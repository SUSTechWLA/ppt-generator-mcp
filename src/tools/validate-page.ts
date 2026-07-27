import { JSDOM } from "jsdom";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export type ValidationCheck =
  | "no-xml-tags"
  | "all-icons-rendered"
  | "all-images-exist"
  | "valid-html";

export interface ValidatePageInput {
  html: string;
  htmlFilePath?: string;
  checks: ValidationCheck[];
}

export interface ValidationIssue {
  type: string;
  message: string;
  tag?: string;
  detail?: string;
}

export interface ValidatePageOutput {
  valid: boolean;
  issues: ValidationIssue[];
}

// Must match fill-placeholders
const RESIDUAL_TAGS = [
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

export function validatePage(input: ValidatePageInput): ValidatePageOutput {
  const issues: ValidationIssue[] = [];

  for (const check of input.checks) {
    switch (check) {
      case "no-xml-tags":
        issues.push(...checkResidualTags(input.html));
        break;
      case "all-icons-rendered":
        issues.push(...checkIconsRendered(input.html));
        break;
      case "all-images-exist":
        issues.push(...checkImagesExist(input.html, input.htmlFilePath));
        break;
      case "valid-html":
        issues.push(...checkValidHtml(input.html));
        break;
    }
  }

  return { valid: issues.length === 0, issues };
}

function checkResidualTags(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = html.split("\n");

  for (const tag of RESIDUAL_TAGS) {
    const regex = new RegExp(`<${tag}[\\s>]`, "gi");
    const matches = html.match(regex);
    if (matches) {
      // Find line numbers for the first few instances
      const lineNums: number[] = [];
      lines.forEach((l, i) => {
        if (regex.test(l)) lineNums.push(i + 1);
      });

      issues.push({
        type: "residual-xml-tag",
        tag,
        message: `发现 ${matches.length} 处未替换的 <${tag}> 标签`,
        detail: lineNums.length > 0
          ? `行: ${lineNums.slice(0, 5).join(", ")}${lineNums.length > 5 ? "…" : ""}`
          : undefined,
      });
    }
  }
  return issues;
}

function checkIconsRendered(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const matches = html.match(/<icon[^>]*>/gi);
  if (matches) {
    issues.push({
      type: "unrendered-icon",
      message: `发现 ${matches.length} 处未渲染的 <icon> 标签`,
    });
  }
  return issues;
}

function checkImagesExist(
  html: string,
  htmlFilePath?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const imgRegex = /<img[^>]*src="([^"]*)"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.startsWith("data:") || src.startsWith("http")) continue;

    if (htmlFilePath) {
      const fullPath = path.resolve(path.dirname(htmlFilePath), src);
      if (!fs.existsSync(fullPath)) {
        issues.push({
          type: "missing-image",
          message: `图片文件不存在: ${src}`,
          detail: `完整路径: ${fullPath}`,
        });
      }
    }
  }
  return issues;
}

function checkValidHtml(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    new JSDOM(html);
  } catch (err) {
    issues.push({
      type: "invalid-html",
      message: `HTML 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Also check for basic structural elements
  if (!/<html/i.test(html)) {
    issues.push({ type: "missing-structure", message: "缺少 <html> 根元素" });
  }
  if (!/<title>/i.test(html)) {
    issues.push({ type: "missing-structure", message: "缺少 <title> 元素" });
  }

  return issues;
}
