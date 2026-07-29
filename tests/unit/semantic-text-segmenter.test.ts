import assert from "node:assert/strict";
import test from "node:test";

import { segmentSemanticText } from "../../src/services/semantic-text-segmenter.js";

test("semantic segmenter returns exact offsets and gaps across ASCII boundaries", () => {
  const input = 'A 2.5 ready. "Keep. Together." Next;\nFinal.';

  assert.deepEqual(segmentSemanticText(input), [
    { text: "A 2.5 ready.", start: 0, end: 12, gapBefore: "" },
    { text: '"Keep. Together."', start: 13, end: 30, gapBefore: " " },
    { text: "Next;", start: 31, end: 36, gapBefore: " " },
    { text: "Final.", start: 37, end: 43, gapBefore: "\n" },
  ]);
});

test("semantic segmenter supports Chinese punctuation without inventing gaps", () => {
  assert.deepEqual(segmentSemanticText("完成初始化。随后校验；最终归档。"), [
    { text: "完成初始化。", start: 0, end: 6, gapBefore: "" },
    { text: "随后校验；", start: 6, end: 11, gapBefore: "" },
    { text: "最终归档。", start: 11, end: 16, gapBefore: "" },
  ]);
});

test("semantic segmenter keeps ordered-list periods attached to their clauses", () => {
  assert.deepEqual(segmentSemanticText("1. Inspect power; 2. Inspect network."), [
    { text: "1. Inspect power;", start: 0, end: 17, gapBefore: "" },
    { text: "2. Inspect network.", start: 18, end: 37, gapBefore: " " },
  ]);
});

test("semantic segmenter keeps URL, domain, and email periods inside their sentence", () => {
  const firstSentence = "Visit www.example.com or https://docs.example.com, then email name@example.com.";
  const secondSentence = "Arrive onsite.";
  const input = `${firstSentence} ${secondSentence}`;

  assert.deepEqual(segmentSemanticText(input), [
    { text: firstSentence, start: 0, end: firstSentence.length, gapBefore: "" },
    {
      text: secondSentence,
      start: firstSentence.length + 1,
      end: input.length,
      gapBefore: " ",
    },
  ]);
});

test("semantic segmenter keeps initialisms inside genuine English sentence boundaries", () => {
  const firstSentence = "Use e.g. local checks and i.e. alternate checks with the U.S. team.";
  const input = `${firstSentence} Response complete. Arrive onsite.`;

  assert.deepEqual(segmentSemanticText(input).map((segment) => segment.text), [
    firstSentence,
    "Response complete.",
    "Arrive onsite.",
  ]);
});
