import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAICompatibleProviders } from "../../src/providers/openai-compatible.js";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.js";

test("text provider returns parsed JSON", async (t) => {
  const mock = await startMockOpenAIServer();
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config);
  const value = await providers.text.generateJson({
    system: "Return JSON",
    payload: { source: "内容" },
    schemaName: "test_payload",
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(mock.requests.some((request) => request.url.endsWith("/chat/completions")), true);
});

test("image provider accepts b64_json", async (t) => {
  const mock = await startMockOpenAIServer({ imageMode: "base64" });
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config);
  const image = await providers.image.generate({ prompt: "商务园区", size: "1792x1024" });
  assert.equal(image.kind, "base64");
  if (image.kind === "base64") assert.match(image.data, /^[A-Za-z0-9+/=]+$/);
});

test("retries 429 responses with bounded backoff", async (t) => {
  const mock = await startMockOpenAIServer({ failFirstChatWith: 429 });
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config, {
    sleep: async () => undefined,
    random: () => 0,
  });
  await providers.text.generateJson({ system: "Return JSON", payload: {}, schemaName: "test_payload" });
  assert.equal(mock.requests.filter((request) => request.url.endsWith("/chat/completions")).length, 2);
});

test("never leaks provider secrets in a surfaced error", async (t) => {
  const mock = await startMockOpenAIServer({ failFirstChatWith: 401 });
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config);
  await assert.rejects(
    () => providers.text.generateJson({ system: "Return JSON", payload: {}, schemaName: "test_payload" }),
    (error: unknown) => error instanceof Error && !error.message.includes(mock.apiKey),
  );
});
