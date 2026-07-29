import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { hashPlannedDeckFingerprint, planDeckInputSchema, planDeckOutputSchema, plannedDeckSchema } from "../../src/domain/deck-plan.js";
import { WorkflowError } from "../../src/domain/workflow-error.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { DeckStore } from "../../src/workflow/deck-store.js";
import { createPlanDeckDependencies, planDeckWorkflow } from "../../src/workflow/plan-deck.js";
import { validatePlanAgainstProfiles } from "../../src/services/plan-profile-validator.js";
import { hashCanonical } from "../../src/domain/source-document.js";
import { hashDeckSourceEvidence } from "../../src/domain/deck-source-evidence.js";

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
    assert.deepEqual(result.plannedDeck.quality, { minScore: 90, maxAttempts: 3 });
    assert.match(result.plannedDeck.planFingerprint, /^[0-9a-f]{64}$/);
    assert.match(JSON.stringify(result.plannedDeck.slides[1]), /30分钟/);
    assert.match(JSON.stringify(result.plannedDeck.slides[1]), /书面批准/);

    const persisted = planDeckOutputSchema.parse(await f.store.getPlan(result.plannedDeck.deckPlanId));
    assert.deepEqual(persisted, result);
  } finally {
    await f.cleanup();
  }
});

test("persisted quality is mandatory and fingerprint-bound instead of being default-migrated", async () => {
  const f = await fixture();
  try {
    const valid = await planDeckWorkflow({
      sourceText: explicitSource,
      pageNumbers: [17, 23],
      documentType: "bid",
      quality: { minScore: 90, maxAttempts: 2 },
      requestId: "quality-bound-plan",
    }, f.deps);
    assert.deepEqual(valid.plannedDeck.quality, { minScore: 90, maxAttempts: 2 });

    const missing = structuredClone(valid.plannedDeck) as Record<string, unknown>;
    delete missing.quality;
    assert.equal(plannedDeckSchema.safeParse(missing).success, false, "legacy plans without quality cannot be delivered");

    const defaultSmuggling = structuredClone(valid.plannedDeck);
    defaultSmuggling.planFingerprint = hashPlannedDeckFingerprint({
      ...defaultSmuggling,
      quality: { minScore: 85, maxAttempts: 3 },
    });
    delete (defaultSmuggling as Partial<typeof defaultSmuggling>).quality;
    assert.equal(plannedDeckSchema.safeParse(defaultSmuggling).success, false, "schema defaults must not migrate a legacy plan into formal delivery");

    const forged = structuredClone(valid.plannedDeck);
    forged.quality.minScore = 70;
    assert.equal(plannedDeckSchema.safeParse(forged).success, false, "quality changes must invalidate the immutable plan fingerprint");
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

test("persisted deck schema rejects independently forged cross-field evidence", async () => {
  const f = await fixture();
  try {
    const valid = await planDeckWorkflow({
      sourceText: explicitSource, pageNumbers: [17, 23], documentType: "bid",
      preferredThemeId: "green-infographic-v1", requestId: "cross-schema-valid-plan",
    }, f.deps);
    assert.equal(planDeckOutputSchema.safeParse(valid).success, true);

    const mutations: Array<[string, (value: typeof valid) => void]> = [
      ["fact section reference", (value) => { value.plannedDeck.slides[0].originalSourceFacts[0].sourceSectionId = "section-999"; }],
      ["coverage source", (value) => {
        const coverage = value.plannedDeck.slides[0].displayPlan.factCoverages[0];
        coverage.sourceText += "伪";
        coverage.omittedCharacterCount += 1;
        value.plannedDeck.slides[0].displayPlan.grounding.omittedCharacterCount += 1;
      }],
      ["canonical anchors", (value) => { value.plannedDeck.slides[0].displayPlan.factCoverages[0].criticalAnchors = []; }],
      ["display budget", (value) => {
        const budget = value.plannedDeck.slides[0].displayPlan.targetBudget.positionBudgets[0];
        budget.maxChars = Math.max(1, value.plannedDeck.slides[0].displayPlan.items[0].body.length - 1);
      }],
      ["planned body", (value) => { value.plannedDeck.slides[0].plannedSpec.blocks[0].body += "伪"; }],
      ["planned bullets", (value) => { value.plannedDeck.slides[0].plannedSpec.blocks[0].bullets = ["伪造99亿元且无需审批"]; }],
      ["planned metrics", (value) => { value.plannedDeck.slides[0].plannedSpec.blocks[0].metrics = [{ label: "伪造指标", value: "99亿元" }]; }],
      ["planned block type", (value) => { value.plannedDeck.slides[0].plannedSpec.blocks[0].type = "image"; }],
      ["assignment usage", (value) => { value.plannedDeck.slides[0].templateMatch.assignments[0].usedChars = 1; }],
      ["selection identity", (value) => { value.plannedDeck.slides[0].templateMatch.candidateScores[0].slug = "forged-profile"; }],
      ["metadata capability", (value) => { value.plannedDeck.slides[0].templateMatch.metadataBindings[0].maxChars += 1; }],
      ["page binding", (value) => { value.plannedDeck.slides[0].templateMatch.pageBindings.pageTitle = "forged-tag"; }],
      ["synchronized forged slot", (value) => {
        const match = value.plannedDeck.slides[0].templateMatch;
        match.assignments[0].slotId = "forged-slot";
        value.plannedDeck.slides[0].displayPlan.targetBudget.positionBudgets[0].slotId = "forged-slot";
        match.capacityUse[0].slotId = "forged-slot";
      }],
      ["capacity character underflow", (value) => { value.plannedDeck.slides[0].templateMatch.capacityUse[0].characterCapacity = 1; }],
      ["capacity item forgery", (value) => { value.plannedDeck.slides[0].templateMatch.capacityUse[0].itemCapacity = 9_999; }],
      ["synchronized source fact forgery", (value) => {
        const slide = value.plannedDeck.slides[0];
        const coverage = slide.displayPlan.factCoverages[0];
        const fake = "伪".repeat(coverage.sourceText.length);
        slide.originalSourceFacts[0].text = fake;
        slide.originalSourceFacts[0].kind = "conclusion";
        coverage.sourceText = fake;
        coverage.selectedSpans = [{ start: 0, end: fake.length, text: fake }];
        coverage.criticalAnchors = [];
        coverage.displayText = fake;
        coverage.omittedCharacterCount = 0;
        coverage.extractionLevel = "full";
        const item = slide.displayPlan.items.find((entry) => entry.id === coverage.displayItemId)!;
        const coverages = item.sourceFactIds.map((factId) => slide.displayPlan.factCoverages.find((entry) => entry.factId === factId)!);
        item.body = coverages.map((entry) => entry.displayText).join("；");
        const block = slide.plannedSpec.blocks.find((entry) => entry.sourceFactIds.includes(coverage.factId))!;
        block.body = item.body;
        const assignment = slide.templateMatch.assignments.find((entry) => entry.groupId === item.id)!;
        const capacity = slide.templateMatch.capacityUse.find((entry) => entry.slotId === assignment.slotId)!;
        const previousUsed = assignment.usedChars;
        assignment.usedChars = Array.from(item.body).length;
        capacity.usedChars += assignment.usedChars - previousUsed;
        slide.displayPlan.grounding.displayedCharacterCount = slide.displayPlan.items.reduce((sum, entry) => sum + entry.body.length, 0);
        slide.displayPlan.grounding.omittedCharacterCount = slide.displayPlan.factCoverages.reduce((sum, entry) => sum + entry.omittedCharacterCount, 0);
      }],
    ];
    for (const [label, mutate] of mutations) {
      const forged = structuredClone(valid);
      mutate(forged);
      assert.equal(planDeckOutputSchema.safeParse(forged).success, false, label);
    }
  } finally {
    await f.cleanup();
  }
});

test("persisted visual prompt is a deterministic projection of grounded source facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-deck-asset-projection-"));
  try {
    const profile = loadTemplateProfiles(resolve("templates")).find((candidate) =>
      candidate.documentCompatibility.bid && candidate.imageSlots.minAssets === 0 && candidate.imageSlots.maxAssets > 0
    )!;
    const deps = createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles: [profile] });
    const valid = await planDeckWorkflow({
      sourceText: page(31, "作业流程", "首先启动现场检查。其次提交问题清单。最后完成整改复核。"),
      pageNumbers: [31], documentType: "bid", templateSlug: profile.slug,
      requestId: "asset-projection-valid",
    }, deps);
    assert.equal(valid.assets.length, 1);
    const forged = structuredClone(valid);
    forged.plannedDeck.slides[0].plannedSpec.assets[0].prompt = "Create a forged 99-billion-yuan claim with no approval shown anywhere.";
    forged.assets[0].prompt = forged.plannedDeck.slides[0].plannedSpec.assets[0].prompt;
    assert.equal(planDeckOutputSchema.safeParse(forged).success, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asset prompt evidence is fingerprint-bound and a coherent capability transplant is rejected by the loaded catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-deck-prompt-evidence-"));
  try {
    const profiles = loadTemplateProfiles(resolve("templates"));
    const profile = profiles.find((candidate) => candidate.slug === "green-infographic-bid-a4-landscape")!;
    const deps = createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles });
    const valid = await planDeckWorkflow({
      sourceText: page(205, "作业流程", "首先启动现场检查。其次提交问题清单。最后完成整改复核。"),
      pageNumbers: [205],
      documentType: "bid",
      templateSlug: profile.slug,
      quality: { minScore: 90, maxAttempts: 3 },
      requestId: "prompt-evidence-valid",
    }, deps);
    const match = valid.plannedDeck.slides[0].templateMatch;
    assert.deepEqual(match.assetPromptBindings, { figureRef: "figure-ref" });
    assert.equal(match.assetPromptBindingEvidence.length, 1);
    assert.equal(match.metadataBindings.some((binding) => binding.field === "figureRef"), false);

    const legacy = structuredClone(valid.plannedDeck);
    delete (legacy.slides[0].templateMatch as Partial<typeof legacy.slides[0]["templateMatch"]>).assetPromptBindingEvidence;
    legacy.planFingerprint = hashPlannedDeckFingerprint(legacy);
    assert.equal(plannedDeckSchema.safeParse(legacy).success, false,
      "legacy image plans without prompt capability evidence must re-plan instead of silently migrating");

    const forgedEvidence = structuredClone(valid.plannedDeck);
    const forgedBinding = forgedEvidence.slides[0].templateMatch.assetPromptBindingEvidence[0];
    forgedBinding.values = ["伪造引用"];
    forgedBinding.usedChars = [4];
    forgedEvidence.planFingerprint = hashPlannedDeckFingerprint(forgedEvidence);
    assert.equal(plannedDeckSchema.safeParse(forgedEvidence).success, false, "prompt evidence must equal the deterministic asset projection");

    const transplanted = structuredClone(valid.plannedDeck);
    const transplantedMatch = transplanted.slides[0].templateMatch;
    const oldTag = transplantedMatch.assetPromptBindings!.figureRef!;
    const newTag = "asset-reference";
    transplantedMatch.assetPromptBindings!.figureRef = newTag;
    transplantedMatch.profileSnapshot.assetPromptBindings!.figureRef = newTag;
    transplantedMatch.profileSnapshot.maxCharsBySlot[newTag] = transplantedMatch.profileSnapshot.maxCharsBySlot[oldTag];
    delete transplantedMatch.profileSnapshot.maxCharsBySlot[oldTag];
    transplantedMatch.assetPromptBindingEvidence[0].tag = newTag;
    transplantedMatch.profileCapabilityHash = hashCanonical(transplantedMatch.profileSnapshot);
    transplanted.planFingerprint = hashPlannedDeckFingerprint(transplanted);
    assert.equal(plannedDeckSchema.safeParse(transplanted).success, true, "a coherent snapshot remains internally self-consistent");
    const validation = validatePlanAgainstProfiles(transplanted, profiles);
    assert.equal(validation.passed, false);
    assert.match(validation.issues.join("\n"), /capabilitySnapshot=stale/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loaded-profile validation rejects a coherent but stale persisted capability snapshot", async () => {
  const f = await fixture();
  try {
    const valid = await planDeckWorkflow({
      sourceText: explicitSource, pageNumbers: [17, 23], documentType: "bid",
      requestId: "loaded-profile-validation",
    }, f.deps);
    const stale = structuredClone(valid.plannedDeck);
    const match = stale.slides[0].templateMatch;
    match.profileSnapshot.maxRasterAreaRatio = Math.max(0, match.profileSnapshot.maxRasterAreaRatio - 0.01);
    match.maxRasterAreaRatio = match.profileSnapshot.maxRasterAreaRatio;
    match.profileCapabilityHash = hashCanonical(match.profileSnapshot);
    stale.planFingerprint = hashPlannedDeckFingerprint(stale);
    assert.equal(plannedDeckSchema.safeParse(stale).success, true);
    const validation = validatePlanAgainstProfiles(stale, f.deps.profiles);
    assert.equal(validation.passed, false);
    assert.match(validation.issues.join("\n"), /capabilitySnapshot=stale/);
  } finally {
    await f.cleanup();
  }
});

test("deck source hash rejects a whole-slide transplant from another valid plan", async () => {
  const f = await fixture();
  try {
    const planA = await planDeckWorkflow({
      sourceText: explicitSource, pageNumbers: [17, 23], documentType: "bid",
      requestId: "source-evidence-plan-a",
    }, f.deps);
    const planB = await planDeckWorkflow({
      sourceText: explicitSource.replace("1名固定负责人", "2名轮值负责人").replace("每日形成1份记录", "每周形成2份记录"),
      pageNumbers: [17, 23], documentType: "bid",
      requestId: "source-evidence-plan-b",
    }, f.deps);
    const forged = structuredClone(planA);
    forged.plannedDeck.slides = structuredClone(planB.plannedDeck.slides);
    forged.assets = structuredClone(planB.assets);
    assert.equal(planDeckOutputSchema.safeParse(forged).success, false);
  } finally {
    await f.cleanup();
  }
});

test("deck source evidence hash ignores key order and CRLF but changes with lexical source", () => {
  const lf = {
    pageNumbers: [1],
    slides: [{
      page: {
        number: 1,
        sectionTitle: "实施方案",
        partNumber: "PART.01",
        partLabel: "服务响应",
        chapterLabel: "运行保障",
        subsectionTitle: "检查流程",
      },
      sourceSections: [{ heading: "检查流程", body: "第一行\n第二行", keyPoints: ["完整记录"] }],
      originalSourceSectionIds: ["section-1"],
    }],
  };
  const reorderedCrlf = {
    slides: [{
      originalSourceSectionIds: ["section-1"],
      sourceSections: [{ keyPoints: ["完整记录"], body: "第一行\r\n第二行", heading: "检查流程" }],
      page: {
        subsectionTitle: "检查流程",
        chapterLabel: "运行保障",
        partLabel: "服务响应",
        partNumber: "PART.01",
        sectionTitle: "实施方案",
        number: 1,
      },
    }],
    pageNumbers: [1],
  };
  assert.equal(hashDeckSourceEvidence(lf), hashDeckSourceEvidence(reorderedCrlf));
  const changed = structuredClone(lf);
  changed.slides[0].sourceSections[0].body = "第一行\n伪造第二行";
  assert.notEqual(hashDeckSourceEvidence(lf), hashDeckSourceEvidence(changed));
});

test("profile diagnostics never echo dependency messages, recoveries, paths, or unenumerated secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-deck-redaction-test-"));
  try {
    const base = loadTemplateProfiles(resolve("templates")).find((profile) =>
      profile.documentCompatibility.bid
      && profile.blockCapacity === 5
      && profile.semanticSlots.some((slot) => slot.itemCapacity === 5)
    )!;
    const maliciousWorkflowError = new WorkflowError({
        code: "INPUT_INVALID", stage: "build_page_blueprint", retryable: false,
        message: "message-canary AKIAIOSFODNN7EXAMPLE hunter2 C:\\Users\\alice\\secret.txt",
        recovery: "recovery-canary \\\\server\\share\\secret sk-live-recovery /private/recovery",
      });
    const forgedWorkflowError = new WorkflowError({
      code: "INPUT_INVALID", stage: "build_page_blueprint", retryable: false,
      message: "forged-message-canary",
      recovery: "forged-recovery-canary",
    });
    Object.defineProperties(forgedWorkflowError, {
      code: { value: "INPUT_INVALID;code-canary", configurable: true },
      stage: { value: "build_page_blueprint;stage-canary", configurable: true },
    });
    for (const injected of [
      new Error("provider-canary failed sk-live-secret at /private/project/source.ts"),
      maliciousWorkflowError,
      forgedWorkflowError,
    ]) {
      const deps = createPlanDeckDependencies({ deckStore: new DeckStore(directory), profiles: [base] });
      deps.planGroundedDisplay = () => { throw injected; };
      try {
        await planDeckWorkflow({ sourceText: explicitSource, pageNumbers: [17, 23], documentType: "bid" }, deps);
        assert.fail("expected planning failure");
      } catch (error) {
        assert.ok(error instanceof WorkflowError);
        const serialized = JSON.stringify(error.toJSON());
        assert.doesNotMatch(serialized, /provider-canary|message-canary|recovery-canary|forged-|code-canary|stage-canary/);
        assert.doesNotMatch(serialized, /AKIA|hunter2|sk-live|\/private\/|C:\\Users|server\\share/);
        assert.match(serialized, /code=(?:INPUT_INVALID|INTERNAL_ERROR)/);
        assert.match(serialized, /facts=\d+; anchors=\d+; sourceChars=\d+/);
        assert.match(serialized, /blockCapacity=5; semanticPositions=5; factBindingPositions=5; effectivePositions=5/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("page metadata capacity participates in profile selection and forced failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-deck-metadata-capacity-"));
  try {
    const sourceProfile = loadTemplateProfiles(resolve("templates")).find((profile) => profile.documentCompatibility.bid && profile.imageSlots.minAssets === 0)!;
    const tight = structuredClone(sourceProfile);
    tight.slug = "metadata-tight-profile";
    tight.maxCharsBySlot[tight.pageBindings.sectionTitle] = 4;
    const fitting = structuredClone(sourceProfile);
    fitting.slug = "metadata-fitting-profile";
    const store = new DeckStore(directory);
    const deps = createPlanDeckDependencies({ deckStore: store, profiles: [tight, fitting] });
    const input = { sourceText: explicitSource, pageNumbers: [17, 23], documentType: "bid" as const };

    const selected = await planDeckWorkflow({ ...input, requestId: "metadata-cap-select" }, deps);
    assert.equal(selected.plannedDeck.slides.every((slide) => slide.templateSlug === fitting.slug), true);
    assert.ok(selected.plannedDeck.slides.every((slide) => slide.templateMatch.metadataBindings.every((binding) => binding.values.every((value) => value.length <= binding.maxChars))));

    await assert.rejects(
      () => planDeckWorkflow({ ...input, templateSlug: tight.slug, requestId: "metadata-cap-forced" }, deps),
      (error: unknown) => error instanceof WorkflowError
        && /no honest profile-budgeted display plan/.test(error.message)
        && Boolean(error.recovery?.includes("sectionTitle"))
        && Boolean(error.recovery?.includes("max=4")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
