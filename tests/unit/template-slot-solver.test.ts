import assert from "node:assert/strict";
import test from "node:test";

import type { PageBlueprint, SemanticRole } from "../../src/domain/page-blueprint.js";
import type { TemplateProfile } from "../../src/domain/template-profile.js";
import { mapSlideContent } from "../../src/services/slide-content-mapper.js";
import { materializeSlideSpec } from "../../src/services/page-blueprint-builder.js";
import { solveTemplateSlots } from "../../src/services/template-slot-solver.js";

function blueprint(groups: Array<{ role: SemanticRole; title: string; body: string }>): PageBlueprint {
  const contentGroups = groups.map((group, index) => ({
    id: `group-${index + 1}`,
    order: index,
    ...group,
    sourceSectionIds: [`section-${index + 1}`],
    sourceFactIds: [`fact-${index + 1}`],
  }));
  return {
    version: 1,
    pageNumber: 17,
    title: "通用交付机制",
    documentType: "proposal",
    groups: contentGroups,
    sourceFactIds: contentGroups.flatMap((group) => group.sourceFactIds),
    density: "medium",
    visualNeed: "none",
    assets: [],
  };
}

function profile(overrides: Record<string, unknown> = {}): TemplateProfile {
  return {
    slug: "arbitrary-layout",
    version: "1.0.0",
    themeId: "neutral-paper",
    pageIntents: ["detail", "process", "comparison", "evidence", "visual-support"],
    supportedRoles: ["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence", "visual"],
    semanticSlots: [{
      id: "main",
      priority: 1,
      required: true,
      itemCapacity: 3,
      maxCharsPerItem: 120,
      acceptedRoles: ["fact", "metric", "process", "comparison", "evidence"],
      bindings: { title: "component-title", body: "paragraph" },
    }],
    blockCapacity: 3,
    supportedBlocks: ["text", "image", "table", "process", "metric"],
    imageSlots: { placeholderTag: "figures", placeholderCount: 0, minAssets: 0, maxAssets: 0, unusedPolicy: "remove-placeholder" },
    densityRange: ["low", "high"],
    maxCharsBySlot: {
      "component-title": 60,
      paragraph: 120,
      "fact-title": 60,
      "fact-body": 120,
      "process-title": 60,
      "process-body": 120,
      "item-label": 60,
      "page-title": 100,
      "page-number": 4,
      "section-title": 100,
      "part-number": 20,
      "part-label": 40,
      "chapter-label": 100,
      "topic-title": 100,
      "subsection-title": 160,
      "summary-text": 160,
    },
    maxRasterAreaRatio: 0.18,
    minimumBodyFontPt: 8.5,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    documentCompatibility: { bid: true, proposal: true, presentation: true },
    format: "a4-landscape",
    status: "approved",
    ...overrides,
  } as unknown as TemplateProfile;
}

function parsedTemplate(tags: Record<string, number>) {
  return {
    slug: "fixture",
    html: "<html></html>",
    filePath: "/tmp/fixture.html",
    metadata: { slug: "fixture", name: "fixture", description: "", usecase: [], format: "a4-landscape", layout: "", components: [], style: "", lang: "zh-CN", filePath: "/tmp/fixture.html" },
    placeholders: Object.entries(tags).map(([tag, count]) => ({ tag, count, currentText: "" })),
    icons: [],
  };
}

test("equivalent profiles produce the same assignment after slug rename", () => {
  const page = blueprint([
    { role: "fact", title: "履约要求", body: "按原文要求执行。" },
    { role: "process", title: "实施流程", body: "首先复核，然后交付。" },
  ]);
  const first = solveTemplateSlots(page, profile({ slug: "alpha-layout" }));
  const second = solveTemplateSlots(page, profile({ slug: "renamed-layout" }));
  assert.deepEqual(first.assignments, second.assignments);
  assert.equal(first.feasible, true);
});

test("slot order and IDs do not change mapped semantic content", () => {
  const page = blueprint([
    { role: "fact", title: "稳定团队", body: "团队保持稳定。" },
    { role: "process", title: "交付流程", body: "首先提交，然后审核。" },
  ]);
  const profileA = profile({ semanticSlots: [
    { id: "facts", priority: 1, required: false, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["fact"], bindings: { title: "fact-title", body: "fact-body" } },
    { id: "processes", priority: 2, required: false, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["process"], bindings: { title: "process-title", body: "process-body" } },
  ] });
  const profileB = profile({ semanticSlots: [
    { id: "renamed-process", priority: 2, required: false, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["process"], bindings: { title: "process-title", body: "process-body" } },
    { id: "renamed-fact", priority: 1, required: false, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["fact"], bindings: { title: "fact-title", body: "fact-body" } },
  ] });
  const template = parsedTemplate({ "fact-title": 1, "fact-body": 1, "process-title": 1, "process-body": 1 });
  const spec = materializeSlideSpec(page);
  assert.deepEqual(mapSlideContent(spec, template, profileA), mapSlideContent(spec, template, profileB));
});

test("semantic binding expansion fills each declared table row without dropping the fact body", () => {
  const page = blueprint([
    { role: "fact", title: "履约要求", body: "完整保留要求正文。" },
    { role: "metric", title: "考核指标", body: "完整保留指标正文。" },
  ]);
  const tableProfile = profile({
    blockCapacity: 2,
    semanticSlots: [{
      id: "table-rows",
      priority: 1,
      required: true,
      itemCapacity: 2,
      maxCharsPerItem: 120,
      acceptedRoles: ["fact", "metric"],
      bindings: { tableCell: "table-cell" },
      factBearingBinding: "tableCell",
      bindingExpansion: { tableCell: 2 },
    }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, "table-cell": 120 },
  });
  const mapped = mapSlideContent(materializeSlideSpec(page), parsedTemplate({ "table-cell": 4 }), tableProfile);
  assert.deepEqual(mapped["table-cell"], ["履约要求", "完整保留要求正文。", "考核指标", "完整保留指标正文。"]);
});

test("unmatched roles and facts return explicit diagnostics", () => {
  const page = blueprint([{ role: "comparison", title: "方案对比", body: "A方案优于B方案。" }]);
  const result = solveTemplateSlots(page, profile({
    supportedRoles: ["fact"],
    semanticSlots: [{ id: "facts", priority: 1, required: true, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["fact"], bindings: { title: "component-title", body: "paragraph" } }],
  }));
  assert.equal(result.feasible, false);
  assert.deepEqual(result.unmatched[0]?.sourceFactIds, ["fact-1"]);
  assert.match(result.unmatched[0]?.reason ?? "", /角色/);
  assert.deepEqual(result.unrepresentedFactIds, ["fact-1"]);
});

test("item capacity and per-item character limits are hard constraints", () => {
  const tooMany = solveTemplateSlots(blueprint([
    { role: "fact", title: "要求一", body: "内容一" },
    { role: "fact", title: "要求二", body: "内容二" },
  ]), profile({ semanticSlots: [{ id: "only", priority: 1, required: true, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["fact"], bindings: { title: "component-title", body: "paragraph" } }] }));
  const tooLong = solveTemplateSlots(blueprint([
    { role: "fact", title: "长文要求", body: "一".repeat(121) },
  ]), profile({ semanticSlots: [{ id: "only", priority: 1, required: true, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["fact"], bindings: { title: "component-title", body: "paragraph" } }] }));
  assert.equal(tooMany.feasible, false);
  assert.match(tooMany.unmatched[0]?.reason ?? "", /容量/);
  assert.equal(tooLong.feasible, false);
  assert.match(tooLong.unmatched[0]?.reason ?? "", /字符/);
});

test("role-specific slots cannot reorder groups against source order", () => {
  const page = blueprint([
    { role: "process", title: "先执行", body: "先执行实施流程。" },
    { role: "fact", title: "后说明", body: "后说明履约要求。" },
  ]);
  const result = solveTemplateSlots(page, profile({ semanticSlots: [
    { id: "fact-first", priority: 1, required: false, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["fact"], bindings: { title: "fact-title", body: "fact-body" } },
    { id: "process-second", priority: 2, required: false, itemCapacity: 1, maxCharsPerItem: 120, acceptedRoles: ["process"], bindings: { title: "process-title", body: "process-body" } },
  ] }));
  assert.equal(result.feasible, false);
  assert.deepEqual(result.unrepresentedFactIds, ["fact-2"]);
  assert.match(result.unmatched[0]?.reason ?? "", /源顺序/);
});

test("short-title-only slots cannot claim source facts are represented", () => {
  const page = blueprint([{ role: "fact", title: "履约要求", body: "每个事实必须完整展示。" }]);
  const result = solveTemplateSlots(page, profile({ semanticSlots: [{
    id: "labels-only",
    priority: 1,
    required: true,
    itemCapacity: 1,
    maxCharsPerItem: 120,
    acceptedRoles: ["fact"],
    bindings: { shortTitle: "item-label" },
  }] }));
  assert.equal(result.feasible, false);
  assert.deepEqual(result.unrepresentedFactIds, ["fact-1"]);
  assert.match(result.unmatched[0]?.reason ?? "", /无损事实/);
});

test("table expansion that emits only the title cannot represent the fact body", () => {
  const page = blueprint([{ role: "fact", title: "履约要求", body: "完整事实正文必须出现。" }]);
  const result = solveTemplateSlots(page, profile({
    blockCapacity: 1,
    semanticSlots: [{
      id: "title-only-table",
      priority: 1,
      required: true,
      itemCapacity: 1,
      maxCharsPerItem: 120,
      acceptedRoles: ["fact"],
      bindings: { tableCell: "table-cell" },
      factBearingBinding: "tableCell",
      factBearingValueIndex: 0,
      bindingExpansion: { tableCell: 1 },
    }],
    maxCharsBySlot: { ...profile().maxCharsBySlot, "table-cell": 120 },
  }));
  assert.equal(result.feasible, false);
  assert.deepEqual(result.unrepresentedFactIds, ["fact-1"]);
  assert.match(result.unmatched[0]?.reason ?? "", /完整事实正文|无损事实/);
});
