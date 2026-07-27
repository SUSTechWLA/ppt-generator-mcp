import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface AssemblePageInput {
  html: string;
  config: {
    removeXmlComment?: boolean;
    minifyOutput?: boolean;
    inlineCss?: boolean;
    outputPath?: string;
    linkedCssPath?: string;
    templateDir?: string;
  };
}

export interface AssemblePageOutput {
  outputPath?: string;
  html: string;
  warnings: string[];
}

// Must match the PLACEHOLDER_TAGS in fill-placeholders.ts
const PLACEHOLDER_TAGS = [
  "page-title", "page-number", "section-title", "part-number",
  "part-label", "chapter-label", "topic-title", "subsection-title",
  "component-title", "figure-ref", "paragraph", "step-label",
  "step-number", "stage-number", "stage-label", "item-label",
  "node-label", "figures", "image-caption", "summary-text", "bullet",
  "table-header", "table-cell", "icon",
];

// ============================================================================
// Implementation
// ============================================================================

export function assemblePage(input: AssemblePageInput): AssemblePageOutput {
  const warnings: string[] = [];
  let html = input.html;

  // ── 1. Remove XML comment header ──
  if (input.config.removeXmlComment !== false) {
    html = html.replace(/<!--[\s\S]*?-->/g, (match) => {
      if (match.startsWith("<!--[if") || match.startsWith("<!--<![endif]")) {
        return match;
      }
      return "";
    });
  }

  // ── 2. Check for residual XML placeholders ──
  for (const tag of PLACEHOLDER_TAGS) {
    const regex = new RegExp(`<${tag}[\\s>]`, "gi");
    const match = html.match(regex);
    if (match) {
      warnings.push(`发现残留占位符标签: <${tag}> (${match.length}处)`);
    }
  }

  // ── 3. Inline CSS ──
  if (input.config.inlineCss && input.config.linkedCssPath) {
    const cssPath = input.config.linkedCssPath;
    if (fs.existsSync(cssPath)) {
      const cssContent = fs.readFileSync(cssPath, "utf-8");
      html = html.replace(
        /<link[^>]*href="([^"]*\.css)"[^>]*>/g,
        `<style>${cssContent}</style>`,
      );
    } else {
      warnings.push(`CSS 文件不存在: ${cssPath}`);
    }
  }

  // ── 4. Copy CSS alongside output ──
  if (input.config.templateDir && input.config.outputPath) {
    // Find linked CSS
    const cssMatches = html.matchAll(
      /<link[^>]*href="(\.\/[^"]*\.css)"[^>]*>/g,
    );
    for (const m of cssMatches) {
      const relCss = m[1];
      const absCss = path.resolve(input.config.templateDir, relCss);
      if (fs.existsSync(absCss)) {
        const destCss = path.join(
          path.dirname(input.config.outputPath),
          path.basename(relCss),
        );
        const cssContent = fs.readFileSync(absCss, "utf-8");
        const destDir = path.dirname(destCss);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(destCss, cssContent);
        html = html.replace(relCss, `./${path.basename(relCss)}`);
      } else {
        warnings.push(`CSS 文件未找到: ${absCss}`);
      }
    }
  }

  // ── 5. Minify ──
  if (input.config.minifyOutput) {
    html = html.replace(/\n\s*/g, "").replace(/>\s+</g, "><").trim();
  }

  // ── 6. Write output ──
  if (input.config.outputPath) {
    const outputDir = path.dirname(input.config.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(input.config.outputPath, html, "utf-8");
  }

  return { outputPath: input.config.outputPath, html, warnings };
}
