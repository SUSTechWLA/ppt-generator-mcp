import { JSDOM } from "jsdom";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface TemplateMeta {
  slug: string;
  name: string;
  description: string;
  usecase: string[];
  format: string;
  layout: string;
  components: string[];
  style: string;
  lang: string;
  filePath: string;
}

export interface PlaceholderInfo {
  tag: string;
  currentText: string;
  count: number;
}

export interface IconInfo {
  name: string;
  description: string;
  count: number;
}

export interface ParsedTemplate {
  slug: string;
  html: string;
  filePath: string;
  metadata: TemplateMeta;
  placeholders: PlaceholderInfo[];
  icons: IconInfo[];
}

// ============================================================================
// XML Comment Metadata Parser
// ============================================================================

function parseXmlCommentHeader(html: string): Partial<TemplateMeta> {
  const commentMatch = html.match(/<!--([\s\S]*?)-->/);
  if (!commentMatch) return {};

  const comment = commentMatch[1];
  const meta: Record<string, string> = {};

  const lines = comment.split("\n");
  for (const line of lines) {
    const m = line.match(/^@(\S+)\s+(.+)$/);
    if (m) {
      meta[m[1]] = m[2].trim();
    }
  }

  return {
    name: meta["name"] || "",
    slug: meta["slug"] || "",
    description: meta["description"] || "",
    usecase: meta["usecase"] ? meta["usecase"].split("|").map((s) => s.trim()) : [],
    format: meta["format"] || "",
    layout: meta["layout"] || "",
    components: meta["components"] ? meta["components"].split("|").map((s) => s.trim()) : [],
    style: meta["style"] || "",
    lang: meta["lang"] || "zh-CN",
  };
}

// ============================================================================
// HTML Meta Tag Parser
// ============================================================================

function parseMetaTags(doc: Document): Partial<TemplateMeta> {
  const getContent = (name: string): string => {
    const el = doc.querySelector(`meta[name="${name}"]`);
    return el?.getAttribute("content") || "";
  };

  return {
    name: getContent("template-name"),
    slug: getContent("template-slug"),
    description: getContent("template-description"),
    usecase: getContent("template-usecase")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    format: getContent("template-format"),
  };
}

// ============================================================================
// Placeholder Extractor
// ============================================================================

const PLACEHOLDER_TAGS = [
  "page-title",
  "page-number",
  "section-title",
  "part-number",
  "part-label",
  "chapter-label",
  "topic-title",
  "subsection-title",
  "component-title",
  "figure-ref",
  "paragraph",
  "step-label",
  "step-number",
  "stage-number",
  "stage-label",
  "item-label",
  "node-label",
  "figures",
  "image-caption",
  "summary-text",
  "bullet",
  "icon",
];

function extractPlaceholders(doc: Document): PlaceholderInfo[] {
  const map = new Map<string, { texts: Set<string>; count: number }>();

  for (const tag of PLACEHOLDER_TAGS) {
    const elements = doc.querySelectorAll(tag);
    if (elements.length > 0) {
      const texts = new Set<string>();
      elements.forEach((el) => {
        texts.add(el.textContent?.trim() || "");
      });
      map.set(tag, { texts, count: elements.length });
    }
  }

  return Array.from(map.entries()).map(([tag, info]) => ({
    tag,
    currentText: Array.from(info.texts).join(" | ").slice(0, 200),
    count: info.count,
  }));
}

function extractIcons(doc: Document): IconInfo[] {
  const iconElements = doc.querySelectorAll("icon");
  const map = new Map<
    string,
    { descriptions: Set<string>; count: number }
  >();

  iconElements.forEach((el) => {
    const name = el.getAttribute("name") || "unknown";
    const desc = el.textContent?.trim() || "";
    const existing = map.get(name);
    if (existing) {
      existing.descriptions.add(desc);
      existing.count++;
    } else {
      map.set(name, { descriptions: new Set([desc]), count: 1 });
    }
  });

  return Array.from(map.entries()).map(([name, info]) => ({
    name,
    description: Array.from(info.descriptions).join(" | "),
    count: info.count,
  }));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all available templates in a directory.
 */
export function listTemplates(
  templatesDir: string,
): (TemplateMeta & { filePath: string })[] {
  const result: (TemplateMeta & { filePath: string })[] = [];

  function scanDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files/dirs and assets/images/icons directories
      if (
        entry.name.startsWith(".") ||
        entry.name === "assets" ||
        entry.name === "output" ||
        entry.name === "node_modules"
      )
        continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".html") && !entry.name.endsWith("-page.html")) {
        // Only scan template files (not reference pages)
        const html = fs.readFileSync(fullPath, "utf-8");
        const first80Lines = html.split("\n").slice(0, 80).join("\n");

        const commentMeta = parseXmlCommentHeader(first80Lines);
        const dom = new JSDOM(html);
        const htmlMeta = parseMetaTags(dom.window.document);

        const meta: TemplateMeta = {
          slug: commentMeta.slug || htmlMeta.slug || "",
          name: commentMeta.name || htmlMeta.name || "",
          description: commentMeta.description || htmlMeta.description || "",
          usecase: commentMeta.usecase?.length
            ? commentMeta.usecase
            : htmlMeta.usecase || [],
          format: commentMeta.format || htmlMeta.format || "",
          layout: commentMeta.layout || "",
          components: commentMeta.components || [],
          style: commentMeta.style || "",
          lang: commentMeta.lang || "zh-CN",
          filePath: path.relative(templatesDir, fullPath),
        };

        result.push({ ...meta, filePath: fullPath });
      }
    }
  }

  scanDir(templatesDir);
  return result;
}

/**
 * Load and fully parse a template by slug or path.
 */
export function loadTemplate(
  templatesDir: string,
  slug: string,
): ParsedTemplate {
  // Find the template file
  const templates = listTemplates(templatesDir);
  const tpl = templates.find(
    (t) => t.slug === slug || t.filePath.includes(slug),
  );

  if (!tpl) {
    throw new Error(
      `Template "${slug}" not found. Available: ${templates.map((t) => t.slug).join(", ")}`,
    );
  }

  const html = fs.readFileSync(tpl.filePath, "utf-8");
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const placeholders = extractPlaceholders(doc);
  const icons = extractIcons(doc);

  return {
    slug: tpl.slug,
    html,
    filePath: tpl.filePath,
    metadata: tpl,
    placeholders,
    icons,
  };
}

/**
 * Extract figure prompts from HTML for image generation.
 */
export function extractFigurePrompts(html: string): {
  html: string;
  prompts: Array<{ id: string; prompt: string; caption: string }>;
} {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const figuresElements = doc.querySelectorAll("figures");
  const prompts: Array<{ id: string; prompt: string; caption: string }> = [];

  figuresElements.forEach((el, i) => {
    const prompt = el.textContent?.trim() || "";
    // Find the associated image-caption
    const parent = el.parentElement;
    const captionEl = parent?.querySelector("image-caption");
    const caption = captionEl?.textContent?.trim() || "AI生成图片";

    const id = `img-${Date.now().toString(36)}-${i}`;
    prompts.push({ id, prompt, caption });
  });

  return { html: dom.serialize(), prompts };
}
