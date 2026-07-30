# PPT Generator MCP

面向中文标书、技术方案和项目汇报的展示页生成 MCP。主工作流接收已经由上游分页的固定格式正文，逐页输出自包含 A4 横向 HTML、PNG 预览、质量报告和跨页一致性报告。

本项目交付的是“像 PPT 的单页 HTML”，不是 `.pptx`。最终 HTML 已内联 CSS、SVG 和图片，不依赖网络资源。

## 核心能力

- 固定上游协议：整行 `<page N>`、标签化标题、`正文：`；页码边界不猜测、不重排。
- 事实与来源证据：金额、面积、数量、时限和约束均可追溯到所属页面。
- 模板无关页面蓝图和严格 `TemplateProfile`：按容量、语义角色、图片槽位、文档策略和密度选择模板，不按页码、正文或 slug 特判。
- `plan_deck → generate_deck → get_deck`：不可变计划、断点续跑、每页独立 QA、跨页一致性校验。
- 无图片 API 模式：Agent 调用 `imagegen` 后，以 `externalAssets` 注入图片。
- 可选 OpenAI-compatible 文本、图片和多模态评审 provider。
- Chromium QA：单页、尺寸、溢出、字号、对比度、图片加载、脚本、远程资源和敏感信息门禁。
- 最多 3 次定向修复；`requestId` 支持断点复用。

## 安装与启动

要求 Node.js 22+。

```bash
npm install
npx playwright install chromium
npm run build
npm start
```

生产 MCP 配置已写入 `.mcp.json`：

```json
{
  "mcpServers": {
    "ppt-generator": {
      "command": "node",
      "args": ["dist/src/server.js"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

开发时可改为 `command: "npx"`、`args: ["tsx", "src/server.ts"]`。OpenCode 或自定义 Agent 使用相同 stdio 命令即可。

## 推荐 Agent workflow（无需图片 API）

1. 上游把正文整理为固定分页协议，调用 `plan_deck`。
2. 逐项读取返回的 `assets[].id` 和 `assets[].prompt`；Agent 仅在这里调用自身的 `imagegen`。
3. 将图片转为 Base64 data URL，按原资产 ID 组成 `externalAssets`。
4. 使用 `deckPlanId` 调用 `generate_deck`。缺图时返回 `needs_assets`，补齐后复用同一 `requestId` 继续。
5. 逐页检查质量分与硬门禁，再检查 deck consistency；只有 deck 状态为 `delivered` 才作为交付件。

输入必须采用以下格式；`<page N>` 必须独占一行，`pageNumbers` 必须与标记完全相同且严格递增：

```text
<page 59>
一级标题：第一分节：优势与有利条件分析
二级标题：2.1 项目需求深度理解
三级标题：2.1.1 项目背景与采购需求解读
四级标题：可选的更细标题
正文：
这里是本页正文，可包含多个自然段。
```

规划调用：

```json
{
  "sourceText": "<page 59>\n一级标题：第一分节：优势与有利条件分析\n二级标题：2.1 项目需求深度理解\n三级标题：2.1.1 项目背景与采购需求解读\n正文：\n这里是第59页正文。",
  "pageNumbers": [59],
  "documentType": "bid",
  "preferredThemeId": "green-infographic-v1",
  "audience": "招标评审专家与项目业主",
  "quality": { "minScore": 90, "maxAttempts": 3 },
  "requestId": "proposal-deck-plan-001"
}
```

生成调用：

```json
{
  "deckPlanId": "直接使用 plan_deck 返回的 UUID",
  "externalAssets": [
    { "id": "p59-img-001", "dataUrl": "data:image/png;base64,..." }
  ],
  "requestId": "proposal-deck-run-001"
}
```

`externalAssets` 可使用 PNG、JPEG、WebP 或 SVG data URL。资产 ID 必须与 `plan_deck.assets` 完全一致；不要自行增加图片。

## 高层 MCP 工具

| 工具 | 用途 |
|---|---|
| `plan_deck` | 固定分页正文 → 不可变逐页计划、模板能力证据和图片提示词 |
| `generate_deck` | 资产注入 → 逐页生成/QA/修复和跨页一致性检查 |
| `get_deck` | 按 UUID 读取脱敏 plan、manifest 或闭集文本产物 |

`plan_slide`、`generate_slide` 和原子工具继续保留用于兼容与调试。稳定交付必须优先使用 deck 工作流；高层 deck 路径不会调用旧 Markdown 兼容解析器或语义自动分页器。

## 状态与产物

- `needs_assets`：计划需要图片，当前仍缺少一个或多个指定资产；可使用同一请求继续。
- `running`：正在逐页生成。
- `partial`：部分页面已生成，但仍有失败页或一致性问题，不可正式交付。
- `delivered`：全部页面达到各自阈值、硬门禁通过且跨页一致性通过。
- `failed`：没有形成可继续的安全结果。

页面运行写入 `<PPT_OUTPUT_ROOT>/<runId>/`，deck 元数据写入 `<PPT_OUTPUT_ROOT>/decks/`：

```text
manifest.json
final.html
final.png
quality.json
assets/
attempts/01..03/
stages/
decks/plans/<deckPlanId>/plan.json
decks/runs/<deckRunId>/manifest.json
decks/runs/<deckRunId>/consistency.json
```

## 配置

复制 `.env.example` 并按需设置。所有 provider 都是可选的：

- `PPT_LLM_BASE_URL / API_KEY / MODEL`：文本规划。
- `PPT_IMAGE_BASE_URL / API_KEY / MODEL`：图片生成；URL 响应还需 `PPT_IMAGE_ALLOWED_HOSTS`。
- `PPT_REVIEW_BASE_URL / API_KEY / MODEL`：多模态复核。
- `PPT_OUTPUT_ROOT`：运行目录，默认 `output/runs`。
- `PPT_REQUEST_TIMEOUT_MS`、`PPT_MAX_IMAGE_BYTES` 等：运行限制。

密钥只从 Server 环境读取，不进入 `generate_slide` 参数、HTML 或 manifest。旧版 `generate_image` 仅为兼容用途。

## 验证与真实 Demo

```bash
npm run typecheck
npm run build
npm test
npm run demo:source
```

`demo:source` 通过内存 MCP 完整调用 `plan_slide → generate_slide`，使用 `examples/assets/personnel-coordination.png`，并执行真实 Chromium QA。

详细 deck 工具契约与接入说明见 [docs/workflows/generate-deck.md](docs/workflows/generate-deck.md)。

## 模板开发

模板位于 `templates/green-infographic/`，能力档案在 `template-profiles.json`。新增模板必须：

1. 提供唯一 slug 和 A4 横向 HTML。
2. 只使用受支持占位标签。
3. 增加 `approved` profile。
4. 通过 `npm run test:templates`、浏览器渲染测试和完整验收。

## License

MIT
