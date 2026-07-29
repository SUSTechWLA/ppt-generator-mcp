import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WorkflowError } from "../../src/domain/workflow-error.js";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import { paginateSource } from "../../src/services/semantic-paginator.js";

const markdown = `### 项目人员配备要求响应
必须配置1名固定项目对接人员，且不得随意变更。

##### 固定项目对接人员配置方案
对接人员作为唯一信息窗口，覆盖8个项目。

负责指令传达、日报汇总、问题反馈、台账归档和考核迎检。

具备不少于三年项目管理经验，并配置后备人员。

##### 作业人员动态调配机制
建立基础配置、季节调配和任务驱动三层机制。

接到临时指令后30分钟内启动，1小时内到场。

##### 人员变更申请与审批流程
提交书面申请并经采购人书面批准。

安排不少于五个工作日交接，上岗后三个工作日内拜访。`;

test("paginator creates four ordered pages without losing source order", () => {
  const source = normalizeSource({ sourceText: markdown });
  const pages = paginateSource(source, [59, 60, 61, 62]);

  assert.deepEqual(pages.map((page) => page.pageNumber), [59, 60, 61, 62]);
  assert.match(pages[0].title, /固定|总体/);
  assert.match(pages[1].title, /固定|续/);
  assert.match(pages[2].title, /动态调配/);
  assert.match(pages[3].title, /变更|交接/);
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
});

test("paginator keeps approval and its time limits on the same page", () => {
  const source = normalizeSource({ sourceText: markdown });
  const page62 = paginateSource(source, [59, 60, 61, 62])[3];
  const body = page62.sourceSections.map((section) => section.body).join("\n");

  assert.match(body, /书面申请/);
  assert.match(body, /五个工作日/);
  assert.match(body, /三个工作日/);
});

test("paginator subdivides a generic long paragraph at safe semantic boundaries", () => {
  const source = normalizeSource({
    sections: [{
      heading: "智能仓储运行规则",
      body: "仓储系统每日生成1次库存快照，并保留30天。1）入库机器人按12条通道依次巡检；2）分拣线每小时核对240件货物；3）冷链区域持续记录温度和湿度。系统执行规则规定：“温控报警必须在5分钟内确认，且不得跳过复核。”值班人员先检查传感器、电源模块和网络链路，并将检查结果写入运行日志。设备完成初始化。该设备随后进入校验。校验阶段依次比对库存编码、货位编号和批次信息，任何差异都必须生成异常记录。主仓面积为12,500.50㎡，自动设备覆盖其中9,800㎡，剩余区域由人工班组巡回检查。早班在8时前完成交接，中班在16时前复核库存，晚班在24时前封存当日记录。每次交接均需核对未完成任务、告警状态、维护工单和备用设备数量。若发生独立故障，现场人员立即启动应急预案并通知值班主管。维护人员完成故障定位后更换损坏部件，恢复运行前再次执行安全检查。系统恢复后生成1份事件报告，报告保存不少于3年。周度复盘汇总响应时长、故障类型和恢复结果，用于持续优化仓储运行流程。",
    }],
  });

  const pages = paginateSource(source, [101, 102, 103]);
  const pageBodies = pages.map((page) => page.sourceSections.map((section) => section.body).join("\n"));
  const combinedBody = pageBodies.join("\n");
  const dependencyPage = pageBodies.findIndex((body) => body.includes("设备完成初始化。"));

  assert.deepEqual(pages.map((page) => page.pageNumber), [101, 102, 103]);
  assert.ok(pages.every((page) => page.originalSourceFactIds.length > 0));
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
  assert.match(combinedBody, /1）入库机器人按12条通道依次巡检；/);
  assert.match(combinedBody, /12,500\.50㎡/);
  assert.match(combinedBody, /“温控报警必须在5分钟内确认，且不得跳过复核。”/);
  assert.notEqual(dependencyPage, -1);
  assert.match(pageBodies[dependencyPage], /设备完成初始化。该设备随后进入校验。/);
});

test("paginator aligns ASCII sentence facts and preserves the original inter-sentence gap", () => {
  const source = normalizeSource({
    sections: [{
      heading: "Incident response",
      body: "Response complete. Arrive onsite.",
    }],
  });

  assert.deepEqual(source.facts.map((fact) => fact.text), [
    "Response complete.",
    "Arrive onsite.",
  ]);

  const splitPages = paginateSource(source, [81, 82]);
  assert.deepEqual(splitPages.map((page) => page.originalSourceFactIds), [
    ["fact-1"],
    ["fact-2"],
  ]);

  const [combinedPage] = paginateSource(source, [81]);
  assert.equal(combinedPage.sourceSections[0].body, "Response complete. Arrive onsite.");
});

test("paginator aligns ASCII semicolon list clauses with source facts", () => {
  const source = normalizeSource({
    sections: [{
      heading: "Inspection checklist",
      body: "1) Inspect power; 2) Inspect network; 3) Confirm ready.",
    }],
  });

  assert.deepEqual(source.facts.map((fact) => fact.text), [
    "1) Inspect power;",
    "2) Inspect network;",
    "3) Confirm ready.",
  ]);

  const pages = paginateSource(source, [91, 92, 93]);
  assert.ok(pages.every((page) => page.originalSourceFactIds.length > 0));
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
});

test("paginator keeps protected ASCII periods out of fragment facts and pages", () => {
  const source = normalizeSource({
    sections: [{
      heading: "Inspection checklist",
      body: "1. Inspect www.example.com; 2. Email name@example.com and follow the U.S. guide.",
    }],
  });

  assert.deepEqual(source.facts.map((fact) => fact.text), [
    "1. Inspect www.example.com;",
    "2. Email name@example.com and follow the U.S. guide.",
  ]);

  const pages = paginateSource(source, [94, 95]);
  assert.deepEqual(pages.map((page) => page.sourceSections[0].body), source.facts.map((fact) => fact.text));
  assert.deepEqual(pages.map((page) => page.originalSourceFactIds), [["fact-1"], ["fact-2"]]);
});

const contextualPeriodCases = [
  {
    name: "title and label abbreviations",
    body: "Dr. Chen arrives. Use No. 1 channel.",
    facts: ["Dr. Chen arrives.", "Use No. 1 channel."],
    pageNumbers: [201, 202],
  },
  {
    name: "an ASCII ellipsis",
    body: "Wait... Continue checks.",
    facts: ["Wait...", "Continue checks."],
    pageNumbers: [201, 202],
  },
  {
    name: "a sentence-final initialism",
    body: "Operations are in the U.S. Response complete.",
    facts: ["Operations are in the U.S.", "Response complete."],
    pageNumbers: [201, 202],
  },
  {
    name: "a contextual numbered-list marker",
    body: "Scope includes 1. Inspect power; Continue checks.",
    facts: ["Scope includes 1. Inspect power;", "Continue checks."],
    pageNumbers: [201, 202],
  },
  {
    name: "a consecutive Unicode ellipsis",
    body: "等待……继续检查。",
    facts: ["等待……", "继续检查。"],
    pageNumbers: [201, 202],
  },
  {
    name: "organization continuations after initialisms",
    body: "The U.S. Army responds. The U.N. Security Council met. Response complete.",
    facts: ["The U.S. Army responds.", "The U.N. Security Council met.", "Response complete."],
    pageNumbers: [201, 202, 203],
  },
  {
    name: "sentence-final numeric prose",
    body: "Complete phase 2. Release starts. Coverage reached 8. Next action begins.",
    facts: ["Complete phase 2.", "Release starts.", "Coverage reached 8.", "Next action begins."],
    pageNumbers: [201, 202, 203, 204],
  },
  {
    name: "a label abbreviation without a label value",
    body: "See Fig. Response complete. See Fig. 2.",
    facts: ["See Fig.", "Response complete.", "See Fig. 2."],
    pageNumbers: [201, 202, 203],
  },
] as const;

for (const scenario of contextualPeriodCases) {
  test(`paginator preserves fact order without fragments for ${scenario.name}`, () => {
    const source = normalizeSource({
      sections: [{ heading: "Operations guide", body: scenario.body }],
    });

    assert.deepEqual(source.facts.map((fact) => fact.text), [...scenario.facts]);
    assert.ok(source.facts.every((fact) => fact.text.length > 0 && !/^[.。！？!?；;…]+$/u.test(fact.text)));

    const pages = paginateSource(source, [...scenario.pageNumbers]);
    assert.deepEqual(pages.map((page) => page.sourceSections[0].body), [...scenario.facts]);
    assert.deepEqual(
      pages.flatMap((page) => page.originalSourceFactIds),
      source.facts.map((fact) => fact.id),
    );
  });
}

test("paginator keeps adjacent Chinese sentences naturally unspaced", () => {
  const source = normalizeSource({
    sections: [{
      heading: "校验流程",
      body: "设备完成初始化。该设备随后进入校验。",
    }],
  });

  const [page] = paginateSource(source, [83]);
  assert.equal(page.sourceSections[0].body, "设备完成初始化。该设备随后进入校验。");
});

test("paginator covers the repository acceptance source in four ordered pages", () => {
  const sourceMarkdown = readFileSync(new URL("../../test.md", import.meta.url), "utf8");
  const source = normalizeSource({ sourceText: sourceMarkdown });

  const pages = paginateSource(source, [59, 60, 61, 62]);

  assert.deepEqual(pages.map((page) => page.pageNumber), [59, 60, 61, 62]);
  assert.ok(pages.every((page) => page.originalSourceFactIds.length > 0));
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
});

test("paginator uses bullet-only content as non-overlapping source units", () => {
  const source = normalizeSource({
    sourceText: `# 操作清单
- 重置设备。
- 检查线路。`,
  });

  const pages = paginateSource(source, [1, 2]);

  assert.deepEqual(pages.map((page) => page.sourceSections[0].body), ["重置设备。", "检查线路。"]);
  assert.deepEqual(
    pages.flatMap((page) => page.sourceSections.flatMap((section) => [section.body, ...(section.keyPoints ?? [])])),
    ["重置设备。", "检查线路。"],
  );
  assert.ok(pages.every((page) => page.originalSourceFactIds.length > 0));
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
});

test("paginator removes structured key points that overlap body paragraphs", () => {
  const source = normalizeSource({
    sections: [{
      heading: "维护步骤",
      body: "重置设备。\n\n检查线路。",
      keyPoints: ["检查线路。", "归档报告。"],
    }],
  });

  const pages = paginateSource(source, [21, 22]);

  assert.deepEqual(pages.map((page) => page.sourceSections[0].body), ["重置设备。", "检查线路。"]);
  assert.deepEqual(
    pages.flatMap((page) => page.sourceSections.flatMap((section) => [section.body, ...(section.keyPoints ?? [])])),
    ["重置设备。", "检查线路。", "归档报告。"],
  );
  assert.ok(pages.every((page) => page.originalSourceFactIds.length > 0));
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
});

test("paginator gives unrelated continuation pages a neutral title", () => {
  const source = normalizeSource({
    sections: [{
      heading: "产品发布流程",
      body: "整理发布清单。\n\n完成线上校验。",
    }],
  });

  const pages = paginateSource(source, [41, 42]);

  assert.equal(pages[1].title, "产品发布流程（续）");
});

test("paginator keeps a multi-paragraph overview with the first substantive component", () => {
  const source = normalizeSource({
    sourceText: `# 总体方案
概述一。

概述二。

## 执行
步骤一。

步骤二。

步骤三。`,
  });

  const pages = paginateSource(source, [51, 52, 53]);
  const firstPageBody = pages[0].sourceSections[0].body;
  const laterPageBodies = pages.slice(1).map((page) => page.sourceSections[0].body).join("\n");

  assert.match(firstPageBody, /概述一。/);
  assert.match(firstPageBody, /概述二。/);
  assert.match(firstPageBody, /步骤一。/);
  assert.doesNotMatch(laterPageBodies, /概述一。|概述二。/);
});

test("paginator rejects page counts that require splitting a structural continuation", () => {
  const source = normalizeSource({
    sourceText: `# 设备方案
## 流程
设备完成初始化。

该设备随后进入校验。`,
  });

  assert.throws(
    () => paginateSource(source, [61, 62]),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "paginate_source"
      && /dependency-safe partitions/.test(error.message),
  );
});

test("paginator can split a self-contained conditional action paragraph", () => {
  const source = normalizeSource({
    sections: [{
      heading: "故障响应",
      body: "监测设备状态。\n\n若发生故障，立即启动预案。",
    }],
  });

  const pages = paginateSource(source, [63, 64]);

  assert.deepEqual(pages.map((page) => page.sourceSections[0].body), ["监测设备状态。", "若发生故障，立即启动预案。"]);
});

test("paginator can split a self-contained completion condition", () => {
  const source = normalizeSource({
    sections: [{
      heading: "校验流程",
      body: "准备任务。\n\n在设备完成后，启动校验。",
    }],
  });

  const pages = paginateSource(source, [65, 66]);

  assert.deepEqual(pages.map((page) => page.sourceSections[0].body), ["准备任务。", "在设备完成后，启动校验。"]);
});

test("paginator rejects factless normalized source instead of returning empty fact partitions", () => {
  const source = normalizeSource({
    sections: [{ heading: "执行", body: "完成检查。" }],
  });

  assert.throws(
    () => paginateSource({ ...source, facts: [] }, [71]),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "paginate_source"
      && /does not contain extractable facts/.test(error.message),
  );
});

test("paginator rejects duplicate source fact IDs instead of emitting duplicate references", () => {
  const source = normalizeSource({
    sections: [{ heading: "执行", body: "完成检查。\n\n记录结果。" }],
  });
  const duplicateFactIds = source.facts.map((fact, index) => ({
    ...fact,
    id: index === 1 ? source.facts[0].id : fact.id,
  }));

  assert.throws(
    () => paginateSource({ ...source, facts: duplicateFactIds }, [72, 73]),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "paginate_source"
      && /exactly once/.test(error.message),
  );
});

test("paginator uses the same paragraph allocation for unrelated content and page numbers", () => {
  const source = normalizeSource({
    sourceText: `# 服务运行方案
所有异常必须留存记录。

## 现场调度
值班人员接收工单并确认责任人。

在20分钟内完成首次响应。

## 数据归档
每日归集记录并复核。`,
  });

  const pages = paginateSource(source, [7, 8, 9]);

  assert.deepEqual(pages.map((page) => page.pageNumber), [7, 8, 9]);
  assert.deepEqual(pages.map((page) => page.originalSourceSectionIds), [
    ["section-1", "section-2"],
    ["section-2"],
    ["section-3"],
  ]);
  assert.deepEqual(
    pages.flatMap((page) => page.originalSourceFactIds),
    source.facts.map((fact) => fact.id),
  );
});

test("paginator reports an explicit diagnostic when there are fewer pages than major headings", () => {
  const source = normalizeSource({
    sourceText: `# 服务方案
总则。

## 调度
安排人员。

## 归档
保存记录。`,
  });

  assert.throws(
    () => paginateSource(source, [7]),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "paginate_source"
      && /fewer pages than substantive headings/.test(error.message),
  );
});
