import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProductionDependencies } from "../src/app.js";
import { loadAppConfig } from "../src/config/env.js";
import { createPptMcpServer } from "../src/mcp/register-tools.js";
import type { SlideSpec } from "../src/domain/slide-spec.js";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceText = await readFile(join(projectRoot, "test.md"), "utf8");
const imagePath = join(projectRoot, "examples", "assets", "personnel-coordination.png");
const image = await readFile(imagePath);

const imagePrompt = "Create a premium, photorealistic horizontal editorial photograph for a Chinese procurement proposal slide about landscape-maintenance personnel coordination. Scene: a capable Chinese project coordinator in a modern, bright operations office reviewing a large site map and a daily staffing plan with two uniformed landscape-maintenance team leaders; through a glass wall, a well-maintained residential garden with mature trees and trimmed shrubs is visible. The mood is calm, accountable, organized, and credible—not theatrical. Composition should leave some clean darker green negative space toward the left edge for slide integration, while the people and map occupy the center-right. Natural daylight, realistic skin and hands, documentary corporate photography, deep forest green, jade, paper white, and a restrained warm-gold accent. Wide 16:9 composition, high detail, professional bid-document quality. No readable text, no numbers, no logos, no brand marks, no watermark, no presentation frame, no UI, no exaggerated stock-photo smiles.";

const plannedSpec: SlideSpec = {
  title: "项目人员配备要求响应",
  eyebrow: "人员配置与履约保障",
  conclusion: "以1名固定对接为窗口、8个项目动态调配为弹性、书面审批为边界，确保人员稳定与服务连续。",
  blocks: [
    {
      id: "block-1",
      type: "text",
      title: "固定窗口",
      body: "配置1名专职项目对接人员，作为采购人与各作业班组之间的唯一信息窗口，统一承担指令传达、进度汇总、问题反馈与台账归档。",
      bullets: ["唯一对接窗口", "覆盖8个物业项目", "日报与台账闭环"],
      metrics: [{ label: "固定对接", value: "1名" }, { label: "服务覆盖", value: "8个项目" }],
      sourceFactIds: ["fact-1", "fact-4", "fact-7", "fact-10", "fact-12"],
    },
    {
      id: "block-2",
      type: "process",
      title: "动态调配",
      body: "按基础配置、季节变化和任务驱动三层机制统筹人员；临时指令触发后，从邻近项目或机动班组调集匹配技能人员。",
      bullets: ["30分钟内启动", "1小时内到场", "邻近与机动班组支援"],
      metrics: [{ label: "启动时限", value: "30分钟" }, { label: "到场时限", value: "1小时" }],
      sourceFactIds: ["fact-18", "fact-19", "fact-24", "fact-30", "fact-32", "fact-33"],
    },
    {
      id: "block-3",
      type: "process",
      title: "有序变更",
      body: "项目对接人员原则上不得随意变更；确需更换时，须提交书面申请，经采购人审核同意后执行，并完成充分岗位交接。",
      bullets: ["书面提出申请", "采购人审核同意", "不少于5个工作日交接"],
      metrics: [{ label: "岗位交接", value: "不少于5个工作日" }],
      sourceFactIds: ["fact-2", "fact-47", "fact-48", "fact-49", "fact-50"],
    },
  ],
  assets: [{
    id: "img-001",
    type: "image",
    blockId: "block-1",
    prompt: imagePrompt,
    alt: "项目对接人员与园林养护班组共同复核场地与人员计划",
    sourceFactIds: ["fact-4", "fact-18"],
    width: 1792,
    height: 1024,
  }],
  sourceFactIds: ["fact-1", "fact-2", "fact-4", "fact-7", "fact-18", "fact-32", "fact-47", "fact-49", "fact-50"],
  designIntent: { tone: "professional", density: "medium", visualRatio: 0.42 },
};

const config = loadAppConfig({
  PPT_OUTPUT_ROOT: join(projectRoot, "output", "runs"),
});
const dependencies = createProductionDependencies(config, { templatesDir: join(projectRoot, "templates") });
const server = createPptMcpServer(dependencies);
const client = new Client({ name: "real-imagegen-delivery", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const baseInput = {
    sourceText,
    plannedSpec,
    templateSlug: "green-infographic-bid-a4-landscape-visual",
    audience: "采购评审专家",
    quality: { minScore: 85, maxAttempts: 3 },
  };
  const plan = await client.callTool({ name: "plan_slide", arguments: baseInput });
  if (plan.isError) throw new Error(JSON.stringify(plan.content));

  const generated = await client.callTool({
    name: "generate_slide",
    arguments: {
      ...baseInput,
      requestId: "personnel-response-deliverable-v4",
      externalAssets: [{ id: "img-001", dataUrl: `data:image/png;base64,${image.toString("base64")}` }],
    },
  });
  if (generated.isError) throw new Error(JSON.stringify(generated.content));
  const planSummary = plan.structuredContent as { sourceHash?: string; selectedTemplate?: unknown; assets?: unknown } | undefined;
  process.stdout.write(`${JSON.stringify({
    plan: {
      sourceHash: planSummary?.sourceHash,
      selectedTemplate: planSummary?.selectedTemplate,
      assets: planSummary?.assets,
    },
    result: generated.structuredContent,
  }, null, 2)}\n`);
} finally {
  await client.close();
  await server.close();
}
