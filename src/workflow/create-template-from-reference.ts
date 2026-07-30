import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import * as z from "zod/v4";

import { hashCanonical } from "../domain/source-document.js";
import type { GeneratedAsset, SlideSpec } from "../domain/slide-spec.js";
import { TEMPLATE_BLUEPRINT_JSON_SCHEMA, templateBlueprintSchema, type TemplateBlueprint } from "../domain/template-blueprint.js";
import { loadTemplate } from "../lib/template-parser.js";
import { evaluateDeterministic } from "../services/deterministic-evaluator.js";
import { renderPage } from "../services/page-renderer.js";
import { composeSlide } from "../services/slide-composer.js";
import { compileTemplateBlueprint } from "../services/template-blueprint-compiler.js";
import { inspectTemplateHtml, MAX_REFERENCE_HTML_CHARS } from "../services/template-inspector.js";
import { loadTemplateProfiles } from "../services/template-selector.js";
import type { TemplateKnowledgeRecord, TemplateKnowledgeStore } from "./template-knowledge-store.js";

const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;
const imageDataUrlSchema = z.string().max(17_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).superRefine((value, context) => {
  const payload = value.slice(value.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(payload.length * 3 / 4) - padding;
  if (bytes <= 0 || bytes > MAX_REFERENCE_IMAGE_BYTES) context.addIssue({ code: "custom", message: "Reference image exceeds the bounded byte limit" });
});

export const createTemplateFromReferenceInputSchema = z.object({
  referenceHtml: z.string().trim().min(20).max(MAX_REFERENCE_HTML_CHARS).optional(),
  referenceImageDataUrl: imageDataUrlSchema.optional(),
  blueprint: templateBlueprintSchema.optional(),
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict().superRefine((value, context) => {
  const sources = Number(Boolean(value.referenceHtml)) + Number(Boolean(value.referenceImageDataUrl)) + Number(Boolean(value.blueprint));
  if (sources !== 1) context.addIssue({ code: "custom", message: "Provide exactly one referenceHtml, referenceImageDataUrl, or blueprint" });
});

export type CreateTemplateFromReferenceInput = z.input<typeof createTemplateFromReferenceInputSchema>;

export interface TemplateAnalysisHandoff {
  status: "needs_analysis";
  sourceType: "image";
  sourceHash: string;
  analysisTaskId: string;
  analysisPrompt: string;
  blueprintSchema: Record<string, unknown>;
}

export interface ApprovedTemplateKnowledge extends TemplateKnowledgeRecord {
  status: "approved";
  promotion: { liveCatalogSelection: false; instruction: string };
}

export type CreateTemplateFromReferenceResult = TemplateAnalysisHandoff | ApprovedTemplateKnowledge;

export interface CreateTemplateFromReferenceDependencies {
  store: TemplateKnowledgeStore;
  analyzeReferenceImage?: (input: { imageDataUrl: string; prompt: string; blueprintSchema: Record<string, unknown> }) => Promise<unknown>;
}

export const TEMPLATE_ANALYSIS_PROMPT = [
  "Analyze only the reference page's layout, hierarchy, grid, typography, palette, spacing, component types and visual ratios.",
  "Return exactly one JSON object matching the supplied TemplateBlueprint schema.",
  "Do not transcribe visible body copy, filenames, logos, brand names or watermarks.",
  "Never propose the screenshot as a full-page background and never copy protected image assets.",
].join(" ");

function publicApproved(record: TemplateKnowledgeRecord): ApprovedTemplateKnowledge {
  return {
    status: "approved",
    ...record,
    promotion: {
      liveCatalogSelection: false,
      instruction: "Promote the immutable template.html and profile.json into the server template catalog, then restart to enable selection.",
    },
  };
}

async function withValidatedCompiledCatalog<T>(
  html: string,
  profile: ReturnType<typeof compileTemplateBlueprint>["profile"],
  operation: (template: ReturnType<typeof loadTemplate>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "template-knowledge-catalog-"));
  try {
    const family = join(root, "learned");
    await mkdir(family, { recursive: true });
    const slug = (profile as { slug: string }).slug;
    await writeFile(join(family, `${slug}.html`), html);
    await writeFile(join(family, "template-profiles.json"), `${JSON.stringify([profile])}\n`);
    const loaded = loadTemplateProfiles(root);
    if (loaded.length !== 1 || loaded[0].slug !== slug) throw new Error("Compiled template capability profile is inconsistent");
    return await operation(loadTemplate(root, slug));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function qaSlideSpec(blueprint: TemplateBlueprint): SlideSpec {
  const semanticRegions = blueprint.grid.regions.filter((region) => ["body", "metric", "process", "evidence"].includes(region.role));
  const blocks: SlideSpec["blocks"] = semanticRegions.map((region, index) => {
    const semanticRole = region.role === "body" ? "fact" as const : region.role as "metric" | "process" | "evidence";
    const type = region.role === "metric" ? "metric" as const : region.role === "process" ? "process" as const : "text" as const;
    return {
      id: `block-${index + 1}`,
      type,
      title: region.role === "metric" ? "Service target" : region.role === "process" ? "Delivery stage" : region.role === "evidence" ? "Delivery evidence" : "Delivery capability",
      body: "Clear ownership, measurable controls and traceable evidence support reliable service delivery.",
      bullets: [],
      metrics: region.role === "metric" ? [{ label: "Target", value: "99%" }] : [],
      sourceFactIds: [`fact-${index + 1}`],
      semanticRole,
    };
  });
  const sourceFactIds = blocks.flatMap((block) => block.sourceFactIds);
  return {
    title: "Reliable service delivery model",
    eyebrow: "Implementation framework",
    conclusion: "Responsibilities, controls and evidence form one reusable delivery system.",
    blocks,
    assets: blueprint.optionalImage.enabled ? [{
      id: "img-001",
      type: "image",
      blockId: blocks[0].id,
      prompt: "Professional abstract service delivery scene with layered geometric forms, no text, logo or watermark.",
      alt: "Abstract service delivery support visual",
      sourceFactIds: [sourceFactIds[0]],
      width: 1792,
      height: 1024,
    }] : [],
    sourceFactIds,
    designIntent: { tone: "professional", density: "medium", visualRatio: blueprint.visualRatios.image },
  };
}

async function createOwnedQaAsset(path: string, spec: SlideSpec): Promise<GeneratedAsset[]> {
  if (spec.assets.length === 0) return [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1, javaScriptEnabled: false });
    await page.setContent(`<!doctype html><html><style>*{box-sizing:border-box}html,body{width:640px;height:360px;margin:0;overflow:hidden}body{background:#eaf3ee}.scene{position:relative;width:100%;height:100%;background:linear-gradient(135deg,#123d2b,#2d7b57 58%,#b8dcc8)}.plane{position:absolute;border-radius:36px;transform:rotate(-12deg);box-shadow:0 18px 50px #0a2d2055}.a{width:430px;height:160px;left:-40px;top:68px;background:#ffffffdc}.b{width:350px;height:120px;right:-25px;bottom:34px;background:#76b895dd}.orb{position:absolute;width:128px;height:128px;right:88px;top:36px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#d5eadf 38%,#176b45 100%);box-shadow:0 22px 44px #06281b66}</style><body><div class="scene"><div class="plane a"></div><div class="plane b"></div><div class="orb"></div></div></body></html>`);
    const bytes = await page.screenshot({ path, type: "png" });
    const declared = spec.assets[0];
    return [{
      id: declared.id,
      promptHash: hashCanonical({ prompt: declared.prompt }),
      mimeType: "image/png",
      filePath: path,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      reused: false,
    }];
  } finally {
    await browser.close();
  }
}

export async function createTemplateFromReference(
  rawInput: unknown,
  deps: CreateTemplateFromReferenceDependencies,
): Promise<CreateTemplateFromReferenceResult> {
  const input = createTemplateFromReferenceInputSchema.parse(rawInput);
  const sourceType = input.referenceHtml ? "html" as const : input.referenceImageDataUrl ? "image" as const : "blueprint" as const;
  const sourceValue = input.referenceHtml ?? input.referenceImageDataUrl ?? input.blueprint!;
  const sourceHash = hashCanonical({ sourceType, source: sourceValue });
  const fingerprint = hashCanonical({ sourceType, sourceHash });
  if (sourceType === "image" && !deps.analyzeReferenceImage) {
    return deps.store.withRequestLock(input.requestId, async () => {
      const existing = await deps.store.reserveAnalysisRequest(input.requestId, fingerprint);
      if (existing) return publicApproved(existing);
      return {
        status: "needs_analysis" as const,
        sourceType,
        sourceHash,
        analysisTaskId: `template-analysis-${sourceHash.slice(0, 24)}`,
        analysisPrompt: TEMPLATE_ANALYSIS_PROMPT,
        blueprintSchema: TEMPLATE_BLUEPRINT_JSON_SCHEMA as Record<string, unknown>,
      };
    });
  }

  return deps.store.withRequestLock(input.requestId, async () => {
    const existing = await deps.store.findRequest(input.requestId, fingerprint);
    if (existing) return publicApproved(existing);
    let blueprint: TemplateBlueprint;
    if (input.referenceHtml) {
      const inspection = inspectTemplateHtml(input.referenceHtml);
      if (!inspection.safe) throw new Error("Unsafe reference HTML cannot be approved");
      blueprint = inspection.blueprint;
    } else if (input.referenceImageDataUrl) {
      blueprint = templateBlueprintSchema.parse(await deps.analyzeReferenceImage!({
        imageDataUrl: input.referenceImageDataUrl,
        prompt: TEMPLATE_ANALYSIS_PROMPT,
        blueprintSchema: TEMPLATE_BLUEPRINT_JSON_SCHEMA as Record<string, unknown>,
      }));
    } else blueprint = templateBlueprintSchema.parse(input.blueprint);

    const compiled = compileTemplateBlueprint(blueprint);
    const qaRoot = await mkdtemp(join(tmpdir(), "template-knowledge-qa-"));
    try {
      const screenshotPath = join(qaRoot, "preview.png");
      const spec = qaSlideSpec(blueprint);
      const assets = await createOwnedQaAsset(join(qaRoot, "owned-qa.png"), spec);
      const composedHtml = await withValidatedCompiledCatalog(compiled.html, compiled.profile, async (template) => (
        await composeSlide({ spec, template, profile: compiled.profile, assets })
      ).html);
      const rendered = await renderPage({ html: composedHtml, screenshotPath });
      const deterministic = evaluateDeterministic(rendered, {
        profile: compiled.profile,
        maxRasterAreaRatio: compiled.profile.maxRasterAreaRatio,
        maximumRasterAssets: compiled.profile.imageSlots.maxAssets,
        minimumBodyFontPt: compiled.profile.minimumBodyFontPt,
        expectedPageNumber: 1,
      });
      if (!deterministic.safeToReturn || !deterministic.hardGatePassed) {
        const evidence = deterministic.issues.slice(0, 5).map((issue) => `${issue.category}: ${issue.evidence}`).join("; ");
        throw new Error(`Compiled template failed Chromium quality gates${evidence ? ` (${evidence})` : ""}`);
      }
      const record = await deps.store.approve({
        requestId: input.requestId,
        requestFingerprint: fingerprint,
        sourceType,
        sourceHash,
        blueprint,
        html: compiled.html,
        profile: compiled.profile,
        quality: {
          chromiumRendered: true,
          hardGatePassed: true,
          safeToReturn: true,
          score: Math.max(90, 100 - deterministic.issues.filter((issue) => issue.severity === "warning").length * 2),
          imageCount: rendered.raster.visibleCount,
          rasterAreaRatio: rendered.rasterAreaRatio,
          containmentViolations: 0,
          collisions: 0,
          issues: deterministic.issues.map((issue) => ({ severity: issue.severity, category: issue.category, evidence: issue.evidence })),
        },
        preview: await readFile(screenshotPath),
      });
      return publicApproved(record);
    } finally {
      await rm(qaRoot, { recursive: true, force: true });
    }
  });
}
