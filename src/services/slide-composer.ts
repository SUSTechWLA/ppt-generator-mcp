import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";

import type { GeneratedAsset, SlideSpec } from "../domain/slide-spec.js";
import type { PageMetadata } from "../domain/document-context.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { ParsedTemplate } from "../lib/template-parser.js";
import { solveTemplateSlots, type TemplateSlotSolution } from "./template-slot-solver.js";
import { fillPlaceholders } from "../tools/fill-placeholders.js";
import { mapSlideContent } from "./slide-content-mapper.js";

export interface ComposeSlideInput {
  spec: SlideSpec;
  template: ParsedTemplate;
  profile: TemplateProfile;
  assets: GeneratedAsset[];
  page?: PageMetadata;
  slotSolution?: TemplateSlotSolution;
  designTokens?: { fontScale?: number; spacingScale?: number; contrastMode?: "normal" | "high" };
}

export interface ComposeResult {
  html: string;
  warnings: string[];
}

async function inlineCss(doc: Document, templatePath: string): Promise<void> {
  const familyRoot = await realpath(dirname(templatePath));
  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href
      || isAbsolute(href)
      || href.includes("\\")
      || href.includes("?")
      || href.includes("#")
      || href.split("/").includes("..")
      || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
      || !href.toLowerCase().endsWith(".css")) {
      throw new Error("Stylesheet path must be a relative CSS file inside the template family");
    }
    const requestedPath = resolve(familyRoot, href);
    const requestedDelta = relative(familyRoot, requestedPath);
    if (requestedDelta === ".." || requestedDelta.startsWith(`..${sep}`) || isAbsolute(requestedDelta)) {
      throw new Error("Stylesheet path resolves outside the template family");
    }
    const cssPath = await realpath(requestedPath);
    const actualDelta = relative(familyRoot, cssPath);
    if (actualDelta === ".." || actualDelta.startsWith(`..${sep}`) || isAbsolute(actualDelta)) {
      throw new Error("Stylesheet symlink resolves outside the template family");
    }
    const css = await readFile(cssPath, "utf8");
    if (/\\|@import\b|\burl\s*\(|\b(?:-webkit-)?image-set\s*\(|(?:https?|file|data):|\/\//i.test(css)) {
      throw new Error("Unsafe stylesheet resource directive is not allowed");
    }
    const style = doc.createElement("style");
    style.setAttribute("data-inline-source", href);
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

function injectAssets(doc: Document, spec: SlideSpec, profile: TemplateProfile, assets: GeneratedAsset[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const declared of spec.assets) {
    if (!byId.has(declared.id)) throw new Error(`Missing generated asset: ${declared.id}`);
  }
  const declaredImages = spec.assets.filter((asset) => asset.type === "image");
  if (new Set(declaredImages.map((asset) => asset.id)).size !== declaredImages.length) throw new Error("SlideSpec image asset IDs must be unique");
  const imageSlots = profile.imageSlots;
  const figures = Array.from(doc.querySelectorAll(imageSlots.placeholderTag));
  if (figures.length !== imageSlots.placeholderCount) {
    throw new Error(`Template contains ${figures.length} image placeholders but profile declares ${imageSlots.placeholderCount}`);
  }
  if (declaredImages.length < imageSlots.minAssets || declaredImages.length > imageSlots.maxAssets) {
    const expectation = imageSlots.minAssets === imageSlots.maxAssets
      ? `exactly ${imageSlots.minAssets}`
      : `between ${imageSlots.minAssets} and ${imageSlots.maxAssets}`;
    throw new Error(`Template requires ${expectation} image assets; received ${declaredImages.length}`);
  }
  figures.forEach((slot, index) => {
    const declared = declaredImages[index];
    if (!declared) {
      if (imageSlots.unusedPolicy === "remove-container") {
        const container = imageSlots.containerSelector ? slot.closest(imageSlots.containerSelector) : null;
        if (!container) throw new Error(`Unused image slot has no container matching ${imageSlots.containerSelector}`);
        container.remove();
      } else {
        slot.remove();
      }
      return;
    }
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
  pages[0].setAttribute("data-slide-page", String(input.page?.number ?? 1));
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

function prepareTemplateHtml(template: ParsedTemplate, profile: TemplateProfile, solution: TemplateSlotSolution): string {
  const dom = new JSDOM(template.html);
  const doc = dom.window.document;
  for (const slot of profile.semanticSlots) {
    const elements = Array.from(doc.querySelectorAll(`[data-semantic-slot="${slot.id}"]`));
    if (elements.length !== slot.itemCapacity) {
      throw new Error(`Semantic slot ${slot.id} has ${elements.length} item markers; expected ${slot.itemCapacity}`);
    }
    const assignments = new Map(
      solution.assignments
        .filter((assignment) => assignment.slotId === slot.id)
        .map((assignment) => [assignment.itemIndex, assignment]),
    );
    elements.forEach((element, index) => {
      const assignment = assignments.get(index);
      if (!assignment) element.remove();
      else element.setAttribute("data-block-id", assignment.groupId);
    });
  }
  const assignedCount = solution.assignments.length;
  doc.querySelector(".bid-page")?.setAttribute("data-semantic-item-count", String(assignedCount));
  for (const group of profile.auxiliaryGroups ?? []) {
    const capacity = group.itemCapacity;
    const usedItems = Math.min(assignedCount, capacity);
    Array.from(doc.querySelectorAll(group.itemSelector)).forEach((element, index) => {
      if (index >= usedItems) element.remove();
    });
    if (group.connectorSelector) {
      const usedConnectors = Math.max(0, usedItems - 1);
      Array.from(doc.querySelectorAll(group.connectorSelector)).forEach((element, index) => {
        if (index >= usedConnectors) element.remove();
      });
    }
  }
  for (const element of Array.from(doc.querySelectorAll("[data-min-semantic-items]"))) {
    const minimum = Number.parseInt(element.getAttribute("data-min-semantic-items") ?? "", 10);
    if (Number.isFinite(minimum) && assignedCount < minimum) element.remove();
  }
  return dom.serialize();
}

export async function composeSlide(input: ComposeSlideInput): Promise<ComposeResult> {
  const solution = input.slotSolution ?? solveTemplateSlots(input.spec, input.profile);
  const content = mapSlideContent(input.spec, input.template, input.profile, input.page, solution);
  const filled = await fillPlaceholders({ html: prepareTemplateHtml(input.template, input.profile, solution), content: { direct: content } });
  const dom = new JSDOM(filled.html);
  const doc = dom.window.document;
  doc.querySelectorAll("script, noscript").forEach((element) => element.remove());
  await inlineCss(doc, input.template.filePath);
  await inlineIcons(doc, input.template.filePath);
  injectAssets(doc, input.spec, input.profile, input.assets);
  applyMarkersAndTokens(doc, input);
  const html = dom.serialize().replace(/<!--([\s\S]*?)-->/g, "");
  return { html, warnings: [...filled.warnings, ...scanResiduals(html)] };
}
