import * as z from "zod/v4";
import { documentTypeSchema, pageMetadataSchema } from "./document-context.js";
import { displayPlanSchema } from "./display-plan.js";
import { generateSlideOutputSchema } from "./quality-report.js";
import { externalAssetInputSchema, hashCanonical, qualitySettingsSchema, sourceFactSchema, sourceSectionInputSchema } from "./source-document.js";
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

const metadataFieldSchema = z.enum([
  "pageTitle", "pageNumber", "sectionTitle", "partNumber", "partLabel",
  "chapterLabel", "topicTitle", "subsectionTitle", "summaryText", "imageCaption", "figureRef",
]);

const persistedPageBindingsSchema = z.object({
  pageTitle: z.string().regex(/^[a-z][a-z0-9-]*$/),
  pageNumber: z.string().regex(/^[a-z][a-z0-9-]*$/),
  sectionTitle: z.string().regex(/^[a-z][a-z0-9-]*$/),
  partNumber: z.string().regex(/^[a-z][a-z0-9-]*$/),
  partLabel: z.string().regex(/^[a-z][a-z0-9-]*$/),
  chapterLabel: z.string().regex(/^[a-z][a-z0-9-]*$/),
  topicTitle: z.string().regex(/^[a-z][a-z0-9-]*$/),
  subsectionTitle: z.string().regex(/^[a-z][a-z0-9-]*$/),
  summaryText: z.string().regex(/^[a-z][a-z0-9-]*$/),
  imageCaption: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  figureRef: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
}).strict();

const metadataBindingEvidenceSchema = z.object({
  field: metadataFieldSchema,
  tag: z.string().regex(/^[a-z][a-z0-9-]*$/),
  values: z.array(z.string().max(500)).max(12),
  usedChars: z.array(z.number().int().nonnegative()).max(12),
  maxChars: z.number().int().positive().max(500),
}).strict().superRefine((binding, context) => {
  if (binding.values.length !== binding.usedChars.length
    || binding.values.some((value, index) => Array.from(value).length !== binding.usedChars[index])) {
    context.addIssue({ code: "custom", message: "Metadata character evidence must equal emitted values", path: ["usedChars"] });
  }
  if (binding.usedChars.some((used) => used > binding.maxChars)) {
    context.addIssue({ code: "custom", message: "Metadata value exceeds its profile binding capacity", path: ["values"] });
  }
});

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
  pageBindings: persistedPageBindingsSchema,
  metadataBindings: z.array(metadataBindingEvidenceSchema).min(9).max(11),
  profileCapabilityHash: z.string().regex(/^[0-9a-f]{64}$/),
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

function orderedEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function metadataExpectedValues(slide: z.infer<typeof deckSlidePlanSchema>): Record<z.infer<typeof metadataFieldSchema>, string[]> {
  const blockById = new Map(slide.plannedSpec.blocks.map((block) => [block.id, block]));
  const imageAssets = slide.plannedSpec.assets.filter((asset) => asset.type === "image");
  return {
    pageTitle: [slide.plannedSpec.title],
    pageNumber: [String(slide.page.number)],
    sectionTitle: [slide.page.sectionTitle],
    partNumber: [slide.page.partNumber],
    partLabel: [slide.page.partLabel],
    chapterLabel: [slide.page.chapterLabel],
    topicTitle: [slide.plannedSpec.title],
    subsectionTitle: [slide.page.subsectionTitle],
    summaryText: [slide.plannedSpec.conclusion],
    imageCaption: imageAssets.map((asset) => asset.alt),
    figureRef: imageAssets.map((asset) => blockById.get(asset.blockId)?.title ?? asset.alt),
  };
}

function capabilityFingerprint(slide: z.infer<typeof deckSlidePlanSchema>): string {
  const match = slide.templateMatch;
  return hashCanonical({
    templateSlug: slide.templateSlug,
    themeId: match.themeId,
    profileVersion: match.profileVersion,
    blockCapacity: match.blockCapacity,
    semanticItemCapacity: match.semanticItemCapacity,
    effectiveItemCapacity: match.effectiveItemCapacity,
    effectiveMaxCharsPerItem: match.effectiveMaxCharsPerItem,
    minimumBodyFontPt: match.minimumBodyFontPt,
    maxRasterAreaRatio: match.maxRasterAreaRatio,
    pageBindings: match.pageBindings,
    metadataBindings: match.metadataBindings.map(({ field, tag, maxChars }) => ({ field, tag, maxChars })),
  });
}

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
  if (slide.originalSourceSectionIds.length !== slide.sourceSections.length
    || new Set(slide.originalSourceSectionIds).size !== slide.originalSourceSectionIds.length) {
    context.addIssue({ code: "custom", message: "Original section IDs must map source sections exactly once", path: ["originalSourceSectionIds"] });
  }
  const sectionIds = new Set(slide.originalSourceSectionIds);
  if (slide.originalSourceFacts.some((fact) => !sectionIds.has(fact.sourceSectionId))) {
    context.addIssue({ code: "custom", message: "Original facts must reference page-local source sections", path: ["originalSourceFacts"] });
  }
  const factsById = new Map(slide.originalSourceFacts.map((fact) => [fact.id, fact]));
  for (const [index, coverage] of slide.displayPlan.factCoverages.entries()) {
    if (factsById.get(coverage.factId)?.text !== coverage.sourceText) {
      context.addIssue({ code: "custom", message: "Coverage source text must equal the immutable original fact", path: ["displayPlan", "factCoverages", index, "sourceText"] });
    }
  }
  for (const [index, item] of slide.displayPlan.items.entries()) {
    const block = slide.plannedSpec.blocks[index];
    if (!block || block.id !== `block-${index + 1}` || item.id !== `group-${index + 1}`
      || block.semanticRole !== item.role || block.title !== item.title || block.body !== item.body
      || !orderedEqual(block.sourceFactIds, item.sourceFactIds)) {
      context.addIssue({ code: "custom", message: "Display items and planned blocks must be exact deterministic projections", path: ["plannedSpec", "blocks", index] });
    }
    const budget = slide.displayPlan.targetBudget.positionBudgets.find((entry) => entry.displayItemId === item.id);
    const assignment = slide.templateMatch.assignments.find((entry) => entry.groupId === item.id);
    if (!budget || !assignment || budget.slotId !== assignment.slotId || budget.itemIndex !== assignment.itemIndex
      || budget.maxChars !== assignment.maxChars || assignment.usedChars !== Array.from(item.body).length
      || Array.from(item.body).length > budget.maxChars || assignment.role !== item.role
      || !orderedEqual(assignment.sourceFactIds, item.sourceFactIds)) {
      context.addIssue({ code: "custom", message: "Position budget and slot assignment evidence must match visible content", path: ["templateMatch", "assignments"] });
    }
  }
  if (slide.displayPlan.targetBudget.positionBudgets.length !== slide.displayPlan.items.length
    || slide.templateMatch.assignments.length !== slide.displayPlan.items.length) {
    context.addIssue({ code: "custom", message: "Every visible item requires exactly one position and assignment", path: ["templateMatch", "assignments"] });
  }
  const tightestSelectedLimit = Math.min(...slide.displayPlan.targetBudget.positionBudgets.map((budget) => budget.maxChars));
  const declaredEffectiveItems = Math.min(
    slide.displayPlan.targetBudget.blockCapacity,
    slide.displayPlan.targetBudget.semanticPositionCapacity,
    slide.displayPlan.targetBudget.factBindingPositionCapacity,
  );
  if (slide.displayPlan.targetBudget.maxCharsPerItem !== tightestSelectedLimit
    || slide.displayPlan.targetBudget.itemCapacity !== declaredEffectiveItems
    || slide.displayPlan.items.length > declaredEffectiveItems) {
    context.addIssue({ code: "custom", message: "Display target budget must use the tightest persisted capabilities", path: ["displayPlan", "targetBudget"] });
  }
  const capacitySlots = new Set(slide.templateMatch.capacityUse.map((capacity) => capacity.slotId));
  if (capacitySlots.size !== slide.templateMatch.capacityUse.length
    || slide.templateMatch.assignments.some((assignment) => !capacitySlots.has(assignment.slotId))) {
    context.addIssue({ code: "custom", message: "Capacity evidence must cover every assigned semantic slot", path: ["templateMatch", "capacityUse"] });
  }
  for (const [index, capacity] of slide.templateMatch.capacityUse.entries()) {
    const assigned = slide.templateMatch.assignments.filter((assignment) => assignment.slotId === capacity.slotId);
    if (capacity.usedItems !== assigned.length
      || capacity.usedChars !== assigned.reduce((total, assignment) => total + assignment.usedChars, 0)
      || capacity.itemCapacity < capacity.usedItems) {
      context.addIssue({ code: "custom", message: "Slot capacity totals must equal assignment evidence", path: ["templateMatch", "capacityUse", index] });
    }
  }
  const expectedMetadata = metadataExpectedValues(slide);
  const requiredFields = Object.entries(slide.templateMatch.pageBindings)
    .filter(([, tag]) => tag !== undefined)
    .map(([field]) => field as z.infer<typeof metadataFieldSchema>);
  const evidenceFields = slide.templateMatch.metadataBindings.map((binding) => binding.field);
  if (new Set(evidenceFields).size !== evidenceFields.length
    || requiredFields.length !== evidenceFields.length
    || requiredFields.some((field) => !evidenceFields.includes(field))) {
    context.addIssue({ code: "custom", message: "Metadata evidence must cover every declared page binding exactly once", path: ["templateMatch", "metadataBindings"] });
  }
  for (const [index, binding] of slide.templateMatch.metadataBindings.entries()) {
    if (slide.templateMatch.pageBindings[binding.field] !== binding.tag
      || !orderedEqual(binding.values, expectedMetadata[binding.field])) {
      context.addIssue({ code: "custom", message: "Metadata evidence must equal emitted page values and tags", path: ["templateMatch", "metadataBindings", index] });
    }
  }
  const selectedCandidate = slide.templateMatch.candidateScores.find((candidate) => candidate.slug === slide.templateSlug);
  if (!selectedCandidate || selectedCandidate.score !== slide.templateMatch.selectionScore) {
    context.addIssue({ code: "custom", message: "Selection evidence must identify the persisted template", path: ["templateMatch", "candidateScores"] });
  }
  if (slide.templateMatch.profileCapabilityHash !== capabilityFingerprint(slide)) {
    context.addIssue({ code: "custom", message: "Profile capability evidence fingerprint mismatch", path: ["templateMatch", "profileCapabilityHash"] });
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
  if (deck.preferredThemeId && deck.slides.some((slide) => slide.templateMatch.themeId !== deck.preferredThemeId)) {
    context.addIssue({ code: "custom", message: "Every selected profile must belong to the preferred theme", path: ["slides"] });
  }
});

export const planDeckOutputSchema = z.object({
  plannedDeck: plannedDeckSchema,
  assets: z.array(assetSpecSchema).max(30),
  nextStep: z.string().min(1).max(500),
}).strict().superRefine((output, context) => {
  const plannedAssets = output.plannedDeck.slides.flatMap((slide) => slide.plannedSpec.assets);
  if (plannedAssets.length !== output.assets.length
    || plannedAssets.some((asset, index) => JSON.stringify(asset) !== JSON.stringify(output.assets[index]))) {
    context.addIssue({ code: "custom", message: "Top-level assets must equal page-scoped planned assets", path: ["assets"] });
  }
});

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
