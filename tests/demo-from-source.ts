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

const SOURCE_TEXT = `### 1.1.1 项目人员配备要求响应

招标文件明确要求："供应商中标后（包括服务期间），需明确1名固定的项目对接人员，其余作业人员根据现场实际情况增减。项目对接人员不得随意变更，若确需更换，须提交书面申请且经采购人审核同意。"针对此项要求，本方案从固定项目对接人员配置、作业人员动态调配机制和人员变更申请审批流程三个维度进行全面响应。

##### 固定项目对接人员配置方案

本方案将为本项目配备一名专职项目对接人员，该名人员将作为本方案与采购人之间的唯一信息对接窗口，全面负责日常养护工作的协调联络、任务传达、信息反馈和紧急事务处理。项目对接人员的日常工作职责包括：每日与采购人指定联系人进行工作沟通、接收养护指令和工作要求并传达至各班组；跟踪汇总各项目养护作业进度，形成工作日报定期汇报；处理业主反馈的问题和投诉，第一时间协调班组赴现场处理；负责养护工作台账的统一管理；负责月度考核迎检的统筹协调。

在人员资质和履职保障方面，选派的项目对接人员具有园林绿化相关专业背景和不少于三年项目管理经验；配备专用通信工具和交通工具确保随时可到达现场；建立后备人员交接预案确保工作不出现断档；将工作表现纳入绩效考核体系与业主满意度挂钩。

##### 作业人员动态调配机制

充分考虑8个物业项目养护面积差异大、植物品种多样的特点，本方案建立科学灵活的作业人员动态调配机制。核心框架由三个层面构成：基础配置层针对各项目养护面积确定日常人员配置，锦棠华府和溪语雅苑配置稳定班组，四个小型项目由机动班组巡回养护；季节性调配层根据春夏秋冬不同季节重点，定向调整修剪、施肥、植保、防台等作业人员比例；任务驱动调配层针对突击性任务和迎检整改，30分钟内启动调配流程，1小时内人员到达现场。

人员调配执行流程为：每日编制次日人员分配方案、每周召开班组协调会制定下周计划、每月根据考核结果优化配置方案，同时建立详细的人员调配台账记录。

##### 人员变更申请与审批流程

本方案严格遵守招标文件中关于项目对接人员不得随意变更的规定，制定规范透明的变更申请与审批流程。变更仅限三种情形：人员因重大疾病或意外伤害无法履职、个人原因离职或退休、采购人主动要求更换。变更流程包括：提交书面变更申请书说明原因和新任人选资质、采购人审核评估、书面批复同意、安排不少于五个工作日的岗位交接、新任人员上岗后三日内拜访采购人。

同时建立后备梯队制度，从班组长中选拔1-2名技术骨干作为后备培养对象，确保人员变更时新任者对本项目已有充分了解，最大限度缩短适应期。`;

// ============================================================================
// Insert prompt cards for visual slots
// ============================================================================

async function insertPromptCards(
  html: string,
  iconPrompts: Array<{ position: string; prompt: string }>,
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
    card.innerHTML = `<span class="prompt-label">🔷 图标</span><span class="prompt-text">${escapeHtml(ip?.prompt || "icon prompt")}</span>`;
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

  // ── 5. Assemble ───────────────────────────────────────────────
  console.log("\n[5/6] assemble_page");
  const outputPath = path.join(OUTPUT_DIR, "page-personnel-response.html");
  const assembled = assemblePage({
    html: promptHtml,
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
