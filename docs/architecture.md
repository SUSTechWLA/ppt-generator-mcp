# PPT Generator MCP 架构与实现原理

本文描述 2026-07-31 已实现并通过自动测试、生产 build 与真实 MCP stdio 双次复现的生产行为。`docs/superpowers/` 下的设计与计划记录该行为的决策依据和实施证据。

## 1. 系统定位与边界

PPT Generator MCP 把上游已经分页的中文标书、技术方案或汇报正文，转换为经过逐页 QA 的自包含 A4 横向 HTML 展示页。它负责以下工作：

- 校验固定分页正文协议；
- 规范化中文标点并建立不可变来源证据；
- 抽取事实、关键锚点和页面元数据；
- 根据每个模板的严格能力 profile 规划可展示内容；
- 生成稳定的图片/图标意图和资产 ID；
- 接收外部生成的图片 data URL；
- 组装 HTML，并使用 Chromium 执行真实布局与质量门禁；
- 持久化计划、页面运行结果和整套一致性证据，支持幂等恢复。

系统不负责自动推测分页，也不要求最终产物必须是 `.pptx`。推荐交付物是自包含 `final.html`；截图 `final.png` 和质量 JSON 用于验收与追踪。

## 2. 总体数据流

```mermaid
flowchart TD
    A["上游固定分页正文"] --> B["MCP 严格输入 Schema"]
    B --> C["显式页解析与标点规范化"]
    C --> D["Source sections / facts / critical anchors"]
    D --> E["逐 profile grounded display planning"]
    E --> F["模板策略、槽位与容量硬门禁"]
    F --> G["逐页完整成功候选，按局部质量排序"]
    G --> H["deck-scope bounded optimizer"]
    H --> I0["有效模式与选择证据持久化"]
    I0 --> H0["不可变 plannedDeck + profile snapshot"]
    H0 --> I{"是否需要图片"}
    I -- "是" --> J["外部 Agent 按 asset id 生成图片"]
    I -- "否" --> K["generate_deck"]
    J --> K
    K --> L["模板编译与自包含 HTML"]
    L --> M["Chromium 渲染与确定性 QA"]
    M --> N{"硬门禁与阈值通过"}
    N -- "否" --> O["定向修复，最多 3 次"]
    O --> L
    N -- "是" --> P["页面交付与 deck consistency"]
    P --> Q["final.html / quality.json / manifest"]
```

模板知识沉淀是旁路流程：参考 HTML、截图或通用 blueprint 先经过安全检查和 owned compiler，再通过 Chromium QA，保存为不可变知识；它不会自动进入生产模板目录。

## 3. 固定正文如何变成来源证据

### 3.1 严格分页协议

高层 deck 路径只接受以下结构：

```text
<page 59>
一级标题：...
二级标题：...
三级标题：...
四级标题：可选
正文：
本页正文。
```

`<page N>` 必须独占一行，页码严格递增，调用参数 `pageNumbers` 必须与正文标记完全一致。高层路径不调用旧 Markdown 兼容解析器，不自动切页，也不会在缺少明确标记时猜测页码。入口实现位于 `src/services/explicit-page-parser.ts`。

### 3.2 中文标点规范化

`src/services/content-normalizer.ts` 和 `src/domain/chinese-punctuation.ts` 在事实抽取前统一处理中文标点，主要解决：

- 重复分号，例如 `；；`；
- 分号与句号等冲突结尾，例如 `；。`；
- 列表或事实重新组合时机械追加分号；
- 引号、括号附近不合理的句末标点组合。

规范化发生在来源建模和后续文本组合的公共边界，不针对某一页、某句话或某个模板写特例。

### 3.3 事实与关键锚点

每页正文被转换为有序 `SourceSection[]` 和 `SourceFact[]`。事实 ID 在整套文档中保持稳定顺序；计划会同时持久化原始 section ID、fact ID、事实文本和覆盖证据。

`src/domain/critical-anchor.ts` 识别不能在压缩表达中丢失的内容，包括数字、比例、日期、范围、单位、否定关系和其他决定事实含义的短语。grounded planner 可以合并表达，但每个事实必须恰好被表示，关键锚点必须出现在最终可见文本中。

## 4. `plan_deck` 的当前实现

### 4.1 页面元数据

显式标题被映射为页眉、章节、主题和小节元数据。每个字段在进入模板规划前就按展示容量校验；超长标题会返回可修复错误，而不是在渲染时缩到不可读字号。

### 4.2 每个模板都独立证明可行

对身份过滤后允许参与的每个 approved profile，`src/workflow/plan-deck.ts` 依次执行：

1. `planGroundedDisplay`：在该 profile 的真实容量预算内建立 display items；
2. `selectTemplate`：验证页面意图、密度、文档类型、图片基数和模板能力；
3. `solveTemplateSlots`：把每个 display item 分配到确定的语义槽位和 value index；
4. `materializeSlideSpec`：把已落地的 display plan 投影为确定性的 slide spec；
5. 校验页面元数据和图片提示词绑定的字符容量；
6. 只有 `unmatched=[]` 且 `unrepresentedFactIds=[]` 的候选才算成功。

失败候选只产生有界、脱敏的本地诊断，不会把依赖异常、堆栈、物理路径或隐藏提示词暴露给调用方。

### 4.3 局部质量排序与整套序列选择

生产 workflow 先对每页全部成功候选执行稳定的局部质量排序：

1. 保留的正文字符数更多；
2. 模板选择分更高；
3. 内容块数量更接近模板 block capacity；
4. profile version 字典序稳定比较。

排序第一的候选是该页质量参考。`off` 直接采用所有局部赢家；`conservative`、`balanced` 与 `expressive` 只允许落在各自 retained-character loss 和 selection-score loss 质量带内的候选参与整套选择。事实覆盖、critical anchors、槽位与字符容量、最小字号、页面元数据、图片基数及文档策略在进入质量带之前已经作为硬门禁执行，任何模式都不能绕过。

| 模式 | 相对本页最佳的正文字符损失 | 模板选择分损失 |
|---|---:|---:|
| `off` | 只保留局部赢家 | 只保留局部赢家 |
| `conservative` | `0` | 最多 `3` |
| `balanced` | 最多 `min(18, max(6, floor(best × 3%)))` | 最多 `8` |
| `expressive` | 最多 `min(40, max(12, floor(best × 7%)))` | 最多 `15` |

`src/services/deck-template-diversity.ts` 使用固定的 first-use reward、adjacent-repeat penalty 和质量损失函数做确定性 beam DP。为限制模板 catalog 增长后的成本，每页最多保留 12 个已准入候选，每一页最多保留 256 个状态，公共输入最多 30 页，即扩展上限为 `30 × 256 × 12` 次 transition。状态去重、剪枝和最终选择使用同一组稳定 tie-breakers；相同正文、catalog、页序和参数得到相同序列。

新计划省略 `templateDiversity` 时，workflow 采用默认 `balanced` 并持久化有效模式。显式 `templateSlug` 是调用方强制覆盖：候选身份被固定，有效模式强制为 `off`。若硬门禁后某页只有一个完整成功候选，优化器保留该安全赢家，不会为追求版式变化扩大质量带。

这不是强化学习。优化器没有训练数据、探索、策略更新、环境反馈或在线学习，只是在固定约束和固定效用函数下求解有界组合选择。

### 4.4 不可变计划证据

每个 slide plan 不只保存模板 slug，还保存：

- 原始 source sections、facts 和 fact 顺序；
- display plan、fact coverage 与关键锚点；
- deterministic slide spec 与图片意图；
- 完整 template profile snapshot 及 capability hash；
- 每个语义项的 slot assignment、字符使用和容量总计；
- 页面元数据与图片提示词的绑定证据；
- 按局部质量顺序保存的完整成功候选评分；
- 有效 `templateDiversity`、保留字符损失、选择分损失、首次使用、相邻重复，以及重复是不可避免还是全局质量权衡优选的证据；
- 选择原因、文档策略和主题信息。

`planFingerprint` 绑定来源、页面顺序、质量要求、有效多样性模式和上述模板能力证据。使用相同 `requestId` 恢复计划时，Server 返回原计划，并用当前 catalog 再次校验 capability；不会静默重规划旧计划。历史计划的 `templateDiversity` 仍是可选字段，解析时不会为旧 artifact 合成默认值，因此原 fingerprint 保持有效。

## 5. 模板 profile 为什么是核心

HTML 只描述“怎么画”，profile 描述“能否诚实地画”。`templates/green-infographic/template-profiles.json` 是生产模板能力的唯一事实来源，声明：

- `pageIntents` 与 `supportedRoles`；
- 语义槽位、必需槽位、每槽 item capacity 和字符上限；
- 标题、正文、表格、流程和辅助组件的 binding expansion；
- 图片占位符数量、`minAssets/maxAssets` 和无图处理策略；
- block capacity、密度区间、最小正文字号和最大位图面积；
- 标书、方案、展示等文档类型兼容性；
- A4 横向格式、设计 token 和必须存在的页面地标。

模板选择不能绕过 profile。新增 HTML 而不新增准确 profile，或扩大 HTML 容量却不更新 profile，都会导致规划证据和真实渲染不一致。

## 6. 图片与外部 Agent 的职责分界

`plan_deck` 返回的 `assets` 是确定性图片意图，每项包含稳定、页级作用域的 ID 和 prompt。高层 workflow 不在规划阶段调用图片 API。

调用方可以使用任意图像能力生成图片，但必须：

1. 保留 Server 返回的资产 ID；
2. 转换为允许的 PNG、JPEG、WebP 或 SVG data URL；
3. 通过 `externalAssets` 交给 `generate_deck`；
4. 不添加计划之外的资产，也不把远程 URL 当成交付图片。

若缺少必需图片，`generate_deck` 返回 `needs_assets`。补齐后复用相同 request ID 即可继续，已经交付的页面不会重复生成。只有最终被选页面的资产会出现在高层规划输出中。

## 7. `generate_deck`、逐页 QA 与修复

### 7.1 生成前验证

`generate_deck` 先读取不可变计划并验证：

- deck plan ID、request ID 和输入 schema；
- 当前模板 catalog 与持久化 profile snapshot 一致；
- 外部资产 ID、类型、数量、大小和 data URL 安全；
- 每页只消费属于该页的资产；
- 同一 request ID 的并发请求按队列串行化。

### 7.2 HTML 组装

内容映射不做自由字符串替换，而是依据持久化 assignment、profile bindings 和模板占位符进行确定性投影。最终 HTML 必须自包含，不允许脚本、远程字体、远程图片、Logo 或水印。

### 7.3 Chromium 硬门禁

`src/services/page-renderer.ts` 在真实 Chromium 中测量 DOM、字体、图片和布局；`src/services/deterministic-evaluator.ts` 至少检查：

- 画布和 body 无滚动溢出；
- 元素未越界、未被祖先裁剪、未发生非豁免碰撞；
- 正文字号不低于 profile 与文档策略中更严格的值；
- 普通文本与大字满足相应对比度；
- 位图数量和面积不超过更严格的模板/文档上限；
- 图片为允许的内联格式，能够加载且不是空白占位；
- 页面元数据、语义项、fact ID、关键锚点和可见文本与计划一致；
- 必需语义槽、地标和图片槽均满足 profile。

可选多模态 reviewer 只能补充质量判断，不能覆盖确定性硬门禁。诊断在返回前还会经过安全规范化，避免泄露路径、提示词或敏感内容。

### 7.4 定向修复

失败页面进入有界质量循环，默认最多 3 次。修复路由只允许执行计划支持的动作，例如调整字号/间距 token、增强对比度、在兼容范围内切换模板或重新生成已声明资产。每次尝试都有独立 HTML、截图和质量证据。

仅当页面分数达到阈值且全部硬门禁通过时，页面才可交付。整套页面完成后还要执行 deck consistency；任何失败页或跨页一致性问题都会使结果保持 `partial`，不能作为正式交付。

## 8. 状态、幂等与恢复

### 8.1 计划阶段

`DeckStore.createOrResumePlan` 使用 request ID 与 canonical input 建立不可变计划身份：

- 同一 request ID + 相同输入：返回原计划；
- 同一 request ID + 不同输入：拒绝复用；
- 恢复时 catalog 能力不再匹配：拒绝继续，避免用新模板解释旧证据。

### 8.2 生成阶段

deck run 按页持久化状态。重复调用会复用已完成页，只处理缺失资产或尚未交付的页面。最终状态语义：

| 状态 | 含义 |
|---|---|
| `needs_assets` | 计划要求的图片尚未全部提供，可恢复 |
| `running` | 页面正在生成或 QA |
| `partial` | 有失败页或 deck consistency 问题，不可交付 |
| `delivered` | 所有页面和整套一致性检查均通过 |
| `failed` | 未形成可安全继续的结果 |

## 9. MCP 工具面

Server 当前注册 20 个工具，分为四层。

### 9.1 推荐的多页交付工具

| 工具 | 责任 |
|---|---|
| `plan_deck` | 固定分页正文到不可变计划、模板证据和图片 prompts |
| `generate_deck` | 外部资产注入、逐页生成、QA、修复和一致性检查 |
| `get_deck` | 按 UUID 读取脱敏计划、manifest 或白名单产物 |

### 9.2 模板知识工具

| 工具 | 责任 |
|---|---|
| `inspect_template` | 只读检查有界内联 HTML，提取通用布局知识 |
| `create_template_from_reference` | 从一种参考输入编译并 QA 不可变模板知识 |
| `list_template_knowledge` | 列出已批准知识、能力标签和 QA 证据 |

### 9.3 单页兼容与诊断工具

`plan_slide`、`generate_slide`、`get_run`、`get_artifact`、`evaluate_slide` 保留给旧 workflow、单页调试和自定义编排。新的稳定多页交付应优先使用 deck 工具。

### 9.4 原子模板工具

`list_templates`、`load_template`、`fill_placeholders`、`insert_asset_slots`、`render_icons`、`assemble_page`、`validate_page`、`parse_source_content`、`generate_image` 用于受控的低层编排。

前两组构成推荐的 high-level deck/template-knowledge surface：strict schema 不接收调用方 API Key、base URL、任意物理路径或远程 URL，provider secret 来自 Server 环境，产物进入受控 store。

后两组是 trusted-local legacy/atomic surface，而不是同一安全承诺的延伸。部分兼容/原子 schema 接收物理路径、`apiKey`、`baseUrl`、`outputPath` 或 `outputDir`；`generate_image` 可按调用方配置直接发起网络请求并写入调用方指定目录。它们继承宿主进程的网络和文件权限，其下载与输出不享受 high-level host allowlist、artifact allowlist 或 store-root containment 保证。它们只适合受控本地编排，不得暴露给不可信 Agent；生产部署应通过 MCP client/gateway 工具白名单只开放所需高层工具，或把 trusted-local surface 置于独立受控主机。

## 10. 模板知识沉淀

模板学习的目标是复用网格、层级、间距、色板、组件和视觉比例，而不是复制参考页面正文或品牌。

1. `inspect_template` 对内联 HTML 做只读安全检查并输出归一化 blueprint；
2. `create_template_from_reference` 每次只接受一种输入：内联 HTML、受限图片 data URL 或已验证 blueprint；
3. 截图缺少 Server 视觉分析器时返回 `needs_analysis`，由外部 Agent 填充通用 blueprint；
4. owned compiler 生成 Server 自有的模板结构，不把截图当背景，也不保留可见正文、Logo、水印或品牌；
5. 模板目录校验和真实 Chromium QA 通过后，知识以版本化记录写入 store；
6. 人工检查后把闭集产物晋升到 `templates/`，重启 Server 才参与生产选择。

这条隔离线避免未经验证的参考页面直接影响正式交付。

## 11. 安全设计

### 11.1 推荐 high-level surface

这里的安全承诺只覆盖 9.1 与 9.2 的 deck/template-knowledge 工具：

- 入口使用 strict Zod schema，拒绝未知字段，不接收调用方 key、base URL、物理路径或远程 URL；
- provider 密钥只从 Server 环境变量读取，并以不可枚举属性保存在 Server 内部；
- 输入只包含有界正文、受限 data URL、蓝图和逻辑 ID；
- deck 与 template-knowledge store 对路径做根目录包含、realpath 和符号链接检查；
- 可读取产物使用固定 artifact 白名单和大小上限，大型 HTML 不通过公共文本接口回传；
- 图片大小、数量、输入字符数、并发数和请求时长有显式上限；
- 高层错误与诊断经过结构化和脱敏，未知异常不把原始依赖消息、堆栈或物理路径返回调用方。

### 11.2 Trusted-local legacy/atomic surface

9.3 与 9.4 为兼容旧 workflow 和受控低层编排而保留。它们可能接收物理路径、调用方 `apiKey/baseUrl` 和输出目录，并可使用宿主网络与文件系统权限。特别是 `generate_image` 可直接访问调用方配置的 endpoint 并写入 `outputDir`；`assemble_page` 等工具也可写入调用方路径。

因此，high-level 的 host allowlist、artifact allowlist、store-root containment 和“secret 只来自环境”保证不适用于这些 legacy/atomic 下载与输出操作。Server 注册这些工具不等于授权不可信 Agent 使用它们；工具暴露策略必须由受控 MCP client/gateway 或独立部署边界执行。

## 12. 当前限制与演进方向

### 12.1 当前限制

- 上游必须先分页；Server 不做语义自动分页；
- 当前模板目录只有 `green-infographic` 模板族；
- 只有经过 profile、文档策略和 grounded planner 全部验证的模板才有资格参与选择，因此模板数量多不等于某页存在多个合格候选；
- 某页只有一个完整成功候选，或其他候选超出所选模式的质量带时，整套优化可以合法连续使用同一版式；
- 高层 workflow 不隐式调用图片 API；调用方必须完成图片生成和注入；
- 当前自动验证包含 `npm test` 的 contract、优化器与真实 workflow 回归，以及 `npm run check` 的 typecheck/build；Chromium 交付 QA 仍在 `generate_deck` 阶段按页执行。

### 12.2 已实现的整套模板多样性选择

生产版会先保留每页全部完整成功候选，再用有界、确定性的序列优化器选择整套组合。事实覆盖、critical anchors、容量、字号、图片基数和文档策略仍是硬门禁；只有质量接近本页最佳的候选才能参与多样性竞争。选择证据和有效模式随 planned deck 持久化并进入新计划 fingerprint。

完整模式、质量带、目标函数和兼容策略见 `docs/superpowers/specs/2026-07-30-deck-template-diversity-design.md`。

## 13. 扩展时的验收清单

### 新模板

- HTML 自包含、A4 横向、slug 唯一；
- profile 准确声明所有容量、角色、图片槽和文档兼容性；
- template bindings 与 profile expansion 完全一致；
- 不依靠缩小到不可读字号容纳正文；
- 真实 Chromium 检查地标、溢出、碰撞、字号、对比度和图片；
- 对同一正文重复规划得到同一计划和 fingerprint。

### 新 workflow 能力

- 先定义输入、持久化证据和历史兼容策略；
- 新策略不能绕过事实、容量、图片或文档硬门禁；
- 推荐 high-level workflow 的外部 provider 必须可选，并保持密钥只在 Server 环境；
- 幂等恢复不能因新默认值改变历史计划身份；
- 更新 README、本文和真实 MCP 验收步骤后再进入主分支。
