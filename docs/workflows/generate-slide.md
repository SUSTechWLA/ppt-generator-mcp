# `generate_slide` Agent Workflow

## 目标

将中文商务正文稳定转换为单页 A4 横向 HTML。最终页必须自包含、无脚本、无远程资源、无占位符，并通过 Chromium 硬门禁。

## 无图片 API 的标准流程

### 1. 规划

调用 `plan_slide`：

```json
{
  "sourceText": "# 项目服务方案\n\n## 服务目标\n项目要求建立标准化服务体系。",
  "audience": "采购评审专家",
  "quality": { "minScore": 85, "maxAttempts": 3 },
  "requestId": "proposal-page-001"
}
```

关键返回字段：

- `facts`：可引用的事实 ID。
- `plannedSpec`：生成时原样回传，避免两次规划漂移。
- `selectedTemplate`：批准模板和选择原因。
- `assets`：稳定 ID、提示词、alt 和尺寸。

Agent 可以自行修改 `plannedSpec`，但每个整页、block 和 asset 的 `sourceFactIds` 都必须存在于 `facts`。未知事实会在组合前被拒绝。

### 2. 生成图片

对每个 `assets[].prompt` 调用 Agent 自带的 imagegen。生成后保留原始文件，并转换为 data URL：

```json
{
  "id": "img-001",
  "dataUrl": "data:image/png;base64,..."
}
```

不要用 imagegen 生成图标；模板图标优先来自审核后的本地 SVG 库。

### 3. 生成与 QA

调用 `generate_slide`，回传与规划阶段相同的正文，并增加：

```json
{
  "plannedSpec": { "...": "plan_slide 返回的完整对象" },
  "templateSlug": "green-infographic-bid-a4-landscape-visual",
  "externalAssets": [
    { "id": "img-001", "dataUrl": "data:image/png;base64,..." }
  ]
}
```

Workflow 顺序：

```text
normalize_input
  → build_or_validate_slide_spec
  → select_template
  → persist_external_or_provider_assets
  → compose_self_contained_html
  → chromium_render_and_measure
  → six_dimension_quality_report
  → bounded_targeted_repair
  → promote_final_artifacts
```

## QA 规则

硬门禁检查：

- 恰好一个 `data-slide-page`。
- 1123 × 794 固定 A4 横向画布，无 body 或文本裁切溢出。
- 正文不低于 8.5pt；普通文字对比度至少 4.5:1，大字至少 3:1。
- 图片加载成功且有有效像素；SVG 图标与 Raster 图片分开评价。
- 无 `<script>`、远程请求、残余占位符和疑似密钥。

六维得分权重：忠实度 25%、结构 15%、可读性 20%、布局 20%、资产 10%、技术完整性 10%。没有 review API 时，仍执行完整硬门禁和确定性评分。

修复动作是闭集：定向改写 block、恢复事实、重生指定资产、最多切换一次模板、调整字号/间距/对比度 token。最多 3 次尝试，不允许模型写任意 CSS 或 JavaScript。

## 状态

- `delivered`：硬门禁通过且 `score >= minScore`。
- `best_effort`：存在安全可查看的页面，但阈值或硬门禁未全部满足。
- `failed`：没有安全页面。

`remainingIssues` 是 Agent 下一步判断的唯一问题清单。不要只看分数。

## 幂等与恢复

`requestId` 与完整输入指纹绑定。同一个 requestId、同一个输入会复用 run；同一 requestId 配不同输入会返回 fingerprint 错误。已完成阶段保存在 `stages/`，图片提示词哈希不变时可复用资产。

## 产物读取

- `get_run({runId})`：manifest 和阶段状态。
- `evaluate_slide({runId})`：最终质量 JSON。
- `get_artifact({runId, artifactName})`：闭集读取 `manifest.json`、`final.html`、`final.png`、`quality.json`。

HTML/JSON 小于 512 KiB 时可内联返回；较大的产物返回安全绝对路径和字节数。

## Provider 模式

如果 Server 配置了 OpenAI-compatible provider，`plan_slide`、图片生成和多模态 review 可自动执行。凭证仅来自 `.env` 中的 `PPT_LLM_*`、`PPT_IMAGE_*`、`PPT_REVIEW_*`，绝不能放入 MCP 工具参数。
