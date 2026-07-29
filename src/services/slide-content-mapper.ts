import type { PageMetadata } from "../domain/document-context.js";
import type { SemanticRole } from "../domain/page-blueprint.js";
import type { SlideBlock, SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { ParsedTemplate } from "../lib/template-parser.js";
import { solveTemplateSlots, type TemplateSlotSolution } from "./template-slot-solver.js";
import { projectOptionalImages } from "./optional-image-projection.js";

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
  return block.title.trim();
}

function metricText(block: SlideBlock): string {
  return block.metrics.map((metric) => `${metric.label}：${metric.value}`).join("；");
}

function valuesForItem(field: BindingField, block: SlideBlock, role: SemanticRole, index: number): string[] {
  if (field === "title" || field === "figureRef") return [block.title];
  if (field === "body" || field === "narrativeBody") return [[block.body, ...block.bullets].filter(Boolean).join("；")];
  if (field === "shortTitle") return [shortTitle(block)];
  if (["label", "stepLabel", "stageLabel", "itemLabel", "nodeLabel"].includes(field)) return [ROLE_LABELS[role]];
  if (["sequence", "stepNumber", "stageNumber"].includes(field)) return [String(index + 1).padStart(2, "0")];
  if (field === "bullet") return [block.bullets[0] ?? block.title];
  if (field === "metric") return [metricText(block) || block.title];
  if (field === "tableCell") {
    return [block.title, [block.body, ...block.bullets].filter(Boolean).join("；"), metricText(block) || "—", ROLE_LABELS[role]];
  }
  return [];
}

function valuesFor(field: BindingField, blocks: SlideBlock[], roles: SemanticRole[], valuesPerItem = 1): string[] {
  if (field === "tableHeader") return ["语义主题", "原文事实", "量化信息", "内容类型"];
  return blocks.flatMap((block, index) => {
    const values = valuesForItem(field, block, roles[index], index);
    return [...values.slice(0, valuesPerItem), ...Array.from({ length: Math.max(0, valuesPerItem - values.length) }, () => "")];
  });
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
  const images = projectOptionalImages(spec);
  if (images.assets.length > 0 && bindings.imageCaption && count(template, bindings.imageCaption) > 0) {
    values[bindings.imageCaption] = exactValues(template, bindings.imageCaption, images.captions);
  }
  if (images.assets.length > 0 && bindings.figureRef && count(template, bindings.figureRef) > 0) {
    values[bindings.figureRef] = exactValues(template, bindings.figureRef, images.figureRefs);
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
      append(mapped, tag, valuesFor(field, blocks, roles, slot.bindingExpansion?.[field] ?? 1));
    }
  }

  if (profile.auxiliaryBindings) {
    const assignments = [...solution.assignments];
    const blocks = assignments.map((assignment) => blockById.get(assignment.groupId)).filter((block): block is SlideBlock => Boolean(block));
    const roles = assignments.map((assignment) => assignment.role);
    for (const [field, tag] of Object.entries(profile.auxiliaryBindings) as Array<[BindingField, string]>) {
      const cardinality = profile.auxiliaryCapacities?.[field];
      if (!cardinality) throw new Error(`Auxiliary binding ${field} has no declared cardinality`);
      const maximum = cardinality.itemCapacity * cardinality.valuesPerItem;
      const available = count(template, tag);
      if (available > 0) {
        const groups = (profile.auxiliaryGroups ?? []).filter((group) => group.bindingFields.includes(field));
        const values = groups.length > 0
          ? groups.flatMap((group) => valuesFor(
              field,
              blocks.slice(0, group.itemCapacity),
              roles.slice(0, group.itemCapacity),
              cardinality.valuesPerItem,
            ))
          : valuesFor(field, blocks.slice(0, cardinality.itemCapacity), roles.slice(0, cardinality.itemCapacity), cardinality.valuesPerItem);
        append(mapped, tag, values.slice(0, maximum));
      }
    }
  }

  const direct = pageContent(spec, page, profile, template);
  for (const [tag, values] of mapped) {
    if (count(template, tag) > 0) direct[tag] = exactValues(template, tag, values);
  }
  for (const [tag, rawValues] of Object.entries(direct)) {
    const limit = profile.maxCharsBySlot[tag];
    if (!limit) throw new Error(`Bound placeholder ${tag} has no declared character capacity`);
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    for (const value of values) {
      if (Array.from(value).length > limit) throw new Error(`Bound placeholder ${tag} value exceeds character capacity ${limit}`);
    }
  }
  return direct;
}
