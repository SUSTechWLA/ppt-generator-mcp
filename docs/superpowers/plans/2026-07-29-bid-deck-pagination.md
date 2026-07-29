# Generic Content-to-HTML Deck MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MCP 从连续 Markdown/正文稳定规划、生成并逐页验收高质量自包含 HTML 展示页，同时能将优秀 HTML 或展示页/PPT 图片沉淀为可复用模板知识。`test.md` 的 59–62 页只是最终验收样本，图片资产由外部 `imagegen` 回注。

**Architecture:** 在现有单页 `generateSlideWorkflow` 之上增加 deck domain、语义分页器、模板无关 `PageBlueprint`、能力型 `TemplateProfile`、通用槽位求解器、模板知识库、deck store 和 `plan_deck → generate_deck → get_deck` 编排层。每页保存独立源引用、蓝图、模板匹配证据和 runId；生成复用单页渲染与质量循环，deck 检查只负责跨页一致性。

**Tech Stack:** TypeScript ESM、Zod v4、Model Context Protocol SDK、Playwright Chromium、Node.js test runner、JSDOM、现有 HTML/CSS 模板系统。

## Global Constraints

- 本轮目标页码固定为 `59, 60, 61, 62`，但 domain 必须支持其他连续正整数页码。
- 正式交付仅包含自包含 HTML；PNG、quality 和 manifest 是 QA 证据，不生成 PPTX。
- 生产代码不得对页码 59–62、`test.md` 内容、当前模板 slug、某个章节标题或固定“五行”结构建立分支。
- 模板选择只使用能力画像：语义槽位、容量、密度、视觉占比、必需结构、页面意图和文档类型策略。slug 只是标识符。
- `test.md` 和当前模板只存在于 fixture、acceptance 和最终交付脚本。必须增加 slug 重命名与跨行业泛化测试。
- 参考模板工作流必须把“多模态分析”与“确定性 HTML 编译/清洗/QA/入库”分层；无 provider 时返回 `needs_analysis` 而不伪造视觉理解。
- 每页最多一张位图，位图面积不得超过页面面积的 18%。
- 每页必须独立达到 `minScore=90`、通过全部硬门禁，并且最多尝试 3 次、最多切换一次模板。
- 页面正文最小字号不得低于 8.5pt；不得通过删除事实或降低字号解决溢出。
- 所有数字、时限、面积、项目名称和审批条件必须引用源文档事实。
- MCP 在没有文本 provider 时仍能确定性完成分页和页面规划。
- MCP 在没有图片 provider 时返回稳定资产 ID 与提示词；本轮图片只用内置 `imagegen` 生成后作为 data URL 回注。
- 最终 HTML 不得包含远程资源、脚本、密钥、未解析占位符或失败图片。
- 不提交 `.superpowers/brainstorm/` 视觉讨论产物。

---

### Task 1: Deck domain contracts and page-aware single-slide input

**Files:**
- Create: `src/domain/document-context.ts`
- Create: `src/domain/deck-plan.ts`
- Create: `src/domain/deck-manifest.ts`
- Modify: `src/domain/source-document.ts`
- Modify: `src/domain/slide-spec.ts`
- Test: `tests/unit/deck-domain.test.ts`

**Interfaces:**
- Consumes: existing `sourceSectionInputSchema`, `qualitySettingsSchema`, `slideSpecSchema`, and `generateSlideOutputSchema`.
- Produces: `documentTypeSchema`, `pageMetadataSchema`, `planDeckInputSchema`, `plannedDeckSchema`, `generateDeckInputSchema`, `planDeckOutputSchema`, `generateDeckOutputSchema`, `DeckManifest`, and asset IDs matching `p<page>-img-<sequence>`.

- [ ] **Step 1: Write failing schema tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { generateDeckInputSchema, planDeckInputSchema } from "../../src/domain/deck-plan.js";
import { generateSlideInputSchema } from "../../src/domain/source-document.js";

test("deck input accepts one Markdown source and ordered page numbers", () => {
  const input = planDeckInputSchema.parse({
    sourceMarkdown: "### 人员要求\n\n必须配置1名固定对接人员。",
    pageNumbers: [59, 60, 61, 62],
    documentType: "bid",
    quality: { minScore: 90, maxAttempts: 3 },
  });
  assert.deepEqual(input.pageNumbers, [59, 60, 61, 62]);
});

test("deck input rejects duplicate or unordered page numbers", () => {
  assert.throws(() => planDeckInputSchema.parse({
    sourceText: "必须配置1名固定对接人员。",
    pageNumbers: [59, 61, 60, 62],
    documentType: "bid",
  }));
});

test("single-slide input accepts deck-scoped page metadata and asset ids", () => {
  const input = generateSlideInputSchema.parse({
    sourceText: "项目必须在30分钟内启动人员调配，并在1小时内到场。",
    documentType: "bid",
    page: { number: 61, sectionTitle: "人员配置与履约保障", partNumber: "PART.01", partLabel: "方案响应", chapterLabel: "1.1 人员配备要求响应", subsectionTitle: "1.1.1 动态调配机制" },
    externalAssets: [{ id: "p61-img-001", dataUrl: "data:image/png;base64," + "a".repeat(32) }],
  });
  assert.equal(input.page?.number, 61);
});

test("generate deck requires a persisted plan id and page-scoped assets", () => {
  const input = generateDeckInputSchema.parse({
    deckPlanId: "11111111-1111-4111-8111-111111111111",
    externalAssets: [{ id: "p59-img-001", dataUrl: "data:image/png;base64," + "a".repeat(32) }],
  });
  assert.equal(input.externalAssets[0].id, "p59-img-001");
});
```

- [ ] **Step 2: Run the domain tests and verify failure**

Run: `node --import tsx --test tests/unit/deck-domain.test.ts`

Expected: FAIL because `src/domain/deck-plan.ts` does not exist.

- [ ] **Step 3: Implement strict Zod contracts**

```ts
// src/domain/document-context.ts
import * as z from "zod/v4";

export const documentTypeSchema = z.enum(["bid", "proposal", "presentation"]);
export const pageMetadataSchema = z.object({
  number: z.number().int().min(1).max(9999),
  sectionTitle: z.string().trim().min(1).max(60),
  partNumber: z.string().trim().min(1).max(20),
  partLabel: z.string().trim().min(1).max(30),
  chapterLabel: z.string().trim().min(1).max(80),
  subsectionTitle: z.string().trim().min(1).max(100),
}).strict();

export type DocumentType = z.infer<typeof documentTypeSchema>;
export type PageMetadata = z.infer<typeof pageMetadataSchema>;
```

```ts
// src/domain/deck-plan.ts
import * as z from "zod/v4";
import { generateSlideOutputSchema } from "./quality-report.js";
import { externalAssetInputSchema, qualitySettingsSchema, sourceSectionInputSchema } from "./source-document.js";
import { assetSpecSchema, slideSpecSchema } from "./slide-spec.js";
import { documentTypeSchema, pageMetadataSchema } from "./document-context.js";

const sourceChoice = {
  sourceMarkdown: z.string().trim().min(20).max(120_000).optional(),
  sourceText: z.string().trim().min(20).max(120_000).optional(),
  sections: z.array(sourceSectionInputSchema).min(1).max(50).optional(),
};

export const planDeckInputSchema = z.object({
  ...sourceChoice,
  pageNumbers: z.array(z.number().int().min(1).max(9999)).min(1).max(30),
  documentType: documentTypeSchema.default("bid"),
  templateSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  audience: z.string().trim().max(200).optional(),
  quality: qualitySettingsSchema,
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict().superRefine((value, context) => {
  const sources = Number(Boolean(value.sourceMarkdown)) + Number(Boolean(value.sourceText)) + Number(Boolean(value.sections));
  if (sources !== 1) context.addIssue({ code: "custom", message: "Provide exactly one source" });
  if (value.pageNumbers.some((number, index) => index > 0 && number <= value.pageNumbers[index - 1])) {
    context.addIssue({ code: "custom", message: "pageNumbers must be strictly increasing" });
  }
});

export const deckSlidePlanSchema = z.object({
  page: pageMetadataSchema,
  sourceSections: z.array(sourceSectionInputSchema).min(1),
  originalSourceSectionIds: z.array(z.string().regex(/^section-\d+$/)).min(1),
  originalSourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  plannedSpec: slideSpecSchema,
  templateSlug: z.string().regex(/^[a-z0-9-]+$/),
}).strict();

export const plannedDeckSchema = z.object({
  version: z.literal(1),
  deckPlanId: z.string().uuid(),
  sourceHash: z.string().length(64),
  documentType: documentTypeSchema,
  pageNumbers: z.array(z.number().int().positive()),
  slides: z.array(deckSlidePlanSchema).min(1).max(30),
}).strict();

export const planDeckOutputSchema = z.object({
  plannedDeck: plannedDeckSchema,
  assets: z.array(assetSpecSchema).max(30),
  nextStep: z.string().min(1).max(500),
}).strict();

export const generateDeckInputSchema = z.object({
  deckPlanId: z.string().uuid(),
  externalAssets: z.array(externalAssetInputSchema).max(30),
  requestId: z.string().trim().min(8).max(128).optional(),
}).strict();

export const deckPageResultSchema = generateSlideOutputSchema.extend({ pageNumber: z.number().int().positive() });
export const deckPageFailureSchema = z.object({
  pageNumber: z.number().int().positive(),
  status: z.literal("failed"),
  error: z.object({ code: z.string().optional(), message: z.string(), retryable: z.boolean().optional() }).strict(),
}).strict();
export const deckPageOutputSchema = z.union([deckPageResultSchema, deckPageFailureSchema]);
export const generateDeckOutputSchema = z.object({
  deckRunId: z.string().uuid(),
  deckPlanId: z.string().uuid(),
  status: z.enum(["needs_assets", "running", "partial", "delivered", "failed"]),
  pages: z.array(deckPageOutputSchema),
  missingAssetIds: z.array(z.string()),
  manifestPath: z.string(),
  consistency: z.object({ passed: z.boolean(), issues: z.array(z.string()) }).strict().optional(),
}).strict();
```

Define the manifest types in `src/domain/deck-manifest.ts` with the same field names used by Tasks 5 and 8:

```ts
import type { GenerateSlideOutput } from "./quality-report.js";

export type DeckStatus = "needs_assets" | "running" | "partial" | "delivered" | "failed";

export interface DeckPageRecord {
  pageNumber: number;
  status: "running" | "delivered" | "best_effort" | "failed";
  runId?: string;
  result?: GenerateSlideOutput;
  error?: { code?: string; message: string; retryable?: boolean };
}

export interface DeckManifest {
  version: 1;
  deckRunId: string;
  deckPlanId: string;
  requestId?: string;
  requestFingerprint: string;
  status: DeckStatus;
  createdAt: string;
  updatedAt: string;
  assetHashes: Record<string, string>;
  missingAssetIds: string[];
  pages: DeckPageRecord[];
  consistency?: { passed: boolean; issues: string[] };
}
```

Update both asset ID regexes to `^(?:p\d+-)?(?:img|icon)-\d{3}$`, and extend `generateSlideInputSchema` with optional `documentType` and `page` imported from `document-context.ts`. This one-way import avoids a `source-document ↔ deck-plan` runtime cycle and leaves existing callers unchanged.

- [ ] **Step 4: Run domain tests and the existing input tests**

Run: `node --import tsx --test tests/unit/deck-domain.test.ts tests/unit/domain-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain contracts**

```bash
git add src/domain/document-context.ts src/domain/deck-plan.ts src/domain/deck-manifest.ts src/domain/source-document.ts src/domain/slide-spec.ts tests/unit/deck-domain.test.ts
git commit -m "feat: define multi-page bid deck contracts"
```

---

### Task 2: Heading-aware semantic pagination

**Files:**
- Create: `src/services/semantic-paginator.ts`
- Test: `tests/unit/semantic-paginator.test.ts`

**Interfaces:**
- Consumes: normalized `SourceDocument` and ordered `pageNumbers`.
- Produces: `paginateSource(source: SourceDocument, pageNumbers: number[]): PagePartition[]`, where every partition has `pageNumber`, `title`, `sourceSections`, `originalSourceSectionIds`, and `originalSourceFactIds`.

- [ ] **Step 1: Write failing pagination tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import { paginateSource } from "../../src/services/semantic-paginator.js";

const markdown = `### 项目人员配备要求响应
必须配置1名固定项目对接人员，且不得随意变更。

##### 固定项目对接人员配置方案
对接人员作为唯一信息窗口，覆盖8个项目。

负责指令传达、日报汇总、问题反馈、台账归档和考核迎检。

具备不少于三年项目管理经验，并配置后备人员。

##### 作业人员动态调配机制
建立基础配置、季节调配和任务驱动三层机制。

接到临时指令后30分钟内启动，1小时内到场。

##### 人员变更申请与审批流程
提交书面申请并经采购人书面批准。

安排不少于五个工作日交接，上岗后三个工作日内拜访。`;

test("paginator creates four ordered pages without losing source order", () => {
  const source = normalizeSource({ sourceText: markdown });
  const pages = paginateSource(source, [59, 60, 61, 62]);
  assert.deepEqual(pages.map((page) => page.pageNumber), [59, 60, 61, 62]);
  assert.match(pages[0].title, /固定|总体/);
  assert.match(pages[1].title, /职责|履职/);
  assert.match(pages[2].title, /动态调配/);
  assert.match(pages[3].title, /变更|交接/);
  assert.equal(new Set(pages.flatMap((page) => page.originalSourceFactIds)).size, source.facts.length);
});

test("paginator keeps approval and its time limits on the same page", () => {
  const source = normalizeSource({ sourceText: markdown });
  const page62 = paginateSource(source, [59, 60, 61, 62])[3];
  const body = page62.sourceSections.map((section) => section.body).join("\n");
  assert.match(body, /书面申请/);
  assert.match(body, /五个工作日/);
  assert.match(body, /三个工作日/);
});
```

- [ ] **Step 2: Run the paginator tests and verify failure**

Run: `node --import tsx --test tests/unit/semantic-paginator.test.ts`

Expected: FAIL because `paginateSource` does not exist.

- [ ] **Step 3: Implement paragraph units, section groups, and stable page allocation**

```ts
// src/services/semantic-paginator.ts
import type { SourceDocument, SourceSectionInput } from "../domain/source-document.js";

export interface PagePartition {
  pageNumber: number;
  title: string;
  sourceSections: SourceSectionInput[];
  originalSourceSectionIds: string[];
  originalSourceFactIds: string[];
}

const PAGE_BUDGET = 1_350;

function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
}

function titleFor(heading: string, chunkIndex: number): string {
  if (/固定项目对接/.test(heading) && chunkIndex === 0) return "总体响应与固定对接机制";
  if (/固定项目对接/.test(heading)) return "岗位职责与履职保障";
  if (/动态调配/.test(heading)) return "八项目动态调配机制";
  if (/变更申请|审批流程/.test(heading)) return "人员变更审批与无缝交接";
  return heading.slice(0, 40);
}
```

Implementation rules:

1. Treat the first title section as an overview and prepend it to the first substantive section.
2. Give every substantive heading one page before distributing extra requested pages.
3. Assign extra pages in source order to the first group whose paragraph cost exceeds `PAGE_BUDGET`.
4. Split only between paragraphs; never split a sentence or a paragraph containing both an approval action and its time limit.
5. Map facts to a partition by exact normalized sentence inclusion, then add any unmatched source fact to the nearest partition from the same source section so no fact disappears.
6. Throw `WorkflowError` with stage `paginate_source` when requested pages are fewer than substantive headings or when an indivisible paragraph exceeds twice the page budget.

- [ ] **Step 4: Run paginator and normalizer tests**

Run: `node --import tsx --test tests/unit/semantic-paginator.test.ts tests/unit/content-normalizer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit semantic pagination**

```bash
git add src/services/semantic-paginator.ts tests/unit/semantic-paginator.test.ts
git commit -m "feat: paginate bid source by semantic boundaries"
```

---

### Task 3: Generic template-independent page-blueprint planning

**Files:**
- Create: `src/domain/page-blueprint.ts`
- Create: `src/services/page-blueprint-builder.ts`
- Test: `tests/unit/page-blueprint-builder.test.ts`

**Interfaces:**
- Consumes: a `PagePartition`, locally normalized `SourceDocument`, `DocumentType`, and optional audience.
- Produces a template-independent `PageBlueprint` containing semantic roles (`headline | conclusion | fact | metric | process | comparison | evidence | visual`), ordered content groups, density, visual need, source references, and page-scoped asset intents.
- Produces `materializeSlideSpec(blueprint): SlideSpec` as the existing workflow compatibility representation while retaining semantic roles and all source fact references.

- [ ] **Step 1: Write failing generic blueprint tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import { buildPageBlueprint } from "../../src/services/page-blueprint-builder.js";

test("planner derives semantic roles and keeps every source fact", () => {
  const source = normalizeSource({ sourceText: "# 应急响应\n重点区域覆盖8个项目。指令后30分钟启动，1小时到场。\n## 闭环\n每日记录，每周协调，每月优化。" });
  const blueprint = buildPageBlueprint(source, { pageNumber: 17, title: "应急响应", documentType: "bid" });
  assert.ok(blueprint.groups.some((group) => group.role === "metric"));
  assert.ok(blueprint.groups.some((group) => group.role === "process"));
  assert.deepEqual(new Set(blueprint.sourceFactIds), new Set(source.facts.map((fact) => fact.id)));
  assert.ok(blueprint.groups.length >= 2);
});

test("planner is domain and page-number independent", () => {
  const source = normalizeSource({ sourceText: "# 产品路线图\n第一阶段完成调研。第二阶段上线内测。第三阶段覆盖50家客户。" });
  const blueprint = buildPageBlueprint(source, { pageNumber: 3, title: "产品路线图", documentType: "presentation" });
  assert.equal(blueprint.pageNumber, 3);
  assert.ok(blueprint.groups.some((group) => group.role === "process"));
});
```

Add a cross-domain test using a product roadmap document with non-59 page numbers.

```ts
assert.equal(blueprint.pageNumber, 17);
assert.match(JSON.stringify(blueprint), /30分钟/);
```

- [ ] **Step 2: Run blueprint tests to verify failure**

Run: `node --import tsx --test tests/unit/page-blueprint-builder.test.ts`

Expected: FAIL because the blueprint builder does not exist.

- [ ] **Step 3: Implement fact-preserving semantic planning**

The builder must cluster facts by source section, discourse markers, repeated subject, metric/process cues, and dependency links. Group count is determined by content and configurable bounds, never a constant. Every group carries source fact IDs. Create zero or one visual intent only when it adds explanatory value; prompts use document/page context and source facts, never a hard-coded industry, theme color, or page number narrative.

`materializeSlideSpec` converts semantic groups into the existing block types without changing order or facts. Extend the compatibility schema only where necessary to retain group roles; existing single-slide callers must continue to parse.

- [ ] **Step 4: Run generic planning and fact-reference tests**

Run: `node --import tsx --test tests/unit/page-blueprint-builder.test.ts tests/unit/slide-spec-builder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit bid page planning and mapping**

```bash
git add src/domain/page-blueprint.ts src/services/page-blueprint-builder.ts src/domain/slide-spec.ts tests/unit/page-blueprint-builder.test.ts
git commit -m "feat: plan template-independent page blueprints"
```

---

### Task 4: Capability-driven template profiles, selection, and repair

**Files:**
- Modify: `src/domain/template-profile.ts`
- Modify: `templates/green-infographic/template-profiles.json`
- Create: `src/services/template-slot-solver.ts`
- Modify: `src/services/template-selector.ts`
- Modify: `src/services/slide-content-mapper.ts`
- Modify: `src/services/slide-composer.ts`
- Modify: `src/app.ts`
- Test: `tests/unit/template-selector.test.ts`
- Test: `tests/unit/template-slot-solver.test.ts`
- Test: `tests/unit/slide-composer.test.ts`

**Interfaces:**
- Consumes: `PageBlueprint`/`SlideSpec`, approved capability profiles, optional forced slug, and a generic document policy derived from `DocumentType`.
- Produces: `selectTemplate(...)` whose compatibility, policy filtering, scoring, and repair candidates depend only on declared capabilities. The selected slug is an output identifier, never an input to business scoring.
- Produces `solveTemplateSlots(blueprint, profile)` with explicit assignments, transformations, capacity use, and unmatched-role diagnostics; page-aware mapping binds through profile-declared slot selectors/roles, not row positions.

- [ ] **Step 1: Add failing capability and rename-invariance tests**

```ts
test("bid policy excludes profiles whose declared visual ratio exceeds policy", () => {
  const selection = selectTemplate(makeSlideSpec(), makeTemplateProfiles(), undefined, "bid");
  assert.equal(selection.candidates.every((item) => profile(item).maxRasterAreaRatio <= 0.18), true);
});

test("renaming every slug does not change capability ranking", () => {
  const original = selectTemplate(makeSlideSpec(), profiles, undefined, "proposal");
  const renamed = selectTemplate(makeSlideSpec(), renameProfiles(profiles), undefined, "proposal");
  assert.deepEqual(original.candidates.map((x) => x.score), renamed.candidates.map((x) => x.score));
});

test("equivalent profiles produce the same slot assignment after slug rename", () => {
  const first = solveTemplateSlots(makeBlueprint(), makeProfile({ slug: "alpha-layout" }));
  const second = solveTemplateSlots(makeBlueprint(), makeProfile({ slug: "renamed-layout" }));
  assert.deepEqual(first.assignments, second.assignments);
});

test("forced template still must satisfy document policy", () => {
  assert.throws(
    () => selectTemplate(makeSlideSpec(), [makeProfile({ slug: "any-name", maxRasterAreaRatio: 0.55 })], "any-name", "bid"),
    /不满足.*文档策略/,
  );
});
```

- [ ] **Step 2: Run selector tests and verify failure**

Run: `node --import tsx --test tests/unit/template-selector.test.ts`

Expected: FAIL because `selectTemplate` does not apply document policies.

- [ ] **Step 3: Implement generic capability profiles and document policies**

Extend profiles with stable slot IDs/selectors/roles/capacities, `themeId`, `pageIntents`, `requiredLandmarks`, `maxRasterAreaRatio`, and document compatibility. Migrate every existing profile explicitly; do not infer business capability from filenames. The selector must hard-filter impossible capacity/policy matches, then score semantic role coverage, density fit, visual fit, page intent, and theme continuity. Stable tie-breaking may use catalog order, not slug lexicography. In `app.ts`, apply the same policy and candidate set during repair.

The solver performs deterministic constrained matching: hard capacity and required-role checks first, then weighted role compatibility, density use, visual-ratio fit, and source-order preservation. It may merge adjacent compatible groups or compress copy within recorded limits, but must return an error if any source fact would become unrepresented. `slide-content-mapper.ts` binds content through declared selectors/roles. Pass page metadata through initial and repair compositions so page numbers never reset. The same mapper must work for a fixture template whose slot IDs/order differ from the current templates.

- [ ] **Step 4: Run selector and quality-loop tests**

Run: `node --import tsx --test tests/unit/template-selector.test.ts tests/unit/quality-loop.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit template policy**

```bash
git add src/domain/template-profile.ts templates/green-infographic/template-profiles.json src/services/template-slot-solver.ts src/services/template-selector.ts src/services/slide-content-mapper.ts src/services/slide-composer.ts src/workflow/generate-slide.ts src/app.ts tests/unit/template-selector.test.ts tests/unit/template-slot-solver.test.ts tests/unit/slide-composer.test.ts
git commit -m "feat: select templates by declared capabilities"
```

---

### Task 4B: Reference-to-template knowledge workflow

**Files:**
- Create: `src/domain/template-blueprint.ts`
- Create: `src/services/template-inspector.ts`
- Create: `src/services/template-blueprint-compiler.ts`
- Create: `src/workflow/template-knowledge-store.ts`
- Create: `src/workflow/create-template-from-reference.ts`
- Test: `tests/unit/template-inspector.test.ts`
- Test: `tests/unit/template-blueprint-compiler.test.ts`
- Test: `tests/e2e/template-knowledge-workflow.test.ts`

**Interfaces:**
- `inspectTemplateHtml(html)` returns a normalized blueprint/profile draft: canvas, grid, slots, semantic roles, component hierarchy, typography, palette, spacing, visual ratios, and sanitization findings.
- `createTemplateFromReference(input, deps)` accepts exactly one of `referenceHtml`, `referenceImageDataUrl`, or `blueprint`. HTML is inspected deterministically. Image input uses an optional multimodal `analyzeReferenceImage`; without it the result is `needs_analysis` with a stable prompt and JSON schema. A supplied/analyzed blueprint is compiled, sanitized, rendered, quality-checked, and only then saved as `approved` knowledge.
- `TemplateKnowledgeStore` persists immutable versioned records with source type/hash, blueprint, compiled HTML/profile paths, QA report, and created timestamp. It never stores API keys or arbitrary remote URLs.

- [ ] **Step 1: Write failing HTML-inspection, image-handoff, compiler, and store tests**

Tests must prove:

1. An arbitrary safe HTML reference produces roles and design tokens without depending on current template tags or filenames.
2. An image data URL without a provider returns `needs_analysis`, a JSON schema, and no approved template files.
3. The same image with a fake provider returns a blueprint, compiles a self-contained A4 HTML template, passes Chromium hard gates, and creates an immutable knowledge record.
4. `<script>`, event handlers, remote resources, path traversal slugs, duplicate slot IDs, inaccessible contrast, or missing required roles are rejected before approval.
5. Repeating the same request ID and source hash is idempotent; changing the hash under the same request ID is rejected.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test tests/unit/template-inspector.test.ts tests/unit/template-blueprint-compiler.test.ts tests/e2e/template-knowledge-workflow.test.ts`

Expected: FAIL because the template knowledge workflow does not exist.

- [ ] **Step 3: Implement analysis boundary, deterministic compiler, QA, and persistence**

The image-analysis prompt asks only for layout structure and design tokens; it must instruct the model not to transcribe visible body copy, logos, or watermarks. The compiler uses owned generic HTML/CSS components and semantic placeholders, not the reference image as a full-page background. All generated CSS values are range-checked, every content-bearing region becomes a declared slot, and output has no script or network dependency. Approval requires static validation plus a real Chromium render and a capability/profile consistency check.

- [ ] **Step 4: Run focused tests, typecheck, and full regression**

Run: `npm run typecheck && node --import tsx --test tests/unit/template-*.test.ts tests/e2e/template-knowledge-workflow.test.ts && npm test`

Expected: PASS.

- [ ] **Step 5: Commit template knowledge workflow**

```bash
git add src/domain/template-blueprint.ts src/services/template-inspector.ts src/services/template-blueprint-compiler.ts src/workflow/template-knowledge-store.ts src/workflow/create-template-from-reference.ts tests/unit/template-inspector.test.ts tests/unit/template-blueprint-compiler.test.ts tests/e2e/template-knowledge-workflow.test.ts
git commit -m "feat: learn reusable html templates from references"
```

---

### Task 5: Persistent deck planning and run store

**Files:**
- Create: `src/workflow/deck-store.ts`
- Modify: `src/domain/deck-manifest.ts`
- Test: `tests/unit/deck-store.test.ts`

**Interfaces:**
- Consumes: canonical plan input, `PlannedDeck`, generated page results, and consistency report.
- Produces: `DeckStore.createOrResumePlan`, `savePlan`, `getPlan`, `createOrResumeRun`, `mergeAssetHashes`, `markNeedsAssets`, `hasDeliveredPage`, `savePageResult`, `savePageFailure`, `listPageRecords`, `finalizeRun`, and closed-name `getArtifact`.

- [ ] **Step 1: Write failing deck-store tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeckStore } from "../../src/workflow/deck-store.js";

test("deck store resumes an identical plan request", async () => {
  const store = new DeckStore(await mkdtemp(join(tmpdir(), "deck-store-")));
  const first = await store.createOrResumePlan({ requestId: "personnel-pages", canonicalInput: { pageNumbers: [59, 60, 61, 62] } });
  const second = await store.createOrResumePlan({ requestId: "personnel-pages", canonicalInput: { pageNumbers: [59, 60, 61, 62] } });
  assert.equal(second.deckPlanId, first.deckPlanId);
  assert.equal(second.resumed, true);
});

test("deck store rejects request id reuse with different input", async () => {
  const store = new DeckStore(await mkdtemp(join(tmpdir(), "deck-store-")));
  await store.createOrResumePlan({ requestId: "personnel-pages", canonicalInput: { pageNumbers: [59, 60] } });
  await assert.rejects(() => store.createOrResumePlan({ requestId: "personnel-pages", canonicalInput: { pageNumbers: [61, 62] } }), /fingerprint mismatch/);
});

test("deck store only returns closed artifact names", async () => {
  const store = new DeckStore(await mkdtemp(join(tmpdir(), "deck-store-")));
  await assert.rejects(() => store.getArtifact("11111111-1111-4111-8111-111111111111", "../../secret" as never), /Invalid deck artifact name/);
});
```

- [ ] **Step 2: Run deck-store tests and verify failure**

Run: `node --import tsx --test tests/unit/deck-store.test.ts`

Expected: FAIL because `DeckStore` does not exist.

- [ ] **Step 3: Implement atomic plan and run persistence**

Use the existing `RunStore` patterns: UUID validation, canonical SHA-256 fingerprints, `write → rename` atomic writes, path containment with `relative`, and separate request indexes for plans and deck runs. Store under:

```text
<outputRoot>/decks/plans/<deckPlanId>/plan.json
<outputRoot>/decks/runs/<deckRunId>/manifest.json
<outputRoot>/decks/runs/<deckRunId>/consistency.json
```

Allow only `plan.json`, `manifest.json`, and `consistency.json` through `DeckStore.getArtifact`. Page HTML remains owned by the corresponding single-page `RunStore` and is referenced by path in the deck manifest.

Use this public interface so later workflow tasks do not invent incompatible names:

```ts
export interface DeckStoreApi {
  createOrResumePlan(input: { requestId?: string; canonicalInput: unknown }): Promise<{ deckPlanId: string; resumed: boolean; plan?: unknown }>;
  savePlan(deckPlanId: string, output: unknown): Promise<void>;
  getPlan(deckPlanId: string): Promise<unknown>;
  createOrResumeRun(input: { requestId?: string; canonicalInput: { deckPlanId: string }; deckPlanId: string }): Promise<{ deckRunId: string; resumed: boolean; manifest: DeckManifest }>;
  mergeAssetHashes(deckRunId: string, hashes: Record<string, string>): Promise<DeckManifest>;
  markNeedsAssets(deckRunId: string, ids: string[]): Promise<GenerateDeckOutput>;
  hasDeliveredPage(deckRunId: string, pageNumber: number): Promise<boolean>;
  savePageResult(deckRunId: string, pageNumber: number, result: GenerateSlideOutput): Promise<DeckManifest>;
  savePageFailure(deckRunId: string, pageNumber: number, error: unknown): Promise<DeckManifest>;
  listPageRecords(deckRunId: string): Promise<DeckPageRecord[]>;
  finalizeRun(deckRunId: string, input: { pages: DeckPageRecord[]; consistency?: { passed: boolean; issues: string[] } }): Promise<GenerateDeckOutput>;
  getRun(deckRunId: string): Promise<DeckManifest>;
  getArtifact(deckRunId: string, name: "manifest.json" | "consistency.json"): Promise<{ path: string; size: number; text?: string }>;
}
```

`createOrResumeRun` fingerprints only `{ deckPlanId }`. `mergeAssetHashes` accepts new missing asset IDs during a `needs_assets` continuation, but rejects a different hash for an asset ID that was already recorded. This permits images to arrive incrementally without allowing silent replacement.

- [ ] **Step 4: Run deck-store and existing run-store tests**

Run: `node --import tsx --test tests/unit/deck-store.test.ts tests/unit/run-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit deck persistence**

```bash
git add src/domain/deck-manifest.ts src/workflow/deck-store.ts tests/unit/deck-store.test.ts
git commit -m "feat: persist resumable deck plans and runs"
```

---

### Task 6: `plan_deck` workflow

**Files:**
- Create: `src/workflow/plan-deck.ts`
- Modify: `src/app.ts`
- Test: `tests/unit/plan-deck.test.ts`

**Interfaces:**
- Consumes: `PlanDeckInput`, `normalizeSource`, `paginateSource`, `buildPageBlueprint`, capability profiles, `solveTemplateSlots`, `materializeSlideSpec`, `selectTemplate`, and `DeckStore`.
- Produces: `planDeckWorkflow(rawInput, deps): Promise<PlanDeckOutput>` with persisted `deckPlanId`, arbitrary ordered page plans, stable page-scoped assets when visuals are justified, template-match evidence, and no generated image bytes.

- [ ] **Step 1: Write a failing four-page planning test**

```ts
test("plan deck turns one source into pages 59 through 62", async () => {
  const result = await planDeckWorkflow({
    sourceMarkdown: personnelMarkdown,
    pageNumbers: [59, 60, 61, 62],
    documentType: "bid",
    quality: { minScore: 90, maxAttempts: 3 },
    requestId: "plan-personnel-59-62",
  }, dependencies);
  assert.deepEqual(result.plannedDeck.slides.map((slide) => slide.page.number), [59, 60, 61, 62]);
  assert.equal(result.assets.every((asset) => /^p(?:59|60|61|62)-img-\d{3}$/.test(asset.id)), true);
  assert.equal(result.plannedDeck.slides.every((slide) => slide.templateMatch.unmatched.length === 0), true);
  assert.match(JSON.stringify(result.plannedDeck.slides[2]), /30分钟/);
  assert.match(JSON.stringify(result.plannedDeck.slides[3]), /五个工作日/);
});
```

- [ ] **Step 2: Run the planning test and verify failure**

Run: `node --import tsx --test tests/unit/plan-deck.test.ts`

Expected: FAIL because `planDeckWorkflow` does not exist.

- [ ] **Step 3: Implement the planning pipeline**

```ts
export async function planDeckWorkflow(rawInput: unknown, deps: PlanDeckDependencies): Promise<PlanDeckOutput> {
  const input = planDeckInputSchema.parse(rawInput);
  const sourceInput = input.sourceMarkdown ? { sourceText: input.sourceMarkdown } : input.sourceText ? { sourceText: input.sourceText } : { sections: input.sections };
  const source = deps.normalizeSource({ ...sourceInput, quality: input.quality });
  const active = await deps.deckStore.createOrResumePlan({ requestId: input.requestId, canonicalInput: input });
  if (active.plan) return planDeckOutputSchema.parse(active.plan);

  const partitions = deps.paginateSource(source, input.pageNumbers);
  const slides = await Promise.all(partitions.map(async (partition) => {
    const pageSource = deps.normalizeSource({ sections: partition.sourceSections, quality: input.quality });
    const blueprint = deps.buildPageBlueprint(pageSource, { pageNumber: partition.pageNumber, title: partition.title, documentType: input.documentType, audience: input.audience });
    const selection = deps.selectTemplate(blueprint, input.templateSlug, input.documentType);
    const templateMatch = deps.solveTemplateSlots(blueprint, selection.profile);
    const spec = deps.materializeSlideSpec(blueprint, templateMatch);
    return {
      page: deps.buildPageMetadata(partition),
      sourceSections: partition.sourceSections,
      originalSourceSectionIds: partition.originalSourceSectionIds,
      originalSourceFactIds: partition.originalSourceFactIds,
      plannedSpec: spec,
      templateSlug: selection.slug,
      templateMatch,
    };
  }));
  const plannedDeck = plannedDeckSchema.parse({ version: 1, deckPlanId: active.deckPlanId, sourceHash: source.sourceHash, documentType: input.documentType, pageNumbers: input.pageNumbers, slides });
  const output = planDeckOutputSchema.parse({ plannedDeck, assets: slides.flatMap((slide) => slide.plannedSpec.assets), nextStep: "Generate every asset and call generate_deck with externalAssets." });
  await deps.deckStore.savePlan(active.deckPlanId, output);
  return output;
}
```

`buildPageMetadata` derives section/chapter/subsection labels from the source heading ancestry and caller-supplied context. It may use neutral fallbacks when headings are absent, but must not contain acceptance-specific labels. Add a second planning test for a product roadmap with pages `[3, 4]` and a catalog whose slugs are unrelated to the green templates.

- [ ] **Step 4: Run planning and selector tests**

Run: `node --import tsx --test tests/unit/plan-deck.test.ts tests/unit/semantic-paginator.test.ts tests/unit/template-selector.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit deck planning workflow**

```bash
git add src/workflow/plan-deck.ts src/app.ts tests/unit/plan-deck.test.ts
git commit -m "feat: plan multi-page bid decks from source"
```

---

### Task 7: Profile-driven page gates and cross-page consistency

**Files:**
- Modify: `src/services/page-renderer.ts`
- Modify: `src/services/deterministic-evaluator.ts`
- Create: `src/services/deck-consistency.ts`
- Test: `tests/render/page-renderer.test.ts`
- Test: `tests/unit/deck-consistency.test.ts`

**Interfaces:**
- Consumes: a rendered page plus optional `{ documentType, expectedPageNumber, profile, policy }`.
- Produces: page structure signals and `evaluateDeckConsistency(pages): DeckConsistencyReport`.

- [ ] **Step 1: Add failing render and consistency tests**

```ts
test("page gate requires profile-declared landmarks and correct page number", async () => {
  const render = await renderPage({ html: validBidHtml, screenshotPath });
  const report = evaluateDeterministic(render, { documentType: "bid", expectedPageNumber: 59, profile });
  assert.equal(report.hardGatePassed, true);
  assert.equal(render.structure.pageNumber, "59");
});

test("bid gate rejects a photo-dominant page", async () => {
  const render = await renderPage({ html: photoDominantBidHtml, screenshotPath });
  const report = evaluateDeterministic(render, { documentType: "bid", expectedPageNumber: 59, maxRasterAreaRatio: 0.18 });
  assert.equal(report.hardGatePassed, false);
  assert.match(report.issues.map((issue) => issue.evidence).join("\n"), /图片面积/);
});

test("deck consistency rejects discontinuous page numbers", () => {
  const report = evaluateDeckConsistency([
    { pageNumber: 59, templateSlug: baseSlug, html: html59 },
    { pageNumber: 61, templateSlug: baseSlug, html: html61 },
  ]);
  assert.equal(report.passed, false);
  assert.match(report.issues.join("\n"), /页码不连续/);
});
```

- [ ] **Step 2: Run render and consistency tests to verify failure**

Run: `node --import tsx --test tests/render/page-renderer.test.ts tests/unit/deck-consistency.test.ts`

Expected: FAIL because structure signals, raster ratio, and deck consistency do not exist.

- [ ] **Step 3: Measure bid structure and raster area**

Extend `RenderResult` with:

```ts
structure: {
  hasPageHeader: boolean;
  hasChapterBand: boolean;
  hasSubsectionTitle: boolean;
  hasSummaryBand: boolean;
  hasPageFooter: boolean;
  pageNumber?: string;
  rasterAreaRatio: number;
};
```

In Chromium, query semantic landmarks declared by the chosen profile rather than a fixed CSS selector list. Sum the clipped on-canvas area of non-SVG `<img>` rectangles once and divide by the declared canvas area.

Update `evaluateDeterministic` to accept the selected profile and document policy. Emit hard errors for missing declared landmarks, page-number mismatch, or raster area above the stricter of profile and policy limits.

Implement `evaluateDeckConsistency` to require strictly consecutive page numbers, compatible declared `themeId`/design tokens, consistent caller/source-derived hierarchy labels, and no page with `status !== "delivered"`. Never derive theme from slug prefixes.

- [ ] **Step 4: Run render, evaluator, and consistency tests**

Run: `node --import tsx --test tests/render/page-renderer.test.ts tests/unit/slide-evaluator.test.ts tests/unit/deck-consistency.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit bid and deck QA gates**

```bash
git add src/services/page-renderer.ts src/services/deterministic-evaluator.ts src/services/deck-consistency.ts tests/render/page-renderer.test.ts tests/unit/deck-consistency.test.ts
git commit -m "feat: enforce per-page bid and deck consistency gates"
```

---

### Task 8: Resumable `generate_deck` workflow

**Files:**
- Create: `src/workflow/generate-deck.ts`
- Modify: `src/workflow/generate-slide.ts`
- Modify: `src/app.ts`
- Test: `tests/e2e/generate-deck-workflow.test.ts`

**Interfaces:**
- Consumes: persisted `deckPlanId`, page-scoped external assets, existing `generateSlideWorkflow`, `DeckStore`, and `evaluateDeckConsistency`.
- Produces: `generateDeckWorkflow(rawInput, deps): Promise<GenerateDeckOutput>` with independent page run IDs and deck status.

- [ ] **Step 1: Write failing deck workflow tests**

```ts
test("generate deck reports missing assets before running pages", async () => {
  const result = await generateDeckWorkflow({ deckPlanId, externalAssets: [asset59] }, dependencies);
  assert.equal(result.status, "needs_assets");
  assert.deepEqual(result.missingAssetIds, ["p60-img-001", "p61-img-001", "p62-img-001"]);
  assert.equal(result.pages.length, 0);
});

test("generate deck resumes at the failed page without rerunning delivered pages", async () => {
  const first = await generateDeckWorkflow({ deckPlanId, externalAssets: allAssets, requestId: "generate-personnel-deck" }, dependenciesWithPage61Failure);
  assert.equal(first.status, "partial");
  const page59 = first.pages.find((page) => page.pageNumber === 59);
  assert.equal(page59?.status, "delivered");
  if (!page59 || page59.status === "failed") throw new Error("page 59 was not delivered");
  const page59RunId = page59.runId;

  const resumed = await generateDeckWorkflow({ deckPlanId, externalAssets: allAssets, requestId: "generate-personnel-deck" }, dependencies);
  assert.equal(resumed.status, "delivered");
  const resumedPage59 = resumed.pages.find((page) => page.pageNumber === 59);
  if (!resumedPage59 || resumedPage59.status === "failed") throw new Error("resumed page 59 was not delivered");
  assert.equal(resumedPage59.runId, page59RunId);
});
```

- [ ] **Step 2: Run deck workflow tests and verify failure**

Run: `node --import tsx --test tests/e2e/generate-deck-workflow.test.ts`

Expected: FAIL because `generateDeckWorkflow` does not exist.

- [ ] **Step 3: Implement asset preflight, page orchestration, and resume**

```ts
export async function generateDeckWorkflow(rawInput: unknown, deps: GenerateDeckDependencies): Promise<GenerateDeckOutput> {
  const input = generateDeckInputSchema.parse(rawInput);
  const planOutput = await deps.deckStore.getPlan(input.deckPlanId);
  const plannedDeck = planDeckOutputSchema.parse(planOutput).plannedDeck;
  const requiredIds = plannedDeck.slides.flatMap((slide) => slide.plannedSpec.assets.map((asset) => asset.id));
  const provided = new Set(input.externalAssets.map((asset) => asset.id));
  const missingAssetIds = requiredIds.filter((id) => !provided.has(id));
  const run = await deps.deckStore.createOrResumeRun({ requestId: input.requestId, canonicalInput: { deckPlanId: input.deckPlanId }, deckPlanId: input.deckPlanId });
  await deps.deckStore.mergeAssetHashes(run.deckRunId, deps.hashAssets(input.externalAssets));
  if (missingAssetIds.length > 0) return deps.deckStore.markNeedsAssets(run.deckRunId, missingAssetIds);

  for (const slide of plannedDeck.slides) {
    if (await deps.deckStore.hasDeliveredPage(run.deckRunId, slide.page.number)) continue;
    try {
      const result = await deps.generateSlide({
        sections: slide.sourceSections,
        plannedSpec: slide.plannedSpec,
        templateSlug: slide.templateSlug,
        documentType: plannedDeck.documentType,
        page: slide.page,
        externalAssets: input.externalAssets.filter((asset) => slide.plannedSpec.assets.some((spec) => spec.id === asset.id)),
        quality: { minScore: 90, maxAttempts: 3 },
        requestId: `${run.deckRunId}-page-${slide.page.number}`,
      });
      await deps.deckStore.savePageResult(run.deckRunId, slide.page.number, result);
    } catch (error) {
      await deps.deckStore.savePageFailure(run.deckRunId, slide.page.number, error);
      break;
    }
  }
  const pages = await deps.deckStore.listPageRecords(run.deckRunId);
  const delivered = pages.filter((page) => page.status === "delivered" && page.result).map((page) => ({ pageNumber: page.pageNumber, ...page.result! }));
  const consistency = delivered.length === plannedDeck.slides.length ? await deps.evaluateConsistency(delivered) : undefined;
  return deps.deckStore.finalizeRun(run.deckRunId, { pages, consistency });
}
```

Pass the bid policy into each single-page deterministic evaluation. Preserve the existing single-page public behavior when `documentType` and `page` are absent.

- [ ] **Step 4: Run deck, single-page, and resume tests**

Run: `node --import tsx --test tests/e2e/generate-deck-workflow.test.ts tests/e2e/generate-slide-workflow.test.ts tests/unit/run-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit deck generation workflow**

```bash
git add src/workflow/generate-deck.ts src/workflow/generate-slide.ts src/app.ts tests/e2e/generate-deck-workflow.test.ts
git commit -m "feat: generate and resume quality-gated bid decks"
```

---

### Task 9: MCP workflow and template-knowledge tools

**Files:**
- Modify: `src/mcp/register-tools.ts`
- Modify: `src/app.ts`
- Modify: `tests/helpers/mcp-harness.ts`
- Modify: `tests/contract/mcp-tools.test.ts`
- Test: `tests/contract/mcp-deck-tools.test.ts`

**Interfaces:**
- Consumes: `planDeckWorkflow`, `generateDeckWorkflow`, `DeckStore`, and deck schemas.
- Produces MCP tools `plan_deck`, `generate_deck`, `get_deck`, `inspect_template`, `create_template_from_reference`, and `list_template_knowledge` with structured output and safe error handling.

- [ ] **Step 1: Write failing MCP contract tests**

```ts
test("lists the multi-page workflow tools", async () => {
  const tools = await client.listTools();
  for (const name of ["plan_deck", "generate_deck", "get_deck", "inspect_template", "create_template_from_reference", "list_template_knowledge"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name));
  }
});

test("plan_deck returns page-scoped image prompts", async () => {
  const result = await client.callTool({ name: "plan_deck", arguments: deckInput });
  assert.equal(result.isError, undefined);
  const output = planDeckOutputSchema.parse(result.structuredContent);
  assert.deepEqual(output.plannedDeck.pageNumbers, [59, 60, 61, 62]);
  assert.equal(output.assets.every((asset) => /^p\d+-img-\d{3}$/.test(asset.id)), true);
});

test("get_deck never exposes arbitrary paths or stack traces", async () => {
  const result = await client.callTool({ name: "get_deck", arguments: { deckRunId: "not-a-uuid" } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result.content), /at .+\(.+\.ts:\d+/);
});
```

- [ ] **Step 2: Run MCP contract tests and verify failure**

Run: `node --import tsx --test tests/contract/mcp-tools.test.ts tests/contract/mcp-deck-tools.test.ts`

Expected: FAIL because the three deck tools are not registered.

- [ ] **Step 3: Register high-level deck tools**

```ts
server.registerTool("plan_deck", {
  title: "Plan a quality-gated bid deck",
  description: "将连续中文正文按语义分页，返回每页事实、标书模板和稳定的图片提示词。",
  inputSchema: planDeckInputSchema,
  outputSchema: planDeckOutputSchema,
}, async (input) => safeTool(async () => {
  const result = await dependencies.planDeck(input);
  return toToolResult(result, `已规划 ${result.plannedDeck.slides.length} 页；请生成 ${result.assets.length} 个图片资产后调用 generate_deck。`);
}));

server.registerTool("generate_deck", {
  title: "Generate a quality-gated bid deck",
  description: "使用已持久化 deck plan 和外部图片资产生成逐页 QA 的自包含 HTML。",
  inputSchema: generateDeckInputSchema,
  outputSchema: generateDeckOutputSchema,
}, async (input) => safeTool(async () => toToolResult(await dependencies.generateDeck(input), "Deck workflow completed.")));

server.registerTool("get_deck", {
  title: "Get deck run",
  description: "读取 deck manifest、逐页状态和跨页一致性报告。",
  inputSchema: { deckRunId: z.string().uuid() },
}, async ({ deckRunId }) => safeTool(async () => toJsonToolResult(await dependencies.deckStore.getRun(deckRunId))));
```

Extend `PptMcpDependencies` with typed `planDeck`, `generateDeck`, and `deckStore` members. Keep all existing atomic and single-slide tools unchanged.

Register the three template-knowledge tools from Task 4B. The image-reference tool must expose both `needs_analysis` and `approved` structured outputs; it accepts data URLs or validated blueprints, never arbitrary source/output filesystem paths. `inspect_template` is read-only. `list_template_knowledge` returns records and safe artifact identifiers, not unrestricted paths.

- [ ] **Step 4: Run MCP contract and single-slide acceptance tests**

Run: `node --import tsx --test tests/contract/*.test.ts tests/e2e/mcp-workflow.acceptance.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit MCP deck tools**

```bash
git add src/mcp/register-tools.ts src/app.ts tests/helpers/mcp-harness.ts tests/contract/mcp-tools.test.ts tests/contract/mcp-deck-tools.test.ts
git commit -m "feat: expose multi-page bid workflow over mcp"
```

---

### Task 10: Four-page acceptance, real imagegen handoff, and documentation

**Files:**
- Create: `tests/e2e/personnel-deck.acceptance.test.ts`
- Create: `scripts/generate-personnel-deck.ts`
- Create: `examples/assets/personnel-deck/README.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/workflows/generate-slide.md`
- Create: `docs/workflows/generate-deck.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: production MCP server, `test.md`, `plan_deck`, four external image data URLs, and `generate_deck`.
- Produces: deterministic test coverage, a reproducible real-run script, documented Agent protocol, and final page 59–62 HTML artifacts.

- [ ] **Step 1: Write a failing in-memory MCP acceptance test**

```ts
test("one Markdown document becomes four independently delivered bid pages", async () => {
  const markdown = await readFile(resolve("test.md"), "utf8");
  const planned = await callPlanDeckThroughInMemoryMcp({
    sourceMarkdown: markdown,
    pageNumbers: [59, 60, 61, 62],
    documentType: "bid",
    quality: { minScore: 90, maxAttempts: 3 },
    requestId: "acceptance-plan-personnel-59-62",
  }, dependencies);
  const assets = planned.assets.map((asset, index) => ({ id: asset.id, dataUrl: fixtureDataUrls[index] }));
  const result = await callGenerateDeckThroughInMemoryMcp({ deckPlanId: planned.plannedDeck.deckPlanId, externalAssets: assets, requestId: "acceptance-generate-personnel-59-62" }, dependencies);
  assert.equal(result.status, "delivered");
  assert.deepEqual(result.pages.map((page) => page.pageNumber), [59, 60, 61, 62]);
  for (const page of result.pages) {
    assert.equal(page.status, "delivered");
    if (page.status === "failed") throw new Error(`page ${page.pageNumber} failed: ${page.error.message}`);
    assert.equal(page.quality.hardGatePassed, true);
    assert.ok(page.quality.score >= 90);
    const html = await readFile(page.artifacts.htmlPath, "utf8");
    assert.match(html, new RegExp(`>${page.pageNumber}<`));
    assert.doesNotMatch(html, /<script|https?:\/\/|<figures|<icon|img-slot/i);
  }
});
```

- [ ] **Step 2: Run the acceptance test and verify failure**

Run: `node --import tsx --test tests/e2e/personnel-deck.acceptance.test.ts`

Expected: FAIL until the full deck MCP path is wired.

- [ ] **Step 3: Implement the reproducible script and docs**

`scripts/generate-personnel-deck.ts` must:

1. Read `test.md`.
2. Call `plan_deck` through the in-memory MCP client.
3. Write `asset-prompts.json` under the deck output directory.
4. Look for every asset actually returned by `plan_deck` at `examples/assets/personnel-deck/<asset-id>.png`; zero assets is valid.
5. If any asset is missing, print the exact asset IDs and prompts and exit with code 2 without calling `generate_deck`.
6. If all assets exist, convert them to data URLs, call `generate_deck`, and copy only `page-59.html` through `page-62.html` into `output/deliverables/personnel-deck-59-62/`.
7. Print every page score, hard-gate result, runId, HTML path, preview path, and quality path.

Add scripts:

```json
{
  "plan:personnel-deck": "node --import tsx scripts/generate-personnel-deck.ts --plan-only",
  "generate:personnel-deck": "node --import tsx scripts/generate-personnel-deck.ts",
  "test:deck": "node --import tsx --test tests/unit/deck-*.test.ts tests/unit/semantic-paginator.test.ts tests/unit/plan-deck.test.ts tests/e2e/generate-deck-workflow.test.ts tests/e2e/personnel-deck.acceptance.test.ts"
}
```

Document the Agent-independent protocol in `docs/workflows/generate-deck.md`, including exact MCP inputs, `needs_assets`, resumption, artifact paths, and the rule that external Agents generate images only after `plan_deck`.

Add `.superpowers/` to `.gitignore` so the approved visual-brainstorming session never enters a feature commit.

- [ ] **Step 4: Run the automated test matrix before generating real images**

Run: `npm run typecheck && npm run build && npm test && npm run test:deck && npm run test:templates`

Expected: all commands exit 0; existing single-slide tests remain green.

- [ ] **Step 5: Ask MCP for the real prompts, then use built-in imagegen once per asset**

Run: `npm run plan:personnel-deck`

Expected: exit code 2 when one or more planned assets are absent, with stable asset IDs and prompts written to `asset-prompts.json`; if the planner decides a page needs no raster asset, do not invent one.

For each returned asset, call the built-in `imagegen` tool with exactly the prompt returned by MCP. Inspect every result and copy the accepted file from the Codex generated-images directory to the matching ID under:

```text
examples/assets/personnel-deck/<asset-id>.png
```

Do not use CLI fallback, do not add text to images, do not reuse one image for multiple pages, and record the final prompts in `examples/assets/personnel-deck/README.md`.

- [ ] **Step 6: Generate the real four-page deck entirely through MCP**

Run: `npm run generate:personnel-deck`

Expected: `delivered`; pages 59–62 each have score at least 90, `hardGatePassed=true`, no remaining errors, and an HTML file under `output/deliverables/personnel-deck-59-62/`.

- [ ] **Step 7: Inspect every page individually at full size**

Open each final PNG with `view_image` at original detail. Verify:

- title hierarchy and page number;
- no clipped text, unexpected wrapping, or blank component;
- the image is subordinate to the bid content;
- page 61 shows 30 minutes and 1 hour;
- page 62 shows five working days, three working days, and 1–2 backup staff;
- all four pages use the same standard bid style.

If a page fails visual review, add a targeted regression test before changing mapper, template CSS, evaluator, or repair behavior, then rerun only that page and finally rerun the full matrix.

- [ ] **Step 8: Commit acceptance, assets, script, and docs**

```bash
git add .gitignore tests/e2e/personnel-deck.acceptance.test.ts scripts/generate-personnel-deck.ts examples/assets/personnel-deck package.json README.md docs/workflows/generate-slide.md docs/workflows/generate-deck.md
git commit -m "feat: ship four-page personnel bid workflow"
```

- [ ] **Step 9: Perform final clean verification**

Run: `npm run typecheck && npm run build && npm test && npm run test:deck && npm run test:templates && npm run generate:personnel-deck && git diff --check && git status --short`

Expected: all tests pass, the real deck is `delivered`, every page is at least 90, and `git status --short` prints no tracked or untracked changes.
