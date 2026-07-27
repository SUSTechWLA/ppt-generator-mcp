/**
 * PPT Generator MCP — Demo: green-infographic template to deliverable page.
 *
 * Usage:
 *   npx tsx tests/demo.ts
 *
 * Env vars (optional):
 *   OPENAI_API_KEY   — enable LLM expansion mode
 *   ANTHROPIC_API_KEY
 *   ENABLE_IMAGE_GEN — enable DALL-E image generation (needs OPENAI_API_KEY)
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listTemplates, loadTemplate } from "../src/lib/template-parser.js";
import { fillPlaceholders } from "../src/tools/fill-placeholders.js";
import { insertAssetSlots, buildPromptsPage } from "../src/tools/insert-asset-slots.js";
import { assemblePage } from "../src/tools/assemble-page.js";
import { validatePage } from "../src/tools/validate-page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");

// ============================================================================
// Content: 绿化养护技术方案标书页
// Paragraphs at 100-160 chars for optimal A4 landscape fit.
// ============================================================================

const CONTENT = {
  direct: {
    // Page metadata
    "page-title":     "第1页 | 绿化养护服务方案",
    "page-number":    "1",
    "section-title":  "第二章：服务方案与技术措施",
    "part-number":    "PART.1",
    "part-label":     "技术方案",
    "chapter-label":  "2.1 绿化养护服务总体方案",
    "topic-title":    "科学养护体系与质量保障措施",
    "subsection-title": "2.1.1 养护服务体系设计",

    // Card titles (5 text-cards, no more 6th element needed since
    // the template now uses <figure-ref> instead of <component-title>
    // inside the <figures> element)
    "component-title": [
      "养护工作流程体系",
      "季节性养护策略",
      "三级质量检查制度",
      "应急响应与灾害防控",
      "数字化养护管理",
    ],

    // Card 2 image: reference to paired card title
    "figure-ref": "季节性养护策略",

    // Paragraphs (120-160 chars each for perfect fit)
    "paragraph": [
      `本项目建立计划编制、作业实施、质量检查、问题整改、资料归档五阶段闭环养护流程。计划阶段根据植物生长周期和采购人要求编制年度、月度和周度计划；作业阶段按标准操作规程实施修剪、施肥、浇水、除草和病虫害防治；检查阶段通过巡检和抽检确保质量达标。`,
      `绿化养护需根据季节变化调整重点。春季以修剪整形、施肥促长、补植为主；夏季重点抗旱浇水、病虫害防治和防台风加固；秋季进行施肥、树木涂白和防寒准备；冬季实施防寒保暖、冬季修剪和清园消毒。四季各有侧重，确保植物全年健康生长。`,
      `建立班组自检、项目周检、公司月检三级质量检查体系。评分采用百分制，涵盖绿化长势、修剪整形、水肥管理、病虫害防治、卫生保洁和资料管理六大维度。月度考核低于80分为不合格，需限期整改并复检，考核结果与绩效直接挂钩。`,
      `制定台风暴雨、高温干旱、低温冰冻、病虫害爆发四类专项应急预案。配置抽水泵、油锯、支撑杆、遮阳网等应急物资，应急人员按项目分布，30分钟内响应、2小时内到场。灾前全面排查加固，灾后及时恢复，确保养护区域安全。`,
      `依托智慧园林管理平台实现养护作业数字化。平台集成GPS轨迹追踪、电子工单派发、作业拍照上传、病虫害AI识别和养护数据统计分析。管理人员通过App实时查看进度，采购人通过专属账号查询记录，确保养护质量可追溯、管理透明化。`,
    ],

    // Visual: icon-process (5 steps)
    "step-label": ["计划编制", "作业实施", "质量检查", "问题整改", "资料归档"],

    // Visual: timeline (4 stages)
    "stage-number": ["01", "02", "03", "04"],
    "stage-label":  ["班组自检", "项目周检", "公司月检", "年度考评"],

    // Visual: capability-panel (3 items)
    "item-label": ["应急预案", "应急物资", "快速响应"],

    // Visual: org-chart (3 nodes)
    "node-label": ["管理平台", "作业终端", "数据看板"],

    // Summary band
    "summary-text": `本方案以科学化、标准化、数字化为核心，建立覆盖全周期的绿化养护管理体系，通过五阶段闭环流程、四季差异化养护、三级质量检查和智慧化平台支撑，确保养护质量达标、过程可追溯。`,
    "bullet": ["五阶段闭环流程", "四季差异化养护", "三级质量检查", "智慧园林平台"],

    // Image caption
    "image-caption": "园林绿化养护作业场景示意图（AI生成，非项目实景）",
  },
};

// ============================================================================
// Helpers
// ============================================================================

function hr(label = "") {
  console.log(label ? `\n${"=".repeat(60)}` : "-".repeat(60));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  hr();
  console.log("  PPT Generator MCP — 端到端 Demo");
  console.log("  模板 → 6 步 MCP 工具调度 → 可交付页面");
  hr();

  // ── Step 1: list_templates ──────────────────────────────────────
  console.log("\n[1/6] list_templates — 扫描模板库");
  const templates = listTemplates(TEMPLATES_DIR);
  for (const t of templates) {
    console.log(`  ${t.slug}`);
    console.log(`    ${t.name}  |  ${t.usecase.slice(0, 2).join(", ")}`);
  }

  // ── Step 2: load_template ───────────────────────────────────────
  console.log("\n[2/6] load_template — 加载模板并解析占位符");
  // Use the exact slug to target the original text-card-paired template
  const slug = "green-infographic-bid-a4-landscape";
  // Other available templates:
  //   green-infographic-bid-a4-landscape-visual         — 少文字视觉为主
  //   green-infographic-bid-a4-landscape-text-image     — 图文并茂 1:1
  //   green-infographic-bid-a4-landscape-table-image    — 表格+图片
  //   green-infographic-bid-a4-landscape-table-text     — 表格+文字
  //   green-infographic-bid-a4-landscape-table-text-image — 表格+文字+图片
  const tpl = loadTemplate(TEMPLATES_DIR, slug);
  console.log(`  名称: ${tpl.metadata.name}`);
  console.log(`  占位符: ${tpl.placeholders.map((p) => `${p.tag}x${p.count}`).join(", ")}`);
  console.log(`  图标: ${tpl.icons.map((i) => i.name).join(", ")}`);

  // ── Step 3: fill_placeholders ───────────────────────────────────
  console.log("\n[3/6] fill_placeholders — 文生文填充（direct 模式）");

  const llmProvider = process.env.OPENAI_API_KEY
    ? "openai" as const
    : process.env.ANTHROPIC_API_KEY
      ? "anthropic" as const
      : null;

  const fillResult = await fillPlaceholders({
    html: tpl.html,
    content: CONTENT,
    ...(llmProvider
      ? {
          expand: {}, // Placeholder for if we wanted LLM expansion
          llmConfig: {
            provider: llmProvider,
            apiKey: llmProvider === "openai"
              ? process.env.OPENAI_API_KEY!
              : process.env.ANTHROPIC_API_KEY!,
          },
        }
      : {}),
  });

  console.log(`  已填充: ${fillResult.filledCount} 处`);
  if (fillResult.warnings.length > 0) {
    console.log(`  ⚠️  内容警告:`);
    for (const w of fillResult.warnings) console.log(`     ${w}`);
  }
  if (fillResult.remainingPlaceholders.length > 0) {
    console.log(`  待处理: ${fillResult.remainingPlaceholders.join(", ")}`);
  }

  // ── Step 4: Asset slots + Page 2 ───────────────────────────────
  console.log("\n[4/6] insert_asset_slots + build_prompts_page");
  const templateDir = path.dirname(tpl.filePath);

  const { html: layoutHtml, assetMap } = insertAssetSlots({
    html: fillResult.html,
    iconPrompts: [],
    imagePrompts: [],
  });
  const finalHtml = layoutHtml.replace("</body>", buildPromptsPage(assetMap) + "</body>");
  console.log(`  槽位: ${assetMap.filter(a => a.type === "image").length} img + ${assetMap.filter(a => a.type === "icon").length} icon`);

  // ── Step 5: assemble_page ───────────────────────────────────────
  console.log("\n[5/6] assemble_page — 组装两页交付件");
  const outputPath = path.join(OUTPUT_DIR, "deliverable-page-1.html");

  const assembleResult = assemblePage({
    html: finalHtml,
    config: {
      removeXmlComment: true,
      minifyOutput: false,
      outputPath,
      templateDir,
    },
  });

  console.log(`  输出: ${assembleResult.outputPath}`);
  if (assembleResult.warnings.length > 0) {
    for (const w of assembleResult.warnings) console.log(`  ⚠️  ${w}`);
  }

  // ── Step 7: validate_page ───────────────────────────────────────
  console.log("\n[6/6] validate_page — 质量验证");
  const validateResult = validatePage({
    html: assembleResult.html,
    htmlFilePath: assembleResult.outputPath,
    checks: ["no-xml-tags", "all-icons-rendered", "valid-html"],
  });

  if (validateResult.valid) {
    console.log("  验证通过 — 无残留占位符，HTML 合法");
  } else {
    console.log("  验证未通过:");
    for (const issue of validateResult.issues) {
      console.log(`  ❌ [${issue.type}] ${issue.message}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  hr();
  console.log("  编排层标准调度流程（6 个 MCP 原子工具）:\n");
  console.log("  1. list_templates      浏览模板库，按 usecase/format 选模板");
  console.log("  2. load_template       加载 HTML + 解析占位符清单");
  console.log("  3. fill_placeholders   文生文填充（direct 替换 / LLM 扩写）");
  console.log("  4. insert_asset_slots  <icon>/<figures> → 带ID占位框(Page1)");
  console.log("  5. build_prompts_page  生成提示词参考表(Page2) + 组装");
  console.log("  6. validate_page       检查残留 XML、HTML 合法性");
  hr(`\n  可交付页面: ${outputPath}`);
}

main().catch((err) => {
  console.error("Demo 失败:", err);
  process.exit(1);
});
