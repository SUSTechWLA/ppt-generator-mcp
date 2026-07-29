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

import { deckManifestSchema } from "../../src/domain/deck-manifest.js";
import type { GenerateSlideOutput } from "../../src/domain/quality-report.js";
import { WorkflowError } from "../../src/domain/workflow-error.js";
import { DeckStore } from "../../src/workflow/deck-store.js";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PLAN_ID = "22222222-2222-4222-8222-222222222222";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CLOSED_FAILURE = { code: "INTERNAL_ERROR" as const, message: "Page generation failed" as const, retryable: false };

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

test("saved plans are immutable while canonically identical saves are idempotent", async () => {
  const { store } = await makeStore();
  const plan = await store.createOrResumePlan({ canonicalInput: { pageNumbers: [4, 9] } });
  await store.savePlan(plan.deckPlanId, { metadata: { density: "high", audience: "reviewer" }, pages: [4, 9] });
  await store.savePlan(plan.deckPlanId, { pages: [4, 9], metadata: { audience: "reviewer", density: "high" } });

  await assert.rejects(
    () => store.savePlan(plan.deckPlanId, { pages: [4, 10], metadata: { audience: "reviewer", density: "high" } }),
    /plan replacement/i,
  );
  assert.deepEqual(await store.getPlan(plan.deckPlanId), {
    metadata: { audience: "reviewer", density: "high" },
    pages: [4, 9],
  });
});

test("concurrent different plan saves permit one immutable winner", async () => {
  const { store } = await makeStore();
  const plan = await store.createOrResumePlan({ canonicalInput: { pageNumbers: [12, 13] } });
  const candidates = [{ pages: [12, 13], variant: "alpha" }, { pages: [12, 13], variant: "beta" }];
  const outcomes = await Promise.allSettled(candidates.map((candidate) => store.savePlan(plan.deckPlanId, candidate)));

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const persisted = await store.getPlan(plan.deckPlanId);
  assert.equal(candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(persisted)), true);
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

test("delivered page records are immutable and win concurrent delivery/failure races", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const delivered = slideResult(crypto.randomUUID());
  const race = await Promise.allSettled([
    store.savePageResult(run.deckRunId, 77, delivered),
    store.savePageFailure(run.deckRunId, 77, { code: "LATE_FAILURE", message: "late worker failed" }),
  ]);
  assert.equal(race.some((outcome) => outcome.status === "fulfilled"), true);
  assert.equal((await store.listPageRecords(run.deckRunId))[0]?.status, "delivered");

  await store.savePageResult(run.deckRunId, 77, delivered);
  await assert.rejects(
    () => store.savePageResult(run.deckRunId, 77, { ...delivered, summary: "different result" }),
    /delivered page.*immutable/i,
  );
  await assert.rejects(
    () => store.savePageFailure(run.deckRunId, 77, { message: "late failure" }),
    /delivered page.*immutable/i,
  );
});

test("non-delivered page records can be replaced by later retry outcomes", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const renderFailure = new WorkflowError({
    code: "RENDER_FAILED",
    stage: "compose_html",
    retryable: true,
    message: "first attempt failed",
  });
  const qualityFailure = new WorkflowError({
    code: "QUALITY_FAILED",
    stage: "quality_loop",
    retryable: true,
    message: "second attempt failed",
  });
  const firstBestEffort = slideResult(crypto.randomUUID(), "best_effort");
  const secondBestEffort = { ...slideResult(crypto.randomUUID(), "best_effort"), summary: "new retry result" };

  await store.savePageFailure(run.deckRunId, 31, renderFailure);
  await store.savePageFailure(run.deckRunId, 31, qualityFailure);
  assert.equal((await store.listPageRecords(run.deckRunId)).find((page) => page.pageNumber === 31)?.error?.code, "QUALITY_FAILED");

  await store.savePageResult(run.deckRunId, 32, firstBestEffort);
  await store.savePageResult(run.deckRunId, 32, secondBestEffort);
  assert.equal((await store.listPageRecords(run.deckRunId)).find((page) => page.pageNumber === 32)?.runId, secondBestEffort.runId);

  await store.savePageFailure(run.deckRunId, 33, renderFailure);
  await store.savePageResult(run.deckRunId, 33, firstBestEffort);
  assert.equal((await store.listPageRecords(run.deckRunId)).find((page) => page.pageNumber === 33)?.status, "best_effort");

  await store.savePageResult(run.deckRunId, 34, firstBestEffort);
  await store.savePageFailure(run.deckRunId, 34, qualityFailure);
  assert.equal((await store.listPageRecords(run.deckRunId)).find((page) => page.pageNumber === 34)?.status, "failed");

  await store.savePageFailure(run.deckRunId, 34, qualityFailure);
  assert.equal((await store.listPageRecords(run.deckRunId)).find((page) => page.pageNumber === 34)?.status, "failed");
});

test("delivery wins concurrent retry mutations for the same nonterminal page", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await store.savePageFailure(run.deckRunId, 88, { message: "initial failure" });
  const delivered = slideResult(crypto.randomUUID());
  const retry = slideResult(crypto.randomUUID(), "best_effort");

  await Promise.allSettled([
    store.savePageResult(run.deckRunId, 88, retry),
    store.savePageResult(run.deckRunId, 88, delivered),
    store.savePageFailure(run.deckRunId, 88, { message: "late failure" }),
  ]);

  const page = (await store.listPageRecords(run.deckRunId)).find((record) => record.pageNumber === 88);
  assert.equal(page?.status, "delivered");
  assert.equal(page?.runId, delivered.runId);
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
  assert.deepEqual(record.error, { code: "INTERNAL_ERROR", message: "Page generation failed", retryable: false });
  assert.doesNotMatch(manifestText, /STACK SHOULD|\/Users\/private|sk-secret-value/);
});

test("page failure diagnostics redact generic paths, URLs, and credential forms", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const message = [
    "provider failed at /etc/ssl/private/key.pem",
    "client_secret=hunter2 access_token=abc123 Bearer bearer-value",
    'auth=plain-auth "client_secret":"json-secret" x-api-key:header-key Authorization: Basic basic-value',
    "OPENAI_API_KEY=openai-secret DATABASE_URL=postgres://db-user:db-pass@example.invalid/app FTP=ftp://ftp-user:ftp-pass@example.invalid/file",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.jwt-signature",
    "../relative/secrets.json C:\\private\\token.txt \\\\server\\share\\key.pem",
    "https://example.invalid/callback?api_key=query-secret&token=url-token",
  ].join("; ");
  await store.savePageFailure(run.deckRunId, 19, { code: "PROVIDER_FAILED", retryable: true, message });

  const text = await readFile(join(root, "decks", "runs", run.deckRunId, "manifest.json"), "utf8");
  const [record] = await store.listPageRecords(run.deckRunId);
  assert.deepEqual(record.error, { code: "INTERNAL_ERROR", message: "Page generation failed", retryable: false });
  assert.doesNotMatch(text, /provider failed|\/etc\/ssl|hunter2|abc123|bearer-value|plain-auth|json-secret|header-key|basic-value|openai-secret|db-user|db-pass|ftp-user|ftp-pass|jwt-signature|relative\/secrets|C:\\private|server\\share|query-secret|url-token/);
});

test("allowlisted WorkflowError metadata persists with a closed generic message", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const error = new WorkflowError({
    code: "RENDER_FAILED",
    stage: "compose_html",
    retryable: true,
    message: "render exposed OPENAI_API_KEY=must-not-persist at /etc/private/key.pem",
  });

  await store.savePageFailure(run.deckRunId, 20, error);
  const [record] = await store.listPageRecords(run.deckRunId);
  assert.deepEqual(record.error, {
    code: "RENDER_FAILED",
    stage: "compose_html",
    message: "Page rendering failed",
    retryable: true,
  });
  const text = await readFile(join(root, "decks", "runs", run.deckRunId, "manifest.json"), "utf8");
  assert.doesNotMatch(text, /must-not-persist|\/etc\/private/);
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

test("a delivered run remains terminal under idempotent and conflicting continuation calls", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const result = slideResult(crypto.randomUUID());
  await store.savePageResult(run.deckRunId, 8, result);
  await store.finalizeRun(run.deckRunId, {
    pages: await store.listPageRecords(run.deckRunId),
    consistency: { passed: true, issues: [] },
  });

  assert.equal((await store.savePageResult(run.deckRunId, 8, result)).status, "delivered");
  assert.equal((await store.markNeedsAssets(run.deckRunId, [])).status, "delivered");
  await assert.rejects(() => store.markNeedsAssets(run.deckRunId, ["p8-img-001"]), /delivered deck run.*immutable/i);
  await assert.rejects(() => store.mergeAssetHashes(run.deckRunId, { "p8-img-001": HASH_A }), /delivered deck run.*immutable/i);
  await assert.rejects(() => store.savePageFailure(run.deckRunId, 9, { message: "late failure" }), /delivered deck run.*immutable/i);
  assert.equal((await store.getRun(run.deckRunId)).status, "delivered");
});

test("finalize rejects attempts to erase or replace a delivered page", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const result = slideResult(crypto.randomUUID());
  await store.savePageResult(run.deckRunId, 51, result);

  await assert.rejects(
    () => store.finalizeRun(run.deckRunId, {
      pages: [{ pageNumber: 51, status: "delivered", runId: result.runId, result: { ...result, summary: "forged replacement" } }],
      consistency: { passed: true, issues: [] },
    }),
    /delivered page.*immutable/i,
  );
  await assert.rejects(
    () => store.finalizeRun(run.deckRunId, {
      pages: [{ pageNumber: 52, status: "failed", error: CLOSED_FAILURE }],
      consistency: { passed: true, issues: [] },
    }),
    /cannot omit delivered page/i,
  );
});

test("finalize cannot report delivered when consistency fails", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  await store.savePageResult(run.deckRunId, 68, slideResult(crypto.randomUUID()));
  const output = await store.finalizeRun(run.deckRunId, {
    pages: await store.listPageRecords(run.deckRunId),
    consistency: { passed: false, issues: ["visual inconsistency"] },
  });
  assert.equal(output.status, "partial");
});

test("manifest schema rejects delivered state with failed pages or consistency", async () => {
  const { store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const base = await store.getRun(run.deckRunId);
  const failedPage = { pageNumber: 68, status: "failed" as const, error: CLOSED_FAILURE };
  assert.equal(deckManifestSchema.safeParse({ ...base, status: "delivered", pages: [failedPage] }).success, false);
  const delivered = slideResult(crypto.randomUUID());
  const deliveredPage = { pageNumber: 68, status: "delivered" as const, runId: delivered.runId, result: delivered };
  assert.equal(deckManifestSchema.safeParse({
    ...base,
    status: "delivered",
    pages: [deliveredPage],
    consistency: { passed: false, issues: ["not consistent"] },
  }).success, false);
  assert.equal(deckManifestSchema.safeParse({
    ...base,
    status: "running",
    missingAssetIds: ["p68-img-001"],
  }).success, false);
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

test("artifact lookup maps missing and filesystem errors to bounded logical diagnostics", async () => {
  const { root, store } = await makeStore();
  await assert.rejects(
    () => store.getArtifact(PLAN_ID, "manifest.json"),
    (error: Error) => {
      assert.match(error.message, /deck artifact not found.*manifest\.json/i);
      assert.doesNotMatch(error.message, /deck-store-|11111111/);
      return true;
    },
  );

  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const manifestPath = join(root, "decks", "runs", run.deckRunId, "manifest.json");
  await rm(manifestPath);
  await mkdir(manifestPath);
  await assert.rejects(
    () => store.getArtifact(run.deckRunId, "manifest.json"),
    (error: Error) => {
      assert.match(error.message, /unable to read deck artifact.*manifest\.json/i);
      assert.doesNotMatch(error.message, new RegExp(`${run.deckRunId}|${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      return true;
    },
  );
});

test("artifact lookup hides physical paths when a symlink escapes the root", async () => {
  const { root, store } = await makeStore();
  const run = await store.createOrResumeRun({ canonicalInput: { deckPlanId: PLAN_ID }, deckPlanId: PLAN_ID });
  const outside = await mkdtemp(join(tmpdir(), "deck-artifact-outside-"));
  const outsideFile = join(outside, "consistency.json");
  await writeFile(outsideFile, "{}", "utf8");
  await symlink(outsideFile, join(root, "decks", "runs", run.deckRunId, "consistency.json"), "file");

  await assert.rejects(
    () => store.getArtifact(run.deckRunId, "consistency.json"),
    (error: Error) => {
      assert.match(error.message, /deck artifact unavailable.*consistency\.json.*unsafe path/i);
      assert.doesNotMatch(error.message, new RegExp(`${run.deckRunId}|${outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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
