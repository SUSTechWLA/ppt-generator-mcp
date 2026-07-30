import {
  displayPlanSchema,
  type CriticalAnchor,
  type DisplayFactCoverage,
  type DisplayPlan,
  type SourceSpan,
} from "../domain/display-plan.js";
import {
  pageBlueprintSchema,
  type PageBlueprint,
  type PageContentGroup,
  type SemanticRole,
} from "../domain/page-blueprint.js";
import type { DocumentType } from "../domain/document-context.js";
import type { SourceDocument, SourceFact } from "../domain/source-document.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { extractCanonicalAnchors } from "../domain/critical-anchor.js";
import { chineseClauseSeparator, joinChineseClauses } from "../domain/chinese-punctuation.js";
import { groundedRoleForFacts, groundedTitleForRole, projectGroundedDensity, projectGroundedVisualIntents } from "../domain/slide-projection.js";
import { effectiveProfilePositions, type EffectiveProfilePosition } from "../domain/profile-capability.js";

export interface GroundedDisplayContext {
  pageNumber: number;
  title: string;
  documentType: DocumentType;
  profile: TemplateProfile;
  audience?: string;
}

export interface GroundedDisplayResult {
  blueprint: PageBlueprint;
  displayPlan: DisplayPlan;
  retainedCharacterCount: number;
}

interface ExtractionCandidate {
  spans: SourceSpan[];
  displayText: string;
  extractionLevel: DisplayFactCoverage["extractionLevel"];
  retainedCharacters: number;
}

interface FactChoice {
  fact: SourceFact;
  candidate: ExtractionCandidate;
  anchors: CriticalAnchor[];
}

interface PlannedItem {
  role: SemanticRole;
  choices: FactChoice[];
  position: EffectiveProfilePosition;
}

interface SearchPlan {
  items: PlannedItem[];
  retainedCharacters: number;
  compressedFacts: number;
  skippedPositions: number;
}

const ALLOWED_FACT_SEPARATOR = "；";
const ALLOWED_SPAN_SEPARATOR = "，";

function capacityError(message: string, diagnostics: string): never {
  throw new WorkflowError({
    code: "INPUT_INVALID",
    stage: "build_page_blueprint",
    retryable: false,
    message,
    recovery: diagnostics,
  });
}

function trimSpan(text: string, start: number, end: number): SourceSpan | undefined {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && /\s/u.test(text[nextStart])) nextStart += 1;
  while (nextEnd > nextStart && /\s/u.test(text[nextEnd - 1])) nextEnd -= 1;
  if (nextEnd <= nextStart) return undefined;
  return { start: nextStart, end: nextEnd, text: text.slice(nextStart, nextEnd) };
}

function mergeSpans(text: string, spans: SourceSpan[]): SourceSpan[] {
  const ordered = spans.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SourceSpan[] = [];
  for (const span of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
      previous.text = text.slice(previous.start, previous.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function clauseSpans(text: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[，；。：:!?！？]/u.test(text[index])) continue;
    const span = trimSpan(text, start, index);
    if (span) spans.push(span);
    start = index + 1;
  }
  const tail = trimSpan(text, start, text.length);
  if (tail) spans.push(tail);
  return spans;
}

function containsAnchor(span: SourceSpan, anchor: CriticalAnchor): boolean {
  return span.start <= anchor.start && span.end >= anchor.end;
}

function candidateFromSpans(
  spans: SourceSpan[],
  level: ExtractionCandidate["extractionLevel"],
): ExtractionCandidate {
  return {
    spans,
    displayText: spans.map((span) => span.text).join(ALLOWED_SPAN_SEPARATOR),
    extractionLevel: level,
    retainedCharacters: spans.reduce((total, span) => total + span.text.length, 0),
  };
}

function extractionCandidates(fact: SourceFact, anchors: CriticalAnchor[]): ExtractionCandidate[] {
  const text = fact.text;
  const full = candidateFromSpans([{ start: 0, end: text.length, text }], "full");
  const clauses = clauseSpans(text);
  const candidates: ExtractionCandidate[] = [full];
  const anchorClauses = mergeSpans(text, clauses.filter((clause) => anchors.some((anchor) => containsAnchor(clause, anchor))));
  const fallbackClause = clauses.reduce<SourceSpan | undefined>((best, clause) => !best || clause.text.length > best.text.length ? clause : best, undefined);
  const clauseSelection = anchorClauses.length > 0 ? anchorClauses : fallbackClause ? [fallbackClause] : [];
  if (clauseSelection.length > 0) candidates.push(candidateFromSpans(clauseSelection, "clause"));

  const exactAnchorSelection = mergeSpans(text, anchors.map((anchor) => ({
    start: anchor.start,
    end: anchor.end,
    text: anchor.text,
  })));
  if (exactAnchorSelection.length > 0) candidates.push(candidateFromSpans(exactAnchorSelection, "anchor"));

  const windows = anchors.map((anchor) => trimSpan(text, Math.max(0, anchor.start - 6), Math.min(text.length, anchor.end + 8)))
    .filter((span): span is SourceSpan => Boolean(span));
  if (windows.length === 0 && fallbackClause) {
    const length = Math.min(fallbackClause.text.length, Math.max(8, Math.ceil(fallbackClause.text.length * 0.35)));
    const core = trimSpan(text, fallbackClause.start, fallbackClause.start + length);
    if (core) windows.push(core);
  }
  const anchorSelection = mergeSpans(text, windows);
  if (anchorSelection.length > 0 && anchors.every((anchor) => anchorSelection.some((span) => containsAnchor(span, anchor)))) {
    candidates.push(candidateFromSpans(anchorSelection, "anchor"));
  }

  const unique = new Map<string, ExtractionCandidate>();
  for (const candidate of candidates) {
    if (!candidate.displayText || !anchors.every((anchor) => candidate.spans.some((span) => containsAnchor(span, anchor)))) continue;
    const key = candidate.spans.map((span) => `${span.start}:${span.end}`).join("|");
    const existing = unique.get(key);
    if (!existing || candidate.retainedCharacters > existing.retainedCharacters) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => right.retainedCharacters - left.retainedCharacters);
}

interface Combination {
  choices: FactChoice[];
  length: number;
  retainedCharacters: number;
  compressedFacts: number;
}

function betterCombination(left: Combination | undefined, right: Combination): Combination {
  if (!left) return right;
  if (right.retainedCharacters !== left.retainedCharacters) return right.retainedCharacters > left.retainedCharacters ? right : left;
  if (right.compressedFacts !== left.compressedFacts) return right.compressedFacts < left.compressedFacts ? right : left;
  return right.length > left.length ? right : left;
}

function compactRange(
  facts: SourceFact[],
  anchors: CriticalAnchor[][],
  candidates: ExtractionCandidate[][],
  start: number,
  end: number,
  limit: number,
): Combination | undefined {
  let states = new Map<number, Combination>([[0, { choices: [], length: 0, retainedCharacters: 0, compressedFacts: 0 }]]);
  for (let index = start; index < end; index += 1) {
    const next = new Map<number, Combination>();
    for (const state of states.values()) {
      for (const candidate of candidates[index]) {
        const previous = state.choices.at(-1)?.candidate.displayText;
        const separator = previous
          ? chineseClauseSeparator(previous, candidate.displayText, ALLOWED_FACT_SEPARATOR)
          : "";
        const length = state.length + separator.length + candidate.displayText.length;
        if (length > limit) continue;
        const choice: Combination = {
          choices: [...state.choices, { fact: facts[index], candidate, anchors: anchors[index] }],
          length,
          retainedCharacters: state.retainedCharacters + candidate.retainedCharacters,
          compressedFacts: state.compressedFacts + Number(candidate.extractionLevel !== "full"),
        };
        next.set(length, betterCombination(next.get(length), choice));
      }
    }
    states = next;
    if (states.size === 0) return undefined;
  }
  return [...states.values()].reduce<Combination | undefined>(betterCombination, undefined);
}

function balancePenalty(items: PlannedItem[]): number {
  if (items.length <= 1) return 0;
  const lengths = items.map((item) => joinChineseClauses(
    item.choices.map((choice) => choice.candidate.displayText),
    ALLOWED_FACT_SEPARATOR,
  ).length);
  return Math.max(...lengths) - Math.min(...lengths);
}

function betterPlan(left: SearchPlan | undefined, right: SearchPlan): SearchPlan {
  if (!left) return right;
  if (right.retainedCharacters !== left.retainedCharacters) return right.retainedCharacters > left.retainedCharacters ? right : left;
  if (right.compressedFacts !== left.compressedFacts) return right.compressedFacts < left.compressedFacts ? right : left;
  const rightBalance = balancePenalty(right.items);
  const leftBalance = balancePenalty(left.items);
  if (rightBalance !== leftBalance) return rightBalance < leftBalance ? right : left;
  if (right.skippedPositions !== left.skippedPositions) return right.skippedPositions < left.skippedPositions ? right : left;
  return right.items.length < left.items.length ? right : left;
}

function searchDisplayPlan(source: SourceDocument, profile: TemplateProfile): { plan?: SearchPlan; positions: EffectiveProfilePosition[] } {
  const facts = source.facts;
  const positions = effectiveProfilePositions(profile);
  const anchors = facts.map((fact) => extractCanonicalAnchors(fact.text));
  const candidates = facts.map((fact, index) => extractionCandidates(fact, anchors[index]));
  const combinationCache = new Map<string, Combination | undefined>();
  const searchCache = new Map<string, SearchPlan | undefined>();
  const requiredSlotIds = profile.semanticSlots.filter((slot) => slot.required).map((slot) => slot.id);
  const requiredBitBySlot = new Map(requiredSlotIds.map((slotId, index) => [slotId, 1 << index]));
  const requiredMask = requiredSlotIds.reduce((mask, _, index) => mask | (1 << index), 0);

  const range = (start: number, end: number, limit: number): Combination | undefined => {
    const key = `${start}:${end}:${limit}`;
    if (combinationCache.has(key)) return combinationCache.get(key);
    const result = compactRange(facts, anchors, candidates, start, end, limit);
    combinationCache.set(key, result);
    return result;
  };

  const visit = (factIndex: number, positionIndex: number, itemsUsed: number, filledRequiredMask: number): SearchPlan | undefined => {
    if (factIndex === facts.length) {
      return filledRequiredMask === requiredMask
        ? { items: [], retainedCharacters: 0, compressedFacts: 0, skippedPositions: 0 }
        : undefined;
    }
    if (positionIndex >= positions.length || itemsUsed >= profile.blockCapacity) return undefined;
    const key = `${factIndex}:${positionIndex}:${itemsUsed}:${filledRequiredMask}`;
    if (searchCache.has(key)) return searchCache.get(key);
    const position = positions[positionIndex];
    let best: SearchPlan | undefined;

    const skipped = visit(factIndex, positionIndex + 1, itemsUsed, filledRequiredMask);
    if (skipped) best = { ...skipped, skippedPositions: skipped.skippedPositions + 1 };

    for (let end = factIndex + 1; end <= facts.length; end += 1) {
      const factsInGroup = facts.slice(factIndex, end);
      const role = groundedRoleForFacts(factsInGroup);
      if (!profile.supportedRoles.includes(role) || !position.slot.acceptedRoles.includes(role)) continue;
      const compacted = range(factIndex, end, position.maxChars);
      if (!compacted) continue;
      const bit = requiredBitBySlot.get(position.slot.id) ?? 0;
      const tail = visit(end, positionIndex + 1, itemsUsed + 1, filledRequiredMask | bit);
      if (!tail) continue;
      best = betterPlan(best, {
        items: [{ role, choices: compacted.choices, position }, ...tail.items],
        retainedCharacters: compacted.retainedCharacters + tail.retainedCharacters,
        compressedFacts: compacted.compressedFacts + tail.compressedFacts,
        skippedPositions: tail.skippedPositions,
      });
    }
    searchCache.set(key, best);
    return best;
  };

  return { plan: visit(0, 0, 0, 0), positions };
}

export function verifyGroundedDisplay(
  sourceFacts: SourceFact[],
  groups: PageContentGroup[],
  plan: DisplayPlan,
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const expectedIds = sourceFacts.map((fact) => fact.id);
  const groupedIds = groups.flatMap((group) => group.sourceFactIds);
  const coverageIds = plan.factCoverages.map((coverage) => coverage.factId);
  if (groupedIds.length !== expectedIds.length || groupedIds.some((factId, index) => factId !== expectedIds[index])) {
    issues.push("Displayed groups do not cover source facts exactly once in order");
  }
  if (coverageIds.length !== expectedIds.length || coverageIds.some((factId, index) => factId !== expectedIds[index])) {
    issues.push("Fact coverage evidence does not preserve source order");
  }
  const factsById = new Map(sourceFacts.map((fact) => [fact.id, fact]));
  const coveragesById = new Map(plan.factCoverages.map((coverage) => [coverage.factId, coverage]));
  for (const coverage of plan.factCoverages) {
    const fact = factsById.get(coverage.factId);
    if (!fact || coverage.sourceText !== fact.text) {
      issues.push(`Coverage source mismatch for ${coverage.factId}`);
      continue;
    }
    const rebuilt = coverage.selectedSpans.map((span) => fact.text.slice(span.start, span.end)).join(ALLOWED_SPAN_SEPARATOR);
    if (rebuilt !== coverage.displayText) issues.push(`Coverage is not extractively rebuilt for ${coverage.factId}`);
    const canonicalAnchors = extractCanonicalAnchors(fact.text);
    if (canonicalAnchors.length !== coverage.criticalAnchors.length
      || canonicalAnchors.some((anchor, index) => {
        const declared = coverage.criticalAnchors[index];
        return !declared || anchor.kind !== declared.kind || anchor.start !== declared.start
          || anchor.end !== declared.end || anchor.text !== declared.text;
      })) {
      issues.push(`Declared anchors do not equal canonical source anchors for ${coverage.factId}`);
    }
    for (const anchor of canonicalAnchors) {
      if (!coverage.selectedSpans.some((span) => span.start <= anchor.start && span.end >= anchor.end)) {
        issues.push(`Critical ${anchor.kind} anchor is missing for ${coverage.factId}`);
      }
    }
  }
  for (const [index, group] of groups.entries()) {
    const expectedBody = joinChineseClauses(
      group.sourceFactIds.map((factId) => coveragesById.get(factId)?.displayText ?? ""),
      ALLOWED_FACT_SEPARATOR,
    );
    if (group.body !== expectedBody) issues.push(`Display body is not grounded for group-${index + 1}`);
    const budget = plan.targetBudget.positionBudgets.find((position) => position.displayItemId === group.id);
    if (!budget || group.body.length > budget.maxChars) issues.push(`Display body exceeds its profile budget for ${group.id}`);
  }
  return { passed: issues.length === 0, issues };
}

export function planGroundedDisplay(source: SourceDocument, context: GroundedDisplayContext): GroundedDisplayResult {
  if (source.facts.length === 0) capacityError("Source page has no extractable facts", "Add factual body content after 正文：.");
  if (source.facts.length > 200) {
    capacityError(
      `Source page contains ${source.facts.length} facts, above the auditable display-plan limit`,
      `No facts were dropped. Split the upstream explicit page before retrying; received ${source.facts.length}, supported at most 200.`,
    );
  }
  const { plan, positions } = searchDisplayPlan(source, context.profile);
  if (!plan) {
    const minimumAnchorCharacters = source.facts.reduce((total, fact) => {
      const spans = mergeSpans(fact.text, extractCanonicalAnchors(fact.text).map((anchor) => ({ start: anchor.start, end: anchor.end, text: anchor.text })));
      return total + spans.reduce((sum, span) => sum + span.text.length, 0);
    }, 0);
    capacityError(
      `Content cannot fit profile capacity without losing grounded source anchors`,
      `profile=${context.profile.slug}; facts=${source.facts.length}; blocks=${context.profile.blockCapacity}; semanticPositions=${positions.length}; minimumAnchorCharacters=${minimumAnchorCharacters}`,
    );
  }

  const sourceSectionById = new Map(source.sections.map((section) => [section.id, section]));
  const factCoverages: DisplayFactCoverage[] = [];
  const groups: PageContentGroup[] = plan.items.map((item, index) => {
    const id = `group-${index + 1}`;
    for (const choice of item.choices) {
      factCoverages.push({
        factId: choice.fact.id,
        displayItemId: id,
        sourceText: choice.fact.text,
        selectedSpans: choice.candidate.spans,
        criticalAnchors: choice.anchors,
        displayText: choice.candidate.displayText,
        omittedCharacterCount: choice.fact.text.length - choice.candidate.retainedCharacters,
        extractionLevel: choice.candidate.extractionLevel,
      });
    }
    const facts = item.choices.map((choice) => choice.fact);
    return {
      id,
      order: index,
      role: item.role,
      title: groundedTitleForRole(item.role),
      body: joinChineseClauses(
        item.choices.map((choice) => choice.candidate.displayText),
        ALLOWED_FACT_SEPARATOR,
      ),
      sourceSectionIds: [...new Set(facts.map((fact) => fact.sourceSectionId).filter((sectionId) => sourceSectionById.has(sectionId)))],
      sourceFactIds: facts.map((fact) => fact.id),
    };
  });
  const assets = projectGroundedVisualIntents({
    pageNumber: context.pageNumber,
    title: context.title,
    groups,
    sourceFacts: source.facts,
    maxAssets: context.profile.imageSlots.maxAssets,
  });
  if (assets.length < context.profile.imageSlots.minAssets) {
    capacityError(
      "Profile requires an image but the page has no semantically justified visual group",
      `profile=${context.profile.slug}; minimumAssets=${context.profile.imageSlots.minAssets}; visual candidates require a process or comparison group with at least three source facts.`,
    );
  }
  const density = projectGroundedDensity(source.facts);
  const blueprint = pageBlueprintSchema.parse({
    version: 1,
    pageNumber: context.pageNumber,
    title: context.title,
    documentType: context.documentType,
    ...(context.audience ? { audience: context.audience } : {}),
    groups,
    sourceFactIds: source.facts.map((fact) => fact.id),
    density,
    visualNeed: assets.length > 0 ? "supporting" : "none",
    assets,
  });
  const selectedLimits = plan.items.map((item) => item.position.maxChars);
  const itemCapacity = Math.min(context.profile.blockCapacity, positions.length);
  const displayPlanDraft = {
    version: 1 as const,
    items: groups.map((group) => ({
      id: group.id,
      order: group.order,
      role: group.role,
      title: group.title,
      body: group.body,
      sourceFactIds: group.sourceFactIds,
    })),
    factCoverages,
    targetBudget: {
      blockCapacity: context.profile.blockCapacity,
      semanticPositionCapacity: positions.length,
      factBindingPositionCapacity: positions.length,
      itemCapacity,
      maxCharsPerItem: Math.min(...selectedLimits),
      minimumBodyFontPt: context.profile.minimumBodyFontPt,
      positionBudgets: plan.items.map((item, index) => ({
        displayItemId: `group-${index + 1}`,
        slotId: item.position.slot.id,
        itemIndex: item.position.itemIndex,
        maxChars: item.position.maxChars,
      })),
    },
    grounding: {
      passed: true,
      issues: [] as string[],
      mappedFactIds: source.facts.map((fact) => fact.id),
      displayedCharacterCount: groups.reduce((total, group) => total + group.body.length, 0),
      omittedCharacterCount: factCoverages.reduce((total, coverage) => total + coverage.omittedCharacterCount, 0),
    },
  };
  const preliminary = displayPlanSchema.parse(displayPlanDraft);
  const grounding = verifyGroundedDisplay(source.facts, groups, preliminary);
  const displayPlan = displayPlanSchema.parse({ ...displayPlanDraft, grounding: { ...displayPlanDraft.grounding, ...grounding } });
  if (!displayPlan.grounding.passed) {
    capacityError("Grounded display verification failed", displayPlan.grounding.issues.join("; "));
  }
  return { blueprint, displayPlan, retainedCharacterCount: plan.retainedCharacters };
}
