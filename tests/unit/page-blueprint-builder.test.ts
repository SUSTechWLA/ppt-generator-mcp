import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pageBlueprintSchema } from "../../src/domain/page-blueprint.js";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import {
  buildPageBlueprint,
  materializeSlideSpec,
} from "../../src/services/page-blueprint-builder.js";

function groupedFactIds(blueprint: ReturnType<typeof buildPageBlueprint>): string[] {
  return blueprint.groups.flatMap((group) => group.sourceFactIds);
}

test("planner detects service metrics and process while preserving facts exactly once", () => {
  const source = normalizeSource({
    sourceText: `# 应急响应
重点区域覆盖8个项目。指令后30分钟启动，1小时到场。

## 闭环管理
每日记录，每周协调，每月优化。`,
  });

  const blueprint = buildPageBlueprint(source, {
    pageNumber: 17,
    title: "应急响应",
    documentType: "bid",
  });
  const expectedFactIds = source.facts.map((fact) => fact.id);

  assert.ok(blueprint.groups.some((group) => group.role === "metric"));
  assert.ok(blueprint.groups.some((group) => group.role === "process"));
  assert.deepEqual(blueprint.sourceFactIds, expectedFactIds);
  assert.deepEqual(groupedFactIds(blueprint), expectedFactIds);
  assert.equal(new Set(groupedFactIds(blueprint)).size, expectedFactIds.length);
  assert.match(JSON.stringify(blueprint), /30分钟/);
  assert.match(JSON.stringify(blueprint), /1小时/);

  const spec = materializeSlideSpec(blueprint);
  assert.deepEqual(spec.sourceFactIds, expectedFactIds);
  assert.deepEqual(spec.blocks.flatMap((block) => block.sourceFactIds), expectedFactIds);
  assert.deepEqual(
    spec.blocks.map((block) => block.semanticRole),
    blueprint.groups.map((group) => group.role),
  );
  assert.equal(
    spec.blocks.flatMap((block) => block.metrics).every((metric) => !/\d/.test(metric.label)),
    true,
  );
});

test("planner handles an unrelated product roadmap on page 3 deterministically", () => {
  const source = normalizeSource({
    sourceText: `# 产品路线图
第一阶段完成调研。第二阶段上线内测。第三阶段覆盖50家客户。`,
  });
  const context = {
    pageNumber: 3,
    title: "产品路线图",
    documentType: "presentation" as const,
    audience: "产品委员会",
  };

  const first = buildPageBlueprint(source, context);
  const second = buildPageBlueprint(source, context);

  assert.equal(first.pageNumber, 3);
  assert.equal(first.groups.length, 1);
  assert.equal(first.groups[0].role, "process");
  assert.deepEqual(groupedFactIds(first), source.facts.map((fact) => fact.id));
  assert.ok(
    materializeSlideSpec(first).blocks[0].metrics.some((metric) => metric.value === "50家"),
  );
  assert.deepEqual(first, second);
  assert.deepEqual(materializeSlideSpec(first), materializeSlideSpec(second));
});

test("planner keeps an approval condition with its time dependency", () => {
  const source = normalizeSource({
    sourceText: `# 人员变更政策
人员仅在客户书面批准后方可变更。批准后5个工作日完成交接。未经批准不得调整。`,
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 8,
    title: "人员变更政策",
    documentType: "proposal",
  });
  const approvalFact = source.facts.find((fact) => fact.text.includes("书面批准"));
  const handoverFact = source.facts.find((fact) => fact.text.includes("5个工作日"));

  assert.ok(approvalFact);
  assert.ok(handoverFact);
  const dependencyGroup = blueprint.groups.find((group) => group.sourceFactIds.includes(approvalFact.id));
  assert.ok(dependencyGroup);
  assert.ok(dependencyGroup.sourceFactIds.includes(handoverFact.id));
  assert.match(dependencyGroup.body, /书面批准/);
  assert.match(dependencyGroup.body, /5个工作日/);
  assert.deepEqual(groupedFactIds(blueprint), source.facts.map((fact) => fact.id));
});

test("planner groups a discourse continuation with its repeated subject", () => {
  const source = normalizeSource({
    sourceText: "# 平台治理\n平台负责统一调度。另外，平台保留完整记录。",
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 9,
    title: "平台治理",
    documentType: "proposal",
  });

  assert.equal(source.facts.length, 2);
  assert.equal(blueprint.groups.length, 1);
  assert.deepEqual(blueprint.groups[0].sourceFactIds, ["fact-1", "fact-2"]);
});

test("sparse factual source stays honest with one group, one block, and no image", () => {
  const source = normalizeSource({
    sourceText: "# 内部评审政策\n当前版本仅适用于公司内部评审流程。",
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 11,
    title: "内部评审政策",
    documentType: "proposal",
  });
  const spec = materializeSlideSpec(blueprint);

  assert.equal(source.facts.length, 1);
  assert.equal(blueprint.groups.length, 1);
  assert.equal(blueprint.visualNeed, "none");
  assert.deepEqual(blueprint.assets, []);
  assert.equal(spec.blocks.length, 1);
  assert.deepEqual(spec.blocks[0].sourceFactIds, ["fact-1"]);
  assert.equal(spec.blocks[0].body, source.facts[0].text);
  assert.doesNotMatch(spec.conclusion, /\d/);
});

test("planner emits at most one explanatory page-scoped visual intent", () => {
  const source = normalizeSource({
    sourceText: `# 发布流程
第一步收集需求。第二步完成设计。第三步执行验证。第四步正式发布。`,
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 8,
    title: "发布流程",
    documentType: "presentation",
  });

  assert.equal(blueprint.visualNeed, "supporting");
  assert.equal(blueprint.assets.length, 1);
  assert.equal(blueprint.assets[0].id, "p8-img-001");
  assert.match(blueprint.assets[0].prompt, /发布流程/);
  assert.match(blueprint.assets[0].prompt, /no text/i);
  assert.match(blueprint.assets[0].prompt, /no logo/i);
  assert.match(blueprint.assets[0].prompt, /no watermark/i);
  assert.doesNotMatch(blueprint.assets[0].prompt, /page\s*8|第8页/i);
});

test("Arabic-numbered steps stay one ordered process and retain their time metric", () => {
  const source = normalizeSource({
    sourceText: `# 发布步骤
步骤1收集需求。步骤2在2小时内完成评审。步骤3执行验证。步骤4正式发布。`,
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 14,
    title: "发布步骤",
    documentType: "presentation",
  });
  const expectedFactIds = source.facts.map((fact) => fact.id);

  assert.equal(blueprint.groups.length, 1);
  assert.equal(blueprint.groups[0].role, "process");
  assert.deepEqual(blueprint.groups[0].sourceFactIds, expectedFactIds);
  assert.equal(blueprint.visualNeed, "supporting");
  assert.equal(blueprint.assets.length, 1);
  assert.deepEqual(groupedFactIds(blueprint), expectedFactIds);

  const spec = materializeSlideSpec(blueprint);
  assert.equal(spec.blocks.length, 1);
  assert.equal(spec.blocks[0].type, "process");
  assert.equal(spec.blocks[0].semanticRole, "process");
  assert.deepEqual(spec.blocks[0].sourceFactIds, expectedFactIds);
  assert.ok(spec.blocks[0].metrics.some((metric) => metric.value === "2小时"));
});

test("pure quantitative facts remain metric content", () => {
  const source = normalizeSource({
    sourceText: "# 运营指标\n覆盖率达到95%。月均处理120项请求。",
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 15,
    title: "运营指标",
    documentType: "proposal",
  });

  assert.equal(blueprint.groups.every((group) => group.role === "metric"), true);
  assert.deepEqual(groupedFactIds(blueprint), source.facts.map((fact) => fact.id));
});

test("dense source remains bounded without losing or reordering facts", () => {
  const sentences = Array.from(
    { length: 18 },
    (_, index) => `功能${index + 1}完成独立验收。`,
  );
  const source = normalizeSource({
    sourceText: `# 功能验收清单\n${sentences.join("")}`,
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 23,
    title: "功能验收清单",
    documentType: "presentation",
  });
  const expectedFactIds = source.facts.map((fact) => fact.id);

  assert.ok(blueprint.groups.length <= 12);
  assert.deepEqual(groupedFactIds(blueprint), expectedFactIds);
  assert.deepEqual(
    materializeSlideSpec(blueprint).blocks.flatMap((block) => block.sourceFactIds),
    expectedFactIds,
  );
});

test("blueprint validation rejects unknown and missing group fact references", () => {
  const source = normalizeSource({
    sourceText: "# 审核规则\n申请人提交完整材料。审核人在2个工作日内反馈。",
  });
  const blueprint = buildPageBlueprint(source, {
    pageNumber: 6,
    title: "审核规则",
    documentType: "proposal",
  });
  const firstGroup = blueprint.groups[0];
  const unknown = {
    ...blueprint,
    groups: [{ ...firstGroup, sourceFactIds: ["fact-999"] }, ...blueprint.groups.slice(1)],
  };
  const missing = {
    ...blueprint,
    groups: blueprint.groups.slice(0, -1),
  };

  assert.throws(() => pageBlueprintSchema.parse(unknown), /fact/i);
  assert.throws(() => pageBlueprintSchema.parse(missing), /fact/i);
  assert.throws(() => materializeSlideSpec(unknown as typeof blueprint), /fact/i);
});

test("production blueprint modules contain no acceptance-specific policy", async () => {
  const sources = await Promise.all([
    readFile(new URL("../../src/domain/page-blueprint.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/services/page-blueprint-builder.ts", import.meta.url), "utf8"),
  ]);
  const productionText = sources.join("\n");

  assert.doesNotMatch(productionText, /test\.md/i);
  assert.doesNotMatch(productionText, /green-infographic|a4-landscape/i);
  assert.doesNotMatch(productionText, /项目人员配备要求响应|园林|绿化|养护/);
  assert.doesNotMatch(productionText, /\[\s*59\s*,\s*60\s*,\s*61\s*,\s*62\s*\]/);
  assert.doesNotMatch(productionText, /pageNumber\s*(?:===?|!==?)\s*(?:59|60|61|62)\b/);
  assert.doesNotMatch(productionText, /p(?:59|60|61|62)-img-/);
});
