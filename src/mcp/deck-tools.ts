import * as z from "zod/v4";

import {
  generateDeckOutputSchema,
  planDeckOutputSchema,
} from "../domain/deck-plan.js";
import {
  deckConsistencySchema,
  deckManifestSchema,
  type DeckManifest,
} from "../domain/deck-manifest.js";
import { documentTypeSchema } from "../domain/document-context.js";
import {
  generateSlideOutputSchema,
  qualityReportSchema,
} from "../domain/quality-report.js";
import { qualitySettingsSchema } from "../domain/source-document.js";

export const mcpPlanDeckInputSchema = z.object({
  sourceMarkdown: z.string().trim().min(20).max(120_000).optional(),
  sourceText: z.string().trim().min(20).max(120_000).optional(),
  pageNumbers: z.array(z.number().int().min(1).max(9999)).min(1).max(30),
  documentType: documentTypeSchema,
  preferredThemeId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  audience: z.string().trim().max(200).optional(),
  quality: qualitySettingsSchema,
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict().superRefine((value, context) => {
  const sources = Number(Boolean(value.sourceMarkdown)) + Number(Boolean(value.sourceText));
  if (sources !== 1) context.addIssue({ code: "custom", message: "Provide exactly one source string" });
  if (value.pageNumbers.some((number, index) => index > 0 && number <= value.pageNumbers[index - 1])) {
    context.addIssue({ code: "custom", message: "pageNumbers must be strictly increasing" });
  }
});

export const deckArtifactNameSchema = z.enum([
  "manifest.json",
  "final.html",
  "quality.json",
  "consistency.json",
]);

export const getDeckInputSchema = z.object({
  id: z.string().uuid(),
  view: z.enum(["plan", "manifest", "artifact"]),
  artifact: deckArtifactNameSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.view === "artifact" && input.artifact === undefined) {
    context.addIssue({ code: "custom", message: "artifact is required when view is artifact", path: ["artifact"] });
  }
  if (input.view !== "artifact" && input.artifact !== undefined) {
    context.addIssue({ code: "custom", message: "artifact is only allowed when view is artifact", path: ["artifact"] });
  }
});

const artifactReferenceSchema = z.object({
  id: z.string().uuid(),
  view: z.literal("artifact"),
  artifact: deckArtifactNameSchema,
}).strict();

const manifestReferenceSchema = z.object({
  id: z.string().uuid(),
  view: z.literal("manifest"),
}).strict();

const publicPageArtifactsSchema = z.object({
  html: artifactReferenceSchema,
  manifest: artifactReferenceSchema,
  quality: artifactReferenceSchema,
}).strict();

const publicPageQualitySchema = generateSlideOutputSchema.shape.quality;

const publicDeckPageResultSchema = z.object({
  pageNumber: z.number().int().positive(),
  runId: z.string().uuid(),
  status: z.enum(["delivered", "best_effort", "failed"]),
  selectedTemplate: z.object({ slug: z.string(), reason: z.string() }).strict(),
  artifacts: publicPageArtifactsSchema,
  quality: publicPageQualitySchema,
  summary: z.string().min(1).max(500),
}).strict();

const publicDeckPageFailureSchema = z.object({
  pageNumber: z.number().int().positive(),
  status: z.literal("failed"),
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }).strict(),
}).strict();

export const mcpGenerateDeckOutputSchema = z.object({
  deckRunId: z.string().uuid(),
  deckPlanId: z.string().uuid(),
  status: z.enum(["needs_assets", "running", "partial", "delivered", "failed"]),
  assets: z.object({
    status: z.enum(["needs_assets", "ready"]),
    missingAssetIds: z.array(z.string().regex(/^(?:p\d+-)?(?:img|icon)-\d{3}$/)),
  }).strict(),
  pages: z.array(z.union([publicDeckPageResultSchema, publicDeckPageFailureSchema])),
  artifacts: z.object({
    manifest: manifestReferenceSchema,
    consistency: artifactReferenceSchema.optional(),
  }).strict(),
  consistency: z.object({ passed: z.boolean(), issues: z.array(z.string()) }).strict().optional(),
}).strict();

const publicDeckPageRecordSchema = z.union([
  publicDeckPageResultSchema,
  publicDeckPageFailureSchema,
  z.object({ pageNumber: z.number().int().positive(), status: z.literal("running") }).strict(),
]);

export const publicDeckManifestSchema = z.object({
  version: z.literal(1),
  deckRunId: z.string().uuid(),
  deckPlanId: z.string().uuid(),
  status: z.enum(["needs_assets", "running", "partial", "delivered", "failed"]),
  createdAt: z.string().min(1).max(50),
  updatedAt: z.string().min(1).max(50),
  missingAssetIds: z.array(z.string().regex(/^(?:p\d+-)?(?:img|icon)-\d{3}$/)),
  pages: z.array(publicDeckPageRecordSchema),
  consistency: deckConsistencySchema.optional(),
}).strict();

const workflowStageSchema = z.enum([
  "normalize_input", "build_slide_spec", "select_template", "generate_assets",
  "compose_html", "quality_loop", "finalize",
]);

export const publicPageManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  status: z.enum(["running", "delivered", "best_effort", "failed"]),
  createdAt: z.string().min(1).max(50),
  updatedAt: z.string().min(1).max(50),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  template: z.object({ slug: z.string(), version: z.string(), reason: z.string() }).strict().optional(),
  stages: z.array(z.object({
    stage: workflowStageSchema,
    status: z.enum(["running", "completed", "failed"]),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    error: z.object({ code: z.string().optional(), message: z.string(), retryable: z.boolean().optional() }).strict().optional(),
  }).strict()),
  assets: z.array(z.object({
    id: z.string().regex(/^(?:p\d+-)?(?:img|icon)-\d{3}$/),
    mimeType: z.string().min(1).max(100),
    prompt: z.string().min(1).max(2_000).optional(),
  }).strict()),
  attempts: z.array(z.object({
    attempt: z.number().int().min(1).max(3),
    score: z.number().min(0).max(100),
    hardGatePassed: z.boolean(),
    safeToReturn: z.boolean(),
  }).strict()),
  selectedAttempt: z.number().int().min(1).max(3).optional(),
  quality: publicPageQualitySchema.optional(),
  summary: z.string().min(1).max(500).optional(),
}).strict();

export const publicQualityArtifactSchema = qualityReportSchema;

const getPlanOutputSchema = z.object({
  kind: z.literal("plan"),
  id: z.string().uuid(),
  view: z.literal("plan"),
  data: planDeckOutputSchema,
}).strict();

const getManifestOutputSchema = z.object({
  kind: z.literal("deck_manifest"),
  id: z.string().uuid(),
  view: z.literal("manifest"),
  data: publicDeckManifestSchema,
}).strict();

const getPageManifestOutputSchema = z.object({
  kind: z.literal("page_manifest"),
  id: z.string().uuid(),
  view: z.literal("artifact"),
  artifact: z.literal("manifest.json"),
  size: z.number().int().nonnegative(),
  data: publicPageManifestSchema,
}).strict();

const getHtmlOutputSchema = z.object({
  kind: z.literal("html"),
  id: z.string().uuid(),
  view: z.literal("artifact"),
  artifact: z.literal("final.html"),
  size: z.number().int().nonnegative(),
  data: z.string(),
}).strict();

const getQualityOutputSchema = z.object({
  kind: z.literal("quality"),
  id: z.string().uuid(),
  view: z.literal("artifact"),
  artifact: z.literal("quality.json"),
  size: z.number().int().nonnegative(),
  data: publicQualityArtifactSchema,
}).strict();

const getConsistencyOutputSchema = z.object({
  kind: z.literal("consistency"),
  id: z.string().uuid(),
  view: z.literal("artifact"),
  artifact: z.literal("consistency.json"),
  size: z.number().int().nonnegative(),
  data: deckConsistencySchema,
}).strict();

export const getDeckVariantSchema = z.discriminatedUnion("kind", [
  getPlanOutputSchema,
  getManifestOutputSchema,
  getPageManifestOutputSchema,
  getHtmlOutputSchema,
  getQualityOutputSchema,
  getConsistencyOutputSchema,
]);

export const getDeckOutputSchema = z.object({ result: getDeckVariantSchema }).strict();

type PublicGenerateDeckOutput = z.infer<typeof mcpGenerateDeckOutputSchema>;

function pageArtifactReferences(runId: string): z.infer<typeof publicPageArtifactsSchema> {
  return {
    html: { id: runId, view: "artifact", artifact: "final.html" },
    manifest: { id: runId, view: "artifact", artifact: "manifest.json" },
    quality: { id: runId, view: "artifact", artifact: "quality.json" },
  };
}

export function publicGenerateDeckOutput(value: unknown): PublicGenerateDeckOutput {
  const output = generateDeckOutputSchema.parse(value);
  return mcpGenerateDeckOutputSchema.parse({
    deckRunId: output.deckRunId,
    deckPlanId: output.deckPlanId,
    status: output.status,
    assets: {
      status: output.missingAssetIds.length > 0 ? "needs_assets" : "ready",
      missingAssetIds: output.missingAssetIds,
    },
    pages: output.pages.map((page) => "runId" in page
      ? {
          pageNumber: page.pageNumber,
          runId: page.runId,
          status: page.status,
          selectedTemplate: page.selectedTemplate,
          artifacts: pageArtifactReferences(page.runId),
          quality: page.quality,
          summary: page.summary,
        }
      : page),
    artifacts: {
      manifest: { id: output.deckRunId, view: "manifest" },
      ...(output.consistency
        ? { consistency: { id: output.deckRunId, view: "artifact", artifact: "consistency.json" } }
        : {}),
    },
    ...(output.consistency ? { consistency: output.consistency } : {}),
  });
}

const unsafeKey = /(?:^|_)(?:api[_-]?key|secret|token|authorization|stack|cause|path|file[_-]?path|request[_-]?(?:id|fingerprint)|asset[_-]?hashes|data[_-]?url)(?:$|_)/i;
const absolutePath = /(?:\/(?:Users|private|home|var|tmp)\/[^\s"'<>]+|[A-Za-z]:[\\/][^\s"'<>]+)/g;
const credential = /(?:Bearer\s+[^\s"'<>]+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{12,}|\b[A-Za-z0-9_-]*(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|database[_-]?url)\s*[:=]\s*[^\s;"'<>]+)/gi;

function publicText(value: string): string {
  return value.replace(absolutePath, "[redacted-path]").replace(credential, "[redacted-credential]");
}

export function sanitizePublicData(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === "string") return publicText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[redacted-cycle]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizePublicData(item, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !unsafeKey.test(key.replaceAll(/([a-z])([A-Z])/g, "$1_$2")))
      .map(([key, item]) => [key, sanitizePublicData(item, seen)]));
  } finally {
    seen.delete(value);
  }
}

export function sanitizePlan(value: unknown): unknown {
  return planDeckOutputSchema.parse(value);
}

export function sanitizeDeckManifest(value: unknown): unknown {
  const manifest = deckManifestSchema.parse(value) as DeckManifest;
  return publicDeckManifestSchema.parse(sanitizePublicData({
    version: manifest.version,
    deckRunId: manifest.deckRunId,
    deckPlanId: manifest.deckPlanId,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    missingAssetIds: manifest.missingAssetIds,
    pages: manifest.pages.map((record) => record.result
      ? publicGenerateDeckOutput({
          deckRunId: manifest.deckRunId,
          deckPlanId: manifest.deckPlanId,
          status: manifest.status,
          pages: [{ ...record.result, pageNumber: record.pageNumber }],
          missingAssetIds: manifest.missingAssetIds,
          manifestPath: "redacted",
          ...(manifest.consistency ? { consistency: manifest.consistency } : {}),
        }).pages[0]
      : {
          pageNumber: record.pageNumber,
          status: record.status,
          ...(record.error ? { error: record.error } : {}),
        }),
    ...(manifest.consistency ? { consistency: manifest.consistency } : {}),
  }));
}

function parsedArtifact(text: string, artifact: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid persisted ${artifact} JSON`);
  }
}

export function sanitizePageManifestText(text: string): z.infer<typeof publicPageManifestSchema> {
  const raw = parsedArtifact(text, "page manifest") as Record<string, unknown>;
  const stages = raw.stages && typeof raw.stages === "object" && !Array.isArray(raw.stages)
    ? Object.entries(raw.stages as Record<string, Record<string, unknown>>).map(([stage, record]) => ({ stage, ...record }))
    : [];
  const finalResult = raw.finalResult && typeof raw.finalResult === "object"
    ? raw.finalResult as Record<string, unknown>
    : undefined;
  const sanitized = sanitizePublicData({
    version: raw.version,
    runId: raw.runId,
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(raw.sourceHash ? { sourceHash: raw.sourceHash } : {}),
    ...(raw.template ? { template: raw.template } : {}),
    stages,
    assets: Array.isArray(raw.assets)
      ? raw.assets.map((asset) => {
          const item = asset as Record<string, unknown>;
          return { id: item.id, mimeType: item.mimeType, ...(item.prompt ? { prompt: item.prompt } : {}) };
        })
      : [],
    attempts: Array.isArray(raw.attempts)
      ? raw.attempts.map((attempt) => {
          const item = attempt as Record<string, unknown>;
          return {
            attempt: item.attempt,
            score: item.score,
            hardGatePassed: item.hardGatePassed,
            safeToReturn: item.safeToReturn,
          };
        })
      : [],
    ...(raw.selectedAttempt ? { selectedAttempt: raw.selectedAttempt } : {}),
    ...(finalResult?.quality ? { quality: finalResult.quality } : {}),
    ...(finalResult?.summary ? { summary: finalResult.summary } : {}),
  });
  return publicPageManifestSchema.parse(sanitized);
}

export function sanitizeQualityText(text: string): z.infer<typeof publicQualityArtifactSchema> {
  return publicQualityArtifactSchema.parse(sanitizePublicData(parsedArtifact(text, "quality artifact")));
}

export function sanitizeConsistencyText(text: string): z.infer<typeof deckConsistencySchema> {
  return deckConsistencySchema.parse(sanitizePublicData(parsedArtifact(text, "consistency artifact")));
}

export function sanitizeHtmlText(text: string): string {
  return publicText(text);
}
