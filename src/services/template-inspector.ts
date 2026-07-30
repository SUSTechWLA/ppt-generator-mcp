import { JSDOM } from "jsdom";

import { hashCanonical } from "../domain/source-document.js";
import { colorContrastRatio, templateBlueprintSchema, type TemplateBlueprint } from "../domain/template-blueprint.js";
import { executableDomViolations } from "../lib/html-security.js";

export const MAX_REFERENCE_HTML_CHARS = 120_000;

export interface TemplateInspectionFinding {
  code: "executable-dom" | "unsafe-css-resource" | "resource-attribute" | "branding-discarded" | "tokens-normalized";
  severity: "error" | "notice";
}

export interface TemplateInspection {
  version: 1;
  sourceHash: string;
  safe: boolean;
  blueprint: TemplateBlueprint;
  componentHierarchy: Array<{ component: string; role: string; children: string[] }>;
  findings: TemplateInspectionFinding[];
  sanitization: { proseDiscarded: true; brandingDiscarded: true; resourceContentDiscarded: true };
}

const UNSAFE_CSS = /\\|@import\b|@font-face\b|\burl\s*\(|\b(?:-webkit-)?image-set\s*\(|\b(?:https?|file|data|javascript|ftp|blob|wss?|resource)\s*:|\/\//i;
const RESOURCE_ATTRIBUTES = "[src],[srcset],[href],[xlink\\:href],[poster],[data],[action],[formaction],[background],[manifest],[archive],[codebase]";

function colorCandidates(css: string): string[] {
  return [...new Set((css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((value) => value.toLowerCase()))];
}

function countColumns(css: string): number {
  const repeat = css.match(/grid-template-columns\s*:\s*repeat\(\s*(\d+)/i);
  const value = repeat ? Number(repeat[1]) : 12;
  return Number.isInteger(value) && value >= 4 && value <= 12 ? value : 12;
}

export function inspectTemplateHtml(referenceHtml: string): TemplateInspection {
  if (typeof referenceHtml !== "string" || referenceHtml.trim().length < 20 || referenceHtml.length > MAX_REFERENCE_HTML_CHARS) {
    throw new Error(`referenceHtml must contain 20-${MAX_REFERENCE_HTML_CHARS} characters`);
  }
  const dom = new JSDOM(referenceHtml);
  const doc = dom.window.document;
  const styles = Array.from(doc.querySelectorAll("style")).map((style) => style.textContent ?? "").join("\n");
  const findings: TemplateInspectionFinding[] = [];
  if (executableDomViolations(doc).length > 0) findings.push({ code: "executable-dom", severity: "error" });
  if (UNSAFE_CSS.test(styles) || Array.from(doc.querySelectorAll<HTMLElement>("[style]")).some((element) => UNSAFE_CSS.test(element.getAttribute("style") ?? ""))) {
    findings.push({ code: "unsafe-css-resource", severity: "error" });
  }
  const resourceElements = Array.from(doc.querySelectorAll<HTMLElement>(RESOURCE_ATTRIBUTES));
  if (resourceElements.length > 0) {
    const onlyDiscardableInlineRasters = resourceElements.every((element) => {
      const resourceAttributes = ["src", "srcset", "href", "xlink:href", "poster", "data", "action", "formaction", "background", "manifest", "archive", "codebase"]
        .filter((name) => element.hasAttribute(name));
      return element.tagName === "IMG" && resourceAttributes.length === 1 && resourceAttributes[0] === "src"
        && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(element.getAttribute("src") ?? "");
    });
    findings.push({ code: "resource-attribute", severity: onlyDiscardableInlineRasters ? "notice" : "error" });
  }
  if (doc.querySelector("img,svg,[class*=logo i],[id*=logo i]") || /(?:logo|watermark|brand)/i.test(referenceHtml)) {
    findings.push({ code: "branding-discarded", severity: "notice" });
  }

  const sourceHash = hashCanonical({ sourceType: "html", source: referenceHtml.trim() });
  const colors = colorCandidates(styles);
  const background = colors.includes("#ffffff") ? "#ffffff" : "#ffffff";
  const text = colors.find((color) => ["#000000", "#111111", "#16251d", "#17241e"].includes(color)) ?? "#17241e";
  const primary = colors.find((color) => color !== background && color !== text && colorContrastRatio(color, background) >= 4.5) ?? "#176b45";
  const gridColumns = countColumns(styles);
  const sections = Math.max(1, Math.min(4, doc.querySelectorAll("main > section, main > article, .card, [class*=card i]").length || 2));
  const bodySpan = Math.max(1, Math.floor(gridColumns / Math.min(2, sections)));
  const regions: TemplateBlueprint["grid"]["regions"] = [
    { id: "title", role: "title", component: "title-band", columnStart: 1, columnSpan: gridColumns, row: 1 },
    ...Array.from({ length: sections }, (_, index) => ({
      id: `body-${index + 1}`,
      role: index === sections - 1 && sections > 1 ? "evidence" as const : "body" as const,
      component: index === sections - 1 && sections > 1 ? "evidence-card" as const : "fact-card" as const,
      columnStart: (index % 2) * bodySpan + 1,
      columnSpan: bodySpan,
      row: 2 + Math.floor(index / 2),
    })),
    { id: "conclusion", role: "conclusion", component: "conclusion-band", columnStart: 1, columnSpan: gridColumns, row: 4 },
    { id: "page", role: "page-number", component: "page-number", columnStart: Math.max(1, gridColumns - 1), columnSpan: Math.min(2, gridColumns), row: 5 },
  ];
  const blueprint = templateBlueprintSchema.parse({
    version: 1,
    displayName: "Learned reference layout",
    slugSeed: `learned-reference-${sourceHash.slice(0, 12)}`,
    canvas: { format: "a4-landscape", widthMm: 297, heightMm: 210 },
    grid: { columns: gridColumns, gapMm: 4, regions },
    typography: { fontFamily: "Arial, sans-serif", bodyPt: 10, titlePt: 24, lineHeight: 1.4 },
    palette: { background, surface: "#f4f7f6", text, primary, secondary: "#d9eadf" },
    spacing: { outerMm: 12, gapMm: 4, cardPaddingMm: 5, borderRadiusMm: 2 },
    visualRatios: { text: 0.62, image: 0, whitespace: 0.24 },
    optionalImage: { enabled: false, maxAreaRatio: 0, screenshotAsBackground: false },
    capabilityTags: ["detail", ...(regions.some((region) => region.role === "evidence") ? ["evidence" as const] : []), "formal"],
  });
  findings.push({ code: "tokens-normalized", severity: "notice" });
  return {
    version: 1,
    sourceHash,
    safe: !findings.some((finding) => finding.severity === "error"),
    blueprint,
    componentHierarchy: [
      { component: "page", role: "canvas", children: ["title-band", "content-grid", "conclusion-band", "page-number"] },
      { component: "content-grid", role: "body", children: regions.filter((region) => ["body", "evidence"].includes(region.role)).map((region) => region.component) },
    ],
    findings,
    sanitization: { proseDiscarded: true, brandingDiscarded: true, resourceContentDiscarded: true },
  };
}
