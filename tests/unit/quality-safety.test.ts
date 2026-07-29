import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeHtmlText } from "../../src/mcp/deck-tools.js";
import { hasUnsafeDiagnosticText } from "../../src/services/quality-safety.js";

function percentEncode(value: string, rounds: number): string {
  let encoded = value;
  for (let round = 0; round < rounds; round += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

test("canonical safety detects nested external locations through sixteen percent-decode rounds", () => {
  for (const rounds of [1, 2, 4, 5, 8, 16]) {
    assert.equal(
      hasUnsafeDiagnosticText(percentEncode("file:///Users/alice/deep-secret.txt", rounds)),
      true,
      `expected ${rounds} encoded round(s) to be unsafe`,
    );
  }
});

test("canonical safety fails closed when percent decoding is still changing beyond its work budget", () => {
  assert.equal(hasUnsafeDiagnosticText(percentEncode("普通文本", 32)), false);
  assert.equal(hasUnsafeDiagnosticText(percentEncode("普通文本", 33)), true);
  assert.equal(hasUnsafeDiagnosticText(percentEncode("普通文本", 64)), true);
});

test("canonical safety keeps ordinary percentages and malformed percent fragments", () => {
  for (const value of [
    "完成率为95%，误差不超过5%。",
    "格式%ZZ保持原样，不将残缺%E0%A4%A视为地址。",
  ]) assert.equal(hasUnsafeDiagnosticText(value), false, value);
});

test("public HTML accepts a legitimate inline SVG data URL", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#145c3d"/></svg>';
  const html = `<html><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" alt="合法图标"></body></html>`;
  assert.equal(sanitizeHtmlText(html), html);
});
