import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPage } from "../../src/services/page-renderer.js";
import { evaluateDeterministic } from "../../src/services/deterministic-evaluator.js";

test("accepts a bounded A4 landscape page", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-valid-"));
  const html = await readFile("tests/fixtures/render/valid-page.html", "utf8");
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.equal(report.hardGatePassed, true, JSON.stringify(report.issues, null, 2));
  assert.equal(render.viewport.width, 1123);
  assert.equal(render.pageCount, 1);
});

test("detects text overflow", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-overflow-"));
  const html = await readFile("tests/fixtures/render/overflow-page.html", "utf8");
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.ok(report.issues.some((issue) => issue.category === "layout" && issue.severity === "error"));
  assert.equal(report.hardGatePassed, false);
  assert.equal(report.safeToReturn, true);
});

test("blocks remote requests in a supposedly self-contained page", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-network-"));
  const html = '<html><body><article data-slide-page="1"><img src="https://example.com/a.png"></article></body></html>';
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.equal(report.safeToReturn, false);
  assert.ok(report.issues.some((issue) => issue.category === "technical"));
});
