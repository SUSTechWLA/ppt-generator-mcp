import type { SourceDocument, SourceFact } from "../domain/source-document.js";
import { slideSpecSchema, type SlideBlock, type SlideSpec } from "../domain/slide-spec.js";

export interface SlidePlanningPolicy {
  maxRasterAreaRatio: number;
  maxImageAssets: number;
}

function titleFor(index: number, heading?: string): string {
  const fallback = ["核心要求", "落实机制", "交付校验", "持续保障"][index] ?? `方案要点${index + 1}`;
  return (heading || fallback).trim().slice(0, 30).padEnd(2, "要");
}

function factFor(source: SourceDocument, index: number): SourceFact {
  return source.facts[index % source.facts.length];
}

export function constrainSlideSpecToPlanningPolicy(spec: SlideSpec, policy: SlidePlanningPolicy): SlideSpec {
  return slideSpecSchema.parse({
    ...spec,
    assets: spec.assets.slice(0, policy.maxImageAssets),
    designIntent: {
      ...spec.designIntent,
      visualRatio: Math.min(spec.designIntent.visualRatio, policy.maxRasterAreaRatio),
    },
  });
}

export function buildDeterministicSlideSpec(
  source: SourceDocument,
  policy: SlidePlanningPolicy = { maxRasterAreaRatio: 0.3, maxImageAssets: 1 },
): SlideSpec {
  if (source.facts.length === 0) throw new Error("Source document contains no facts for slide planning");
  const blockCount = Math.min(4, Math.max(3, source.sections.length));
  const blocks: SlideBlock[] = Array.from({ length: blockCount }, (_, index) => {
    const section = source.sections[index % source.sections.length];
    const fact = factFor(source, index);
    const numeric = fact.text.match(/\d[\d,.]*(?:%|万元|元|天|小时|分钟|个|名|项|次)?/)?.[0];
    return {
      id: `block-${index + 1}`,
      type: index === 1 ? "process" : numeric && index === 2 ? "metric" : "text",
      title: titleFor(index, section?.heading),
      body: fact.text.slice(0, 500),
      bullets: (section?.keyPoints ?? []).slice(0, 4).map((point) => point.slice(0, 80)),
      metrics: numeric ? [{ label: "正文指标", value: numeric }] : [],
      sourceFactIds: [fact.id],
    };
  });
  const factIds = [...new Set(blocks.flatMap((block) => block.sourceFactIds))];
  const title = (source.title || source.sections[0].heading || "项目服务方案").slice(0, 40);
  const conclusion = `围绕${blocks.slice(0, 3).map((block) => block.title).join("、")}形成可执行、可检查的项目响应。`.slice(0, 160);
  return constrainSlideSpecToPlanningPolicy(slideSpecSchema.parse({
    title: title.length >= 4 ? title : `${title}方案`,
    eyebrow: "项目方案响应",
    conclusion,
    blocks,
    assets: [{
      id: "img-001",
      type: "image",
      blockId: blocks[0].id,
      prompt: `中国项目服务团队围绕“${title}”开展现场协调与工作计划复核的真实商务场景，专业可信，自然光，深绿色与纸白色调，横向构图，无文字、无标识、无水印`,
      alt: `${title}项目协同场景示意图`,
      sourceFactIds: [blocks[0].sourceFactIds[0]],
      width: 1792,
      height: 1024,
    }],
    sourceFactIds: factIds,
    designIntent: { tone: "professional", density: blockCount >= 4 ? "high" : "medium", visualRatio: 0.3 },
  }), policy);
}
