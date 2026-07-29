# PPT Generator MCP

面向中文标书、技术方案和项目汇报的单页生成 MCP。输入 Markdown 或结构化 sections，输出一张自包含的 A4 横向 HTML、PNG 预览、质量报告和可恢复 manifest。

本项目交付的是“像 PPT 的单页 HTML”，不是 `.pptx`。最终 HTML 已内联 CSS、SVG 和图片，不依赖网络资源。

## 核心能力

- 正文规范化与事实 ID：金额、时限、数量、强制要求均可回溯。
- `SlideSpec`：标题、结论、3–6 个内容模块和资产提示词的稳定中间模型。
- 6 个批准模板：按容量、模块类型、图片槽位和密度评分选择。
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

1. 调用 `plan_slide`，获得事实清单、`plannedSpec`、模板和 `assets[].prompt`。
2. Agent 用自身的 `imagegen` 能力按提示词生成图片。
3. 将图片转为 Base64 data URL，按资产 ID 组成 `externalAssets`。
4. 调用 `generate_slide`，传回原始正文、`plannedSpec`、模板 slug 和图片。
5. 读取返回的 HTML、PNG、quality 和 manifest；如为 `best_effort`，查看 `remainingIssues`。

规划调用：

```json
{
  "sourceText": "# 项目服务方案\n\n## 服务目标\n项目要求建立标准化服务体系。",
  "audience": "采购评审专家",
  "quality": { "minScore": 85, "maxAttempts": 3 },
  "requestId": "proposal-page-001"
}
```

生成调用在上述字段基础上增加：

```json
{
  "plannedSpec": { "...": "直接使用 plan_slide 返回值" },
  "templateSlug": "green-infographic-bid-a4-landscape-visual",
  "externalAssets": [
    { "id": "img-001", "dataUrl": "data:image/png;base64,..." }
  ]
}
```

`externalAssets` 可使用 PNG、JPEG、WebP 或 SVG data URL。资产 ID 必须与 `plannedSpec.assets` 一致。

## 高层 MCP 工具

| 工具 | 用途 |
|---|---|
| `plan_slide` | 正文 → 事实约束、SlideSpec、模板和图片提示词 |
| `generate_slide` | 资产注入 → 组合、浏览器渲染、评分、修复和交付 |
| `evaluate_slide` | 读取最终质量报告 |
| `get_run` | 查看 manifest、阶段和尝试记录 |
| `get_artifact` | 安全读取 `final.html`、`final.png`、`quality.json` 或 manifest |

兼容原子工具仍可用于调试：`list_templates`、`load_template`、`parse_source_content`、`fill_placeholders`、`insert_asset_slots`、`render_icons`、`generate_image`、`assemble_page`、`validate_page`。高层交付应优先使用 `plan_slide` 与 `generate_slide`。

## 状态与产物

- `delivered`：所有硬门禁通过，得分达到阈值。
- `best_effort`：页面安全可查看，但未达到阈值或仍有非安全性硬门禁问题。
- `failed`：没有任何尝试满足安全返回条件。

每次运行写入 `output/runs/<runId>/`：

```text
manifest.json
final.html
final.png
quality.json
assets/
attempts/01..03/
stages/
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

详细工具契约与接入说明见 [docs/workflows/generate-slide.md](docs/workflows/generate-slide.md)。

## 模板开发

模板位于 `templates/green-infographic/`，能力档案在 `template-profiles.json`。新增模板必须：

1. 提供唯一 slug 和 A4 横向 HTML。
2. 只使用受支持占位标签。
3. 增加 `approved` profile。
4. 通过 `npm run test:templates`、浏览器渲染测试和完整验收。

## License

MIT
