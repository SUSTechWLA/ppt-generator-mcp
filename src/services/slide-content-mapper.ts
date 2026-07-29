import type { PageMetadata } from "../domain/document-context.js";
import type { SemanticRole } from "../domain/page-blueprint.js";
import type { SlideBlock, SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { ParsedTemplate } from "../lib/template-parser.js";
import { solveTemplateSlots, type TemplateSlotSolution } from "./template-slot-solver.js";

export type FillContent = Record<string, string | string[]>;

type BindingField = keyof TemplateProfile["semanticSlots"][number]["bindings"];

const DEFAULT_PAGE_BINDINGS: TemplateProfile["pageBindings"] = {
  pageTitle: "page-title",
  pageNumber: "page-number",
  sectionTitle: "section-title",
  partNumber: "part-number",
  partLabel: "part-label",
  chapterLabel: "chapter-label",
  topicTitle: "topic-title",
  subsectionTitle: "subsection-title",
  summaryText: "summary-text",
  imageCaption: "image-caption",
  figureRef: "figure-ref",
};

const ROLE_LABELS: Record<SemanticRole, string> = {
  headline: "页面主题",
  conclusion: "核心结论",
  fact: "事实要点",
  metric: "量化指标",
  process: "实施流程",
  comparison: "对比分析",
  evidence: "事实依据",
  visual: "视觉说明",
};

function count(template: ParsedTemplate, tag: string): number {
  return template.placeholders.find((placeholder) => placeholder.tag === tag)?.count ?? 0;
}

function shortTitle(block: SlideBlock): string {
  return Array.from(block.title.trim()).slice(0, 8).join("");
}

function metricText(block: SlideBlock): string {
  return block.metrics.map((metric) => `${metric.label}：${metric.value}`).join("；");
}

function valuesFor(field: BindingField, blocks: SlideBlock[], roles: SemanticRole[]): string[] {
  if (field === "title" || field === "figureRef") return blocks.map((block) => block.title);
  if (field === "body" || field === "narrativeBody") return blocks.map((block) => [block.body, ...block.bullets].filter(Boolean).join("；"));
  if (["shortTitle", "label", "stepLabel", "stageLabel", "itemLabel", "nodeLabel"].includes(field)) return blocks.map(shortTitle);
  if (["sequence", "stepNumber", "stageNumber"].includes(field)) return blocks.map((_, index) => String(index + 1).padStart(2, "0"));
  if (field === "bullet") return blocks.map((block) => block.bullets[0] ?? block.title);
  if (field === "metric") return blocks.map((block) => metricText(block) || block.title);
  if (field === "tableHeader") return ["语义主题", "原文事实", "量化信息", "内容类型"];
  if (field === "tableCell") {
    return blocks.flatMap((block, index) => [
      block.title,
      [block.body, ...block.bullets].filter(Boolean).join("；"),
      metricText(block) || "—",
      ROLE_LABELS[roles[index]],
    ]);
  }
  return [];
}

function append(output: Map<string, string[]>, tag: string | undefined, values: string[]): void {
  if (!tag) return;
  output.set(tag, [...(output.get(tag) ?? []), ...values]);
}

function exactValues(template: ParsedTemplate, tag: string, values: string[]): string[] {
  const available = count(template, tag);
  if (available === 0) return [];
  if (values.length > available) {
    throw new Error(`Declared binding ${tag} has ${available} placeholders but received ${values.length} values`);
  }
  return [...values, ...Array.from({ length: available - values.length }, () => "")];
}

function pageContent(spec: SlideSpec, page: PageMetadata | undefined, profile: TemplateProfile, template: ParsedTemplate): FillContent {
  const bindings = profile.pageBindings ?? DEFAULT_PAGE_BINDINGS;
  const values: FillContent = {
    [bindings.pageTitle]: spec.title,
    [bindings.pageNumber]: String(page?.number ?? 1),
    [bindings.sectionTitle]: page?.sectionTitle ?? spec.eyebrow ?? "项目方案响应",
    [bindings.partNumber]: page?.partNumber ?? "PART.01",
    [bindings.partLabel]: page?.partLabel ?? "方案响应",
    [bindings.chapterLabel]: page?.chapterLabel ?? spec.eyebrow ?? "项目服务方案",
    [bindings.topicTitle]: spec.title,
    [bindings.subsectionTitle]: page?.subsectionTitle ?? spec.conclusion,
    [bindings.summaryText]: spec.conclusion,
  };
  if (bindings.imageCaption && count(template, bindings.imageCaption) > 0) {
    const captions = spec.assets.map((asset) => asset.alt);
    values[bindings.imageCaption] = exactValues(template, bindings.imageCaption, captions.length > 0 ? captions : ["方案场景示意图"]);
  }
  if (bindings.figureRef && count(template, bindings.figureRef) > 0) {
    const blockById = new Map(spec.blocks.map((block) => [block.id, block]));
    const references = spec.assets.map((asset) => blockById.get(asset.blockId)?.title ?? asset.alt);
    values[bindings.figureRef] = exactValues(template, bindings.figureRef, references.length > 0 ? references : [spec.title]);
  }
  return values;
}

export function mapSlideContent(
  spec: SlideSpec,
  template: ParsedTemplate,
  profile: TemplateProfile,
  page?: PageMetadata,
  providedSolution?: TemplateSlotSolution,
): FillContent {
  if (spec.blocks.length === 0) throw new Error("SlideSpec has no content blocks");
  const solution = providedSolution ?? solveTemplateSlots(spec, profile);
  if (!solution.feasible) {
    const diagnostics = solution.unmatched.map((item) => `${item.groupId || "required-slot"}: ${item.reason}`).join("；");
    throw new Error(`Template slot assignment failed: ${diagnostics}; unrepresented facts: ${solution.unrepresentedFactIds.join(", ")}`);
  }
  const blockById = new Map(spec.blocks.map((block) => [block.id, block]));
  const mapped = new Map<string, string[]>();
  const orderedSlots = profile.semanticSlots
    .map((slot, catalogIndex) => ({ slot, catalogIndex }))
    .sort((left, right) => left.slot.priority - right.slot.priority || left.catalogIndex - right.catalogIndex);

  for (const { slot } of orderedSlots) {
    const assignments = solution.assignments
      .filter((assignment) => assignment.slotId === slot.id)
      .sort((left, right) => left.itemIndex - right.itemIndex);
    const blocks = assignments.map((assignment) => blockById.get(assignment.groupId)).filter((block): block is SlideBlock => Boolean(block));
    const roles = assignments.map((assignment) => assignment.role);
    for (const [field, tag] of Object.entries(slot.bindings) as Array<[BindingField, string]>) {
      append(mapped, tag, valuesFor(field, blocks, roles));
    }
  }

  if (profile.auxiliaryBindings) {
    const assignments = [...solution.assignments];
    const blocks = assignments.map((assignment) => blockById.get(assignment.groupId)).filter((block): block is SlideBlock => Boolean(block));
    const roles = assignments.map((assignment) => assignment.role);
    for (const [field, tag] of Object.entries(profile.auxiliaryBindings) as Array<[BindingField, string]>) {
      const available = count(template, tag);
      if (available > 0) append(mapped, tag, valuesFor(field, blocks, roles).slice(0, available));
    }
  }

  const direct = pageContent(spec, page, profile, template);
  for (const [tag, values] of mapped) {
    if (count(template, tag) > 0) direct[tag] = exactValues(template, tag, values);
  }
  return direct;
}
