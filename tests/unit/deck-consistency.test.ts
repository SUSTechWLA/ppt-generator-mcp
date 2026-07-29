import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { hashCanonical } from "../../src/domain/source-document.js";
import { evaluateDeckConsistency, type DeckConsistencyPage } from "../../src/services/deck-consistency.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { DeckStore } from "../../src/workflow/deck-store.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../../src/workflow/plan-deck.js";

function page(number: number, title: string, body: string): string {
  return `<page ${number}>\n\u4e00\u7ea7\u6807\u9898\uff1a\u6570\u5b57\u4ea7\u54c1\u65b9\u6848\n\u4e8c\u7ea7\u6807\u9898\uff1a\u5ba2\u6237\u4ea4\u4ed8\n\u4e09\u7ea7\u6807\u9898\uff1a\u8fd0\u884c\u4fdd\u969c\n\u56db\u7ea7\u6807\u9898\uff1a${title}\n\u6b63\u6587\uff1a\n${body}`;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "deck-consistency-"));
  const profiles = loadTemplateProfiles(resolve("templates"));
  const plan = await planDeckWorkflow({
    sourceText: [
      page(101, "\u7a33\u5b9a\u54cd\u5e94", "\u5fc5\u987b\u914d\u7f6e1\u540d\u56fa\u5b9a\u8d1f\u8d23\u4eba\u3002"),
      page(104, "\u5c65\u7ea6\u6d41\u7a0b", "\u6307\u4ee430\u5206\u949f\u5185\u542f\u52a8\uff0c1\u5c0f\u65f6\u5185\u5230\u573a\u3002"),
    ].join("\n\n"),
    pageNumbers: [101, 104],
    documentType: "bid",
    preferredThemeId: "green-infographic-v1",
  }, createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles }));
  return { directory, profiles, plannedDeck: plan.plannedDeck };
}

function delivery(slide: Awaited<ReturnType<typeof fixture>>["plannedDeck"]["slides"][number]): DeckConsistencyPage {
  const fields = Object.fromEntries(slide.templateMatch.metadataBindings.map((binding) => [binding.field, binding.values]));
  return {
    pageNumber: slide.page.number,
    status: "delivered",
    selectedTemplateSlug: slide.templateSlug,
    quality: { score: 92, threshold: 90, hardGatePassed: true },
    render: {
      viewport: { width: 1123, height: 794 },
      pageCount: 1,
      structure: {
        pageNumber: String(slide.page.number),
        profile: { slug: slide.templateSlug, version: slide.templateMatch.profileVersion, themeId: slide.templateMatch.themeId, format: slide.templateMatch.profileSnapshot.format },
        designTokens: { fontFamily: "Arial", textColor: "rgb(23, 53, 42)", backgroundColor: "rgb(255, 255, 255)", fontScale: "1", spacingScale: "1", contrastMode: "normal" },
        landmarkCounts: { "page-header": 1, "chapter-band": 1, "subsection-title": 1, "summary-band": 1, "page-footer": 1 },
        landmarkRects: { "page-header": [{ x: 24, y: 24, width: 1075, height: 42 }], "chapter-band": [{ x: 24, y: 69, width: 1075, height: 42 }], "subsection-title": [{ x: 24, y: 114, width: 1075, height: 42 }], "summary-band": [{ x: 24, y: 680, width: 1075, height: 42 }], "page-footer": [{ x: 24, y: 725, width: 1075, height: 42 }] },
        pageFields: fields,
        semanticItems: [],
        blankComponents: [],
      },
    },
  };
}

test("persisted nonconsecutive page list passes exactly while reorder, extra, missing and undelivered pages fail", async () => {
  const f = await fixture();
  try {
    const pages = f.plannedDeck.slides.map(delivery);
    assert.equal(evaluateDeckConsistency({ plannedDeck: f.plannedDeck, loadedProfiles: f.profiles, pages }).passed, true);
    for (const candidate of [[pages[1], pages[0]], pages.slice(0, 1), [...pages, { ...pages[1], pageNumber: 108 }], [{ ...pages[0], status: "best_effort" as const }, pages[1]], [{ ...pages[0], quality: { score: Number.NaN, threshold: 0, hardGatePassed: true } }, pages[1]]]) {
      assert.equal(evaluateDeckConsistency({ plannedDeck: f.plannedDeck, loadedProfiles: f.profiles, pages: candidate }).passed, false);
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("theme compatibility is declared and survives slug renaming; slug-like prefixes cannot mask incompatible theme or tokens", async () => {
  const f = await fixture();
  try {
    const renamedProfiles = structuredClone(f.profiles);
    const renamedPlan = structuredClone(f.plannedDeck);
    const renameBySlug = new Map<string, string>();
    for (const slug of new Set(renamedPlan.slides.map((slide) => slide.templateSlug))) {
      const profile = renamedProfiles.find((candidate) => candidate.slug === slug)!;
      const renamed = `renamed-${slug}`;
      renameBySlug.set(slug, renamed);
      profile.slug = renamed;
    }
    for (const slide of renamedPlan.slides) {
      const original = slide.templateSlug;
      const renamed = renameBySlug.get(original)!;
      slide.templateSlug = renamed;
      slide.templateMatch.profileSnapshot.slug = renamed;
      slide.templateMatch.profileCapabilityHash = hashCanonical(slide.templateMatch.profileSnapshot);
      const selected = slide.templateMatch.candidateScores.find((candidate) => candidate.slug === original)!;
      selected.slug = renamed;
    }
    const renamedPages = renamedPlan.slides.map(delivery);
    assert.equal(evaluateDeckConsistency({ plannedDeck: renamedPlan, loadedProfiles: renamedProfiles, pages: renamedPages }).passed, true);

    const incompatibleTheme = structuredClone(renamedPages);
    incompatibleTheme[1].render.structure.profile!.themeId = "lookalike-prefix-other-theme";
    assert.equal(evaluateDeckConsistency({ plannedDeck: renamedPlan, loadedProfiles: renamedProfiles, pages: incompatibleTheme }).passed, false);

    const incompatibleTokens = structuredClone(renamedPages);
    incompatibleTokens[1].render.structure.designTokens.fontFamily = "Times New Roman";
    assert.equal(evaluateDeckConsistency({ plannedDeck: renamedPlan, loadedProfiles: renamedProfiles, pages: incompatibleTokens }).passed, false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("per-page heading text may change but must match its own persisted metadata and stable hierarchy placement", async () => {
  const f = await fixture();
  try {
    const pages = f.plannedDeck.slides.map(delivery);
    assert.notDeepEqual(pages[0].render.structure.pageFields.subsectionTitle, pages[1].render.structure.pageFields.subsectionTitle);
    assert.equal(evaluateDeckConsistency({ plannedDeck: f.plannedDeck, loadedProfiles: f.profiles, pages }).passed, true);

    const wrongMetadata = structuredClone(pages);
    wrongMetadata[1].render.structure.pageFields.subsectionTitle = ["\u4f2a\u9020\u5c0f\u8282"];
    assert.equal(evaluateDeckConsistency({ plannedDeck: f.plannedDeck, loadedProfiles: f.profiles, pages: wrongMetadata }).passed, false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
