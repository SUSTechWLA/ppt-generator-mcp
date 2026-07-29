import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { generateSlideWorkflow } from "../../src/workflow/generate-slide.js";
import { makeWorkflowDependencies, workflowInput } from "../helpers/workflow-fixtures.js";

test("generates a delivered self-contained slide", async () => {
  const deps = await makeWorkflowDependencies({ scores: [88], hardGates: [true] });
  const result = await generateSlideWorkflow(workflowInput, deps);
  assert.equal(result.status, "delivered");
  assert.equal(result.quality.score, 88);
  assert.match(await readFile(result.artifacts.htmlPath, "utf8"), /data:image\/png;base64,/);
  assert.equal(result.quality.attempts, 1);
});

test("returns best_effort after three safe attempts below threshold", async () => {
  const deps = await makeWorkflowDependencies({ scores: [72, 79, 83], hardGates: [true, true, true] });
  const result = await generateSlideWorkflow(workflowInput, deps);
  assert.equal(result.status, "best_effort");
  assert.equal(result.quality.attempts, 3);
  assert.equal(result.quality.score, 83);
});

test("does not repeat completed image generation when requestId is replayed", async () => {
  const deps = await makeWorkflowDependencies({ scores: [90], hardGates: [true] });
  const first = await generateSlideWorkflow({ ...workflowInput, requestId: "workflow-resume-1" }, deps);
  const second = await generateSlideWorkflow({ ...workflowInput, requestId: "workflow-resume-1" }, deps);
  assert.equal(second.runId, first.runId);
  assert.equal(deps.counters.imageCalls, 1);
});

test("reports the template of the selected repaired attempt", async () => {
  const switchedSlug = "green-infographic-bid-a4-landscape-table-text";
  const deps = await makeWorkflowDependencies({
    scores: [74, 92],
    hardGates: [true, true],
    templateSlugs: ["green-infographic-bid-a4-landscape-text-image", switchedSlug],
  });
  const result = await generateSlideWorkflow(workflowInput, deps);
  assert.equal(result.selectedTemplate.slug, switchedSlug);
  assert.match(result.selectedTemplate.reason, /修复.*切换/);
  const manifest = await deps.runStore.getRun(result.runId);
  assert.equal(manifest.template?.slug, switchedSlug);
  assert.match(manifest.template?.reason ?? "", /修复.*切换/);
});

test("sanitizes a fake quality loop result before attempt and final quality persistence", async () => {
  const deps = await makeWorkflowDependencies({
    scores: [82],
    hardGates: [true],
    issues: [{
      id: "fake-loop-url",
      severity: "warning",
      category: "layout",
      evidence: "https://review.invalid/fake-loop?token=fake-loop-secret",
      suggestedAction: "Keep best effort semantics",
    }],
  });
  const result = await generateSlideWorkflow(workflowInput, deps);
  assert.equal(result.status, "best_effort");
  assert.equal(result.quality.score, 82);
  assert.equal(result.quality.hardGatePassed, true);
  assert.equal(result.quality.remainingIssues[0]?.category, "layout");
  assert.equal(result.quality.remainingIssues[0]?.severity, "warning");

  const runDir = deps.runStore.runDir(result.runId);
  const attemptQuality = await readFile(join(runDir, "attempts", "01", "quality.json"), "utf8");
  const finalQuality = await readFile(join(runDir, "quality.json"), "utf8");
  const manifest = await readFile(result.artifacts.manifestPath, "utf8");
  const allLayers = `${attemptQuality}\n${finalQuality}\n${manifest}\n${JSON.stringify(result)}`;
  assert.match(allLayers, /External review diagnostic removed by safety policy/);
  assert.doesNotMatch(allLayers, /review\.invalid|fake-loop-secret/);
});
