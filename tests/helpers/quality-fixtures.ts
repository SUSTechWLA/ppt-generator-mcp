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
    images: [{ src: "data:image/png;base64,iVBORw0KGgo=", complete: true, naturalWidth: 1, naturalHeight: 1, opaqueRatio: 1, luminanceVariance: 0.2, isVector: false, displayedArea: 10_000 }],
    rasterAreaRatio: 0.02,
    bodyScroll: { width: 1123, height: 794 },
    occupiedRatio: 0.75,
    signals: { networkRequests: [], hasScripts: false, hasUnresolvedPlaceholders: false, hasSecretLikeText: false, screenshotCreated: true },
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
