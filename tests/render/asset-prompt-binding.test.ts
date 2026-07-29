import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

import { evaluateDeterministic } from "../../src/services/deterministic-evaluator.js";
import { renderPage } from "../../src/services/page-renderer.js";
import { composeSlide } from "../../src/services/slide-composer.js";
import { getDocumentTemplatePolicy, loadTemplateProfiles } from "../../src/services/template-selector.js";
import { loadTemplate } from "../../src/lib/template-parser.js";
import { DeckStore } from "../../src/workflow/deck-store.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../../src/workflow/plan-deck.js";

const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1792" height="1024" viewBox="0 0 1792 1024"><rect width="1792" height="1024" fill="#dcecdf"/><path d="M120 850L610 310l330 330 260-250 472 460" fill="none" stroke="#2f6b4f" stroke-width="72"/></svg>').toString("base64")}`;

test("real image directive binding is prompt-only while visible metadata and Chromium QA remain strict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asset-prompt-render-"));
  try {
    const profiles = loadTemplateProfiles(resolve("templates"));
    const profile = profiles.find((candidate) => candidate.slug === "green-infographic-bid-a4-landscape");
    assert.ok(profile);
    const sourceText = `<page 205>\n一级标题：服务实施\n二级标题：履约管理\n三级标题：响应机制\n四级标题：稳定运行\n正文：\n首先启动现场检查。其次提交问题清单。最后完成整改复核。`;
    const planned = await planDeckWorkflow({
      sourceText,
      pageNumbers: [205],
      documentType: "bid",
      templateSlug: profile.slug,
      quality: { minScore: 90, maxAttempts: 3 },
    }, createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles }));
    const slide = planned.plannedDeck.slides[0];
    assert.equal(slide.plannedSpec.assets.length, 1);

    const match = slide.templateMatch as typeof slide.templateMatch & {
      assetPromptBindings?: { figureRef?: string };
      assetPromptBindingEvidence?: Array<{ field: string; tag: string; values: string[] }>;
    };
    assert.equal(match.pageBindings.figureRef, undefined, "prompt-only references must not be promised as rendered page fields");
    assert.equal(match.metadataBindings.some((binding) => binding.field === "figureRef"), false);
    assert.deepEqual(match.assetPromptBindings, { figureRef: "figure-ref" });
    assert.deepEqual(match.assetPromptBindingEvidence?.map(({ field, tag, values }) => ({ field, tag, values })), [{
      field: "figureRef",
      tag: "figure-ref",
      values: [slide.plannedSpec.blocks.find((block) => block.id === slide.plannedSpec.assets[0].blockId)?.title],
    }]);

    const asset = slide.plannedSpec.assets[0];
    const composed = await composeSlide({
      spec: slide.plannedSpec,
      template: loadTemplate(resolve("templates"), slide.templateSlug),
      profile: slide.templateMatch.profileSnapshot,
      assets: [{
        id: asset.id,
        promptHash: "prompt-hash",
        mimeType: "image/svg+xml",
        filePath: join(directory, `${asset.id}.svg`),
        dataUrl: SVG,
        reused: false,
      }],
      page: slide.page,
    });
    assert.doesNotMatch(composed.html, /<figures|<figure-ref|data-page-field="figureRef"/i);
    assert.match(composed.html, new RegExp(`data-asset-id=["']${asset.id}["']`));

    const rendered = await renderPage({ html: composed.html, screenshotPath: join(directory, "page.png") });
    const report = evaluateDeterministic(rendered, {
      profile: slide.templateMatch.profileSnapshot,
      documentPolicy: getDocumentTemplatePolicy("bid"),
      expectedPageNumber: slide.page.number,
      expectedMetadataBindings: slide.templateMatch.metadataBindings,
      displayPlan: slide.displayPlan,
      plannedSpec: slide.plannedSpec,
    });
    assert.equal(report.hardGatePassed, true, JSON.stringify(report.issues, null, 2));

    const visibleProfile = structuredClone(slide.templateMatch.profileSnapshot);
    delete visibleProfile.assetPromptBindings;
    visibleProfile.pageBindings.figureRef = "figure-ref";
    const sourceTemplate = loadTemplate(resolve("templates"), slide.templateSlug);
    const visibleTemplate = {
      ...sourceTemplate,
      html: sourceTemplate.html
        .replace(/<figure-ref>([\s\S]*?)<\/figure-ref>/, "$1")
        .replace("</figcaption>", '</figcaption><span class="visible-figure-reference"><figure-ref>内容标题</figure-ref></span>'),
    };
    const visibleComposed = await composeSlide({
      spec: slide.plannedSpec,
      template: visibleTemplate,
      profile: visibleProfile,
      assets: [{
        id: asset.id,
        promptHash: "prompt-hash",
        mimeType: "image/svg+xml",
        filePath: join(directory, `${asset.id}.svg`),
        dataUrl: SVG,
        reused: false,
      }],
      page: slide.page,
    });
    const visibleReference = slide.plannedSpec.blocks.find((block) => block.id === asset.blockId)!.title;
    assert.match(visibleComposed.html, /data-page-field="figureRef"/);
    const visibleContext = {
      profile: visibleProfile,
      documentPolicy: getDocumentTemplatePolicy("bid"),
      expectedPageNumber: slide.page.number,
      expectedMetadataBindings: [
        ...slide.templateMatch.metadataBindings,
        { field: "figureRef", values: [visibleReference] },
      ],
      displayPlan: slide.displayPlan,
      plannedSpec: slide.plannedSpec,
    };
    const visibleRender = await renderPage({ html: visibleComposed.html, screenshotPath: join(directory, "visible-reference.png") });
    assert.equal(evaluateDeterministic(visibleRender, visibleContext).hardGatePassed, true,
      JSON.stringify(evaluateDeterministic(visibleRender, visibleContext).issues, null, 2));

    const deleted = new JSDOM(visibleComposed.html);
    deleted.window.document.querySelector('[data-page-field="figureRef"]')?.remove();
    const deletedRender = await renderPage({ html: deleted.serialize(), screenshotPath: join(directory, "deleted-reference.png") });
    assert.equal(evaluateDeterministic(deletedRender, visibleContext).hardGatePassed, false,
      "a genuinely visible figure reference remains a metadata hard gate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
