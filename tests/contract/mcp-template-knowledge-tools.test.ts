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
import { ONE_PIXEL_PNG, validTemplateBlueprint } from "../helpers/template-knowledge-fixtures.js";

async function productionClient(t: test.TestContext) {
  const outputRoot = await mkdtemp(join(tmpdir(), "mcp-template-knowledge-"));
  const dependencies = createProductionDependencies(loadAppConfig({ PPT_OUTPUT_ROOT: outputRoot }), { templatesDir: resolve("templates") });
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "template-knowledge-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputRoot, { recursive: true, force: true });
  });
  return client;
}

test("lists three strict template knowledge tools without path, API key or remote URL inputs", async (t) => {
  const client = await productionClient(t);
  const listed = await client.listTools();
  for (const name of ["inspect_template", "create_template_from_reference", "list_template_knowledge"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /api[_-]?key|secret|(?:source|output|file|template)path|remoteurl/i);
  }
  const inspect = listed.tools.find((tool) => tool.name === "inspect_template")!;
  assert.deepEqual(Object.keys(inspect.inputSchema.properties ?? {}), ["referenceHtml"]);
  const create = listed.tools.find((tool) => tool.name === "create_template_from_reference")!;
  assert.deepEqual(Object.keys(create.inputSchema.properties ?? {}).sort(), ["blueprint", "referenceHtml", "referenceImageDataUrl", "requestId"].sort());
});

test("MCP inspection strips source copy and image handoff never echoes pixels", async (t) => {
  const client = await productionClient(t);
  const inspected = await client.callTool({
    name: "inspect_template",
    arguments: { referenceHtml: `<!doctype html><html><head><style>main{display:grid;grid-template-columns:repeat(8,1fr);color:#17241e;background:#fff}</style></head><body><h1>PRIVATE CLIENT COPY</h1><main><section>Secret facts</section></main><footer>BrandLogo</footer></body></html>` },
  });
  assert.equal(inspected.isError, undefined, JSON.stringify(inspected.content));
  assert.doesNotMatch(JSON.stringify(inspected), /PRIVATE CLIENT|Secret facts|BrandLogo/i);

  const handoff = await client.callTool({
    name: "create_template_from_reference",
    arguments: { referenceImageDataUrl: ONE_PIXEL_PNG, requestId: "mcp-image-handoff-01" },
  });
  assert.equal(handoff.isError, undefined, JSON.stringify(handoff.content));
  assert.equal((handoff.structuredContent as { result: { status: string } }).result.status, "needs_analysis");
  assert.doesNotMatch(JSON.stringify(handoff), /iVBOR|base64|data:image/i);
  const listed = await client.callTool({ name: "list_template_knowledge", arguments: {} });
  assert.deepEqual((listed.structuredContent as { records: unknown[] }).records, []);
});

test("MCP blueprint approval and list expose only immutable logical evidence", async (t) => {
  const client = await productionClient(t);
  const approved = await client.callTool({
    name: "create_template_from_reference",
    arguments: { blueprint: validTemplateBlueprint(), requestId: "mcp-blueprint-approve-01" },
  });
  assert.equal(approved.isError, undefined, JSON.stringify(approved.content));
  const output = (approved.structuredContent as {
    result: {
      status: string;
      knowledgeId: string;
      artifacts: string[];
      quality: { hardGatePassed: boolean; evidenceVersion: number; imageEvidenceStatus: string };
    };
  }).result;
  assert.equal(output.status, "approved");
  assert.match(output.knowledgeId, /^[0-9a-f-]{36}$/i);
  assert.equal(output.quality.hardGatePassed, true);
  assert.equal(output.quality.evidenceVersion, 2);
  assert.equal(output.quality.imageEvidenceStatus, "measured");
  assert.deepEqual(output.artifacts, ["blueprint.json", "template.html", "profile.json", "qa.json", "preview.png"]);
  const listed = await client.callTool({ name: "list_template_knowledge", arguments: {} });
  assert.equal((listed.structuredContent as { records: unknown[] }).records.length, 1);
  const serialized = JSON.stringify({ approved, listed });
  assert.doesNotMatch(serialized, /\/Users\/|\/tmp\/|requestFingerprint|requestId|data:image|base64|stack|api[_-]?key/i);
});
