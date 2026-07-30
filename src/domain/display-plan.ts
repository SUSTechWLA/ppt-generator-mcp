import * as z from "zod/v4";

import { semanticRoleSchema } from "./page-blueprint.js";
import { criticalAnchorKindSchema, extractCanonicalAnchors } from "./critical-anchor.js";
import { joinChineseClauses } from "./chinese-punctuation.js";

const factIdSchema = z.string().regex(/^fact-\d+$/);
const groupIdSchema = z.string().regex(/^group-\d+$/);

export const sourceSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: z.string().min(1).max(500),
}).strict().refine((span) => span.end > span.start, "Source span end must be after start");

export const criticalAnchorSchema = sourceSpanSchema.extend({
  kind: criticalAnchorKindSchema,
}).strict();

export const displayFactCoverageSchema = z.object({
  factId: factIdSchema,
  displayItemId: groupIdSchema,
  sourceText: z.string().min(1).max(500),
  selectedSpans: z.array(sourceSpanSchema).min(1).max(100),
  criticalAnchors: z.array(criticalAnchorSchema).max(100),
  displayText: z.string().min(1).max(500),
  omittedCharacterCount: z.number().int().nonnegative().max(500),
  extractionLevel: z.enum(["full", "clause", "anchor"]),
}).strict().superRefine((coverage, context) => {
  let previousEnd = -1;
  for (const [index, span] of coverage.selectedSpans.entries()) {
    if (span.start < previousEnd) {
      context.addIssue({ code: "custom", message: "Selected source spans must be ordered and disjoint", path: ["selectedSpans", index] });
    }
    if (coverage.sourceText.slice(span.start, span.end) !== span.text) {
      context.addIssue({ code: "custom", message: "Selected span must be an exact source substring", path: ["selectedSpans", index] });
    }
    previousEnd = span.end;
  }
  for (const [index, anchor] of coverage.criticalAnchors.entries()) {
    if (coverage.sourceText.slice(anchor.start, anchor.end) !== anchor.text) {
      context.addIssue({ code: "custom", message: "Critical anchor must be an exact source substring", path: ["criticalAnchors", index] });
    }
    if (!coverage.selectedSpans.some((span) => span.start <= anchor.start && span.end >= anchor.end)) {
      context.addIssue({ code: "custom", message: "Every critical anchor must be retained by a selected span", path: ["criticalAnchors", index] });
    }
  }
  const canonicalAnchors = extractCanonicalAnchors(coverage.sourceText);
  if (canonicalAnchors.length !== coverage.criticalAnchors.length
    || canonicalAnchors.some((anchor, index) => {
      const declared = coverage.criticalAnchors[index];
      return !declared || anchor.kind !== declared.kind || anchor.start !== declared.start
        || anchor.end !== declared.end || anchor.text !== declared.text;
    })) {
    context.addIssue({ code: "custom", message: "Critical anchors must equal canonical source extraction", path: ["criticalAnchors"] });
  }
  const rebuilt = coverage.selectedSpans.map((span) => span.text).join("，");
  if (rebuilt !== coverage.displayText) {
    context.addIssue({ code: "custom", message: "Display text must be rebuilt only from selected source spans", path: ["displayText"] });
  }
  const retained = coverage.selectedSpans.reduce((total, span) => total + span.text.length, 0);
  if (coverage.omittedCharacterCount !== coverage.sourceText.length - retained) {
    context.addIssue({ code: "custom", message: "Omitted character count must match selected spans", path: ["omittedCharacterCount"] });
  }
});

export const displayItemSchema = z.object({
  id: groupIdSchema,
  order: z.number().int().nonnegative(),
  role: semanticRoleSchema,
  title: z.string().trim().min(2).max(30),
  body: z.string().trim().min(1).max(500),
  sourceFactIds: z.array(factIdSchema).min(1),
}).strict();

export const displayTargetBudgetSchema = z.object({
  blockCapacity: z.number().int().min(1).max(12),
  semanticPositionCapacity: z.number().int().min(1).max(144),
  factBindingPositionCapacity: z.number().int().min(1).max(144),
  itemCapacity: z.number().int().min(1).max(12),
  maxCharsPerItem: z.number().int().min(1).max(500),
  minimumBodyFontPt: z.number().min(8.5).max(24),
  positionBudgets: z.array(z.object({
    displayItemId: groupIdSchema,
    slotId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    itemIndex: z.number().int().nonnegative(),
    maxChars: z.number().int().min(1).max(500),
  }).strict()).min(1).max(144),
}).strict();

export const displayGroundingSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().trim().min(1).max(500)).max(200),
  mappedFactIds: z.array(factIdSchema),
  displayedCharacterCount: z.number().int().nonnegative(),
  omittedCharacterCount: z.number().int().nonnegative(),
}).strict();

export const displayPlanSchema = z.object({
  version: z.literal(1),
  items: z.array(displayItemSchema).min(1).max(12),
  factCoverages: z.array(displayFactCoverageSchema).min(1),
  targetBudget: displayTargetBudgetSchema,
  grounding: displayGroundingSchema,
}).strict().superRefine((plan, context) => {
  const itemIds = plan.items.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({ code: "custom", message: "Display item IDs must be unique", path: ["items"] });
  }
  if (plan.items.some((item, index) => item.order !== index || item.id !== `group-${index + 1}`)) {
    context.addIssue({ code: "custom", message: "Display items must be ordered and contiguous", path: ["items"] });
  }
  const flattened = plan.items.flatMap((item) => item.sourceFactIds);
  const covered = plan.factCoverages.map((coverage) => coverage.factId);
  if (flattened.length !== covered.length || flattened.some((factId, index) => factId !== covered[index])) {
    context.addIssue({ code: "custom", message: "Display items and fact coverage must map facts exactly once in order", path: ["factCoverages"] });
  }
  const coverageByFact = new Map(plan.factCoverages.map((coverage) => [coverage.factId, coverage]));
  for (const [index, item] of plan.items.entries()) {
    const coverages = item.sourceFactIds.map((factId) => coverageByFact.get(factId));
    if (coverages.some((coverage) => !coverage || coverage.displayItemId !== item.id)) {
      context.addIssue({ code: "custom", message: "Fact coverage must reference its owning display item", path: ["items", index] });
      continue;
    }
    if (joinChineseClauses(coverages.map((coverage) => coverage!.displayText)) !== item.body) {
      context.addIssue({ code: "custom", message: "Display item body must be rebuilt from fact coverage text", path: ["items", index, "body"] });
    }
  }
  const omitted = plan.factCoverages.reduce((total, coverage) => total + coverage.omittedCharacterCount, 0);
  const displayed = plan.items.reduce((total, item) => total + item.body.length, 0);
  if (omitted !== plan.grounding.omittedCharacterCount) {
    context.addIssue({ code: "custom", message: "Grounding omitted-character evidence is inconsistent", path: ["grounding"] });
  }
  if (displayed !== plan.grounding.displayedCharacterCount) {
    context.addIssue({ code: "custom", message: "Grounding displayed-character evidence is inconsistent", path: ["grounding"] });
  }
  if (plan.grounding.passed !== (plan.grounding.issues.length === 0)) {
    context.addIssue({ code: "custom", message: "Grounding pass state must agree with issues", path: ["grounding"] });
  }
  if (plan.grounding.mappedFactIds.length !== covered.length
    || plan.grounding.mappedFactIds.some((factId, index) => factId !== covered[index])) {
    context.addIssue({ code: "custom", message: "Grounding mapped facts must match coverage order", path: ["grounding", "mappedFactIds"] });
  }
});

export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type CriticalAnchor = z.infer<typeof criticalAnchorSchema>;
export type DisplayFactCoverage = z.infer<typeof displayFactCoverageSchema>;
export type DisplayItem = z.infer<typeof displayItemSchema>;
export type DisplayTargetBudget = z.infer<typeof displayTargetBudgetSchema>;
export type DisplayPlan = z.infer<typeof displayPlanSchema>;
