# PPT Generator MCP

面向中文标书、技术方案和项目汇报的 HTML 展示页生成 MCP。它接收上游已经分页的固定格式正文，根据严格模板能力档案规划页面、生成图片提示词、注入外部图片，并逐页执行 Chromium QA，最终输出可独立交付的 A4 横向 HTML。

项目不依赖特定 Agent：任何支持 MCP stdio 和工具调用的 workflow 都能接入。最终交付是内联 CSS、SVG 与图片的自包含 HTML，而不是 `.pptx`。

## 核心能力

- 固定输入协议：只接受整行 `<page N>`、标签化标题和 `正文：`，不猜测页码，不自动重新分页。
- 中文标点规范化：清理正文中的重复分号和冲突句末标点，并在事实、要点和修复文本组合时避免机械追加分号。
- `plan_deck → generate_deck → get_deck`：不可变计划、外部图片注入、断点续跑、逐页独立 QA 和跨页一致性检查。
- 通用模板选择：依据语义角色、组件容量、内容密度、图片槽位和文档兼容性选择模板，不按页码、正文或模板名写特例。
- 模板知识沉淀：从内联 HTML、展示页截图或通用蓝图提取布局知识，经 owned compiler 和真实浏览器 QA 后保存为不可变模板知识。
- 质量门禁：检查单页尺寸、溢出、字号、对比度、图片加载、远程资源、脚本与敏感信息；最多进行 3 次定向修复。
- Provider 可选：没有文本或图片 API 时仍可确定性规划，并由调用方通过 `externalAssets` 注入图片。
- 安全边界：API Key 仅从 Server 环境读取；高层工具不接受路径、远程 URL、任意文件名或图片 API Key。

## 项目结构

```text
.
├── src/                         # MCP 工具、工作流、模板编译、渲染和 QA
├── templates/
│   └── green-infographic/       # A4 横向模板、能力档案、样式与图标
├── .mcp.json                    # MCP stdio 配置
├── .env.example                 # 可选 provider 与运行限制
├── package.json
└── tsconfig.json
```

`dist/`、`output/` 和 `node_modules/` 均为可再生成目录，不属于源码交付。

## 安装与启动

要求 Node.js 22+。

```bash
npm install
npx playwright install chromium
npm run check
npm start
```

`.mcp.json` 已配置生产 stdio Server：

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

开发时运行 `npm run dev`，或让 Agent 使用 `npx tsx src/server.ts` 作为 stdio 命令。

## 固定正文协议

上游必须先完成分页。每个 `<page N>` 必须独占一行，页码严格递增；`pageNumbers` 必须与标记完全一致。

```text
<page 59>
一级标题：第一分节：优势与有利条件分析
二级标题：2.1 项目需求深度理解
三级标题：2.1.1 项目背景与采购需求解读
四级标题：可选的更细标题
正文：
这里是本页正文，可包含多个自然段。

<page 60>
一级标题：第一分节：优势与有利条件分析
二级标题：2.2 服务方案
三级标题：2.2.1 实施路径
正文：
这里是下一页正文。
```

高层 deck 路径不会调用旧 Markdown 兼容解析器，也不会做语义自动分页。输入格式错误时直接返回可修复的契约错误。

## 推荐生成 workflow

1. 调用 `plan_deck`，得到不可变 `deckPlanId`、逐页模板选择、内容计划以及 `assets[].id/prompt`。
2. 调用方按提示词生成图片。没有图片 API 时，可由 Agent 自己的图像能力生成，再转换为 PNG、JPEG、WebP 或 SVG data URL。
3. 保持原资产 ID，将图片组成 `externalAssets`，调用 `generate_deck`。
4. 若返回 `needs_assets`，补齐缺失资产并复用相同 `requestId`；已交付页面不会重复生成。
5. 逐页检查分数与硬门禁，再检查 deck consistency。仅 `status=delivered` 可作为正式交付。
6. 使用 `get_deck` 读取脱敏 manifest、`final.html`、`quality.json` 或 `consistency.json`。

规划示例：

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

生成示例：

```json
{
  "deckPlanId": "plan_deck 返回的 UUID",
  "externalAssets": [
    { "id": "plan_deck 返回的资产 ID", "dataUrl": "data:image/png;base64,..." }
  ],
  "requestId": "proposal-deck-run-001"
}
```

不得自行增加资产 ID；没有图片需求时传空数组。

## 模板知识 workflow

模板学习的目标是提取可复用的网格、层级、排版、色板、间距、组件和视觉比例，而不是复制参考页正文、品牌、Logo、水印或整页截图。

1. 对内联 HTML 先调用 `inspect_template`，只读检查结构、安全风险和归一化蓝图。
2. 调用 `create_template_from_reference`，且每次只传一种输入：`referenceHtml`、受限图片 data URL，或符合 schema 的 `blueprint`。
3. 截图在 Server 未配置视觉分析器时返回 `needs_analysis`，调用方依据返回的 `analysisPrompt` 和 `blueprintSchema` 生成通用蓝图后再次提交。
4. `approved` 结果已经通过模板目录校验和真实 Chromium QA，并写入不可变知识存储。
5. `list_template_knowledge` 可读取逻辑 ID、能力标签、闭集产物名和 QA 证据，不暴露物理路径或原始像素。
6. 新知识不会自动进入运行中的模板目录。按返回的 `promotion.instruction` 人工晋升 `template.html` 与 `profile.json`，重启 Server 后才参与选择。

## 主要 MCP 工具

| 工具 | 用途 |
|---|---|
| `plan_deck` | 固定分页正文 → 不可变逐页计划、模板证据和图片提示词 |
| `generate_deck` | 外部资产注入 → 逐页生成、QA、修复和跨页一致性检查 |
| `get_deck` | 按 UUID 读取脱敏计划、manifest 或闭集文本产物 |
| `inspect_template` | 只读分析内联 HTML 的通用布局与设计知识 |
| `create_template_from_reference` | 从 HTML、截图或蓝图编译并 QA 模板知识 |
| `list_template_knowledge` | 列出已批准模板知识及 QA 证据 |

`plan_slide`、`generate_slide`、`get_run`、`get_artifact`、`evaluate_slide` 及原子模板工具继续保留，用于兼容、调试或自定义编排。稳定的多页交付优先使用 deck workflow。

## 状态与产物

- `needs_assets`：仍缺少计划中指定的一个或多个图片，可继续同一请求。
- `running`：正在逐页生成。
- `partial`：存在失败页或跨页一致性问题，不可正式交付。
- `delivered`：所有页面达到阈值、硬门禁和跨页一致性要求。
- `failed`：没有形成可继续的安全结果。

默认运行目录为 `output/runs`：

```text
<runId>/
├── final.html
├── final.png
├── quality.json
├── manifest.json
├── assets/
├── attempts/
└── stages/
decks/
├── plans/<deckPlanId>/plan.json
└── runs/<deckRunId>/
    ├── manifest.json
    └── consistency.json
template-knowledge/
└── ...
```

## 配置

复制 `.env.example` 并按需设置。所有 provider 都是可选的：

- `PPT_LLM_BASE_URL / API_KEY / MODEL`：OpenAI-compatible 文本规划。
- `PPT_IMAGE_BASE_URL / API_KEY / MODEL`：兼容低层图片工具；远程 URL 还需 `PPT_IMAGE_ALLOWED_HOSTS`。
- `PPT_REVIEW_BASE_URL / API_KEY / MODEL`：可选多模态复核。
- `PPT_OUTPUT_ROOT`：运行目录，默认 `output/runs`。
- `PPT_MAX_CONCURRENCY`、`PPT_REQUEST_TIMEOUT_MS`、`PPT_MAX_IMAGE_BYTES` 等：资源限制。

没有 reviewer 时，Chromium 硬门禁与确定性评分仍然生效。密钥只从环境变量读取，不进入工具参数、HTML 或 manifest。

## 模板维护

内置模板位于 `templates/green-infographic/`，使用同目录 `template-profiles.json` 描述能力。新增或晋升模板必须：

1. 提供唯一 slug 和自包含 A4 横向 HTML。
2. 只使用 Server 支持的占位标签与本地安全资源。
3. 为容量、语义角色、图片槽位、密度和文档类型提供严格 profile。
4. 通过 `npm run check`，并在真实 Chromium 中完成渲染和质量门禁。

模板族的具体清单和维护约束见 `templates/green-infographic/README.md`。

## License

MIT
