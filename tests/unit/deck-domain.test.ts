import assert from "node:assert/strict";
import test from "node:test";

import { generateDeckInputSchema, planDeckInputSchema } from "../../src/domain/deck-plan.js";
import { generateSlideInputSchema } from "../../src/domain/source-document.js";

test("deck input accepts one Markdown source and ordered page numbers", () => {
  const input = planDeckInputSchema.parse({
    sourceMarkdown: "### 人员要求\n\n必须配置1名固定对接人员。",
    pageNumbers: [59, 60, 61, 62],
    documentType: "bid",
    quality: { minScore: 90, maxAttempts: 3 },
  });
  assert.deepEqual(input.pageNumbers, [59, 60, 61, 62]);
});

test("deck input rejects duplicate or unordered page numbers", () => {
  assert.throws(() => planDeckInputSchema.parse({
    sourceText: "必须配置1名固定对接人员。",
    pageNumbers: [59, 61, 60, 62],
    documentType: "bid",
  }));
});

test("single-slide input accepts deck-scoped page metadata and asset ids", () => {
  const input = generateSlideInputSchema.parse({
    sourceText: "项目必须在30分钟内启动人员调配，并在1小时内到场。",
    documentType: "bid",
    page: { number: 61, sectionTitle: "人员配置与履约保障", partNumber: "PART.01", partLabel: "方案响应", chapterLabel: "1.1 人员配备要求响应", subsectionTitle: "1.1.1 动态调配机制" },
    externalAssets: [{ id: "p61-img-001", dataUrl: "data:image/png;base64," + "a".repeat(32) }],
  });
  assert.equal(input.page?.number, 61);
});

test("generate deck requires a persisted plan id and page-scoped assets", () => {
  const input = generateDeckInputSchema.parse({
    deckPlanId: "11111111-1111-4111-8111-111111111111",
    externalAssets: [{ id: "p59-img-001", dataUrl: "data:image/png;base64," + "a".repeat(32) }],
  });
  assert.equal(input.externalAssets[0].id, "p59-img-001");
});
