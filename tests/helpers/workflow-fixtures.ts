import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QualityReport } from "../../src/domain/quality-report.js";
import type { WorkflowDependencies } from "../../src/workflow/generate-slide.js";
import { RunStore } from "../../src/workflow/run-store.js";
import type { AttemptResult, QualityLoopResult } from "../../src/workflow/quality-loop.js";
import { makeGeneratedAssets, makeSlideSpec, makeSourceDocument, makeTemplateProfiles } from "./domain-fixtures.js";

export const workflowInput = {
  sourceText: "# 服务方案\n\n## 响应机制\n项目必须在30分钟内响应，并覆盖8个服务点。",
  quality: { minScore: 85, maxAttempts: 3 },
};

async function writeFakeAttempts(runDir: string, scores: number[], hardGates: boolean[]): Promise<QualityLoopResult> {
  const spec = makeSlideSpec({ assetCount: 1 });
  const state = {
    spec,
    assets: makeGeneratedAssets(spec.assets),
    templateSlug: "green-infographic-bid-a4-landscape-text-image",
    designTokens: { fontScale: 1, spacingScale: 1, contrastMode: "normal" as const },
    templateSwitched: false,
  };
  const attempts: AttemptResult[] = [];
  for (let index = 0; index < scores.length; index += 1) {
    const attempt = index + 1;
    const directory = join(runDir, "attempts", String(attempt).padStart(2, "0"));
    await mkdir(directory, { recursive: true });
    const htmlPath = join(directory, "page.html");
    const screenshotPath = join(directory, "preview.png");
    const qualityPath = join(directory, "quality.json");
    const quality: QualityReport = {
      score: scores[index],
      safeToReturn: true,
      hardGatePassed: hardGates[index],
      dimensions: { fidelity: scores[index], structure: scores[index], readability: scores[index], layout: scores[index], asset: scores[index], technical: scores[index] },
      issues: [],
    };
    const html = '<html><body><article data-slide-page="1"><img src="data:image/png;base64,iVBORw0KGgo="></article></body></html>';
    await Promise.all([
      writeFile(htmlPath, html),
      writeFile(screenshotPath, Buffer.from("iVBORw0KGgo=", "base64")),
      writeFile(qualityPath, JSON.stringify(quality, null, 2)),
    ]);
    attempts.push({ attempt, html, htmlPath, screenshotPath, qualityPath, quality, actions: [], state });
  }
  const selected = [...attempts].sort((left, right) => right.quality.score - left.quality.score)[0];
  return {
    status: selected.quality.hardGatePassed && selected.quality.score >= 85 ? "delivered" : "best_effort",
    attempts,
    selectedAttempt: selected.attempt,
  };
}

export async function makeWorkflowDependencies(options: { scores: number[]; hardGates: boolean[] }) {
  const root = await mkdtemp(join(tmpdir(), "ppt-workflow-"));
  const counters = { imageCalls: 0 };
  const source = makeSourceDocument();
  const spec = makeSlideSpec({ factIds: source.facts.map((fact) => fact.id), assetCount: 1 });
  const assets = makeGeneratedAssets(spec.assets);
  const dependencies: WorkflowDependencies & { counters: typeof counters } = {
    counters,
    runStore: new RunStore(root),
    profiles: makeTemplateProfiles(),
    normalizeSource: () => source,
    buildSlideSpec: async () => spec,
    selectTemplate: () => ({ slug: "green-infographic-bid-a4-landscape-text-image", reason: "图片槽位与内容匹配", score: 95, candidates: [] }),
    generateAssets: async () => { counters.imageCalls += 1; return assets; },
    composeSlide: async () => ({ html: '<html><body><article data-slide-page="1"><img src="data:image/png;base64,iVBORw0KGgo="></article></body></html>', warnings: [] }),
    runQualityLoop: async (input) => writeFakeAttempts(input.runDir, options.scores, options.hardGates),
  };
  return dependencies;
}
