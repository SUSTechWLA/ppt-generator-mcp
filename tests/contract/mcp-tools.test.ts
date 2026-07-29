import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPptMcpServer } from "../../src/mcp/register-tools.js";
import { makeWorkflowDependencies, workflowInput } from "../helpers/workflow-fixtures.js";

test("lists workflow and compatibility tools with structured output", async (t) => {
  const dependencies = await makeWorkflowDependencies({ scores: [90], hardGates: [true] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPptMcpServer({ ...dependencies, templatesDir: "templates" });
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of ["plan_slide", "generate_slide", "get_run", "get_artifact", "evaluate_slide", "insert_asset_slots", "fill_placeholders", "list_templates"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const result = await client.callTool({ name: "generate_slide", arguments: workflowInput });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { status?: string } | undefined)?.status, "delivered");
});

test("plan_slide returns stable image prompts for Agent imagegen", async (t) => {
  const dependencies = await makeWorkflowDependencies({ scores: [90], hardGates: [true] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPptMcpServer({ ...dependencies, templatesDir: "templates" });
  const client = new Client({ name: "plan-contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "plan_slide", arguments: workflowInput });
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { assets: Array<{ id: string; prompt: string }>; plannedSpec: unknown };
  assert.equal(structured.assets[0].id, "img-001");
  assert.ok(structured.assets[0].prompt.length > 10);
  assert.ok(structured.plannedSpec);
});

test("tool errors never include a stack trace", async (t) => {
  const dependencies = await makeWorkflowDependencies({ scores: [90], hardGates: [true] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPptMcpServer({ ...dependencies, templatesDir: "templates" });
  const client = new Client({ name: "error-contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "get_run", arguments: { runId: "not-a-uuid" } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /stack/i);
});
