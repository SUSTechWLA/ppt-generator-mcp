import assert from "node:assert/strict";
import test from "node:test";

import type { SourceSection } from "../../src/domain/source-document.js";
import { extractFacts } from "../../src/services/fact-extractor.js";
import { normalizeSource } from "../../src/services/content-normalizer.js";

function section(body: string): SourceSection {
  return { id: "section-1", heading: "通用方案", body, keyPoints: [], order: 0 };
}

test("fact extraction preserves repeated occurrences as distinct facts", () => {
  const repeated = "每日完成1次检查。";
  const facts = extractFacts([section(`${repeated}\n${repeated}`)]);

  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((fact) => fact.text), [repeated, repeated]);
  assert.deepEqual(facts.map((fact) => fact.id), ["fact-1", "fact-2"]);
});

test("a sentence above 500 characters is losslessly segmented instead of sliced", () => {
  const longSentence = `项目必须${"连续完整履约".repeat(90)}并保留记录。`;
  assert.ok(longSentence.length > 500);

  const facts = extractFacts([section(longSentence)]);

  assert.ok(facts.length > 1);
  assert.ok(facts.every((fact) => fact.text.length <= 500));
  assert.equal(facts.map((fact) => fact.text).join(""), longSentence);
});

test("more than 200 fact occurrences never disappear silently", () => {
  const body = Array.from({ length: 205 }, (_, index) => `第${index + 1}项任务必须完成。`).join("\n");
  const facts = extractFacts([section(body)]);

  assert.equal(facts.length, 205);
  assert.equal(facts.at(-1)?.text, "第205项任务必须完成。");
});

test("fact chunking preserves boundary whitespace and surrogate pairs exactly", () => {
  const body = `${"甲".repeat(499)}  🚀${"乙".repeat(20)}`;
  const source = normalizeSource({
    sections: [{ heading: "无损分段", body }],
    quality: { minScore: 90, maxAttempts: 3 },
  });

  assert.ok(source.facts.length > 1);
  assert.equal(source.facts.map((fact) => fact.text).join(""), body);
  assert.equal(source.facts.some((fact) => /[\uD800-\uDBFF]$/.test(fact.text)), false);
  assert.equal(source.facts.some((fact) => /^[\uDC00-\uDFFF]/.test(fact.text)), false);
});
