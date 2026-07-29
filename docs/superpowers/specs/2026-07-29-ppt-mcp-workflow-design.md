# PPT Generator MCP 单页 HTML Workflow 优化设计

日期：2026-07-29  
状态：已确认，待实施计划  
目标场景：中文商务标书、技术方案、项目汇报

## 1. 背景

当前项目已经具备模板扫描、正文解析、占位符填充、图标渲染、图片生成、HTML 组装和基础验证能力，并内置 6 个绿色商务风格的 A4 横向模板。现有类型检查、全模板 QA 和正文 Demo 均可运行。

目前仍存在以下影响 Agent 稳定调用的问题：

- `src/server.ts` 同时承担工具定义、参数转换、调用分发和服务启动，边界不清晰。
- Demo 已经使用 `insertAssetSlots` 和提示词参考页，但该能力没有注册为 MCP 工具，README 与实际代码不同步。
- 正文解析和模板推荐包含“人员配备”等特定业务硬编码，难以覆盖其他中文商务内容。
- 模板推荐主要依赖小节数量和固定 slug，没有基于模板能力、文本密度和素材需求进行评分。
- 当前验证只覆盖残留标签、图片路径和 HTML 可解析性，无法判断文本溢出、视觉层级、信息忠实度和素材相关性。
- API Key 由工具参数传入，容易进入 Agent 上下文、调用记录或错误输出。
- 默认 Demo 生成“布局页 + 提示词页”两页 HTML，不符合最终单页交付目标。
- 缺少一键完成完整链路的高层工具，不同 Agent 必须自行理解和编排多个原子步骤。

本设计在保持现有原子工具兼容的前提下，增加稳定的一键 Workflow、标准中间模型、真实素材生成、浏览器渲染、多模态质量评价和自动修正闭环。

## 2. 已确认的产品边界

### 2.1 首版目标

- 最终交付物是高质量、A4 横向、单页、自包含 HTML。
- HTML 中直接包含实际生成的图片，不保留图片槽位，也不附加第二页提示词表。
- 图片默认以内联 Data URL 形式写入 HTML，同时保留原始素材文件。
- 图片提示词、图标语义、质量报告和生成记录写入结构化 manifest。
- Workflow 自动执行质量评价和最多 3 轮定向修正。
- API 凭证只由 MCP Server 环境变量管理。
- 文本、图片和评审统一通过 OpenAI-compatible API 接入。
- 输入同时支持原始 Markdown 和上游已处理的结构化 sections。
- 模板只来自仓库内经过审核和版本管理的模板库。
- 首版聚焦中文商务标书、技术方案和项目汇报。

### 2.2 非目标

- 不生成 `.pptx` 文件。
- 不允许 Agent 在运行时提交任意 HTML 模板。
- 不在首版覆盖营销、培训、个人作品集等通用演示场景。
- 不在首版提供中英文或多语言模板。
- 不在首版建设队列、数据库和独立任务调度服务。
- 不允许模型直接写入任意 CSS 或执行任意文件路径。

## 3. 方案选择

采用“高层 Workflow 工具 + 原子工具”的组合方案。

- `generate_slide` 是默认交付入口，一次调用执行完整链路。
- 原子工具继续开放，用于调试、局部重做和高级 Agent 自定义编排。
- 高层工具和原子工具调用相同的领域服务，不维护两套业务逻辑。
- 每次运行生成 `runId` 和持久化 manifest，为将来升级到任务引擎保留接口。
- 旧工具名称和主要输入保持兼容，避免破坏已有 Agent 配置。

不采用仅靠调用 Agent 编排的方案，因为不同 Agent 容易漏掉质量检查、错误恢复或素材替换步骤。首版也不采用持久化任务引擎，因为当前单页生成规模尚不需要数据库、队列和任务生命周期管理。

## 4. 总体架构

高层 Workflow 依次执行七个阶段：

1. `normalize_input`
2. `build_slide_spec`
3. `select_template`
4. `generate_assets`
5. `compose_html`
6. `render_and_evaluate`
7. `repair_loop`

建议代码结构：

```text
src/
├── server.ts
├── config/
│   ├── env.ts
│   └── limits.ts
├── domain/
│   ├── source-document.ts
│   ├── slide-spec.ts
│   ├── template-profile.ts
│   ├── quality-report.ts
│   └── run-manifest.ts
├── providers/
│   ├── text-provider.ts
│   ├── image-provider.ts
│   ├── review-provider.ts
│   └── openai-compatible.ts
├── workflow/
│   ├── generate-slide.ts
│   ├── quality-loop.ts
│   └── run-store.ts
├── services/
│   ├── content-normalizer.ts
│   ├── fact-extractor.ts
│   ├── slide-spec-builder.ts
│   ├── template-selector.ts
│   ├── asset-generator.ts
│   ├── slide-composer.ts
│   ├── page-renderer.ts
│   ├── slide-evaluator.ts
│   └── repair-router.ts
├── tools/
└── mcp/
    ├── definitions.ts
    ├── handlers.ts
    └── errors.ts
```

`src/server.ts` 只负责加载配置、注册工具、连接 transport 和输出启动日志。

## 5. 标准领域模型

### 5.1 SourceDocument

无论调用方传入 Markdown 还是 sections，首先转换为统一结构：

```ts
interface SourceDocument {
  language: "zh-CN";
  title?: string;
  sections: SourceSection[];
  facts: SourceFact[];
  sourceHash: string;
}

interface SourceSection {
  id: string;
  heading: string;
  body: string;
  keyPoints: string[];
  order: number;
}

interface SourceFact {
  id: string;
  text: string;
  kind: "number" | "name" | "requirement" | "conclusion";
  sourceSectionId: string;
}
```

输入归一化负责：

- 解析 Markdown 标题、段落和列表。
- 清理空段、重复空白和异常控制字符。
- 保留原始顺序。
- 提取数字、时间、面积、名称、强制要求和主要结论。
- 生成稳定的内容哈希，用于幂等和缓存。
- 对空正文、超长正文和结构不合法的 sections 返回 `INPUT_INVALID`。

### 5.2 SlideSpec

`SlideSpec` 是内容、模板和 HTML 之间的稳定中间模型：

```ts
interface SlideSpec {
  title: string;
  eyebrow?: string;
  conclusion: string;
  blocks: SlideBlock[];
  assets: AssetSpec[];
  sourceFactIds: string[];
  designIntent: {
    tone: "professional";
    density: "low" | "medium" | "high";
    visualRatio: number;
  };
}
```

每个 `SlideBlock` 明确类型、标题、正文、数据和来源事实，不直接包含模板标签或 HTML。每个 `AssetSpec` 包含稳定 ID、类型、所属 block、提示词、替代文本、尺寸、风格约束和来源事实。

文本模型必须返回符合 Schema 的 JSON。无法解析或引用不存在的事实 ID 时，不进入模板填充阶段。

### 5.3 TemplateProfile

模板元数据扩展为可评分的能力档案：

```ts
interface TemplateProfile {
  slug: string;
  version: string;
  blockCapacity: number;
  supportedBlocks: Array<"text" | "image" | "table" | "process" | "metric">;
  imageSlots: number;
  densityRange: ["low" | "medium" | "high", "low" | "medium" | "high"];
  maxCharsBySlot: Record<string, number>;
  format: "a4-landscape";
  status: "approved";
}
```

模板选择根据以下因素评分：

- block 类型与容量匹配度
- 图片数量和图片占比
- 表格、流程或指标组件需求
- 总文字量与槽位容量
- 信息密度
- 内容顺序与模板视觉顺序

强制指定 `templateSlug` 时仍执行兼容性检查；明显不匹配时返回问题，而不是静默产生溢出页面。

## 6. Workflow 数据流

### 6.1 normalize_input

接受 `sourceText` 或 `sections`，二者必须且只能提供一个。输出 `SourceDocument` 和事实清单。

### 6.2 build_slide_spec

调用文本模型完成：

- 提炼单页核心结论。
- 选择 3–6 个最重要的信息块。
- 保留关键数字、名称和强制要求。
- 为每个 block 绑定来源事实 ID。
- 生成图片或图标素材规格。
- 控制文本长度，使其落在模板库可支持的范围。

该阶段不选择具体模板，也不生成 HTML。

### 6.3 select_template

对所有 `approved` 模板计算匹配分，返回选中模板、候选排名和选择理由。模板不匹配时优先调整 `SlideSpec` 的信息密度；不会为了塞入模板而删除关键事实。

### 6.4 generate_assets

- 按 `AssetSpec` 调用 OpenAI-compatible 图片接口。
- 默认图片并发数为 2。
- 支持接口返回 URL 或 `b64_json`。
- 对 URL 下载设置协议、域名策略、超时、MIME 和大小校验。
- 图片生成结果保存到运行目录，并记录模型、提示词哈希、尺寸和响应摘要。
- 未修改提示词的素材在后续 attempt 中直接复用。
- 图标优先使用审核后的本地 SVG；只有本地图标库无法表达时才生成新素材。

### 6.5 compose_html

- 将 `SlideSpec` 映射到模板声明的槽位。
- 插入本地图标和生成图片。
- 默认将图片转换为 Data URL，生成单文件 HTML。
- 移除模板 XML 注释和所有占位标签。
- 仅允许通过受控设计令牌调整字号、间距和密度。
- 组装结果写入当前 attempt 目录。

### 6.6 render_and_evaluate

使用无头浏览器按 297 × 210 mm、固定 device scale factor 和固定字体环境渲染页面，输出 PNG 截图、DOM 测量结果和质量报告。

### 6.7 repair_loop

根据质量问题执行局部修正。每次修正生成新 attempt，不覆盖历史记录。最多执行 3 个 attempt，达到交付阈值后立即停止。

## 7. MCP 工具契约

### 7.1 generate_slide

输入：

```ts
interface GenerateSlideInput {
  sourceText?: string;
  sections?: Array<{
    heading: string;
    body: string;
    keyPoints?: string[];
  }>;
  templateSlug?: string;
  audience?: string;
  quality?: {
    minScore?: number;
    maxAttempts?: number;
  };
  requestId?: string;
}
```

规则：

- `sourceText` 和 `sections` 二选一。
- `minScore` 默认 85，允许范围 70–95。
- `maxAttempts` 默认 3，允许范围 1–3。
- `requestId` 是调用方提供的幂等键。
- 不接受 API Key、Base URL 或模型名称。

输出：

```ts
interface GenerateSlideOutput {
  runId: string;
  status: "delivered" | "best_effort" | "failed";
  selectedTemplate: {
    slug: string;
    reason: string;
  };
  artifacts: {
    htmlPath: string;
    previewPath: string;
    manifestPath: string;
  };
  quality: {
    score: number;
    threshold: number;
    hardGatePassed: boolean;
    attempts: number;
    dimensions: Record<string, number>;
    remainingIssues: QualityIssue[];
  };
  summary: string;
}
```

MCP 默认返回路径、评分和摘要，不把自包含 HTML、图片或完整模型响应直接写入 Agent 上下文。

状态语义固定如下：

- `delivered`：全部硬性门槛通过，且综合分达到阈值。
- `best_effort`：已经生成可解析、可截图、图片完整且不含敏感信息的单页 HTML，但内容、溢出、布局或综合分仍未达到交付门槛。
- `failed`：没有形成可安全查看的完整单页 HTML，或配置、Provider、渲染、评审 Schema、敏感信息检查等关键阶段失败。

### 7.2 新增辅助工具

- `evaluate_slide`：对运行目录中的 HTML 或允许范围内的 HTML 文件执行完整质量评价。
- `get_run`：读取 run 状态、阶段记录、attempt 列表和质量摘要。
- `get_artifact`：读取 manifest、质量报告等文本产物；大文件返回路径和大小，不直接回传。
- `insert_asset_slots`：注册现有调试能力，仅用于提示词预览或模板调试，不进入默认 workflow。

### 7.3 保留的兼容工具

- `list_templates`
- `load_template`
- `parse_source_content`
- `fill_placeholders`
- `generate_image`
- `render_icons`
- `assemble_page`
- `validate_page`

兼容工具内部迁移到新的 service 和 provider，旧工具名称和主要输入保持不变。其工具描述应明确用途、前置条件、输出格式和推荐下一步。

### 7.4 Schema 与返回约定

- 所有新工具使用严格 JSON Schema 并拒绝所有未声明字段。
- 成功响应同时提供机器可读 JSON 和一段简短的人类摘要。
- 失败响应使用统一错误结构，不在普通文本中混入未定义错误格式。
- 大型产物通过运行目录和 artifact 工具访问。

## 8. 运行目录与状态

每次运行写入独立目录：

```text
output/runs/<runId>/
├── final.html
├── final.png
├── manifest.json
├── assets/
│   ├── img-001.png
│   └── img-NNN.png
└── attempts/
    ├── 01/
    │   ├── page.html
    │   ├── preview.png
    │   ├── measurements.json
    │   └── quality.json
    ├── 02/
    └── 03/
```

manifest 至少记录：

- runId、requestId、requestFingerprint、创建和更新时间
- sourceHash、配置档名称和模板版本
- 每个阶段的状态、耗时和错误摘要
- `SlideSpec`
- 素材 ID、提示词、提示词哈希和文件路径
- 每个 attempt 的得分、问题和修正动作
- 最终选中 attempt
- 产物路径和校验和

manifest 不记录 API Key、请求头、服务端完整错误响应或环境变量值。

`requestFingerprint` 由规范化输入、`templateSlug`、`audience`、质量阈值和最大 attempt 数共同计算。相同 `requestId` 和相同 `requestFingerprint` 再次调用时返回已有结果，或从最后成功阶段恢复。相同 `requestId` 对应不同 fingerprint 时返回 `INPUT_INVALID`，防止错误复用。调用方希望使用新参数重新生成时必须提供新的 `requestId`。

## 9. 质量评价

### 9.1 硬性门槛

以下任一检查失败，产物不得标记为 `delivered`：

- HTML 可解析且不存在残留 XML 占位标签。
- 页面严格为单页 A4 横向。
- 不存在文本溢出、组件越界、遮挡或裁切。
- 图片全部加载成功且具有有效尺寸。
- 标题、关键数字和专有名词与来源事实一致。
- 页面不包含 API Key、内部系统提示词或错误堆栈。
- 浏览器截图成功。
- 评审模型返回符合 Schema 的评价结果。

### 9.2 综合评分

| 维度 | 权重 |
|---|---:|
| 原文忠实度与关键信息保留 | 25 |
| 叙事结构与结论表达 | 15 |
| 可读性与信息密度 | 20 |
| 版式、层级、留白和配色 | 20 |
| 图片及图标的相关性与风格统一 | 10 |
| HTML 技术质量与可交付性 | 10 |

默认阈值为 85 分。总分由各维度归一化加权计算，不能由评审模型直接给出一个无明细的总分。

### 9.3 确定性评价

浏览器检测至少包括：

- 根页面数量和页面尺寸
- 每个组件的 bounding box
- `scrollWidth/clientWidth` 和 `scrollHeight/clientHeight`
- 元素是否越过页面安全边界
- 文本最小字号、行高和文本块密度
- 图片加载状态、自然宽高和透明空白异常
- 页面主要区域的空白比例
- 残留占位符和错误文本

### 9.4 多模态评价

评审模型接收：

- 页面截图
- 精简后的来源事实清单
- `SlideSpec`
- 确定性测量结果
- 固定评分 rubric

评审模型必须返回 Schema 化 JSON，其中每个问题包含：

```ts
interface QualityIssue {
  id: string;
  severity: "error" | "warning";
  category:
    | "fidelity"
    | "structure"
    | "readability"
    | "layout"
    | "asset"
    | "technical";
  evidence: string;
  targetId?: string;
  suggestedAction: string;
}
```

评审模型不能自行修改页面，也不能提供可直接执行的任意代码。

## 10. 自动修正策略

`repair-router` 只执行受支持的局部动作：

- 文本过长：重写目标 block，并重新验证事实 ID。
- 论证不清：重写目标标题、正文或结论，不修改无关 block。
- 关键信息缺失：从 `SourceDocument.facts` 补回。
- 图片不相关：修改目标 `AssetSpec` 提示词并只重生成该素材。
- 模板不匹配：在前两个 attempt 中最多切换一次模板。
- 字号、间距或对比度不合格：调整预定义设计令牌。
- 图片比例不匹配：裁切或重生成目标图片。

修正限制：

- 模型不得直接注入 CSS、JavaScript 或文件路径。
- 不得通过删除关键事实解决溢出。
- 未发生变化的内容和素材必须复用。
- 每轮修正必须记录问题 ID、动作类型、目标和结果。

选择最终版本时，先比较硬性门槛，再比较综合分。达到阈值的首个版本即可交付。3 轮后仍未达标时返回最高分版本，状态为 `best_effort`。

## 11. Provider 与环境配置

环境变量：

```text
PPT_LLM_BASE_URL
PPT_LLM_API_KEY
PPT_LLM_MODEL

PPT_IMAGE_BASE_URL
PPT_IMAGE_API_KEY
PPT_IMAGE_MODEL
PPT_IMAGE_ALLOWED_HOSTS

PPT_REVIEW_BASE_URL
PPT_REVIEW_API_KEY
PPT_REVIEW_MODEL

PPT_OUTPUT_ROOT
PPT_MAX_CONCURRENCY
PPT_REQUEST_TIMEOUT_MS
PPT_MAX_INPUT_CHARS
PPT_MAX_IMAGE_BYTES
```

文本、图片和评审三个角色可以指向同一服务，也可以独立配置。配置模块只返回已校验的配置对象，不向工具 handler 暴露原始环境变量。

不需要模型的原子工具应在缺少 API 配置时继续工作。`generate_slide` 启动前必须一次性检查所需配置，缺少配置时快速返回 `CONFIG_MISSING`。

## 12. 安全约束

- 工具参数不接受 API Key。
- 日志、MCP 返回、HTML 和错误信息执行敏感信息扫描。
- 所有输出路径必须位于 `PPT_OUTPUT_ROOT` 内。
- 模板只能通过审核目录中的 slug 访问。
- 外部图片 URL 只允许 `https`，主机必须匹配 `PPT_IMAGE_ALLOWED_HOSTS`，并执行超时、MIME、大小和响应状态校验。
- 输入正文、图片数量、并发数、运行时长和单文件大小均设置上限。
- MCP stdio 标准输出只承载协议消息，诊断日志写入标准错误。
- 模板视为可信仓库资产；来源正文和模型返回均视为不可信输入并进行转义。
- 最终 HTML 默认不包含可执行脚本。
- 错误响应不包含堆栈、请求头、服务端完整响应或环境变量。

## 13. 错误与恢复

统一错误结构：

```ts
interface WorkflowError {
  code:
    | "INPUT_INVALID"
    | "CONFIG_MISSING"
    | "TEMPLATE_FAILED"
    | "MODEL_FAILED"
    | "ASSET_FAILED"
    | "RENDER_FAILED"
    | "QUALITY_FAILED"
    | "INTERNAL_ERROR";
  stage: string;
  retryable: boolean;
  message: string;
  runId?: string;
  recovery?: string;
}
```

恢复规则：

- 每个阶段成功后立即原子写入 manifest。
- `429`、网络超时和服务端 `5xx` 使用带抖动的指数退避。
- 参数错误、认证失败和 Schema 错误不自动重试。
- 单张图片失败只重试该素材。
- 评审服务不可用时保留页面，但运行状态为 `failed`，不能绕过质量门槛。
- 质量未达标但流程完整时返回 `best_effort`。
- `get_run` 始终能够说明最后成功阶段和推荐恢复动作。

## 14. 测试策略

### 14.1 单元测试

- Markdown 和 sections 归一化
- 事实提取与事实引用校验
- `SlideSpec` Schema
- 模板评分和强制模板兼容性
- 路径安全和幂等键
- 评分加权
- 修正路由和最大 attempt 限制
- 敏感信息脱敏

### 14.2 MCP 契约测试

- 工具清单和描述
- 严格输入校验
- 成功结构化返回
- 统一错误码
- 旧工具兼容性
- `requestId` 重放

### 14.3 Provider 测试

使用本地 mock OpenAI-compatible 服务覆盖：

- 文本 JSON 返回
- URL 图片返回
- Base64 图片返回
- 多模态评审返回
- 429、超时、5xx、认证失败和非法 JSON

默认测试不访问外网，也不使用真实 API Key。

### 14.4 渲染与视觉回归

- 所有审核模板执行浏览器渲染。
- 检测页面数量、尺寸、溢出、空白页和图片加载。
- 使用固定字体和固定浏览器版本保存基线截图。
- 视觉回归重点检测异常布局漂移，不以像素完全一致作为唯一标准。

### 14.5 端到端测试

- Markdown 输入生成达标单页 HTML。
- sections 输入生成达标单页 HTML。
- 默认自动选模板。
- 强制模板并通过兼容性检查。
- 图片局部重试。
- 质量修正达到阈值。
- 三轮未达标返回 `best_effort`。
- 中断后通过 `requestId` 恢复。

## 15. 构建、文档与兼容迁移

新增标准脚本：

- `build`
- `test`
- `test:unit`
- `test:contract`
- `test:render`
- `test:e2e`
- `typecheck`
- `start`
- `dev`

生产启动使用构建后的 JavaScript，开发模式继续支持 `tsx`。

README 以 `generate_slide` 为默认调用方式，并包含：

- 环境变量配置
- Claude Code 接入
- OpenCode 接入
- 自定义 Agent 接入
- 完整输入输出示例
- 原子工具说明
- 质量评分说明
- 失败恢复说明

现有 Demo 调整为真实单页成品流程。旧的两页提示词 Demo 可保留为明确命名的调试示例，但不再代表默认交付流程。

## 16. 验收标准

实施完成需要同时满足：

1. 一次 `generate_slide` 调用可生成自包含的单页 A4 横向 HTML。
2. HTML 包含实际图片，不包含素材槽位或第二页提示词表。
3. `delivered` 产物综合分不低于配置阈值，默认 85。
4. `delivered` 产物通过全部硬性检查。
5. 每轮生成、评价和修正均可追踪。
6. 相同 `requestId` 不会重复生成图片或重复计费。
7. 默认测试不依赖外网和真实 API Key。
8. 现有 6 个模板继续通过兼容测试和渲染测试。
9. 现有原子工具调用方式不被破坏。
10. API Key 不出现在工具参数、日志、HTML、manifest 或错误响应中。
11. README 与实际 MCP 工具清单、默认 workflow 和配置保持一致。

## 17. 实施顺序约束

后续实施计划应按以下依赖顺序拆分：

1. 领域模型、配置和严格 Schema
2. Provider 抽象与 mock 服务
3. 输入归一化和事实提取
4. `SlideSpec` 生成
5. 模板能力档案和选择器
6. 素材生成与安全下载
7. 单页 HTML 组装
8. 浏览器渲染和确定性检查
9. 多模态评分与修正闭环
10. Workflow、run store 和幂等恢复
11. MCP 工具注册与兼容层
12. 文档、Demo 和全量验收

每一阶段必须先有可运行的自动化测试，再接入下一阶段。
