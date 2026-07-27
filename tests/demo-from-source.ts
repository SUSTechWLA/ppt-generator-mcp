/**
 * Demo: 正文 → 纯文本可交付页面（含可审视的图片/图标提示词）
 *
 * 图标和图片插槽替换为完整提示词卡片，用户可直接审视内容并就提示词对话优化。
 * 后续接入 LLM API 即可将提示词一键转化为实际图片/图标。
 *
 * Usage:
 *   npx tsx tests/demo-from-source.ts
 *   OPENAI_API_KEY=sk-... npx tsx tests/demo-from-source.ts   # LLM 智能摘要
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadTemplate } from "../src/lib/template-parser.js";
import { parseSourceContent } from "../src/tools/parse-source-content.js";
import { fillPlaceholders } from "../src/tools/fill-placeholders.js";
import { assemblePage } from "../src/tools/assemble-page.js";
import { validatePage } from "../src/tools/validate-page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");

// ============================================================================
// Source document
// ============================================================================

// Read source from test.md (full bid document)
const SOURCE_TEXT = fs.readFileSync(
  path.join(PROJECT_ROOT, "test.md"),
  "utf-8",
);

// ============================================================================
// Insert prompt cards for visual slots
// ============================================================================

async function insertPromptCards(
  html: string,
  iconPrompts: Array<{ position: string; description: string; prompt: string }>,
  imagePrompts: Array<{ prompt: string }>,
): Promise<string> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Replace <icon> tags with prompt cards
  const icons = doc.querySelectorAll("icon");
  let iconIdx = 0;
  icons.forEach((el) => {
    const ip = iconPrompts[iconIdx % iconPrompts.length];
    const card = doc.createElement("div");
    card.setAttribute("class", "prompt-icon");
    const concept = ip?.position || "图标";
    card.innerHTML = `<span class="prompt-label">🔷 ${escapeHtml(concept)}</span><span class="prompt-text">${escapeHtml(ip?.prompt || "icon prompt")}</span>`;
    el.replaceWith(card);
    iconIdx++;
  });

  // Replace <figures> with image prompt cards
  const figures = doc.querySelectorAll("figures");
  figures.forEach((el, i) => {
    const imgPrompt = imagePrompts[i]?.prompt || "image prompt";
    const card = doc.createElement("div");
    card.setAttribute("class", "prompt-image");
    card.innerHTML = `<span class="prompt-label">🖼️ 配图提示词（可对话优化后生成）</span><span class="prompt-text">${escapeHtml(imgPrompt)}</span>`;
    el.replaceWith(card);

    // Clean figure-ref inside parent
    const parent = el.parentElement;
    const ref = parent?.querySelector("figure-ref");
    if (ref) ref.replaceWith(doc.createTextNode(ref.textContent || ""));
  });

  return dom.serialize();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================================
// Build prompts summary section for user review
// ============================================================================

function buildPromptsSummary(
  imagePrompts: Array<{ sectionTitle: string; prompt: string }>,
  iconPrompts: Array<{ position: string; prompt: string }>,
): string {
  const cards = imagePrompts.map((ip, i) =>
    `<div style="margin-bottom:2mm;padding:2mm;background:#F2F7EF;border-left:1mm solid #0B5A2A;font-size:8pt;line-height:1.4;">
      <strong style="color:#0B5A2A;">🖼️ 配图${i + 1}：${escapeHtml(ip.sectionTitle)}</strong>
      <p style="margin:0.5mm 0 0;color:#6B746E;">${escapeHtml(ip.prompt)}</p>
    </div>`,
  ).join("");

  const icons = iconPrompts.map((ip, i) =>
    `<div style="display:inline-block;width:30%;margin:1mm;padding:1.5mm;background:#F2F7EF;border:0.3mm dashed #8FAE99;font-size:7pt;vertical-align:top;">
      <strong style="color:#0B5A2A;">🔷 ${escapeHtml(ip.position)}</strong>
      <p style="margin:0.3mm 0 0;color:#6B746E;font-size:6.5pt;">${escapeHtml(ip.prompt)}</p>
    </div>`,
  ).join("");

  return `
    <div style="width:297mm;padding:3mm 6.5mm;background:#fff;margin-top:2mm;page-break-before:always;">
      <h3 style="color:#0B5A2A;font-size:14pt;margin:0 0 2mm;">📋 图片与图标生成提示词汇总（可审视优化后批量生成）</h3>
      <div style="margin-bottom:3mm;">${cards}</div>
      <h3 style="color:#0B5A2A;font-size:14pt;margin:2mm 0;">🔷 图标生成提示词</h3>
      <div>${icons}</div>
    </div>`;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("  正文 → 纯文本可交付页面（含审视提示词）");
  console.log("=".repeat(60));

  const useLLM = !!process.env.OPENAI_API_KEY;
  const llmConfig = useLLM
    ? { provider: "openai" as const, apiKey: process.env.OPENAI_API_KEY! }
    : undefined;

  // ── 1. Parse source ────────────────────────────────────────────
  console.log("\n[1/6] parse_source_content");
  const parsed = await parseSourceContent({
    sourceText: SOURCE_TEXT,
    mode: useLLM ? "llm" : "direct",
    llmConfig,
  });

  console.log(`  模板: ${parsed.recommendedTemplate}`);
  console.log(`  卡片: ${(parsed.content.direct["component-title"] as string[])?.length || 0} 个`);
  console.log(`  图片提示词: ${parsed.imagePrompts.length} 个`);
  console.log(`  图标提示词: ${parsed.iconPrompts.length} 个`);

  // ── 2. Load template ──────────────────────────────────────────
  console.log("\n[2/6] load_template");
  const tpl = loadTemplate(TEMPLATES_DIR, parsed.recommendedTemplate);

  // ── 3. Fill content ───────────────────────────────────────────
  console.log("\n[3/6] fill_placeholders");
  const filled = await fillPlaceholders({
    html: tpl.html,
    content: parsed.content,
    llmConfig,
  });
  console.log(`  已填充: ${filled.filledCount} 处`);
  if (filled.warnings.length) for (const w of filled.warnings) console.log(`  ⚠️  ${w}`);

  // ── 4. Insert prompt cards (replaces render_icons + generate_image) ──
  console.log("\n[4/6] insert_prompt_cards");
  const promptHtml = await insertPromptCards(
    filled.html,
    parsed.iconPrompts,
    parsed.imagePrompts,
  );
  console.log(`  图标卡片: ${parsed.iconPrompts.length} 个`);
  console.log(`  配图卡片: ${parsed.imagePrompts.length} 个`);

  // ── 5. Add image prompts summary + assemble ────────────────────
  console.log("\n[5/6] add_prompts_summary + assemble_page");

  // Append all image prompts as a reviewable section after the page
  const promptsSection = buildPromptsSummary(parsed.imagePrompts, parsed.iconPrompts);
  const finalHtml = promptHtml.replace("</body>", promptsSection + "</body>");

  const outputPath = path.join(OUTPUT_DIR, "page-personnel-response.html");
  const assembled = assemblePage({
    html: finalHtml,
    config: {
      removeXmlComment: true,
      outputPath,
      templateDir: path.dirname(tpl.filePath),
    },
  });
  console.log(`  输出: ${assembled.outputPath}`);
  if (assembled.warnings.length) for (const w of assembled.warnings) console.log(`  ⚠️  ${w}`);

  // ── 6. Validate ───────────────────────────────────────────────
  console.log("\n[6/6] validate_page");
  const validated = validatePage({
    html: assembled.html,
    htmlFilePath: outputPath,
    checks: ["no-xml-tags", "valid-html"],
  });

  if (validated.valid) {
    console.log("  验证通过 ✅");
  } else {
    for (const issue of validated.issues) console.log(`  ❌ ${issue.message}`);
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  可交付页面: ${outputPath}`);
  console.log(`  结果: ${validated.valid ? "✅" : "⚠️"}`);
  console.log("=".repeat(60));
}

main().catch((err) => { console.error("Demo failed:", err); process.exit(1); });
