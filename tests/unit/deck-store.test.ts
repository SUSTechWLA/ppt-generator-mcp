import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GenerateSlideOutput } from "../../src/domain/quality-report.js";
import { DeckStore } from "../../src/workflow/deck-store.js";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PLAN_ID = "22222222-2222-4222-8222-222222222222";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function makeStore(prefix = "deck-store-"): Promise<{ root: string; store: DeckStore }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, store: new DeckStore(root) };
}

function slideResult(runId: string, status: GenerateSlideOutput["status"] = "delivered"): GenerateSlideOutput {
  return {
    runId,
    status,
    selectedTemplate: { slug: "generic-layout", reason: "capabilities match" },
    artifacts: {
      htmlPath: `/safe/runs/${runId}/final.html`,
      previewPath: `/safe/runs/${runId}/final.png`,
      manifestPath: `/safe/runs/${runId}/manifest.json`,
    },
    quality: {
      score: status === "delivered" ? 95 : 82,
      threshold: 90,
      hardGatePassed: status === "delivered",
      attempts: 1,
      dimensions: {
        fidelity: 95,
        structure: 95,
        readability: 95,
        layout: 95,
        asset: 95,
        technical: 95,
      },
      remainingIssues: [],
    },
    summary: "page result",
  };
}

test("plan requests use a canonical fingerprint and resume persisted output", async () => {
  const { store } = await makeStore();
  const first = await store.createOrResumePlan({
    requestId: "personnel-pages",
    canonicalInput: { pageNumbers: [3, 7], options: { audience: "reviewer", density: "high" } },
  });
  const output = { plannedDeck: { deckPlanId: first.deckPlanId, pageNumbers: [3, 7] } };
  await store.savePlan(first.deckPlanId, output);

  const second = await store.createOrResumePlan({
    requestId: "personnel-pages",
    canonicalInput: { options: { density: "high", audience: "reviewer" }, pageNumbers: [3, 7] },
  });

  assert.equal(second.deckPlanId, first.deckPlanId);
  assert.equal(second.resumed, true);
  assert.deepEqual(second.plan, output);
  assert.deepEqual(await store.getPlan(first.deckPlanId), output);
});

test("plan request ids reject different canonical input", async () => {
  const { store } = await makeStore();
  await store.createOrResumePlan({ requestId: "personnel-pages", canonicalInput: { pageNumbers: [59, 60] } });
  await assert.rejects(
    () => store.createOrResumePlan({ requestId: "personnel-pages", canonicalInput: { pageNumbers: [61, 62] } }),
    /fingerprint mismatch/i,
  );
});

test("concurrent plan creation is idempotent across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-store-concurrent-plan-"));
  const stores = [new DeckStore(root), new DeckStore(root), new DeckStore(root)];
  const results = await Promise.all(stores.map((store) => store.createOrResumePlan({
    requestId: "concurrent-plan",
    canonicalInput: { pageNumbers: [10, 20, 30] },
  })));

  assert.equal(new Set(results.map((result) => result.deckPlanId)).size, 1);
  assert.equal(results.filter((result) => result.resumed).length, 2);
});

test("run requests resume by deckPlanId and reject request id reuse", async () => {
  const { store } = await makeStore();
  const first = await store.createOrResumeRun({
    requestId: "generate-plan-one",
    canonicalInput: { deckPlanId: PLAN_ID },
    deckPlanId: PLAN_ID,
  });
  const second = await store.createOrResumeRun({
    requestId: "generate-plan-one",
    canonicalInput: { deckPlanId: PLAN_ID },
    deckPlanId: PLAN_ID,
  });
  assert.equal(second.deckRunId, first.deckRunId);
  assert.equal(second.resumed, true);
  assert.equal(second.manifest.status, "running");

  await assert.rejects(() => store.createOrResumeRun({
    requestId: "generate-plan-one",
    canonicalInput: { deckPlanId: OTHER_PLAN_ID },
    deckPlanId: OTHER_PLAN_ID,
  }), /fingerprint mismatch/i);
  await assert.rejects(() => store.createOrResumeRun({
    requestId: "different-fields",
    canonicalInput: { deckPlanId: OTHER_PLAN_ID },
    deckPlanId: PLAN_ID,
  }), /deckPlanId mismatch/i);
});

test("assets arrive incrementally without loss and cannot be replaced", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });

  const needsAssets = await store.markNeedsAssets(run.deckRunId, ["p17-img-001", "p23-img-001", "p17-img-001"]);
  assert.equal(needsAssets.status, "needs_assets");
  assert.deepEqual(needsAssets.missingAssetIds, ["p17-img-001", "p23-img-001"]);

  await Promise.all([
    store.mergeAssetHashes(run.deckRunId, { "p17-img-001": HASH_A }),
    store.mergeAssetHashes(run.deckRunId, { "p23-img-001": HASH_B }),
  ]);
  const restored = await store.getRun(run.deckRunId);
  assert.deepEqual(restored.assetHashes, { "p17-img-001": HASH_A, "p23-img-001": HASH_B });
  assert.deepEqual(restored.missingAssetIds, []);
  assert.equal(restored.status, "running");

  await store.mergeAssetHashes(run.deckRunId, { "p17-img-001": HASH_A });
  await assert.rejects(
    () => store.mergeAssetHashes(run.deckRunId, { "p17-img-001": HASH_B }),
    /asset hash replacement/i,
  );
});

test("markNeedsAssets ignores hashes already supplied", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await store.mergeAssetHashes(run.deckRunId, { "p44-img-001": HASH_A });
  const output = await store.markNeedsAssets(run.deckRunId, ["p44-img-001"]);
  assert.equal(output.status, "running");
  assert.deepEqual(output.missingAssetIds, []);
});

test("page writes cannot move a run out of needs_assets while assets remain missing", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await store.markNeedsAssets(run.deckRunId, ["p44-img-001"]);

  await assert.rejects(
    () => store.savePageFailure(run.deckRunId, 44, { message: "asset unavailable" }),
    /assets are missing/i,
  );
  const restored = await store.getRun(run.deckRunId);
  assert.equal(restored.status, "needs_assets");
  assert.deepEqual(restored.missingAssetIds, ["p44-img-001"]);
  assert.deepEqual(restored.pages, []);
});

test("concurrent page mutations preserve every record and delivered-page state", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const pageRuns = [17, 23, 41].map(() => crypto.randomUUID());

  await Promise.all([
    store.savePageResult(run.deckRunId, 17, slideResult(pageRuns[0])),
    store.savePageResult(run.deckRunId, 23, slideResult(pageRuns[1], "best_effort")),
    store.savePageFailure(run.deckRunId, 41, new Error("render failed")),
  ]);

  assert.deepEqual((await store.listPageRecords(run.deckRunId)).map((page) => page.pageNumber), [17, 23, 41]);
  assert.equal(await store.hasDeliveredPage(run.deckRunId, 17), true);
  assert.equal(await store.hasDeliveredPage(run.deckRunId, 23), false);

  await store.savePageResult(run.deckRunId, 41, slideResult(pageRuns[2]));
  const repaired = await store.listPageRecords(run.deckRunId);
  assert.equal(repaired.length, 3);
  assert.equal(repaired.find((page) => page.pageNumber === 41)?.status, "delivered");
});

test("page failures persist bounded diagnostics without stacks, paths, or secrets", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const failure = new Error("provider failed at /Users/private/project with api_key=sk-secret-value");
  failure.stack = "STACK SHOULD NEVER BE PERSISTED";
  Object.assign(failure, { code: "PROVIDER_FAILED", retryable: true });

  await store.savePageFailure(run.deckRunId, 9, failure);
  const manifestText = await readFile(join(root, "decks", "runs", run.deckRunId, "manifest.json"), "utf8");
  const [record] = await store.listPageRecords(run.deckRunId);
  assert.equal(record.error?.code, "PROVIDER_FAILED");
  assert.equal(record.error?.retryable, true);
  assert.match(record.error?.message ?? "", /provider failed/i);
  assert.doesNotMatch(manifestText, /STACK SHOULD|\/Users\/private|sk-secret-value/);
});

test("finalize derives a truthful status and persists consistency evidence", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await store.savePageResult(run.deckRunId, 101, slideResult(crypto.randomUUID()));
  await store.savePageFailure(run.deckRunId, 305, { code: "QA_FAILED", message: "quality gate failed", retryable: false });
  const pages = await store.listPageRecords(run.deckRunId);

  const output = await store.finalizeRun(run.deckRunId, {
    pages,
    consistency: { passed: false, issues: ["heading rhythm differs"] },
  });

  assert.equal(output.status, "partial");
  assert.deepEqual(output.pages.map((page) => page.pageNumber), [101, 305]);
  assert.deepEqual(output.consistency, { passed: false, issues: ["heading rhythm differs"] });
  const artifact = await store.getArtifact(run.deckRunId, "consistency.json");
  assert.match(artifact.text ?? "", /heading rhythm differs/);
  assert.equal((await store.getRun(run.deckRunId)).status, "partial");
});

test("all delivered pages with passing consistency finalize as delivered", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await store.savePageResult(run.deckRunId, 8, slideResult(crypto.randomUUID()));
  const output = await store.finalizeRun(run.deckRunId, {
    pages: await store.listPageRecords(run.deckRunId),
    consistency: { passed: true, issues: [] },
  });
  assert.equal(output.status, "delivered");
});

test("invalid identifiers, artifact names, and asset hashes cannot become paths or keys", async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.getPlan("../escape"), /invalid deckPlanId/i);
  await assert.rejects(() => store.getRun("../escape"), /invalid deckRunId/i);
  await assert.rejects(
    () => store.getArtifact(PLAN_ID, "../../secret" as "manifest.json"),
    /invalid deck artifact name/i,
  );
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await assert.rejects(
    () => store.mergeAssetHashes(run.deckRunId, { "../../secret": HASH_A }),
    /invalid asset id/i,
  );
  await assert.rejects(
    () => store.mergeAssetHashes(run.deckRunId, { "p1-img-001": "not-a-sha256" }),
    /invalid asset hash/i,
  );
});

test("corrupted JSON fails with a bounded diagnostic instead of being treated as absent", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const path = join(root, "decks", "runs", run.deckRunId, "manifest.json");
  await writeFile(path, '{"requestFingerprint":"sensitive-fragment"', "utf8");

  await assert.rejects(
    () => store.getRun(run.deckRunId),
    (error: Error) => {
      assert.match(error.message, /corrupted deck json.*manifest/i);
      assert.doesNotMatch(error.message, /sensitive-fragment|deck-store-/);
      return true;
    },
  );
});

test("missing persisted JSON reports a logical artifact without exposing the output root", async () => {
  const { root, store } = await makeStore();
  await assert.rejects(
    () => store.getPlan(PLAN_ID),
    (error: Error) => {
      assert.match(error.message, /deck json not found.*plan\.json/i);
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("internal symlinks cannot escape the configured output root", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const outside = await mkdtemp(join(tmpdir(), "deck-store-outside-"));
  const runDirectory = join(root, "decks", "runs", run.deckRunId);
  await rm(runDirectory, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "manifest.json"), "{}", "utf8");
  await symlink(outside, runDirectory, "dir");

  await assert.rejects(() => store.getRun(run.deckRunId), /escapes the output root/i);
});

test("atomic writes leave no temporary files after concurrent updates", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.savePageFailure(
    run.deckRunId,
    index + 1,
    { message: `failure ${index + 1}` },
  )));

  const files = await readdir(join(root, "decks", "runs", run.deckRunId));
  assert.equal(files.some((file) => file.endsWith(".tmp")), false);
  assert.equal((await store.listPageRecords(run.deckRunId)).length, 8);
});
