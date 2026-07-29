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

test("semantic segmenter consumes a consecutive Unicode ellipsis as one terminal span", () => {
  assert.deepEqual(segmentSemanticText("等待……继续检查。"), [
    { text: "等待……", start: 0, end: 4, gapBefore: "" },
    { text: "继续检查。", start: 4, end: 9, gapBefore: "" },
  ]);
});

test("semantic segmenter keeps organization-name continuations after initialisms", () => {
  assert.deepEqual(segmentSemanticText("The U.S. Army responds. The U.N. Security Council met."), [
    { text: "The U.S. Army responds.", start: 0, end: 23, gapBefore: "" },
    { text: "The U.N. Security Council met.", start: 24, end: 54, gapBefore: " " },
  ]);
});

test("semantic segmenter ends numeric prose before a genuine next sentence", () => {
  assert.deepEqual(segmentSemanticText("Complete phase 2. Release starts. Coverage reached 8. Next action begins."), [
    { text: "Complete phase 2.", start: 0, end: 17, gapBefore: "" },
    { text: "Release starts.", start: 18, end: 33, gapBefore: " " },
    { text: "Coverage reached 8.", start: 34, end: 53, gapBefore: " " },
    { text: "Next action begins.", start: 54, end: 73, gapBefore: " " },
  ]);
});

test("semantic segmenter uses label value context for an abbreviation period", () => {
  assert.deepEqual(segmentSemanticText("See Fig. Response complete. See Fig. 2."), [
    { text: "See Fig.", start: 0, end: 8, gapBefore: "" },
    { text: "Response complete.", start: 9, end: 27, gapBefore: " " },
    { text: "See Fig. 2.", start: 28, end: 39, gapBefore: " " },
  ]);
});

test("semantic segmenter preserves source traceability without punctuation-only fragments", () => {
  const inputs = [
    'A 2.5 ready. "Keep. Together." Next;',
    "1. Inspect power; 2. Inspect network.",
    "Visit www.example.com, then email name@example.com. Arrive onsite.",
    "Dr. Chen arrives. Use No. 1 channel.",
    "等待……继续检查。",
    "Wait... Continue checks.",
    "Operations are in the U.S. Response complete. The U.S. team continues.",
    "The U.S. Army responds.",
    "The U.N. Security Council met.",
    "Complete phase 2. Release starts.",
    "Coverage reached 8. Next action begins.",
    "Scope includes 1. Inspect power;",
    "See Fig. Response complete.",
    "……继续检查。",
    "... Continue checks.",
    "Wait. ... Continue checks.",
    "Acme Co., Ltd. provides service.",
    "Acme Inc. Response complete.",
    "Meet at St. Louis office.",
    "The U.S. Postal Service responds.",
  ];
  const allowedShortClauses = new Set(["等待……"]);

  for (const input of inputs) {
    const segments = segmentSemanticText(input);
    assert.ok(segments.every((segment) => segment.text.length > 0 && !/^[.。！？!?；;…]+$/u.test(segment.text)));
    assert.ok(segments.every((segment) => input.slice(segment.start, segment.end) === segment.text));
    assert.ok(segments.every((segment) => {
      const lexicalLength = segment.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
      return lexicalLength > 2 || allowedShortClauses.has(segment.text);
    }));
    assert.equal(segments.map((segment) => segment.gapBefore + segment.text).join(""), input);
  }
});

test("semantic segmenter attaches leading and standalone ellipses to following lexical text", () => {
  assert.deepEqual(segmentSemanticText("……继续检查。"), [
    { text: "……继续检查。", start: 0, end: 7, gapBefore: "" },
  ]);
  assert.deepEqual(segmentSemanticText("... Continue checks."), [
    { text: "... Continue checks.", start: 0, end: 20, gapBefore: "" },
  ]);
  assert.deepEqual(segmentSemanticText("Wait. ... Continue checks."), [
    { text: "Wait.", start: 0, end: 5, gapBefore: "" },
    { text: "... Continue checks.", start: 6, end: 26, gapBefore: " " },
  ]);
});

test("semantic segmenter terminates punctuation-only input without emitting a segment", () => {
  assert.deepEqual(segmentSemanticText("..."), []);
  assert.deepEqual(segmentSemanticText("……"), []);
  assert.deepEqual(segmentSemanticText("... …… ;；!?！？"), []);
});

test("semantic segmenter keeps company suffix continuations but preserves sentence boundaries", () => {
  assert.deepEqual(segmentSemanticText("Acme Co., Ltd. provides service. Acme Inc. provides service."), [
    { text: "Acme Co., Ltd. provides service.", start: 0, end: 32, gapBefore: "" },
    { text: "Acme Inc. provides service.", start: 33, end: 60, gapBefore: " " },
  ]);
  assert.deepEqual(segmentSemanticText("Acme Inc. Response complete."), [
    { text: "Acme Inc.", start: 0, end: 9, gapBefore: "" },
    { text: "Response complete.", start: 10, end: 28, gapBefore: " " },
  ]);
});

test("semantic segmenter uses address syntax for abbreviated proper names", () => {
  assert.deepEqual(segmentSemanticText("Meet at St. Louis office. Status is St. Response complete."), [
    { text: "Meet at St. Louis office.", start: 0, end: 25, gapBefore: "" },
    { text: "Status is St.", start: 26, end: 39, gapBefore: " " },
    { text: "Response complete.", start: 40, end: 58, gapBefore: " " },
  ]);
});

test("semantic segmenter keeps multi-token proper names after initialisms", () => {
  assert.deepEqual(segmentSemanticText("The U.S. Postal Service responds. The U.S. Response complete."), [
    { text: "The U.S. Postal Service responds.", start: 0, end: 33, gapBefore: "" },
    { text: "The U.S.", start: 34, end: 42, gapBefore: " " },
    { text: "Response complete.", start: 43, end: 61, gapBefore: " " },
  ]);
});
