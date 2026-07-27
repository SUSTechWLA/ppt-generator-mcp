/**
 * QA Test: Generate and validate deliverables from all 6 templates.
 *
 * Usage:
 *   npx tsx tests/test-all-templates.ts
 *   ENABLE_IMAGE_GEN=1 npx tsx tests/test-all-templates.ts  # with DALL-E
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listTemplates, loadTemplate } from "../src/lib/template-parser.js";
import { fillPlaceholders } from "../src/tools/fill-placeholders.js";
import { renderIcons } from "../src/tools/render-icons.js";
import { assemblePage } from "../src/tools/assemble-page.js";
import { validatePage } from "../src/tools/validate-page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "qa-test");

// ============================================================================
// Generic content factory — generates suitable content for any template
// ============================================================================

function makeContent(template: ReturnType<typeof loadTemplate>) {
  const hasTag = (tag: string) => template.placeholders.some((p) => p.tag === tag);
  const count = (tag: string) => template.placeholders.find((p) => p.tag === tag)?.count || 0;
  const slug = template.slug;

  const direct: Record<string, string | string[]> = {
    "page-title": "第1页 | 绿化养护服务方案",
    "page-number": "1",
    "section-title": "第二章：服务方案与技术措施",
    "part-number": "PART.1",
    "part-label": "技术方案",
    "chapter-label": "2.1 绿化养护服务总体方案",
    "topic-title": "科学养护体系与质量保障措施",
    "subsection-title": "2.1.1 养护服务体系设计",
  };

  // Fill component-title based on template type
  if (hasTag("component-title")) {
    const n = count("component-title");
    const titles = ["养护工作流程", "季节性养护策略", "三级质量检查", "应急响应机制", "数字化管理"];
    direct["component-title"] = titles.slice(0, n);
  }

  if (hasTag("figure-ref")) {
    const n = count("figure-ref");
    const titles = (direct["component-title"] as string[]) || [];
    // Use matching card titles, or fall back to generic
    direct["figure-ref"] = n <= 1
      ? (titles[1] || titles[0] || "核心场景")
      : titles.slice(0, n);
  }

  if (hasTag("paragraph")) {
    const n = count("paragraph");
    const paras = [
      `本项目建立计划编制、作业实施、质量检查、问题整改、资料归档五阶段闭环养护流程。各阶段按标准操作规程执行，确保养护任务有序推进、质量可追溯。`,
      `绿化养护需根据季节变化调整重点。春季修剪施肥补植，夏季抗旱防台，秋季施肥涂白防寒，冬季修剪保暖消毒。四季各有侧重，确保植物全年健康。`,
      `建立班组自检、项目周检、公司月检三级质量体系。评分涵盖长势、修剪、水肥、病虫害、保洁、资料六大维度，月度考核低于80分需整改复检。`,
      `制定台风暴雨、高温干旱、低温冰冻、病虫害四类应急预案。配置抽水泵、油锯等物资，30分钟内响应、2小时内到场，灾前排查灾后恢复。`,
      `依托智慧园林平台实现数字化管理，集成GPS追踪、电子工单、AI病虫害识别和数据统计分析，确保养护质量可追溯、管理透明化。`,
      `以上措施共同构成本项目绿化养护服务的完整体系，各环节协同配合，确保服务质量满足采购人要求。`,
    ];
    direct["paragraph"] = paras.slice(0, n);
  }

  if (hasTag("step-label")) {
    direct["step-label"] = ["计划编制", "作业实施", "质量检查", "问题整改", "资料归档"];
  }
  if (hasTag("stage-number")) {
    direct["stage-number"] = ["01", "02", "03", "04"];
  }
  if (hasTag("stage-label")) {
    direct["stage-label"] = ["班组自检", "项目周检", "公司月检", "年度考评"];
  }
  if (hasTag("item-label")) {
    const n = count("item-label");
    direct["item-label"] = ["应急预案", "应急物资", "快速响应", "专业团队"].slice(0, n);
  }
  if (hasTag("node-label")) {
    const n = count("node-label");
    direct["node-label"] = ["管理平台", "作业终端", "数据看板"].slice(0, n);
  }
  if (hasTag("summary-text")) {
    direct["summary-text"] = `本方案以科学化、标准化、数字化为核心，建立覆盖全周期的养护管理体系。`;
  }
  if (hasTag("bullet")) {
    const n = count("bullet");
    const allBullets = [
      "全周期闭环管理", "四季差异化养护", "三级质量检查", "智慧园林平台",
      "标准化作业流程", "数字化管理系统", "应急响应机制",
    ];
    direct["bullet"] = allBullets.slice(0, n);
  }
  if (hasTag("image-caption")) {
    direct["image-caption"] = "园林绿化养护场景示意图（AI生成，非项目实景）";
  }

  // Table content
  if (hasTag("table-header")) {
    const n = count("table-header");
    direct["table-header"] = ["指标项", "分值", "评分标准", "得分"].slice(0, n);
  }
  if (hasTag("table-cell")) {
    const cells = [
      "绿化长势", "25", "植物生长健壮，无枯死缺株", "—",
      "修剪整形", "20", "修剪规范，树形美观", "—",
      "水肥管理", "15", "浇水施肥及时适量", "—",
      "病虫害防治", "15", "防治及时，无严重危害", "—",
      "卫生保洁", "15", "绿地整洁，无杂草垃圾", "—",
      "资料管理", "10", "台账齐全，记录完整", "—",
    ];
    direct["table-cell"] = cells.slice(0, count("table-cell"));
  }

  return { direct };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("  QA Test — 全模板生成验证");
  console.log("=".repeat(60));

  const { JSDOM } = await import("jsdom");
  const templates = listTemplates(TEMPLATES_DIR);
  const results: Array<{ slug: string; valid: boolean; issues: number; warnings: string[] }> = [];

  for (const tpl of templates) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`  📄 ${tpl.slug}`);
    console.log(`     ${tpl.name}`);

    try {
      // Step 1: Load
      const parsed = loadTemplate(TEMPLATES_DIR, tpl.slug);
      console.log(`     占位符: ${parsed.placeholders.length} 种 / ${parsed.placeholders.reduce((s,p)=>s+p.count,0)} 处`);

      // Step 2: Fill
      const content = makeContent(parsed);
      const filled = await fillPlaceholders({ html: parsed.html, content });
      console.log(`     填充: ${filled.filledCount} 处` + (filled.warnings.length ? ` ⚠️ ${filled.warnings.length} 警告` : ""));

      // Step 3: Icons
      const templateDir = path.dirname(parsed.filePath);
      const iconBase = path.join(templateDir, "assets", "icons");
      const iconsDone = renderIcons({
        html: filled.html,
        iconBasePath: iconBase,
        iconsRelativePath: `../../templates/green-infographic/assets/icons/`,
      });
      if (iconsDone.iconCount > 0) console.log(`     图标: ${iconsDone.iconCount} 个`);

      // Step 4: Images
      const imgDom = new JSDOM(iconsDone.html);
      const imgDoc = imgDom.window.document;
      const figuresList = imgDoc.querySelectorAll("figures");
      for (let i = 0; i < figuresList.length; i++) {
        const el = figuresList[i];
        const prompt = el.textContent?.trim() || "AI生成场景图";
        const placeholder = imgDoc.createElement("div");
        placeholder.setAttribute("class", "placeholder-card");
        placeholder.innerHTML = `<strong>AI 生成配图</strong><span>${prompt.slice(0, 60)}...</span>`;
        el.replaceWith(placeholder);
        // Clean figure-ref residuals
        const parent = el.parentElement;
        const ref = parent?.querySelector("figure-ref");
        if (ref) ref.replaceWith(imgDoc.createTextNode(ref.textContent || ""));
      }
      const imageHtml = imgDom.serialize();
      if (figuresList.length > 0) console.log(`     图片: ${figuresList.length} 个占位符`);

      // Step 5: Assemble
      const outPath = path.join(OUTPUT_DIR, `${tpl.slug}.html`);
      const assembled = assemblePage({
        html: imageHtml,
        config: {
          removeXmlComment: true,
          outputPath: outPath,
          templateDir,
        },
      });
      if (assembled.warnings.length) {
        for (const w of assembled.warnings) console.log(`     ⚠️  ${w}`);
      }

      // Step 6: Validate
      const validated = validatePage({
        html: assembled.html,
        htmlFilePath: outPath,
        checks: ["no-xml-tags", "all-icons-rendered", "valid-html"],
      });

      const ok = validated.valid && assembled.warnings.length === 0;
      console.log(`     结果: ${ok ? "✅ 通过" : "❌ 有问题"}`);
      for (const issue of validated.issues) {
        console.log(`       [${issue.type}] ${issue.message}`);
      }

      results.push({
        slug: tpl.slug,
        valid: ok,
        issues: validated.issues.length,
        warnings: assembled.warnings,
      });
    } catch (err) {
      console.log(`     ❌ 异常: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        slug: tpl.slug,
        valid: false,
        issues: 1,
        warnings: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  // ── Summary ──
  console.log(`\n${"=".repeat(60)}`);
  console.log("  QA 结果汇总");
  console.log("=".repeat(60));
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.valid) { pass++; console.log(`  ✅ ${r.slug}`); }
    else { fail++; console.log(`  ❌ ${r.slug} — ${r.issues} 问题`); }
  }
  console.log(`\n  通过: ${pass}/${results.length}  失败: ${fail}/${results.length}`);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
