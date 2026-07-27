/**
 * Demo: 正文 → 可交付 PPT 页面（全流程）
 *
 * 输入: raw markdown source
 * 流程: parse_source_content → fill_placeholders → render_icons
 *       → generate_image → assemble_page → validate_page
 *
 * Usage:
 *   npx tsx tests/demo-from-source.ts
 *   OPENAI_API_KEY=sk-... npx tsx tests/demo-from-source.ts   # LLM mode
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplate } from "../src/lib/template-parser.js";
import { parseSourceContent } from "../src/tools/parse-source-content.js";
import { fillPlaceholders } from "../src/tools/fill-placeholders.js";
import { renderIcons } from "../src/tools/render-icons.js";
import { assemblePage } from "../src/tools/assemble-page.js";
import { validatePage } from "../src/tools/validate-page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");

// ============================================================================
// Source document (from user's markdown)
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
// Icon mapping — replaces hardcoded template icons with context-aware ones
// ============================================================================

function suggestIcons(
  sections: Array<{ title: string; paragraphs: string[] }>,
): Record<string, string> {
  const allText = sections.map((s) => s.title + " " + s.paragraphs.join(" ")).join(" ");

  const iconSemantics: Record<string, string> = {
    "users-group":      "人员|团队|班组|对接|组织",
    "clipboard-check":  "审批|流程|变更|申请|合规",
    "file-description": "文件|文档|台账|记录|归档|资料",
    "search":           "检查|巡查|考核|评估|监督",
    "calendar":         "计划|日程|安排|编制|排期",
    "scissors":         "作业|养护|修剪|施工|操作",
    "truck":            "设备|车辆|运输|机械|物资",
    "shield-check":     "质量|安全|保障|达标|标准",
  };

  // Score icons by keyword match count against content
  const scored = Object.entries(iconSemantics)
    .map(([icon, keywords]) => ({
      icon,
      score: keywords.split("|").filter((kw) => allText.includes(kw)).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Only replace truly irrelevant icons (not in our semantics at all)
  const irrelevant = ["leaf", "sun", "snowflake", "wind", "bug", "alert-triangle", "droplet"];
  const replacements: Record<string, string> = {};

  for (let i = 0; i < irrelevant.length; i++) {
    const best = scored[i % scored.length];
    if (best) replacements[irrelevant[i]] = best.icon;
  }

  return replacements;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("  正文 → PPT 全流程 Demo");
  console.log("=".repeat(60));

  // ── Step 1: Parse source content ─────────────────────────────────
  console.log("\n[1/8] parse_source_content — 解析正文 → 结构化 content");

  const mode = process.env.OPENAI_API_KEY ? "llm" : "direct";
  const llmConfig = process.env.OPENAI_API_KEY
    ? { provider: "openai" as const, apiKey: process.env.OPENAI_API_KEY }
    : undefined;

  const parsed = await parseSourceContent({
    sourceText: SOURCE_TEXT,
    mode: mode as "direct" | "llm",
    llmConfig,
  });

  console.log(`  模式: ${mode}`);
  console.log(`  推荐模板: ${parsed.recommendedTemplate}`);
  console.log(`  解析段落: ${parsed.sections.length} 节`);
  console.log(`  卡片标题: ${(parsed.content.direct["component-title"] as string[])?.length || 0} 个`);
  console.log(`  图片提示词: ${parsed.imagePrompts.length} 个`);
  for (const img of parsed.imagePrompts) {
    console.log(`    📷 ${img.sectionTitle}: ${img.prompt.slice(0, 80)}...`);
  }

  // ── Step 2: Load template ────────────────────────────────────────
  console.log("\n[2/8] load_template");

  const tpl = loadTemplate(TEMPLATES_DIR, parsed.recommendedTemplate);
  console.log(`  模板: ${tpl.metadata.name}`);

  // ── Step 3: Fill placeholders ────────────────────────────────────
  console.log("\n[3/8] fill_placeholders");

  const filled = await fillPlaceholders({
    html: tpl.html,
    content: parsed.content,
    ...(llmConfig ? { llmConfig } : {}),
  });

  console.log(`  已填充: ${filled.filledCount} 处`);
  if (filled.warnings.length > 0) {
    console.log(`  ⚠️  警告:`);
    for (const w of filled.warnings) console.log(`     ${w}`);
  }
  if (filled.remainingPlaceholders.length > 0) {
    console.log(`  待处理: ${filled.remainingPlaceholders.join(", ")}`);
  }

  // ── Step 4: Replace icons + render ────────────────────────────────
  console.log("\n[4/8] map_icons + render_icons");

  const templateDir = path.dirname(tpl.filePath);
  const { JSDOM } = await import("jsdom");

  // 4a: Replace hardcoded template icons with context-aware ones (BEFORE render)
  const preIconDom = new JSDOM(filled.html);
  const iconMap = suggestIcons(parsed.sections);
  const preIconDoc = preIconDom.window.document;
  preIconDoc.querySelectorAll("icon").forEach((el) => {
    const oldName = el.getAttribute("name") || "";
    if (iconMap[oldName]) el.setAttribute("name", iconMap[oldName]);
  });
  console.log(`  图标映射: ${Object.keys(iconMap).length} 个替换 (${Object.entries(iconMap).map(([k,v]) => `${k}→${v}`).join(", ")})`);

  // 4b: Now render icons
  const afterIconHtml = preIconDom.serialize();
  const iconResult = renderIcons({
    html: afterIconHtml,
    iconBasePath: path.join(templateDir, "assets", "icons"),
    iconsRelativePath: `../../templates/green-infographic/assets/icons/`,
  });
  console.log(`  已渲染: ${iconResult.iconCount} 个 SVG 图标`);

  // ── Step 5: Generate images ──────────────────────────────────────
  console.log("\n[5/8] generate_image");

  const imgDom = new JSDOM(iconResult.html);
  const imgDoc = imgDom.window.document;

  const figuresList = imgDoc.querySelectorAll("figures");
  for (let i = 0; i < figuresList.length; i++) {
    const el = figuresList[i];
    const prompt = parsed.imagePrompts[i]?.prompt || "AI生成场景图";
    const placeholder = imgDoc.createElement("div");
    placeholder.setAttribute("class", "placeholder-card");
    const escapedPrompt = prompt.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    placeholder.innerHTML =
      `<strong>📷 AI 配图提示词</strong><span>${escapedPrompt}</span>`;
    el.replaceWith(placeholder);

    const parent = el.parentElement;
    const refTag = parent?.querySelector("figure-ref");
    if (refTag) refTag.replaceWith(imgDoc.createTextNode(refTag.textContent || ""));
  }

  const imageHtml = imgDom.serialize();
  console.log(`  已生成 ${figuresList.length} 个图片占位符`);

  // ── Step 6: Assemble ─────────────────────────────────────────────
  console.log("\n[6/8] assemble_page");

  const outputPath = path.join(OUTPUT_DIR, "page-personnel-response.html");
  const assembled = assemblePage({
    html: imageHtml,
    config: {
      removeXmlComment: true,
      outputPath,
      templateDir,
    },
  });
  console.log(`  输出: ${assembled.outputPath}`);
  if (assembled.warnings.length > 0) {
    for (const w of assembled.warnings) console.log(`  ⚠️  ${w}`);
  }

  // ── Step 7: Validate ─────────────────────────────────────────────
  console.log("\n[7/8] validate_page");

  const validated = validatePage({
    html: assembled.html,
    htmlFilePath: outputPath,
    checks: ["no-xml-tags", "all-icons-rendered", "valid-html"],
  });

  if (validated.valid) {
    console.log("  验证通过 — 无残留占位符，HTML 合法");
  } else {
    console.log("  验证未通过:");
    for (const issue of validated.issues) {
      console.log(`  ❌ [${issue.type}] ${issue.message}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  8 步全流程完成`);
  console.log(`  输入: Markdown 正文 (${SOURCE_TEXT.length} 字)`);
  console.log(`  输出: ${outputPath}`);
  if (validated.valid && assembled.warnings.length === 0) {
    console.log(`  结果: ✅ 可交付`);
  } else {
    console.log(`  结果: ⚠️ 需检查`);
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
