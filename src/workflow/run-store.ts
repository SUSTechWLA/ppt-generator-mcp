import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../domain/source-document.js";
import type { ArtifactName, AttemptRecord, RunManifest, StageRecord, WorkflowStage } from "../domain/run-manifest.js";
import {
  hasUnsafeDiagnosticValue,
  normalizeGenerateSlideOutputDiagnostics,
  normalizePersistedQualityArtifact,
} from "../services/quality-safety.js";

interface RequestIndexEntry {
  runId: string;
  fingerprint: string;
}

export interface InternalArtifactReadLimits {
  maxImageBytes: number;
  maxAssets: number;
  maxInputChars: number;
}

interface VerifiedArtifact {
  path: string;
  size: number;
}

type RequestIndex = Record<string, RequestIndexEntry>;

export interface ActiveRun {
  runId: string;
  manifest: RunManifest;
  resumed: boolean;
  store: RunStore;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACTS = new Set<ArtifactName>(["manifest.json", "final.html", "final.png", "quality.json"]);
const PUBLIC_TEXT_ARTIFACT_MAX_BYTES = 512 * 1024;
const CONSISTENCY_MARKUP_OVERHEAD_BYTES = 2 * 1024 * 1024;
const DATA_URL_MARKUP_OVERHEAD_BYTES = 128;
const MAX_UTF8_BYTES_PER_INPUT_CHARACTER = 4;

class UnsafeArtifactEntryError extends Error {}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isContained(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export class RunStore {
  readonly root: string;
  readonly #internalReadLimits?: Readonly<InternalArtifactReadLimits>;

  constructor(root: string, internalReadLimits?: InternalArtifactReadLimits) {
    this.root = resolve(root);
    if (internalReadLimits) {
      if (!Number.isSafeInteger(internalReadLimits.maxImageBytes) || internalReadLimits.maxImageBytes <= 0
        || !Number.isSafeInteger(internalReadLimits.maxAssets) || internalReadLimits.maxAssets < 0
        || !Number.isSafeInteger(internalReadLimits.maxInputChars) || internalReadLimits.maxInputChars <= 0) {
        throw new Error("Invalid internal artifact read limits");
      }
      this.#internalReadLimits = Object.freeze({ ...internalReadLimits });
    }
  }

  runDir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`Invalid runId: ${runId}`);
    return this.safePath(runId);
  }

  private safePath(...segments: string[]): string {
    const target = resolve(this.root, ...segments);
    const delta = relative(this.root, target);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Resolved path escapes the output root");
    return target;
  }

  private manifestPath(runId: string): string {
    return join(this.runDir(runId), "manifest.json");
  }

  private async writeManifest(manifest: RunManifest): Promise<RunManifest> {
    manifest.updatedAt = new Date().toISOString();
    await atomicWrite(this.manifestPath(manifest.runId), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async createOrResume(input: { requestId?: string; canonicalInput: unknown }): Promise<ActiveRun> {
    await mkdir(this.root, { recursive: true });
    const fingerprint = hashCanonical(input.canonicalInput);
    const indexPath = this.safePath("request-index.json");
    const index = await readJson<RequestIndex>(indexPath, {});
    if (input.requestId && index[input.requestId]) {
      const entry = index[input.requestId];
      if (entry.fingerprint !== fingerprint) throw new Error(`requestId fingerprint mismatch for ${input.requestId}`);
      const manifest = await this.getRun(entry.runId);
      return { runId: entry.runId, manifest, resumed: true, store: this };
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    await mkdir(this.runDir(runId), { recursive: true });
    const manifest: RunManifest = {
      version: 1,
      runId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      requestFingerprint: fingerprint,
      status: "running",
      createdAt: now,
      updatedAt: now,
      stages: {},
      assets: [],
      attempts: [],
    };
    await this.writeManifest(manifest);
    if (input.requestId) {
      index[input.requestId] = { runId, fingerprint };
      await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    }
    return { runId, manifest, resumed: false, store: this };
  }

  async getRun(runId: string): Promise<RunManifest> {
    return readJson<RunManifest>(this.manifestPath(runId));
  }

  async updateStage(runId: string, stage: WorkflowStage, update: StageRecord): Promise<RunManifest> {
    const manifest = await this.getRun(runId);
    manifest.stages[stage] = { ...manifest.stages[stage], ...update };
    return this.writeManifest(manifest);
  }

  async writeStageOutput(runId: string, stage: WorkflowStage, value: unknown): Promise<void> {
    const directory = join(this.runDir(runId), "stages");
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, `${stage}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readStageOutput<T>(runId: string, stage: WorkflowStage): Promise<{ found: false } | { found: true; value: T }> {
    const manifest = await this.getRun(runId);
    if (manifest.stages[stage]?.status !== "completed") return { found: false };
    try {
      return { found: true, value: await readJson<T>(join(this.runDir(runId), "stages", `${stage}.json`)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { found: false };
      throw error;
    }
  }

  async updateWorkflowData(runId: string, update: Partial<Pick<RunManifest, "sourceHash" | "template" | "slideSpec" | "assets">>): Promise<RunManifest> {
    const manifest = await this.getRun(runId);
    Object.assign(manifest, update);
    return this.writeManifest(manifest);
  }

  async saveAttempt(runId: string, attempt: AttemptRecord, files?: { html?: string; preview?: Buffer; quality?: unknown }): Promise<RunManifest> {
    const directory = join(this.runDir(runId), "attempts", String(attempt.attempt).padStart(2, "0"));
    await mkdir(directory, { recursive: true });
    if (files?.html !== undefined) await atomicWrite(join(directory, "page.html"), files.html);
    if (files?.preview !== undefined) await atomicWrite(join(directory, "preview.png"), files.preview);
    if (files?.quality !== undefined) {
      await atomicWrite(join(directory, "quality.json"), `${JSON.stringify(normalizePersistedQualityArtifact(files.quality), null, 2)}\n`);
    }
    const manifest = await this.getRun(runId);
    const safeAttempt = hasUnsafeDiagnosticValue(attempt.actions) ? { ...attempt, actions: [] } : attempt;
    manifest.attempts = [...manifest.attempts.filter((item) => item.attempt !== attempt.attempt), safeAttempt].sort((a, b) => a.attempt - b.attempt);
    return this.writeManifest(manifest);
  }

  async promoteAttempt(runId: string, attempt: AttemptRecord): Promise<{ htmlPath: string; previewPath: string; qualityPath: string }> {
    const directory = this.runDir(runId);
    const mappings: Array<[string, string]> = [
      [attempt.htmlPath, join(directory, "final.html")],
      [attempt.previewPath, join(directory, "final.png")],
      [attempt.qualityPath, join(directory, "quality.json")],
    ];
    for (const [source, destination] of mappings) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    }
    return { htmlPath: mappings[0][1], previewPath: mappings[1][1], qualityPath: mappings[2][1] };
  }

  async finalize(runId: string, update: Pick<RunManifest, "status"> & Partial<Pick<RunManifest, "selectedAttempt" | "finalResult" | "artifacts">>): Promise<RunManifest> {
    const manifest = await this.getRun(runId);
    Object.assign(manifest, {
      ...update,
      ...(update.finalResult ? { finalResult: normalizeGenerateSlideOutputDiagnostics(update.finalResult) } : {}),
    });
    return this.writeManifest(manifest);
  }

  private async resolveVerifiedArtifact(runId: string, artifactName: ArtifactName): Promise<VerifiedArtifact> {
    const directory = this.runDir(runId);
    if (!ARTIFACTS.has(artifactName)) throw new Error(`Invalid artifact name: ${artifactName}`);
    const path = artifactName === "manifest.json" ? this.manifestPath(runId) : join(directory, artifactName);
    const delta = relative(directory, path);
    if (delta.startsWith("..") || isAbsolute(delta)) throw new Error("Artifact path escapes run directory");
    try {
      const [rootEntry, directoryEntry, artifactEntry] = await Promise.all([
        lstat(this.root),
        lstat(directory),
        lstat(path),
      ]);
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new UnsafeArtifactEntryError();
      if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) throw new UnsafeArtifactEntryError();
      if (artifactEntry.isSymbolicLink() || !artifactEntry.isFile()) throw new UnsafeArtifactEntryError();

      const [actualRoot, actualDirectory, actualPath] = await Promise.all([
        realpath(this.root),
        realpath(directory),
        realpath(path),
      ]);
      if (!isContained(actualRoot, actualDirectory) || !isContained(actualDirectory, actualPath)) {
        throw new UnsafeArtifactEntryError();
      }

      const metadata = await stat(path);
      if (!metadata.isFile()) throw new UnsafeArtifactEntryError();
      return { path, size: metadata.size };
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new Error(`Artifact not found (${artifactName})`);
      if (error instanceof UnsafeArtifactEntryError || isErrno(error, "ELOOP")) {
        throw new Error(`Artifact unavailable (${artifactName}): unsafe storage entry`);
      }
      throw new Error(`Unable to read artifact (${artifactName})`);
    }
  }

  async getArtifact(runId: string, artifactName: ArtifactName): Promise<{ path: string; size: number; text?: string }> {
    const artifact = await this.resolveVerifiedArtifact(runId, artifactName);
    const result: { path: string; size: number; text?: string } = { ...artifact };
    if (artifact.size <= PUBLIC_TEXT_ARTIFACT_MAX_BYTES && artifactName !== "final.png") {
      try {
        result.text = await readFile(artifact.path, "utf8");
      } catch {
        throw new Error(`Unable to read artifact (${artifactName})`);
      }
    }
    return result;
  }

  async readFinalHtmlForConsistency(runId: string, plannedAssetCount: number): Promise<{ size: number; text: string }> {
    const limits = this.#internalReadLimits;
    if (!limits
      || !Number.isSafeInteger(plannedAssetCount)
      || plannedAssetCount < 0
      || plannedAssetCount > limits.maxAssets) {
      throw new Error("Artifact unavailable (final.html)");
    }
    const base64BytesPerAsset = 4 * Math.ceil(limits.maxImageBytes / 3);
    const markupBytes = CONSISTENCY_MARKUP_OVERHEAD_BYTES
      + limits.maxInputChars * MAX_UTF8_BYTES_PER_INPUT_CHARACTER;
    const maxBytes = markupBytes
      + plannedAssetCount * (base64BytesPerAsset + DATA_URL_MARKUP_OVERHEAD_BYTES);
    if (!Number.isSafeInteger(maxBytes)) throw new Error("Artifact unavailable (final.html)");

    const artifact = await this.resolveVerifiedArtifact(runId, "final.html");
    if (artifact.size > maxBytes) throw new Error("Artifact unavailable (final.html)");
    try {
      return { size: artifact.size, text: await readFile(artifact.path, "utf8") };
    } catch {
      throw new Error("Artifact unavailable (final.html)");
    }
  }
}
