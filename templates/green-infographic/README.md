# Green Infographic 模板

绿色信息图型标书页面 — A4 横向，12 列网格，正文+可视化组件配对展示。

## 文件清单

```
green-infographic/
├── green-infographic-bid-a4-landscape.html  # ★ 模板：标书 A4 横向信息图页
├── green-infographic-theme.css              # 主题样式（颜色、排版、布局）
├── green-infographic-page.html              # 参考示例（已填充的实际标书页）
├── assets/
│   ├── icons/                               # SVG 图标库（Tabler Icons / MIT）
│   └── images/                              # 图片素材
└── README.md
```

## 模板元数据

每个模板通过 **文件头部 XML 注释** 和 **HTML `<meta>` 标签** 两层携带元数据。LLM 扫描模板目录时，读取 `@name` 和 `@description` 即可判断是否匹配当前任务。

### 元数据格式（XML 注释头部）

```
@name        绿色信息图型标书页（A4横向）
@slug        green-infographic-bid-a4-landscape
@description 适用于标书技术方案、项目建议书...A4横向单页...
@usecase     标书技术方案 | 项目建议书 | 方案汇报
@format      A4横向 297×210mm 单页
@layout      12列网格 | 正文卡片(span-8)+可视化组件(span-4)配对
@components  text-card | icon-flow | image-card | timeline | ...
@style       绿色商务 | 信息图 | 圆角卡片 | 渐变章节条
@lang        zh-CN
```

### HTML `<meta>` 标签

```html
<meta name="template-name" content="绿色信息图型标书页（A4横向）">
<meta name="template-slug" content="green-infographic-bid-a4-landscape">
<meta name="template-description" content="适用于标书技术方案...">
<meta name="template-usecase" content="标书技术方案, 项目建议书, ...">
<meta name="template-format" content="A4横向 297×210mm">
```

## LLM 模板选择流程

```
1. 列出 templates/ 下所有 *.html 文件
2. 每个文件读取前 80 行，解析 @name、@description、@usecase、@format
3. 根据用户任务匹配：
   - 文档类型 → 匹配 @usecase
   - 页面格式 → 匹配 @format
   - 内容密度 → 匹配 @description 中的布局描述
4. 选定模板后，读取完整文件，按替换规则填充内容
```

## 命名规范

模板文件命名遵循：`{style}-{usecase}-{format}.html`

| 段 | 含义 | 本模板取值 |
|----|------|-----------|
| style | 视觉主题 | `green-infographic` |
| usecase | 适用场景 | `bid` |
| format | 页面规格 | `a4-landscape` |

未来扩展示例：
- `green-infographic-bid-a4-portrait.html` — 同主题竖版
- `blue-corporate-report-a4-landscape.html` — 蓝调企业报告
- `green-infographic-certification-a4-portrait.html` — 绿色认证页

## 页面结构

```
┌────────────────────────────────────────────────────────┐
│  section-title                    PART.X / part-label  │  ← 页面头部
├────────────────────────────────────────────────────────┤
│  chapter-label              topic-title                │  ← 渐变章节条
├────────────────────────────────────────────────────────┤
│  subsection-title                                      │  ← 子章节标题
├─────────────────────────┬──────────────────────────────┤
│  text-card (span-8)     │  visual-component (span-4)   │
│  卡片标题               │  图标流程 / 图片 / 时间线    │  ← 正文网格
│  正文段落               │  能力面板 / 组织架构         │    12 列,
├─────────────────────────┼──────────────────────────────┤    6 行
│  ... 共 5 组配对 ...    │  ...                         │
├─────────────────────────┴──────────────────────────────┤
│  summary-band (span-12)  总结 + 要点                    │
├────────────────────────────────────────────────────────┤
│                                            [页码]      │  ← 渐变色页脚
└────────────────────────────────────────────────────────┘
```

## XML 占位符参考

所有占位符为包裹式 XML 标签，内含中文示例文字，人可读、LLM 可解析。

### 页面元数据

| 占位符 | 示例内容 | LLM 替换为 |
|--------|---------|-----------|
| `<page-title>` | `第N页｜页面主题标题` | 替换内部文字 |
| `<page-number>` | `N` | 数字 |
| `<section-title>` | `第一分节：分节名称` | 节标题 |
| `<part-number>` | `PART.N` | 部分编号 |
| `<part-label>` | `部分标签` | 标签文字 |
| `<chapter-label>` | `X.X 章节名称` | 章节编号+标题 |
| `<topic-title>` | `页面主题标题` | 当前页主题 |
| `<subsection-title>` | `X.X.X 子章节标题` | 子章节编号+标题 |

### 正文卡片（text-card）

```html
<section class="component text-card span-8" data-component="text-card">
  <h4 class="component-title"><component-title>卡片标题</component-title></h4>
  <p data-source-paragraph="N"><paragraph>正文段落内容。</paragraph></p>
</section>
```

| 子占位符 | 说明 |
|---------|------|
| `<component-title>` | 卡片小标题 |
| `<paragraph>` | 正文段落，根据信息密度 150-250 字为宜 |

### 图标流程（icon-process）

```html
<div class="process-step">
  <icon name="calendar">日历图标</icon>
  <span><step-label>步骤名称</step-label></span>
</div>
```

| 子占位符 | 说明 |
|---------|------|
| `<icon name="...">` | `name` 选现有图标，内部文字为备选文生图提示词 |
| `<step-label>` | 步骤名称 |

### 图片卡片（image-card）

```html
<figures>根据左侧正文提炼的图片提示词。</figures>
<figcaption class="image-caption"><image-caption>图片说明</image-caption></figcaption>
```

| 子占位符 | 说明 |
|---------|------|
| `<figures>` | 图片提示词，应关联左侧 `<paragraph>` 正文内容 |
| `<image-caption>` | 图片下方说明文字 |

### 时间线（timeline）

```html
<div class="timeline-stage season-spring">
  <strong><stage-number>01</stage-number></strong>
  <span><stage-label>阶段名称</stage-label></span>
</div>
```

`season` 取值：`spring`(绿) | `summer`(青) | `autumn`(橙) | `winter`(蓝)

### 能力面板（capability-panel）

```html
<div class="capability-item">
  <icon name="users-group">图标描述</icon>
  <span><item-label>能力项名称</item-label></span>
</div>
```

### 组织架构图（org-chart）

```html
<div class="org-node"><node-label>节点名称</node-label></div>
```

### 总结条（summary-band）

```html
<p><summary-text>总结段落</summary-text></p>
<ul class="summary-list">
  <li><bullet>要点内容</bullet></li>
</ul>
```

## LLM 替换规则

| 优先级 | 模式 | 处理方式 |
|--------|------|---------|
| 1 | `<xxx>示例文字</xxx>` | 去除外层 XML 标签，替换内部文字为生成内容 |
| 2 | `<icon name="calendar">描述</icon>` | 替换为 `<img src="./assets/icons/calendar.svg" alt="描述">` |
| 3 | `<figures>提示词</figures>` | 根据左侧正文提炼提示词，替换为 `<img src="路径" alt="描述">` |
| 4 | 属性中 `N` 或中文占位值 | 替换属性值为实际内容 |
| 5 | 最终检查 | 输出不得残留任何 `<xxx>...</xxx>` XML 标签 |

## 可用图标

所有图标位于 `assets/icons/`，通过 `<icon name="...">` 的 `name` 属性引用。

| 文件名 | 语义 | 适用场景 |
|--------|------|---------|
| `calendar.svg` | 日历 | 计划、排期 |
| `scissors.svg` | 剪刀 | 修剪、裁剪 |
| `search.svg` | 搜索 | 检查、巡查 |
| `clipboard-check.svg` | 剪贴板勾选 | 整改、核查 |
| `file-description.svg` | 文件 | 归档、文档 |
| `users-group.svg` | 用户组 | 人员、团队 |
| `truck.svg` | 卡车 | 设备、运输 |
| `shield-check.svg` | 盾牌勾选 | 质量、安全 |
| `leaf.svg` | 叶子 | 绿化、生态 |
| `sun.svg` | 太阳 | 天气、光照 |
| `droplet.svg` | 水滴 | 浇水、湿度 |
| `snowflake.svg` | 雪花 | 防寒、冬季 |
| `wind.svg` | 风 | 抗风、通风 |
| `bug.svg` | 虫子 | 病虫害 |
| `alert-triangle.svg` | 警告 | 风险、应急 |
| `user.svg` | 用户 | 人员、角色 |

## 颜色系统

| 变量 | 色值 | 用途 |
|------|------|------|
| `--green-900` | `#0B5A2A` | 标题、深色背景 |
| `--green-700` | `#2F7D32` | 渐变、分割线 |
| `--green-500` | `#5E9C48` | 色块点缀 |
| `--green-100` | `#DCEAD8` | 卡片背景 |
| `--green-050` | `#F2F7EF` | 表格斑马纹 |
| `--cyan-600` | `#1D9DB2` | 夏季/渐变 |
| `--blue-500` | `#0B84E6` | 冬季/渐变 |
| `--orange-500` | `#D98A12` | 秋季 |
| `--ink` | `#171A18` | 正文 |
| `--muted` | `#6B746E` | 辅助文字 |
| `--line` | `#8FAE99` | 边框 |

## 布局参数

| 参数 | 值 |
|------|-----|
| 页面尺寸 | A4 横向 297×210mm |
| 网格 | 12 列，间距 2.5mm(行) × 3mm(列) |
| 组件圆角 | 2.5mm |
| 字体 | Source Han Sans SC → Noto Sans CJK SC → Microsoft YaHei → PingFang SC |
| 正文字号 | 10.8pt |
| 最小字号 | 8.5pt |
