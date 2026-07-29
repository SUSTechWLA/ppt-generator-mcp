import {
  pageBlueprintSchema,
  type BlueprintDensity,
  type PageBlueprint,
  type PageContentGroup,
  type SemanticRole,
} from "../domain/page-blueprint.js";
import { slideSpecSchema, type SlideBlockType, type SlideSpec } from "../domain/slide-spec.js";
import {
  sourceDocumentSchema,
  type SourceDocument,
  type SourceFact,
  type SourceSection,
} from "../domain/source-document.js";
import type { DocumentType } from "../domain/document-context.js";
import { WorkflowError } from "../domain/workflow-error.js";

export interface BuildPageBlueprintContext {
  pageNumber: number;
  title: string;
  documentType: DocumentType;
  audience?: string;
}

interface FactUnit {
  fact: SourceFact;
  section: SourceSection;
  role: SemanticRole;
}

interface GroupDraft {
  role: SemanticRole;
  facts: SourceFact[];
  sections: SourceSection[];
}

const MAX_GROUPS = 12;
const MAX_GROUP_BODY_LENGTH = 500;
const PROCESS_CUE = /(?:第[一二三四五六七八九十]+阶段|第[一二三四五六七八九十]+步|首先|其次|然后|随后|最后|每日|每周|每月|流程|步骤|启动|到场|提交|审核|审批|批准后|交接|上线|发布)/;
const COMPARISON_CUE = /(?:相比|较之|对比|高于|低于|优于|劣于|同比|环比|\bversus\b|\bvs\.?\b)/i;
const METRIC_CUE = /\d[\d,.]*(?:%|万元|元|个工作日|工作日|分钟|小时|天|日|周|个月|月|年|㎡|家|个|名|项|次|台|套|家)?/;
const CONCLUSION_CUE = /^(?:因此|所以|综上|由此|结论)|(?:形成|实现|保障|确保|达成)/;
const DEPENDENCY_LEAD = /^(?:该|其|此|上述|前述|其中|同时|并且|并|且|随后|批准后|审批后|通过后|未经)/;
const DISCOURSE_CONTINUATION = /^(?:此外|另外|补充(?:说明)?|同样)[，,:\s]*/;
const APPROVAL_CUE = /(?:申请|审核|审批|批准|同意|许可|签字)/;

const ROLE_LABELS: Record<SemanticRole, string> = {
  headline: "页面主题",
  conclusion: "核心结论",
  fact: "关键事实",
  metric: "量化指标",
  process: "实施流程",
  comparison: "对比分析",
  evidence: "事实依据",
  visual: "视觉说明",
};

function planningError(message: string, recovery: string): never {
  throw new WorkflowError({
    code: "INPUT_INVALID",
    stage: "build_page_blueprint",
    retryable: false,
    message,
    recovery,
  });
}

function roleFor(fact: SourceFact): SemanticRole {
  if (COMPARISON_CUE.test(fact.text)) return "comparison";
  if (PROCESS_CUE.test(fact.text)) return "process";
  if (METRIC_CUE.test(fact.text)) return "metric";
  if (CONCLUSION_CUE.test(fact.text)) return "conclusion";
  if (fact.kind === "name") return "evidence";
  return "fact";
}

function normalizedBody(facts: SourceFact[]): string {
  return facts.map((fact) => fact.text.trim()).join("\n");
}

function leadingSubject(value: string): string | undefined {
  const match = value.match(/^([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z\d]{1,11}?)(?:作为|负责|覆盖|完成|启动|到场|提交|审核|审批|保留|将|应|须|可|为|在)/u);
  return match?.[1];
}

function sharesSubject(left: SourceFact, right: SourceFact): boolean {
  const leftSubject = leadingSubject(left.text);
  const rightSubject = leadingSubject(right.text);
  return Boolean(leftSubject && rightSubject && leftSubject === rightSubject);
}

function continuesRepeatedSubject(left: SourceFact, right: SourceFact): boolean {
  if (!DISCOURSE_CONTINUATION.test(right.text)) return false;
  const leftSubject = leadingSubject(left.text);
  const rightSubject = leadingSubject(right.text.replace(DISCOURSE_CONTINUATION, ""));
  return Boolean(leftSubject && rightSubject && leftSubject === rightSubject);
}

function isDependency(left: SourceFact, right: SourceFact): boolean {
  if (DEPENDENCY_LEAD.test(right.text)) return true;
  return APPROVAL_CUE.test(left.text)
    && (APPROVAL_CUE.test(right.text) || METRIC_CUE.test(right.text));
}

function canJoin(group: GroupDraft, unit: FactUnit): boolean {
  const previous = group.facts[group.facts.length - 1];
  const previousSection = group.sections[group.sections.length - 1];
  if (!previous || previousSection.id !== unit.section.id) return false;
  if (normalizedBody([...group.facts, unit.fact]).length > MAX_GROUP_BODY_LENGTH) return false;
  if (isDependency(previous, unit.fact)) return true;
  if (continuesRepeatedSubject(previous, unit.fact)) return true;
  if (group.role === "process" && unit.role === "process") return true;
  if (group.role === unit.role && sharesSubject(previous, unit.fact)) return true;
  return sharesSubject(previous, unit.fact)
    && group.role !== "comparison"
    && unit.role !== "comparison";
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

function mergeDrafts(left: GroupDraft, right: GroupDraft): GroupDraft {
  return {
    role: combineRole(left.role, right.role),
    facts: [...left.facts, ...right.facts],
    sections: [...left.sections, ...right.sections],
  };
}

function reduceToGroupBound(groups: GroupDraft[]): GroupDraft[] {
  const reduced = [...groups];
  while (reduced.length > MAX_GROUPS) {
    const candidates = reduced.slice(0, -1)
      .map((group, index) => {
        const next = reduced[index + 1];
        const combinedLength = normalizedBody([...group.facts, ...next.facts]).length;
        const sameSection = group.sections[group.sections.length - 1]?.id === next.sections[0]?.id;
        const sameRole = group.role === next.role;
        return {
          index,
          combinedLength,
          score: (sameSection ? 0 : 10_000) + (sameRole ? 0 : 1_000) + combinedLength,
        };
      })
      .filter((candidate) => candidate.combinedLength <= MAX_GROUP_BODY_LENGTH)
      .sort((left, right) => left.score - right.score || left.index - right.index);

    const candidate = candidates[0];
    if (!candidate) {
      planningError(
        "Source facts exceed the honest page blueprint capacity",
        "Paginate the source into more pages before building page blueprints.",
      );
    }
    reduced.splice(candidate.index, 2, mergeDrafts(reduced[candidate.index], reduced[candidate.index + 1]));
  }
  return reduced;
}

function groupFacts(source: SourceDocument): GroupDraft[] {
  const sectionsById = new Map(source.sections.map((section) => [section.id, section]));
  const units = source.facts.map((fact): FactUnit => {
    const section = sectionsById.get(fact.sourceSectionId);
    if (!section) {
      planningError(
        `Source fact ${fact.id} references unknown section ${fact.sourceSectionId}`,
        "Normalize the source again before planning the page.",
      );
    }
    return { fact, section, role: roleFor(fact) };
  });
  const groups: GroupDraft[] = [];

  for (const unit of units) {
    const current = groups[groups.length - 1];
    if (current && canJoin(current, unit)) {
      current.facts.push(unit.fact);
      current.sections.push(unit.section);
      current.role = combineRole(current.role, unit.role);
    } else {
      groups.push({ role: unit.role, facts: [unit.fact], sections: [unit.section] });
    }
  }
  return reduceToGroupBound(groups);
}

function groupTitle(group: GroupDraft): string {
  const headings = Array.from(new Set(group.sections.map((section) => section.heading.trim()).filter(Boolean)));
  const heading = headings[0];
  const roleLabel = ROLE_LABELS[group.role];
  if (!heading) return roleLabel;
  const title = heading === roleLabel ? heading : `${heading}·${roleLabel}`;
  return title.slice(0, 60);
}

function contentGroups(drafts: GroupDraft[]): PageContentGroup[] {
  return drafts.map((group, index) => ({
    id: `group-${index + 1}`,
    order: index,
    role: group.role,
    title: groupTitle(group),
    body: normalizedBody(group.facts),
    sourceSectionIds: Array.from(new Set(group.sections.map((section) => section.id))),
    sourceFactIds: group.facts.map((fact) => fact.id),
  }));
}

function densityFor(source: SourceDocument, groups: PageContentGroup[]): BlueprintDensity {
  const characterCount = source.facts.reduce((total, fact) => total + Array.from(fact.text).length, 0);
  if (source.facts.length <= 2 && characterCount <= 180) return "low";
  if (source.facts.length <= 6 && groups.length <= 4 && characterCount <= 600) return "medium";
  return "high";
}

function explanatoryGroup(groups: PageContentGroup[]): PageContentGroup | undefined {
  return groups.find((group) => group.role === "process" && group.sourceFactIds.length >= 4)
    ?? groups.find((group) => group.role === "comparison" && group.sourceFactIds.length >= 3);
}

function validateSource(source: SourceDocument): void {
  if (source.facts.length === 0) {
    planningError("Source document contains no facts", "Provide at least one factual source sentence.");
  }
  const factIds = source.facts.map((fact) => fact.id);
  if (new Set(factIds).size !== factIds.length) {
    planningError("Source fact IDs must be unique", "Normalize the source again before planning the page.");
  }
}

export function buildPageBlueprint(
  rawSource: SourceDocument,
  context: BuildPageBlueprintContext,
): PageBlueprint {
  const source = sourceDocumentSchema.parse(rawSource);
  validateSource(source);
  const groups = contentGroups(groupFacts(source));
  const explanatory = explanatoryGroup(groups);
  const promptFacts = explanatory?.body.replace(/\s+/g, " ").slice(0, 700);
  const assets = explanatory ? [{
    id: `p${context.pageNumber}-img-001`,
    role: "visual" as const,
    groupId: explanatory.id,
    prompt: `Create a clear explanatory illustration for "${context.title}" grounded in this source sequence: ${promptFacts}. Use a neutral professional setting and clear spatial relationships; no text, no logo, no watermark.`,
    alt: `${context.title}${ROLE_LABELS[explanatory.role]}示意图`.slice(0, 120),
    sourceFactIds: explanatory.sourceFactIds,
    width: 1792 as const,
    height: 1024 as const,
  }] : [];

  return pageBlueprintSchema.parse({
    version: 1,
    pageNumber: context.pageNumber,
    title: context.title,
    documentType: context.documentType,
    ...(context.audience ? { audience: context.audience } : {}),
    groups,
    sourceFactIds: source.facts.map((fact) => fact.id),
    density: densityFor(source, groups),
    visualNeed: assets.length === 1 ? "supporting" : "none",
    assets,
  });
}

function blockTypeFor(role: SemanticRole): SlideBlockType {
  if (role === "metric") return "metric";
  if (role === "process") return "process";
  if (role === "comparison") return "table";
  if (role === "visual") return "image";
  return "text";
}

function metricValues(body: string): Array<{ label: string; value: string }> {
  const values = body.match(new RegExp(METRIC_CUE.source, "g")) ?? [];
  return values.slice(0, 6).map((value) => ({
    label: "正文指标",
    value: value.slice(0, 30),
  }));
}

function slideTitle(title: string): string {
  const compact = title.trim().slice(0, 40);
  return compact.length >= 4 ? compact : `${compact}概览`.slice(0, 40);
}

export function materializeSlideSpec(rawBlueprint: PageBlueprint): SlideSpec {
  const blueprint = pageBlueprintSchema.parse(rawBlueprint);
  const blockIdByGroup = new Map<string, string>();
  const blocks = blueprint.groups.map((group, index) => {
    const blockId = `block-${index + 1}`;
    blockIdByGroup.set(group.id, blockId);
    return {
      id: blockId,
      type: blockTypeFor(group.role),
      title: group.title.slice(0, 30),
      body: group.body,
      bullets: [],
      metrics: metricValues(group.body),
      sourceFactIds: group.sourceFactIds,
      semanticRole: group.role,
    };
  });
  const assets = blueprint.assets.map((asset) => ({
    id: asset.id,
    type: "image" as const,
    blockId: blockIdByGroup.get(asset.groupId) ?? "",
    prompt: asset.prompt,
    alt: asset.alt,
    sourceFactIds: asset.sourceFactIds,
    width: asset.width,
    height: asset.height,
  }));

  const spec = slideSpecSchema.parse({
    title: slideTitle(blueprint.title),
    conclusion: "本页内容按原文事实顺序组织呈现。",
    blocks,
    assets,
    sourceFactIds: blueprint.sourceFactIds,
    designIntent: {
      tone: "professional",
      density: blueprint.density,
      visualRatio: assets.length === 0 ? 0 : 0.18,
    },
  });

  const materializedFactIds = spec.blocks.flatMap((block) => block.sourceFactIds);
  if (materializedFactIds.length !== blueprint.sourceFactIds.length
    || materializedFactIds.some((factId, index) => factId !== blueprint.sourceFactIds[index])) {
    planningError(
      "Materialized slide blocks do not preserve page facts exactly once in source order",
      "Rebuild the page blueprint before selecting a template.",
    );
  }
  return spec;
}
