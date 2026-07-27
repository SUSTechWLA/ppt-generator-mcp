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
// Insert asset slots (Page 1) — ID'd placeholder boxes for images/icons
// ============================================================================

async function insertAssetSlots(
  html: string,
  iconPrompts: Array<{ position: string; description: string; prompt: string }>,
  imagePrompts: Array<{ sectionTitle: string; prompt: string }>,
): Promise<{ html: string; assetMap: Array<{ id: string; type: string; label: string; prompt: string }> }> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const assetMap: Array<{ id: string; type: string; label: string; prompt: string }> = [];

  // Replace <icon> tags with icon-slot placeholder boxes
  const icons = doc.querySelectorAll("icon");
  icons.forEach((el, i) => {
    const ip = iconPrompts[i % iconPrompts.length];
    const id = `icon-${String(i + 1).padStart(3, "0")}`;
    const label = ip?.position || "图标";
    const slot = doc.createElement("div");
    slot.setAttribute("class", "icon-slot");
    slot.innerHTML = `<span class="slot-id">[${id}]</span><span class="slot-label">${escapeHtml(label)}</span>`;
    el.replaceWith(slot);
    assetMap.push({ id, type: "icon", label, prompt: ip?.prompt || "" });
  });

  // Replace <figures> with img-slot placeholder boxes
  const figures = doc.querySelectorAll("figures");
  figures.forEach((el, i) => {
    const ip = imagePrompts[i];
    const id = `img-${String(i + 1).padStart(3, "0")}`;
    const label = ip?.sectionTitle || "配图";
    const slot = doc.createElement("div");
    slot.setAttribute("class", "img-slot");
    slot.innerHTML = `<span class="slot-id">[${id}]</span><span class="slot-size">1792×1024</span><span class="slot-label">${escapeHtml(label)}</span>`;
    el.replaceWith(slot);
    assetMap.push({ id, type: "image", label, prompt: ip?.prompt || "" });

    // Clean figure-ref inside parent
    const parent = el.parentElement;
    const ref = parent?.querySelector("figure-ref");
    if (ref) ref.replaceWith(doc.createTextNode(ref.textContent || ""));
  });

  // Add any remaining image prompts that didn't fit DOM slots
  for (let i = figures.length; i < imagePrompts.length; i++) {
    const ip = imagePrompts[i];
    const id = `img-${String(i + 1).padStart(3, "0")}`;
    assetMap.push({ id, type: "image", label: ip?.sectionTitle || "配图", prompt: ip?.prompt || "" });
  }

  return { html: dom.serialize(), assetMap };
}

// ============================================================================
// Build prompts reference page (Page 2)
// ============================================================================

function buildPromptsPage(assetMap: Array<{ id: string; type: string; label: string; prompt: string }>): string {
  const images = assetMap.filter((a) => a.type === "image");
  const icons = assetMap.filter((a) => a.type === "icon");

  const imgRows = images.map((a) =>
    `<tr>
      <td style="padding:1.5mm 2mm;border:0.2mm solid #8FAE99;font-size:8pt;font-weight:700;color:#0B5A2A;">${escapeHtml(a.id)}</td>
      <td style="padding:1.5mm 2mm;border:0.2mm solid #8FAE99;font-size:8pt;">${escapeHtml(a.label)}</td>
      <td style="padding:1.5mm 2mm;border:0.2mm solid #8FAE99;font-size:7.5pt;line-height:1.4;color:#171A18;">${escapeHtml(a.prompt)}</td>
    </tr>`,
  ).join("");

  const iconRows = icons.map((a) =>
    `<tr>
      <td style="padding:1mm 2mm;border:0.2mm solid #8FAE99;font-size:7pt;font-weight:700;color:#0B5A2A;">${escapeHtml(a.id)}</td>
      <td style="padding:1mm 2mm;border:0.2mm solid #8FAE99;font-size:7pt;">${escapeHtml(a.label)}</td>
      <td style="padding:1mm 2mm;border:0.2mm solid #8FAE99;font-size:6.5pt;line-height:1.3;color:#6B746E;">${escapeHtml(a.prompt)}</td>
    </tr>`,
  ).join("");

  return `
    <div style="width:297mm;padding:4mm 6.5mm;background:#fff;page-break-before:always;font-family:Source Han Sans SC,Noto Sans CJK SC,sans-serif;">
      <h2 style="color:#0B5A2A;font-size:16pt;margin:0 0 1mm;">📋 图片与图标生成参考</h2>
      <p style="color:#6B746E;font-size:8pt;margin:0 0 3mm;">以下提示词可直接用于 DALL-E / Stable Diffusion 等文生图工具。生成后将图片命名为对应的 ID 并放入 assets 目录，即可自动替换交付件页面中的占位框。</p>

      <h3 style="color:#0B5A2A;font-size:12pt;margin:2mm 0 1mm;">🖼️ 配图提示词</h3>
      <table style="width:100%;border-collapse:collapse;border:0.3mm solid #8FAE99;">
        <thead>
          <tr style="background:#0B5A2A;color:#fff;">
            <th style="padding:1.5mm 2mm;font-size:8pt;text-align:left;">ID</th>
            <th style="padding:1.5mm 2mm;font-size:8pt;text-align:left;width:25%;">所属卡片</th>
            <th style="padding:1.5mm 2mm;font-size:8pt;text-align:left;">生成提示词</th>
          </tr>
        </thead>
        <tbody>${imgRows}</tbody>
      </table>

      <h3 style="color:#0B5A2A;font-size:12pt;margin:4mm 0 1mm;">🔷 图标提示词</h3>
      <table style="width:100%;border-collapse:collapse;border:0.3mm solid #8FAE99;">
        <thead>
          <tr style="background:#0B5A2A;color:#fff;">
            <th style="padding:1mm 2mm;font-size:7pt;text-align:left;">ID</th>
            <th style="padding:1mm 2mm;font-size:7pt;text-align:left;width:20%;">概念</th>
            <th style="padding:1mm 2mm;font-size:7pt;text-align:left;">生成提示词</th>
          </tr>
        </thead>
        <tbody>${iconRows}</tbody>
      </table>

      <p style="color:#6B746E;font-size:7pt;margin:3mm 0 0;">生成后文件命名示例：img-001.png, icon-001.svg — 放置于 assets/images/ 和 assets/icons/ 目录后刷新交付件页面即可显示。</p>
    </div>`;
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

  // ── 4. Insert asset slots (Page 1: layout with ID'd placeholders) ──
  console.log("\n[4/6] insert_asset_slots");
  const { html: layoutHtml, assetMap } = await insertAssetSlots(
    filled.html,
    parsed.iconPrompts,
    parsed.imagePrompts,
  );
  console.log(`  图片槽位: ${assetMap.filter(a => a.type === "image").length} 个`);
  console.log(`  图标槽位: ${assetMap.filter(a => a.type === "icon").length} 个`);

  // ── 5. Build Page 2 + assemble ─────────────────────────────────
  console.log("\n[5/6] build_prompts_page + assemble");
  const promptsPage = buildPromptsPage(assetMap);
  const finalHtml = layoutHtml.replace("</body>", promptsPage + "</body>");

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
