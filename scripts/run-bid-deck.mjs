#!/usr/bin/env node
/**
 * 一键标书交付件生成工作流
 * ─────────────────────────────────────────────────────────────
 * 用途：把一个已分页的中文标书正文（<page N> 协议）完整转成可交付的
 *       A4 横向 HTML 类 PPT 页，并通过真实 MCP server 全程 QA。
 *
 * 流程：
 *   1. 启动 dist/src/server.js（stdio MCP server）
 *   2. plan_deck            —— 固化计划、模板、图片提示词
 *   3. 生成本地配图（无图片 API 时的占位方案）
 *   4. generate_deck        —— 注入素材、逐页 QA、整套一致性
 *   5. get_deck / 读盘      —— 取回 final.html / quality / consistency
 *   6. 整理交付件到输出目录
 *
 * 用法：
 *   node scripts/run-bid-deck.mjs [正文路径] [输出目录] [requestId前缀]
 *   例：node scripts/run-bid-deck.mjs test.md output/deliverables/my-bid bid-20260802
 *
 * 环境：Node 22+，已执行 npm run build 且 npx playwright install chromium
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = join(ROOT, "dist", "src", "server.js");

const sourcePath = resolve(process.argv[2] ?? join(ROOT, "test.md"));
const outDir = resolve(process.argv[3] ?? join(ROOT, "output", "deliverables", `bid-${Date.now()}`));
const requestIdPrefix = process.argv[4] ?? "bid-deck";

function fatal(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

async function generateThemedImage(promptText, pageNumber, assetId) {
  // 无图片 API 时的占位配图：渲染一个与标书主题一致的商务示意图。
  // 真实部署时，这一步应由 Agent 用其文生图能力替换。
  const short = promptText.slice(0, 40).replace(/["\\]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1792" height="1024">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0e5a2d"/><stop offset="0.55" stop-color="#2f8a4a"/><stop offset="1" stop-color="#7ec48f"/>
      </linearGradient>
      <pattern id="grid" width="90" height="90" patternUnits="userSpaceOnUse">
        <path d="M0 90 H90 M90 0 V90" stroke="rgba(255,255,255,0.07)" stroke-width="2"/>
      </pattern>
    </defs>
    <rect width="1792" height="1024" fill="url(#g)"/>
    <rect width="1792" height="1024" fill="url(#grid)"/>
    <circle cx="1420" cy="250" r="210" fill="rgba(255,255,255,0.10)"/>
    <circle cx="1560" cy="820" r="150" fill="rgba(255,255,255,0.08)"/>
    <rect x="120" y="150" width="8" height="720" rx="4" fill="rgba(255,255,255,0.55)"/>
    <rect x="170" y="330" width="360" height="30" rx="15" fill="rgba(255,255,255,0.85)"/>
    <rect x="170" y="400" width="540" height="22" rx="11" fill="rgba(255,255,255,0.45)"/>
    <rect x="170" y="450" width="500" height="22" rx="11" fill="rgba(255,255,255,0.45)"/>
    <rect x="170" y="500" width="520" height="22" rx="11" fill="rgba(255,255,255,0.45)"/>
    <text x="170" y="260" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="34" fill="rgba(255,255,255,0.92)">P${pageNumber} · ${assetId}</text>
    <text x="170" y="640" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="24" fill="rgba(255,255,255,0.7)">${short}</text>
  </svg>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1792, height: 1024 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    const png = await page.screenshot({ type: "png" });
    return `data:image/png;base64,${png.toString("base64")}`;
  } finally {
    await browser.close();
  }
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content ?? result).slice(0, 600)}`);
  }
  // 数据在 structuredContent；旧式工具回退解析 text JSON。
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  if (!existsSync(SERVER)) fatal(`未找到已构建的 server：${SERVER}，请先运行 npm run build`);
  if (!existsSync(sourcePath)) fatal(`正文文件不存在：${sourcePath}`);

  const sourceText = await readFile(sourcePath, "utf8");
  const pageNumbers = [...sourceText.matchAll(/<page (\d+)>/g)].map((m) => Number(m[1]));
  if (pageNumbers.length === 0) fatal("正文中没有 <page N> 分页标记，请先按协议分页。");
  console.log(`📄 正文 ${sourcePath}：${pageNumbers.length} 页 (${pageNumbers.join(", ")})`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    cwd: ROOT,
    env: { ...process.env, PPT_OUTPUT_ROOT: join(ROOT, "output", "runs") },
  });
  const client = new Client({ name: "bid-deck-driver", version: "1.0.0" });
  await client.connect(transport);
  console.log("🔌 已连接 MCP server（stdio）");

  try {
    // 1) plan_deck
    console.log("① plan_deck ...");
    const plan = await callTool(client, "plan_deck", {
      sourceText,
      pageNumbers,
      documentType: "bid",
      templateDiversity: "balanced",
      preferredThemeId: "green-infographic-v1",
      requestId: `${requestIdPrefix}-plan`,
      quality: { minScore: 80, maxAttempts: 3 },
    });
    const deckPlanId = plan.plannedDeck?.deckPlanId ?? plan.plannedDeck?.id;
    const slides = plan.plannedDeck?.slides ?? [];
    console.log(`   deckPlanId=${deckPlanId} | 计划 ${slides.length} 页，需要配图 ${plan.assets?.length ?? 0} 张`);
    for (const s of slides) {
      console.log(`   - 页 ${s.page.number} 模板=${s.templateSlug.split("landscape")[1] || "(base)"} 配图=${s.plannedSpec.assets.length}`);
    }

    // 2) 生成本地配图
    const externalAssets = [];
    if ((plan.assets ?? []).length > 0) {
      console.log("② 生成配图 ...");
      for (const asset of plan.assets) {
        const pageNum = asset.id.match(/p(\d+)-/)?.[1] ?? "?";
        console.log(`   - ${asset.id} (页 ${pageNum})`);
        const dataUrl = await generateThemedImage(asset.prompt, pageNum, asset.id);
        externalAssets.push({ id: asset.id, dataUrl });
      }
    } else {
      console.log("② 无配图需求，跳过");
    }

    // 3) generate_deck（处理 needs_assets 恢复）
    console.log("③ generate_deck ...");
    let run = await callTool(client, "generate_deck", {
      deckPlanId,
      externalAssets,
      requestId: `${requestIdPrefix}-run`,
    });
    let guard = 0;
    while (run.status === "needs_assets" && guard < 3) {
      const missing = run.missingAssetIds ?? [];
      console.log(`   needs_assets，补齐 ${missing.length} 张后再试`);
      const missingAssets = (plan.assets ?? []).filter((a) => missing.includes(a.id));
      const extra = [];
      for (const asset of missingAssets) {
        const pageNum = asset.id.match(/p(\d+)-/)?.[1] ?? "?";
        extra.push({ id: asset.id, dataUrl: await generateThemedImage(asset.prompt, pageNum, asset.id) });
      }
      run = await callTool(client, "generate_deck", { deckPlanId, externalAssets: [...externalAssets, ...extra], requestId: `${requestIdPrefix}-run` });
      guard += 1;
    }
    if (run.status !== "delivered") {
      for (const p of run.pages ?? []) {
        if (p.status !== "delivered") console.log(`   ⚠ 页 ${p.pageNumber} ${p.status}${p.error ? `：${p.error.message ?? JSON.stringify(p.error)}` : ""}`);
      }
      fatal(`deck 状态为 ${run.status}，未能交付`);
    }
    console.log(`   deck 状态：delivered (${run.pages?.length ?? 0} 页)`);

    // 4) 取回交付件（final.html 较大，直接读输出目录；quality/consistency 走 get_deck）
    await mkdir(outDir, { recursive: true });
    const runsRoot = join(ROOT, "output", "runs");
    const delivered = [];
    for (const p of run.pages) {
      const runId = p.runId;
      const tpl = ((p.selectedTemplate?.slug ?? "").split("landscape")[1] || "-base").replace(/^-/, "");
      const srcHtml = join(runsRoot, runId, "final.html");
      if (existsSync(srcHtml)) {
        const destHtml = join(outDir, `page-${p.pageNumber}-${tpl}.html`);
        await cp(srcHtml, destHtml);
      }
      // quality.json 走 get_deck 白名单接口验证
      let quality;
      try { quality = await callTool(client, "get_deck", { id: runId, view: "artifact", artifact: "quality.json" }); } catch { /* 读盘兜底 */ }
      const srcQuality = join(runsRoot, runId, "quality.json");
      if (existsSync(srcQuality)) await cp(srcQuality, join(outDir, `page-${p.pageNumber}-quality.json`));
      const score = p.quality?.score ?? quality?.result?.data?.score ?? "?";
      delivered.push({ pageNumber: p.pageNumber, template: tpl, score });
      console.log(`   - 页 ${p.pageNumber} ${tpl} 已交付 score=${score}`);
    }

    // 整套一致性
    try {
      const consistency = await callTool(client, "get_deck", { id: run.deckRunId, view: "artifact", artifact: "consistency.json" });
      await writeFile(join(outDir, "deck-consistency.json"), JSON.stringify(consistency.result?.data ?? consistency, null, 2));
      console.log(`④ 整套一致性：${JSON.stringify(consistency.result?.data?.passed ?? "?")}`);
    } catch (e) {
      console.log(`④ 一致性读取跳过：${e.message.slice(0, 80)}`);
    }

    await writeFile(join(outDir, "delivery-manifest.json"), JSON.stringify({
      source: sourcePath,
      deckPlanId,
      deckRunId: run.deckRunId,
      pageNumbers,
      delivered,
      generatedAt: new Date().toISOString(),
    }, null, 2));

    console.log(`\n✅ 交付件已生成：${outDir}`);
    console.log("   页面：", delivered.map((d) => `page-${d.pageNumber}-${d.template}.html`).join(", "));
    console.log("   说明：配图为无 API 时的主题占位图；正式交付请让 Agent 用其文生图能力替换。");
  } finally {
    await client.close();
  }
}

main().catch((error) => fatal(error.message));
