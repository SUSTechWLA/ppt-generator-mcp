import type { QualityIssue, QualityReport } from "../../src/domain/quality-report.js";
import type { QualityLoopInput } from "../../src/workflow/quality-loop.js";
import { makeGeneratedAssets, makeSlideSpec } from "./domain-fixtures.js";

export function reportWith(issue: Partial<QualityIssue>): QualityReport {
  return {
    score: 70,
    safeToReturn: true,
    hardGatePassed: true,
    dimensions: { fidelity: 70, structure: 70, readability: 70, layout: 70, asset: 70, technical: 70 },
    issues: [{ id: "issue-1", severity: "error", category: "layout", evidence: "template capacity mismatch", suggestedAction: "switch template", ...issue }],
  };
}

export function makeLoopInput(options: {
  scores: number[];
  hardGates: boolean[];
  safeFlags?: boolean[];
  maxAttempts: number;
}): QualityLoopInput {
  let evaluationIndex = 0;
  const spec = makeSlideSpec({ assetCount: 1 });
  return {
    initialState: {
      spec,
      assets: makeGeneratedAssets(spec.assets),
      templateSlug: "green-infographic-bid-a4-landscape",
      designTokens: { fontScale: 1, spacingScale: 1, contrastMode: "normal" },
      templateSwitched: false,
    },
    minScore: 85,
    maxAttempts: options.maxAttempts,
    compose: async ({ attempt }) => ({ html: '<html><body data-slide-page="1"></body></html>', screenshotPath: `/tmp/attempt-${attempt}.png` }),
    evaluate: async () => {
      const index = evaluationIndex++;
      return {
        ...reportWith({}),
        score: options.scores[index],
        safeToReturn: options.safeFlags?.[index] ?? true,
        hardGatePassed: options.hardGates[index],
      };
    },
    repair: async ({ state, actions }) => ({
      ...state,
      templateSwitched: state.templateSwitched || actions.some((action) => action.type === "switch_template"),
    }),
  };
}
