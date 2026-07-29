import * as z from "zod/v4";

import { semanticRoleSchema } from "./page-blueprint.js";
import { slideBlockTypeSchema } from "./slide-spec.js";

export const templateDensitySchema = z.enum(["low", "medium", "high"]);
export const pageIntentSchema = z.enum(["detail", "process", "comparison", "evidence", "visual-support"]);
export const semanticLandmarkSchema = z.enum([
  "page-header",
  "chapter-band",
  "subsection-title",
  "summary-band",
  "page-footer",
]);

const placeholderTagSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const slotBindingsSchema = z.object({
  title: placeholderTagSchema.optional(),
  body: placeholderTagSchema.optional(),
  shortTitle: placeholderTagSchema.optional(),
  narrativeBody: placeholderTagSchema.optional(),
  sequence: placeholderTagSchema.optional(),
  stepLabel: placeholderTagSchema.optional(),
  stepNumber: placeholderTagSchema.optional(),
  stageLabel: placeholderTagSchema.optional(),
  stageNumber: placeholderTagSchema.optional(),
  itemLabel: placeholderTagSchema.optional(),
  nodeLabel: placeholderTagSchema.optional(),
  label: placeholderTagSchema.optional(),
  bullet: placeholderTagSchema.optional(),
  metric: placeholderTagSchema.optional(),
  tableHeader: placeholderTagSchema.optional(),
  tableCell: placeholderTagSchema.optional(),
  figureRef: placeholderTagSchema.optional(),
}).strict().refine((bindings) => Object.keys(bindings).length > 0, "A semantic slot must declare at least one placeholder binding");

export const semanticSlotSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  priority: z.number().int().min(0).max(100),
  required: z.boolean(),
  itemCapacity: z.number().int().min(1).max(12),
  maxCharsPerItem: z.number().int().min(1).max(500),
  acceptedRoles: z.array(semanticRoleSchema).min(1),
  bindings: slotBindingsSchema,
}).strict();

export const pageBindingsSchema = z.object({
  pageTitle: placeholderTagSchema,
  pageNumber: placeholderTagSchema,
  sectionTitle: placeholderTagSchema,
  partNumber: placeholderTagSchema,
  partLabel: placeholderTagSchema,
  chapterLabel: placeholderTagSchema,
  topicTitle: placeholderTagSchema,
  subsectionTitle: placeholderTagSchema,
  summaryText: placeholderTagSchema,
  imageCaption: placeholderTagSchema.optional(),
  figureRef: placeholderTagSchema.optional(),
}).strict();

export const templateProfileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  themeId: z.string().regex(/^[a-z0-9-]+$/),
  pageIntents: z.array(pageIntentSchema).min(1),
  supportedRoles: z.array(semanticRoleSchema).min(1),
  semanticSlots: z.array(semanticSlotSchema).min(1).max(12),
  auxiliaryBindings: slotBindingsSchema.optional(),
  pageBindings: pageBindingsSchema,
  blockCapacity: z.number().int().min(1).max(12),
  supportedBlocks: z.array(slideBlockTypeSchema).min(1),
  imageSlots: z.number().int().min(0).max(12),
  densityRange: z.tuple([templateDensitySchema, templateDensitySchema]),
  maxCharsBySlot: z.record(z.string(), z.number().int().positive()),
  maxRasterAreaRatio: z.number().min(0).max(1),
  requiredLandmarks: z.array(semanticLandmarkSchema).min(1),
  documentCompatibility: z.object({
    bid: z.boolean(),
    proposal: z.boolean(),
    presentation: z.boolean(),
  }).strict(),
  format: z.literal("a4-landscape"),
  status: z.literal("approved"),
}).strict().superRefine((profile, context) => {
  const slotIds = profile.semanticSlots.map((slot) => slot.id);
  if (new Set(slotIds).size !== slotIds.length) {
    context.addIssue({ code: "custom", message: "Semantic slot IDs must be unique", path: ["semanticSlots"] });
  }
  const densityOrder = ["low", "medium", "high"];
  if (densityOrder.indexOf(profile.densityRange[0]) > densityOrder.indexOf(profile.densityRange[1])) {
    context.addIssue({ code: "custom", message: "densityRange must be ordered", path: ["densityRange"] });
  }
  const declaredCapacity = profile.semanticSlots.reduce((total, slot) => total + slot.itemCapacity, 0);
  if (declaredCapacity < profile.blockCapacity) {
    context.addIssue({ code: "custom", message: "Semantic slot capacity must cover blockCapacity", path: ["semanticSlots"] });
  }
});

export type PageIntent = z.infer<typeof pageIntentSchema>;
export type SemanticLandmark = z.infer<typeof semanticLandmarkSchema>;
export type SemanticSlot = z.infer<typeof semanticSlotSchema>;
export type TemplateProfile = z.infer<typeof templateProfileSchema>;

export interface TemplateCandidate {
  slug: string;
  score: number;
}

export interface TemplateSelection {
  slug: string;
  score: number;
  reason: string;
  candidates: TemplateCandidate[];
}
