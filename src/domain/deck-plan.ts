import * as z from "zod/v4";
import { documentTypeSchema, pageMetadataSchema } from "./document-context.js";
import { displayPlanSchema } from "./display-plan.js";
import { generateSlideOutputSchema } from "./quality-report.js";
import { externalAssetInputSchema, qualitySettingsSchema, sourceFactSchema, sourceSectionInputSchema } from "./source-document.js";
import { assetSpecSchema, slideSpecSchema } from "./slide-spec.js";

const sourceChoice = {
  sourceMarkdown: z.string().trim().min(20).max(120_000).optional(),
  sourceText: z.string().trim().min(20).max(120_000).optional(),
};

export const planDeckInputSchema = z.object({
  ...sourceChoice,
  pageNumbers: z.array(z.number().int().min(1).max(9999)).min(1).max(30),
  documentType: documentTypeSchema.default("bid"),
  templateSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  preferredThemeId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  audience: z.string().trim().max(200).optional(),
  quality: qualitySettingsSchema,
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict().superRefine((value, context) => {
  const sources = Number(Boolean(value.sourceMarkdown)) + Number(Boolean(value.sourceText));
  if (sources !== 1) context.addIssue({ code: "custom", message: "Provide exactly one source" });
  if (value.pageNumbers.some((number, index) => index > 0 && number <= value.pageNumbers[index - 1])) {
    context.addIssue({ code: "custom", message: "pageNumbers must be strictly increasing" });
  }
});

const slotAssignmentSchema = z.object({
  groupId: z.string().regex(/^group-\d+$/),
  slotId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  itemIndex: z.number().int().nonnegative(),
  role: z.enum(["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence", "visual"]),
  usedChars: z.number().int().nonnegative(),
  maxChars: z.number().int().positive(),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  transformation: z.literal("none"),
}).strict();

const slotCapacityUseSchema = z.object({
  slotId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  usedItems: z.number().int().nonnegative(),
  itemCapacity: z.number().int().positive(),
  usedChars: z.number().int().nonnegative(),
  characterCapacity: z.number().int().positive(),
}).strict();

const slotDiagnosticSchema = z.object({
  groupId: z.string(),
  role: z.enum(["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence", "visual"]),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const deckTemplateMatchSchema = z.object({
  themeId: z.string().regex(/^[a-z0-9-]+$/),
  profileVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  selectionScore: z.number().finite(),
  selectionReason: z.string().trim().min(1).max(1_000),
  candidateScores: z.array(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), score: z.number().finite() }).strict()).min(1),
  blockCapacity: z.number().int().positive(),
  semanticItemCapacity: z.number().int().positive(),
  effectiveItemCapacity: z.number().int().positive(),
  effectiveMaxCharsPerItem: z.number().int().positive(),
  minimumBodyFontPt: z.number().min(8.5),
  maxRasterAreaRatio: z.number().min(0).max(1),
  assignments: z.array(slotAssignmentSchema),
  capacityUse: z.array(slotCapacityUseSchema),
  transformations: z.array(z.object({
    type: z.enum(["merge", "compress", "project-decorative"]),
    groupIds: z.array(z.string().regex(/^group-\d+$/)),
    detail: z.string().trim().min(1).max(1_000),
  }).strict()),
  unmatched: z.array(slotDiagnosticSchema),
  representedFactIds: z.array(z.string().regex(/^fact-\d+$/)),
  unrepresentedFactIds: z.array(z.string().regex(/^fact-\d+$/)),
}).strict();

export const deckSlidePlanSchema = z.object({
  page: pageMetadataSchema,
  sourceSections: z.array(sourceSectionInputSchema).min(1),
  originalSourceSectionIds: z.array(z.string().regex(/^section-\d+$/)).min(1),
  originalSourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  originalSourceFacts: z.array(sourceFactSchema).min(1),
  displayPlan: displayPlanSchema,
  plannedSpec: slideSpecSchema,
  templateSlug: z.string().regex(/^[a-z0-9-]+$/),
  templateMatch: deckTemplateMatchSchema,
}).strict().superRefine((slide, context) => {
  const factIds = slide.originalSourceFacts.map((fact) => fact.id);
  const displayedIds = slide.displayPlan.factCoverages.map((coverage) => coverage.factId);
  const blockIds = slide.plannedSpec.blocks.flatMap((block) => block.sourceFactIds);
  const representedIds = slide.templateMatch.representedFactIds;
  for (const [path, ids] of [
    ["originalSourceFacts", factIds],
    ["displayPlan", displayedIds],
    ["plannedSpec", blockIds],
    ["templateMatch", representedIds],
  ] as const) {
    if (ids.length !== slide.originalSourceFactIds.length
      || ids.some((factId, index) => factId !== slide.originalSourceFactIds[index])) {
      context.addIssue({ code: "custom", message: "Every persisted page representation must preserve source fact order", path: [path] });
    }
  }
  if (slide.plannedSpec.sourceFactIds.length !== slide.originalSourceFactIds.length
    || slide.plannedSpec.sourceFactIds.some((factId, index) => factId !== slide.originalSourceFactIds[index])) {
    context.addIssue({ code: "custom", message: "Planned spec fact IDs must match original source facts", path: ["plannedSpec", "sourceFactIds"] });
  }
  if (slide.templateMatch.unmatched.length > 0 || slide.templateMatch.unrepresentedFactIds.length > 0) {
    context.addIssue({ code: "custom", message: "Persisted template match must be fully feasible", path: ["templateMatch"] });
  }
  if (slide.templateMatch.effectiveItemCapacity !== slide.displayPlan.targetBudget.itemCapacity
    || slide.templateMatch.effectiveMaxCharsPerItem !== slide.displayPlan.targetBudget.maxCharsPerItem
    || slide.templateMatch.minimumBodyFontPt !== slide.displayPlan.targetBudget.minimumBodyFontPt) {
    context.addIssue({ code: "custom", message: "Template match capability evidence must equal the display target budget", path: ["templateMatch"] });
  }
  if (slide.plannedSpec.assets.some((asset) => !asset.id.startsWith(`p${slide.page.number}-`))) {
    context.addIssue({ code: "custom", message: "Every planned asset must be scoped to its page", path: ["plannedSpec", "assets"] });
  }
});

export const plannedDeckSchema = z.object({
  version: z.literal(1),
  deckPlanId: z.string().uuid(),
  sourceHash: z.string().length(64),
  documentType: documentTypeSchema,
  preferredThemeId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  pageNumbers: z.array(z.number().int().positive()),
  slides: z.array(deckSlidePlanSchema).min(1).max(30),
}).strict().superRefine((deck, context) => {
  const slideNumbers = deck.slides.map((slide) => slide.page.number);
  if (slideNumbers.length !== deck.pageNumbers.length
    || slideNumbers.some((pageNumber, index) => pageNumber !== deck.pageNumbers[index])) {
    context.addIssue({ code: "custom", message: "Planned slides must preserve the asserted page sequence", path: ["slides"] });
  }
  const assetIds = deck.slides.flatMap((slide) => slide.plannedSpec.assets.map((asset) => asset.id));
  if (new Set(assetIds).size !== assetIds.length) {
    context.addIssue({ code: "custom", message: "Deck asset IDs must be unique", path: ["slides"] });
  }
});

export const planDeckOutputSchema = z.object({
  plannedDeck: plannedDeckSchema,
  assets: z.array(assetSpecSchema).max(30),
  nextStep: z.string().min(1).max(500),
}).strict();

export const generateDeckInputSchema = z.object({
  deckPlanId: z.string().uuid(),
  externalAssets: z.array(externalAssetInputSchema).max(30),
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict();

export const deckPageResultSchema = generateSlideOutputSchema.extend({ pageNumber: z.number().int().positive() });
export const deckPageFailureSchema = z.object({
  pageNumber: z.number().int().positive(),
  status: z.literal("failed"),
  error: z.object({ code: z.string().optional(), message: z.string(), retryable: z.boolean().optional() }).strict(),
}).strict();
export const deckPageOutputSchema = z.union([deckPageResultSchema, deckPageFailureSchema]);
export const generateDeckOutputSchema = z.object({
  deckRunId: z.string().uuid(),
  deckPlanId: z.string().uuid(),
  status: z.enum(["needs_assets", "running", "partial", "delivered", "failed"]),
  pages: z.array(deckPageOutputSchema),
  missingAssetIds: z.array(z.string()),
  manifestPath: z.string(),
  consistency: z.object({ passed: z.boolean(), issues: z.array(z.string()) }).strict().optional(),
}).strict();
