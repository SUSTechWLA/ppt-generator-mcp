import assert from "node:assert/strict";
import test from "node:test";

import { inspectTemplateHtml } from "../../src/services/template-inspector.js";

test("arbitrary safe HTML becomes generic layout knowledge without source copy or branding", () => {
  const source = `<!doctype html><html><head><style>
    body{margin:0;background:#fff;color:#16251d;font-family:Arial,sans-serif}
    main{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
    .card{grid-column:span 6;background:#eef5f1;padding:18px}
  </style></head><body><header><img alt="Acme Logo"><h1>SECRET PROCUREMENT WORDING</h1></header>
  <main><section class="card"><h2>Operational promise</h2><p>Do not retain this sentence.</p></section>
  <section class="card"><h2>Evidence</h2><p>Nor this filename report-final.pptx.</p></section></main><footer>ACME™</footer></body></html>`;

  const inspected = inspectTemplateHtml(source);
  assert.equal(inspected.safe, true);
  assert.equal(inspected.blueprint.canvas.format, "a4-landscape");
  assert.equal(inspected.blueprint.grid.columns, 12);
  assert.ok(inspected.blueprint.grid.regions.some((region) => region.role === "title"));
  assert.ok(inspected.blueprint.grid.regions.some((region) => region.role === "body"));
  assert.ok(inspected.blueprint.grid.regions.some((region) => region.role === "page-number"));
  assert.match(inspected.blueprint.palette.primary, /^#[0-9a-f]{6}$/);
  assert.doesNotMatch(JSON.stringify(inspected), /SECRET PROCUREMENT|Do not retain|report-final|ACME|Logo/i);
});

test("inspection reports executable DOM and unsafe CSS resources without echoing source", () => {
  const inspected = inspectTemplateHtml(`<html><head><style>@import url(https://bad.invalid/x.css)</style></head><body><template shadowrootmode="open"><script>alert(1)</script></template></body></html>`);
  assert.equal(inspected.safe, false);
  assert.ok(inspected.findings.some((finding) => finding.code === "executable-dom"));
  assert.ok(inspected.findings.some((finding) => finding.code === "unsafe-css-resource"));
  assert.doesNotMatch(JSON.stringify(inspected), /bad\.invalid|alert\(1\)/);
});

test("inspection may discard a bounded inline raster reference without treating pixels as template knowledge", () => {
  const inspected = inspectTemplateHtml(`<!doctype html><html><head><style>body{color:#17241e;background:#ffffff}</style></head><body><h1>Layout</h1><main><section>Body</section><img src="data:image/png;base64,AAAA" alt="reference pixels"></main><footer>1</footer></body></html>`);
  assert.equal(inspected.safe, true);
  assert.ok(inspected.findings.some((finding) => finding.code === "resource-attribute" && finding.severity === "notice"));
  assert.doesNotMatch(JSON.stringify(inspected), /AAAA|data:image|reference pixels/i);
});

test("primary token inference uses the blueprint 4.5 contrast threshold with a stable fallback", () => {
  for (const color of ["#888888", "#777777"]) {
    const inspected = inspectTemplateHtml(`<!doctype html><html><head><style>:root{--primary:${color};--background:#ffffff}body{color:#17241e;background:#ffffff}</style></head><body><main><section>Body</section></main><footer>1</footer></body></html>`);
    assert.equal(inspected.safe, true);
    assert.equal(inspected.blueprint.palette.primary, "#176b45");
  }
  const boundary = inspectTemplateHtml(`<!doctype html><html><head><style>:root{--primary:#767676;--background:#ffffff}body{color:#17241e;background:#ffffff}</style></head><body><main><section>Body</section></main><footer>1</footer></body></html>`);
  assert.equal(boundary.safe, true);
  assert.equal(boundary.blueprint.palette.primary, "#767676");
});
