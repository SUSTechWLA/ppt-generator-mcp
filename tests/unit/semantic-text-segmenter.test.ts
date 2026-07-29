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

test("semantic segmenter keeps title and label abbreviations with their continuation", () => {
  assert.deepEqual(segmentSemanticText("Dr. Chen arrives. Mr. Lee uses No. 1 channel."), [
    { text: "Dr. Chen arrives.", start: 0, end: 17, gapBefore: "" },
    { text: "Mr. Lee uses No. 1 channel.", start: 18, end: 45, gapBefore: " " },
  ]);
});

test("semantic segmenter consumes ASCII and Unicode ellipses as whole terminals", () => {
  const segments = segmentSemanticText("Wait... Continue checks. Pause… Resume.");

  assert.deepEqual(segments, [
    { text: "Wait...", start: 0, end: 7, gapBefore: "" },
    { text: "Continue checks.", start: 8, end: 24, gapBefore: " " },
    { text: "Pause…", start: 25, end: 31, gapBefore: " " },
    { text: "Resume.", start: 32, end: 39, gapBefore: " " },
  ]);
  assert.ok(segments.every((segment) => segment.text.length > 0 && !/^\.+$/.test(segment.text)));
});

test("semantic segmenter uses following context for an initialism final period", () => {
  assert.deepEqual(segmentSemanticText("Operations are in the U.S. Response complete. The U.S. team continues."), [
    { text: "Operations are in the U.S.", start: 0, end: 26, gapBefore: "" },
    { text: "Response complete.", start: 27, end: 45, gapBefore: " " },
    { text: "The U.S. team continues.", start: 46, end: 70, gapBefore: " " },
  ]);
});

test("semantic segmenter protects a contextual numbered-list marker after prose", () => {
  assert.deepEqual(segmentSemanticText("Scope includes 1. Inspect power; Continue checks."), [
    { text: "Scope includes 1. Inspect power;", start: 0, end: 32, gapBefore: "" },
    { text: "Continue checks.", start: 33, end: 49, gapBefore: " " },
  ]);
});
