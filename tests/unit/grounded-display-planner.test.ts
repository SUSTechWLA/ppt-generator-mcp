import assert from "node:assert/strict";
import test from "node:test";

import type { TemplateProfile } from "../../src/domain/template-profile.js";
import { WorkflowError } from "../../src/domain/workflow-error.js";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import {
  planGroundedDisplay,
  verifyGroundedDisplay,
} from "../../src/services/grounded-display-planner.js";
import { extractCanonicalAnchors } from "../../src/domain/critical-anchor.js";

function profile(overrides: Partial<TemplateProfile> = {}): TemplateProfile {
  return {
    slug: "capability-layout",
    version: "1.0.0",
    themeId: "neutral-theme",
    pageIntents: ["detail", "process", "comparison", "evidence", "visual-support"],
    supportedRoles: ["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence", "visual"],
    semanticSlots: [{
      id: "main",
      priority: 1,
      required: true,
      itemCapacity: 3,
      maxCharsPerItem: 80,
      acceptedRoles: ["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence"],
      bindings: { title: "component-title", body: "paragraph" },
      factBearingBinding: "body",
      factBearingValueIndex: 0,
      bindingExpansion: { title: 1, body: 1 },
    }],
    pageBindings: {
      pageTitle: "page-title", pageNumber: "page-number", sectionTitle: "section-title",
      partNumber: "part-number", partLabel: "part-label", chapterLabel: "chapter-label",
      topicTitle: "topic-title", subsectionTitle: "subsection-title", summaryText: "summary-text",
    },
    blockCapacity: 3,
    supportedBlocks: ["text", "image", "table", "process", "metric"],
    imageSlots: { placeholderTag: "figures", placeholderCount: 0, minAssets: 0, maxAssets: 0, unusedPolicy: "remove-placeholder" },
    densityRange: ["medium", "high"],
    maxCharsBySlot: {
      "component-title": 30, paragraph: 80, "page-title": 40, "page-number": 4,
      "section-title": 60, "part-number": 20, "part-label": 30, "chapter-label": 80,
      "topic-title": 40, "subsection-title": 60, "summary-text": 100,
    },
    maxRasterAreaRatio: 0,
    minimumBodyFontPt: 8.5,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    documentCompatibility: { bid: true, proposal: true, presentation: true },
    format: "a4-landscape",
    status: "approved",
    ...overrides,
  };
}

const denseBody = [
  "项目必须配置1名固定负责人，合同期内不得随意变更。",
  "接到临时指令后30分钟内启动调配，1小时内到场。",
  "人员变更须提交书面申请，未经采购人书面批准不得上岗。",
  "新任人员上岗前不少于五个工作日完成交接，上岗后三个工作日内拜访。",
  "锦棠华府36,130.50㎡与溪语雅苑23,234㎡作为重点区域。",
].join("\n");

test("grounded compaction covers every fact once and preserves critical anchors", () => {
  const source = normalizeSource({ sections: [{ heading: "履约保障", body: denseBody }], quality: { minScore: 90, maxAttempts: 3 } });
  const result = planGroundedDisplay(source, {
    pageNumber: 17, title: "履约保障", documentType: "bid", profile: profile(),
  });

  assert.deepEqual(result.blueprint.groups.flatMap((group) => group.sourceFactIds), source.facts.map((fact) => fact.id));
  assert.equal(result.displayPlan.grounding.passed, true);
  assert.equal(result.displayPlan.factCoverages.length, source.facts.length);
  const visible = result.blueprint.groups.map((group) => group.body).join("\n");
  for (const token of ["1名", "不得", "30分钟", "1小时", "书面批准", "未经", "五个工作日", "三个工作日", "锦棠华府", "36,130.50㎡", "溪语雅苑", "23,234㎡"]) {
    assert.match(visible, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(result.blueprint.groups.every((group) => group.body.length <= 80));
  assert.doesNotMatch(visible, /…|\.\.\./);
  assert.deepEqual(verifyGroundedDisplay(source.facts, result.blueprint.groups, result.displayPlan).issues, []);
});

test("effective capacity uses the tighter fact-bearing binding and block capacity", () => {
  const source = normalizeSource({ sections: [{ heading: "运行要求", body: "必须保留1项完整记录。\n必须保留2项完整记录。\n必须保留3项完整记录。" }], quality: { minScore: 90, maxAttempts: 3 } });
  const tight = profile({
    blockCapacity: 2,
    semanticSlots: [{
      id: "matrix", priority: 1, required: true, itemCapacity: 6, maxCharsPerItem: 80,
      acceptedRoles: ["fact", "metric", "process", "comparison", "evidence", "conclusion", "headline"],
      bindings: { tableCell: "table-cell" }, factBearingBinding: "tableCell", factBearingValueIndex: 1,
      bindingExpansion: { tableCell: 2 },
    }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, "table-cell": 24 },
  });

  const result = planGroundedDisplay(source, { pageNumber: 8, title: "运行要求", documentType: "bid", profile: tight });

  assert.ok(result.blueprint.groups.length <= 2);
  assert.ok(result.blueprint.groups.every((group) => group.body.length <= 24));
  assert.equal(result.displayPlan.targetBudget.itemCapacity, 2);
  assert.equal(result.displayPlan.targetBudget.maxCharsPerItem, 24);
});

test("equivalent capabilities produce identical grounded content after a slug rename", () => {
  const source = normalizeSource({ sections: [{ heading: "通用履约", body: denseBody }], quality: { minScore: 90, maxAttempts: 3 } });
  const first = planGroundedDisplay(source, { pageNumber: 33, title: "通用履约", documentType: "bid", profile: profile({ slug: "first-identity" }) });
  const renamed = planGroundedDisplay(source, { pageNumber: 33, title: "通用履约", documentType: "bid", profile: profile({ slug: "renamed-identity" }) });

  assert.deepEqual(renamed.blueprint, first.blueprint);
  assert.deepEqual(renamed.displayPlan, first.displayPlan);
});

test("an optional image is emitted only for a semantically justified process group", () => {
  const source = normalizeSource({
    sections: [{ heading: "交付流程", body: "首先接收任务。\n随后完成审核。\n然后组织实施。\n最后形成反馈。" }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  const visualProfile = profile({
    maxRasterAreaRatio: 0.18,
    imageSlots: { placeholderTag: "figures", placeholderCount: 1, minAssets: 0, maxAssets: 1, unusedPolicy: "remove-container", containerSelector: "figure" },
  });
  const result = planGroundedDisplay(source, { pageNumber: 34, title: "交付流程", documentType: "bid", profile: visualProfile });

  assert.equal(result.blueprint.assets.length, 1);
  assert.equal(result.blueprint.assets[0].id, "p34-img-001");
  assert.match(result.blueprint.assets[0].prompt, /no text, no logo, no watermark/);
});

test("dense content returns a structured capacity error instead of truncating facts", () => {
  const source = normalizeSource({ sections: [{ heading: "超密集内容", body: "项目必须在1234567890分钟内完成并经采购人书面批准。" }], quality: { minScore: 90, maxAttempts: 3 } });
  const impossible = profile({
    blockCapacity: 1,
    semanticSlots: [{
      id: "tiny", priority: 1, required: true, itemCapacity: 1, maxCharsPerItem: 8,
      acceptedRoles: ["fact", "metric", "process", "comparison", "evidence", "conclusion", "headline"],
      bindings: { body: "paragraph" }, factBearingBinding: "body", factBearingValueIndex: 0,
      bindingExpansion: { body: 1 },
    }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 8 },
  });

  assert.throws(
    () => planGroundedDisplay(source, { pageNumber: 9, title: "超密集内容", documentType: "bid", profile: impossible }),
    (error: unknown) => error instanceof WorkflowError
      && error.code === "INPUT_INVALID"
      && error.stage === "build_page_blueprint"
      && /capacity|budget|profile/i.test(error.message)
      && Boolean(error.recovery?.includes("profile=")),
  );
});

test("more than 200 extracted facts fail planning with an explicit no-loss diagnostic", () => {
  const body = Array.from({ length: 201 }, (_, index) => `第${index + 1}项任务必须完成。`).join("\n");
  const source = normalizeSource({ sections: [{ heading: "超限事实", body }], quality: { minScore: 90, maxAttempts: 3 } });
  assert.equal(source.facts.length, 201);

  assert.throws(
    () => planGroundedDisplay(source, { pageNumber: 10, title: "超限事实", documentType: "bid", profile: profile() }),
    (error: unknown) => error instanceof WorkflowError
      && error.code === "INPUT_INVALID"
      && /201 facts/.test(error.message)
      && Boolean(error.recovery?.includes("No facts were dropped")),
  );
});

test("verifier recomputes canonical project-name and negation anchors from source", () => {
  const source = normalizeSource({
    sections: [{ heading: "连续性要求", body: "星河壹号在长周期服务期间要求全程无中断并保留可追溯记录。" }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  const result = planGroundedDisplay(source, { pageNumber: 35, title: "连续性要求", documentType: "bid", profile: profile({
    semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 32 }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 32 },
  }) });
  const visible = result.blueprint.groups.map((group) => group.body).join("\n");
  assert.match(visible, /星河壹号/);
  assert.match(visible, /无中断/);

  const forged = structuredClone(result.displayPlan);
  forged.factCoverages[0].criticalAnchors = [];
  const verification = verifyGroundedDisplay(source.facts, result.blueprint.groups, forged);
  assert.equal(verification.passed, false);
  assert.match(verification.issues.join("\n"), /canonical|anchor/i);
});

for (const scenario of [
  { text: `年度目标明确，配置3,000（${"甲".repeat(24)}）株常绿乔木。`, number: "3,000", unit: "株" },
  { text: `年度目标明确，服务12（${"乙".repeat(24)}）万人次。`, number: "12", unit: "万人次" },
  { text: `年度目标明确，配置5（${"丙".repeat(24)}）辆作业车。`, number: "5", unit: "辆" },
  { text: `年度目标明确，服务12（${"丁".repeat(24)}）家子项目。`, number: "12", unit: "家" },
] as const) {
  test(`numeric anchor retains independently separated unit ${scenario.unit}`, () => {
    const source = normalizeSource({ sections: [{ heading: "数量要求", body: scenario.text }], quality: { minScore: 90, maxAttempts: 3 } });
    const result = planGroundedDisplay(source, { pageNumber: 36, title: "数量要求", documentType: "bid", profile: profile({
      semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 34 }],
      maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 34 },
    }) });
    const visible = result.blueprint.groups[0].body;
    assert.match(visible, new RegExp(scenario.number.replace(",", "\\,")));
    assert.match(visible, new RegExp(scenario.unit));
    assert.ok(result.displayPlan.factCoverages[0].criticalAnchors.some((anchor) => anchor.kind === "unit" && anchor.text === scenario.unit));
  });
}

test("anchor extraction has negative controls for place and ordinary noun prefixes", () => {
  const anchors = extractCanonicalAnchors("无锡市未央区的名称由采购人确认。");
  assert.equal(anchors.some((anchor) => anchor.kind === "negation"), false);
  assert.equal(anchors.some((anchor) => anchor.kind === "unit" && anchor.text === "名"), false);
  assert.ok(anchors.some((anchor) => anchor.kind === "name" && /(?:无锡市|未央区)/.test(anchor.text)));
});

for (const subject of ["云栖府", "滨江壹品", "钱塘江沿线"] as const) {
  test(`conservative subject grounding retains unknown Chinese name ${subject}`, () => {
    const source = normalizeSource({
      sections: [{ heading: "服务对象", body: `${subject}承担常态化环境维护、应急响应和设施巡检等综合工作，后续运行状态稳定。` }],
      quality: { minScore: 90, maxAttempts: 3 },
    });
    const result = planGroundedDisplay(source, { pageNumber: 37, title: "服务对象", documentType: "bid", profile: profile({
      semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 34 }],
      maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 34 },
    }) });
    assert.match(result.blueprint.groups[0].body, new RegExp(subject));
    assert.ok(result.displayPlan.factCoverages[0].criticalAnchors.some((anchor) => anchor.kind === "subject" && anchor.text.includes(subject)));
  });
}

test("explicit enumeration clause retains all unknown names", () => {
  const source = normalizeSource({
    sections: [{ heading: "服务范围", body: "服务范围包括云栖府、滨江壹品和钱塘江沿线，必须每日巡查。" }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  const result = planGroundedDisplay(source, { pageNumber: 38, title: "服务范围", documentType: "bid", profile: profile({
    semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 44 }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 44 },
  }) });
  assert.match(result.blueprint.groups[0].body, /云栖府/);
  assert.match(result.blueprint.groups[0].body, /滨江壹品/);
  assert.match(result.blueprint.groups[0].body, /钱塘江/);
  assert.ok(result.displayPlan.factCoverages[0].criticalAnchors.some((anchor) =>
    anchor.kind === "subject" && /云栖府.*滨江壹品.*钱塘江/u.test(anchor.text)
  ));
});

test("ordinary subject prefix is structural rather than a fabricated name", () => {
  const anchors = extractCanonicalAnchors("工作人员承担常态化维护工作，服务期间必须每日巡查。");
  assert.equal(anchors.some((anchor) => anchor.kind === "name"), false);
  assert.ok(anchors.some((anchor) => anchor.kind === "subject" && anchor.text === "工作人员承担常态化维护工作"));
});

test("subject plus mandatory tokens fail capacity instead of silently dropping the subject", () => {
  const source = normalizeSource({
    sections: [{ heading: "服务对象", body: "云栖府承担常态化环境维护工作，服务期间必须每日巡查并保留记录。" }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  assert.throws(
    () => planGroundedDisplay(source, { pageNumber: 39, title: "服务对象", documentType: "bid", profile: profile({
      semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 7 }],
      maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 7 },
    }) }),
    (error: unknown) => error instanceof WorkflowError && /without losing grounded source anchors/.test(error.message),
  );
});

test("complete first semantic clause retains coordinated object names across enumeration commas", () => {
  const firstClause = "服务团队重点保障云栖府、滨江壹品和钱塘江沿线";
  const source = normalizeSource({
    sections: [{ heading: "重点对象", body: `${firstClause}，必须在30分钟内响应并形成闭环。` }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  const result = planGroundedDisplay(source, { pageNumber: 40, title: "重点对象", documentType: "bid", profile: profile({
    semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 44 }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 44 },
  }) });
  assert.match(result.blueprint.groups[0].body, /云栖府/);
  assert.match(result.blueprint.groups[0].body, /滨江壹品/);
  assert.match(result.blueprint.groups[0].body, /钱塘江/);
  assert.ok(result.displayPlan.factCoverages[0].criticalAnchors.some((anchor) =>
    anchor.kind === "subject" && anchor.text === firstClause
  ));
});

test("ordinary first clause is retained as context without fabricating a proper name", () => {
  const firstClause = "工作人员认真完成常规清洁任务";
  const anchors = extractCanonicalAnchors(`${firstClause}，必须每日巡查。`);
  assert.ok(anchors.some((anchor) => anchor.kind === "subject" && anchor.text === firstClause));
  assert.equal(anchors.some((anchor) => anchor.kind === "name"), false);
});

test("overlong first semantic clause produces a structured capacity failure", () => {
  const source = normalizeSource({
    sections: [{ heading: "长分句", body: `服务团队重点保障${"常规作业".repeat(10)}，必须每日巡查。` }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  assert.throws(
    () => planGroundedDisplay(source, { pageNumber: 41, title: "长分句", documentType: "bid", profile: profile({
      semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 34 }],
      maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 34 },
    }) }),
    (error: unknown) => error instanceof WorkflowError
      && error.code === "INPUT_INVALID"
      && /without losing grounded source anchors/.test(error.message),
  );
});

test("syntactic bare obligation markers retain their complete actor-action-object clause", () => {
  for (const clause of [
    "人员应妥善保管资料",
    "人员应每日完成检查",
    "人员应定期完成检查",
    "人员应书面提交结果",
    "团队需持续保留记录",
    "团队需妥善保管资料",
    "团队需服从现场安排",
    "采购人资料应保存完整",
    "项目急需补充人员",
    "材料为作业必需条件",
  ]) {
    const anchors = extractCanonicalAnchors(`${clause}，后续形成闭环。`);
    assert.ok(anchors.some((anchor) => anchor.kind === "obligation" && anchor.text === clause), clause);
  }

  const negative = extractCanonicalAnchors("响应适应反应对应供应效应相应应急应用应聘应届应收应付应力应变应试应景应酬需求所需供需刚需军需内需外需均属于普通词汇。");
  assert.equal(negative.some((anchor) => anchor.kind === "obligation"), false);
});

test("ordinary conclusion does not compact to a fabricated obligation fragment", () => {
  const source = normalizeSource({
    sections: [{ heading: "年度结论", body: "年度目标明确，系统响应顺畅，服务体验良好。" }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  const result = planGroundedDisplay(source, { pageNumber: 42, title: "年度结论", documentType: "bid", profile: profile({
    semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 12 }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 12 },
  }) });
  assert.equal(result.blueprint.groups[0].body, "年度目标明确");
  assert.equal(result.displayPlan.factCoverages[0].criticalAnchors.some((anchor) =>
    anchor.kind === "obligation" && anchor.text === "应"
  ), false);
});

test("reviewer max12 obligation example fails instead of dropping actor action and object", () => {
  const source = normalizeSource({
    sections: [{ heading: "资料安全", body: "服务目标明确，中标人应妥善保管采购人资料，确保档案安全。" }],
    quality: { minScore: 90, maxAttempts: 3 },
  });
  assert.throws(
    () => planGroundedDisplay(source, { pageNumber: 43, title: "资料安全", documentType: "bid", profile: profile({
      semanticSlots: [{ ...profile().semanticSlots[0], maxCharsPerItem: 12 }],
      maxCharsBySlot: { ...profile().maxCharsBySlot, paragraph: 12 },
    }) }),
    (error: unknown) => error instanceof WorkflowError
      && error.code === "INPUT_INVALID"
      && /without losing grounded source anchors/.test(error.message),
  );
});
