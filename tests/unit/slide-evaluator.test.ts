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
