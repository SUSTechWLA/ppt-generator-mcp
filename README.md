# PPT Generator MCP

将 HTML 模板转化为可交付页面（PPT/标书/方案）的 MCP Server。提供 7 个原子工具，可由编排层 Agent（Claude Code / OpenCode / 自定义 Agent）调度，组合文生文 LLM + 文生图 API，完成模板选择 → 内容填充 → 图标渲染 → 配图生成 → 页面组装 → 质量验证的完整链路。

## 快速开始

### 前置条件

- Node.js ≥ 22
- （可选）OpenAI API Key — 启用 LLM 扩写和 DALL-E 文生图
- （可选）Anthropic API Key — 使用 Claude 模型扩写

### 安装

```bash
git clone <repo-url> ppt-generator-mcp
cd ppt-generator-mcp
npm install
```

### 跑通 Demo

```bash
npm run demo
```

这会用内置的绿化养护标书示例内容填充模板，在 `output/` 生成一页完整的 A4 横向 HTML 页面。

## 一键集成 Agent

### Claude Code

在项目根目录的 `.mcp.json`（已配置）：

```json
{
  "mcpServers": {
    "ppt-generator": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

重启 Claude Code 后，Agent 可直接调用 `list_templates`、`load_template` 等工具。

### OpenCode / 自定义 Agent

在 OpenCode 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "ppt-generator": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/src/server.ts"]
    }
  }
}
```

或手动启动 stdio 传输：

```bash
npm start
```

### 使用 MCP Inspector 调试

```bash
npx @modelcontextprotocol/inspector npx tsx src/server.ts
```

## 架构

```
编排层 (Claude Code / OpenCode / 自定义 Agent)
    │  MCP Protocol (stdio)
    ▼
┌─────────────────────────────────────────────────┐
│  src/server.ts          MCP Server（7 工具注册）  │
│  src/lib/                                              │
│  ├── template-parser.ts   模板扫描 / 占位符解析       │
│  └── llm-client.ts        OpenAI + Anthropic 客户端    │
│  src/tools/                                             │
│  ├── fill-placeholders.ts 文生文填充（核心）           │
│  ├── generate-image.ts    DALL-E 文生图                │
│  ├── render-icons.ts      <icon> → SVG <img>           │
│  ├── assemble-page.ts     组装 HTML + 复制 CSS          │
│  └── validate-page.ts     残留占位符 / HTML 合法性检查   │
└─────────────────────────────────────────────────┘
```

## 7 个 MCP 工具

| # | 工具 | 输入 | 输出 | API 依赖 |
|---|------|------|------|----------|
| 1 | `list_templates` | `templatesDir?` | 模板元数据列表 | 无 |
| 2 | `load_template` | `slug` | HTML + 占位符清单 + 图标清单 | 无 |
| 3 | `fill_placeholders` | `html` + `content` + `llmConfig?` | 填充后 HTML + 详情 + 残留清单 | OpenAI / Anthropic（expand 模式） |
| 4 | `generate_image` | `html`/`prompt` + `imageConfig` | 图片路径 + HTML | OpenAI DALL-E |
| 5 | `render_icons` | `html` + `iconBasePath` | HTML（icon → img） | 无 |
| 6 | `assemble_page` | `html` + `config` | 输出文件路径 + HTML | 无 |
| 7 | `validate_page` | `html` + `checks` | 验证结果 + 问题清单 | 无 |

## 标准调度流程

编排层 Agent 按以下顺序调用 7 个工具，完成一页 PPT：

```
1. list_templates     → 浏览模板库，按 usecase/format 选择合适模板
2. load_template      → 加载 HTML，获取占位符和图标清单
3. fill_placeholders  → 用 direct 文本或 LLM 扩写填充所有占位符
4. render_icons       → 将 <icon name="x"> 替换为 SVG <img>
5. generate_image     → 将 <figures> 提示词替换为 DALL-E 生成的图片
6. assemble_page      → 移除注释、复制 CSS、写入输出文件
7. validate_page      → 检查残留占位符、图片引用、HTML 合法性
```

### 编排示例（伪代码）

```python
# Agent 伪代码 — 展示编排层如何调用 MCP 工具
templates = mcp.call("list_templates")
tpl = pick_best(templates, usecase="标书技术方案", format="A4横向")

parsed = mcp.call("load_template", slug=tpl.slug)
# parsed.placeholders → [{tag: "component-title", count: 5}, ...]

content = build_content_from_user_document(user_doc, parsed.placeholders)
# content.direct = {"component-title": [...], "paragraph": [...], ...}

filled = mcp.call("fill_placeholders", html=parsed.html, content=content)

icons = mcp.call("render_icons", html=filled.html, iconBasePath=tpl.iconDir)

images = mcp.call("generate_image", html=icons.html, imageConfig={...})

page = mcp.call("assemble_page", html=images.html,
    config={outputPath: "output/page-1.html", templateDir: tpl.dir})

result = mcp.call("validate_page", html=page.html, checks=["no-xml-tags", ...])
assert result.valid
```

## 6 个内置模板

| # | Slug | 风格 | 布局 |
|---|------|------|------|
| 1 | `green-infographic-bid-a4-landscape` | 正文+组件配对 | 5组 text-card(span-8) + 可视化组件(span-4) |
| 2 | `...-visual` | 少文字视觉为主 | 大图 + 双栏简述 + 图标流程 + 能力面板 |
| 3 | `...-text-image` | 多文+图片 1:1 | 4行 text(span-6) ⇄ image(span-6) 交错 |
| 4 | `...-table-image` | 表格+图片 | 大表格(span-8) + 图片(span-4) + 时间线 |
| 5 | `...-table-text` | 表格+文字 | 评分矩阵(span-7) + 文字解读(span-5) |
| 6 | `...-table-text-image` | 表格+文字+图片 | 文字(span-5) + 图片(span-3) + 表格(span-4) |

### 模板格式

模板是含 XML 占位符的 HTML 文件。占位符由 MCP 工具解析和替换：

```html
<!-- 模板头部 XML 注释：元数据 -->
<!-- @name 绿色信息图型标书页（A4横向） @slug green-infographic-... -->

<title><page-title>第N页｜页面主题标题</page-title></title>
...
<h4 class="component-title"><component-title>卡片标题</component-title></h4>
<p><paragraph>正文段落内容。</paragraph></p>
<img src="..."><icon name="calendar">图标描述</icon>
<figures>文生图提示词</figures>
```

LLM 替换规则：
1. `<xxx>示例文字</xxx>` → 去除标签，替换文字
2. `<icon name="x">描述</icon>` → `<img src="./assets/icons/x.svg">`
3. `<figures>提示词</figures>` → `<img src="生成的图片">`
4. 属性中的占位值 → 替换为实际值
5. 最终不得残留任何 `<xxx>` XML 标签

### 添加新模板

1. 在 `templates/` 下创建新目录
2. 编写 HTML 模板，使用 XML 占位符标记可变内容
3. 添加 XML 注释头部（`@name`、`@slug`、`@usecase` 等）
4. HTML `<meta>` 标签携带相同元数据
5. 配套 CSS 和 assets（图标、图片）
6. 运行 `npm run demo` 验证模板可被正确解析

## 目录结构

```
├── src/
│   ├── server.ts              # MCP Server 入口
│   ├── lib/
│   │   ├── template-parser.ts # 模板扫描、元数据解析、占位符提取
│   │   └── llm-client.ts      # OpenAI / Anthropic 统一客户端
│   └── tools/
│       ├── fill-placeholders.ts # 文生文填充（direct + LLM 扩写）
│       ├── generate-image.ts    # DALL-E 文生图
│       ├── render-icons.ts      # <icon> → <img> SVG 渲染
│       ├── assemble-page.ts     # 组装 HTML、复制 CSS、写文件
│       └── validate-page.ts     # 残留占位符 / HTML 合法性检查
├── templates/
│   └── green-infographic/      # 绿色信息图模板
│       ├── green-infographic-bid-a4-landscape.html  # 模板 HTML
│       ├── green-infographic-theme.css              # 主题 CSS
│       ├── assets/icons/                            # SVG 图标（Tabler Icons）
│       └── README.md          # 模板文档
├── tests/
│   └── demo.ts                 # 端到端 Demo
├── .mcp.json                   # Claude Code MCP 配置
├── package.json
└── tsconfig.json
```

## 配置

### 环境变量

| 变量 | 用途 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API Key（文生文 + DALL-E 文生图） |
| `ANTHROPIC_API_KEY` | Anthropic API Key（文生文） |
| `ENABLE_IMAGE_GEN` | 设为任意值启用 DALL-E 文生图（demo 中） |

### MCP Server 配置

`.mcp.json` 已预配置，支持的 Agent 框架：

- **Claude Code** — 自动发现 `.mcp.json`
- **OpenCode** — 在配置中引用 `command: "npx"` + `args: ["tsx", "src/server.ts"]`
- **自定义 Agent** — 通过 stdio 启动 `npm start`，发送 JSON-RPC 消息

## License

MIT
