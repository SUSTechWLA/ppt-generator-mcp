import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSource } from "../../src/services/content-normalizer.js";

test("normalizes Markdown and preserves numeric requirements", () => {
  const document = normalizeSource({
    sourceText: [
      "# 智慧园区方案",
      "",
      "## 建设目标",
      "项目必须在30天内完成一期建设，预算为280万元。",
      "",
      "- 建立统一服务窗口",
      "- 覆盖8个服务点",
    ].join("\n"),
  });

  assert.equal(document.title, "智慧园区方案");
  assert.equal(document.sections[0].heading, "建设目标");
  assert.deepEqual(document.sections[0].keyPoints, ["建立统一服务窗口", "覆盖8个服务点"]);
  assert.ok(document.facts.some((fact) => fact.text.includes("30天")));
  assert.ok(document.facts.some((fact) => fact.text.includes("280万元")));
  assert.ok(document.facts.some((fact) => fact.kind === "requirement"));
  assert.equal(document.sourceHash.length, 64);
});

test("normalizes structured sections in caller order", () => {
  const document = normalizeSource({
    sections: [
      { heading: "现状", body: "当前覆盖8个项目。" },
      {
        heading: "目标",
        body: "服务响应时间不得超过30分钟。",
        keyPoints: ["快速响应"],
      },
    ],
  });

  assert.deepEqual(document.sections.map((section) => section.heading), ["现状", "目标"]);
  assert.equal(document.sections[1].keyPoints[0], "快速响应");
  assert.ok(document.facts.some((fact) => fact.text.includes("不得超过30分钟")));
});

test("normalizes plain text without headings instead of crashing", () => {
  const document = normalizeSource({
    sourceText: "本项目建立统一调度机制。服务人员应在30分钟内响应现场任务。",
  });

  assert.equal(document.sections.length, 1);
  assert.equal(document.sections[0].heading, "正文");
  assert.ok(document.facts.length >= 2);
});
