# Green Infographic 模板族

绿色商务信息图型 A4 横向模板，面向标书、技术方案与项目汇报。模板使用统一页眉、章节带、内容网格、总结带和页脚，通过不同组件容量覆盖纯文字、图文、表格和视觉重点页。

模板不负责理解正文，也不按页码绑定版式。MCP 先把固定分页正文转成模板无关的页面计划，再依据 `template-profiles.json` 中的能力、容量、密度和文档兼容性选择具体模板。

## 文件清单

```text
green-infographic/
├── green-infographic-bid-a4-landscape.html
├── green-infographic-bid-a4-landscape-text-image.html
├── green-infographic-bid-a4-landscape-visual.html
├── green-infographic-bid-a4-landscape-table-text.html
├── green-infographic-bid-a4-landscape-table-image.html
├── green-infographic-bid-a4-landscape-table-text-image.html
├── green-infographic-theme.css
├── template-profiles.json
└── assets/icons/
    ├── calendar.svg
    ├── clipboard-check.svg
    ├── file-description.svg
    ├── scissors.svg
    ├── search.svg
    ├── shield-check.svg
    ├── truck.svg
    └── users-group.svg
```

## 模板能力

| slug | 主要用途 | 图片需求 | 兼容文档 |
|---|---|---:|---|
| `green-infographic-bid-a4-landscape` | 通用详情、流程、对比、证据 | 0–1 | 标书、方案、展示 |
| `green-infographic-bid-a4-landscape-text-image` | 四组图文并列展示 | 4 | 展示 |
| `green-infographic-bid-a4-landscape-visual` | 单一主视觉与精简要点 | 1 | 展示 |
| `green-infographic-bid-a4-landscape-table-text` | 表格与文字解释 | 0 | 标书、方案、展示 |
| `green-infographic-bid-a4-landscape-table-image` | 表格、图片与说明 | 1 | 标书、方案、展示 |
| `green-infographic-bid-a4-landscape-table-text-image` | 高密度表格、文字与图片 | 1 | 标书、方案、展示 |

精确的语义角色、块容量、字符上限、图片槽位、字体下限和设计契约以 `template-profiles.json` 为唯一事实来源。

## 通用页面结构

```text
┌──────────────────────────────────────────────────────────┐
│ section-title                         PART / part-label │
├──────────────────────────────────────────────────────────┤
│ chapter-label                         topic-title       │
├──────────────────────────────────────────────────────────┤
│ subsection-title                                       │
├──────────────────────────────────────────────────────────┤
│ 由 profile 定义的正文 / 图文 / 表格 / 流程组件网格      │
├──────────────────────────────────────────────────────────┤
│ summary-band                                            │
├──────────────────────────────────────────────────────────┤
│                                                   页码   │
└──────────────────────────────────────────────────────────┘
```

## 占位绑定

页面级绑定包括：

- `page-title`、`page-number`
- `section-title`、`part-number`、`part-label`
- `chapter-label`、`topic-title`、`subsection-title`
- `summary-text`、`image-caption`

内容区常用绑定包括：

- `component-title`、`paragraph`
- `step-label`、`stage-label`、`stage-number`
- `item-label`、`node-label`
- `table-header`、`table-cell`
- `figures`、`figure-ref`

各模板实际支持的绑定与数量必须和 profile 一致。调用方不应直接做字符串替换；由 MCP 的模板解析、内容映射、图标渲染、页面组装和 QA 工具完成编译。

## 维护约束

新增或调整模板时应保持以下边界：

1. 页面规格固定为 A4 横向，模板 slug 唯一。
2. 保留 `page-header`、`chapter-band`、`subsection-title`、`summary-band` 和 `page-footer` 等设计契约要求的地标。
3. profile 必须准确描述容量，不通过缩小到不可读字号来容纳超量正文。
4. 图片槽位数量、`minAssets/maxAssets` 和 HTML 中的 `figures` 数量一致。
5. 仅引用仓库内安全资源；交付 HTML 不包含脚本、远程字体、远程图片、Logo 或水印。
6. 样式变化同步更新 `designContract`，并用真实 Chromium 检查尺寸、溢出、对比度和最小字号。
7. 通过项目根目录的 `npm run check` 后，再执行一次完整生成 workflow 验收。

从外部优秀页面学习的新模板应先进入模板知识 workflow。只有完成 owned compiler 与 QA，并经过人工晋升和 Server 重启后，才能进入正式模板目录参与选择。
