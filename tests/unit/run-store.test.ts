import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

test("artifact lookup rejects external and internal symlinks with closed diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "ppt-runs-secret-"));
  const store = new RunStore(root);
  const run = await store.createOrResume({ canonicalInput });
  const outsideSecret = join(outside, "outside-secret.html");
  await writeFile(outsideSecret, "OUTSIDE_SECRET_CANARY", "utf8");
  await symlink(outsideSecret, join(store.runDir(run.runId), "final.html"), "file");

  await assert.rejects(
    () => store.getArtifact(run.runId, "final.html"),
    (error: Error) => {
      assert.match(error.message, /artifact.*(?:unsafe|unavailable)/i);
      assert.doesNotMatch(error.message, /OUTSIDE_SECRET_CANARY|ppt-runs-secret-|outside-secret|\/private\/|\/Users\//i);
      return true;
    },
  );

  await writeFile(join(store.runDir(run.runId), "internal.html"), "safe", "utf8");
  await symlink(join(store.runDir(run.runId), "internal.html"), join(store.runDir(run.runId), "quality.json"), "file");
  await assert.rejects(() => store.getArtifact(run.runId, "quality.json"), /artifact.*(?:unsafe|unavailable)/i);
});

test("artifact lookup rejects a symlinked run directory and non-regular artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-component-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "ppt-runs-component-outside-"));
  const store = new RunStore(root);
  const run = await store.createOrResume({ canonicalInput });
  const runDirectory = store.runDir(run.runId);
  await rm(runDirectory, { recursive: true });
  await writeFile(join(outside, "manifest.json"), "RUN_DIRECTORY_SECRET", "utf8");
  await symlink(outside, runDirectory, "dir");
  await assert.rejects(
    () => store.getArtifact(run.runId, "manifest.json"),
    (error: Error) => {
      assert.match(error.message, /artifact.*(?:unsafe|unavailable)/i);
      assert.doesNotMatch(error.message, /RUN_DIRECTORY_SECRET|component-outside|\/private\/|\/Users\//i);
      return true;
    },
  );

  await rm(runDirectory);
  await mkdir(runDirectory);
  await mkdir(join(runDirectory, "final.html"));
  await assert.rejects(() => store.getArtifact(run.runId, "final.html"), /artifact.*unavailable/i);
});

test("internal consistency read accepts bounded large HTML while public artifact text remains capped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-internal-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root, {
    maxImageBytes: 600 * 1024,
    maxAssets: 2,
    maxInputChars: 2_000,
  });
  const run = await store.createOrResume({ canonicalInput });
  const largeHtml = `<html><body>${"x".repeat(700 * 1024)}</body></html>`;
  await writeFile(join(store.runDir(run.runId), "final.html"), largeHtml, "utf8");

  const publicArtifact = await store.getArtifact(run.runId, "final.html");
  assert.ok(publicArtifact.size > 512 * 1024);
  assert.equal(publicArtifact.text, undefined);

  const internalArtifact = await store.readFinalHtmlForConsistency(run.runId, 1);
  assert.equal(internalArtifact.size, Buffer.byteLength(largeHtml));
  assert.equal(internalArtifact.text, largeHtml);
  assert.equal("path" in internalArtifact, false, "internal consumers must not receive physical storage paths");
});

test("internal consistency read fails closed for over-budget, symlink, directory and escaped storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-internal-unsafe-"));
  const outside = await mkdtemp(join(tmpdir(), "ppt-runs-internal-secret-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const store = new RunStore(root, {
    maxImageBytes: 1_024,
    maxAssets: 1,
    maxInputChars: 100,
  });
  const overBudget = await store.createOrResume({ canonicalInput: { kind: "over-budget" } });
  const overBudgetCanary = "OVER_BUDGET_PRIVATE_CONTENT";
  await writeFile(
    join(store.runDir(overBudget.runId), "final.html"),
    `<html>${overBudgetCanary}${"x".repeat(20 * 1024 * 1024)}</html>`,
    "utf8",
  );
  await assert.rejects(
    () => store.readFinalHtmlForConsistency(overBudget.runId, 1),
    (error: Error) => {
      assert.match(error.message, /artifact.*unavailable/i);
      assert.doesNotMatch(error.message, new RegExp(`${overBudgetCanary}|${root}|${outside}`));
      return true;
    },
  );

  const symlinkRun = await store.createOrResume({ canonicalInput: { kind: "symlink" } });
  const symlinkCanary = "SYMLINK_PRIVATE_CONTENT";
  const outsideFile = join(outside, "secret.html");
  await writeFile(outsideFile, symlinkCanary, "utf8");
  await symlink(outsideFile, join(store.runDir(symlinkRun.runId), "final.html"), "file");
  await assert.rejects(
    () => store.readFinalHtmlForConsistency(symlinkRun.runId, 1),
    (error: Error) => {
      assert.match(error.message, /artifact.*unavailable/i);
      assert.doesNotMatch(error.message, new RegExp(`${symlinkCanary}|${root}|${outside}`));
      return true;
    },
  );

  const directoryRun = await store.createOrResume({ canonicalInput: { kind: "directory" } });
  await mkdir(join(store.runDir(directoryRun.runId), "final.html"));
  await assert.rejects(
    () => store.readFinalHtmlForConsistency(directoryRun.runId, 0),
    /artifact.*unavailable/i,
  );

  const rootLink = join(tmpdir(), `ppt-runs-internal-root-link-${Date.now()}`);
  const realRoot = await mkdtemp(join(tmpdir(), "ppt-runs-internal-root-real-"));
  t.after(async () => {
    await rm(rootLink, { recursive: true, force: true });
    await rm(realRoot, { recursive: true, force: true });
  });
  const rootStore = new RunStore(realRoot, {
    maxImageBytes: 1_024,
    maxAssets: 1,
    maxInputChars: 100,
  });
  const rootRun = await rootStore.createOrResume({ canonicalInput: { kind: "root-link" } });
  await writeFile(join(rootStore.runDir(rootRun.runId), "final.html"), "ROOT_LINK_PRIVATE_CONTENT", "utf8");
  await rename(realRoot, rootLink);
  await symlink(rootLink, realRoot, "dir");
  await assert.rejects(
    () => rootStore.readFinalHtmlForConsistency(rootRun.runId, 0),
    (error: Error) => {
      assert.match(error.message, /artifact.*unavailable/i);
      assert.doesNotMatch(error.message, /ROOT_LINK_PRIVATE_CONTENT|ppt-runs-internal-root/i);
      return true;
    },
  );
});

test("normalizes quality diagnostics before RunStore writes the first attempt artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-safe-attempt-"));
  const store = new RunStore(root);
  const run = await store.createOrResume({ canonicalInput });
  const attemptDir = join(store.runDir(run.runId), "attempts", "01");
  await store.saveAttempt(run.runId, {
    attempt: 1,
    htmlPath: join(attemptDir, "page.html"),
    previewPath: join(attemptDir, "preview.png"),
    qualityPath: join(attemptDir, "quality.json"),
    score: 95,
    hardGatePassed: true,
    safeToReturn: true,
    actions: [],
  }, {
    quality: {
      score: 95,
      safeToReturn: true,
      hardGatePassed: true,
      dimensions: { fidelity: 95, structure: 95, readability: 95, layout: 95, asset: 95, technical: 95 },
      issues: [{
        id: "unsafe-attempt-warning",
        severity: "warning",
        category: "technical",
        evidence: "https://review.invalid/private?token=attempt-secret",
        suggestedAction: "Bearer attempt-credential",
      }],
    },
  });

  const persisted = await readFile(join(attemptDir, "quality.json"), "utf8");
  assert.match(persisted, /External review diagnostic removed by safety policy/);
  assert.doesNotMatch(persisted, /attempt-secret|attempt-credential|review\.invalid/);
});
