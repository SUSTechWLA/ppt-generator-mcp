import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowError } from "../../src/domain/workflow-error.js";
import {
  parseExplicitPages,
  partitionDeckSource,
} from "../../src/services/explicit-page-parser.js";

function page(pageNumber: number, body: string, fourthLevel?: string): string {
  return `<page ${pageNumber}>\n一级标题：通用方案\n二级标题：运行管理\n三级标题：实施要求\n${fourthLevel ? `四级标题：${fourthLevel}\n` : ""}正文：\n${body}`;
}

test("parser maps four arbitrary full-line markers and preserves exact source ranges", () => {
  const sourceText = `  \n${page(101, "Alpha response completes within 15 minutes.")}\n\n${page(104, "Beta team records 2 checks.")}\n${page(109, "Gamma keeps 3 audit records.")}\n${page(120, "Delta closes every issue.")}\n`;

  const parsed = parseExplicitPages(sourceText);

  assert.equal(parsed.mode, "explicit");
  assert.deepEqual(parsed.pages.map((chunk) => chunk.pageNumber), [101, 104, 109, 120]);
  for (const chunk of parsed.pages) {
    assert.equal(chunk.sourceText, sourceText.slice(chunk.sourceStart, chunk.sourceEnd));
    assert.equal(chunk.body, sourceText.slice(chunk.bodyStart, chunk.bodyEnd));
  }
  assert.ok(parsed.pages.every((chunk, index) => index === 0 || chunk.sourceStart === parsed.pages[index - 1].sourceEnd));
});

test("synthetic upstream fixture yields declared pages, heading metadata, and page-local facts only", () => {
  const sourceText = [
    page(59, "第一页记录年度计划和月度检查结果。"),
    page(60, "第二页明确每日1次巡查和30分钟响应要求。"),
    page(61, "第三页核对3项设备并形成可追溯台账。", "一、现场运行特征分析"),
    page(62, "第四页在每个作业面完成后独立复核。", "二、客户交付特征分析"),
  ].join("\n\n");

  const partitions = partitionDeckSource({ sourceText, pageNumbers: [59, 60, 61, 62] });

  assert.deepEqual(partitions.map((partition) => partition.pageNumber), [59, 60, 61, 62]);
  assert.equal(partitions[0].headingMetadata.level1, "通用方案");
  assert.equal(partitions[0].headingMetadata.level3, "实施要求");
  assert.equal(partitions[2].headingMetadata.level4, "一、现场运行特征分析");
  assert.equal(partitions[3].title, "二、客户交付特征分析");
  assert.ok(partitions.every((partition) => partition.normalizedSource.facts.length > 0));
  assert.equal(
    new Set(partitions.flatMap((partition) => partition.originalSourceFactIds)).size,
    partitions.flatMap((partition) => partition.originalSourceFactIds).length,
  );
  for (const partition of partitions) {
    const allFactText = partition.normalizedSource.facts.map((fact) => fact.text).join("\n");
    assert.doesNotMatch(allFactText, /<page\s+\d+>|(?:一|二|三|四)级标题：|正文：/i);
    assert.ok(partition.normalizedSource.facts.every((fact) => partition.body.includes(fact.text)));
  }
});

test("numbers in prose, dimensions, headings, and inline marker text never create page markers", () => {
  const unmarked = `# 2026 年方案\n尺寸为 2,239.56㎡，正文中说明 <page 88> 只是引用。`;
  assert.deepEqual(parseExplicitPages(unmarked), { mode: "unmarked" });

  const explicit = `${page(7, "面积为2,239.56㎡，标题章节号为2.1.2。文中引用 <page 88> 不是边界。")}`;
  const parsed = parseExplicitPages(explicit);
  assert.equal(parsed.mode, "explicit");
  assert.deepEqual(parsed.pages.map((chunk) => chunk.pageNumber), [7]);
  assert.match(parsed.pages[0].body, /<page 88>/);
});

test("production partitioning rejects unmarked source instead of semantically repaginating it", () => {
  const sourceText = "# 运行方案\n\n设备每日检查1次，并保留记录30天。";

  assert.deepEqual(parseExplicitPages(sourceText), { mode: "unmarked" });
  assert.throws(
    () => partitionDeckSource({ sourceText, pageNumbers: [1] }),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "partition_deck_source"
      && error.retryable === false
      && /explicit <page N>/.test(error.message)
      && Boolean(error.recovery?.includes("<page N>")),
  );
});

const rejectedSources = [
  {
    name: "duplicate markers",
    sourceText: `${page(3, "第一页内容。")}\n${page(3, "第二页内容。")}`,
    message: /unique and strictly increasing/,
  },
  {
    name: "unordered markers",
    sourceText: `${page(4, "第一页内容。")}\n${page(2, "第二页内容。")}`,
    message: /unique and strictly increasing/,
  },
  {
    name: "a malformed partial marker",
    sourceText: `${page(4, "第一页内容。")}\n<page 5\n一级标题：通用方案\n正文：\n第二页内容。`,
    message: /Malformed explicit page marker/,
  },
  {
    name: "lexical preamble",
    sourceText: `这段内容没有所属页。\n${page(4, "正式页内容。")}`,
    message: /Lexical content before the first explicit page marker/,
  },
] as const;

for (const scenario of rejectedSources) {
  test(`parser rejects ${scenario.name} with stable recovery guidance`, () => {
    assert.throws(
      () => parseExplicitPages(scenario.sourceText),
      (error: unknown) => error instanceof WorkflowError
        && error.stage === "parse_explicit_pages"
        && scenario.message.test(error.message)
        && Boolean(error.recovery),
    );
  });
}

test("partitioner rejects requested page numbers that do not exactly equal explicit markers", () => {
  const sourceText = `${page(11, "第一页内容。")}\n${page(15, "第二页内容。")}`;

  assert.throws(
    () => partitionDeckSource({ sourceText, pageNumbers: [11, 14] }),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "partition_deck_source"
      && /must exactly match explicit markers 11, 15/.test(error.message)
      && Boolean(error.recovery?.includes("11, 15")),
  );
});

test("renaming heading text and changing industry prose leaves declared page mapping unchanged", () => {
  const first = `${page(31, "机械设备每日检查2次。")}\n${page(32, "现场问题在30分钟内复核。")}`;
  const second = first
    .replaceAll("通用方案", "数字产品路线")
    .replaceAll("运行管理", "客户交付")
    .replace("机械设备每日检查2次。", "每日同步2次订单数据。")
    .replace("现场问题在30分钟内复核。", "客户需求在30分钟内确认。");

  assert.deepEqual(
    partitionDeckSource({ sourceText: first, pageNumbers: [31, 32] }).map((partition) => partition.pageNumber),
    partitionDeckSource({ sourceText: second, pageNumbers: [31, 32] }).map((partition) => partition.pageNumber),
  );
});

test("parser accepts an optional fourth-level heading and preserves unknown labeled metadata", () => {
  const sourceText = `<page 41>\n一级标题：总体方案\n二级标题：运行管理\n三级标题：实施要求\n四级标题：日常巡检\n资料分类：内部管理\n正文：\n现场每日完成1次巡检。`;

  const parsed = parseExplicitPages(sourceText);

  assert.equal(parsed.mode, "explicit");
  assert.equal(parsed.pages[0].headingMetadata.level4, "日常巡检");
  assert.deepEqual(parsed.pages[0].headingMetadata.additionalLabels, [
    { label: "资料分类", value: "内部管理" },
  ]);
  assert.equal(parsed.pages[0].title, "日常巡检");
});

test("parser rejects an empty explicit page body", () => {
  assert.throws(
    () => parseExplicitPages(page(51, "   \n")),
    (error: unknown) => error instanceof WorkflowError
      && error.stage === "parse_explicit_pages"
      && /Page 51 body is empty/.test(error.message)
      && Boolean(error.recovery),
  );
});

for (const scenario of [
  {
    name: "a duplicate body label after LF body content",
    suffix: "\n第一段内容。\n正文：\n第二段内容。",
    message: /Page 71 contains a duplicate 正文： label after body content/,
  },
  {
    name: "an indented duplicate body label after CRLF body content",
    suffix: "\r\n第一段内容。\r\n  正文: 第二段内容。",
    message: /Page 71 contains a duplicate 正文： label after body content/,
  },
  {
    name: "a late structural heading label after LF body content",
    suffix: "\n第一段内容。\n四级标题：迟到的小节\n第二段内容。",
    message: /Page 71 contains 四级标题： after the body has started/,
  },
  {
    name: "an indented late structural heading label after CRLF body content",
    suffix: "\r\n第一段内容。\r\n\t一级标题: 迟到的章节\r\n第二段内容。",
    message: /Page 71 contains 一级标题： after the body has started/,
  },
] as const) {
  test(`parser rejects ${scenario.name}`, () => {
    const sourceText = page(71, "").replace(/\n$/, "") + scenario.suffix;

    assert.throws(
      () => parseExplicitPages(sourceText),
      (error: unknown) => error instanceof WorkflowError
        && error.stage === "parse_explicit_pages"
        && scenario.message.test(error.message)
        && Boolean(error.recovery?.includes("one heading block")),
    );
  });
}

test("parser allows ordinary colon-bearing prose lines after the body starts", () => {
  const sourceText = `<page 72>\r\n一级标题：通用方案\r\n二级标题：运行管理\r\n三级标题：实施要求\r\n正文：\r\n处理说明：负责人每日复核1次。\r\n章节编号：2.1.2。\r\n普通正文中可以引用“正文：”和“一级标题：”字样。`;

  const parsed = parseExplicitPages(sourceText);

  assert.equal(parsed.mode, "explicit");
  assert.match(parsed.pages[0].body, /处理说明：/);
  assert.match(parsed.pages[0].body, /普通正文中可以引用/);
});
