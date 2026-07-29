import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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
