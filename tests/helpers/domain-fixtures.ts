import type { SourceDocument } from "../../src/domain/source-document.js";
import type { AssetSpec, GeneratedAsset, SlideBlockType, SlideSpec } from "../../src/domain/slide-spec.js";
import type { TemplateProfile } from "../../src/domain/template-profile.js";

export const validInput = {
  sourceText: "# 服务方案\n\n## 响应要求\n项目必须在30分钟内响应。",
  quality: { minScore: 85, maxAttempts: 3 },
};
export const canonicalInput = validInput;

export function makeSourceDocument(): SourceDocument {
  return {
    language: "zh-CN",
    title: "服务方案",
    sections: [{ id: "section-1", heading: "响应要求", body: "项目必须在30分钟内响应。", keyPoints: ["快速响应"], order: 0 }],
    facts: [{ id: "fact-1", text: "项目必须在30分钟内响应。", kind: "requirement", sourceSectionId: "section-1" }],
    sourceHash: "0".repeat(64),
  };
}

export function makeSlideSpec(options: {
  blockTypes?: SlideBlockType[];
  assetCount?: number;
  factIds?: string[];
} = {}): SlideSpec {
  const types = [...(options.blockTypes ?? ["text", "process", "metric"] as SlideBlockType[])];
  while (types.length < 3) types.push("text");
  const factIds = options.factIds ?? ["fact-1"];
  const blocks = types.slice(0, 6).map((type, index) => ({
    id: `block-${index + 1}`,
    type,
    title: `方案要点${index + 1}`,
    body: "围绕项目目标建立标准化执行和检查机制。",
    bullets: [],
    metrics: type === "metric" ? [{ label: "响应时限", value: "30分钟" }] : [],
    sourceFactIds: factIds,
  }));
  const assets = Array.from({ length: options.assetCount ?? 1 }, (_, index) => ({
    id: `img-${String(index + 1).padStart(3, "0")}`,
    type: "image" as const,
    blockId: blocks[index % blocks.length].id,
    prompt: "professional Chinese business service scene, deep green and paper white, no text",
    alt: "项目服务场景",
    sourceFactIds: factIds,
    width: 1792 as const,
    height: 1024 as const,
  }));
  return {
    title: "标准化项目服务方案",
    eyebrow: "服务响应",
    conclusion: "以标准机制保障项目目标落实",
    blocks,
    assets,
    sourceFactIds: factIds,
    designIntent: { tone: "professional", density: "medium", visualRatio: assets.length / blocks.length },
  };
}

export function makeTemplateProfiles(): TemplateProfile[] {
  const pageBindings = {
    pageTitle: "page-title",
    pageNumber: "page-number",
    sectionTitle: "section-title",
    partNumber: "part-number",
    partLabel: "part-label",
    chapterLabel: "chapter-label",
    topicTitle: "topic-title",
    subsectionTitle: "subsection-title",
    summaryText: "summary-text",
  } as const;
  return [
    {
      slug: "green-infographic-bid-a4-landscape-text-image",
      version: "2.0.0",
      themeId: "fixture-theme",
      pageIntents: ["detail", "process", "visual-support"],
      supportedRoles: ["headline", "conclusion", "fact", "metric", "process", "evidence", "visual"],
      semanticSlots: [{ id: "main", priority: 1, required: true, itemCapacity: 4, maxCharsPerItem: 160, acceptedRoles: ["headline", "conclusion", "fact", "metric", "process", "evidence", "visual"], bindings: { title: "component-title", body: "paragraph" }, factBearingBinding: "body", factBearingValueIndex: 0, bindingExpansion: { title: 1, body: 1 } }],
      pageBindings,
      blockCapacity: 4,
      supportedBlocks: ["text", "image", "process", "metric"],
      imageSlots: { placeholderTag: "figures", placeholderCount: 4, minAssets: 0, maxAssets: 4, unusedPolicy: "remove-container", containerSelector: "figure" },
      densityRange: ["low", "high"],
      maxCharsBySlot: { "component-title": 30, paragraph: 160, "page-title": 40, "page-number": 4, "section-title": 60, "part-number": 20, "part-label": 30, "chapter-label": 80, "topic-title": 40, "subsection-title": 160, "summary-text": 160 },
      maxRasterAreaRatio: 0.45,
      requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
      documentCompatibility: { bid: true, proposal: true, presentation: true },
      format: "a4-landscape",
      status: "approved",
    },
    {
      slug: "green-infographic-bid-a4-landscape-table-text",
      version: "2.0.0",
      themeId: "fixture-theme",
      pageIntents: ["detail", "comparison", "evidence"],
      supportedRoles: ["headline", "conclusion", "fact", "metric", "comparison", "evidence"],
      semanticSlots: [{ id: "main", priority: 1, required: true, itemCapacity: 2, maxCharsPerItem: 200, acceptedRoles: ["headline", "conclusion", "fact", "metric", "comparison", "evidence"], bindings: { title: "component-title", body: "paragraph" }, factBearingBinding: "body", factBearingValueIndex: 0, bindingExpansion: { title: 1, body: 1 } }],
      pageBindings,
      blockCapacity: 2,
      supportedBlocks: ["text", "table", "metric"],
      imageSlots: { placeholderTag: "figures", placeholderCount: 0, minAssets: 0, maxAssets: 0, unusedPolicy: "remove-placeholder" },
      densityRange: ["medium", "high"],
      maxCharsBySlot: { "component-title": 30, paragraph: 200, "page-title": 40, "page-number": 4, "section-title": 60, "part-number": 20, "part-label": 30, "chapter-label": 80, "topic-title": 40, "subsection-title": 160, "summary-text": 160 },
      maxRasterAreaRatio: 0,
      requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
      documentCompatibility: { bid: true, proposal: true, presentation: true },
      format: "a4-landscape",
      status: "approved",
    },
  ];
}

export const imageSpec = makeSlideSpec({ assetCount: 1 }).assets[0];
export const makeGeneratedAssets = (specs: AssetSpec[]): GeneratedAsset[] => specs.map((spec) => ({
  id: spec.id,
  promptHash: `hash-${spec.id}`,
  mimeType: "image/png",
  filePath: `/tmp/${spec.id}.png`,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  reused: false,
}));
