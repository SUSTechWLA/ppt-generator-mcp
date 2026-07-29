import assert from "node:assert/strict";
import test from "node:test";

import { routeRepairs } from "../../src/services/repair-router.js";
import { runQualityLoop } from "../../src/workflow/quality-loop.js";
import { makeLoopInput, reportWith } from "../helpers/quality-loop-fixtures.js";

test("routes overflow to a target block rewrite", () => {
  const actions = routeRepairs(
    reportWith({ category: "layout", targetId: "block-2", evidence: "text overflow" }),
    { attempt: 1, templateSwitched: false },
  );
  assert.deepEqual(actions[0], { type: "rewrite_block", targetId: "block-2", reasonIssueId: "issue-1" });
});

test("switches template at most once and stops after three attempts", async () => {
  const result = await runQualityLoop(makeLoopInput({ scores: [70, 78, 82], hardGates: [true, true, true], maxAttempts: 3 }));
  assert.equal(result.status, "best_effort");
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts.filter((attempt) => attempt.actions.some((action) => action.type === "switch_template")).length, 1);
});

test("distinguishes safe best effort from failed output", async () => {
  const bestEffort = await runQualityLoop(makeLoopInput({ scores: [90], hardGates: [false], safeFlags: [true], maxAttempts: 1 }));
  const failed = await runQualityLoop(makeLoopInput({ scores: [90], hardGates: [false], safeFlags: [false], maxAttempts: 1 }));
  assert.equal(bestEffort.status, "best_effort");
  assert.equal(failed.status, "failed");
});

test("stops immediately once score and hard gates pass", async () => {
  const result = await runQualityLoop(makeLoopInput({ scores: [88, 92], hardGates: [true, true], maxAttempts: 3 }));
  assert.equal(result.status, "delivered");
  assert.equal(result.attempts.length, 1);
});
