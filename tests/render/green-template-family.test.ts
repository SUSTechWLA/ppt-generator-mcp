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
import { evaluateSlide } from "../../src/services/slide-evaluator.js";
import { executeRepairs, type RepairState } from "../../src/services/repair-executor.js";
import { getDocumentTemplatePolicy, loadTemplateProfiles, selectTemplate } from "../../src/services/template-selector.js";
import { solveTemplateSlots } from "../../src/services/template-slot-solver.js";
import { runQualityLoop } from "../../src/workflow/quality-loop.js";
import { makeSourceDocument } from "../helpers/domain-fixtures.js";

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

function profileBoundarySpec(profile: (typeof profiles)[number], bodyChars: number): SlideSpec {
  const factBinding = profile.semanticSlots[0].factBearingBinding;
  const type: SlideBlockType = factBinding === "tableCell" ? "table" : "text";
  const spec = specFor(Array.from({ length: profile.blockCapacity }, () => type), { density: "high" });
  spec.blocks = spec.blocks.map((block, index) => ({
    ...block,
    title: `边界要点${index + 1}`,
    body: "项".repeat(bodyChars),
  }));
  spec.assets = Array.from({ length: profile.imageSlots.minAssets }, (_, index) => ({
    id: `img-${String(index + 1).padStart(3, "0")}`,
    type: "image" as const,
    blockId: spec.blocks[index % spec.blocks.length].id,
    prompt: "professional bid service illustration, no text",
    alt: "项目服务示意图",
    sourceFactIds: spec.blocks[index % spec.blocks.length].sourceFactIds,
    width: 1792 as const,
    height: 1024 as const,
  }));
  spec.designIntent.visualRatio = spec.assets.length > 0 ? profile.maxRasterAreaRatio : 0;
  return spec;
}

for (const profile of profiles) {
  test(`${profile.slug} renders its declared fact boundary at default tokens`, async () => {
    const slot = profile.semanticSlots[0];
    const factTag = slot.bindings[slot.factBearingBinding]!;
    const auxiliaryFactTags = Object.entries(profile.auxiliaryBindings ?? {})
      .filter(([field]) => ["body", "narrativeBody", "tableCell"].includes(field))
      .map(([, tag]) => tag);
    const effectiveFactCapacity = Math.min(...[factTag, ...auxiliaryFactTags].map((tag) => profile.maxCharsBySlot[tag]));
    assert.equal(slot.maxCharsPerItem, effectiveFactCapacity, "semantic capacity must equal the smallest emitted fact-bearing tag capacity");
    const spec = profileBoundarySpec(profile, slot.maxCharsPerItem);
    const solution = solveTemplateSlots(spec, profile);
    assert.equal(solution.feasible, true, JSON.stringify(solution.unmatched));
    const composed = await composeSlide({
      spec,
      profile,
      template: loadTemplate(templatesDir, profile.slug),
      assets: generatedAssets(spec),
      slotSolution: solution,
      designTokens: { fontScale: 1, spacingScale: 1, contrastMode: "normal" },
    });
    const output = await mkdtemp(join(tmpdir(), "green-capacity-boundary-"));
    const render = await renderPage({ html: composed.html, screenshotPath: join(output, `${profile.slug}.png`) });
    const report = evaluateDeterministic(render, {
      maxRasterAreaRatio: profile.maxRasterAreaRatio,
      maximumRasterAssets: profile.imageSlots.maxAssets,
      minimumBodyFontPt: profile.minimumBodyFontPt,
    });
    assert.equal(report.hardGatePassed, true, JSON.stringify(report.issues, null, 2));
  });

  test(`${profile.slug} rejects one character above its declared fact boundary`, () => {
    const cap = profile.semanticSlots[0].maxCharsPerItem;
    const solution = solveTemplateSlots(profileBoundarySpec(profile, cap + 1), profile);
    assert.equal(solution.feasible, false);
    assert.ok(solution.unmatched.some((item) => /字符上限/.test(item.reason)));
  });
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

test("repair design tokens produce measurable layout changes without dropping below 8.5pt", async () => {
  const templateSlug = "green-infographic-bid-a4-landscape";
  const profile = profiles.find((candidate) => candidate.slug === templateSlug)!;
  const template = loadTemplate(templatesDir, templateSlug);
  const spec = specFor(["text", "text", "text"]);
  const output = await mkdtemp(join(tmpdir(), "green-token-render-"));
  const normal = await composeSlide({ spec, profile, template, assets: [] });
  const repaired = await composeSlide({
    spec,
    profile,
    template,
    assets: [],
    designTokens: { fontScale: 0.86, spacingScale: 0.88, contrastMode: "high" },
  });
  const normalRender = await renderPage({ html: normal.html, screenshotPath: join(output, "normal.png") });
  const repairedRender = await renderPage({ html: repaired.html, screenshotPath: join(output, "repaired.png") });
  const bodyText = spec.blocks[0].body;
  const normalBody = normalRender.elements.find((element) => element.text === bodyText)!;
  const repairedBody = repairedRender.elements.find((element) => element.text === bodyText)!;
  assert.ok(normalBody && repairedBody);
  assert.ok(repairedBody.fontSize < normalBody.fontSize, `${repairedBody.fontSize} should be below ${normalBody.fontSize}`);
  assert.ok(repairedBody.fontSize >= 8.5 * (96 / 72) - 0.05, `${repairedBody.fontSize}px must preserve the 8.5pt floor`);
  assert.notEqual(repairedBody.rect.x, normalBody.rect.x, "spacing token must change computed geometry");
  assert.ok(repairedBody.contrastRatio > normalBody.contrastRatio, "high-contrast token must improve computed text contrast");
  assert.notEqual(repairedRender.screenshotDataUrl, normalRender.screenshotDataUrl, "repair must change rendered pixels");
});

test("real quality loop repairs contrast, re-renders, and terminates at a passing hard gate", async () => {
  const templateSlug = "green-infographic-bid-a4-landscape";
  const profile = profiles.find((candidate) => candidate.slug === templateSlug)!;
  const baseTemplate = loadTemplate(templatesDir, templateSlug);
  const template = {
    ...baseTemplate,
    html: baseTemplate.html.replace(
      "</head>",
      "<style>:root:not([data-contrast=\"high\"]){--ink:#dcead8;--green-900:#dcead8;--muted:#dcead8}</style></head>",
    ),
  };
  const spec = specFor(["text", "text", "text"]);
  const originalBodies = spec.blocks.map((block) => block.body);
  const output = await mkdtemp(join(tmpdir(), "green-repair-loop-"));
  const policy = getDocumentTemplatePolicy("bid");
  const renders = new Map<number, Awaited<ReturnType<typeof renderPage>>>();
  const initialState: RepairState = {
    spec,
    assets: [],
    templateSlug,
    designTokens: { fontScale: 1, spacingScale: 1, contrastMode: "normal" },
    templateSwitched: false,
  };
  const source = makeSourceDocument();
  const result = await runQualityLoop({
    initialState,
    minScore: 85,
    maxAttempts: 3,
    compose: async ({ state, attempt }) => {
      const composed = await composeSlide({ spec: state.spec, profile, template, assets: state.assets, designTokens: state.designTokens });
      const screenshotPath = join(output, `attempt-${attempt}.png`);
      renders.set(attempt, await renderPage({ html: composed.html, screenshotPath }));
      return { html: composed.html, screenshotPath };
    },
    evaluate: async ({ state, attempt }) => {
      const render = renders.get(attempt)!;
      const deterministic = evaluateDeterministic(render, {
        maxRasterAreaRatio: Math.min(profile.maxRasterAreaRatio, policy.maxRasterAreaRatio),
        maximumRasterAssets: policy.maxImageAssets,
        minimumBodyFontPt: Math.max(profile.minimumBodyFontPt, policy.minimumBodyFontPt),
      });
      return evaluateSlide({ source, spec: state.spec, render, deterministic });
    },
    repair: ({ state, actions }) => executeRepairs({ state, actions, source }),
  });

  assert.equal(result.status, "delivered");
  assert.equal(result.selectedAttempt, 2);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].quality.hardGatePassed, false);
  assert.ok(result.attempts[0].quality.issues.some((issue) => issue.category === "readability" && /contrast|对比度/i.test(issue.evidence)));
  assert.equal(result.attempts[1].state.designTokens.contrastMode, "high");
  assert.equal(result.attempts[1].quality.hardGatePassed, true);
  assert.deepEqual(result.attempts[1].state.spec.blocks.map((block) => block.body), originalBodies);
});
