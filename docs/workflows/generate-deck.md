# 固定分页正文生成 HTML Deck

本文档面向调用 MCP 的 Agent。生产路径固定为：

```text
固定格式正文 → plan_deck → 外部图片生成 → generate_deck → 逐页 QA → deck consistency
```

## 1. 输入协议

高层 deck 工作流只处理已经分页的上游正文。每一页必须由独占一行的 `<page N>` 开始，随后是标签化标题、独占一行的 `正文：` 和非空正文。

```text
<page 59>
一级标题：第一分节：优势与有利条件分析
二级标题：2.1 项目需求深度理解
三级标题：2.1.1 项目背景与采购需求解读
四级标题：可选
正文：
本页正文第一段。

本页正文第二段。
```

约束：

- `<page N>` 必须独占一行；正文里的页码、面积或编号不会创建页面。
- `pageNumbers` 必须与正文标记完全一致、严格递增，不允许缺页、增页或重排。
- 支持一级到四级标题；每页至少提供一个非空标题。建议上游保持一级、二级、三级标题齐全，四级标题按需提供。
- `正文：` 之后不得再次出现结构标题或第二个 `正文：`。
- 不接受标记前的非空前言，也不会对未标记 Markdown 自动分页。
- 单次最多 30 页，正文总长度受服务端 `PPT_MAX_INPUT_CHARS` 限制。

## 2. plan_deck

请求示例：

```json
{
  "sourceText": "<page 59>\n一级标题：第一分节：优势与有利条件分析\n二级标题：2.1 项目需求深度理解\n三级标题：2.1.1 项目背景与采购需求解读\n正文：\n本页正文。",
  "pageNumbers": [59],
  "documentType": "bid",
  "preferredThemeId": "green-infographic-v1",
  "audience": "招标评审专家与项目业主",
  "quality": { "minScore": 90, "maxAttempts": 3 },
  "requestId": "proposal-deck-plan-001"
}
```

返回值包含：

- `plannedDeck.deckPlanId`：后续生成唯一允许使用的不可变计划 ID。
- `plannedDeck.slides[]`：逐页来源事实、展示蓝图、模板能力快照和映射证据。
- `assets[]`：页面范围内的图片 ID、提示词、替代文本和来源事实 ID。
- `nextStep`：下一步调用提示。

调用方不得修改计划中的事实、模板能力或图片 ID。相同 `requestId` 与相同输入会复用计划；相同 `requestId` 配不同输入会被拒绝。

## 3. 图片生成边界

没有图片 API 时，MCP 只负责返回稳定提示词。Agent 对 `assets[]` 逐项调用自身图片能力，并将结果转成 data URL：

```json
{
  "id": "p59-img-001",
  "dataUrl": "data:image/png;base64,..."
}
```

支持 PNG、JPEG、WebP 和 SVG data URL。必须满足以下规则：

- ID 与 `plan_deck.assets[].id` 完全一致。
- 不得遗漏、不明增加、重复或替换已经登记的资产。
- 图片只用于解释正文关系；不得把提示词、logo、水印或大段文字画进图中。
- 图片字节数和总资产数受服务端限制。

## 4. generate_deck 与断点续跑

```json
{
  "deckPlanId": "plan_deck 返回的 UUID",
  "externalAssets": [
    { "id": "p59-img-001", "dataUrl": "data:image/png;base64,..." }
  ],
  "requestId": "proposal-deck-run-001"
}
```

若图片未齐，返回：

```json
{
  "status": "needs_assets",
  "assets": {
    "status": "needs_assets",
    "missingAssetIds": ["p59-img-001"]
  },
  "pages": []
}
```

补齐图片后，使用相同 `deckPlanId` 和相同 `requestId` 再次调用。已交付页面不会重复生成；并发的同一请求只执行一次页面工作流。

正式交付必须同时满足：

- `status === "delivered"`；
- 返回页码顺序与计划完全一致；
- 每页 `quality.hardGatePassed === true`；
- 每页 `quality.score >= quality.threshold`；
- `consistency.passed === true` 且 `issues` 为空。

`partial` 和 `failed` 不可作为正式交付件。

## 5. get_deck

`get_deck` 只接受 UUID 和闭集 view，不接受任意路径：

```json
{ "id": "deckPlanId", "view": "plan" }
```

```json
{ "id": "deckRunId", "view": "manifest" }
```

```json
{ "id": "pageRunId", "view": "artifact", "artifact": "quality.json" }
```

```json
{ "id": "deckRunId", "view": "artifact", "artifact": "consistency.json" }
```

闭集产物为 `manifest.json`、`final.html`、`quality.json` 和 `consistency.json`。大型自包含 HTML 可能超过公共文本读取上限，此时工具闭合返回不可读；调用方应使用 `generate_deck` 返回的逻辑产物引用，由受信任的交付层复制文件，而不是扩展 MCP 的任意文件读取能力。

## 6. 每页 QA

页面在真实 Chromium 中独立渲染和评分。硬门禁至少覆盖：

- A4 横向画布和唯一页根；
- 页码、标题层级、模板身份和来源事实一致；
- 文本溢出、裁切、碰撞和最小正文字号；
- 图片加载、位图面积和文档策略；
- 无脚本、事件处理器、远程资源或危险协议；
- 质量诊断不泄露路径、密钥或 provider 响应。

生成完成后还会检查全 deck 的页码、主题、格式、模板能力、标题层级和质量证据一致性。

## 7. 模板约束

模板由 HTML 和 `template-profiles.json` 共同声明能力。模板选择基于语义槽位、容量、最低字号、视觉占比和文档兼容性；不得在生产代码中按特定页码、正文、章节名或模板 slug 写业务分支。

当前标书 demo 使用 `green-infographic-v1` 主题，但同一流程可以选择该主题下其他满足容量的模板变体。
