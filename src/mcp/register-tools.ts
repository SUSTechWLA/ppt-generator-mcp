import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { generateSlideOutputSchema } from "../domain/quality-report.js";
import { generateSlideInputSchema } from "../domain/source-document.js";
import { slideSpecSchema } from "../domain/slide-spec.js";
import { validateFactReferences } from "../services/slide-spec-builder.js";
import type { WorkflowDependencies } from "../workflow/generate-slide.js";
import { generateSlideWorkflow } from "../workflow/generate-slide.js";
import { listTemplates, loadTemplate } from "../lib/template-parser.js";
import { fillPlaceholders } from "../tools/fill-placeholders.js";
import { renderIcons } from "../tools/render-icons.js";
import { assemblePage } from "../tools/assemble-page.js";
import { validatePage } from "../tools/validate-page.js";
import { generateImages, generateSingleImage } from "../tools/generate-image.js";
import { parseSourceContent } from "../tools/parse-source-content.js";
import { insertAssetSlots } from "../tools/insert-asset-slots.js";
import { safeTool, toJsonToolResult, toToolResult } from "./tool-result.js";

export interface PptMcpDependencies extends WorkflowDependencies {
  templatesDir?: string;
}

const planSlideOutputSchema = z.object({
  sourceHash: z.string(),
  facts: z.array(z.object({ id: z.string(), text: z.string(), kind: z.string(), sourceSectionId: z.string() })),
  plannedSpec: slideSpecSchema,
  selectedTemplate: z.object({ slug: z.string(), score: z.number(), reason: z.string() }),
  assets: z.array(z.object({ id: z.string(), type: z.string(), prompt: z.string(), alt: z.string(), width: z.number(), height: z.number() })),
  nextStep: z.string(),
}).strict();

const directContentSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const llmConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  apiKey: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
}).strict();

export function createPptMcpServer(dependencies: PptMcpDependencies): McpServer {
  const server = new McpServer({ name: "ppt-generator-mcp", version: "2.0.0" });
  const templatesDir = resolve(dependencies.templatesDir ?? "templates");

  server.registerTool("plan_slide", {
    title: "Plan one quality-gated slide",
    description: "分析中文正文并返回事实约束、SlideSpec、已批准模板和稳定的图片提示词。Agent 应先调用本工具，再用 imagegen 生成图片，最后调用 generate_slide。",
    inputSchema: generateSlideInputSchema,
    outputSchema: planSlideOutputSchema,
  }, async (input) => safeTool(async () => {
    const source = dependencies.normalizeSource(input);
    const spec = input.plannedSpec ?? await dependencies.buildSlideSpec(source, input.audience);
    validateFactReferences(source, spec);
    const selection = dependencies.selectTemplate(spec, input.templateSlug, input.documentType);
    const output = {
      sourceHash: source.sourceHash,
      facts: source.facts,
      plannedSpec: spec,
      selectedTemplate: { slug: selection.slug, score: selection.score, reason: selection.reason },
      assets: spec.assets.map(({ id, type, prompt, alt, width, height }) => ({ id, type, prompt, alt, width, height })),
      nextStep: "用 Agent imagegen 按 assets.prompt 生成图片；将图片转为 data URL，并连同 plannedSpec 传给 generate_slide.externalAssets。",
    };
    return toToolResult(output, `已规划 ${spec.blocks.length} 个内容模块和 ${spec.assets.length} 个资产；推荐模板 ${selection.slug}。`);
  }));

  server.registerTool("generate_slide", {
    title: "Generate quality-gated slide",
    description: "将中文商务正文生成带真实图片的单页 A4 横向 HTML，执行浏览器 QA 与最多三轮定向修复。无图片 API 时传 plannedSpec 和 externalAssets。",
    inputSchema: generateSlideInputSchema,
    outputSchema: generateSlideOutputSchema,
  }, async (input) => safeTool(async () => {
    const result = await generateSlideWorkflow(input, dependencies);
    return toToolResult(result, `${result.status}: ${result.summary} 交付件 ${result.artifacts.htmlPath}`);
  }));

  server.registerTool("get_run", {
    title: "Get slide run",
    description: "读取指定 runId 的脱敏 manifest、阶段状态、尝试记录和产物路径。",
    inputSchema: { runId: z.string().uuid() },
  }, async ({ runId }) => safeTool(async () => toJsonToolResult(await dependencies.runStore.getRun(runId))));

  server.registerTool("get_artifact", {
    title: "Get slide artifact",
    description: "读取运行目录中的闭集产物；小型 HTML/JSON 返回文本，大型或 PNG 返回安全路径和大小。",
    inputSchema: {
      runId: z.string().uuid(),
      artifactName: z.enum(["manifest.json", "final.html", "final.png", "quality.json"]),
    },
  }, async ({ runId, artifactName }) => safeTool(async () => toJsonToolResult(await dependencies.runStore.getArtifact(runId, artifactName))));

  server.registerTool("evaluate_slide", {
    title: "Read selected slide quality",
    description: "读取已生成运行的最终 quality.json；页面生成时已完成真实 Chromium 硬门禁与六维评分。",
    inputSchema: { runId: z.string().uuid() },
  }, async ({ runId }) => safeTool(async () => {
    const artifact = await dependencies.runStore.getArtifact(runId, "quality.json");
    return toJsonToolResult(artifact.text ? JSON.parse(artifact.text) : artifact);
  }));

  server.registerTool("list_templates", {
    description: "列出模板库中的 HTML 模板元数据。",
    inputSchema: { templatesDir: z.string().optional() },
  }, async ({ templatesDir: customDir }) => safeTool(() => toJsonToolResult({ templates: listTemplates(customDir ? resolve(customDir) : templatesDir) })));

  server.registerTool("load_template", {
    description: "加载指定模板及其占位符、图标和 HTML。",
    inputSchema: { slug: z.string(), templatesDir: z.string().optional() },
  }, async ({ slug, templatesDir: customDir }) => safeTool(() => toJsonToolResult(loadTemplate(customDir ? resolve(customDir) : templatesDir, slug))));

  server.registerTool("fill_placeholders", {
    description: "兼容原子工具：用文本节点安全填充模板占位符。高层交付请优先 generate_slide。",
    inputSchema: {
      html: z.string(),
      content: z.object({ direct: directContentSchema.optional(), expand: z.record(z.string(), z.array(z.object({ index: z.number().int().optional(), keyPoints: z.array(z.string()), style: z.string().optional() }).strict())).optional() }).strict(),
      llmConfig: llmConfigSchema.optional(),
    },
  }, async (input) => safeTool(async () => toJsonToolResult(await fillPlaceholders(input))));

  server.registerTool("insert_asset_slots", {
    description: "兼容原子工具：将 figures/icon 转为带 ID 的资产槽位。高层 Agent workflow 请优先 plan_slide。",
    inputSchema: {
      html: z.string(),
      iconPrompts: z.array(z.object({ position: z.string(), description: z.string(), prompt: z.string() }).strict()),
      imagePrompts: z.array(z.object({ sectionTitle: z.string(), prompt: z.string() }).strict()),
    },
  }, async (input) => safeTool(() => toJsonToolResult(insertAssetSlots(input))));

  server.registerTool("render_icons", {
    description: "兼容原子工具：将 icon 标签替换为本地 SVG 图片。",
    inputSchema: { html: z.string(), iconBasePath: z.string(), iconsRelativePath: z.string().optional() },
  }, async (input) => safeTool(() => toJsonToolResult(renderIcons(input))));

  server.registerTool("assemble_page", {
    description: "兼容原子工具：组装、内联 CSS 并写出 HTML。",
    inputSchema: { html: z.string(), config: z.object({ removeXmlComment: z.boolean().optional(), minifyOutput: z.boolean().optional(), inlineCss: z.boolean().optional(), outputPath: z.string().optional(), linkedCssPath: z.string().optional(), templateDir: z.string().optional() }).strict() },
  }, async (input) => safeTool(() => toJsonToolResult(assemblePage(input))));

  server.registerTool("validate_page", {
    description: "兼容原子工具：执行静态页面校验。完整 QA 请使用 generate_slide。",
    inputSchema: {
      html: z.string(),
      htmlFilePath: z.string().optional(),
      checks: z.array(z.enum(["no-xml-tags", "all-icons-rendered", "all-images-exist", "valid-html"])).default(["no-xml-tags", "all-icons-rendered", "valid-html"]),
    },
  }, async (input) => safeTool(() => toJsonToolResult(validatePage(input))));

  server.registerTool("parse_source_content", {
    description: "兼容原子工具：将 Markdown 解析为旧版模板 direct content。新 workflow 请使用 plan_slide。",
    inputSchema: { sourceText: z.string(), templateSlug: z.string().optional(), mode: z.enum(["direct", "llm"]).default("direct"), llmConfig: llmConfigSchema.optional() },
  }, async (input) => safeTool(async () => toJsonToolResult(await parseSourceContent(input))));

  server.registerTool("generate_image", {
    description: "旧版兼容图片工具。新 workflow 在无 API 时应由 Agent 使用 imagegen，并向 generate_slide 传 externalAssets。",
    inputSchema: {
      html: z.string().optional(),
      prompt: z.string().optional(),
      imageConfig: z.object({ apiKey: z.string(), baseUrl: z.string().optional(), model: z.string().optional() }).strict(),
      outputDir: z.string(),
      outputUrlPrefix: z.string().optional(),
    },
  }, async ({ html, prompt, imageConfig, outputDir, outputUrlPrefix }) => safeTool(async () => {
    if (prompt && !html) return toJsonToolResult(await generateSingleImage(imageConfig, prompt, outputDir));
    if (html) return toJsonToolResult(await generateImages({ html, imageConfig, outputDir, outputUrlPrefix }));
    throw new Error("Either html or prompt must be provided");
  }));

  return server;
}
