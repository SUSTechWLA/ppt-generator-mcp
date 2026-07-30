import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

import { hashCanonical } from "../domain/source-document.js";
import { TEMPLATE_BLUEPRINT_JSON_SCHEMA, templateBlueprintSchema, type TemplateBlueprint } from "../domain/template-blueprint.js";
import { evaluateDeterministic } from "../services/deterministic-evaluator.js";
import { renderPage } from "../services/page-renderer.js";
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

async function validateCompiledCatalog(html: string, profile: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "template-knowledge-catalog-"));
  try {
    const family = join(root, "learned");
    await mkdir(family, { recursive: true });
    const slug = (profile as { slug: string }).slug;
    await writeFile(join(family, `${slug}.html`), html);
    await writeFile(join(family, "template-profiles.json"), `${JSON.stringify([profile])}\n`);
    const loaded = loadTemplateProfiles(root);
    if (loaded.length !== 1 || loaded[0].slug !== slug) throw new Error("Compiled template capability profile is inconsistent");
  } finally {
    await rm(root, { recursive: true, force: true });
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
      await deps.store.reserveAnalysisRequest(input.requestId, fingerprint);
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
    await validateCompiledCatalog(compiled.html, compiled.profile);
    const qaRoot = await mkdtemp(join(tmpdir(), "template-knowledge-qa-"));
    try {
      const screenshotPath = join(qaRoot, "preview.png");
      const rendered = await renderPage({ html: compiled.previewHtml, screenshotPath });
      const deterministic = evaluateDeterministic(rendered, {
        profile: compiled.profile,
        maxRasterAreaRatio: compiled.profile.maxRasterAreaRatio,
        maximumRasterAssets: compiled.profile.imageSlots.maxAssets,
        minimumBodyFontPt: compiled.profile.minimumBodyFontPt,
        expectedPageNumber: 1,
      });
      if (!deterministic.safeToReturn || !deterministic.hardGatePassed) throw new Error("Compiled template failed Chromium quality gates");
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
