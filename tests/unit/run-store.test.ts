import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore } from "../../src/workflow/run-store.js";
import { canonicalInput } from "../helpers/domain-fixtures.js";

test("resumes the same request fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-"));
  const store = new RunStore(root);
  const first = await store.createOrResume({ requestId: "request-123", canonicalInput });
  const second = await store.createOrResume({ requestId: "request-123", canonicalInput });
  assert.equal(second.runId, first.runId);
  assert.equal(second.resumed, true);
});

test("rejects requestId reuse with different input", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-"));
  const store = new RunStore(root);
  await store.createOrResume({ requestId: "request-123", canonicalInput });
  await assert.rejects(
    () => store.createOrResume({ requestId: "request-123", canonicalInput: { ...canonicalInput, audience: "不同受众" } }),
    /fingerprint/i,
  );
  await assert.rejects(() => store.getArtifact("../escape", "manifest.json"), /invalid runId/i);
});

test("persists stage output and resumes after interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-stage-"));
  const store = new RunStore(root);
  const run = await store.createOrResume({ requestId: "request-stage", canonicalInput });
  await store.updateStage(run.runId, "normalize_input", { status: "running", startedAt: new Date().toISOString() });
  await store.writeStageOutput(run.runId, "normalize_input", { title: "已规范化" });
  await store.updateStage(run.runId, "normalize_input", { status: "completed", completedAt: new Date().toISOString() });
  const restored = await store.readStageOutput<{ title: string }>(run.runId, "normalize_input");
  assert.equal(restored.found, true);
  if (restored.found) assert.equal(restored.value.title, "已规范化");
});

test("limits artifact lookup to a closed name set", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-artifact-"));
  const store = new RunStore(root);
  const run = await store.createOrResume({ canonicalInput });
  await assert.rejects(() => store.getArtifact(run.runId, "../secret" as "manifest.json"), /invalid artifact/i);
});
