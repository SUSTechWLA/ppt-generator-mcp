import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createProductionDependencies } from "../../src/app.js";
import { loadAppConfig } from "../../src/config/env.js";
import type { GenerateSlideOutput } from "../../src/domain/quality-report.js";
import type { DeckConsistencyPage } from "../../src/services/deck-consistency.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { DeckStore } from "../../src/workflow/deck-store.js";
import {
  createGenerateDeckDependencies,
  generateDeckWorkflow,
  type PlannedPageWorkflowInput,
} from "../../src/workflow/generate-deck.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../../src/workflow/plan-deck.js";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";

function page(number: number, title: string, body: string): string {
  return `<page ${number}>\n一级标题：数字产品方案\n二级标题：客户交付\n三级标题：运行保障\n四级标题：${title}\n正文：\n${body}`;
}

async function fixture(options: { pages?: number[]; forceAssets?: boolean; maxAttempts?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "generate-deck-e2e-"));
  const profiles = loadTemplateProfiles(resolve("templates"));
  const pageNumbers = options.pages ?? [101, 104];
  const sourceText = pageNumbers.map((number, index) => page(
    number,
    index === 0 ? "稳定响应" : "履约流程",
    options.forceAssets
      ? "首先启动现场检查。其次提交问题清单。最后完成整改复核。"
      : index === 0 ? "必须配置1名固定负责人。" : "指令30分钟内启动，1小时内到场。",
  )).join("\n\n");
  const plan = await planDeckWorkflow({
    sourceText,
    pageNumbers,
    documentType: "bid",
    preferredThemeId: "green-infographic-v1",
    ...(options.forceAssets ? { templateSlug: "green-infographic-bid-a4-landscape" } : {}),
    quality: { minScore: 90, maxAttempts: options.maxAttempts ?? 3 },
  }, createPlanDeckDependencies({ deckStore: new DeckStore(root), profiles }));
  return { root, profiles, plan, store: new DeckStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function result(runId: string, pageNumber: number, status: GenerateSlideOutput["status"] = "delivered"): GenerateSlideOutput {
  return {
    runId,
    status,
    selectedTemplate: { slug: "green-infographic-bid-a4-landscape", reason: "persisted compatible profile" },
    artifacts: {
      htmlPath: `/internal/runs/${runId}/final.html`,
      previewPath: `/internal/runs/${runId}/final.png`,
      manifestPath: `/internal/runs/${runId}/manifest.json`,
    },
    quality: {
      score: status === "delivered" ? 92 : 82,
      threshold: 90,
      hardGatePassed: status === "delivered",
      attempts: 2,
      dimensions: { fidelity: 92, structure: 92, readability: 92, layout: 92, asset: 92, technical: 92 },
      remainingIssues: [],
    },
    summary: `page ${pageNumber}`,
  };
}

function evidence(input: PlannedPageWorkflowInput, output: GenerateSlideOutput): DeckConsistencyPage {
  const profile = input.profile;
  const fields = Object.fromEntries(input.expectedMetadataBindings.map((binding) => [binding.field, binding.values]));
  const ranges = profile.designContract!.landmarkRanges;
  const width = 1123;
  const height = 794;
  const landmarkRects = Object.fromEntries(profile.requiredLandmarks.map((landmark) => {
    const range = ranges[landmark]!;
    return [landmark, [{ x: range.xRatio[0] * width, y: range.yRatio[0] * height, width: range.widthRatio[0] * width, height: range.heightRatio[0] * height }]];
  })) as DeckConsistencyPage["render"]["structure"]["landmarkRects"];
  const landmarkCounts = Object.fromEntries(profile.requiredLandmarks.map((landmark) => [landmark, 1])) as DeckConsistencyPage["render"]["structure"]["landmarkCounts"];
  return {
    pageNumber: input.page.number,
    status: output.status,
    selectedTemplateSlug: output.selectedTemplate.slug,
    quality: output.quality,
    render: {
      viewport: { width, height },
      pageCount: 1,
      structure: {
        pageNumber: String(input.page.number),
        profile: { slug: profile.slug, version: profile.version, themeId: profile.themeId, format: profile.format },
        designTokens: {
          fontFamily: profile.designContract!.tokens.fontFamilies[0],
          textColor: profile.designContract!.tokens.textColors[0],
          backgroundColor: profile.designContract!.tokens.backgroundColors[0],
          fontScale: String(profile.designContract!.tokens.fontScaleRange[0]),
          spacingScale: String(profile.designContract!.tokens.spacingScaleRange[0]),
          contrastMode: profile.designContract!.tokens.contrastModes[0],
        },
        landmarkCounts,
        landmarkRects,
        pageFields: fields,
        semanticItems: [], blankComponents: [], protectedGeneratedText: [], protectedClipViolations: [],
      },
    },
  };
}

test("asset preflight rejects duplicate, unknown, and replacement while zero-asset plans proceed", async () => {
  const withAssets = await fixture({ pages: [205], forceAssets: true });
  try {
    const [asset] = withAssets.plan.assets;
    assert.ok(asset);
    const calls: PlannedPageWorkflowInput[] = [];
    const deps = createGenerateDeckDependencies({
      deckStore: withAssets.store,
      profiles: withAssets.profiles,
      generatePage: async (input) => { calls.push(input); return result(crypto.randomUUID(), input.page.number); },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });

    const missing = await generateDeckWorkflow({ deckPlanId: withAssets.plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "assets-preflight-run" }, deps);
    assert.equal(missing.status, "needs_assets");
    assert.deepEqual(missing.missingAssetIds, [asset.id]);
    assert.equal(calls.length, 0, "no page work may start before assets are complete");

    await assert.rejects(() => generateDeckWorkflow({ deckPlanId: withAssets.plan.plannedDeck.deckPlanId, externalAssets: [{ id: asset.id, dataUrl: PNG }, { id: asset.id, dataUrl: PNG }], requestId: "assets-preflight-run" }, deps), /duplicate/i);
    await assert.rejects(() => generateDeckWorkflow({ deckPlanId: withAssets.plan.plannedDeck.deckPlanId, externalAssets: [{ id: "p205-img-999", dataUrl: PNG }], requestId: "assets-preflight-run" }, deps), /unknown/i);
    await assert.rejects(
      () => generateDeckWorkflow({ deckPlanId: withAssets.plan.plannedDeck.deckPlanId, externalAssets: [{ id: asset.id, dataUrl: `data:image/png;base64,${"a".repeat(32)}` }], requestId: "assets-preflight-run" }, deps),
      /image bytes|match image/i,
    );
    assert.deepEqual((await withAssets.store.getRun(missing.deckRunId)).assetHashes, {}, "invalid image bytes must not poison the immutable hash registry");

    const delivered = await generateDeckWorkflow({ deckPlanId: withAssets.plan.plannedDeck.deckPlanId, externalAssets: [{ id: asset.id, dataUrl: PNG }], requestId: "assets-preflight-run" }, deps);
    assert.equal(delivered.status, "delivered");
    const deckManifest = await readFile(join(withAssets.root, "decks", "runs", delivered.deckRunId, "manifest.json"), "utf8");
    assert.doesNotMatch(deckManifest, /data:image|iVBORw0KGgo|base64/i, "DeckStore must persist only asset hashes, never image bytes");
    assert.doesNotMatch(JSON.stringify(delivered), /data:image|iVBORw0KGgo|base64/i);
    const changed = PNG.replace(/.$/, "A");
    await assert.rejects(() => generateDeckWorkflow({ deckPlanId: withAssets.plan.plannedDeck.deckPlanId, externalAssets: [{ id: asset.id, dataUrl: changed }], requestId: "assets-preflight-run" }, deps), /replacement/i);
  } finally {
    await withAssets.cleanup();
  }

  const zero = await fixture({ pages: [301] });
  try {
    assert.equal(zero.plan.assets.length, 0);
    const deps = createGenerateDeckDependencies({
      deckStore: zero.store,
      profiles: zero.profiles,
      generatePage: async (input) => result(crypto.randomUUID(), input.page.number),
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const output = await generateDeckWorkflow({ deckPlanId: zero.plan.plannedDeck.deckPlanId, externalAssets: [] }, deps);
    assert.equal(output.status, "delivered");
  } finally {
    await zero.cleanup();
  }
});

test("asset preflight applies the injected production byte limit before creating or mutating a run", async () => {
  const f = await fixture({ pages: [207], forceAssets: true });
  try {
    const pngBytes = Buffer.from(PNG.split(",")[1], "base64");
    const oversizedPng = `data:image/png;base64,${Buffer.concat([pngBytes, Buffer.from([0])]).toString("base64")}`;
    const supplied = f.plan.assets.map((asset, index) => ({ id: asset.id, dataUrl: index === 0 ? oversizedPng : PNG }));
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      maxImageBytes: pngBytes.length,
      generatePage: async (input) => result(crypto.randomUUID(), input.page.number),
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const requestId = "asset-byte-limit-run";

    await assert.rejects(() => generateDeckWorkflow({
      deckPlanId: f.plan.plannedDeck.deckPlanId,
      externalAssets: supplied,
      requestId,
    }, deps), /maximum byte size/i);
    assert.deepEqual(await readdir(join(f.root, "decks", "runs")), [], "invalid bytes must be rejected before a run manifest is created");

    const repaired = await generateDeckWorkflow({
      deckPlanId: f.plan.plannedDeck.deckPlanId,
      externalAssets: f.plan.assets.map((asset) => ({ id: asset.id, dataUrl: PNG })),
      requestId,
    }, deps);
    assert.equal(repaired.status, "delivered");
    assert.deepEqual(
      Object.keys((await f.store.getRun(repaired.deckRunId)).assetHashes).sort(),
      f.plan.assets.map((asset) => asset.id).sort(),
    );
  } finally {
    await f.cleanup();
  }
});

test("partial generation preserves safe later pages and resume retries only non-delivered pages", async () => {
  const f = await fixture();
  try {
    const calls: number[] = [];
    let page101Fails = true;
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => {
        calls.push(input.page.number);
        if (input.page.number === 101 && page101Fails) throw new Error("provider failed at /Users/private with sk-secret");
        return result(crypto.randomUUID(), input.page.number);
      },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const first = await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "partial-resume-run" }, deps);
    assert.equal(first.status, "partial");
    assert.deepEqual(first.pages.map((entry) => entry.pageNumber), [101, 104]);
    assert.doesNotMatch(JSON.stringify(first), /sk-secret|\/Users\/private|provider failed/);
    const delivered104 = first.pages.find((entry) => entry.pageNumber === 104 && "runId" in entry);
    assert.ok(delivered104 && "runId" in delivered104);

    page101Fails = false;
    const second = await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "partial-resume-run" }, deps);
    assert.equal(second.status, "delivered");
    assert.deepEqual(calls, [101, 104, 101]);
    const resumed104 = second.pages.find((entry) => entry.pageNumber === 104 && "runId" in entry);
    assert.ok(resumed104 && "runId" in resumed104);
    assert.equal(resumed104.runId, delivered104.runId);

    const persisted = JSON.stringify(await f.store.getRun(first.deckRunId));
    assert.doesNotMatch(persisted, /sk-secret|\/Users\/private|provider failed/);
  } finally {
    await f.cleanup();
  }
});

test("failed asset page resume requires bytes again even when their hashes were registered", async () => {
  const f = await fixture({ pages: [206], forceAssets: true });
  try {
    assert.ok(f.plan.assets.length > 0);
    const suppliedAssets = f.plan.assets.map((asset) => ({ id: asset.id, dataUrl: PNG }));
    let failPage = true;
    const calls: string[][] = [];
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => {
        calls.push(input.externalAssets.map((asset) => asset.id));
        if (failPage) throw new Error("first page attempt failed");
        return result(crypto.randomUUID(), input.page.number);
      },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const requestId = "asset-bytes-resume-run";

    const first = await generateDeckWorkflow({
      deckPlanId: f.plan.plannedDeck.deckPlanId,
      externalAssets: suppliedAssets,
      requestId,
    }, deps);
    assert.equal(first.status, "failed");
    assert.deepEqual(Object.keys((await f.store.getRun(first.deckRunId)).assetHashes).sort(), suppliedAssets.map((asset) => asset.id).sort());

    const withoutBytes = await generateDeckWorkflow({
      deckPlanId: f.plan.plannedDeck.deckPlanId,
      externalAssets: [],
      requestId,
    }, deps);
    assert.equal(withoutBytes.status, "needs_assets");
    assert.deepEqual(withoutBytes.missingAssetIds, suppliedAssets.map((asset) => asset.id));
    assert.equal(calls.length, 1, "resume without bytes must not retry page generation");

    failPage = false;
    const repaired = await generateDeckWorkflow({
      deckPlanId: f.plan.plannedDeck.deckPlanId,
      externalAssets: suppliedAssets,
      requestId,
    }, deps);
    assert.equal(repaired.status, "delivered");
    assert.deepEqual(calls, [suppliedAssets.map((asset) => asset.id), suppliedAssets.map((asset) => asset.id)]);
  } finally {
    await f.cleanup();
  }
});

test("planned page execution receives immutable QA context and persisted quality bounds", async () => {
  const f = await fixture({ pages: [411] });
  try {
    let captured: PlannedPageWorkflowInput | undefined;
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => { captured = input; return result(crypto.randomUUID(), input.page.number); },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [] }, deps);
    assert.ok(captured);
    const slide = f.plan.plannedDeck.slides[0];
    assert.deepEqual(captured.sourceSections, slide.sourceSections);
    assert.deepEqual(captured.displayPlan, slide.displayPlan);
    assert.deepEqual(captured.plannedSpec, slide.plannedSpec);
    assert.deepEqual(captured.page, slide.page);
    assert.equal(captured.profile.slug, slide.templateSlug);
    assert.equal(captured.themeId, slide.templateMatch.themeId);
    assert.equal(captured.documentPolicy.documentType, "bid");
    assert.deepEqual(captured.expectedMetadataBindings, slide.templateMatch.metadataBindings.map(({ field, values }) => ({ field, values })));
    assert.deepEqual(captured.quality, { minScore: 90, maxAttempts: 3 });
  } finally {
    await f.cleanup();
  }
});

test("concurrent resumes cannot overwrite delivered evidence with a later failure", async () => {
  const f = await fixture({ pages: [501] });
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let invocation = 0;
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => {
        invocation += 1;
        const own = invocation;
        await gate;
        if (own === 2) throw new Error("late failure");
        return result(crypto.randomUUID(), input.page.number);
      },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const raw = { deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [], requestId: "concurrent-resume-run" };
    const first = generateDeckWorkflow(raw, deps);
    const second = generateDeckWorkflow(raw, deps);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const outputs = await Promise.all([first, second]);
    assert.ok(outputs.some((output) => output.status === "delivered"));
    const [record] = await f.store.listPageRecords(outputs[0].deckRunId);
    assert.equal(record.status, "delivered");
  } finally {
    await f.cleanup();
  }
});

test("consistency failure keeps page deliveries but prevents deck delivery", async () => {
  const f = await fixture({ pages: [601] });
  try {
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => result(crypto.randomUUID(), input.page.number),
      inspectDeliveredPage: async (input, output) => {
        const invalid = evidence(input, output);
        invalid.render.structure.pageNumber = "999";
        return invalid;
      },
    });
    const output = await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [] }, deps);
    assert.equal(output.status, "partial");
    assert.equal(output.consistency?.passed, false);
    assert.equal(output.pages[0]?.status, "delivered");
    assert.equal((await f.store.listPageRecords(output.deckRunId))[0]?.status, "delivered");
  } finally {
    await f.cleanup();
  }
});

test("successful page diagnostics cannot persist secrets, stacks, or caller paths", async () => {
  const f = await fixture({ pages: [650] });
  try {
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => {
        const unsafe = result(crypto.randomUUID(), input.page.number);
        return {
          ...unsafe,
          summary: "review at /Users/caller/private.ts exposed sk-1234567890abcdef",
          quality: {
            ...unsafe.quality,
            remainingIssues: [{
              id: "leak",
              severity: "warning",
              category: "technical",
              evidence: "Error: provider failure\n    at private (/Users/caller/private.ts:1:1)",
              suggestedAction: "Bearer abcdefghijklmnop",
            }],
          },
        };
      },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const output = await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [] }, deps);
    assert.equal(output.status, "failed");
    const persisted = JSON.stringify(await f.store.getRun(output.deckRunId));
    assert.doesNotMatch(`${JSON.stringify(output)}${persisted}`, /sk-123|Bearer abc|\/Users\/caller|private\.ts|provider failure/);
  } finally {
    await f.cleanup();
  }
});

test("page results cannot substitute caller thresholds or exceed persisted repair attempts", async () => {
  const f = await fixture({ pages: [701], maxAttempts: 2 });
  try {
    let mode: "threshold" | "attempts" = "threshold";
    const deps = createGenerateDeckDependencies({
      deckStore: f.store,
      profiles: f.profiles,
      generatePage: async (input) => {
        const forged = result(crypto.randomUUID(), input.page.number);
        return {
          ...forged,
          quality: {
            ...forged.quality,
            threshold: mode === "threshold" ? 70 : 90,
            attempts: mode === "attempts" ? 3 : 2,
          },
        };
      },
      inspectDeliveredPage: async (input, output) => evidence(input, output),
    });
    const thresholdOutput = await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [] }, deps);
    assert.equal(thresholdOutput.status, "failed");
    assert.equal(thresholdOutput.pages[0]?.status, "failed");
    mode = "attempts";
    const attemptsOutput = await generateDeckWorkflow({ deckPlanId: f.plan.plannedDeck.deckPlanId, externalAssets: [] }, deps);
    assert.equal(attemptsOutput.status, "failed");
    assert.equal(attemptsOutput.pages[0]?.status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("production deck integration composes and QA-checks one immutable planned page without replanning", async () => {
  const root = await mkdtemp(join(tmpdir(), "generate-deck-production-"));
  try {
    const dependencies = createProductionDependencies(
      loadAppConfig({ PPT_OUTPUT_ROOT: root }),
      { templatesDir: resolve("templates") },
    );
    const planned = await dependencies.planDeck({
      sourceText: page(801, "责任人机制", "固定负责人配置数量为1名。规定响应时限为30分钟。"),
      pageNumbers: [801],
      documentType: "bid",
      quality: { minScore: 90, maxAttempts: 3 },
    });
    assert.equal(planned.assets.length, 0);
    const output = await dependencies.generateDeck({
      deckPlanId: planned.plannedDeck.deckPlanId,
      externalAssets: [],
    });
    assert.equal(output.status, "delivered", JSON.stringify(output.consistency));
    assert.equal(output.pages.length, 1);
    const delivered = output.pages[0];
    assert.ok(delivered && "quality" in delivered && "artifacts" in delivered);
    assert.equal(delivered.quality.threshold, 90);
    assert.ok(delivered.quality.attempts <= 3);
    assert.match(await readFile(delivered.artifacts.htmlPath, "utf8"), /data-slide-page="801"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production review diagnostics are closed before first attempt and final persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "generate-deck-review-safety-"));
  const unsafeText = [
    "https://review.invalid/callback?token=url-secret",
    "/Users/reviewer/private/key.txt",
    "OPENAI_API_KEY=review-secret",
    "Error: leaked stack\n    at review (/Users/reviewer/review.ts:8:4)",
    "data:image/png;base64,TEVBS1lfQkFTRTY0",
  ].join(" | ");
  const mock = await startMockOpenAIServer({
    reviewScore: 95,
    reviewIssues: [{
      id: "unsafe-review-warning",
      severity: "warning",
      category: "technical",
      evidence: unsafeText,
      targetId: "https://review.invalid/private-target",
      suggestedAction: "Bearer review-credential-secret",
    }],
  });
  t.after(async () => {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  });
  const dependencies = createProductionDependencies(mock.configFor(root), { templatesDir: resolve("templates") });
  const planned = await dependencies.planDeck({
    sourceText: page(901, "责任人机制", "固定负责人配置数量为1名。规定响应时限为30分钟。"),
    pageNumbers: [901],
    documentType: "bid",
    quality: { minScore: 90, maxAttempts: 2 },
  });
  assert.equal(planned.assets.length, 0);

  const output = await dependencies.generateDeck({ deckPlanId: planned.plannedDeck.deckPlanId, externalAssets: [] });
  assert.equal(output.status, "delivered");
  const delivered = output.pages[0];
  assert.ok(delivered && "runId" in delivered);
  const attemptQuality = await readFile(join(root, delivered.runId, "attempts", "01", "quality.json"), "utf8");
  const pageManifest = await readFile(join(root, delivered.runId, "manifest.json"), "utf8");
  const finalQuality = await readFile(join(root, delivered.runId, "quality.json"), "utf8");
  const deckManifest = await readFile(join(root, "decks", "runs", output.deckRunId, "manifest.json"), "utf8");
  const allPersistence = `${attemptQuality}\n${pageManifest}\n${finalQuality}\n${deckManifest}\n${JSON.stringify(output)}`;

  assert.match(attemptQuality, /External review diagnostic removed by safety policy/);
  assert.doesNotMatch(allPersistence, /url-secret|\/Users\/reviewer|review-secret|leaked stack|TEVBS1lfQkFTRTY0|review-credential-secret/);
});
