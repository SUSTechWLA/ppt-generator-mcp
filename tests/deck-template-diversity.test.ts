import assert from "node:assert/strict";
import test from "node:test";
import { planDeckInputSchema } from "../src/domain/deck-plan.js";

const baseInput = {
  sourceText: "<page 1>\n一级标题：示例\n正文：\n事实内容足够用于页面规划和模板选择。",
  pageNumbers: [1],
};

test("accepts explicit template diversity modes without schema-defaulting omission", () => {
  for (const mode of ["off", "conservative", "balanced", "expressive"] as const) {
    assert.equal(planDeckInputSchema.parse({ ...baseInput, templateDiversity: mode }).templateDiversity, mode);
  }
  assert.equal(planDeckInputSchema.parse(baseInput).templateDiversity, undefined);
  assert.equal(planDeckInputSchema.safeParse({ ...baseInput, templateDiversity: "random" }).success, false);
});
