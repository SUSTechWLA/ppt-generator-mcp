import assert from "node:assert/strict";
import test from "node:test";

import { buildSlideSpec } from "../../src/services/slide-spec-builder.js";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import { makeSlideSpec } from "../helpers/domain-fixtures.js";

const source = normalizeSource({
  sourceText: "# 服务方案\n\n## 响应要求\n项目必须在30分钟内响应，并覆盖8个服务点。",
  quality: { minScore: 85, maxAttempts: 3 },
});

test("builds a SlideSpec whose fact references exist", async () => {
  const factIds = source.facts.map((fact) => fact.id);
  const provider = { generateJson: async () => makeSlideSpec({ factIds, assetCount: 1 }) };
  const spec = await buildSlideSpec(source, provider);
  assert.equal(spec.assets[0].id, "img-001");
  assert.deepEqual(spec.sourceFactIds, factIds);
});

test("rejects unknown fact references", async () => {
  const provider = { generateJson: async () => makeSlideSpec({ factIds: ["fact-999"], assetCount: 0 }) };
  await assert.rejects(() => buildSlideSpec(source, provider), /fact-999/);
});

test("sends compact facts and procurement audience to the model", async () => {
  let payload: unknown;
  const factIds = source.facts.map((fact) => fact.id);
  const provider = {
    generateJson: async (input: { payload: unknown }) => {
      payload = input.payload;
      return makeSlideSpec({ factIds, assetCount: 1 });
    },
  };
  await buildSlideSpec(source, provider, "采购评审专家");
  assert.match(JSON.stringify(payload), /采购评审专家/);
  assert.match(JSON.stringify(payload), /30分钟/);
});
