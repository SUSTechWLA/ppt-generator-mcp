import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { AssetSpec, GeneratedAsset } from "../domain/slide-spec.js";
import { WorkflowError } from "../domain/workflow-error.js";
import type { ImageProvider } from "../providers/contracts.js";
import { safeDownloadImage } from "./safe-download.js";

export interface ExternalAsset {
  id: string;
  dataUrl: string;
}

export interface GenerateAssetsInput {
  specs: AssetSpec[];
  provider?: ImageProvider;
  outputDir: string;
  allowedHosts: string[];
  maxBytes: number;
  existing: GeneratedAsset[];
  externalAssets?: ExternalAsset[];
  iconBasePath?: string;
  timeoutMs?: number;
  cacheIdentity?: { model?: string; templateVersion?: string };
}

const MIME_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
} as const;

function cacheHash(spec: AssetSpec, input: GenerateAssetsInput): string {
  return createHash("sha256").update(JSON.stringify({
    id: spec.id,
    prompt: spec.prompt.trim().replace(/\s+/g, " "),
    size: `${spec.width}x${spec.height}`,
    model: input.cacheIdentity?.model ?? "external-or-default",
    templateVersion: input.cacheIdentity?.templateVersion ?? "1",
  })).digest("hex");
}

function validateMagic(bytes: Buffer, mimeType: GeneratedAsset["mimeType"]): void {
  const valid = mimeType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : mimeType === "image/webp"
        ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        : bytes.subarray(0, 256).toString("utf8").includes("<svg");
  if (!valid) throw new Error(`Image bytes do not match ${mimeType}`);
}

function parseDataUrl(dataUrl: string): { bytes: Buffer; mimeType: GeneratedAsset["mimeType"] } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error("External asset must be a supported Base64 image data URL");
  const mimeType = match[1] as GeneratedAsset["mimeType"];
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  validateMagic(bytes, mimeType);
  return { bytes, mimeType };
}

const ICON_ALIASES: Array<[RegExp, string]> = [
  [/团队|人员|协作|班组/i, "users-group.svg"],
  [/审批|流程|清单/i, "clipboard-check.svg"],
  [/文件|文档|台账|记录/i, "file-description.svg"],
  [/检查|巡查|搜索/i, "search.svg"],
  [/计划|日程|安排/i, "calendar.svg"],
  [/养护|修剪|作业/i, "scissors.svg"],
  [/设备|车辆|运输/i, "truck.svg"],
  [/质量|安全|保障/i, "shield-check.svg"],
];

async function resolveLocalIcon(spec: AssetSpec, iconBasePath?: string): Promise<{ bytes: Buffer; mimeType: "image/svg+xml" } | undefined> {
  if (spec.type !== "icon" || !iconBasePath) return undefined;
  const match = ICON_ALIASES.find(([pattern]) => pattern.test(`${spec.alt} ${spec.prompt}`));
  if (!match) return undefined;
  const path = join(iconBasePath, basename(match[1]));
  try {
    const bytes = await readFile(path);
    validateMagic(bytes, "image/svg+xml");
    return { bytes, mimeType: "image/svg+xml" };
  } catch {
    return undefined;
  }
}

async function persistAsset(
  outputDir: string,
  spec: AssetSpec,
  hash: string,
  bytes: Buffer,
  mimeType: GeneratedAsset["mimeType"],
): Promise<GeneratedAsset> {
  if (bytes.length === 0) throw new Error("Image asset is empty");
  const extension = MIME_EXTENSIONS[mimeType];
  const filePath = join(outputDir, `${spec.id}-${hash.slice(0, 12)}${extension}`);
  const tempPath = `${filePath}.tmp`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(tempPath, bytes);
  await rename(tempPath, filePath);
  return {
    id: spec.id,
    promptHash: hash,
    mimeType,
    filePath,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
    reused: false,
  };
}

export async function generateAssets(input: GenerateAssetsInput): Promise<GeneratedAsset[]> {
  const external = new Map(input.externalAssets?.map((asset) => [asset.id, asset.dataUrl]));
  const unknown = [...external.keys()].filter((id) => !input.specs.some((spec) => spec.id === id));
  if (unknown.length) throw new Error(`External asset IDs are not present in SlideSpec: ${unknown.join(", ")}`);

  const results: GeneratedAsset[] = [];
  for (const spec of input.specs) {
    const hash = cacheHash(spec, input);
    const cached = input.existing.find((asset) => asset.id === spec.id && asset.promptHash === hash);
    if (cached) {
      try {
        await stat(cached.filePath);
        results.push({ ...cached, reused: true });
        continue;
      } catch {
        // Missing cache files are regenerated instead of returning a broken record.
      }
    }

    const supplied = external.get(spec.id);
    if (supplied) {
      const parsed = parseDataUrl(supplied);
      if (parsed.bytes.length > input.maxBytes) throw new Error("External asset exceeds maximum byte size");
      results.push(await persistAsset(input.outputDir, spec, hash, parsed.bytes, parsed.mimeType));
      continue;
    }

    const localIcon = await resolveLocalIcon(spec, input.iconBasePath);
    if (localIcon) {
      results.push(await persistAsset(input.outputDir, spec, hash, localIcon.bytes, localIcon.mimeType));
      continue;
    }

    if (!input.provider) {
      throw new WorkflowError({
        code: "ASSET_FAILED",
        stage: "generate_assets",
        retryable: false,
        message: `No external asset was supplied for ${spec.id} and no image provider is configured`,
        recovery: "Generate the image with the Agent imagegen tool and pass it back as an asset data URL.",
      });
    }
    const generated = await input.provider.generate({ prompt: spec.prompt, size: "1792x1024" });
    const payload = generated.kind === "base64"
      ? { bytes: Buffer.from(generated.data, "base64"), mimeType: generated.mimeType }
      : await safeDownloadImage({ url: generated.url, allowedHosts: input.allowedHosts, maxBytes: input.maxBytes, timeoutMs: input.timeoutMs ?? 60_000 });
    if (payload.bytes.length > input.maxBytes) throw new Error("Generated asset exceeds maximum byte size");
    validateMagic(payload.bytes, payload.mimeType);
    results.push(await persistAsset(input.outputDir, spec, hash, payload.bytes, payload.mimeType));
  }
  return results;
}
