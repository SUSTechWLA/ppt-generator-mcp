import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hashPlannedDeckFingerprint,
  planDeckInputSchema,
  plannedDeckSchema,
} from "../src/domain/deck-plan.js";
import { selectDeckTemplateSequence } from "../src/services/deck-template-diversity.js";
import { mapSlideContent } from "../src/services/slide-content-mapper.js";
import { loadTemplateProfiles } from "../src/services/template-selector.js";
import { loadTemplate } from "../src/lib/template-parser.js";
import { DeckStore } from "../src/workflow/deck-store.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../src/workflow/plan-deck.js";

const baseInput = {
  sourceText: "<page 1>\n一级标题：示例\n正文：\n事实内容足够用于页面规划和模板选择。",
  pageNumbers: [1],
};

const fourPageSource = `<page 1>
一级标题：实施方案
二级标题：服务流程
三级标题：全过程闭环管理
正文：
项目启动后依次完成现场交接、任务分派、过程巡查和结果复核。每项任务记录责任人、完成时限和验收结果，异常事项进入整改闭环。
<page 2>
一级标题：实施方案
二级标题：资源对比
三级标题：多项目资源配置
正文：
服务覆盖8个项目，总面积96,252.66平方米。常态任务与临时任务分别配置人员、设备和物资，项目负责人根据工作量对比结果实施跨项目调度。
<page 3>
一级标题：质量保障
二级标题：证据管理
三级标题：全过程资料留痕
正文：
计划、工单、现场照片、材料记录、复核意见和整改结果统一编号归档。月度考核前检查资料完整性，保证工作内容与验收依据相互印证。
<page 4>
一级标题：质量保障
二级标题：现场控制
三级标题：安全与秩序管理
正文：
机械作业避开人员集中时段，作业区域设置警示和引导。枝叶、草屑及包装物随产随清，完成一个作业面后复查植物、道路、设备和防护设施。`;

const templateRoot = fileURLToPath(new URL("../templates", import.meta.url));

async function runWorkflowWithSource(
  sourceText: string,
  pageNumbers: number[],
  input: Record<string, unknown>,
) {
  const root = await mkdtemp(join(tmpdir(), "deck-diversity-test-"));
  try {
    const deckStore = new DeckStore(root);
    const profiles = loadTemplateProfiles(templateRoot);
    const dependencies = createPlanDeckDependencies({ deckStore, profiles });
    return await planDeckWorkflow({
      sourceText,
      pageNumbers,
      documentType: "bid",
      preferredThemeId: "green-infographic-v1",
      ...input,
    }, dependencies);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runRealWorkflow(input: Record<string, unknown>) {
  return runWorkflowWithSource(fourPageSource, [1, 2, 3, 4], input);
}

test("accepts explicit template diversity modes without schema-defaulting omission", () => {
  for (const mode of ["off", "conservative", "balanced", "expressive"] as const) {
    assert.equal(planDeckInputSchema.parse({ ...baseInput, templateDiversity: mode }).templateDiversity, mode);
  }
  assert.equal(planDeckInputSchema.parse(baseInput).templateDiversity, undefined);
  assert.equal(planDeckInputSchema.safeParse({ ...baseInput, templateDiversity: "random" }).success, false);
});

test("exports the deck template sequence optimizer", () => {
  assert.equal(typeof selectDeckTemplateSequence, "function");
});

test("balanced selects varied near-best templates without adjacent repetition", () => {
  const pages = Array.from({ length: 4 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 198, selectionScore: 90, catalogIndex: 1 },
    { templateSlug: "layout-c", retainedCharacterCount: 197, selectionScore: 89, catalogIndex: 2 },
  ]);
  const decisions = selectDeckTemplateSequence(pages, "balanced");
  const slugs = decisions.map((decision, page) => pages[page][decision.candidateIndex].templateSlug);
  assert.ok(new Set(slugs).size >= 2);
  assert.equal(slugs.some((slug, index) => index > 0 && slug === slugs[index - 1]), false);
});

test("balanced rejects novelty outside the quality band", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 150, selectionScore: 70, catalogIndex: 1 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "balanced")[0].candidateIndex, 0);
});

test("balanced lets a higher template score offset admitted retained-character loss", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 80, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 198, selectionScore: 90, catalogIndex: 1 },
  ]];
  const decision = selectDeckTemplateSequence(pages, "balanced")[0];
  assert.equal(decision.candidateIndex, 1);
  assert.equal(decision.selectionScoreLoss, -10);
});

test("off preserves local winners and sequence selection is deterministic", () => {
  const pages = Array.from({ length: 4 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 199, selectionScore: 91, catalogIndex: 1 },
  ]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "off").map((item) => item.candidateIndex), [0, 0, 0, 0]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "balanced"), selectDeckTemplateSequence(pages, "balanced"));
});

test("a page with a single candidate selects its local winner", () => {
  const pages = [[
    { templateSlug: "only-layout", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "expressive")[0].candidateIndex, 0);
});

test("conservative rejects any retained-character loss", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 199, selectionScore: 92, catalogIndex: 1 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "conservative")[0].candidateIndex, 0);
});

test("expressive admits a candidate inside its wider retained-character band", () => {
  const pages = Array.from({ length: 2 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 188, selectionScore: 92, catalogIndex: 1 },
  ]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "expressive").map((item) => item.candidateIndex), [0, 1]);
});

test("bounds candidate and state exploration for a 30-page deck", () => {
  const pages = Array.from({ length: 30 }, () => Array.from({ length: 20 }, (_, index) => ({
    templateSlug: `layout-${index}`,
    retainedCharacterCount: 200,
    selectionScore: 92,
    catalogIndex: index,
  })));
  const decisions = selectDeckTemplateSequence(pages, "expressive");
  assert.equal(decisions.length, 30);
  assert.equal(decisions.every((decision) => decision.candidateIndex < 12), true);
});

test("a process-capable text table profile carries process facts through its existing bindings", async () => {
  const templateSlug = "green-infographic-bid-a4-landscape-table-text";
  const sourceText = `<page 1>
一级标题：实施方案
二级标题：服务流程
三级标题：全过程闭环管理
正文：
项目启动后依次完成现场交接、任务分派、过程巡查和结果复核。每项任务记录责任人、完成时限和验收结果，异常事项进入整改闭环。`;
  const output = await runWorkflowWithSource(sourceText, [1], {
    templateSlug,
    requestId: "template-process-capability-001",
  });
  const slide = output.plannedDeck.slides[0];

  assert.equal(slide.templateSlug, templateSlug);
  assert.deepEqual(slide.displayPlan.items.map((item) => item.role), ["process", "process"]);
  assert.deepEqual(slide.templateMatch.assignments.map((item) => item.role), ["process", "process"]);
  assert.deepEqual(slide.templateMatch.representedFactIds, slide.originalSourceFactIds);
  assert.deepEqual(slide.templateMatch.unrepresentedFactIds, []);
  assert.deepEqual(slide.templateMatch.unmatched, []);

  const content = mapSlideContent(
    slide.plannedSpec,
    loadTemplate(templateRoot, templateSlug),
    slide.templateMatch.profileSnapshot,
    slide.page,
  );
  assert.deepEqual((content.paragraph as string[]).filter(Boolean), slide.plannedSpec.blocks.map((block) => block.body));
  assert.equal((content["table-cell"] as string[]).filter(Boolean).includes("实施流程"), true);
});

test("balanced planning selects a feasible varied sequence and persists auditable evidence", async () => {
  const output = await runRealWorkflow({
    templateDiversity: "balanced",
    requestId: "template-diversity-balanced-001",
  });

  const slugs = output.plannedDeck.slides.map((slide) => slide.templateSlug);
  assert.ok(new Set(slugs).size >= 2);
  assert.equal(output.plannedDeck.templateDiversity, "balanced");
  assert.ok(output.plannedDeck.slides.every((slide) => slide.templateMatch.unmatched.length === 0));
  assert.ok(output.plannedDeck.slides.every((slide) => slide.templateMatch.unrepresentedFactIds.length === 0));
  assert.ok(output.plannedDeck.slides.every((slide) => slide.templateMatch.candidateScores.length >= 1));
  assert.ok(output.plannedDeck.slides.some((slide) => slide.templateMatch.candidateScores.length >= 2));
  assert.ok(output.plannedDeck.slides.every((slide) =>
    /mode=balanced; retainedLoss=\d+; retainedLossPercent=\d+(?:\.\d+)?; scoreLoss=-?\d+(?:\.\d+)?; firstUse=(?:true|false); adjacentRepeat=(?:true|false)/
      .test(slide.templateMatch.selectionReason)
  ));
  assert.deepEqual(output.assets, output.plannedDeck.slides.flatMap((slide) => slide.plannedSpec.assets));
});

test("omitted template diversity defaults to balanced in new planned decks", async () => {
  const output = await runRealWorkflow({ requestId: "template-diversity-default-001" });
  assert.equal(output.plannedDeck.templateDiversity, "balanced");
});

test("off planning preserves the real catalog local-winner sequence", async () => {
  const output = await runRealWorkflow({
    templateDiversity: "off",
    requestId: "template-diversity-off-001",
  });

  assert.deepEqual(output.plannedDeck.slides.map((slide) => slide.templateSlug), [
    "green-infographic-bid-a4-landscape",
    "green-infographic-bid-a4-landscape",
    "green-infographic-bid-a4-landscape",
    "green-infographic-bid-a4-landscape",
  ]);
  assert.equal(output.plannedDeck.templateDiversity, "off");
  assert.ok(output.plannedDeck.slides.every((slide) =>
    slide.templateMatch.candidateScores[0]?.slug === slide.templateSlug
  ));
});

test("an explicit template slug forces and persists effective diversity off", async () => {
  const templateSlug = "green-infographic-bid-a4-landscape";
  const output = await runRealWorkflow({
    templateSlug,
    templateDiversity: "expressive",
    requestId: "template-diversity-forced-001",
  });

  assert.equal(output.plannedDeck.templateDiversity, "off");
  assert.deepEqual(new Set(output.plannedDeck.slides.map((slide) => slide.templateSlug)), new Set([templateSlug]));
});

test("historical plans without template diversity retain their original fingerprint shape", async () => {
  const output = await runRealWorkflow({
    templateDiversity: "off",
    requestId: "template-diversity-historical-001",
  });
  const historicalPlan = structuredClone(output.plannedDeck) as Record<string, unknown>;
  delete historicalPlan.templateDiversity;
  historicalPlan.planFingerprint = hashPlannedDeckFingerprint(historicalPlan as Parameters<typeof hashPlannedDeckFingerprint>[0]);

  const parsed = plannedDeckSchema.parse(historicalPlan);
  assert.equal(parsed.templateDiversity, undefined);
  assert.equal(parsed.planFingerprint, historicalPlan.planFingerprint);
});
