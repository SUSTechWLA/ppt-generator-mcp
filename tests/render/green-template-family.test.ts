import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";

import type { GeneratedAsset, SlideBlockType, SlideSpec } from "../../src/domain/slide-spec.js";
import { loadTemplate } from "../../src/lib/template-parser.js";
import { evaluateDeterministic } from "../../src/services/deterministic-evaluator.js";
import { renderPage } from "../../src/services/page-renderer.js";
import { composeSlide } from "../../src/services/slide-composer.js";
import { getDocumentTemplatePolicy, loadTemplateProfiles, selectTemplate } from "../../src/services/template-selector.js";

const templatesDir = resolve("templates");
const profiles = loadTemplateProfiles(templatesDir);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";

function specFor(types: SlideBlockType[], options: { asset?: boolean; density?: "low" | "medium" | "high" } = {}): SlideSpec {
  const blocks = types.map((type, index) => ({
    id: `block-${index + 1}`,
    type,
    semanticRole: type === "process" ? "process" as const : type === "table" ? "comparison" as const : "fact" as const,
    title: `通用要点${index + 1}`,
    body: `第${index + 1}项要求完整保留并按既定机制执行。`,
    bullets: [],
    metrics: [],
    sourceFactIds: [`fact-${index + 1}`],
  }));
  const assets = options.asset ? [{
    id: "img-001" as const,
    type: "image" as const,
    blockId: blocks[0].id,
    prompt: "professional service workflow scene, green paper-white, no text",
    alt: "通用服务场景示意图",
    sourceFactIds: blocks[0].sourceFactIds,
    width: 1792 as const,
    height: 1024 as const,
  }] : [];
  return {
    title: "通用项目展示方案",
    eyebrow: "项目方案",
    conclusion: "全部要求均由明确机制承接并形成可核验结果。",
    blocks,
    assets,
    sourceFactIds: blocks.flatMap((block) => block.sourceFactIds),
    designIntent: { tone: "professional", density: options.density ?? "medium", visualRatio: options.asset ? 0.18 : 0 },
  };
}

function generatedAssets(spec: SlideSpec): GeneratedAsset[] {
  return spec.assets.map((asset) => ({
    id: asset.id,
    promptHash: `hash-${asset.id}`,
    mimeType: "image/png",
    filePath: `/tmp/${asset.id}.png`,
    dataUrl: `data:image/png;base64,${png}`,
    reused: false,
  }));
}

for (const scenario of [
  { name: "dense fact", spec: specFor(["text", "text", "text", "text", "text"], { density: "high" }) },
  { name: "process", spec: specFor(["process", "process", "process"], { density: "medium" }) },
  { name: "comparison", spec: specFor(["table", "table", "table", "table"], { asset: true, density: "high" }) },
  { name: "sparse", spec: specFor(["text"], { density: "low" }) },
] as const) {
  test(`green family composes and renders a lossless ${scenario.name} page`, async () => {
    const selection = selectTemplate(scenario.spec, profiles, undefined, "bid", "green-infographic-v1");
    const profile = profiles.find((candidate) => candidate.slug === selection.slug)!;
    const composed = await composeSlide({
      spec: scenario.spec,
      profile,
      template: loadTemplate(templatesDir, selection.slug),
      assets: generatedAssets(scenario.spec),
      page: {
        number: 17,
        sectionTitle: "项目服务方案",
        partNumber: "PART.01",
        partLabel: "方案响应",
        chapterLabel: "1.1 通用执行机制",
        subsectionTitle: "1.1.1 全流程服务要求",
      },
    });
    for (const block of scenario.spec.blocks) assert.match(composed.html, new RegExp(block.body));
    const document = new JSDOM(composed.html).window.document;
    const semanticItems = Array.from(document.querySelectorAll<HTMLElement>("[data-semantic-slot]"));
    assert.equal(semanticItems.length, scenario.spec.blocks.length);
    assert.deepEqual(semanticItems.map((element) => element.dataset.blockId), scenario.spec.blocks.map((block) => block.id));
    assert.equal(
      semanticItems.every((element) => Boolean(element.textContent?.trim())),
      true,
    );
    assert.equal(composed.warnings.length, 0);
    assert.doesNotMatch(composed.html, /<figures|<icon|<script|https?:\/\//i);

    const output = await mkdtemp(join(tmpdir(), "green-family-render-"));
    const render = await renderPage({ html: composed.html, screenshotPath: join(output, `${scenario.name}.png`) });
    const policy = getDocumentTemplatePolicy("bid");
    const report = evaluateDeterministic(render, {
      maxRasterAreaRatio: Math.min(profile.maxRasterAreaRatio, policy.maxRasterAreaRatio),
      maximumRasterAssets: policy.maxImageAssets,
      minimumBodyFontPt: Math.max(profile.minimumBodyFontPt, policy.minimumBodyFontPt),
    });
    assert.equal(report.hardGatePassed, true, `${selection.slug}: ${JSON.stringify(report.issues, null, 2)}`);
  });
}
