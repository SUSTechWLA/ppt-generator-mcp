import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";

export interface RenderElement {
  id: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
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
  }>;
  bodyScroll: { width: number; height: number };
  occupiedRatio: number;
  signals: {
    networkRequests: string[];
    hasScripts: boolean;
    hasUnresolvedPlaceholders: boolean;
    hasSecretLikeText: boolean;
    screenshotCreated: boolean;
  };
}

export async function renderPage(input: { html: string; screenshotPath: string }): Promise<RenderResult> {
  await mkdir(dirname(input.screenshotPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const networkRequests: string[] = [];
    await page.route(/^https?:\/\//, async (route) => {
      networkRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    await page.setContent(input.html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // tsx preserves function names with a tiny helper when serializing callbacks.
    // The callback executes in Chromium, so expose the identity helper there too.
    await page.evaluate("globalThis.__name = (target) => target");

    const measured = await page.evaluate(async () => {
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

      const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const directText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
          return rect.width > 0.5 && rect.height > 0.5 && style.visibility !== "hidden" && style.display !== "none" && directText;
        })
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const foreground = parseColor(style.color) ?? [0, 0, 0, 1];
          const background = effectiveBackground(element);
          const fontSize = Number.parseFloat(style.fontSize);
          const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
          return {
            id: element.dataset.blockId || element.id || `${element.tagName.toLowerCase()}-${index + 1}`,
            tag: element.tagName.toLowerCase(),
            text: (element.textContent ?? "").trim().slice(0, 180),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
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
        return { src: image.currentSrc || image.src, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, opaqueRatio, luminanceVariance };
      }));

      const area = elements.reduce((sum, element) => sum + Math.min(element.rect.width * element.rect.height, 1123 * 794), 0);
      return {
        pageCount: document.querySelectorAll("[data-slide-page]").length,
        elements,
        images,
        bodyScroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        occupiedRatio: Math.min(1, area / (1123 * 794)),
      };
    });

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
        hasUnresolvedPlaceholders: /<(?:figures|icon|page-title|component-title|paragraph|summary-text|bullet)[\s>]/i.test(input.html),
        hasSecretLikeText: /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]\s*["']?[^\s"']{12,})/i.test(input.html),
        screenshotCreated: screenshot.length > 100,
      },
    };
  } finally {
    await browser.close();
  }
}
