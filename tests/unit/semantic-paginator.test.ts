import assert from "node:assert/strict";
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
  assert.match(pages[1].title, /职责|履职/);
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
