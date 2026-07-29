import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

import type { GeneratedAsset, SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { ParsedTemplate } from "../lib/template-parser.js";
import { fillPlaceholders } from "../tools/fill-placeholders.js";
import { mapSlideContent } from "./slide-content-mapper.js";

export interface ComposeSlideInput {
  spec: SlideSpec;
  template: ParsedTemplate;
  profile: TemplateProfile;
  assets: GeneratedAsset[];
  designTokens?: { fontScale?: number; spacingScale?: number; contrastMode?: "normal" | "high" };
}

export interface ComposeResult {
  html: string;
  warnings: string[];
}

async function inlineCss(doc: Document, templatePath: string): Promise<void> {
  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href || /^(?:https?:|data:|\/\/)/i.test(href)) throw new Error(`Remote or invalid stylesheet is not allowed: ${href ?? "missing"}`);
    const cssPath = resolve(dirname(templatePath), href);
    const style = doc.createElement("style");
    style.setAttribute("data-inline-source", href);
    const css = await readFile(cssPath, "utf8");
    style.textContent = css
      .replace(/(?:\.img-slot|\.icon-slot)[^{]*\{[^}]*\}/g, "")
      .replace(/\/\* Asset slots[^*]*\*\//g, "");
    link.replaceWith(style);
  }
}

async function inlineIcons(doc: Document, templatePath: string): Promise<void> {
  for (const icon of Array.from(doc.querySelectorAll("icon"))) {
    const name = icon.getAttribute("name")?.replace(/[^a-z0-9-]/gi, "") || "shield-check";
    const alt = icon.textContent?.trim() || name;
    let svg: string;
    try {
      svg = await readFile(resolve(dirname(templatePath), "assets", "icons", `${name}.svg`), "utf8");
    } catch {
      svg = await readFile(resolve(dirname(templatePath), "assets", "icons", "shield-check.svg"), "utf8");
    }
    const image = doc.createElement("img");
    image.setAttribute("src", `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    image.setAttribute("alt", alt);
    image.setAttribute("data-icon-name", name);
    icon.replaceWith(image);
  }
}

function injectAssets(doc: Document, spec: SlideSpec, assets: GeneratedAsset[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const declared of spec.assets) {
    if (!byId.has(declared.id)) throw new Error(`Missing generated asset: ${declared.id}`);
  }
  const figures = Array.from(doc.querySelectorAll("figures"));
  if (figures.length > 0 && assets.length === 0) throw new Error("Template requires imagery but SlideSpec contains no assets");
  figures.forEach((slot, index) => {
    const declared = spec.assets[index % spec.assets.length];
    const asset = byId.get(declared.id)!;
    const image = doc.createElement("img");
    image.setAttribute("src", asset.dataUrl);
    image.setAttribute("alt", declared.alt);
    image.setAttribute("data-asset-id", declared.id);
    image.setAttribute("decoding", "sync");
    slot.replaceWith(image);
    const parent = image.closest("figure");
    parent?.setAttribute("data-asset-ref", declared.id);
  });
}

function applyMarkersAndTokens(doc: Document, input: ComposeSlideInput): void {
  const pages = doc.querySelectorAll(".bid-page");
  if (pages.length !== 1) throw new Error(`Template must contain exactly one .bid-page; found ${pages.length}`);
  pages[0].setAttribute("data-slide-page", "1");
  input.spec.blocks.forEach((block, index) => {
    doc.querySelectorAll("[data-component]")[index]?.setAttribute("data-block-id", block.id);
  });
  const root = doc.documentElement;
  root.style.setProperty("--workflow-font-scale", String(input.designTokens?.fontScale ?? 1));
  root.style.setProperty("--workflow-spacing-scale", String(input.designTokens?.spacingScale ?? 1));
  if (input.designTokens?.contrastMode === "high") root.setAttribute("data-contrast", "high");
}

function scanResiduals(html: string): string[] {
  const warnings: string[] = [];
  if (/<(?:figures|icon|page-title|component-title|paragraph|summary-text|bullet)[\s>]/i.test(html)) warnings.push("页面仍包含未解析占位符");
  if (/<script[\s>]/i.test(html)) warnings.push("页面仍包含脚本");
  if (/\b(?:src|href)=["']https?:\/\//i.test(html)) warnings.push("页面仍包含远程资源");
  return warnings;
}

export async function composeSlide(input: ComposeSlideInput): Promise<ComposeResult> {
  const content = mapSlideContent(input.spec, input.template, input.profile);
  const filled = await fillPlaceholders({ html: input.template.html, content: { direct: content } });
  const dom = new JSDOM(filled.html);
  const doc = dom.window.document;
  doc.querySelectorAll("script, noscript").forEach((element) => element.remove());
  await inlineCss(doc, input.template.filePath);
  await inlineIcons(doc, input.template.filePath);
  injectAssets(doc, input.spec, input.assets);
  applyMarkersAndTokens(doc, input);
  const html = dom.serialize().replace(/<!--([\s\S]*?)-->/g, "");
  return { html, warnings: [...filled.warnings, ...scanResiduals(html)] };
}
