import type { BlueprintDensity, PageContentGroup, PageVisualIntent, SemanticRole } from "./page-blueprint.js";
import { slideSpecSchema, type SlideBlock, type SlideBlockType, type SlideSpec } from "./slide-spec.js";
import type { SourceFact } from "./source-document.js";

const METRIC_CUE = /\d[\d,.]*(?:%|万元|元|个工作日|工作日|分钟|小时|天|日|周|个月|月|年|㎡|家|个|名|项|次|台|套|家)?/g;
const PROCESS_CUE = /(?:第[一二三四五六七八九十\d]+步|首先|其次|然后|随后|最后|每日|每周|每月|流程|步骤|启动|到场|提交|审核|审批|批准|交接|记录|反馈)/u;
const COMPARISON_CUE = /(?:相比|较之|对比|高于|低于|优于|劣于|同比|环比|\bversus\b|\bvs\.?\b)/iu;
const GROUNDED_METRIC_CUE = /(?:\d[\d,.]*(?:%|万元|元|个工作日|工作日|分钟|小时|天|日|周|个月|月|年|㎡|家|个|名|项|次|台|套)?|[零一二三四五六七八九十百千万两]+(?:个工作日|工作日|分钟|小时|天|日|周|个月|月|年|家|个|名|项|次|台|套))/u;
const CONCLUSION_CUE = /^(?:因此|所以|综上|由此|结论)|(?:形成|实现|保障|确保|达成)/u;

const GROUNDED_ROLE_TITLES: Record<SemanticRole, string> = {
  headline: "页面主题",
  conclusion: "核心结论",
  fact: "关键事实",
  metric: "量化指标",
  process: "实施流程",
  comparison: "对比分析",
  evidence: "事实依据",
  visual: "视觉说明",
};

export function groundedTitleForRole(role: SemanticRole): string {
  return GROUNDED_ROLE_TITLES[role];
}

function groundedRoleForFact(fact: Pick<SourceFact, "text" | "kind">): SemanticRole {
  if (COMPARISON_CUE.test(fact.text)) return "comparison";
  if (PROCESS_CUE.test(fact.text)) return "process";
  if (GROUNDED_METRIC_CUE.test(fact.text)) return "metric";
  if (CONCLUSION_CUE.test(fact.text)) return "conclusion";
  if (fact.kind === "name") return "evidence";
  return "fact";
}

function combineGroundedRole(left: SemanticRole, right: SemanticRole): SemanticRole {
  if (left === right) return left;
  if (left === "process" || right === "process") return "process";
  if (left === "comparison" || right === "comparison") return "comparison";
  if (left === "metric" || right === "metric") return "metric";
  if (left === "conclusion" || right === "conclusion") return "conclusion";
  if (left === "evidence" || right === "evidence") return "evidence";
  return "fact";
}

export function groundedRoleForFacts(facts: Array<Pick<SourceFact, "text" | "kind">>): SemanticRole {
  return facts.map(groundedRoleForFact).reduce(combineGroundedRole);
}

function blockTypeFor(role: SemanticRole): SlideBlockType {
  if (role === "metric") return "metric";
  if (role === "process") return "process";
  if (role === "comparison") return "table";
  if (role === "visual") return "image";
  return "text";
}

function metricValues(body: string): SlideBlock["metrics"] {
  const values = body.match(METRIC_CUE) ?? [];
  return values.slice(0, 6).map((value) => ({ label: "正文指标", value: value.slice(0, 30) }));
}

export function projectedSlideTitle(title: string): string {
  const compact = title.trim().slice(0, 40);
  return compact.length >= 4 ? compact : `${compact}概览`.slice(0, 40);
}

export interface ProjectableDisplayGroup {
  id: string;
  role: SemanticRole;
  title: string;
  body: string;
  sourceFactIds: string[];
}

export function projectGroundedDensity(sourceFacts: Array<Pick<SourceFact, "text">>): BlueprintDensity {
  const sourceCharacters = sourceFacts.reduce((total, fact) => total + fact.text.length, 0);
  if (sourceFacts.length <= 2 && sourceCharacters <= 180) return "low";
  if (sourceFacts.length <= 6 && sourceCharacters <= 600) return "medium";
  return "high";
}

export function projectSlideBlock(group: ProjectableDisplayGroup, index: number): SlideBlock {
  return {
    id: `block-${index + 1}`,
    type: blockTypeFor(group.role),
    title: group.title.slice(0, 30),
    body: group.body,
    bullets: [],
    metrics: metricValues(group.body),
    sourceFactIds: group.sourceFactIds,
    semanticRole: group.role,
  };
}

export function projectGroundedVisualIntents(input: {
  pageNumber: number;
  title: string;
  groups: ProjectableDisplayGroup[];
  sourceFacts: Array<Pick<SourceFact, "id" | "text">>;
  maxAssets: number;
}): PageVisualIntent[] {
  if (input.maxAssets < 1) return [];
  const explanatory = input.groups.find((group) => group.role === "process" && group.sourceFactIds.length >= 3)
    ?? input.groups.find((group) => group.role === "comparison" && group.sourceFactIds.length >= 3);
  if (!explanatory) return [];
  const factsById = new Map(input.sourceFacts.map((fact) => [fact.id, fact]));
  const promptSource = explanatory.sourceFactIds
    .map((factId) => factsById.get(factId)?.text ?? "")
    .filter(Boolean)
    .join(" ");
  const prompt = `Create a restrained professional bid-document illustration for "${input.title}" grounded in this source sequence: ${promptSource}. Show clear spatial or procedural relationships; no text, no logo, no watermark.`;
  if (prompt.length > 1_200) return [];
  return [{
    id: `p${input.pageNumber}-img-001`,
    role: "visual",
    groupId: explanatory.id,
    prompt,
    alt: `${input.title}专业示意图`.slice(0, 120),
    sourceFactIds: explanatory.sourceFactIds,
    width: 1792,
    height: 1024,
  }];
}

export function projectSlideSpec(input: {
  title: string;
  density: BlueprintDensity;
  groups: ProjectableDisplayGroup[];
  assets: PageVisualIntent[];
  sourceFactIds: string[];
}): SlideSpec {
  const blockIdByGroup = new Map(input.groups.map((group, index) => [group.id, `block-${index + 1}`]));
  const blocks = input.groups.map(projectSlideBlock);
  const assets = input.assets.map((asset) => ({
    id: asset.id,
    type: "image" as const,
    blockId: blockIdByGroup.get(asset.groupId) ?? "",
    prompt: asset.prompt,
    alt: asset.alt,
    sourceFactIds: asset.sourceFactIds,
    width: asset.width,
    height: asset.height,
  }));
  return slideSpecSchema.parse({
    title: projectedSlideTitle(input.title),
    conclusion: "本页内容按原文事实顺序组织呈现。",
    blocks,
    assets,
    sourceFactIds: input.sourceFactIds,
    designIntent: {
      tone: "professional",
      density: input.density,
      visualRatio: assets.length === 0 ? 0 : 0.18,
    },
  });
}

export function projectBlueprintSlideSpec(blueprint: {
  title: string;
  density: BlueprintDensity;
  groups: PageContentGroup[];
  assets: PageVisualIntent[];
  sourceFactIds: string[];
}): SlideSpec {
  return projectSlideSpec(blueprint);
}
