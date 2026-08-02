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

// Strong topic suffixes used to derive a short, meaningful title/label from a
// source fact. Longer compounds come first so "绿化面积" wins over bare "面积".
const TOPIC_SUFFIXES = [
  "总建筑面积", "建筑面积", "占地面积", "绿化面积", "服务范围", "作业清单", "养护标准", "操作规程",
  "面积", "规模", "总量", "总额", "金额", "范围", "需求", "目标", "要求", "标准", "责任", "分工", "流程",
  "计划", "清单", "方案", "机制", "体系", "制度", "组织", "安排", "任务", "项目", "阶段", "措施",
  "人员", "设备", "物资", "记录", "资料", "质量", "安全", "响应", "保障", "单位", "区域", "内容", "事项",
  "步骤", "程序", "条件", "情况", "状况", "效果", "结果", "指标", "配置", "类型", "环节", "节点",
  "台账", "档案", "建档", "归档", "编号", "核查", "巡查", "复核", "交接", "调度", "统筹", "分类", "规程",
  "作业", "检查", "方式", "能力", "状态", "特点", "差异", "重点", "关键", "依据", "要点", "成效",
];

const LEADING_FILLERS = /^(?:本次|本项目?|该项目?|本|该|此|各|其中|另外|同时|此外|对于|关于|结合|根据|依据|按照|按|以|为|为满足|在|对|围绕|针对|以下|如下|双方)+/u;

/**
 * Derive a short, source-grounded topic phrase from a fact's opening clause so
 * that cards and auxiliary components show real content instead of generic
 * role labels. Prefers the shortest phrase ending in a strong topic noun.
 */
export function deriveGroundedTitle(text: string): string | undefined {
  const clause = (text.split(/[，,；;。！？!?]/u)[0] ?? text).trim();
  const candidates: Array<{ length: number; index: number; text: string }> = [];
  for (const suffix of TOPIC_SUFFIXES) {
    let searchFrom = 0;
    while (true) {
      const matchIndex = clause.indexOf(suffix, searchFrom);
      if (matchIndex < 0) break;
      searchFrom = matchIndex + suffix.length;
      let start = matchIndex;
      while (start > 0 && /[\p{Script=Han}0-9]/u.test(clause[start - 1])) start -= 1;
      let candidate = clause.slice(start, matchIndex + suffix.length)
        .replace(LEADING_FILLERS, "")
        .replace(/^[和与及、的之]+/u, "")
        .replace(/[的之等类]$/u, "")
        .trim();
      // When a quantified count (e.g. "1家" / "8个") interrupts the topic phrase,
      // cut everything up to it and keep the meaningful suffix (e.g. "入库服务单位").
      const quantified = candidate.match(/[\d零一二三四五六七八九十百千万两]+[家个名项次台套处](?:年度|每日|每周|每月)?/u);
      if (quantified && quantified.index !== undefined && Array.from(candidate).length - quantified.index >= 3) {
        candidate = candidate.slice(quantified.index + quantified[0].length).replace(/^[和与及、的之]+/u, "").trim();
      }
      const length = Array.from(candidate).length;
      if (length < 2) continue;
      candidates.push({ length, index: start, text: candidate });
    }
  }
  if (candidates.length === 0) return undefined;
  const ordered = candidates.slice().sort((left, right) =>
    left.length - right.length || left.index - right.index);
  const preferred = ordered.find((candidate) => candidate.length >= 4) ?? ordered[0];
  return preferred.text.slice(0, 12);
}

export function groundedTitleForGroup(facts: Array<Pick<SourceFact, "kind" | "text">>): string {
  const derived = facts.length > 0 ? deriveGroundedTitle(facts[0].text) : undefined;
  return derived ?? groundedTitleForRole(groundedRoleForFacts(facts));
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

const SUMMARY_FALLBACK = "本页内容按原文事实顺序组织呈现。";

/**
 * Derive a real, source-grounded summary statement for the page summary band
 * instead of a boilerplate fallback. Uses the opening clause of the first
 * display group, truncated at a comma boundary near 50 characters.
 */
export function derivePageConclusion(groups: ProjectableDisplayGroup[]): string {
  const body = groups[0]?.body ?? "";
  const sentence = (body.split(/[。！？]/u)[0] ?? body).trim();
  let trimmed = sentence.replace(/[，,；;、]$/u, "").trim();
  const length = Array.from(trimmed).length;
  if (length > 50) {
    const prefix = Array.from(trimmed).slice(0, 50).join("");
    const cut = prefix.lastIndexOf("，");
    trimmed = (cut >= 10 ? prefix.slice(0, cut) : prefix).trim();
  }
  return Array.from(trimmed).length >= 4 ? trimmed : SUMMARY_FALLBACK;
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
  // A supporting image is justified for any substantial group (process/comparison
  // with two facts, a metric-heavy group, or any dense page with four facts), so
  // text-heavy bid pages still get 配图 and image-capable templates stay usable.
  const explanatory = input.groups.find((group) =>
    (group.role === "process" || group.role === "comparison") && group.sourceFactIds.length >= 2)
    ?? input.groups.find((group) => group.role === "metric" && group.sourceFactIds.length >= 2)
    ?? (input.sourceFacts.length >= 4 ? input.groups[0] : undefined);
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
    conclusion: derivePageConclusion(input.groups),
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
