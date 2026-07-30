import assert from "node:assert/strict";
import test from "node:test";
import { planDeckInputSchema } from "../src/domain/deck-plan.js";
import { selectDeckTemplateSequence } from "../src/services/deck-template-diversity.js";

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

test("exports the deck template sequence optimizer", () => {
  assert.equal(typeof selectDeckTemplateSequence, "function");
});

test("balanced selects varied near-best templates without adjacent repetition", () => {
  const pages = Array.from({ length: 4 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 198, selectionScore: 90, catalogIndex: 1 },
    { templateSlug: "layout-c", retainedCharacterCount: 197, selectionScore: 89, catalogIndex: 2 },
  ]);
  const decisions = selectDeckTemplateSequence(pages, "balanced");
  const slugs = decisions.map((decision, page) => pages[page][decision.candidateIndex].templateSlug);
  assert.ok(new Set(slugs).size >= 2);
  assert.equal(slugs.some((slug, index) => index > 0 && slug === slugs[index - 1]), false);
});

test("balanced rejects novelty outside the quality band", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 150, selectionScore: 70, catalogIndex: 1 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "balanced")[0].candidateIndex, 0);
});

test("balanced lets a higher template score offset admitted retained-character loss", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 80, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 198, selectionScore: 90, catalogIndex: 1 },
  ]];
  const decision = selectDeckTemplateSequence(pages, "balanced")[0];
  assert.equal(decision.candidateIndex, 1);
  assert.equal(decision.selectionScoreLoss, -10);
});

test("off preserves local winners and sequence selection is deterministic", () => {
  const pages = Array.from({ length: 4 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 199, selectionScore: 91, catalogIndex: 1 },
  ]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "off").map((item) => item.candidateIndex), [0, 0, 0, 0]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "balanced"), selectDeckTemplateSequence(pages, "balanced"));
});

test("a page with a single candidate selects its local winner", () => {
  const pages = [[
    { templateSlug: "only-layout", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "expressive")[0].candidateIndex, 0);
});

test("conservative rejects any retained-character loss", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 199, selectionScore: 92, catalogIndex: 1 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "conservative")[0].candidateIndex, 0);
});

test("expressive admits a candidate inside its wider retained-character band", () => {
  const pages = Array.from({ length: 2 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 188, selectionScore: 92, catalogIndex: 1 },
  ]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "expressive").map((item) => item.candidateIndex), [0, 1]);
});

test("bounds candidate and state exploration for a 30-page deck", () => {
  const pages = Array.from({ length: 30 }, () => Array.from({ length: 20 }, (_, index) => ({
    templateSlug: `layout-${index}`,
    retainedCharacterCount: 200,
    selectionScore: 92,
    catalogIndex: index,
  })));
  const decisions = selectDeckTemplateSequence(pages, "expressive");
  assert.equal(decisions.length, 30);
  assert.equal(decisions.every((decision) => decision.candidateIndex < 12), true);
});
