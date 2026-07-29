import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProductionDependencies } from "../../src/app.js";
import { loadAppConfig } from "../../src/config/env.js";
import { WorkflowError } from "../../src/domain/workflow-error.js";
import { getDeckOutputSchema, sanitizePublicData } from "../../src/mcp/deck-tools.js";
import { createPptMcpServer } from "../../src/mcp/register-tools.js";

function page(number: number, title: string, body: string): string {
  return `<page ${number}>\n一级标题：数字产品方案\n二级标题：客户交付\n三级标题：运行保障\n四级标题：${title}\n正文：\n${body}`;
}

const fourPageSource = [
  page(59, "服务责任", "固定负责人配置数量为1名。规定响应时限为30分钟。"),
  page(60, "检查机制", "每日完成1次现场检查。每月形成1份汇总记录。"),
  page(61, "履约管理", "未经采购人书面批准不得变更。全过程保留可追溯记录。"),
  page(62, "闭环处置", "问题整改完成后必须独立复核。复核结果纳入履约台账。"),
].join("\n\n");

async function productionClient(t: test.TestContext) {
  const outputRoot = await mkdtemp(join(tmpdir(), "mcp-deck-contract-"));
  const dependencies = createProductionDependencies(
    loadAppConfig({ PPT_OUTPUT_ROOT: outputRoot }),
    { templatesDir: resolve("templates") },
  );
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "mcp-deck-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputRoot, { recursive: true, force: true });
  });
  return { client, dependencies };
}

test("lists strict high-level deck tools without API-key fields", async (t) => {
  const { client } = await productionClient(t);
  const listed = await client.listTools();

  for (const name of ["plan_deck", "generate_deck", "get_deck"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} input must be strict`);
    assert.ok(tool.outputSchema, `${name} must declare structured output`);
    const output = tool.outputSchema as { additionalProperties?: boolean; anyOf?: Array<{ additionalProperties?: boolean }> };
    if (output.anyOf) assert.ok(output.anyOf.every((variant) => variant.additionalProperties === false), `${name} variants must be strict`);
    else assert.equal(output.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /apiKey|api_key|secret/i);
  }

  const plan = listed.tools.find((tool) => tool.name === "plan_deck")!;
  assert.deepEqual(
    Object.keys((plan.inputSchema.properties ?? {}) as Record<string, unknown>).sort(),
    ["audience", "documentType", "pageNumbers", "preferredThemeId", "quality", "requestId", "sourceMarkdown", "sourceText"].sort(),
  );
  assert.ok((plan.inputSchema.required ?? []).includes("documentType"));
  assert.ok((plan.inputSchema.required ?? []).includes("pageNumbers"));
  assert.match(plan.description ?? "", /<page N>/);
  assert.match(plan.description ?? "", /正文：/);
  assert.match(plan.description ?? "", /never auto-repaginates/i);
  const legacy = listed.tools.find((tool) => tool.name === "parse_source_content")!;
  assert.match(legacy.description ?? "", /compatibility-only/i);

  const get = listed.tools.find((tool) => tool.name === "get_deck")!;
  const artifactNames = ((get.inputSchema.properties as Record<string, { enum?: string[] }>).artifact.enum ?? []);
  assert.deepEqual(artifactNames, ["manifest.json", "final.html", "quality.json", "consistency.json"]);
  const variants = (((get.outputSchema as {
    properties?: { result?: { oneOf?: Array<{ properties?: Record<string, { const?: string }>; additionalProperties?: boolean }> } };
  }).properties?.result?.oneOf) ?? []);
  assert.ok(variants.every((variant) => variant.additionalProperties === false));
  assert.deepEqual(variants.map((variant) => variant.properties?.kind?.const).sort(), [
    "consistency", "deck_manifest", "html", "page_manifest", "plan", "quality",
  ]);
});

test("get_deck output discriminators bind each artifact to its strict data type", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.throws(() => getDeckOutputSchema.parse({
    result: { kind: "html", id, view: "artifact", artifact: "quality.json", size: 10, data: "not html" },
  }));
  assert.throws(() => getDeckOutputSchema.parse({
    result: { kind: "html", id, view: "artifact", artifact: "final.html", size: 10, data: "<html></html>", arbitraryPath: "/tmp/x" },
  }));
  assert.throws(() => getDeckOutputSchema.parse({
    result: { kind: "quality", id, view: "artifact", artifact: "quality.json", size: 10, data: { score: 90 } },
  }));
  assert.throws(() => getDeckOutputSchema.parse({
    result: { kind: "html", id, view: "artifact", artifact: "final.html", size: 10, data: "<html></html>" },
    arbitraryPath: "/tmp/x",
  }));
});

test("artifact sanitizer removes physical metadata and redacts credential assignments", () => {
  const sanitized = sanitizePublicData({
    requestId: "private-request",
    requestFingerprint: "private-fingerprint",
    filePath: "/Users/alice/private/final.html",
    dataUrl: "data:image/png;base64,U0VDUkVU",
    note: "OPENAI_API_KEY=plain-secret and password: hidden-secret",
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /private-request|private-fingerprint|\/Users\/alice|U0VDUkVU|plain-secret|hidden-secret/);
  assert.match(serialized, /redacted-credential/);
});

test("artifact sanitizer uses canonical safety views for encoded, folded, and nested values", () => {
  const unsafeValues = [
    "api_key=\"quoted-secret\"",
    "%2566%2569%256C%2565%253A%252F%252F%252FUsers%252Falice%252Fpercent-secret.txt",
    "file&colon;&sol;&sol;&sol;Users&sol;alice&sol;entity-secret.txt",
    "&#102;&#105;&#108;&#101;&#58;&#47;&#47;&#47;Users&#47;alice&#47;numeric-entity-secret.txt",
    "h\u200Bt t\tp\r s : / /example.invalid/folded-secret",
    "C:/alice/forward-secret.txt",
    "C:\\alice\\back-secret.txt",
    "/Users/alice/unix-secret.txt",
    "data:text/plain;base64,U0VDUkVUX0RBVEFfVVJM",
    Buffer.from("file:///Users/alice/base64-secret.txt").toString("base64"),
    Buffer.from("api_key=short-secret").toString("base64"),
  ];
  const sanitized = sanitizePublicData({ nested: unsafeValues, ordinary: "请核对页面路径与网址字段，不包含任何外部地址。" });
  const serialized = JSON.stringify(sanitized);
  for (const secret of [
    "quoted-secret", "percent-secret", "entity-secret", "numeric-entity-secret", "folded-secret", "forward-secret",
    "back-secret", "unix-secret", "U0VDUkVUX0RBVEFfVVJM", "base64-secret", "short-secret",
  ]) assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /请核对页面路径与网址字段/);
});

test("plan_deck fails closed when canonical source evidence contains a credential", async (t) => {
  const { client } = await productionClient(t);
  const result = await client.callTool({
    name: "plan_deck",
    arguments: {
      sourceText: page(92, "安全凭据", "项目必须使用api_key=\"mcp-plan-secret\"完成调用，并保留1份记录。"),
      pageNumbers: [92],
      documentType: "bid",
      quality: { minScore: 85, maxAttempts: 1 },
    },
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /mcp-plan-secret|api_key/i);
  assert.match(JSON.stringify(result), /INTERNAL_ERROR|INPUT_INVALID/);
});

test("plan_deck production wiring preserves four explicit pages and immutable evidence", async (t) => {
  const { client } = await productionClient(t);
  const result = await client.callTool({
    name: "plan_deck",
    arguments: {
      sourceText: fourPageSource,
      pageNumbers: [59, 60, 61, 62],
      documentType: "bid",
      preferredThemeId: "green-infographic-v1",
      quality: { minScore: 90, maxAttempts: 2 },
      requestId: "mcp-four-page-contract",
    },
  });

  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const output = result.structuredContent as {
    plannedDeck: {
      deckPlanId: string;
      pageNumbers: number[];
      quality: { minScore: number; maxAttempts: number };
      slides: Array<{
        page: { number: number };
        originalSourceFacts: unknown[];
        displayPlan: { grounding: { passed: boolean } };
        templateMatch: { profileCapabilityHash: string; assignments: unknown[] };
      }>;
    };
    assets: Array<{ id: string; prompt: string }>;
  };
  assert.deepEqual(output.plannedDeck.pageNumbers, [59, 60, 61, 62]);
  assert.deepEqual(output.plannedDeck.slides.map((slide) => slide.page.number), [59, 60, 61, 62]);
  assert.deepEqual(output.plannedDeck.quality, { minScore: 90, maxAttempts: 2 });
  assert.ok(output.plannedDeck.slides.every((slide) => slide.originalSourceFacts.length > 0));
  assert.ok(output.plannedDeck.slides.every((slide) => slide.displayPlan.grounding.passed));
  assert.ok(output.plannedDeck.slides.every((slide) => /^[0-9a-f]{64}$/.test(slide.templateMatch.profileCapabilityHash)));
  assert.ok(output.plannedDeck.slides.every((slide) => slide.templateMatch.assignments.length > 0));
  assert.ok(output.assets.every((asset) => /^p(?:59|60|61|62)-img-001$/.test(asset.id)));
  assert.ok(output.assets.every((asset) => asset.prompt.length > 10));
});

test("plan_deck rejects unmarked, malformed, and marker-mismatched source with safe recovery", async (t) => {
  const { client } = await productionClient(t);
  const cases = [
    { sourceText: "# 运行方案\n\n每日检查1次，并保留记录。", pageNumbers: [59] },
    { sourceText: fourPageSource.replace("<page 60>", "<page 60"), pageNumbers: [59, 60, 61, 62] },
    { sourceText: fourPageSource, pageNumbers: [59, 60, 61, 63] },
  ];

  for (const [index, input] of cases.entries()) {
    const result = await client.callTool({
      name: "plan_deck",
      arguments: { ...input, documentType: "bid", quality: { minScore: 85, maxAttempts: 2 }, requestId: `invalid-grammar-${index}` },
    });
    assert.equal(result.isError, true);
    const serialized = JSON.stringify(result);
    assert.match(serialized, /INPUT_INVALID/);
    assert.match(serialized, /<page N>|explicit page|marker/i);
    assert.doesNotMatch(serialized, /\bat\s+\S+\.ts:\d+|\/Users\/|api[_-]?key|Bearer\s+/i);
  }
});

test("get_deck accepts only UUID plus closed view and artifact names and never exposes paths", async (t) => {
  const { client } = await productionClient(t);
  const planned = await client.callTool({
    name: "plan_deck",
    arguments: {
      sourceText: page(71, "责任人机制", "固定负责人配置数量为1名。规定响应时限为30分钟。"),
      pageNumbers: [71],
      documentType: "bid",
      quality: { minScore: 85, maxAttempts: 1 },
      requestId: "get-deck-contract-plan",
    },
  });
  const deckPlanId = (planned.structuredContent as { plannedDeck: { deckPlanId: string } }).plannedDeck.deckPlanId;

  const fetched = await client.callTool({ name: "get_deck", arguments: { id: deckPlanId, view: "plan" } });
  assert.equal(fetched.isError, undefined, JSON.stringify(fetched.content));
  const fetchedResult = (fetched.structuredContent as { result: { id: string; kind: string; view: string } }).result;
  assert.equal(fetchedResult.id, deckPlanId);
  assert.equal(fetchedResult.kind, "plan");
  assert.equal(fetchedResult.view, "plan");
  assert.doesNotMatch(JSON.stringify(fetched), /\/Users\/|manifestPath|htmlPath|previewPath|requestFingerprint|assetHashes/i);

  for (const argumentsValue of [
    { id: "not-a-uuid", view: "plan" },
    { id: deckPlanId, view: "artifact", artifact: "../../etc/passwd" },
    { id: deckPlanId, view: "plan", arbitraryPath: "/private/secret" },
  ]) {
    const rejected = await client.callTool({ name: "get_deck", arguments: argumentsValue });
    assert.equal(rejected.isError, true);
    assert.doesNotMatch(JSON.stringify(rejected), /\/private\/secret|\/Users\/|stack|api[_-]?key|Bearer\s+/i);
  }
});

test("deck WorkflowError is actionable while unexpected dependency errors are closed", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "mcp-deck-error-contract-"));
  const dependencies = createProductionDependencies(
    loadAppConfig({ PPT_OUTPUT_ROOT: outputRoot }),
    { templatesDir: resolve("templates") },
  );
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "mcp-deck-error-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputRoot, { recursive: true, force: true });
  });
  const validInput = {
    sourceText: page(91, "安全错误", "每日完成1次检查。响应时限为30分钟。"),
    pageNumbers: [91],
    documentType: "bid",
    quality: { minScore: 85, maxAttempts: 1 },
  };

  dependencies.planDeck = async () => {
    throw new WorkflowError({
      code: "INPUT_INVALID",
      stage: "parse_explicit_pages",
      retryable: false,
      message: "Page 91 is missing the 正文： label",
      recovery: "Add one 正文： label before the body.",
    });
  };
  const actionable = await client.callTool({ name: "plan_deck", arguments: validInput });
  assert.equal(actionable.isError, true);
  assert.deepEqual(actionable.structuredContent, {
    code: "INPUT_INVALID",
    stage: "parse_explicit_pages",
    retryable: false,
    message: "Page 91 is missing the 正文： label",
    recovery: "Add one 正文： label before the body.",
  });

  dependencies.planDeck = async () => {
    throw new WorkflowError({
      code: "INPUT_INVALID",
      stage: "parse_explicit_pages",
      retryable: false,
      message: "unsafe /Users/alice/private/source.md with sk-live-secret",
      recovery: "Retry with Bearer hidden-credential",
    });
  };
  const unsafeWorkflowError = await client.callTool({ name: "plan_deck", arguments: validInput });
  assert.equal(unsafeWorkflowError.isError, true);
  assert.deepEqual(unsafeWorkflowError.structuredContent, {
    code: "INTERNAL_ERROR",
    stage: "mcp_tool",
    retryable: false,
    message: "The MCP tool could not complete the request safely",
    recovery: "Retry with validated identifiers and inputs; inspect server logs if the failure persists.",
  });
  assert.doesNotMatch(JSON.stringify(unsafeWorkflowError), /sk-live-secret|\/Users\/alice|hidden-credential/i);

  dependencies.planDeck = async () => {
    throw new Error("provider failed with sk-live-secret at /Users/alice/private/server.ts:42\n    at hidden stack");
  };
  const closed = await client.callTool({ name: "plan_deck", arguments: validInput });
  assert.equal(closed.isError, true);
  assert.deepEqual(closed.structuredContent, {
    code: "INTERNAL_ERROR",
    stage: "mcp_tool",
    retryable: false,
    message: "The MCP tool could not complete the request safely",
    recovery: "Retry with validated identifiers and inputs; inspect server logs if the failure persists.",
  });
  assert.doesNotMatch(JSON.stringify(closed), /sk-live-secret|\/Users\/alice|hidden stack|server\.ts:42/i);
});

test("high-level deck workflow never imports compatibility parsing or semantic pagination", async () => {
  for (const file of [
    "src/workflow/plan-deck.ts",
    "src/workflow/generate-deck.ts",
    "src/mcp/deck-tools.ts",
  ]) {
    const source = await readFile(resolve(file), "utf8");
    assert.doesNotMatch(source, /parse-source-content|parseSourceContent|semantic-paginator|recommendTemplateSlug/,
      `${file} must not depend on compatibility parsing or semantic pagination`);
  }
});
