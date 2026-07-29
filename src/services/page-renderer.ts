import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { hasExecutableDom } from "../lib/html-security.js";

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
  }>;
  rasterAreaRatio: number;
  bodyScroll: { width: number; height: number };
  occupiedRatio: number;
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

    const measured = await page.evaluate(async ({ overlapPairs }) => {
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

      const allVisibleElements = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0.5 && rect.height > 0.5 && style.visibility !== "hidden" && style.display !== "none";
        });
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
          };
        });

      const images = await Promise.all(Array.from(document.images).map(async (image) => {
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
        return {
          src,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          opaqueRatio,
          luminanceVariance,
          isVector: src.startsWith("data:image/svg+xml"),
          displayedArea: Math.max(0, rect.width) * Math.max(0, rect.height),
        };
      }));

      const area = elements.reduce((sum, element) => sum + Math.min(element.rect.width * element.rect.height, 1123 * 794), 0);
      const rasterArea = images
        .filter((image) => !image.isVector)
        .reduce((sum, image) => sum + image.displayedArea, 0);
      return {
        pageCount: document.querySelectorAll("[data-slide-page]").length,
        elements,
        images,
        rasterAreaRatio: Math.min(1, rasterArea / (1123 * 794)),
        bodyScroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        occupiedRatio: Math.min(1, area / (1123 * 794)),
        layout: { containmentViolations, collisions },
      };
    }, { overlapPairs: validatedOverlapPairs });

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
