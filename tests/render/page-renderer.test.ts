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

test("does not treat visible font ink or monochrome SVG icons as broken layout", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-font-"));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M2 12h20" stroke="#075f34" stroke-width="2"/></svg>').toString("base64");
  const html = `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}article{padding:20px}.label{height:10px;font:800 20px/1 Arial;color:#075f34;overflow:visible}</style></head><body><article data-slide-page="1"><div class="label">PART.01</div><img src="data:image/svg+xml;base64,${svg}" alt="流程图标"></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  assert.ok(render.elements.some((element) => element.scrollHeight > element.clientHeight + 1));
  const report = evaluateDeterministic(render);
  assert.equal(report.issues.some((issue) => issue.category === "layout" && issue.severity === "error"), false, JSON.stringify(report.issues));
  assert.equal(report.issues.some((issue) => issue.category === "asset" && /变化过低/.test(issue.evidence)), false, JSON.stringify(report.issues));
});
