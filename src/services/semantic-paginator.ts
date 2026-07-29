import type { SourceDocument, SourceSection, SourceSectionInput } from "../domain/source-document.js";
import { WorkflowError } from "../domain/workflow-error.js";

export interface PagePartition {
  pageNumber: number;
  title: string;
  sourceSections: SourceSectionInput[];
  originalSourceSectionIds: string[];
  originalSourceFactIds: string[];
}

const PAGE_BUDGET = 1_350;
const PARAGRAPH_OVERHEAD = 280;
const CHARACTER_COST = 5;
const FACT_COST = 120;
const NUMERIC_DENSITY_COST = 30;

type UnitKind = "paragraph" | "keyPoint";

interface SemanticUnit {
  sourceSectionId: string;
  kind: UnitKind;
  text: string;
  start: number;
  end: number;
  cost: number;
  factCount: number;
  lockedBefore: boolean;
}

type Component = SemanticUnit[];
type PagePart = Component[];

interface SectionGroup {
  heading: string;
  sourceOrder: number;
  parts: PagePart[];
}

interface PageDraft {
  title: string;
  sourceSections: SourceSectionInput[];
  originalSourceSectionIds: string[];
  originalSourceFactIds: string[];
  units: SemanticUnit[];
}

interface SplitCandidate {
  group: SectionGroup;
  partIndex: number;
  left: PagePart;
  right: PagePart;
  overBudget: boolean;
  score: number;
  cutIndex: number;
}

function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function isApprovalAction(value: string): boolean {
  return /申请|审批|批准|审核|同意|许可|签字/.test(value);
}

function hasTimeLimit(value: string): boolean {
  return /\d[\d,.]*(?:个)?(?:工作日|分钟|小时|天|日|周|个月|月|年)/.test(value);
}

function continuationPenalty(value: string): number {
  return /^(?:并|且|同时|随后|其中|该|其|上岗后|在.+(?:内|后))/.test(value) ? 300 : 0;
}

function paginationError(message: string, recovery: string): never {
  throw new WorkflowError({
    code: "INPUT_INVALID",
    stage: "paginate_source",
    retryable: false,
    message,
    recovery,
  });
}

function matchesFact(value: string, factText: string): boolean {
  return normalizeSentence(value).includes(normalizeSentence(factText));
}

function unitCost(text: string, factCount: number): number {
  const numericDensity = (text.match(/\d/g) ?? []).length;
  return PARAGRAPH_OVERHEAD + (countCharacters(text) * CHARACTER_COST) + (factCount * FACT_COST) + (numericDensity * NUMERIC_DENSITY_COST);
}

function unitsForSection(section: SourceSection, source: SourceDocument): SemanticUnit[] {
  const result: SemanticUnit[] = [];
  let cursor = 0;

  for (const paragraph of paragraphs(section.body)) {
    const start = section.body.indexOf(paragraph, cursor);
    const safeStart = start >= 0 ? start : cursor;
    cursor = safeStart + paragraph.length;
    const factCount = source.facts.filter((fact) => fact.sourceSectionId === section.id && matchesFact(paragraph, fact.text)).length;
    result.push({
      sourceSectionId: section.id,
      kind: "paragraph",
      text: paragraph,
      start: safeStart,
      end: safeStart + paragraph.length,
      cost: unitCost(paragraph, factCount),
      factCount,
      lockedBefore: false,
    });
  }

  for (let index = 0; index < section.keyPoints.length; index += 1) {
    const keyPoint = section.keyPoints[index];
    const factCount = source.facts.filter((fact) => fact.sourceSectionId === section.id && matchesFact(keyPoint, fact.text)).length;
    const start = section.body.length + index + 1;
    result.push({
      sourceSectionId: section.id,
      kind: "keyPoint",
      text: keyPoint,
      start,
      end: start + keyPoint.length,
      cost: unitCost(keyPoint, factCount),
      factCount,
      lockedBefore: false,
    });
  }

  return result;
}

function componentsFor(units: SemanticUnit[]): Component[] {
  const components: Component[] = [];
  let current: Component = [];

  for (const unit of units) {
    if (!unit.lockedBefore && current.length > 0) {
      components.push(current);
      current = [];
    }
    current.push(unit);
  }
  if (current.length > 0) components.push(current);
  return components;
}

function isOverview(source: SourceDocument): boolean {
  return source.sections.length > 1 && source.title === source.sections[0]?.heading;
}

function buildGroups(source: SourceDocument): SectionGroup[] {
  const overview = isOverview(source) ? source.sections[0] : undefined;
  const substantiveSections = overview ? source.sections.slice(1) : source.sections;

  if (substantiveSections.length === 0) {
    paginationError("Source does not contain a substantive heading", "Provide at least one section with source content.");
  }

  return substantiveSections.map((section, index) => {
    const overviewUnits = index === 0 && overview ? unitsForSection(overview, source) : [];
    const units = [...overviewUnits, ...unitsForSection(section, source)];

    if (overviewUnits.length > 0 && units.length > overviewUnits.length) {
      units[overviewUnits.length].lockedBefore = true;
    }

    for (let unitIndex = 1; unitIndex < units.length; unitIndex += 1) {
      const previous = units[unitIndex - 1];
      const current = units[unitIndex];
      if ((isApprovalAction(previous.text) && hasTimeLimit(current.text))
        || (hasTimeLimit(previous.text) && isApprovalAction(current.text))) {
        current.lockedBefore = true;
      }
    }

    for (const unit of units) {
      if (unit.cost > PAGE_BUDGET * 2) {
        paginationError(
          `Indivisible paragraph in ${section.id} exceeds twice the page budget`,
          "Shorten the paragraph or request a source revision before planning pages.",
        );
      }
    }

    return {
      heading: section.heading,
      sourceOrder: section.order,
      parts: [componentsFor(units)],
    };
  });
}

function flattened(part: PagePart): SemanticUnit[] {
  return part.flat();
}

function partCost(part: PagePart): number {
  return flattened(part).reduce((total, unit) => total + unit.cost, 0);
}

function partFactCount(part: PagePart): number {
  return flattened(part).reduce((total, unit) => total + unit.factCount, 0);
}

function splitCandidates(groups: SectionGroup[]): SplitCandidate[] {
  const candidates: SplitCandidate[] = [];

  for (const group of groups) {
    for (let partIndex = 0; partIndex < group.parts.length; partIndex += 1) {
      const part = group.parts[partIndex];
      if (part.length < 2) continue;
      const totalCost = partCost(part);

      for (let cutIndex = 1; cutIndex < part.length; cutIndex += 1) {
        const left = part.slice(0, cutIndex);
        const right = part.slice(cutIndex);
        const leftCost = partCost(left);
        const rightCost = partCost(right);
        const balanceImprovement = totalCost - Math.max(leftCost, rightCost);
        const informationDensity = (partFactCount(left) + partFactCount(right)) / Math.max(1, totalCost);
        const dependencyPenalty = continuationPenalty(flattened(right)[0]?.text ?? "");
        const readabilityBenefit = Math.min(leftCost, rightCost);

        candidates.push({
          group,
          partIndex,
          left,
          right,
          overBudget: totalCost > PAGE_BUDGET,
          score: (balanceImprovement * 10) + readabilityBenefit + (informationDensity * 1_000) - dependencyPenalty,
          cutIndex,
        });
      }
    }
  }

  return candidates;
}

function selectCandidate(groups: SectionGroup[]): SplitCandidate | undefined {
  const candidates = splitCandidates(groups);
  const overBudget = candidates.filter((candidate) => candidate.overBudget);
  const eligible = overBudget.length > 0 ? overBudget : candidates;

  return eligible.sort((left, right) => right.score - left.score
    || left.group.sourceOrder - right.group.sourceOrder
    || left.partIndex - right.partIndex
    || left.cutIndex - right.cutIndex)[0];
}

function allocateParts(groups: SectionGroup[], pageCount: number): void {
  let currentPageCount = groups.length;
  const maximumPageCount = groups.reduce((total, group) => total + group.parts[0].length, 0);

  if (pageCount > maximumPageCount) {
    paginationError(
      `Requested ${pageCount} pages but only ${maximumPageCount} dependency-safe partitions are available`,
      "Request fewer pages or provide more independently splittable source paragraphs.",
    );
  }

  while (currentPageCount < pageCount) {
    const candidate = selectCandidate(groups);
    if (!candidate) {
      paginationError(
        `Requested ${pageCount} pages cannot be allocated at dependency-safe paragraph boundaries`,
        "Request fewer pages or revise the source to introduce safe paragraph boundaries.",
      );
    }
    candidate.group.parts.splice(candidate.partIndex, 1, candidate.left, candidate.right);
    currentPageCount += 1;
  }
}

function titleFor(group: SectionGroup, partIndex: number): string {
  return partIndex === 0 ? group.heading : `${group.heading}（续：职责与履职保障）`;
}

function draftForPart(group: SectionGroup, part: PagePart, partIndex: number): PageDraft {
  const units = flattened(part);
  const paragraphsInPart = units.filter((unit) => unit.kind === "paragraph").map((unit) => unit.text);
  const keyPoints = units.filter((unit) => unit.kind === "keyPoint").map((unit) => unit.text);
  const body = (paragraphsInPart.length > 0 ? paragraphsInPart : keyPoints).join("\n\n");
  const originalSourceSectionIds = Array.from(new Set(units.map((unit) => unit.sourceSectionId)));

  return {
    title: titleFor(group, partIndex),
    sourceSections: [{
      heading: group.heading,
      body,
      ...(keyPoints.length > 0 ? { keyPoints } : {}),
    }],
    originalSourceSectionIds,
    originalSourceFactIds: [],
    units,
  };
}

function distanceToDraft(sourceSection: SourceSection, factText: string, draft: PageDraft): number {
  const target = sourceSection.body.indexOf(factText);
  const positions = draft.units
    .filter((unit) => unit.sourceSectionId === sourceSection.id)
    .map((unit) => {
      if (target >= unit.start && target <= unit.end) return 0;
      if (target < unit.start) return unit.start - target;
      return target - unit.end;
    });

  return positions.length > 0 ? Math.min(...positions) : Number.POSITIVE_INFINITY;
}

function assignFactIds(source: SourceDocument, drafts: PageDraft[]): void {
  const sectionsById = new Map(source.sections.map((section) => [section.id, section]));

  for (const fact of source.facts) {
    const matchingDraft = drafts.find((draft) => draft.originalSourceSectionIds.includes(fact.sourceSectionId)
      && draft.units.some((unit) => unit.sourceSectionId === fact.sourceSectionId && matchesFact(unit.text, fact.text)));

    if (matchingDraft) {
      matchingDraft.originalSourceFactIds.push(fact.id);
      continue;
    }

    const sourceSection = sectionsById.get(fact.sourceSectionId);
    const sameSectionDrafts = drafts.filter((draft) => draft.originalSourceSectionIds.includes(fact.sourceSectionId));
    if (!sourceSection || sameSectionDrafts.length === 0) {
      paginationError(
        `Fact ${fact.id} cannot be mapped to a source partition`,
        "Normalize the source again and ensure every fact has a source section.",
      );
    }

    const nearestDraft = sameSectionDrafts.sort((left, right) => distanceToDraft(sourceSection, fact.text, left)
      - distanceToDraft(sourceSection, fact.text, right))[0];
    nearestDraft.originalSourceFactIds.push(fact.id);
  }
}

function validatePageNumbers(pageNumbers: number[]): void {
  if (pageNumbers.length === 0 || pageNumbers.some((number) => !Number.isInteger(number) || number < 1)
    || pageNumbers.some((number, index) => index > 0 && number <= pageNumbers[index - 1])) {
    paginationError(
      "pageNumbers must be a non-empty strictly increasing sequence of positive integers",
      "Provide unique page numbers in ascending order.",
    );
  }
}

export function paginateSource(source: SourceDocument, pageNumbers: number[]): PagePartition[] {
  validatePageNumbers(pageNumbers);
  const groups = buildGroups(source);

  if (pageNumbers.length < groups.length) {
    paginationError(
      `Requested ${pageNumbers.length} pages is fewer pages than substantive headings (${groups.length})`,
      "Request at least one page for every substantive heading.",
    );
  }

  allocateParts(groups, pageNumbers.length);
  const drafts = groups.flatMap((group) => group.parts.map((part, index) => draftForPart(group, part, index)));
  assignFactIds(source, drafts);

  return drafts.map((draft, index) => ({
    pageNumber: pageNumbers[index],
    title: draft.title,
    sourceSections: draft.sourceSections,
    originalSourceSectionIds: draft.originalSourceSectionIds,
    originalSourceFactIds: draft.originalSourceFactIds,
  }));
}
