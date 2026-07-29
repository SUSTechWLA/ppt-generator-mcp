import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { documentTypeSchema, pageMetadataSchema } from "./document-context.js";
import { slideSpecSchema } from "./slide-spec.js";

export const sourceSectionInputSchema = z.object({
  heading: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
  keyPoints: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
}).strict();

export const qualitySettingsSchema = z.object({
  minScore: z.number().int().min(70).max(95).default(85),
  maxAttempts: z.number().int().min(1).max(3).default(3),
}).strict().default({ minScore: 85, maxAttempts: 3 });

export const externalAssetInputSchema = z.object({
  id: z.string().regex(/^(?:p\d+-)?(?:img|icon)-\d{3}$/),
  dataUrl: z.string().min(32).max(20_000_000).regex(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/),
}).strict();

export const generateSlideInputSchema = z.object({
  sourceText: z.string().trim().min(20).max(120_000).optional(),
  sections: z.array(sourceSectionInputSchema).min(1).max(50).optional(),
  templateSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  audience: z.string().trim().max(200).optional(),
  plannedSpec: slideSpecSchema.optional(),
  externalAssets: z.array(externalAssetInputSchema).max(6).optional(),
  documentType: documentTypeSchema.optional(),
  page: pageMetadataSchema.optional(),
  quality: qualitySettingsSchema,
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict().superRefine((value, context) => {
  const count = Number(Boolean(value.sourceText)) + Number(Boolean(value.sections));
  if (count !== 1) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of sourceText or sections",
    });
  }
});

export type GenerateSlideInput = z.input<typeof generateSlideInputSchema>;
export type GenerateSlideRequest = z.output<typeof generateSlideInputSchema>;

export const sourceSectionSchema = z.object({
  id: z.string().regex(/^section-\d+$/),
  heading: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
  keyPoints: z.array(z.string().trim().min(1).max(300)).max(20),
  order: z.number().int().nonnegative(),
}).strict();

export const sourceFactSchema = z.object({
  id: z.string().regex(/^fact-\d+$/),
  text: z.string().trim().min(1).max(500),
  kind: z.enum(["number", "name", "requirement", "conclusion"]),
  sourceSectionId: z.string().regex(/^section-\d+$/),
}).strict();

export const sourceDocumentSchema = z.object({
  language: z.literal("zh-CN"),
  title: z.string().trim().max(120).optional(),
  sections: z.array(sourceSectionSchema).min(1).max(50),
  facts: z.array(sourceFactSchema),
  sourceHash: z.string().length(64),
}).strict();

export type SourceSectionInput = z.infer<typeof sourceSectionInputSchema>;
export type SourceSection = z.infer<typeof sourceSectionSchema>;
export type SourceFact = z.infer<typeof sourceFactSchema>;
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
