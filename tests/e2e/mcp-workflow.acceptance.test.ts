import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProductionDependencies } from "../../src/app.js";
import { loadAppConfig } from "../../src/config/env.js";
import { createPptMcpServer } from "../../src/mcp/register-tools.js";

const markdownInput = {
  sourceText: "# 服务方案\n\n## 响应机制\n项目必须在30分钟内响应，并覆盖8个服务点。",
  quality: { minScore: 85, maxAttempts: 1 },
};
const sectionsInput = {
  sections: [{ heading: "响应机制", body: "项目必须在30分钟内响应，并覆盖8个服务点。", keyPoints: ["快速响应"] }],
  quality: { minScore: 85, maxAttempts: 1 },
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1792" height="1024" viewBox="0 0 1792 1024"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#0b3f29"/><stop offset="1" stop-color="#dcead8"/></linearGradient></defs><rect width="1792" height="1024" fill="url(#g)"/><circle cx="1230" cy="380" r="180" fill="#f7f8f3" opacity=".82"/><path d="M760 720c190-260 430-280 720-80" fill="none" stroke="#c29d52" stroke-width="46"/></svg>`;
const externalDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

test("Markdown and sections both complete the Agent-mediated MCP workflow", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "ppt-acceptance-"));
  const config = loadAppConfig({ PPT_OUTPUT_ROOT: outputRoot });
  const dependencies = createProductionDependencies(config, { templatesDir: resolve("templates") });
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "acceptance", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  for (const [index, input] of [markdownInput, sectionsInput].entries()) {
    const plan = await client.callTool({ name: "plan_slide", arguments: input });
    assert.equal(plan.isError, undefined, JSON.stringify(plan.content));
    const planned = plan.structuredContent as { plannedSpec: unknown; selectedTemplate: { slug: string }; assets: Array<{ id: string }> };
    const generated = await client.callTool({
      name: "generate_slide",
      arguments: {
        ...input,
        plannedSpec: planned.plannedSpec,
        templateSlug: planned.selectedTemplate.slug,
        externalAssets: [{ id: planned.assets[0].id, dataUrl: externalDataUrl }],
        requestId: `acceptance-agent-${index + 1}`,
      },
    });
    assert.equal(generated.isError, undefined, JSON.stringify(generated.content));
    const result = generated.structuredContent as { status: string; quality: { score: number; hardGatePassed: boolean }; artifacts: { htmlPath: string; manifestPath: string } };
    assert.equal(result.status, "delivered");
    assert.ok(result.quality.score >= 85);
    assert.equal(result.quality.hardGatePassed, true);
    const html = await readFile(result.artifacts.htmlPath, "utf8");
    assert.equal((html.match(/data-slide-page=/g) ?? []).length, 1);
    assert.match(html, /data:image\/(?:png|jpeg|webp|svg\+xml)/);
    assert.doesNotMatch(html, /<figures|<icon|img-slot|prompt reference/i);
    assert.doesNotMatch(html, /<script|https?:\/\//i);
    const manifest = await readFile(result.artifacts.manifestPath, "utf8");
    assert.doesNotMatch(manifest, /api[_-]?key|Bearer\s+/i);
  }
});
