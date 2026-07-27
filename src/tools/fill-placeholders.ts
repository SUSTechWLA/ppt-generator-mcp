import { JSDOM } from "jsdom";
import {
  generateText,
  type LLMConfig,
} from "../lib/llm-client.js";

// ============================================================================
// Types
// ============================================================================

export interface FillPlaceholdersInput {
  html: string;
  content: {
    direct?: Record<string, string | string[]>;
    expand?: Record<
      string,
      Array<{
        index?: number;
        keyPoints: string[];
        style?: string;
      }>
    >;
  };
  llmConfig?: LLMConfig;
}

export interface FillPlaceholdersOutput {
  html: string;
  filledCount: number;
  details: Array<{
    tag: string;
    index: number;
    mode: "direct" | "expand" | "attribute";
    oldText: string;
    newText: string;
  }>;
  remainingPlaceholders: string[];
  warnings: string[];
}

// ============================================================================
// Constants
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
  "figure-ref", // inside <figures>, references paired card title
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
  "table-header",
  "table-cell",
];

// Attribute patterns that contain placeholder values
const ATTRIBUTE_PLACEHOLDERS: Array<{
  selector: string;
  attr: string;
  patterns: RegExp[];
  tag?: string;
}> = [
  {
    selector: "[data-page-number]",
    attr: "data-page-number",
    patterns: [/^N$/],
    tag: "page-number",
  },
  {
    selector: "[aria-label]",
    attr: "aria-label",
    patterns: [/^流程名称$/, /^时间线名称$/, /^能力面板名称$/, /^组织架构名称$/],
  },
];

// Content length thresholds for overflow warnings
const CHAR_LIMITS: Record<string, { max: number; label: string }> = {
  paragraph: { max: 180, label: "正文段落" },
  "component-title": { max: 16, label: "卡片标题" },
  "summary-text": { max: 100, label: "总结段落" },
  "step-label": { max: 8, label: "步骤标签" },
  "stage-label": { max: 8, label: "阶段标签" },
  "item-label": { max: 8, label: "能力项标签" },
  "node-label": { max: 8, label: "组织节点标签" },
};

const SYSTEM_PROMPT = `你是一个专业的技术文档撰写助手。根据提供的内容要点，生成正式、专业、通顺的中文技术文档段落。

要求：
1. 语言风格：正式、专业、简洁，适合标书或技术方案文档
2. 字数控制：正文段落120-180字；标题6-15字
3. 保持逻辑清晰、语句通顺
4. 直接输出结果文本，不要输出任何解释、标记或前缀
5. 每句话都要有信息量，避免空洞的套话`;

// ============================================================================
// Implementation
// ============================================================================

export async function fillPlaceholders(
  input: FillPlaceholdersInput,
): Promise<FillPlaceholdersOutput> {
  const details: FillPlaceholdersOutput["details"] = [];
  const warnings: string[] = [];
  let filledCount = 0;

  // === Phase 0: Pre-process raw HTML for JSDOM edge cases ===
  let rawHtml = input.html;

  if (input.content.direct) {
    for (const [tag, value] of Object.entries(input.content.direct)) {
      const replacement = Array.isArray(value) ? value[0] : value;
      if (typeof replacement !== "string") continue;

      // Fix 1: <page-title> inside <title> (JSDOM treats <title> as raw text)
      const titleRegex = new RegExp(
        `(<title[^>]*>)<${tag}>[^<]*<\\/${tag}>(<\\/title>)`,
        "gi",
      );
      if (titleRegex.test(rawHtml)) {
        rawHtml = rawHtml.replace(titleRegex, `$1${replacement}$2`);
        details.push({
          tag, index: -1, mode: "direct",
          oldText: "(inside <title>)", newText: replacement,
        });
        filledCount++;
      }
    }
  }

  // === Phase 1: DOM-based XML tag unwrapping ===
  const dom = new JSDOM(rawHtml);
  const doc = dom.window.document;

  function unwrap(el: Element, newText: string) {
    el.replaceWith(doc.createTextNode(newText));
  }

  // --- Phase 1a: Direct text replacements ---
  if (input.content.direct) {
    for (const [tag, value] of Object.entries(input.content.direct)) {
      const elements = doc.querySelectorAll(tag);
      if (elements.length === 0) continue;

      if (Array.isArray(value)) {
        elements.forEach((el, i) => {
          if (i < value.length) {
            const oldText = el.textContent?.trim() || "";
            const txt = value[i];
            unwrap(el, txt);
            details.push({ tag, index: i, mode: "direct", oldText, newText: txt });
            filledCount++;
            checkLength(tag, txt, i, warnings);
          }
        });
      } else {
        elements.forEach((el, i) => {
          const oldText = el.textContent?.trim() || "";
          unwrap(el, value);
          details.push({ tag, index: i, mode: "direct", oldText, newText: value });
          filledCount++;
          checkLength(tag, value, i, warnings);
        });
      }
    }
  }

  // --- Phase 1b: LLM expansion ---
  if (input.content.expand && input.llmConfig) {
    for (const [tag, items] of Object.entries(input.content.expand)) {
      for (const item of items) {
        const elements = doc.querySelectorAll(tag);
        const targets = item.index !== undefined
          ? [elements[item.index]].filter(Boolean)
          : Array.from(elements);

        for (let i = 0; i < targets.length; i++) {
          const el = targets[i];
          if (!el) continue;
          const idx = item.index !== undefined ? item.index : i;
          const oldText = el.textContent?.trim() || "";
          const style = item.style || "标书技术方案，正式专业，120-180字";
          const userPrompt = buildExpansionPrompt(tag, item.keyPoints, style);

          try {
            const generated = await generateText(input.llmConfig, SYSTEM_PROMPT, userPrompt);
            const cleanText = generated.trim();
            if (cleanText) {
              unwrap(el, cleanText);
              details.push({ tag, index: idx, mode: "expand", oldText, newText: cleanText });
              filledCount++;
              checkLength(tag, cleanText, idx, warnings);
            }
          } catch (err) {
            const msg = `LLM扩写失败 <${tag}>[${idx}]: ${err instanceof Error ? err.message : String(err)}`;
            console.error(msg);
            warnings.push(msg);
          }
        }
      }
    }
  }

  // --- Phase 1c: Attribute placeholder scanning ---
  for (const rule of ATTRIBUTE_PLACEHOLDERS) {
    const elements = doc.querySelectorAll(rule.selector);
    elements.forEach((el) => {
      const currentVal = el.getAttribute(rule.attr);
      if (!currentVal) return;

      for (const pattern of rule.patterns) {
        if (pattern.test(currentVal)) {
          // Try to get replacement from direct content
          let replacement = "";
          if (rule.tag && input.content.direct?.[rule.tag]) {
            const val = input.content.direct[rule.tag];
            replacement = Array.isArray(val) ? val[0] : val;
          }

          if (replacement && replacement !== currentVal) {
            el.setAttribute(rule.attr, replacement);
            details.push({
              tag: rule.tag || rule.attr,
              index: -1,
              mode: "attribute",
              oldText: `${rule.attr}="${currentVal}"`,
              newText: replacement,
            });
            filledCount++;
          } else if (!replacement && input.content.direct) {
            // Try to derive from related tag
            const derived = tryDeriveAttribute(rule.attr, currentVal, input.content.direct, doc);
            if (derived && derived !== currentVal) {
              el.setAttribute(rule.attr, derived);
              details.push({
                tag: rule.tag || rule.attr,
                index: -1,
                mode: "attribute",
                oldText: `${rule.attr}="${currentVal}"`,
                newText: derived,
              });
              filledCount++;
            }
          }
          break;
        }
      }
    });
  }

  // === Phase 2: Post-process serialized HTML ===
  let html = dom.serialize();

  // Clean up any escaped XML tags from previously-serialized HTML
  if (input.content.direct) {
    for (const [tag, value] of Object.entries(input.content.direct)) {
      const replacement = Array.isArray(value) ? value[0] : value;
      if (typeof replacement !== "string") continue;

      const escapedRegex = new RegExp(
        `&lt;${tag}&gt;[^&]*&lt;\\/${tag}&gt;`,
        "gi",
      );
      html = html.replace(escapedRegex, replacement);
    }
  }

  // === Phase 3: Final scan for residual placeholders ===
  // Strip comments first to avoid false positives from example code in comments
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const remaining: string[] = [];
  for (const tag of PLACEHOLDER_TAGS) {
    if (new RegExp(`<${tag}[\\s>]`, "gi").test(htmlNoComments)) {
      remaining.push(tag);
    }
  }

  return { html, filledCount, details, remainingPlaceholders: remaining, warnings };
}

// ============================================================================
// Helpers
// ============================================================================

function checkLength(
  tag: string,
  text: string,
  index: number,
  warnings: string[],
) {
  const limit = CHAR_LIMITS[tag];
  if (limit && text.length > limit.max) {
    warnings.push(
      `${limit.label} <${tag}>[${index}] 共${text.length}字，超出建议上限${limit.max}字，可能溢出`,
    );
  }
}

/**
 * Try to derive an attribute value from related direct content.
 */
function tryDeriveAttribute(
  attr: string,
  currentVal: string,
  direct: Record<string, string | string[]>,
  _doc: Document,
): string | null {
  // Map aria-label placeholders to related content
  const ARIA_MAP: Record<string, string> = {
    "流程名称": "step-label" as any,
    "时间线名称": "stage-label" as any,
    "能力面板名称": "item-label" as any,
    "组织架构名称": "node-label" as any,
  };

  const relatedTag = ARIA_MAP[currentVal];
  if (relatedTag && direct[relatedTag]) {
    const val = direct[relatedTag];
    const items = Array.isArray(val) ? val : [val];
    // Build a concise label from the items
    return items.slice(0, 3).join("·");
  }

  return null;
}

function buildExpansionPrompt(
  tag: string,
  keyPoints: string[],
  style: string,
): string {
  const points = keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n");

  switch (tag) {
    case "component-title":
      return `根据以下要点生成卡片标题（6-15字）：\n${points}\n风格：${style}`;
    case "paragraph":
      return `根据以下要点展开正文段落（120-180字，约3-5句）：\n${points}\n风格：${style}`;
    case "summary-text":
      return `根据以下要点生成总结（40-80字）：\n${points}\n风格：${style}`;
    case "step-label":
    case "stage-label":
    case "item-label":
    case "node-label":
      return `为以下要点生成简短标签（2-8字）：\n${points}`;
    case "figure-ref":
      return `以下是对应的卡片标题，请直接复述（不要修改）：\n${points}`;
    default:
      return `为以下要点生成${tag}文本：\n${points}\n风格：${style}`;
  }
}
