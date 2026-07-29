import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProductionDependencies } from "../../src/app.js";
import { loadAppConfig } from "../../src/config/env.js";
import { createPptMcpServer } from "../../src/mcp/register-tools.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createLargeValidPng(): Buffer {
  const width = 1_024;
  const height = 576;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  let state = 0x6d2b_79f5;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    scanlines[row] = 0;
    for (let x = 1; x <= width * 3; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      scanlines[row + x] = state & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("production MCP includes a valid large PNG page in passing deck consistency without widening public text reads", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "mcp-large-html-consistency-"));
  const png = createLargeValidPng();
  assert.ok(png.length > 512 * 1024, "fixture must exercise a genuinely large self-contained page");
  const dependencies = createProductionDependencies(
    loadAppConfig({ PPT_OUTPUT_ROOT: outputRoot, PPT_MAX_IMAGE_BYTES: String(3 * 1024 * 1024) }),
    { templatesDir: resolve("templates") },
  );
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "large-html-consistency", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputRoot, { recursive: true, force: true });
  });

  const plannedCall = await client.callTool({
    name: "plan_deck",
    arguments: {
      sourceText: "<page 711>\n一级标题：数字产品方案\n二级标题：客户交付\n三级标题：运行保障\n四级标题：作业闭环\n正文：\n首先启动现场检查。其次提交问题清单。最后完成整改复核。",
      pageNumbers: [711],
      documentType: "bid",
      preferredThemeId: "green-infographic-v1",
      quality: { minScore: 90, maxAttempts: 1 },
    },
  });
  assert.equal(plannedCall.isError, undefined, JSON.stringify(plannedCall.content));
  const plan = plannedCall.structuredContent as {
    plannedDeck: { deckPlanId: string };
    assets: Array<{ id: string }>;
  };
  assert.equal(plan.assets.length, 1);

  const generatedCall = await client.callTool({
    name: "generate_deck",
    arguments: {
      deckPlanId: plan.plannedDeck.deckPlanId,
      externalAssets: [{ id: plan.assets[0].id, dataUrl: `data:image/png;base64,${png.toString("base64")}` }],
    },
  });
  assert.equal(generatedCall.isError, undefined, JSON.stringify(generatedCall.content));
  const generated = generatedCall.structuredContent as {
    status: string;
    pages: Array<{ runId: string; quality: { score: number; hardGatePassed: boolean } }>;
    consistency?: { passed: boolean; issues: string[] };
  };
  assert.equal(generated.status, "delivered", JSON.stringify(generated.consistency));
  assert.equal(generated.pages[0].quality.hardGatePassed, true);
  assert.ok(generated.pages[0].quality.score >= 90);
  assert.deepEqual(generated.consistency, { passed: true, issues: [] });

  const publicArtifact = await dependencies.runStore.getArtifact(generated.pages[0].runId, "final.html");
  assert.ok(publicArtifact.size > 512 * 1024);
  assert.equal(publicArtifact.text, undefined);
  const publicMcpRead = await client.callTool({
    name: "get_deck",
    arguments: { id: generated.pages[0].runId, view: "artifact", artifact: "final.html" },
  });
  assert.equal(publicMcpRead.isError, true);
  assert.doesNotMatch(JSON.stringify(publicMcpRead), /data:image\/png;base64|\/private\/|\/Users\//i);
});
