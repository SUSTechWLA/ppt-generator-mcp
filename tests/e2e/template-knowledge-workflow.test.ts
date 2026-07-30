import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTemplateFromReference } from "../../src/workflow/create-template-from-reference.js";
import { TemplateKnowledgeStore } from "../../src/workflow/template-knowledge-store.js";
import { hashCanonical } from "../../src/domain/source-document.js";
import { templateBlueprintSchema } from "../../src/domain/template-blueprint.js";
import { compileTemplateBlueprint } from "../../src/services/template-blueprint-compiler.js";
import { ONE_PIXEL_PNG, validImageTemplateBlueprint, validMetricTemplateBlueprint, validTemplateBlueprint } from "../helpers/template-knowledge-fixtures.js";

function approvalInput(index: number) {
  const blueprint = templateBlueprintSchema.parse(validTemplateBlueprint({ slugSeed: `concurrent-layout-${index}` }));
  const compiled = compileTemplateBlueprint(blueprint);
  return {
    requestId: `concurrent-request-${index}`,
    requestFingerprint: hashCanonical({ request: index }),
    sourceType: "blueprint" as const,
    sourceHash: hashCanonical({ source: index }),
    blueprint,
    html: compiled.html,
    profile: compiled.profile,
    quality: {
      chromiumRendered: true as const,
      hardGatePassed: true as const,
      safeToReturn: true as const,
      score: 100,
      evidenceVersion: 2 as const,
      imageEvidenceStatus: "measured" as const,
      imageCount: 0,
      rasterAreaRatio: 0,
      containmentViolations: 0 as const,
      collisions: 0 as const,
      issues: [],
    },
    preview: Buffer.from("89504e470d0a1a0a", "hex"),
  };
}

test("image without analyzer returns stable handoff and persists nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-no-analyzer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TemplateKnowledgeStore(root);
  const first = await createTemplateFromReference({ referenceImageDataUrl: ONE_PIXEL_PNG, requestId: "image-handoff-01" }, { store });
  const second = await createTemplateFromReference({ referenceImageDataUrl: ONE_PIXEL_PNG, requestId: "image-handoff-01" }, { store });
  assert.equal(first.status, "needs_analysis");
  assert.deepEqual(first, second);
  if (first.status !== "needs_analysis") return;
  assert.match(first.analysisPrompt, /layout|do not transcribe|logo|watermark/i);
  assert.equal((first.blueprintSchema as { additionalProperties?: boolean }).additionalProperties, false);
  const publicContract = first.blueprintSchema as {
    $comment?: string;
    "x-roleComponentMapping"?: Record<string, string>;
    "x-serverValidation"?: Array<{ id: string; description: string }>;
  };
  assert.match(publicContract.$comment ?? "", /JSON Schema.*serverValidation contract/i);
  assert.deepEqual(publicContract["x-roleComponentMapping"], {
    title: "title-band", body: "fact-card", metric: "metric-card", process: "process-card",
    evidence: "evidence-card", image: "image-card", conclusion: "conclusion-band", "page-number": "page-number",
  });
  const constraints = new Map((publicContract["x-serverValidation"] ?? []).map((entry) => [entry.id, entry.description]));
  for (const id of [
    "unique-region-ids", "unique-capability-tags", "required-role-cardinality", "grid-containment",
    "role-component-mapping", "capability-region-bidirectional", "single-enabled-image-region",
    "disabled-image-zero-state", "screenshot-background-forbidden", "visual-ratio-total", "wcag-contrast-4.5",
  ]) assert.ok(constraints.get(id), `missing public serverValidation contract ${id}`);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(lstat(join(root, "records")));
  assert.doesNotMatch(JSON.stringify(first), /base64|iVBOR|data:image/i);
  await assert.rejects(
    createTemplateFromReference({ referenceImageDataUrl: "data:image/png;base64,AAAA", requestId: "image-handoff-01" }, { store }),
    /fingerprint mismatch/i,
  );
  await assert.rejects(
    createTemplateFromReference({ blueprint: validTemplateBlueprint(), requestId: "image-handoff-01" }, { store }),
    /fingerprint mismatch/i,
  );
});

test("caller blueprint receives real Chromium QA and one immutable approved record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-approved-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TemplateKnowledgeStore(root);
  const input = { blueprint: validTemplateBlueprint(), requestId: "approve-blueprint-01" };
  const first = await createTemplateFromReference(input, { store });
  const second = await createTemplateFromReference(input, { store });
  assert.equal(first.status, "approved");
  assert.deepEqual(first, second);
  if (first.status !== "approved") return;
  assert.equal(first.quality.hardGatePassed, true, JSON.stringify(first.quality.issues));
  assert.equal(first.quality.chromiumRendered, true);
  assert.equal((await store.list()).length, 1);
  const html = await store.getArtifact(first.knowledgeId, "template.html");
  assert.match(html.text, /data-template-slug="balanced-evidence-layout"/);
  assert.doesNotMatch(html.text, /data:image|background-image|https?:\/\//i);
  await assert.rejects(
    createTemplateFromReference({ blueprint: validTemplateBlueprint({ displayName: "Changed" }), requestId: "approve-blueprint-01" }, { store }),
    /fingerprint mismatch/i,
  );
  await assert.rejects(
    createTemplateFromReference({ referenceImageDataUrl: ONE_PIXEL_PNG, requestId: "approve-blueprint-01" }, { store }),
    /fingerprint mismatch/i,
  );
});

test("different requests never lose approvals across concurrent store instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-concurrent-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = [new TemplateKnowledgeStore(root), new TemplateKnowledgeStore(root)];
  const inputs = Array.from({ length: 16 }, (_, index) => approvalInput(index + 1));
  const approved = await Promise.all(inputs.map((input, index) => stores[index % stores.length].approve(input)));
  const records = await stores[0].list();
  assert.equal(records.length, approved.length);
  assert.deepEqual(new Set(records.map((record) => record.knowledgeId)), new Set(approved.map((record) => record.knowledgeId)));
  const directories = (await readdir(join(root, "records"))).sort();
  assert.deepEqual(directories, approved.map((record) => record.knowledgeId).sort());
  const index = JSON.parse(await readFile(join(root, "knowledge-index.json"), "utf8")) as { version: number; records: Array<{ knowledgeId: string }>; requests: Record<string, { knowledgeId: string }> };
  assert.equal(index.version, 2);
  assert.equal(index.records.length, approved.length);
  for (const [position, input] of inputs.entries()) assert.equal(index.requests[input.requestId].knowledgeId, approved[position].knowledgeId);
});

test("image approval renders a real raster and enforces the declared raster-area gate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-image-qa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TemplateKnowledgeStore(root);
  await assert.rejects(
    createTemplateFromReference({ blueprint: validImageTemplateBlueprint(0.05), requestId: "image-raster-too-large" }, { store }),
    /Chromium quality gates/i,
  );
  const approved = await createTemplateFromReference({ blueprint: validImageTemplateBlueprint(0.4), requestId: "image-raster-valid" }, { store });
  assert.equal(approved.status, "approved");
  if (approved.status !== "approved") return;
  assert.equal(approved.quality.evidenceVersion, 2);
  if (approved.quality.evidenceVersion !== 2) return;
  assert.equal(approved.quality.imageCount, 1);
  assert.ok(approved.quality.rasterAreaRatio > 0.1 && approved.quality.rasterAreaRatio < 0.4);
  assert.equal(approved.quality.containmentViolations, 0);
  assert.equal(approved.quality.collisions, 0);
  const qa = JSON.parse((await store.getArtifact(approved.knowledgeId, "qa.json")).text) as typeof approved.quality;
  assert.deepEqual(qa, approved.quality);
});

test("metric blueprint compiles, renders and approves through the real workflow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-metric-qa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const approved = await createTemplateFromReference({ blueprint: validMetricTemplateBlueprint(), requestId: "metric-blueprint-approve" }, {
    store: new TemplateKnowledgeStore(root),
  });
  assert.equal(approved.status, "approved");
  if (approved.status !== "approved") return;
  assert.deepEqual(approved.capabilityTags, ["detail", "metric", "formal"]);
  assert.equal(approved.quality.hardGatePassed, true, JSON.stringify(approved.quality.issues));
});

test("safe HTML and configured image analysis both compile generic knowledge without source material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-reference-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TemplateKnowledgeStore(root);
  const html = await createTemplateFromReference({
    referenceHtml: `<!doctype html><html><head><style>body{background:#ffffff;color:#17241e}main{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.card{grid-column:span 6;background:#f4f7f6}</style></head><body><header>PRIVATE BRAND</header><main><section class="card">PRIVATE BODY ONE</section><section class="card">PRIVATE BODY TWO</section></main><footer>PRIVATE WATERMARK</footer></body></html>`,
    requestId: "safe-html-reference-01",
  }, { store });
  assert.equal(html.status, "approved");
  const image = await createTemplateFromReference({ referenceImageDataUrl: ONE_PIXEL_PNG, requestId: "analyzed-image-reference-01" }, {
    store,
    analyzeReferenceImage: async () => validTemplateBlueprint({ slugSeed: "analyzed-image-layout" }),
  });
  assert.equal(image.status, "approved");
  const serializedArtifacts = (await store.list()).map(async (record) => (await store.getArtifact(record.knowledgeId, "template.html")).text);
  const templates = (await Promise.all(serializedArtifacts)).join("\n");
  assert.doesNotMatch(templates, /PRIVATE BRAND|PRIVATE BODY|PRIVATE WATERMARK|iVBOR|data:image/i);
  assert.equal((await store.list()).length, 2);
});

test("unsafe HTML references fail before approval and never persist records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-unsafe-html-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TemplateKnowledgeStore(root);
  for (const referenceHtml of [
    `<html><body><script>alert(1)</script></body></html>`,
    `<html><body onclick="alert(1)">x</body></html>`,
    `<html><body><iframe srcdoc="<p>x</p>"></iframe></body></html>`,
    `<html><body><template shadowrootmode="open"><p>x</p></template></body></html>`,
    `<html><head><style>.x{background:url(data:image/png;base64,AAAA)}</style></head><body>x</body></html>`,
    `<html><body><img src="file:///private/secret.png"></body></html>`,
  ]) await assert.rejects(createTemplateFromReference({ referenceHtml }, { store }), /unsafe reference html/i);
  assert.deepEqual(await store.list(), []);
});

test("store artifact reads fail closed for unknown, symlink, non-regular, escape and corrupted records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-store-safety-"));
  const outside = await mkdtemp(join(tmpdir(), "knowledge-store-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const store = new TemplateKnowledgeStore(root);
  const approved = await createTemplateFromReference({ blueprint: validTemplateBlueprint(), requestId: "store-safety-01" }, { store });
  assert.equal(approved.status, "approved");
  if (approved.status !== "approved") return;
  await assert.rejects(store.getArtifact("00000000-0000-4000-8000-000000000000", "template.html"), /not found/i);
  await assert.rejects(store.getArtifact(approved.knowledgeId, "unknown.json" as "template.html"), /invalid artifact/i);
  const recordDir = join(root, "records", approved.knowledgeId);
  await writeFile(join(outside, "secret"), "secret");
  await rm(join(recordDir, "template.html"));
  await symlink(join(outside, "secret"), join(recordDir, "template.html"));
  await assert.rejects(store.getArtifact(approved.knowledgeId, "template.html"), /unsafe storage entry/i);
  await rm(join(recordDir, "template.html"));
  await mkdir(join(recordDir, "template.html"));
  await assert.rejects(store.getArtifact(approved.knowledgeId, "template.html"), /unsafe storage entry/i);
  await writeFile(join(root, "knowledge-index.json"), "{broken");
  await assert.rejects(store.list(), /unavailable|corrupt/i);
});

test("store list rejects a symlinked root or index instead of trusting external records", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "knowledge-list-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "knowledge-list-external-"));
  t.after(() => Promise.all([rm(parent, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, "knowledge-index.json"), JSON.stringify({ version: 1, records: [], requests: {} }));
  const linkedRoot = join(parent, "linked-root");
  await symlink(outside, linkedRoot);
  await assert.rejects(new TemplateKnowledgeStore(linkedRoot).list(), /unsafe|unavailable/i);

  const safeRoot = join(parent, "safe-root");
  await mkdir(safeRoot);
  await symlink(join(outside, "knowledge-index.json"), join(safeRoot, "knowledge-index.json"));
  await assert.rejects(new TemplateKnowledgeStore(safeRoot).list(), /unsafe|unavailable/i);
});

test("mutations reject a symlinked root before creating anything in the external target", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "knowledge-zero-side-effect-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const operation of ["approve", "reserve"] as const) {
    const outside = join(parent, `outside-${operation}`);
    const linkedRoot = join(parent, `linked-${operation}`);
    await mkdir(outside);
    await symlink(outside, linkedRoot);
    const store = new TemplateKnowledgeStore(linkedRoot);
    if (operation === "approve") await assert.rejects(store.approve(approvalInput(90)), /unsafe|unavailable/i);
    else await assert.rejects(store.reserveAnalysisRequest("symlink-analysis-request", "a".repeat(64)), /unsafe|unavailable/i);
    assert.deepEqual(await readdir(outside), []);
  }
});

test("legacy v1 approved records remain readable and idempotent without claiming measured image QA", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-legacy-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledgeId = "11111111-1111-4111-8111-111111111111";
  const requestId = "legacy-approved-request";
  const fingerprint = "a".repeat(64);
  const legacyRecord = {
    recordVersion: 1,
    knowledgeId,
    templateVersion: 1,
    sourceType: "blueprint",
    sourceHash: "b".repeat(64),
    slug: "legacy-layout",
    capabilityTags: ["detail", "formal"],
    quality: { chromiumRendered: true, hardGatePassed: true, safeToReturn: true, score: 96, issues: [] },
    artifacts: ["blueprint.json", "template.html", "profile.json", "qa.json", "preview.png"],
    createdAt: "2026-07-29T00:00:00.000Z",
    requestId,
    requestFingerprint: fingerprint,
  };
  const legacyIndex = { version: 1, records: [legacyRecord], requests: { [requestId]: { fingerprint, knowledgeId } } };
  await writeFile(join(root, "knowledge-index.json"), `${JSON.stringify(legacyIndex)}\n`);
  const store = new TemplateKnowledgeStore(root);
  const first = await store.list();
  const second = await store.list();
  assert.deepEqual(first, second);
  assert.equal(first[0].quality.evidenceVersion, 1);
  assert.equal(first[0].quality.imageEvidenceStatus, "not-recorded");
  assert.equal("imageCount" in first[0].quality, false);
  assert.equal((await store.findRequest(requestId, fingerprint))?.knowledgeId, knowledgeId);
  assert.equal((await store.reserveAnalysisRequest(requestId, fingerprint))?.knowledgeId, knowledgeId);
  const replay = await store.approve({ ...approvalInput(77), requestId, requestFingerprint: fingerprint });
  assert.equal(replay.knowledgeId, knowledgeId);
  assert.deepEqual(JSON.parse(await readFile(join(root, "knowledge-index.json"), "utf8")), legacyIndex);
});

test("malformed legacy v1 request entries still fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-legacy-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "knowledge-index.json"), JSON.stringify({
    version: 1,
    records: [],
    requests: { corrupt: { fingerprint: "a".repeat(64) } },
  }));
  await assert.rejects(new TemplateKnowledgeStore(root).list(), /unavailable|corrupt/i);
});

test("legacy v1 pending analysis fingerprints retain the unified request boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-legacy-analysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestId = "legacy-analysis-request";
  const fingerprint = "c".repeat(64);
  await writeFile(join(root, "analysis-request-index.json"), JSON.stringify({ [requestId]: fingerprint }));
  const store = new TemplateKnowledgeStore(root);
  await assert.rejects(store.reserveAnalysisRequest(requestId, "d".repeat(64)), /fingerprint mismatch/i);
  await assert.rejects(store.approve({ ...approvalInput(78), requestId, requestFingerprint: "d".repeat(64) }), /fingerprint mismatch/i);
  assert.equal(await store.reserveAnalysisRequest(requestId, fingerprint), undefined);
  const approved = await store.approve({ ...approvalInput(78), requestId, requestFingerprint: fingerprint });
  assert.equal(approved.quality.evidenceVersion, 2);
  assert.equal((await store.findRequest(requestId, fingerprint))?.knowledgeId, approved.knowledgeId);
});

test("invalid prepared evidence starts no writes and emits no unhandled rejection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-preflight-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const invalid = {
      ...approvalInput(81),
      html: "x".repeat(20 * 1024 * 1024),
      quality: { chromiumRendered: true, hardGatePassed: true, safeToReturn: true, score: Number.NaN, issues: [] },
    };
    await assert.rejects(new TemplateKnowledgeStore(root).approve(invalid as never));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(await readdir(root), []);
});

test("settled write rollback removes records and temps, releases the root lock, and permits retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-write-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failProfileWrite = true;
  const store = new TemplateKnowledgeStore(root, {
    writeFile: async (path, value) => {
      if (failProfileWrite && String(path).includes("profile.json.")) {
        failProfileWrite = false;
        throw new Error("injected artifact write failure");
      }
      return writeFile(path, value);
    },
  });
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await assert.rejects(store.approve(approvalInput(82)), /injected artifact write failure/);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  const afterFailure = await readdir(root, { recursive: true });
  assert.deepEqual(unhandled, []);
  assert.equal(afterFailure.some((entry) => entry.endsWith(".tmp") || /records\/[0-9a-f-]{36}/i.test(entry)), false, afterFailure.join("\n"));
  assert.deepEqual(await readdir(root), []);
  const approved = await store.approve(approvalInput(83));
  assert.equal(approved.quality.evidenceVersion, 2);
  assert.equal((await store.list()).length, 1);
});
