---
name: generate-bid-deck
description: 把一个已分页的中文标书/技术方案正文，完整转成可交付的 A4 横向 HTML 类 PPT 页面（经过逐页 Chromium QA 与整套一致性检查）。适用于标书投标、项目建议书、方案汇报等交付件生成。
---

# 生成标书 HTML 交付件（generate-bid-deck）

把一份已经按 `<page N>` 分页的中文标书正文，转成可独立打开的 A4 横向 HTML 类 PPT 交付页。
系统会理解每页内容、选择模板（高密度文字 / 图文信息图自动交替）、提出配图需求、在真实 Chromium 中 QA，并给出可交付的 `final.html`。

## 何时使用

- 已有分页正文（每个 `<page N>` 独占一行、页码严格递增、每页有标签化标题和 `正文：`）。
- 需要把文字丰富、带图、信息密集的标书正文批量变成可交付 HTML 页。
- 不需要 `.pptx`，最终交付是自包含 `final.html`。

## 输入协议（重要）

正文必须满足：

```text
<page 59>
一级标题：第一分节：优势与有利条件分析
二级标题：2.1 项目需求深度理解
三级标题：2.1.1 项目背景与采购需求解读
四级标题：（可选）
正文：
这一页的正文内容……
```

- `<page N>` 独占一行，页码严格递增，N 就是页面号（通常是 RAG 切片的编号）。
- 每页至少一个标签化标题（一级/二级/三级/四级），随后是 `正文：`。
- `pageNumbers` 必须与正文里的标记完全一致（例如 `[59, 60, 61, 62]`）。
- 系统不自动切页、不猜页码。

## 执行步骤

### 1. 校验并调用 plan_deck

```jsonc
{
  "sourceText": "<完整正文>",
  "pageNumbers": [59, 60, 61, 62],   // 必须与正文标记一致
  "documentType": "bid",              // bid | proposal | presentation
  "templateDiversity": "balanced",    // off | conservative | balanced | expressive
  "preferredThemeId": "green-infographic-v1",
  "requestId": "<唯一请求ID>",
  "quality": { "minScore": 80, "maxAttempts": 3 }
}
```

返回值包含 `deckPlanId` 与 `assets`（需要生成的图片清单，含稳定 `id` 与 `prompt`）。

### 2. 生成配图

- 用 Agent 自身的文生图能力，按返回的资产 **id** 与 **prompt** 生成图片。
- 转为 **PNG / JPEG / WebP** base64 data URL（不接受 SVG）。
- 没有图片 API 时：直接运行一键脚本自动生成主题占位图（见文末「一键脚本」），或让 Agent 用其图片能力生成后注入。

### 3. 调用 generate_deck（处理 needs_assets）

```jsonc
{
  "deckPlanId": "<上一步返回的 UUID>",
  "externalAssets": [
    { "id": "p62-img-001", "dataUrl": "data:image/png;base64,..." }
  ],
  "requestId": "<同一前缀的不同后缀>"
}
```

- 若返回 `status: "needs_assets"`，按 `missingAssetIds` 补齐后再用 **同一个 requestId** 继续调用，已交付页不会重复生成。
- 直到 `status: "delivered"` 才算完成。任何 `partial` / `failed` 都不可交付。

### 4. 取回交付件

- `get_deck`（`view: "manifest"`）读取整套 manifest 与 `consistency.json`。
- 每页 `final.html`：含图页面通常较大，超过公共文本上限时 `get_deck` 返回 `html_unavailable` 并给出相对输出根目录的路径（`<runId>/final.html`），本地 Agent 直接按该路径读取即可。
- 每页 `quality.json`：用 `get_deck`（`view: "artifact", artifact: "quality.json"`）读取分数与硬门禁结果。

### 5. 交付验收

- 整套 `status === "delivered"` **且** `consistency.passed === true` **且**每页 `status === "delivered"`。
- 交付 `final.html`（自包含，可直接浏览器打开 / 打印 / 转 PDF）。

## 一键脚本（无图片 API 的全自动路径）

```bash
npm run build   # 确保 dist 最新
node scripts/run-bid-deck.mjs 正文路径 输出目录 请求ID前缀
# 例：
node scripts/run-bid-deck.mjs test.md output/deliverables/my-bid bid-20260802
```

脚本会自动：启动 MCP server → plan_deck → 生成主题占位图 → generate_deck（含 needs_assets 恢复）→ get_deck → 整理交付件到输出目录。
正式交付时，用 Agent 文生图能力替换占位图即可。

## 常见问题

- **`needs_assets` 一直出现**：按 `missingAssetIds` 补齐全部缺图并复用相同 `requestId`。
- **页面 `partial`/`failed`**：查看该页 `quality.json` 的 `remainingIssues`，通常是布局溢出或字号/对比度问题，系统已自动重试最多 3 次。
- **`get_deck` 拿不到 final.html**：页面过大，按返回的 `availableAt`（相对输出根目录）本地读取。
- **中文字体缺字**：服务端需安装中文字体（如 Noto Sans CJK），否则 QA 硬门禁会拒绝交付。

## 验证清单

- [ ] `plan_deck` 返回 `deckPlanId` 与全部页面计划
- [ ] 每页配图按原 `id` + `prompt` 生成并注入
- [ ] `generate_deck` 最终 `status: "delivered"`
- [ ] `consistency.passed === true`
- [ ] 每页 `final.html` 已取回、无脚本、无外部资源、无溢出
