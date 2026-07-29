import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { hasExecutableDom } from "../lib/html-security.js";
import type { SemanticLandmark } from "../domain/template-profile.js";
import { SEMANTIC_LANDMARKS } from "./template-landmarks.js";

export interface RenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderElement {
  id: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  overflowX: string;
  overflowY: string;
  fontSize: number;
  fontWeight: number;
  contrastRatio: number;
  contrastMeasurable: boolean;
  largeText: boolean;
  bodyText: boolean;
}

export interface RenderStructure {
  pageNumber?: string;
  profile?: { slug: string; version: string; themeId: string; format: string };
  designTokens: {
    fontFamily: string;
    textColor: string;
    backgroundColor: string;
    fontScale: string;
    spacingScale: string;
    contrastMode: "normal" | "high";
  };
  landmarkCounts: Record<SemanticLandmark, number>;
  landmarkRects: Record<SemanticLandmark, RenderRect[]>;
  pageFields: Record<string, string[]>;
  semanticItems: Array<{
    blockId: string;
    slotId: string;
    sourceFactIds: string[];
    visibleText: string;
    factText: string;
    factTextOwnerCount: number;
    visibleFactTextOwnerCount: number;
    titleText: string;
    titleTextOwnerCount: number;
    visibleTitleTextOwnerCount: number;
    bindingTexts: Array<{ field: string; valueIndex: number; text: string; visible: boolean }>;
  }>;
  blankComponents: string[];
  protectedGeneratedText: Array<{ zone: "semantic" | "page-field"; owner: string; text: string }>;
}

export interface RenderResult {
  screenshotPath: string;
  screenshotDataUrl: string;
  viewport: { width: 1123; height: 794 };
  pageCount: number;
  elements: RenderElement[];
  images: Array<{
    src: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    opaqueRatio: number;
    luminanceVariance: number;
    isVector: boolean;
    displayedArea: number;
    clippedArea: number;
    cssVisible: boolean;
  }>;
  rasterAreaRatio: number;
  raster: { visibleCount: number; unionArea: number; unionAreaRatio: number };
  bodyScroll: { width: number; height: number };
  occupiedRatio: number;
  structure: RenderStructure;
  layout: {
    containmentViolations: Array<{ targetId: string; ancestorId: string; overflowPx?: number }>;
    collisions: Array<{ firstId: string; secondId: string; overlapArea: number }>;
  };
  signals: {
    networkRequests: string[];
    hasScripts: boolean;
    hasExecutableDom: boolean;
    hasUnresolvedPlaceholders: boolean;
    hasSecretLikeText: boolean;
    screenshotCreated: boolean;
  };
}

export async function renderPage(input: {
  html: string;
  screenshotPath: string;
  validatedOverlapPairs?: Array<{ imageSelector: string; captionSelector: string }>;
}): Promise<RenderResult> {
  await mkdir(dirname(input.screenshotPath), { recursive: true });
  const validatedOverlapPairs = input.validatedOverlapPairs ?? [];
  for (const pair of validatedOverlapPairs) {
    if (!/^\.[a-z_][a-z0-9_-]*$/i.test(pair.imageSelector) || !/^\.[a-z_][a-z0-9_-]*$/i.test(pair.captionSelector)) {
      throw new Error("Validated overlap pair selectors must be explicit class selectors");
    }
  }
  const executableDom = hasExecutableDom(input.html);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 1, javaScriptEnabled: false });
    const page = await context.newPage();
    const networkRequests: string[] = [];
    await page.route(/^https?:\/\//, async (route) => {
      networkRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    await page.routeWebSocket(/^(?:wss?):\/\//i, async (socket) => {
      networkRequests.push(socket.url());
      await socket.close({ code: 1008, reason: "blocked by deterministic renderer" });
    });
    await page.setContent(input.html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // tsx preserves function names with a tiny helper when serializing callbacks.
    // The callback executes in Chromium, so expose the identity helper there too.
    await page.evaluate("globalThis.__name = (target) => target");

    const measured = await page.evaluate(async ({ overlapPairs, landmarks }) => {
      const parseColor = (value: string): [number, number, number, number] | null => {
        const match = value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([\d.]+))?\)/);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])] : null;
      };
      const luminance = ([red, green, blue]: number[]) => {
        const channel = (value: number) => {
          const normalized = value / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      };
      const contrast = (foreground: number[], background: number[]) => {
        const light = Math.max(luminance(foreground), luminance(background));
        const dark = Math.min(luminance(foreground), luminance(background));
        return (light + 0.05) / (dark + 0.05);
      };
      const effectiveBackground = (element: Element): { color: number[]; measurable: boolean } => {
        let current: Element | null = element;
        while (current) {
          const style = getComputedStyle(current);
          if (style.backgroundImage !== "none") return { color: [255, 255, 255], measurable: false };
          const color = parseColor(style.backgroundColor);
          if (color && color[3] > 0.95) return { color, measurable: true };
          current = current.parentElement;
        }
        return { color: [255, 255, 255], measurable: true };
      };

      const fullyClippedByInset = (element: Element, clipPath: string): boolean => {
        const match = clipPath.match(/^inset\(([^)]*)\)/i);
        if (!match) return false;
        const rect = element.getBoundingClientRect();
        const tokens = match[1].trim().split(/\s+/u);
        if (tokens.length < 1 || tokens.length > 4 || tokens.some((token) => /^round$/i.test(token))) return false;
        const expanded = tokens.length === 1 ? [tokens[0], tokens[0], tokens[0], tokens[0]]
          : tokens.length === 2 ? [tokens[0], tokens[1], tokens[0], tokens[1]]
            : tokens.length === 3 ? [tokens[0], tokens[1], tokens[2], tokens[1]]
              : tokens;
        const pixels = (token: string, length: number): number | undefined => {
          if (/^-?[\d.]+%$/.test(token)) return Number.parseFloat(token) * length / 100;
          if (/^-?[\d.]+px$/.test(token)) return Number.parseFloat(token);
          if (token === "0") return 0;
          return undefined;
        };
        const top = pixels(expanded[0], rect.height);
        const right = pixels(expanded[1], rect.width);
        const bottom = pixels(expanded[2], rect.height);
        const left = pixels(expanded[3], rect.width);
        return top !== undefined && right !== undefined && bottom !== undefined && left !== undefined
          && (top + bottom >= rect.height - 0.5 || left + right >= rect.width - 0.5);
      };

      const isCssVisible = (element: Element): boolean => {
        let current: Element | null = element;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0.001) return false;
          if (fullyClippedByInset(current, style.clipPath)) return false;
          current = current.parentElement;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0.5 && rect.height > 0.5;
      };

      const clippedRect = (element: Element): { x: number; y: number; width: number; height: number } | null => {
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left);
        let top = Math.max(0, rect.top);
        let right = Math.min(1123, rect.right);
        let bottom = Math.min(794, rect.bottom);
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body) {
          const style = getComputedStyle(ancestor);
          const ancestorRect = ancestor.getBoundingClientRect();
          if (style.overflowX !== "visible") {
            left = Math.max(left, ancestorRect.left);
            right = Math.min(right, ancestorRect.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, ancestorRect.top);
            bottom = Math.min(bottom, ancestorRect.bottom);
          }
          ancestor = ancestor.parentElement;
        }
        return right - left > 0.5 && bottom - top > 0.5
          ? { x: left, y: top, width: right - left, height: bottom - top }
          : null;
      };

      const unionArea = (rectangles: Array<{ x: number; y: number; width: number; height: number }>): number => {
        const edges = [...new Set(rectangles.flatMap((rect) => [rect.x, rect.x + rect.width]))].sort((left, right) => left - right);
        let total = 0;
        for (let index = 0; index < edges.length - 1; index += 1) {
          const left = edges[index];
          const right = edges[index + 1];
          if (right <= left) continue;
          const intervals = rectangles
            .filter((rect) => rect.x < right && rect.x + rect.width > left)
            .map((rect) => [rect.y, rect.y + rect.height] as [number, number])
            .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          let covered = 0;
          let activeStart: number | undefined;
          let activeEnd: number | undefined;
          for (const [start, end] of intervals) {
            if (activeStart === undefined || activeEnd === undefined) {
              activeStart = start;
              activeEnd = end;
            } else if (start <= activeEnd) activeEnd = Math.max(activeEnd, end);
            else {
              covered += activeEnd - activeStart;
              activeStart = start;
              activeEnd = end;
            }
          }
          if (activeStart !== undefined && activeEnd !== undefined) covered += activeEnd - activeStart;
          total += covered * (right - left);
        }
        return total;
      };

      const allVisibleElements = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
        .filter(isCssVisible);
      const directTextNodes = (element: Element) => Array.from(element.childNodes)
        .filter((node): node is Text => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
      const rectValue = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      const elementId = (element: HTMLElement, fallback: string) => element.dataset.blockId
        || element.id
        || element.classList.item(0)
        || fallback;
      const visualRect = (element: HTMLElement) => {
        const textNodes = directTextNodes(element);
        if (textNodes.length === 0) return rectValue(element.getBoundingClientRect());
        const clientRects = textNodes.flatMap((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return Array.from(range.getClientRects());
        }).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
        if (clientRects.length === 0) return rectValue(element.getBoundingClientRect());
        const left = Math.min(...clientRects.map((rect) => rect.left));
        const top = Math.min(...clientRects.map((rect) => rect.top));
        const right = Math.max(...clientRects.map((rect) => rect.right));
        const bottom = Math.max(...clientRects.map((rect) => rect.bottom));
        return { x: left, y: top, width: right - left, height: bottom - top };
      };
      const contentElements = allVisibleElements.filter((element) => directTextNodes(element).length > 0 || element.matches("img, canvas"));
      const contentIds = new Map(contentElements.map((element, index) => [
        element,
        elementId(element, `${element.tagName.toLowerCase()}-${index + 1}`),
      ]));
      const candidates = contentElements.map((element) => ({
        element,
        id: contentIds.get(element)!,
        visualRect: visualRect(element),
      }));
      const resolvedOverlapPairs = overlapPairs.flatMap((pair) => {
        const images = Array.from(document.querySelectorAll<HTMLElement>(pair.imageSelector));
        const captions = Array.from(document.querySelectorAll<HTMLElement>(pair.captionSelector));
        if (images.length !== 1 || captions.length !== 1) return [];
        const image = images[0];
        const caption = captions[0];
        if (image.localName !== "img" || caption.localName !== "figcaption" || image.closest("figure") !== caption.closest("figure")) return [];
        return [{ image, caption }];
      });

      const containmentViolations: Array<{ targetId: string; ancestorId: string; overflowPx: number }> = [];
      for (const candidate of candidates) {
        const pageRoot = candidate.element.closest<HTMLElement>("[data-slide-page]");
        let ancestor = candidate.element.parentElement;
        while (ancestor && ancestor !== document.body) {
          const rect = ancestor.getBoundingClientRect();
          const visual = candidate.visualRect;
          const overflowPx = Math.max(
            0,
            rect.left - visual.x,
            rect.top - visual.y,
            visual.x + visual.width - rect.right,
            visual.y + visual.height - rect.bottom,
          );
          const outside = overflowPx > 4;
          if (outside) {
            containmentViolations.push({
              targetId: candidate.id,
              ancestorId: elementId(ancestor, ancestor.tagName.toLowerCase()),
              overflowPx,
            });
            break;
          }
          if (ancestor === pageRoot) break;
          ancestor = ancestor.parentElement;
        }
      }

      const collisions: Array<{ firstId: string; secondId: string; overlapArea: number }> = [];
      for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
          const left = candidates[leftIndex];
          const right = candidates[rightIndex];
          if (left.element.contains(right.element) || right.element.contains(left.element)) continue;
          const explicitlyExempt = resolvedOverlapPairs.some(({ image, caption }) => (
            (left.element === image && right.element === caption)
            || (left.element === caption && right.element === image)
          ));
          if (explicitlyExempt) continue;
          const leftRect = rectValue(left.element.getBoundingClientRect());
          const rightRect = rectValue(right.element.getBoundingClientRect());
          const overlapWidth = Math.min(leftRect.x + leftRect.width, rightRect.x + rightRect.width) - Math.max(leftRect.x, rightRect.x);
          const overlapHeight = Math.min(leftRect.y + leftRect.height, rightRect.y + rightRect.height) - Math.max(leftRect.y, rightRect.y);
          if (overlapWidth > 3 && overlapHeight > 3) {
            collisions.push({ firstId: left.id, secondId: right.id, overlapArea: overlapWidth * overlapHeight });
          }
        }
      }

      const elements = allVisibleElements
        .filter((element) => directTextNodes(element).length > 0)
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const foreground = parseColor(style.color) ?? [0, 0, 0, 1];
          const background = effectiveBackground(element);
          const fontSize = Number.parseFloat(style.fontSize);
          const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
          return {
            id: contentIds.get(element) || element.dataset.blockId || element.id || `${element.tagName.toLowerCase()}-${index + 1}`,
            tag: element.tagName.toLowerCase(),
            text: (element.textContent ?? "").trim().slice(0, 180),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            fontSize,
            fontWeight,
            contrastRatio: contrast(foreground, background.color),
            contrastMeasurable: background.measurable,
            largeText: fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700),
            bodyText: element.matches("p, li, td, th, figcaption, [data-fact-text-owner]")
              || Boolean(element.closest("[data-fact-text-owner]")),
          };
        });

      const imageMeasurements = await Promise.all(Array.from(document.images).map(async (image) => {
        let opaqueRatio = 0;
        let luminanceVariance = 0;
        if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 16;
            canvas.height = 16;
            const context = canvas.getContext("2d", { willReadFrequently: true })!;
            context.drawImage(image, 0, 0, 16, 16);
            const pixels = context.getImageData(0, 0, 16, 16).data;
            const values: number[] = [];
            let opaque = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if (pixels[offset + 3] > 5) opaque += 1;
              values.push((pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722) / 255);
            }
            opaqueRatio = opaque / 256;
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            luminanceVariance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
          } catch {
            opaqueRatio = 1;
          }
        }
        const src = image.currentSrc || image.src;
        const rect = image.getBoundingClientRect();
        const cssVisible = isCssVisible(image);
        const clipped = cssVisible ? clippedRect(image) : null;
        return {
          src,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          opaqueRatio,
          luminanceVariance,
          isVector: src.startsWith("data:image/svg+xml"),
          displayedArea: Math.max(0, rect.width) * Math.max(0, rect.height),
          clippedArea: clipped ? clipped.width * clipped.height : 0,
          cssVisible,
          clipped,
        };
      }));

      const images = imageMeasurements.map(({ clipped: _clipped, ...image }) => image);

      const pageRoot = document.querySelector<HTMLElement>("[data-slide-page]");
      const pageStyle = pageRoot ? getComputedStyle(pageRoot) : getComputedStyle(document.body);
      const rootStyle = getComputedStyle(document.documentElement);
      const profileAttributes = pageRoot ? {
        slug: pageRoot.getAttribute("data-template-slug") ?? "",
        version: pageRoot.getAttribute("data-template-version") ?? "",
        themeId: pageRoot.getAttribute("data-theme-id") ?? "",
        format: pageRoot.getAttribute("data-document-format") ?? "",
      } : undefined;
      const profile = profileAttributes && Object.values(profileAttributes).every(Boolean) ? profileAttributes : undefined;
      const landmarkCounts = Object.fromEntries(landmarks.map((landmark) => {
        const matches = Array.from(document.querySelectorAll<HTMLElement>(`[data-page-landmark="${landmark}"]`)).filter(isCssVisible);
        return [landmark, matches.length];
      })) as Record<SemanticLandmark, number>;
      const landmarkRects = Object.fromEntries(landmarks.map((landmark) => [landmark, Array.from(document.querySelectorAll<HTMLElement>(`[data-page-landmark="${landmark}"]`))
        .filter(isCssVisible)
        .map((element) => rectValue(element.getBoundingClientRect()))])) as Record<SemanticLandmark, RenderRect[]>;
      const pageFields: Record<string, string[]> = {};
      for (const field of Array.from(document.querySelectorAll<HTMLElement>("[data-page-field]"))) {
        const name = field.getAttribute("data-page-field");
        const technicalDocumentTitle = name === "pageTitle" && field.tagName === "TITLE";
        if (!technicalDocumentTitle && !isCssVisible(field)) continue;
        const value = (technicalDocumentTitle ? field.textContent : field.innerText)?.trim() ?? "";
        if (!name || !value) continue;
        pageFields[name] = [...(pageFields[name] ?? []), value];
      }
      if (!pageFields.pageTitle && document.title.trim()) pageFields.pageTitle = [document.title.trim()];
      const semanticItems = Array.from(document.querySelectorAll<HTMLElement>("[data-semantic-slot][data-block-id]"))
        .filter(isCssVisible)
        .map((element) => {
          const owners = Array.from(element.querySelectorAll<HTMLElement>("[data-fact-text-owner]"));
          const visibleOwners = owners.filter(isCssVisible);
          const titleOwners = Array.from(element.querySelectorAll<HTMLElement>("[data-semantic-title-owner]"));
          const visibleTitleOwners = titleOwners.filter(isCssVisible);
          const bindingTexts = Array.from(element.querySelectorAll<HTMLElement>("[data-semantic-binding-field][data-semantic-binding-index]"))
            .map((owner) => {
              const visible = isCssVisible(owner);
              return {
                field: owner.getAttribute("data-semantic-binding-field") ?? "",
                valueIndex: Number.parseInt(owner.getAttribute("data-semantic-binding-index") ?? "-1", 10),
                text: visible ? owner.innerText.trim() : "",
                visible,
              };
            });
          return {
            blockId: element.getAttribute("data-block-id") ?? "",
            slotId: element.getAttribute("data-semantic-slot") ?? "",
            sourceFactIds: (element.getAttribute("data-source-fact-ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
            visibleText: element.innerText.trim(),
            factText: visibleOwners.map((owner) => owner.innerText.trim()).filter(Boolean).join("\n"),
            factTextOwnerCount: owners.length,
            visibleFactTextOwnerCount: visibleOwners.length,
            titleText: visibleTitleOwners.map((owner) => owner.innerText.trim()).filter(Boolean).join("\n"),
            titleTextOwnerCount: titleOwners.length,
            visibleTitleTextOwnerCount: visibleTitleOwners.length,
            bindingTexts,
          };
        });
      const decodeGeneratedContent = (raw: string): string => {
        const value = raw.trim();
        if (!value || value === "none" || value === "normal" || value === '""' || value === "''") return "";
        const quoted = value.match(/^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/s);
        return quoted ? (quoted[1] ?? quoted[2] ?? "").replace(/\\([\\"'])/g, "$1") : value;
      };
      const protectedGeneratedText: Array<{ zone: "semantic" | "page-field"; owner: string; text: string }> = [];
      const protectedRoots = Array.from(document.querySelectorAll<HTMLElement>("[data-semantic-slot], [data-page-field]"));
      for (const root of protectedRoots) {
        const zone = root.hasAttribute("data-page-field") ? "page-field" as const : "semantic" as const;
        const owner = root.getAttribute("data-block-id") || root.getAttribute("data-page-field") || root.tagName.toLowerCase();
        for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
          if (!isCssVisible(element)) continue;
          for (const pseudo of ["::before", "::after"] as const) {
            const style = getComputedStyle(element, pseudo);
            if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0.001) continue;
            const text = decodeGeneratedContent(style.content);
            if (/[\p{L}\p{N}]/u.test(text)) protectedGeneratedText.push({ zone, owner, text });
          }
        }
      }
      const blankComponents = Array.from(document.querySelectorAll<HTMLElement>("[data-component]"))
        .filter(isCssVisible)
        .filter((component) => {
          if (component.innerText.trim()) return false;
          return !Array.from(component.querySelectorAll<HTMLElement>("img, svg, canvas"))
            .some((graphic) => isCssVisible(graphic) && Boolean(clippedRect(graphic)));
        })
        .map((component, index) => component.dataset.blockId || component.dataset.component || component.id || `component-${index + 1}`);

      const visibleRasterRects = imageMeasurements
        .filter((image) => !image.isVector && image.cssVisible && image.clipped)
        .map((image) => image.clipped!);
      const rasterUnionArea = unionArea(visibleRasterRects);

      const area = elements.reduce((sum, element) => sum + Math.min(element.rect.width * element.rect.height, 1123 * 794), 0);
      return {
        pageCount: document.querySelectorAll("[data-slide-page]").length,
        elements,
        images,
        rasterAreaRatio: Math.min(1, rasterUnionArea / (1123 * 794)),
        raster: {
          visibleCount: visibleRasterRects.length,
          unionArea: rasterUnionArea,
          unionAreaRatio: Math.min(1, rasterUnionArea / (1123 * 794)),
        },
        bodyScroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        occupiedRatio: Math.min(1, area / (1123 * 794)),
        structure: {
          ...(pageRoot?.getAttribute("data-slide-page") ? { pageNumber: pageRoot.getAttribute("data-slide-page")! } : {}),
          ...(profile ? { profile } : {}),
          designTokens: {
            fontFamily: pageStyle.fontFamily,
            textColor: pageStyle.color,
            backgroundColor: pageStyle.backgroundColor,
            fontScale: rootStyle.getPropertyValue("--workflow-font-scale").trim() || "1",
            spacingScale: rootStyle.getPropertyValue("--workflow-spacing-scale").trim() || "1",
            contrastMode: (document.documentElement.getAttribute("data-contrast") === "high" ? "high" : "normal") as "high" | "normal",
          },
          landmarkCounts,
          landmarkRects,
          pageFields,
          semanticItems,
          blankComponents,
          protectedGeneratedText,
        },
        layout: { containmentViolations, collisions },
      };
    }, { overlapPairs: validatedOverlapPairs, landmarks: SEMANTIC_LANDMARKS });

    await page.screenshot({ path: input.screenshotPath, type: "png", fullPage: false, animations: "disabled" });
    await context.close();
    const screenshot = await readFile(input.screenshotPath);
    return {
      screenshotPath: input.screenshotPath,
      screenshotDataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
      viewport: { width: 1123, height: 794 },
      ...measured,
      signals: {
        networkRequests,
        hasScripts: /<script[\s>]/i.test(input.html),
        hasExecutableDom: executableDom,
        hasUnresolvedPlaceholders: /<(?:figures|icon|page-title|component-title|paragraph|summary-text|bullet)[\s>]/i.test(input.html),
        hasSecretLikeText: /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]\s*["']?[^\s"']{12,})/i.test(input.html),
        screenshotCreated: screenshot.length > 100,
      },
    };
  } finally {
    await browser.close();
  }
}
