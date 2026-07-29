import * as z from "zod/v4";

import type { GenerateSlideOutput } from "./quality-report.js";
import { generateSlideOutputSchema } from "./quality-report.js";

export const deckStatusSchema = z.enum(["needs_assets", "running", "partial", "delivered", "failed"]);

export const deckConsistencySchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().trim().min(1).max(500)).max(100),
}).strict();

export const deckPersistedErrorCodeSchema = z.enum([
  "INPUT_INVALID",
  "CONFIG_MISSING",
  "TEMPLATE_FAILED",
  "MODEL_FAILED",
  "ASSET_FAILED",
  "RENDER_FAILED",
  "QUALITY_FAILED",
  "INTERNAL_ERROR",
]);

export const deckPersistedErrorStageSchema = z.enum([
  "config",
  "provider_request",
  "provider_response",
  "provider_setup",
  "normalize_input",
  "parse_explicit_pages",
  "partition_deck_source",
  "paginate_source",
  "build_page_blueprint",
  "build_slide_spec",
  "load_template_profiles",
  "select_template",
  "generate_assets",
  "download_asset",
  "compose_html",
  "quality_loop",
  "finalize",
  "workflow_stage",
]);

export const deckPersistedErrorMessageSchema = z.enum([
  "Page input was invalid",
  "Page generation configuration is unavailable",
  "Page template processing failed",
  "Page content generation failed",
  "Page asset generation failed",
  "Page rendering failed",
  "Page quality validation failed",
  "Page generation failed",
]);

export const deckPageErrorSchema = z.object({
  code: deckPersistedErrorCodeSchema,
  stage: deckPersistedErrorStageSchema.optional(),
  message: deckPersistedErrorMessageSchema,
  retryable: z.boolean(),
}).strict();

export const deckPageRecordSchema = z.object({
  pageNumber: z.number().int().min(1).max(9999),
  status: z.enum(["running", "delivered", "best_effort", "failed"]),
  runId: z.string().uuid().optional(),
  result: generateSlideOutputSchema.optional(),
  error: deckPageErrorSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.result && record.result.status !== record.status) {
    context.addIssue({ code: "custom", message: "Page result status must match its record status", path: ["result", "status"] });
  }
  if (record.result && record.runId !== record.result.runId) {
    context.addIssue({ code: "custom", message: "Page runId must match its result runId", path: ["runId"] });
  }
  if ((record.status === "delivered" || record.status === "best_effort") && !record.result) {
    context.addIssue({ code: "custom", message: "Completed page records require a result", path: ["result"] });
  }
  if (record.status === "failed" && !record.result && !record.error) {
    context.addIssue({ code: "custom", message: "Failed page records require an error or result", path: ["error"] });
  }
  if (record.status === "running" && (record.result || record.error)) {
    context.addIssue({ code: "custom", message: "Running page records cannot contain a result or error" });
  }
});

const assetIdSchema = z.string().regex(/^(?:p\d+-)?(?:img|icon)-\d{3}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const deckManifestSchema = z.object({
  version: z.literal(1),
  deckRunId: z.string().uuid(),
  deckPlanId: z.string().uuid(),
  requestId: z.string().min(1).max(128).optional(),
  requestFingerprint: sha256Schema,
  status: deckStatusSchema,
  createdAt: z.string().min(1).max(50),
  updatedAt: z.string().min(1).max(50),
  assetHashes: z.record(assetIdSchema, sha256Schema),
  missingAssetIds: z.array(assetIdSchema).max(100),
  pages: z.array(deckPageRecordSchema).max(100),
  consistency: deckConsistencySchema.optional(),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.missingAssetIds).size !== manifest.missingAssetIds.length) {
    context.addIssue({ code: "custom", message: "missingAssetIds must be unique", path: ["missingAssetIds"] });
  }
  if (new Set(manifest.pages.map((page) => page.pageNumber)).size !== manifest.pages.length) {
    context.addIssue({ code: "custom", message: "Page records must have unique page numbers", path: ["pages"] });
  }
  if (manifest.status === "needs_assets" && manifest.missingAssetIds.length === 0) {
    context.addIssue({ code: "custom", message: "needs_assets status requires missing assets", path: ["status"] });
  }
  if (manifest.status !== "needs_assets" && manifest.missingAssetIds.length > 0) {
    context.addIssue({ code: "custom", message: "Only needs_assets runs may retain missing assets", path: ["status"] });
  }
  if (manifest.status === "delivered") {
    if (manifest.pages.length === 0 || manifest.pages.some((page) => page.status !== "delivered")) {
      context.addIssue({ code: "custom", message: "Delivered runs require only delivered page records", path: ["pages"] });
    }
    if (manifest.consistency?.passed === false) {
      context.addIssue({ code: "custom", message: "Delivered runs cannot have failing consistency", path: ["consistency"] });
    }
  }
});

export type DeckStatus = "needs_assets" | "running" | "partial" | "delivered" | "failed";
export type DeckPageError = z.infer<typeof deckPageErrorSchema>;

export interface DeckPageRecord {
  pageNumber: number;
  status: "running" | "delivered" | "best_effort" | "failed";
  runId?: string;
  result?: GenerateSlideOutput;
  error?: DeckPageError;
}

export interface DeckManifest {
  version: 1;
  deckRunId: string;
  deckPlanId: string;
  requestId?: string;
  requestFingerprint: string;
  status: DeckStatus;
  createdAt: string;
  updatedAt: string;
  assetHashes: Record<string, string>;
  missingAssetIds: string[];
  pages: DeckPageRecord[];
  consistency?: { passed: boolean; issues: string[] };
}
