import { makeSlideSpec, makeSourceDocument } from "./domain-fixtures.js";
import type { RenderResult } from "../../src/services/page-renderer.js";
import type { DeterministicReport } from "../../src/services/deterministic-evaluator.js";

export function makeEvaluationFixtures() {
  const source = makeSourceDocument();
  const spec = makeSlideSpec({ factIds: source.facts.map((fact) => fact.id), assetCount: 1 });
  const render: RenderResult = {
    screenshotPath: "/tmp/quality-preview.png",
    screenshotDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    viewport: { width: 1123, height: 794 },
    pageCount: 1,
    elements: [],
    images: [{ src: "data:image/png;base64,iVBORw0KGgo=", complete: true, naturalWidth: 1, naturalHeight: 1, opaqueRatio: 1, luminanceVariance: 0.2, isVector: false, displayedArea: 10_000, clippedArea: 10_000, cssVisible: true }],
    rasterAreaRatio: 0.02,
    raster: { visibleCount: 1, unionArea: 10_000, unionAreaRatio: 0.02 },
    bodyScroll: { width: 1123, height: 794 },
    occupiedRatio: 0.75,
    structure: {
      designTokens: { fontFamily: "Arial", textColor: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)", fontScale: "1", spacingScale: "1", contrastMode: "normal" },
      landmarkCounts: { "page-header": 0, "chapter-band": 0, "subsection-title": 0, "summary-band": 0, "page-footer": 0 },
      landmarkRects: { "page-header": [], "chapter-band": [], "subsection-title": [], "summary-band": [], "page-footer": [] },
      pageFields: {}, semanticItems: [], blankComponents: [], protectedGeneratedText: [], protectedClipViolations: [],
    },
    layout: { containmentViolations: [], collisions: [] },
    signals: { networkRequests: [], hasScripts: false, hasExecutableDom: false, hasUnresolvedPlaceholders: false, hasSecretLikeText: false, screenshotCreated: true },
  };
  const passingDeterministic: DeterministicReport = { safeToReturn: true, hardGatePassed: true, issues: [] };
  const failingDeterministic: DeterministicReport = {
    safeToReturn: true,
    hardGatePassed: false,
    issues: [{ id: "det-1", severity: "error", category: "layout", evidence: "overflow", suggestedAction: "rewrite", targetId: "block-1" }],
  };
  const perfectReview = { review: async () => ({ dimensions: { fidelity: 100, structure: 100, readability: 100, layout: 100, asset: 100, technical: 100 }, issues: [] }) };
  return { source, spec, render, passingDeterministic, failingDeterministic, perfectReview };
}
