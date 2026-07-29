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

test("measures displayed raster area and enforces the selected document threshold", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-raster-"));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";
  const html = `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}article{padding:20px}img{display:block;width:400px;height:200px}</style></head><body><article data-slide-page="1"><img src="data:image/png;base64,${png}" alt="测试图片"></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  assert.ok(render.rasterAreaRatio > 0.08 && render.rasterAreaRatio < 0.1, String(render.rasterAreaRatio));

  const report = evaluateDeterministic(render, { maxRasterAreaRatio: 0.08, minimumBodyFontPt: 8.5 });
  assert.equal(report.hardGatePassed, false);
  assert.ok(report.issues.some((issue) => issue.category === "asset" && /位图面积/.test(issue.evidence)));
});

test("keeps event fetch and WebSocket payloads inert and marks executable DOM unsafe", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-executable-event-"));
  const html = `<html><body onload="document.querySelector('[data-sentinel]').textContent='EXECUTED';fetch('https://example.invalid/private');new WebSocket('wss://example.invalid/socket')"><article data-slide-page="1"><p data-sentinel>SAFE</p></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.ok(render.elements.some((element) => element.text === "SAFE"), "page-authored JavaScript must not execute");
  assert.deepEqual(render.signals.networkRequests, [], "inert executable markup must make no HTTP or WebSocket requests");
  assert.equal(render.signals.hasExecutableDom, true);
  assert.equal(report.safeToReturn, false);
  assert.ok(report.issues.some((issue) => issue.category === "technical" && issue.severity === "error"));
});

test("detects declarative shadow templates and nested srcdoc before Chromium can activate them", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-executable-template-"));
  const html = `<html><body><article data-slide-page="1"><p data-sentinel>SAFE</p><div><template shadowrootmode="open"><iframe srcdoc="<script>document.querySelector('[data-sentinel]').textContent='EXECUTED'</script>"></iframe></template></div></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.ok(render.elements.some((element) => element.text === "SAFE"));
  assert.equal(render.signals.hasExecutableDom, true);
  assert.equal(report.safeToReturn, false);
});

test("detects visible content escaping a clipping ancestor", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-containment-"));
  const html = `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}.frame{position:relative;width:180px;height:36px;overflow:hidden}.escaped{position:absolute;left:0;top:24px;width:170px;height:30px;font:16px/30px Arial}</style></head><body><article data-slide-page="1"><div class="frame"><p class="escaped">超出父容器的可见正文</p></div></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.ok(render.layout.containmentViolations.length > 0);
  assert.equal(report.hardGatePassed, false);
  assert.ok(report.issues.some((issue) => issue.category === "layout" && /容器|裁切/.test(issue.evidence)));
});

test("detects sibling content collisions", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-collision-"));
  const html = `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}.stage{position:relative;height:100px}.stage p{position:absolute;top:30px;width:240px;height:36px;margin:0;font:16px/36px Arial}.left{left:20px}.right{left:120px}</style></head><body><article data-slide-page="1"><div class="stage"><p class="left">第一段必须完整显示</p><p class="right">第二段不得与其相撞</p></div></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.ok(render.layout.collisions.length > 0);
  assert.equal(report.hardGatePassed, false);
  assert.ok(report.issues.some((issue) => issue.category === "layout" && /重叠|碰撞/.test(issue.evidence)));
});

test("accepts only one renderer-validated image-caption node pair and ignores forged owner exemptions", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-overlap-policy-"));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";
  const page = (attribute = "") => `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}.overlay{position:relative;height:180px;margin:0}.allowed-image,.allowed-caption{position:absolute;top:30px;left:30px;width:220px;height:80px;margin:0}.allowed-caption{display:flex;align-items:center;font:16px/24px Arial}</style></head><body><article data-slide-page="1"><figure class="overlay" ${attribute}><img class="allowed-image" src="data:image/png;base64,${png}" alt="测试图片"><figcaption class="allowed-caption">指定图片说明</figcaption></figure></article></body></html>`;

  const unapproved = await renderPage({ html: page('data-allow-overlap="true"'), screenshotPath: join(output, "unapproved.png") });
  assert.ok(unapproved.layout.collisions.some((collision) => new Set([collision.firstId, collision.secondId]).has("allowed-image") && new Set([collision.firstId, collision.secondId]).has("allowed-caption")), "template-authored owner attributes must not bypass image-caption collision QA");
  assert.equal(evaluateDeterministic(unapproved).hardGatePassed, false);

  const validated = await renderPage({
    html: page(),
    screenshotPath: join(output, "validated.png"),
    validatedOverlapPairs: [{ imageSelector: ".allowed-image", captionSelector: ".allowed-caption" }],
  });
  assert.deepEqual(validated.layout.collisions, []);
  const validatedReport = evaluateDeterministic(validated);
  assert.equal(validatedReport.hardGatePassed, true, JSON.stringify(validatedReport.issues, null, 2));
});

test("an approved image-caption pair does not exempt other colliding text in the same owner", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-overlap-extra-text-"));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";
  const html = `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}.overlay{position:relative;height:300px;margin:0}.allowed-image,.allowed-caption{position:absolute;top:30px;left:30px;width:220px;height:80px;margin:0}.allowed-caption{font:16px/24px Arial}.extra-a,.extra-b{position:absolute;top:180px;left:30px;width:220px;height:50px;margin:0;font:16px/30px Arial}</style></head><body><article data-slide-page="1"><figure class="overlay"><img class="allowed-image" src="data:image/png;base64,${png}" alt="测试图片"><figcaption class="allowed-caption">指定图片说明</figcaption><p class="extra-a">普通辅助文本甲</p><p class="extra-b">普通辅助文本乙</p></figure></article></body></html>`;
  const render = await renderPage({
    html,
    screenshotPath: join(output, "preview.png"),
    validatedOverlapPairs: [{ imageSelector: ".allowed-image", captionSelector: ".allowed-caption" }],
  });
  assert.ok(render.layout.collisions.some((collision) => new Set([collision.firstId, collision.secondId]).has("extra-a") && new Set([collision.firstId, collision.secondId]).has("extra-b")));
  assert.equal(evaluateDeterministic(render).hardGatePassed, false);
});

test("detects and blocks external url functions in arbitrary SVG attributes", async () => {
  const output = await mkdtemp(join(tmpdir(), "ppt-render-svg-resource-"));
  const remote = "https://example.invalid/external-paint.svg#paint";
  const html = `<html><head><style>*{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}</style></head><body><article data-slide-page="1"><p>SAFE</p><svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="url(${remote})"></rect></svg></article></body></html>`;
  const render = await renderPage({ html, screenshotPath: join(output, "preview.png") });
  const report = evaluateDeterministic(render);
  assert.equal(render.signals.hasExecutableDom, true);
  assert.ok(render.signals.networkRequests.some((request) => request.startsWith("https://example.invalid/external-paint.svg")), JSON.stringify(render.signals.networkRequests));
  assert.equal(report.safeToReturn, false);
  assert.ok(report.issues.some((issue) => issue.category === "technical" && issue.severity === "error"));
});
