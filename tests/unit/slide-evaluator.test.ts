import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSlide } from "../../src/services/slide-evaluator.js";
import { makeEvaluationFixtures } from "../helpers/quality-fixtures.js";

const { source, spec, render, passingDeterministic, failingDeterministic, perfectReview } = makeEvaluationFixtures();

test("computes total score from fixed weights", async () => {
  const review = { review: async () => ({
    dimensions: { fidelity: 90, structure: 80, readability: 85, layout: 90, asset: 80, technical: 100 },
    issues: [],
  }) };
  const result = await evaluateSlide({ source, spec, render, deterministic: passingDeterministic, review });
  assert.equal(result.score, 87.5);
  assert.equal(result.hardGatePassed, true);
});

test("does not allow the model to override a deterministic failure", async () => {
  const result = await evaluateSlide({ source, spec, render, deterministic: failingDeterministic, review: perfectReview });
  assert.equal(result.hardGatePassed, false);
  assert.equal(result.safeToReturn, true);
});

test("rejects a review that does not match the schema", async () => {
  await assert.rejects(
    () => evaluateSlide({ source, spec, render, deterministic: passingDeterministic, review: { review: async () => ({ score: 100 }) } }),
    /review schema/i,
  );
});

test("provides a deterministic QA score when no review API is configured", async () => {
  const result = await evaluateSlide({ source, spec, render, deterministic: passingDeterministic });
  assert.ok(result.score >= 85);
  assert.equal(result.hardGatePassed, true);
});

test("normalizes unsafe external review diagnostics before returning a quality report", async () => {
  const unsafeText = [
    "https://review.invalid/callback?token=url-secret",
    "/Users/reviewer/private/key.txt",
    "OPENAI_API_KEY=review-secret",
    "Error: leaked stack\n    at review (/Users/reviewer/review.ts:8:4)",
    "data:image/png;base64,TEVBS1lfQkFTRTY0",
  ].join(" | ");
  const review = { review: async () => ({
    dimensions: { fidelity: 95, structure: 95, readability: 95, layout: 95, asset: 95, technical: 95 },
    issues: [{
      id: "unsafe-review-warning",
      severity: "warning" as const,
      category: "technical" as const,
      evidence: unsafeText,
      targetId: "https://review.invalid/private-target",
      suggestedAction: "Bearer review-credential-secret",
    }],
  }) };

  const result = await evaluateSlide({ source, spec, render, deterministic: passingDeterministic, review });

  assert.equal(result.hardGatePassed, true, "a sanitized warning must not forge or erase valid delivery gates");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.evidence, "External review diagnostic removed by safety policy");
  assert.equal(result.issues[0]?.suggestedAction, "Re-run the closed quality checks without external diagnostic details");
  assert.equal(result.issues[0]?.targetId, undefined);
  assert.doesNotMatch(JSON.stringify(result), /url-secret|\/Users\/reviewer|review-secret|leaked stack|TEVBS1lfQkFTRTY0|review-credential-secret/);
});

for (const [kind, unsafeEvidence] of [
  ["URL", "https://review.invalid/private?token=one"],
  ["Unix path", "/Users/reviewer/private/key.txt"],
  ["Windows path", "C:\\reviewer\\private\\key.txt"],
  ["stack", "Error: review failed\n    at review (/opt/reviewer/index.js:8:4)"],
  ["credential", "client_secret=review-secret"],
  ["data URL", "data:image/png;base64,TEVBS1lfQkFTRTY0"],
  ["raw Base64", "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB=="],
] as const) {
  test(`normalizes an isolated external review ${kind}`, async () => {
    const review = { review: async () => ({
      dimensions: { fidelity: 95, structure: 95, readability: 95, layout: 95, asset: 95, technical: 95 },
      issues: [{
        id: "isolated-warning",
        severity: "warning" as const,
        category: "technical" as const,
        evidence: unsafeEvidence,
        suggestedAction: "Run a safe local check",
      }],
    }) };
    const result = await evaluateSlide({ source, spec, render, deterministic: passingDeterministic, review });
    assert.equal(result.issues[0]?.evidence, "External review diagnostic removed by safety policy");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(unsafeEvidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}
