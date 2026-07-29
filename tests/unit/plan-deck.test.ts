import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { planDeckInputSchema, planDeckOutputSchema } from "../../src/domain/deck-plan.js";
import { WorkflowError } from "../../src/domain/workflow-error.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { DeckStore } from "../../src/workflow/deck-store.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../../src/workflow/plan-deck.js";

function page(number: number, title: string, body: string): string {
  return `<page ${number}>\n一级标题：数字产品方案\n二级标题：客户交付\n三级标题：运行保障\n四级标题：${title}\n正文：\n${body}`;
}

const explicitSource = [
  page(17, "稳定响应", "必须配置1名固定负责人，合同期内不得随意变更。\n每日形成1份记录。"),
  page(23, "履约流程", "接到指令后30分钟内启动，1小时内到场。\n未经采购人书面批准不得变更。"),
].join("\n\n");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "plan-deck-test-"));
  const store = new DeckStore(directory);
  const profiles = loadTemplateProfiles(resolve("templates"));
  return {
    directory,
    store,
    deps: createPlanDeckDependencies({ deckStore: store, profiles }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("high-level deck input rejects pre-parsed sections", () => {
  assert.throws(() => planDeckInputSchema.parse({
    sections: [{ heading: "非法入口", body: "这种输入不应触发高层规划。" }],
    pageNumbers: [1], documentType: "bid",
  }));
});

test("plan deck preserves arbitrary explicit page boundaries and persists grounding evidence", async () => {
  const f = await fixture();
  try {
    const result = await planDeckWorkflow({
      sourceMarkdown: explicitSource,
      pageNumbers: [17, 23],
      documentType: "bid",
      preferredThemeId: "green-infographic-v1",
      quality: { minScore: 90, maxAttempts: 3 },
      requestId: "generic-explicit-plan",
    }, f.deps);

    assert.deepEqual(result.plannedDeck.slides.map((slide) => slide.page.number), [17, 23]);
    assert.ok(result.plannedDeck.slides.every((slide) => slide.displayPlan.grounding.passed));
    assert.ok(result.plannedDeck.slides.every((slide) => slide.originalSourceFacts.length === slide.originalSourceFactIds.length));
    assert.ok(result.plannedDeck.slides.every((slide) => slide.templateMatch.unmatched.length === 0));
    assert.ok(result.plannedDeck.slides.every((slide) => slide.templateMatch.themeId === "green-infographic-v1"));
    assert.match(JSON.stringify(result.plannedDeck.slides[1]), /30分钟/);
    assert.match(JSON.stringify(result.plannedDeck.slides[1]), /书面批准/);

    const persisted = planDeckOutputSchema.parse(await f.store.getPlan(result.plannedDeck.deckPlanId));
    assert.deepEqual(persisted, result);
  } finally {
    await f.cleanup();
  }
});

test("plan deck is idempotent and rejects request fingerprint reuse", async () => {
  const f = await fixture();
  try {
    const input = {
      sourceText: explicitSource, pageNumbers: [17, 23], documentType: "bid" as const,
      preferredThemeId: "green-infographic-v1", requestId: "idempotent-plan-request",
    };
    const first = await planDeckWorkflow(input, f.deps);
    const second = await planDeckWorkflow(input, f.deps);
    assert.deepEqual(second, first);

    await assert.rejects(
      () => planDeckWorkflow({ ...input, sourceText: explicitSource.replace("1小时", "2小时") }, f.deps),
      /fingerprint mismatch/,
    );
  } finally {
    await f.cleanup();
  }
});

test("unmarked and marker-mismatched input never falls back to semantic pagination", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => planDeckWorkflow({ sourceText: "# 运行方案\n必须每日检查1次并保留记录。", pageNumbers: [1] }, f.deps),
      /explicit <page N>/,
    );
    await assert.rejects(
      () => planDeckWorkflow({ sourceText: explicitSource, pageNumbers: [17, 24] }, f.deps),
      /exactly match explicit markers/,
    );
  } finally {
    await f.cleanup();
  }
});

test("profile capacity failure retains structured inner diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-deck-capacity-test-"));
  try {
    const loaded = loadTemplateProfiles(resolve("templates"));
    const base = structuredClone(loaded.find((profile) => profile.imageSlots.minAssets === 0 && profile.documentCompatibility.bid)!);
    base.slug = "tiny-capability-profile";
    base.blockCapacity = 1;
    base.semanticSlots = [{
      ...base.semanticSlots[0],
      itemCapacity: 1,
      maxCharsPerItem: 8,
      bindings: { body: "paragraph" },
      factBearingBinding: "body",
      factBearingValueIndex: 0,
      bindingExpansion: { body: 1 },
    }];
    base.maxCharsBySlot = { ...base.maxCharsBySlot, paragraph: 8 };
    const deps = createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles: [base] });

    await assert.rejects(
      () => planDeckWorkflow({
        sourceText: page(9, "严格时限", "项目必须在1234567890分钟内完成，未经采购人书面批准不得变更。"),
        pageNumbers: [9],
        templateSlug: base.slug,
      }, deps),
      (error: unknown) => error instanceof WorkflowError
        && error.code === "INPUT_INVALID"
        && error.stage === "build_page_blueprint"
        && /no honest profile-budgeted display plan/.test(error.message)
        && Boolean(error.recovery?.includes("code=INPUT_INVALID"))
        && Boolean(error.recovery?.includes("stage=build_page_blueprint"))
        && Boolean(error.recovery?.includes("profile=tiny-capability-profile")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
