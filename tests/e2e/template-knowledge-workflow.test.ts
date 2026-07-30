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
import { ONE_PIXEL_PNG, validImageTemplateBlueprint, validTemplateBlueprint } from "../helpers/template-knowledge-fixtures.js";

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
  const index = JSON.parse(await readFile(join(root, "knowledge-index.json"), "utf8")) as { records: Array<{ knowledgeId: string }>; requests: Record<string, { knowledgeId: string }> };
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
  assert.equal(approved.quality.imageCount, 1);
  assert.ok(approved.quality.rasterAreaRatio > 0.1 && approved.quality.rasterAreaRatio < 0.4);
  assert.equal(approved.quality.containmentViolations, 0);
  assert.equal(approved.quality.collisions, 0);
  const qa = JSON.parse((await store.getArtifact(approved.knowledgeId, "qa.json")).text) as typeof approved.quality;
  assert.deepEqual(qa, approved.quality);
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
