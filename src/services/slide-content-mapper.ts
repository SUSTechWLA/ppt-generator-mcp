import type { SlideBlock, SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { ParsedTemplate } from "../lib/template-parser.js";

export type FillContent = Record<string, string | string[]>;

function count(template: ParsedTemplate, tag: string): number {
  return template.placeholders.find((placeholder) => placeholder.tag === tag)?.count ?? 0;
}

function fit(text: string, limit: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  const sentences = normalized.match(/[^。！？；]+[。！？；]?/g) ?? [normalized];
  let result = "";
  for (const sentence of sentences) {
    if ((result + sentence).length > limit) break;
    result += sentence;
  }
  return result || `${normalized.slice(0, Math.max(1, limit - 1))}…`;
}

function repeatFromBlocks(blocks: SlideBlock[], length: number, map: (block: SlideBlock, index: number) => string): string[] {
  if (length === 0) return [];
  return Array.from({ length }, (_, index) => map(blocks[index % blocks.length], index));
}

export function mapSlideContent(
  spec: SlideSpec,
  template: ParsedTemplate,
  profile: TemplateProfile,
): FillContent {
  if (spec.blocks.length === 0) throw new Error("SlideSpec has no content blocks");
  const bodyLimit = Math.min(170, profile.maxCharsBySlot.body ?? 170);
  const short = (block: SlideBlock) => block.title.replace(/配置方案|管理体系|保障机制|响应要求/g, "").slice(0, 8) || block.title.slice(0, 8);
  const direct: FillContent = {
    "page-title": spec.title,
    "page-number": "1",
    "section-title": spec.eyebrow || "项目方案响应",
    "part-number": "PART.01",
    "part-label": "方案响应",
    "chapter-label": "项目服务方案",
    "topic-title": spec.title,
    "subsection-title": spec.conclusion,
    "component-title": repeatFromBlocks(spec.blocks, count(template, "component-title"), (block) => block.title),
    paragraph: repeatFromBlocks(spec.blocks, count(template, "paragraph"), (block) => fit([block.body, ...block.bullets].filter(Boolean).join("；"), bodyLimit)),
    "figure-ref": repeatFromBlocks(spec.blocks, count(template, "figure-ref"), (block) => block.title),
    "image-caption": Array.from({ length: count(template, "image-caption") }, (_, index) => spec.assets[index]?.alt ?? spec.assets[0]?.alt ?? "方案场景示意图"),
    "summary-text": fit(spec.conclusion, profile.maxCharsBySlot.summary ?? 110),
    bullet: repeatFromBlocks(spec.blocks, count(template, "bullet"), (block) => block.bullets[0] ?? block.title),
    "step-label": repeatFromBlocks(spec.blocks, count(template, "step-label"), short),
    "step-number": Array.from({ length: count(template, "step-number") }, (_, index) => String(index + 1).padStart(2, "0")),
    "stage-number": Array.from({ length: count(template, "stage-number") }, (_, index) => String(index + 1).padStart(2, "0")),
    "stage-label": repeatFromBlocks(spec.blocks, count(template, "stage-label"), short),
    "item-label": repeatFromBlocks(spec.blocks, count(template, "item-label"), short),
    "node-label": repeatFromBlocks(spec.blocks, count(template, "node-label"), short),
    "table-header": Array.from({ length: count(template, "table-header") }, (_, index) => ["响应维度", "核心要求", "落实机制", "交付证据"][index % 4]),
    "table-cell": repeatFromBlocks(spec.blocks, count(template, "table-cell"), (block, index) => {
      const metric = block.metrics[index % Math.max(1, block.metrics.length)];
      return fit(index % 4 === 0 ? block.title : metric ? `${metric.label}：${metric.value}` : block.bullets[index % Math.max(1, block.bullets.length)] ?? block.body, profile.maxCharsBySlot["table-cell"] ?? 28);
    }),
  };
  return Object.fromEntries(Object.entries(direct).filter(([, value]) => !Array.isArray(value) || value.length > 0));
}
