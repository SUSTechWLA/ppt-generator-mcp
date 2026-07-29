import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

import { extractCanonicalAnchors } from "../../src/domain/critical-anchor.js";
import { displayPlanSchema, type DisplayPlan } from "../../src/domain/display-plan.js";
import { evaluateDeterministic } from "../../src/services/deterministic-evaluator.js";
import { evaluateDeckConsistency } from "../../src/services/deck-consistency.js";
import { renderPage } from "../../src/services/page-renderer.js";
import { getDocumentTemplatePolicy } from "../../src/services/template-selector.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { composeSlide } from "../../src/services/slide-composer.js";
import { loadTemplate } from "../../src/lib/template-parser.js";
import { DeckStore } from "../../src/workflow/deck-store.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../../src/workflow/plan-deck.js";
import { makeTemplateProfiles } from "../helpers/domain-fixtures.js";

const profile = makeTemplateProfiles()[0];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";

function groundedPlan(facts = ["\u5fc5\u987b\u572830\u5206\u949f\u5185\u54cd\u5e94\u3002"]): DisplayPlan {
  const body = facts.join("\uff1b");
  return displayPlanSchema.parse({
    version: 1,
    items: [{ id: "group-1", order: 0, role: "metric", title: "\u91cf\u5316\u6307\u6807", body, sourceFactIds: facts.map((_, index) => `fact-${index + 1}`) }],
    factCoverages: facts.map((sourceText, index) => ({
      factId: `fact-${index + 1}`,
      displayItemId: "group-1",
      sourceText,
      selectedSpans: [{ start: 0, end: sourceText.length, text: sourceText }],
      criticalAnchors: extractCanonicalAnchors(sourceText),
      displayText: sourceText,
      omittedCharacterCount: 0,
      extractionLevel: "full",
    })),
    targetBudget: {
      blockCapacity: 4,
      semanticPositionCapacity: 4,
      factBindingPositionCapacity: 4,
      itemCapacity: 4,
      maxCharsPerItem: 160,
      minimumBodyFontPt: 8.5,
      positionBudgets: [{ displayItemId: "group-1", slotId: "main", itemIndex: 0, maxChars: 160 }],
    },
    grounding: {
      passed: true,
      issues: [],
      mappedFactIds: facts.map((_, index) => `fact-${index + 1}`),
      displayedCharacterCount: body.length,
      omittedCharacterCount: 0,
    },
  });
}

const metadataBindings = [
  ["pageTitle", "\u7a33\u5b9a\u54cd\u5e94"], ["pageNumber", "101"], ["sectionTitle", "\u6570\u5b57\u4ea7\u54c1\u65b9\u6848"],
  ["partNumber", "PART.01"], ["partLabel", "\u5ba2\u6237\u4ea4\u4ed8"], ["chapterLabel", "\u8fd0\u884c\u4fdd\u969c"],
  ["topicTitle", "\u7a33\u5b9a\u54cd\u5e94"], ["subsectionTitle", "\u7a33\u5b9a\u54cd\u5e94"], ["summaryText", "\u5efa\u7acb\u53ef\u8ffd\u6eaf\u7684\u54cd\u5e94\u673a\u5236"],
].map(([field, value]) => ({ field, values: [value] }));

function pageHtml(options: {
  pageNumber?: number;
  omitLandmark?: string;
  blankComponent?: boolean;
  factBody?: string;
  hiddenFactBody?: boolean;
  duplicateFactOwner?: boolean;
  bodyFontPt?: number;
  extraHtml?: string;
} = {}): string {
  const pageNumber = options.pageNumber ?? 101;
  const landmarks = ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"];
  const landmark = (name: string, contents: string) => options.omitLandmark === name ? "" : `<div data-page-landmark="${name}">${contents}</div>`;
  const factBody = options.factBody ?? "\u5fc5\u987b\u572830\u5206\u949f\u5185\u54cd\u5e94\u3002";
  const owner = (suffix = "") => `<section data-component="fact-card" data-semantic-slot="main" data-block-id="group-1${suffix}" data-source-fact-ids="fact-1"><h4><span data-semantic-binding-field="title" data-semantic-binding-index="0" data-semantic-title-owner>\u91cf\u5316\u6307\u6807</span></h4><p><span data-semantic-binding-field="body" data-semantic-binding-index="0" data-fact-text-owner${options.hiddenFactBody ? ' style="display:none"' : ""}>${factBody}</span></p></section>`;
  const fields = Object.fromEntries(metadataBindings.map((entry) => [entry.field, entry.values[0]]));
  return `<!doctype html><html style="--workflow-font-scale:1;--workflow-spacing-scale:1"><head><style>
    *{box-sizing:border-box}html,body,article{width:1123px;height:794px;margin:0}article{padding:24px;font-family:Arial,sans-serif;color:#17352a;background:#fff}
    [data-page-landmark]{height:42px;margin:3px 0} [data-component]{padding:8px;border:1px solid #bdd8ca} p{margin:0;font-size:${options.bodyFontPt ?? 8.5}pt;line-height:1.35}
    .blank{height:24px}.hidden{display:none}.raster{position:absolute;width:400px;height:200px;left:600px;top:300px}.offcanvas{left:1300px}.decorative{font-size:6pt}
  </style></head><body><article data-slide-page="${pageNumber}" data-template-slug="${profile.slug}" data-template-version="${profile.version}" data-theme-id="${profile.themeId}" data-document-format="${profile.format}">
    ${landmark("page-header", `<span data-page-field="pageTitle">${fields.pageTitle}</span><span data-page-field="sectionTitle">${fields.sectionTitle}</span><span data-page-field="partNumber">${fields.partNumber}</span><span data-page-field="partLabel">${fields.partLabel}</span>`) }
    ${landmark("chapter-band", `<span data-page-field="chapterLabel">${fields.chapterLabel}</span><span data-page-field="topicTitle">${fields.topicTitle}</span>`) }
    ${landmark("subsection-title", `<span data-page-field="subsectionTitle">${fields.subsectionTitle}</span>`) }
    ${owner()}${options.duplicateFactOwner ? owner("-duplicate") : ""}
    ${options.blankComponent ? '<section class="blank" data-component="empty-card"></section>' : ""}
    ${landmark("summary-band", `<span data-page-field="summaryText">${fields.summaryText}</span>`) }
    ${landmark("page-footer", `<span data-page-field="pageNumber">${pageNumber}</span>`) }
    <span class="decorative">\u88c5\u9970\u7f16\u53f7</span>${options.extraHtml ?? ""}
  </article></body></html>`;
}

async function render(html: string, label: string) {
  const output = await mkdtemp(join(tmpdir(), `ppt-profile-gate-${label}-`));
  return renderPage({ html, screenshotPath: join(output, "preview.png") });
}

function evaluate(rendered: Awaited<ReturnType<typeof renderPage>>, displayPlan = groundedPlan()) {
  return evaluateDeterministic(rendered, {
    profile,
    documentPolicy: getDocumentTemplatePolicy("bid"),
    expectedPageNumber: 101,
    expectedMetadataBindings: metadataBindings,
    displayPlan,
  });
}

test("profile-declared landmarks, metadata, page number and nonblank components are hard gates", async () => {
  const valid = evaluate(await render(pageHtml(), "structure-valid"));
  assert.equal(valid.hardGatePassed, true, JSON.stringify(valid.issues, null, 2));

  for (const [label, html] of [
    ["wrong-page", pageHtml({ pageNumber: 104 })],
    ["missing-landmark", pageHtml({ omitLandmark: "chapter-band" })],
    ["blank-component", pageHtml({ blankComponent: true })],
  ] as const) {
    const report = evaluate(await render(html, label));
    assert.equal(report.hardGatePassed, false, label);
  }
});

test("raster QA uses the clipped union and visible count without hidden or off-canvas inflation", async () => {
  const images = `<img class="raster" src="data:image/png;base64,${png}" alt="A"><img class="raster" src="data:image/png;base64,${png}" alt="B"><img class="raster hidden" src="data:image/png;base64,${png}" alt="hidden"><img class="raster offcanvas" src="data:image/png;base64,${png}" alt="outside">`;
  const rendered = await render(pageHtml({ extraHtml: images }), "raster-union");
  assert.equal(rendered.raster.visibleCount, 2);
  assert.ok(rendered.rasterAreaRatio > 0.08 && rendered.rasterAreaRatio < 0.1, String(rendered.rasterAreaRatio));
  assert.equal(evaluate(rendered).hardGatePassed, false, "bid policy should reject two visible raster assets");

  const clippedHtml = `<div style="position:absolute;left:600px;top:300px;width:200px;height:100px;overflow:hidden"><img style="display:block;width:400px;height:200px" src="data:image/png;base64,${png}" alt="clipped"></div>`;
  const clipped = await render(pageHtml({ extraHtml: clippedHtml }), "raster-clipped");
  assert.equal(clipped.raster.visibleCount, 1);
  assert.ok(clipped.rasterAreaRatio > 0.02 && clipped.rasterAreaRatio < 0.025, String(clipped.rasterAreaRatio));

  const invalidHidden = await render(pageHtml({ extraHtml: '<img class="hidden" src="data:image/png;base64,not-an-image" alt="invalid hidden">' }), "raster-invalid-hidden");
  const invalidReport = evaluate(invalidHidden);
  assert.equal(invalidReport.safeToReturn, false, "a failed hidden asset must not remain in final HTML");
});

test("8.49pt semantic body fails while 8.5pt passes and decorative small text is excluded", async () => {
  const below = evaluate(await render(pageHtml({ bodyFontPt: 8.49 }), "font-below"));
  assert.equal(below.hardGatePassed, false);
  assert.ok(below.issues.some((issue) => issue.category === "readability" && /8\.5pt/.test(issue.evidence)));

  const exact = evaluate(await render(pageHtml({ bodyFontPt: 8.5 }), "font-exact"));
  assert.equal(exact.hardGatePassed, true, JSON.stringify(exact.issues, null, 2));
});

test("grounding requires exact visible owner text and exact-once ordered fact attribution", async () => {
  for (const [label, html] of [
    ["hidden", pageHtml({ hiddenFactBody: true })],
    ["duplicate", pageHtml({ duplicateFactOwner: true })],
    ["critical-loss", pageHtml({ factBody: "\u5fc5\u987b\u53ca\u65f6\u54cd\u5e94\u3002" })],
    ["ungrounded-number", pageHtml({ factBody: "\u5fc5\u987b\u572830\u5206\u949f\u5185\u54cd\u5e94\uff0c\u53e6\u970099\u4ebf\u5143\u3002" })],
  ] as const) {
    const report = evaluate(await render(html, `grounding-${label}`));
    assert.equal(report.hardGatePassed, false, label);
    assert.ok(report.issues.some((issue) => issue.category === "fidelity" || issue.category === "structure"), JSON.stringify(report.issues));
  }
});

test("real planned composition exposes fact-bearing DOM text and enforces the exact 8.5pt floor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-real-profile-gate-"));
  try {
    const profiles = loadTemplateProfiles(resolve("templates"));
    const sourceText = `<page 205>\n\u4e00\u7ea7\u6807\u9898\uff1a\u670d\u52a1\u5b9e\u65bd\n\u4e8c\u7ea7\u6807\u9898\uff1a\u5c65\u7ea6\u7ba1\u7406\n\u4e09\u7ea7\u6807\u9898\uff1a\u54cd\u5e94\u673a\u5236\n\u56db\u7ea7\u6807\u9898\uff1a\u7a33\u5b9a\u8fd0\u884c\n\u6b63\u6587\uff1a\n\u56fa\u5b9a\u8d1f\u8d23\u4eba\u914d\u7f6e\u6570\u91cf\u4e3a1\u540d\u3002\n\u89c4\u5b9a\u54cd\u5e94\u65f6\u9650\u4e3a30\u5206\u949f\u3002`;
    const planned = await planDeckWorkflow({ sourceText, pageNumbers: [205], documentType: "bid" }, createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles }));
    const slide = planned.plannedDeck.slides[0];
    const composed = await composeSlide({
      spec: slide.plannedSpec,
      template: loadTemplate(resolve("templates"), slide.templateSlug),
      profile: slide.templateMatch.profileSnapshot,
      assets: [],
      page: slide.page,
    });
    assert.match(composed.html, /data-fact-text-owner="true"/);
    assert.match(composed.html, /data-source-fact-ids="fact-1,fact-2"/);
    const policy = getDocumentTemplatePolicy("bid");
    const context = {
      profile: slide.templateMatch.profileSnapshot,
      documentPolicy: policy,
      expectedPageNumber: slide.page.number,
      expectedMetadataBindings: slide.templateMatch.metadataBindings,
      displayPlan: slide.displayPlan,
      plannedSpec: slide.plannedSpec,
    };
    const exact = await renderPage({ html: composed.html, screenshotPath: join(directory, "exact.png") });
    assert.equal(evaluateDeterministic(exact, context).hardGatePassed, true, JSON.stringify(evaluateDeterministic(exact, context).issues, null, 2));
    const deckConsistency = evaluateDeckConsistency({
      plannedDeck: planned.plannedDeck,
      loadedProfiles: profiles,
      pages: [{
        pageNumber: slide.page.number,
        status: "delivered",
        selectedTemplateSlug: slide.templateSlug,
        quality: { score: 92, threshold: 90, hardGatePassed: true },
        render: exact,
      }],
    });
    assert.equal(deckConsistency.passed, true, JSON.stringify({ issues: deckConsistency.issues, landmarks: exact.structure.landmarkRects }, null, 2));

    const mutatedTitleDom = new JSDOM(composed.html);
    const expectedTitle = slide.displayPlan.items[0].title;
    const titleOwner = mutatedTitleDom.window.document.querySelector("[data-semantic-slot] [data-semantic-title-owner]");
    assert.ok(titleOwner, `expected a visible semantic title owner for ${expectedTitle}`);
    assert.equal(titleOwner.textContent?.trim(), expectedTitle);
    titleOwner.textContent = "微软99亿元";
    const mutatedTitle = await renderPage({ html: mutatedTitleDom.serialize(), screenshotPath: join(directory, "mutated-title.png") });
    assert.equal(evaluateDeterministic(mutatedTitle, context).hardGatePassed, false, "an ungrounded semantic title must fail even when fact body remains exact");

    for (const [label, css] of [
      ["clipped-fact", "[data-fact-text-owner]{clip-path:inset(100%)!important}"],
      ["clipped-page-field", '[data-page-field="subsectionTitle"]{clip-path:inset(100%)!important}'],
      ["generated-semantic-text", '[data-fact-text-owner]::after{content:"微软99亿元"}'],
    ] as const) {
      const html = composed.html.replace("</head>", `<style>${css}</style></head>`);
      const rendered = await renderPage({ html, screenshotPath: join(directory, `${label}.png`) });
      const report = evaluateDeterministic(rendered, context);
      assert.equal(report.hardGatePassed, false, `${label} must not cross the painted-text trust boundary`);
    }

    const decorativePseudoHtml = composed.html.replace("</head>", '<style>[data-semantic-slot]::before{content:"◆"}</style></head>');
    const decorativePseudo = await renderPage({ html: decorativePseudoHtml, screenshotPath: join(directory, "decorative-pseudo.png") });
    assert.equal(evaluateDeterministic(decorativePseudo, context).hardGatePassed, true, "punctuation-only decorative pseudo content must remain allowed");

    const belowHtml = composed.html.replace("</head>", "<style>[data-fact-text-owner]{font-size:8.49pt!important}</style></head>");
    const below = await renderPage({ html: belowHtml, screenshotPath: join(directory, "below.png") });
    const belowReport = evaluateDeterministic(below, context);
    assert.equal(belowReport.hardGatePassed, false);
    assert.ok(belowReport.issues.some((issue) => issue.category === "readability" && /8\.5pt/.test(issue.evidence)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
