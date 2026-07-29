import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProductionDependencies } from "../../src/app.js";
import { loadAppConfig } from "../../src/config/env.js";
import { createPptMcpServer } from "../../src/mcp/register-tools.js";

function page(number: number, title: string, body: string): string {
  return `<page ${number}>\n一级标题：数字产品方案\n二级标题：客户交付\n三级标题：运行保障\n四级标题：${title}\n正文：\n${body}`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1792" height="1024" viewBox="0 0 1792 1024"><rect width="1792" height="1024" fill="#e6efe8"/><path d="M220 740h1350M320 680l280-220 250 120 300-300 310 250" fill="none" stroke="#145c3d" stroke-width="50"/><circle cx="1150" cy="280" r="90" fill="#c7a34b"/></svg>`;
const externalDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

async function fixture(t: test.TestContext) {
  const outputRoot = await mkdtemp(join(tmpdir(), "mcp-deck-acceptance-"));
  const dependencies = createProductionDependencies(
    loadAppConfig({ PPT_OUTPUT_ROOT: outputRoot }),
    { templatesDir: resolve("templates") },
  );
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "mcp-deck-acceptance", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputRoot, { recursive: true, force: true });
  });
  return { client, dependencies };
}

test("production MCP resumes an image deck from needs_assets and does not rerun its delivered page", async (t) => {
  const { client, dependencies } = await fixture(t);
  const planned = await client.callTool({
    name: "plan_deck",
    arguments: {
      sourceText: page(81, "作业闭环", "首先启动现场检查。其次提交问题清单。最后完成整改复核。"),
      pageNumbers: [81],
      documentType: "bid",
      preferredThemeId: "green-infographic-v1",
      quality: { minScore: 85, maxAttempts: 2 },
      requestId: "mcp-image-deck-plan",
    },
  });
  assert.equal(planned.isError, undefined, JSON.stringify(planned.content));
  const plan = planned.structuredContent as {
    plannedDeck: { deckPlanId: string };
    assets: Array<{ id: string; prompt: string }>;
  };
  assert.deepEqual(plan.assets.map((asset) => asset.id), ["p81-img-001"]);

  const first = await client.callTool({
    name: "generate_deck",
    arguments: { deckPlanId: plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "mcp-image-deck-run" },
  });
  assert.equal(first.isError, undefined, JSON.stringify(first.content));
  const waiting = first.structuredContent as {
    deckRunId: string;
    status: string;
    assets: { status: string; missingAssetIds: string[] };
    pages: unknown[];
  };
  assert.equal(waiting.status, "needs_assets");
  assert.deepEqual(waiting.assets, { status: "needs_assets", missingAssetIds: ["p81-img-001"] });
  assert.deepEqual(waiting.pages, []);

  const resumed = await client.callTool({
    name: "generate_deck",
    arguments: {
      deckPlanId: plan.plannedDeck.deckPlanId,
      externalAssets: [{ id: "p81-img-001", dataUrl: externalDataUrl }],
      requestId: "mcp-image-deck-run",
    },
  });
  assert.equal(resumed.isError, undefined, JSON.stringify(resumed.content));
  const delivered = resumed.structuredContent as {
    deckRunId: string;
    status: string;
    assets: { status: string; missingAssetIds: string[] };
    pages: Array<{
      pageNumber: number;
      runId: string;
      quality: { score: number; threshold: number; hardGatePassed: boolean; attempts: number };
      artifacts: { html: { id: string; view: string; artifact: string } };
    }>;
    consistency: { passed: boolean; issues: string[] };
  };
  assert.equal(delivered.deckRunId, waiting.deckRunId);
  assert.equal(delivered.status, "delivered", JSON.stringify(delivered.consistency));
  assert.deepEqual(delivered.assets, { status: "ready", missingAssetIds: [] });
  assert.equal(delivered.pages[0].pageNumber, 81);
  assert.equal(delivered.pages[0].quality.hardGatePassed, true);
  assert.ok(delivered.pages[0].quality.score >= delivered.pages[0].quality.threshold);
  assert.ok(delivered.pages[0].quality.attempts <= 2);
  assert.deepEqual(delivered.pages[0].artifacts.html, {
    id: delivered.pages[0].runId,
    view: "artifact",
    artifact: "final.html",
  });
  assert.equal(delivered.consistency.passed, true, delivered.consistency.issues.join("\n"));

  const before = await dependencies.deckStore.getRun(delivered.deckRunId);
  const repeated = await client.callTool({
    name: "generate_deck",
    arguments: { deckPlanId: plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "mcp-image-deck-run" },
  });
  assert.equal(repeated.isError, undefined, JSON.stringify(repeated.content));
  const repeatedOutput = repeated.structuredContent as typeof delivered;
  assert.equal(repeatedOutput.status, "delivered");
  assert.equal(repeatedOutput.pages[0].runId, delivered.pages[0].runId);
  assert.equal(repeatedOutput.pages[0].quality.attempts, delivered.pages[0].quality.attempts);
  const after = await dependencies.deckStore.getRun(delivered.deckRunId);
  assert.equal(after.pages[0].runId, before.pages[0].runId);

  const htmlArtifact = await client.callTool({
    name: "get_deck",
    arguments: { id: delivered.pages[0].runId, view: "artifact", artifact: "final.html" },
  });
  assert.equal(htmlArtifact.isError, undefined, JSON.stringify(htmlArtifact.content));
  const htmlResult = (htmlArtifact.structuredContent as { result: { kind: string; data: string } }).result;
  assert.equal(htmlResult.kind, "html");
  const html = htmlResult.data;
  assert.equal((html.match(/data-slide-page=/g) ?? []).length, 1);
  assert.match(html, /data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /<script|https?:\/\//i);

  const pageManifest = await client.callTool({
    name: "get_deck",
    arguments: { id: delivered.pages[0].runId, view: "artifact", artifact: "manifest.json" },
  });
  assert.equal(pageManifest.isError, undefined, JSON.stringify(pageManifest.content));
  assert.equal((pageManifest.structuredContent as { result: { kind: string } }).result.kind, "page_manifest");
  const publicManifest = JSON.stringify(pageManifest.structuredContent);
  assert.match(publicManifest, /delivered/);
  assert.doesNotMatch(publicManifest, /\/Users\/|requestId|requestFingerprint|dataUrl|assetHashes|filePath|htmlPath|previewPath|qualityPath/i);

  const qualityArtifact = await client.callTool({
    name: "get_deck",
    arguments: { id: delivered.pages[0].runId, view: "artifact", artifact: "quality.json" },
  });
  assert.equal(qualityArtifact.isError, undefined, JSON.stringify(qualityArtifact.content));
  const quality = (qualityArtifact.structuredContent as {
    result: { kind: string; data: { hardGatePassed: boolean; safeToReturn: boolean } };
  }).result;
  assert.equal(quality.kind, "quality");
  assert.equal(quality.data.hardGatePassed, true);
  assert.equal(quality.data.safeToReturn, true);

  const consistencyArtifact = await client.callTool({
    name: "get_deck",
    arguments: { id: delivered.deckRunId, view: "artifact", artifact: "consistency.json" },
  });
  assert.equal(consistencyArtifact.isError, undefined, JSON.stringify(consistencyArtifact.content));
  const consistency = (consistencyArtifact.structuredContent as {
    result: { kind: string; data: { passed: boolean; issues: string[] } };
  }).result;
  assert.equal(consistency.kind, "consistency");
  assert.deepEqual(consistency.data, { passed: true, issues: [] });
});

test("production MCP delivers a zero-asset plan and returns only sanitized artifact references", async (t) => {
  const { client } = await fixture(t);
  const planned = await client.callTool({
    name: "plan_deck",
    arguments: {
      sourceText: page(82, "责任人机制", "固定负责人配置数量为1名。规定响应时限为30分钟。"),
      pageNumbers: [82],
      documentType: "bid",
      quality: { minScore: 90, maxAttempts: 2 },
      requestId: "mcp-zero-asset-plan",
    },
  });
  assert.equal(planned.isError, undefined, JSON.stringify(planned.content));
  const plan = planned.structuredContent as { plannedDeck: { deckPlanId: string }; assets: unknown[] };
  assert.deepEqual(plan.assets, []);

  const generated = await client.callTool({
    name: "generate_deck",
    arguments: { deckPlanId: plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "mcp-zero-asset-run" },
  });
  assert.equal(generated.isError, undefined, JSON.stringify(generated.content));
  const output = generated.structuredContent as {
    deckRunId: string;
    status: string;
    pages: Array<{ pageNumber: number; quality: { threshold: number; hardGatePassed: boolean } }>;
    artifacts: { manifest: { id: string; view: string } };
    consistency: { passed: boolean };
  };
  assert.equal(output.status, "delivered");
  assert.equal(output.pages[0].pageNumber, 82);
  assert.equal(output.pages[0].quality.threshold, 90);
  assert.equal(output.pages[0].quality.hardGatePassed, true);
  assert.equal(output.consistency.passed, true);
  assert.deepEqual(output.artifacts.manifest, { id: output.deckRunId, view: "manifest" });
  assert.doesNotMatch(JSON.stringify(output), /\/Users\/|manifestPath|htmlPath|previewPath|api[_-]?key|Bearer\s+/i);

  const manifest = await client.callTool({ name: "get_deck", arguments: { id: output.deckRunId, view: "manifest" } });
  assert.equal(manifest.isError, undefined, JSON.stringify(manifest.content));
  assert.doesNotMatch(JSON.stringify(manifest), /\/Users\/|requestFingerprint|assetHashes|manifestPath|htmlPath|previewPath/i);
});
