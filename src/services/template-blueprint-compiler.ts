import type { TemplateBlueprint } from "../domain/template-blueprint.js";
import type { SemanticRole } from "../domain/page-blueprint.js";
import { templateProfileSchema, type TemplateProfile } from "../domain/template-profile.js";

export interface CompiledTemplateBlueprint {
  html: string;
  profile: TemplateProfile;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const REGION_ROLES: Partial<Record<TemplateBlueprint["grid"]["regions"][number]["role"], SemanticRole>> = {
  title: "headline",
  body: "fact",
  metric: "metric",
  process: "process",
  evidence: "evidence",
  image: "visual",
  conclusion: "conclusion",
};

function buildProfile(blueprint: TemplateBlueprint, semanticCapacity: number): TemplateProfile {
  const pageIntents = [...new Set(blueprint.capabilityTags.filter((tag) => tag !== "formal"))];
  const supportedRoles = [...new Set(blueprint.grid.regions.map((region) => REGION_ROLES[region.role]).filter((role): role is SemanticRole => Boolean(role)))];
  const acceptedRoles = [...new Set(blueprint.grid.regions
    .filter((region) => ["body", "metric", "process", "evidence"].includes(region.role))
    .map((region) => REGION_ROLES[region.role] as SemanticRole))];
  const supportedBlocks = [...new Set(blueprint.grid.regions.flatMap((region) => {
    if (region.role === "image") return ["image" as const];
    if (region.role === "metric") return ["metric" as const];
    if (region.role === "process") return ["process" as const];
    if (region.role === "body" || region.role === "evidence") return ["text" as const];
    return [];
  }))];
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
    ...(blueprint.optionalImage.enabled ? { imageCaption: "image-caption" } : {}),
  } as const;
  return templateProfileSchema.parse({
    slug: blueprint.slugSeed,
    version: "1.0.0",
    themeId: `learned-${blueprint.slugSeed}`.slice(0, 64),
    pageIntents: pageIntents.length > 0 ? pageIntents : ["detail"],
    supportedRoles,
    semanticSlots: [{
      id: "main-content",
      priority: 10,
      required: true,
      itemCapacity: semanticCapacity,
      maxCharsPerItem: 150,
      acceptedRoles,
      bindings: { title: "component-title", body: "paragraph" },
      factBearingBinding: "body",
      factBearingValueIndex: 0,
      bindingExpansion: { title: 1, body: 1 },
    }],
    pageBindings,
    ...(blueprint.optionalImage.enabled ? { assetPromptBindings: { figureRef: "figure-ref" } } : {}),
    blockCapacity: semanticCapacity,
    supportedBlocks,
    imageSlots: {
      placeholderTag: "figures",
      placeholderCount: blueprint.optionalImage.enabled ? 1 : 0,
      minAssets: 0,
      maxAssets: blueprint.optionalImage.enabled ? 1 : 0,
      unusedPolicy: blueprint.optionalImage.enabled ? "remove-container" : "remove-placeholder",
      ...(blueprint.optionalImage.enabled ? { containerSelector: "figure" } : {}),
    },
    densityRange: ["low", "high"],
    maxCharsBySlot: {
      "page-title": 80,
      "page-number": 4,
      "section-title": 60,
      "part-number": 20,
      "part-label": 30,
      "chapter-label": 80,
      "topic-title": 60,
      "subsection-title": 60,
      "summary-text": 120,
      "component-title": 40,
      paragraph: 150,
      ...(blueprint.optionalImage.enabled ? { "image-caption": 60, "figure-ref": 40 } : {}),
    },
    maxRasterAreaRatio: blueprint.optionalImage.enabled ? blueprint.optionalImage.maxAreaRatio : 0,
    minimumBodyFontPt: blueprint.typography.bodyPt,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    designContract: {
      version: 1,
      tokens: {
        fontFamilies: [blueprint.typography.fontFamily],
        textColors: [blueprint.palette.text],
        backgroundColors: [blueprint.palette.background],
        fontScaleRange: [0.86, 1],
        spacingScaleRange: [0.86, 1],
        contrastModes: ["normal", "high"],
      },
      landmarkRanges: {
        "page-header": { xRatio: [0, 0.03], yRatio: [0, 0.03], widthRatio: [0.94, 1], heightRatio: [0.05, 0.12] },
        "chapter-band": { xRatio: [0, 0.03], yRatio: [0.05, 0.15], widthRatio: [0.94, 1], heightRatio: [0.04, 0.1] },
        "subsection-title": { xRatio: [0, 0.03], yRatio: [0.12, 0.24], widthRatio: [0.94, 1], heightRatio: [0.03, 0.1] },
        "summary-band": { xRatio: [0, 0.05], yRatio: [0.72, 0.93], widthRatio: [0.9, 1], heightRatio: [0.04, 0.15] },
        "page-footer": { xRatio: [0, 0.03], yRatio: [0.91, 0.99], widthRatio: [0.94, 1], heightRatio: [0.03, 0.07] },
      },
    },
    documentCompatibility: {
      bid: ["fact", "metric", "process", "evidence"].every((role) => supportedRoles.includes(role as SemanticRole))
        && blueprint.optionalImage.maxAreaRatio <= 0.18,
      proposal: ["fact", "metric"].every((role) => supportedRoles.includes(role as SemanticRole)),
      presentation: supportedRoles.includes("fact"),
    },
    format: "a4-landscape",
    status: "approved",
  });
}

export function compileTemplateBlueprint(blueprint: TemplateBlueprint): CompiledTemplateBlueprint {
  const semanticRegions = blueprint.grid.regions.filter((region) => ["body", "metric", "process", "evidence"].includes(region.role));
  const profile = buildProfile(blueprint, semanticRegions.length);
  const contentRegions = [...semanticRegions, ...blueprint.grid.regions.filter((region) => region.role === "image")];
  const contentRowBase = Math.min(...contentRegions.map((region) => region.row));
  const normalizedRow = (row: number) => row - contentRowBase + 1;
  const rowCount = Math.max(...contentRegions.map((region) => normalizedRow(region.row)));
  const cards = semanticRegions.map((region) => `
      <section class="component content-card" data-component="${escapeHtml(region.component)}" data-semantic-slot="main-content" style="grid-column:${region.columnStart} / span ${region.columnSpan};grid-row:${normalizedRow(region.row)}">
        <h4><component-title>Generic content heading</component-title></h4>
        <p><paragraph>Generic body content</paragraph></p>
      </section>`).join("");
  const imageRegion = blueprint.optionalImage.enabled
    ? blueprint.grid.regions.find((region) => region.id === blueprint.optionalImage.regionId)!
    : undefined;
  const image = imageRegion ? `
      <figure class="component image-card" data-component="image-card" style="grid-column:${imageRegion.columnStart} / span ${imageRegion.columnSpan};grid-row:${normalizedRow(imageRegion.row)}">
        <figures>Generate a supporting visual for <figure-ref>the adjacent evidence</figure-ref>; no text, logo or watermark.</figures>
        <figcaption><image-caption>Supporting visual</image-caption></figcaption>
      </figure>` : "";
  const css = `
    *{box-sizing:border-box}html,body{width:1123px;height:794px;margin:0;overflow:hidden}body{background:${blueprint.palette.background};color:${blueprint.palette.text};font-family:${blueprint.typography.fontFamily}}
    .bid-page{width:1123px;height:794px;padding:${blueprint.spacing.outerMm}mm;display:flex;flex-direction:column;gap:${blueprint.spacing.gapMm}mm;background:${blueprint.palette.background}}
    .page-header{height:50px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid ${blueprint.palette.primary}}.page-header h1{font-size:13pt;margin:0}.part-block{display:flex;gap:12px;font-size:9pt}
    .chapter-band{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:${blueprint.palette.primary};color:${blueprint.palette.background};border-radius:${blueprint.spacing.borderRadiusMm}mm}.chapter-band h2{font-size:${blueprint.typography.titlePt}pt;margin:0}.chapter-label{font-size:10pt}
    .subsection-title{height:34px;margin:0;font-size:13pt;color:${blueprint.palette.primary};display:flex;align-items:center}
    .content-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(${blueprint.grid.columns},1fr);grid-template-rows:repeat(${rowCount},minmax(0,1fr));gap:${blueprint.grid.gapMm}mm;align-content:stretch}
    .component{min-width:0;min-height:0}.content-card{padding:${blueprint.spacing.cardPaddingMm}mm;border:1px solid ${blueprint.palette.secondary};border-radius:${blueprint.spacing.borderRadiusMm}mm;background:${blueprint.palette.surface};overflow:hidden}.content-card h4{margin:0 0 9px;color:${blueprint.palette.primary};font-size:13pt}.content-card p{margin:0;font-size:${blueprint.typography.bodyPt}pt;line-height:${blueprint.typography.lineHeight}}
    .image-card{margin:0;padding:${blueprint.spacing.cardPaddingMm}mm;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:8px;border:1px solid ${blueprint.palette.secondary};border-radius:${blueprint.spacing.borderRadiusMm}mm;background:${blueprint.palette.surface};overflow:hidden}.image-card img{display:block;width:100%;height:100%;min-height:0;object-fit:contain}.image-card figcaption{font-size:${blueprint.typography.bodyPt}pt;line-height:1.3;color:${blueprint.palette.text}}
    .summary-band{height:54px;padding:10px 16px;display:flex;align-items:center;border-left:5px solid ${blueprint.palette.primary};background:${blueprint.palette.secondary};font-size:10pt;font-weight:600}
    .page-footer{height:26px;display:flex;align-items:end;justify-content:space-between;border-top:1px solid ${blueprint.palette.secondary};font-size:9pt}.page-footer .page-number{font-weight:700;color:${blueprint.palette.primary}}
  `;
  const html = `<!-- @name ${escapeHtml(blueprint.displayName)}\n@slug ${profile.slug}\n@format A4 landscape 297x210mm -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="template-name" content="${escapeHtml(blueprint.displayName)}"><meta name="template-slug" content="${profile.slug}"><meta name="template-format" content="A4 landscape 297x210mm"><title><page-title>Template page title</page-title></title><style>${css}</style></head><body>
  <article class="bid-page" data-slide-page="1" data-template-slug="${profile.slug}" data-template-version="${profile.version}" data-theme-id="${profile.themeId}" data-document-format="a4-landscape">
    <header class="page-header"><h1><section-title>Section title</section-title></h1><div class="part-block"><span><part-number>PART.01</part-number></span><span><part-label>Part label</part-label></span></div></header>
    <div class="chapter-band"><span class="chapter-label"><chapter-label>Chapter label</chapter-label></span><h2><topic-title>Topic title</topic-title></h2></div>
    <h3 class="subsection-title"><subsection-title>Subsection title</subsection-title></h3>
    <main class="content-grid">${cards}${image}</main>
    <section class="summary-band" data-component="summary-band"><summary-text>Summary statement</summary-text></section>
    <footer class="page-footer"><span>Reusable template knowledge</span><span class="page-number"><page-number>1</page-number></span></footer>
  </article></body></html>`;
  return { html, profile };
}
