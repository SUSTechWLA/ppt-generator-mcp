/**
 * Demo: 正文 → 两页可交付件（Page 1: 布局 + Page 2: 提示词参考）
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
import { insertAssetSlots, buildPromptsPage } from "../src/tools/insert-asset-slots.js";
import { assemblePage } from "../src/tools/assemble-page.js";
import { validatePage } from "../src/tools/validate-page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");

const SOURCE_TEXT = fs.readFileSync(path.join(PROJECT_ROOT, "test.md"), "utf-8");

async function main() {
  console.log("=".repeat(60));
  console.log("  正文 → 两页交付件（布局页 + 提示词参考页）");
  console.log("=".repeat(60));

  const useLLM = !!process.env.OPENAI_API_KEY;
  const llmConfig = useLLM
    ? { provider: "openai" as const, apiKey: process.env.OPENAI_API_KEY! }
    : undefined;

  // 1. Parse source → structured content + prompts
  const parsed = await parseSourceContent({
    sourceText: SOURCE_TEXT,
    mode: useLLM ? "llm" : "direct",
    llmConfig,
  });
  console.log(`\n[1/6] parse_source_content → ${parsed.recommendedTemplate}`);
  console.log(`  ${parsed.sections.length} sections, ${parsed.imagePrompts.length} image prompts, ${parsed.iconPrompts.length} icon prompts`);

  // 2. Load template
  const tpl = loadTemplate(TEMPLATES_DIR, parsed.recommendedTemplate);
  console.log(`[2/6] load_template → ${tpl.metadata.name}`);

  // 3. Fill content
  const filled = await fillPlaceholders({ html: tpl.html, content: parsed.content, llmConfig });
  console.log(`[3/6] fill_placeholders → ${filled.filledCount} filled`);
  if (filled.warnings.length) filled.warnings.forEach((w) => console.log(`  ⚠️  ${w}`));

  // 4. Insert asset slots (Page 1)
  const { html: layoutHtml, assetMap } = insertAssetSlots({
    html: filled.html,
    iconPrompts: parsed.iconPrompts,
    imagePrompts: parsed.imagePrompts,
  });
  console.log(`[4/6] insert_asset_slots → ${assetMap.filter((a) => a.type === "image").length} img + ${assetMap.filter((a) => a.type === "icon").length} icon slots`);

  // 5. Build Page 2 + assemble
  const finalHtml = layoutHtml.replace("</body>", buildPromptsPage(assetMap) + "</body>");
  const outputPath = path.join(OUTPUT_DIR, "page-personnel-response.html");
  const assembled = assemblePage({
    html: finalHtml,
    config: { removeXmlComment: true, outputPath, templateDir: path.dirname(tpl.filePath) },
  });
  console.log(`[5/6] assemble_page → ${outputPath}`);

  // 6. Validate
  const validated = validatePage({ html: assembled.html, htmlFilePath: outputPath, checks: ["no-xml-tags", "valid-html"] });
  console.log(`[6/6] validate_page → ${validated.valid ? "✅" : "❌ " + validated.issues.length + " issues"}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  结果: ${validated.valid ? "✅ 可交付" : "⚠️ 需修复"}  |  ${outputPath}`);
  console.log("=".repeat(60));
}

main().catch((err) => { console.error("Demo failed:", err); process.exit(1); });
