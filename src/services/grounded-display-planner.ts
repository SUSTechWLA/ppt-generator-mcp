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
import type { SemanticSlot, TemplateProfile } from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { extractCanonicalAnchors } from "../domain/critical-anchor.js";

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

interface EffectivePosition {
  slot: SemanticSlot;
  itemIndex: number;
  maxChars: number;
  catalogIndex: number;
}

interface PlannedItem {
  role: SemanticRole;
  choices: FactChoice[];
  position: EffectivePosition;
}

interface SearchPlan {
  items: PlannedItem[];
  retainedCharacters: number;
  compressedFacts: number;
  skippedPositions: number;
}

const ALLOWED_FACT_SEPARATOR = "；";
const ALLOWED_SPAN_SEPARATOR = "，";
const PROCESS_CUE = /(?:第[一二三四五六七八九十\d]+步|首先|其次|然后|随后|最后|每日|每周|每月|流程|步骤|启动|到场|提交|审核|审批|批准|交接|记录|反馈)/u;
const COMPARISON_CUE = /(?:相比|较之|对比|高于|低于|优于|劣于|同比|环比|\bversus\b|\bvs\.?\b)/iu;
const METRIC_CUE = /(?:\d[\d,.]*(?:%|万元|元|个工作日|工作日|分钟|小时|天|日|周|个月|月|年|㎡|家|个|名|项|次|台|套)?|[零一二三四五六七八九十百千万两]+(?:个工作日|工作日|分钟|小时|天|日|周|个月|月|年|家|个|名|项|次|台|套))/u;
const CONCLUSION_CUE = /^(?:因此|所以|综上|由此|结论)|(?:形成|实现|保障|确保|达成)/u;

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

function roleFor(fact: SourceFact): SemanticRole {
  if (COMPARISON_CUE.test(fact.text)) return "comparison";
  if (PROCESS_CUE.test(fact.text)) return "process";
  if (METRIC_CUE.test(fact.text)) return "metric";
  if (CONCLUSION_CUE.test(fact.text)) return "conclusion";
  if (fact.kind === "name") return "evidence";
  return "fact";
}

function combineRole(left: SemanticRole, right: SemanticRole): SemanticRole {
  if (left === right) return left;
  if (left === "process" || right === "process") return "process";
  if (left === "comparison" || right === "comparison") return "comparison";
  if (left === "metric" || right === "metric") return "metric";
  if (left === "conclusion" || right === "conclusion") return "conclusion";
  if (left === "evidence" || right === "evidence") return "evidence";
  return "fact";
}

function groupRole(facts: SourceFact[]): SemanticRole {
  return facts.map(roleFor).reduce(combineRole);
}

function effectivePositions(profile: TemplateProfile): EffectivePosition[] {
  const auxiliaryFactLimits = Object.entries(profile.auxiliaryBindings ?? {})
    .filter(([field]) => ["body", "narrativeBody", "tableCell"].includes(field))
    .map(([, tag]) => profile.maxCharsBySlot[tag])
    .filter((limit): limit is number => typeof limit === "number");
  const slots = profile.semanticSlots
    .map((slot, catalogIndex) => ({ slot, catalogIndex }))
    .sort((left, right) => left.slot.priority - right.slot.priority || left.catalogIndex - right.catalogIndex);
  return slots.flatMap(({ slot, catalogIndex }) => {
    const factTag = slot.bindings[slot.factBearingBinding];
    const limits = [slot.maxCharsPerItem, factTag ? profile.maxCharsBySlot[factTag] : undefined, ...auxiliaryFactLimits]
      .filter((limit): limit is number => typeof limit === "number" && limit > 0);
    const maxChars = Math.min(...limits);
    return Array.from({ length: slot.itemCapacity }, (_, itemIndex) => ({ slot, itemIndex, maxChars, catalogIndex }));
  });
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
        const separator = state.choices.length === 0 ? 0 : ALLOWED_FACT_SEPARATOR.length;
        const length = state.length + separator + candidate.displayText.length;
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
  const lengths = items.map((item) => item.choices.reduce((total, choice, index) => total + choice.candidate.displayText.length + Number(index > 0), 0));
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

function searchDisplayPlan(source: SourceDocument, profile: TemplateProfile): { plan?: SearchPlan; positions: EffectivePosition[] } {
  const facts = source.facts;
  const positions = effectivePositions(profile);
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
      const role = groupRole(factsInGroup);
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

const ROLE_TITLES: Record<SemanticRole, string> = {
  headline: "页面主题",
  conclusion: "核心结论",
  fact: "关键事实",
  metric: "量化指标",
  process: "实施流程",
  comparison: "对比分析",
  evidence: "事实依据",
  visual: "视觉说明",
};

function planVisualAsset(
  context: GroundedDisplayContext,
  groups: PageContentGroup[],
  factsById: Map<string, SourceFact>,
): PageBlueprint["assets"] {
  if (context.profile.imageSlots.maxAssets < 1) return [];
  const explanatory = groups.find((group) => group.role === "process" && group.sourceFactIds.length >= 3)
    ?? groups.find((group) => group.role === "comparison" && group.sourceFactIds.length >= 3);
  if (!explanatory) return [];
  const promptSource = explanatory.sourceFactIds.map((factId) => factsById.get(factId)?.text ?? "").filter(Boolean).join(" ");
  const prompt = `Create a restrained professional bid-document illustration for "${context.title}" grounded in this source sequence: ${promptSource}. Show clear spatial or procedural relationships; no text, no logo, no watermark.`;
  if (prompt.length > 1_200) return [];
  return [{
    id: `p${context.pageNumber}-img-001`,
    role: "visual",
    groupId: explanatory.id,
    prompt,
    alt: `${context.title}专业示意图`.slice(0, 120),
    sourceFactIds: explanatory.sourceFactIds,
    width: 1792,
    height: 1024,
  }];
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
    const expectedBody = group.sourceFactIds.map((factId) => coveragesById.get(factId)?.displayText ?? "").join(ALLOWED_FACT_SEPARATOR);
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
      title: ROLE_TITLES[item.role],
      body: item.choices.map((choice) => choice.candidate.displayText).join(ALLOWED_FACT_SEPARATOR),
      sourceSectionIds: [...new Set(facts.map((fact) => fact.sourceSectionId).filter((sectionId) => sourceSectionById.has(sectionId)))],
      sourceFactIds: facts.map((fact) => fact.id),
    };
  });
  const assets = planVisualAsset(context, groups, new Map(source.facts.map((fact) => [fact.id, fact])));
  if (assets.length < context.profile.imageSlots.minAssets) {
    capacityError(
      "Profile requires an image but the page has no semantically justified visual group",
      `profile=${context.profile.slug}; minimumAssets=${context.profile.imageSlots.minAssets}; visual candidates require a process or comparison group with at least three source facts.`,
    );
  }
  const sourceCharacters = source.facts.reduce((total, fact) => total + fact.text.length, 0);
  const density = source.facts.length <= 2 && sourceCharacters <= 180 ? "low" : source.facts.length <= 6 && sourceCharacters <= 600 ? "medium" : "high";
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
