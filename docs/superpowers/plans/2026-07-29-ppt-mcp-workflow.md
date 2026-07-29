# PPT Generator MCP Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready `generate_slide` MCP workflow that turns Chinese business source content into a self-contained, quality-gated, single-page A4 landscape HTML deliverable with real generated assets.

**Architecture:** Keep the existing atomic tools for compatibility, but move their logic behind focused domain services and provider interfaces. A new synchronous workflow creates a normalized source model, builds a `SlideSpec`, selects an approved template, generates assets, composes and renders HTML, evaluates quality, applies bounded repairs, and persists every attempt under a resumable `runId`.

**Tech Stack:** Node.js 22+, TypeScript 7, MCP SDK 1.29, Zod 4, OpenAI SDK 6, JSDOM 29, Playwright Chromium, Node built-in test runner.

## Global Constraints

- Final output is one self-contained A4 landscape HTML page; no `.pptx`, prompt page, or unresolved asset slot.
- The workflow accepts exactly one of `sourceText` or `sections` and normalizes both to `SourceDocument`.
- The first release supports Chinese business bids, technical proposals, and project reports only.
- Templates are selected only from the repository's approved, versioned template catalog.
- Text, image, and review providers use server-managed OpenAI-compatible profiles; MCP tool inputs never accept credentials.
- Default quality threshold is 85, allowed threshold range is 70–95, and maximum attempts are 1–3 with a default of 3.
- `delivered` requires every hard gate and the configured score threshold; `best_effort` requires a safe renderable page; otherwise return `failed`.
- Default automated tests must not use external network access or real API credentials.
- Existing MCP tool names and primary input contracts remain compatible.
- Implement every production change test-first and finish each task with the listed focused commit.

---

## File and Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Configuration | `src/config/env.ts`, `src/config/limits.ts` | Parse server-only provider profiles and operational limits without exposing secrets |
| Domain | `src/domain/source-document.ts`, `src/domain/slide-spec.ts`, `src/domain/template-profile.ts`, `src/domain/quality-report.ts`, `src/domain/workflow-error.ts`, `src/domain/run-manifest.ts` | Strict schemas and stable interfaces shared by services, workflow, and MCP handlers |
| Providers | `src/providers/contracts.ts`, `src/providers/openai-compatible.ts` | Text JSON generation, image generation, and multimodal review behind injectable interfaces |
| Source processing | `src/services/content-normalizer.ts`, `src/services/fact-extractor.ts` | Convert Markdown or sections to `SourceDocument` and preserve source facts |
| Content planning | `src/services/slide-spec-builder.ts` | Produce and validate a fact-linked `SlideSpec` |
| Templates | `templates/green-infographic/template-profiles.json`, `src/services/template-selector.ts`, `src/lib/template-parser.ts` | Load approved profiles and score content-to-template compatibility |
| Assets | `src/services/safe-download.ts`, `src/services/asset-generator.ts` | Generate, validate, cache, and persist images and local icons |
| Composition | `src/services/slide-content-mapper.ts`, `src/services/slide-composer.ts` | Map `SlideSpec` to existing placeholders and emit self-contained HTML |
| Rendering | `src/services/page-renderer.ts`, `src/services/deterministic-evaluator.ts` | Render fixed A4 screenshots and measure page geometry, loading, and overflow |
| Quality | `src/services/slide-evaluator.ts`, `src/services/repair-router.ts`, `src/services/repair-executor.ts`, `src/workflow/quality-loop.ts` | Weighted review, constrained repair actions, and bounded attempt selection |
| Persistence | `src/workflow/run-store.ts` | Safe run directories, atomic manifests, request fingerprints, and artifact access |
| Orchestration | `src/workflow/generate-slide.ts` | Execute the complete pipeline and persist stage transitions |
| MCP | `src/mcp/register-tools.ts`, `src/mcp/tool-result.ts`, `src/server.ts` | Register structured tools, map errors, and start stdio transport |
| Tests | `tests/unit`, `tests/contract`, `tests/render`, `tests/e2e`, `tests/helpers/domain-fixtures.ts`, `tests/helpers/workflow-fixtures.ts`, `tests/helpers/mcp-harness.ts` | Offline unit, MCP, renderer, provider, failure, and full workflow coverage |

---

### Task 1: Domain Schemas, Configuration, and Test Harness

**Files:**
- Create: `src/domain/source-document.ts`
- Create: `src/domain/slide-spec.ts`
- Create: `src/domain/template-profile.ts`
- Create: `src/domain/quality-report.ts`
- Create: `src/domain/workflow-error.ts`
- Create: `src/config/env.ts`
- Create: `src/config/limits.ts`
- Create: `tests/helpers/domain-fixtures.ts`
- Create: `tests/unit/domain-config.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `process.env` and plain MCP input values.
- Produces: `GenerateSlideInput`, `SourceDocument`, `SlideSpec`, `TemplateProfile`, `QualityReport`, `AppConfig`, `WorkflowError`, and `requireWorkflowConfig(config)`.

- [ ] **Step 1: Add the built-in test runner script and write failing schema/config tests**

```ts
// tests/unit/domain-config.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { generateSlideInputSchema } from "../../src/domain/source-document.js";
import { loadAppConfig, requireWorkflowConfig } from "../../src/config/env.js";

test("generate_slide accepts exactly one source input", () => {
  assert.equal(generateSlideInputSchema.safeParse({ sourceText: "# 项目\n正文内容足够长。" }).success, true);
  assert.equal(generateSlideInputSchema.safeParse({ sourceText: "正文", sections: [] }).success, false);
  assert.equal(generateSlideInputSchema.safeParse({ unknown: true }).success, false);
});

test("workflow config keeps provider secrets server-side", () => {
  const config = loadAppConfig({
    PPT_LLM_BASE_URL: "https://model.example/v1",
    PPT_LLM_API_KEY: "llm-secret",
    PPT_LLM_MODEL: "text-model",
    PPT_IMAGE_BASE_URL: "https://model.example/v1",
    PPT_IMAGE_API_KEY: "image-secret",
    PPT_IMAGE_MODEL: "image-model",
    PPT_IMAGE_ALLOWED_HOSTS: "cdn.example",
    PPT_REVIEW_BASE_URL: "https://model.example/v1",
    PPT_REVIEW_API_KEY: "review-secret",
    PPT_REVIEW_MODEL: "vision-model",
    PPT_OUTPUT_ROOT: "/tmp/ppt-runs"
  });
  assert.equal(requireWorkflowConfig(config).llm.model, "text-model");
  assert.equal(JSON.stringify(config).includes("llm-secret"), false);
});
```

Add this script before running the test:

```json
"test:unit": "node --import tsx --test tests/unit/*.test.ts"
```

- [ ] **Step 2: Run the test and verify the missing modules fail**

Run: `npm run test:unit`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/domain/source-document.js` or `src/config/env.js`.

- [ ] **Step 3: Add Zod as a direct dependency and implement the minimal strict schemas**

Run: `npm install zod@^4.4.3`

Use strict objects and explicit cross-field validation:

```ts
// src/domain/source-document.ts
import { createHash } from "node:crypto";
import * as z from "zod/v4";

export const sourceSectionInputSchema = z.object({
  heading: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
  keyPoints: z.array(z.string().trim().min(1).max(300)).max(20).optional()
}).strict();

export const generateSlideInputSchema = z.object({
  sourceText: z.string().trim().min(20).max(120_000).optional(),
  sections: z.array(sourceSectionInputSchema).min(1).max(50).optional(),
  templateSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  audience: z.string().trim().max(200).optional(),
  quality: z.object({
    minScore: z.number().int().min(70).max(95).default(85),
    maxAttempts: z.number().int().min(1).max(3).default(3)
  }).strict().default({ minScore: 85, maxAttempts: 3 }),
  requestId: z.string().trim().min(8).max(128).optional()
}).strict().superRefine((value, ctx) => {
  if (Number(Boolean(value.sourceText)) + Number(Boolean(value.sections)) !== 1) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of sourceText or sections" });
  }
});

export type GenerateSlideInput = z.infer<typeof generateSlideInputSchema>;
export const hashCanonical = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
```

Define the approved unions exactly once in the other domain files:

```ts
export type SlideBlockType = "text" | "image" | "table" | "process" | "metric";
export type QualityCategory = "fidelity" | "structure" | "readability" | "layout" | "asset" | "technical";
export type WorkflowStatus = "delivered" | "best_effort" | "failed";
```

Implement these strict shared schemas and infer their TypeScript types from Zod:

```ts
export const sourceFactSchema = z.object({
  id: z.string().regex(/^fact-\d+$/),
  text: z.string().trim().min(1).max(500),
  kind: z.enum(["number", "name", "requirement", "conclusion"]),
  sourceSectionId: z.string().regex(/^section-\d+$/)
}).strict();

export const slideBlockSchema = z.object({
  id: z.string().regex(/^block-\d+$/),
  type: z.enum(["text", "image", "table", "process", "metric"]),
  title: z.string().trim().min(2).max(30),
  body: z.string().trim().min(1).max(500),
  bullets: z.array(z.string().trim().min(1).max(80)).max(6),
  metrics: z.array(z.object({ label: z.string().max(20), value: z.string().max(30) }).strict()).max(6),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1)
}).strict();

export const assetSpecSchema = z.object({
  id: z.string().regex(/^(?:img|icon)-\d{3}$/),
  type: z.enum(["image", "icon"]),
  blockId: z.string().regex(/^block-\d+$/),
  prompt: z.string().trim().min(10).max(1200),
  alt: z.string().trim().min(2).max(120),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  width: z.literal(1792),
  height: z.literal(1024)
}).strict();

export const slideSpecSchema = z.object({
  title: z.string().trim().min(4).max(40),
  eyebrow: z.string().trim().max(40).optional(),
  conclusion: z.string().trim().min(4).max(160),
  blocks: z.array(slideBlockSchema).min(3).max(6),
  assets: z.array(assetSpecSchema).max(6),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  designIntent: z.object({
    tone: z.literal("professional"),
    density: z.enum(["low", "medium", "high"]),
    visualRatio: z.number().min(0).max(1)
  }).strict()
}).strict();

export interface GeneratedAsset {
  id: string;
  promptHash: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
  filePath: string;
  dataUrl: string;
  reused: boolean;
}

export interface QualityReport {
  score: number;
  safeToReturn: boolean;
  hardGatePassed: boolean;
  dimensions: Record<QualityCategory, number>;
  issues: QualityIssue[];
}

export const qualityIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  category: z.enum(["fidelity", "structure", "readability", "layout", "asset", "technical"]),
  evidence: z.string().min(1).max(500),
  targetId: z.string().max(100).optional(),
  suggestedAction: z.string().min(1).max(300)
}).strict();

export const generateSlideOutputSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["delivered", "best_effort", "failed"]),
  selectedTemplate: z.object({ slug: z.string(), reason: z.string() }).strict(),
  artifacts: z.object({ htmlPath: z.string(), previewPath: z.string(), manifestPath: z.string() }).strict(),
  quality: z.object({
    score: z.number().min(0).max(100),
    threshold: z.number().min(70).max(95),
    hardGatePassed: z.boolean(),
    attempts: z.number().int().min(1).max(3),
    dimensions: z.record(z.string(), z.number().min(0).max(100)),
    remainingIssues: z.array(qualityIssueSchema)
  }).strict(),
  summary: z.string().min(1).max(500)
}).strict();
```

Create the shared fixtures with real, schema-valid values:

```ts
export const validInput = { sourceText: "# 服务方案\n\n## 响应要求\n项目必须在30分钟内响应。", quality: { minScore: 85, maxAttempts: 3 } };
export const canonicalInput = validInput;

export function makeSourceDocument(): SourceDocument {
  return {
    language: "zh-CN",
    title: "服务方案",
    sections: [{ id: "section-1", heading: "响应要求", body: "项目必须在30分钟内响应。", keyPoints: ["快速响应"], order: 0 }],
    facts: [{ id: "fact-1", text: "项目必须在30分钟内响应。", kind: "requirement", sourceSectionId: "section-1" }],
    sourceHash: "fixture-source-hash"
  };
}

export function makeSlideSpec(options: { blockTypes?: SlideBlockType[]; assetCount?: number; factIds?: string[] } = {}): SlideSpec {
  const types = options.blockTypes ?? ["text", "text", "text"];
  while (types.length < 3) types.push("text");
  const factIds = options.factIds ?? ["fact-1"];
  const blocks = types.slice(0, 6).map((type, index) => ({ id: `block-${index + 1}`, type, title: `方案要点${index + 1}`, body: "围绕项目目标建立标准化执行和检查机制。", bullets: [], metrics: [], sourceFactIds: factIds }));
  const assets = Array.from({ length: options.assetCount ?? 1 }, (_, index) => ({ id: `img-${String(index + 1).padStart(3, "0")}`, type: "image" as const, blockId: blocks[index % blocks.length].id, prompt: "professional Chinese business service scene, green and white, no text", alt: "项目服务场景", sourceFactIds: factIds, width: 1792 as const, height: 1024 as const }));
  return { title: "标准化项目服务方案", conclusion: "以标准机制保障项目目标落实", blocks, assets, sourceFactIds: factIds, designIntent: { tone: "professional", density: "medium", visualRatio: assets.length / blocks.length } };
}

export function makeTemplateProfiles(): TemplateProfile[] {
  return [
    { slug: "green-infographic-bid-a4-landscape-text-image", version: "1.0.0", blockCapacity: 4, supportedBlocks: ["text", "image"], imageSlots: 4, densityRange: ["low", "high"], maxCharsBySlot: { body: 160 }, format: "a4-landscape", status: "approved" },
    { slug: "green-infographic-bid-a4-landscape-table-text", version: "1.0.0", blockCapacity: 2, supportedBlocks: ["text", "table"], imageSlots: 0, densityRange: ["medium", "high"], maxCharsBySlot: { body: 200 }, format: "a4-landscape", status: "approved" }
  ];
}

export const imageSpec = makeSlideSpec({ assetCount: 1 }).assets[0];
export const makeGeneratedAssets = (specs: AssetSpec[]): GeneratedAsset[] => specs.map((spec) => ({ id: spec.id, promptHash: `hash-${spec.id}`, mimeType: "image/png", filePath: `/tmp/${spec.id}.png`, dataUrl: "data:image/png;base64,iVBORw0KGgo=", reused: false }));
```

All later tests import these fixtures instead of creating incompatible ad hoc shapes.

Implement `WorkflowError` with `code`, `stage`, `retryable`, `message`, `runId`, and `recovery`, and ensure its JSON serializer omits `stack` and `cause`.

Implement `loadAppConfig(env)` so provider secrets live in non-enumerable `secret` properties. `requireWorkflowConfig` must return `CONFIG_MISSING` naming missing variable names without returning their values. Parse all design variables and apply these defaults:

```ts
export const DEFAULT_LIMITS = {
  maxConcurrency: 2,
  requestTimeoutMs: 60_000,
  maxInputChars: 120_000,
  maxImageBytes: 12 * 1024 * 1024,
  maxAssets: 6,
  maxAttempts: 3
} as const;
```

`PPT_OUTPUT_ROOT` defaults to `<project-root>/output/runs`; `PPT_IMAGE_ALLOWED_HOSTS` is a comma-separated exact hostname list and is mandatory only when the image endpoint can return URLs. Reject non-integer, negative, zero, or out-of-range numeric limits during startup.

- [ ] **Step 4: Run focused tests and type checking**

Run: `npm run test:unit && npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the domain foundation**

```bash
git add package.json package-lock.json src/domain src/config tests/helpers/domain-fixtures.ts tests/unit/domain-config.test.ts
git commit -m "feat: add workflow domain schemas and config"
```

---

### Task 2: Input Normalization and Source Fact Extraction

**Files:**
- Create: `src/services/fact-extractor.ts`
- Create: `src/services/content-normalizer.ts`
- Create: `tests/unit/content-normalizer.test.ts`

**Interfaces:**
- Consumes: validated `GenerateSlideInput` from Task 1.
- Produces: `normalizeSource(input: GenerateSlideInput): SourceDocument` and `extractFacts(sections: SourceSection[]): SourceFact[]`.

- [ ] **Step 1: Write failing Markdown, sections, and fact preservation tests**

```ts
// tests/unit/content-normalizer.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSource } from "../../src/services/content-normalizer.js";

test("normalizes Markdown without domain-specific headings", () => {
  const doc = normalizeSource({
    sourceText: "# 智慧园区方案\n\n## 建设目标\n项目必须在30天内完成一期建设，预算为280万元。",
    quality: { minScore: 85, maxAttempts: 3 }
  });
  assert.equal(doc.title, "智慧园区方案");
  assert.equal(doc.sections[0].heading, "建设目标");
  assert.ok(doc.facts.some((fact) => fact.text.includes("30天")));
  assert.ok(doc.facts.some((fact) => fact.text.includes("280万元")));
  assert.ok(doc.facts.some((fact) => fact.kind === "requirement"));
});

test("normalizes structured sections in caller order", () => {
  const doc = normalizeSource({
    sections: [
      { heading: "现状", body: "当前覆盖8个项目。" },
      { heading: "目标", body: "服务响应时间不得超过30分钟。", keyPoints: ["快速响应"] }
    ],
    quality: { minScore: 85, maxAttempts: 3 }
  });
  assert.deepEqual(doc.sections.map((section) => section.heading), ["现状", "目标"]);
  assert.equal(doc.sections[1].keyPoints[0], "快速响应");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --import tsx --test tests/unit/content-normalizer.test.ts`

Expected: FAIL because `content-normalizer.js` does not exist.

- [ ] **Step 3: Implement deterministic normalization and fact extraction**

```ts
// src/services/fact-extractor.ts
const FACT_SENTENCE = /[^。！？；\n]+[。！？；]?/g;
const NUMBER = /\d[\d,.]*(?:%|万元|元|天|小时|分钟|㎡|个|名|项|次)?/;
const REQUIREMENT = /必须|不得|应当|应在|需在|要求|确保/;

export function extractFacts(sections: SourceSection[]): SourceFact[] {
  const facts: SourceFact[] = [];
  for (const section of sections) {
    const sentences = section.body.match(FACT_SENTENCE) ?? [];
    for (const sentence of sentences.map((value) => value.trim()).filter(Boolean)) {
      const kind = REQUIREMENT.test(sentence)
        ? "requirement"
        : NUMBER.test(sentence)
          ? "number"
          : "conclusion";
      if (kind !== "conclusion" || facts.filter((fact) => fact.sourceSectionId === section.id).length === 0) {
        facts.push({ id: `fact-${facts.length + 1}`, text: sentence, kind, sourceSectionId: section.id });
      }
    }
  }
  return facts;
}
```

`normalizeSource` must parse `#` as the document title, `##` through `######` as sections, preserve paragraphs and bullets, synthesize a `正文` section only when content precedes the first heading, reject an empty result, then compute `sourceHash` from canonical sections and facts.

- [ ] **Step 4: Run normalization tests and the existing source Demo**

Run: `node --import tsx --test tests/unit/content-normalizer.test.ts && npm run demo:source`

Expected: both normalization tests PASS and the existing Demo still completes.

- [ ] **Step 5: Commit input normalization**

```bash
git add src/services/fact-extractor.ts src/services/content-normalizer.ts tests/unit/content-normalizer.test.ts
git commit -m "feat: normalize slide sources and extract facts"
```

---

### Task 3: OpenAI-Compatible Provider Contracts and Offline Mock Server

**Files:**
- Create: `src/providers/contracts.ts`
- Create: `src/providers/openai-compatible.ts`
- Create: `tests/helpers/mock-openai-server.ts`
- Create: `tests/unit/providers.test.ts`
- Modify: `src/lib/llm-client.ts`

**Interfaces:**
- Consumes: provider profiles from `AppConfig`.
- Produces: `TextProvider.generateJson`, `ImageProvider.generate`, `ReviewProvider.review`, and `createOpenAICompatibleProviders(config)`.

- [ ] **Step 1: Write failing provider tests against a local HTTP mock**

```ts
// tests/unit/providers.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatibleProviders } from "../../src/providers/openai-compatible.js";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.js";

test("text provider returns parsed JSON", async (t) => {
  const mock = await startMockOpenAIServer();
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config);
  const value = await providers.text.generateJson({
    system: "Return JSON",
    payload: { source: "内容" },
    schemaName: "test_payload"
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(mock.requests.some((request) => request.url.endsWith("/chat/completions")), true);
});

test("image provider accepts b64_json", async (t) => {
  const mock = await startMockOpenAIServer({ imageMode: "base64" });
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config);
  const image = await providers.image.generate({ prompt: "商务园区", size: "1792x1024" });
  assert.equal(image.kind, "base64");
  assert.match(image.data, /^[A-Za-z0-9+/=]+$/);
});

test("retries 429 and 5xx responses with bounded backoff", async (t) => {
  const mock = await startMockOpenAIServer({ failFirstChatWith: 429 });
  t.after(mock.close);
  const providers = createOpenAICompatibleProviders(mock.config, { sleep: async () => undefined, random: () => 0 });
  await providers.text.generateJson({ system: "Return JSON", payload: {}, schemaName: "test_payload" });
  assert.equal(mock.requests.filter((request) => request.url.endsWith("/chat/completions")).length, 2);
});
```

- [ ] **Step 2: Run the test and verify provider modules are missing**

Run: `node --import tsx --test tests/unit/providers.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement injectable provider interfaces and compatible clients**

```ts
// src/providers/contracts.ts
export interface TextProvider {
  generateJson(input: { system: string; payload: unknown; schemaName: string }): Promise<unknown>;
}

export type GeneratedImage =
  | { kind: "base64"; data: string; mimeType: "image/png" | "image/jpeg" }
  | { kind: "url"; url: string };

export interface ImageProvider {
  generate(input: { prompt: string; size: "1792x1024" }): Promise<GeneratedImage>;
}

export interface ReviewProvider {
  review(input: { system: string; screenshotDataUrl: string; payload: unknown }): Promise<unknown>;
}
```

Use the existing `openai` package for `/chat/completions` and `/images/generations`. Text calls must request JSON object output, use temperature `0.2`, enforce the configured timeout, and wrap `429`, timeout, `5xx`, authentication, and invalid JSON as sanitized `WorkflowError` instances. Review calls send one text block and one `image_url` block. `createOpenAICompatibleProviders(config, runtime?)` accepts injectable `sleep` and `random` functions for tests; production retries `429`, timeout, and `5xx` at most three times with delays `250ms × 2^attempt + jitter`, while authentication and validation errors are never retried.

The mock server must bind to `127.0.0.1`, record request paths and JSON bodies, implement deterministic chat, image, and review responses, and expose `configFor(outputRoot)` to create a complete `AppConfig` without spreading non-enumerable secret fields. The text client includes `schemaName` in its JSON user payload; the mock returns `{ ok: true }` for `test_payload`, a valid 3-block fact-linked spec for `slide_spec`, and the configured six-dimension report for review requests. Update `src/lib/llm-client.ts` as a compatibility facade so old tools keep their current exports while internally using the new provider client.

- [ ] **Step 4: Run provider tests and verify no external request is made**

Run: `node --import tsx --test tests/unit/providers.test.ts && npm run typecheck`

Expected: PASS; every recorded request targets the local mock server.

- [ ] **Step 5: Commit provider abstraction**

```bash
git add src/providers src/lib/llm-client.ts tests/helpers/mock-openai-server.ts tests/unit/providers.test.ts
git commit -m "feat: add openai-compatible provider layer"
```

---

### Task 4: Fact-Linked SlideSpec Builder

**Files:**
- Create: `src/services/slide-spec-builder.ts`
- Create: `tests/unit/slide-spec-builder.test.ts`

**Interfaces:**
- Consumes: `SourceDocument` and `TextProvider`.
- Produces: `buildSlideSpec(source, provider, audience?): Promise<SlideSpec>` with 3–6 fact-linked blocks and stable asset IDs.

- [ ] **Step 1: Write failing tests for valid facts and rejected hallucinations**

```ts
// tests/unit/slide-spec-builder.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSlideSpec } from "../../src/services/slide-spec-builder.js";
import { normalizeSource } from "../../src/services/content-normalizer.js";
import { makeSlideSpec } from "../helpers/domain-fixtures.js";

const source = normalizeSource({
  sourceText: "# 服务方案\n\n## 响应要求\n项目必须在30分钟内响应，并覆盖8个服务点。",
  quality: { minScore: 85, maxAttempts: 3 }
});

test("builds a SlideSpec whose fact references exist", async () => {
  const factIds = source.facts.map((fact) => fact.id);
  const provider = { generateJson: async () => makeSlideSpec({ factIds, assetCount: 1 }) };
  const spec = await buildSlideSpec(source, provider);
  assert.equal(spec.assets[0].id, "img-001");
});

test("rejects unknown fact references", async () => {
  const provider = { generateJson: async () => makeSlideSpec({ factIds: ["fact-999"], assetCount: 0 }) };
  await assert.rejects(() => buildSlideSpec(source, provider), /fact-999/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --import tsx --test tests/unit/slide-spec-builder.test.ts`

Expected: FAIL because `slide-spec-builder.js` does not exist.

- [ ] **Step 3: Implement prompt construction, schema parsing, and fact validation**

```ts
export async function buildSlideSpec(
  source: SourceDocument,
  provider: TextProvider,
  audience = "项目决策者"
): Promise<SlideSpec> {
  const raw = await provider.generateJson({
    schemaName: "slide_spec",
    system: SLIDE_SPEC_SYSTEM_PROMPT,
    payload: { audience, sections: source.sections, facts: source.facts }
  });
  const spec = slideSpecSchema.parse(raw);
  const allowed = new Set(source.facts.map((fact) => fact.id));
  const referenced = new Set([
    ...spec.sourceFactIds,
    ...spec.blocks.flatMap((block) => block.sourceFactIds),
    ...spec.assets.flatMap((asset) => asset.sourceFactIds)
  ]);
  for (const factId of referenced) {
    if (!allowed.has(factId)) throw new WorkflowError({ code: "MODEL_FAILED", stage: "build_slide_spec", retryable: true, message: `Unknown source fact: ${factId}` });
  }
  return spec;
}
```

The system prompt must require Chinese copy, one clear conclusion, 3–6 blocks, no unsupported facts, no text inside generated imagery, and complete asset alt text. Schema constraints must cap title, body, bullet, metric, and prompt lengths.

- [ ] **Step 4: Run builder and full unit tests**

Run: `node --import tsx --test tests/unit/slide-spec-builder.test.ts && npm run test:unit`

Expected: PASS.

- [ ] **Step 5: Commit the SlideSpec builder**

```bash
git add src/services/slide-spec-builder.ts tests/unit/slide-spec-builder.test.ts
git commit -m "feat: build fact-linked slide specifications"
```

---

### Task 5: Approved Template Profiles and Scored Selection

**Files:**
- Create: `templates/green-infographic/template-profiles.json`
- Create: `src/services/template-selector.ts`
- Create: `tests/unit/template-selector.test.ts`
- Modify: `src/lib/template-parser.ts`
- Modify: `src/tools/parse-source-content.ts`

**Interfaces:**
- Consumes: `SlideSpec`, optional forced slug, template directory.
- Produces: `loadTemplateProfiles(dir): TemplateProfile[]` and `selectTemplate(spec, profiles, forcedSlug?): TemplateSelection`.

- [ ] **Step 1: Write failing tests for image, table, and forced-template selection**

```ts
// tests/unit/template-selector.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { selectTemplate } from "../../src/services/template-selector.js";
import { makeSlideSpec, makeTemplateProfiles } from "../helpers/domain-fixtures.js";

const profiles = makeTemplateProfiles();

test("prefers a text-image template for four image-backed blocks", () => {
  const selection = selectTemplate(makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 }), profiles);
  assert.equal(selection.slug, "green-infographic-bid-a4-landscape-text-image");
  assert.match(selection.reason, /图片槽位/);
});

test("rejects a forced template with insufficient capacity", () => {
  assert.throws(
    () => selectTemplate(makeSlideSpec({ blockTypes: ["table", "table", "table"], assetCount: 3 }), profiles, "green-infographic-bid-a4-landscape-table-text"),
    /不兼容/
  );
});
```

- [ ] **Step 2: Run the focused test and verify selection is missing**

Run: `node --import tsx --test tests/unit/template-selector.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add profiles for all six templates and implement weighted scoring**

Each profile must declare `slug`, `version`, `blockCapacity`, `supportedBlocks`, `imageSlots`, `densityRange`, `maxCharsBySlot`, `format: "a4-landscape"`, and `status: "approved"`.

Use an explicit 100-point calculation:

```ts
const score =
  capacityScore(spec, profile) * 0.25 +
  blockTypeScore(spec, profile) * 0.25 +
  imageSlotScore(spec, profile) * 0.20 +
  densityScore(spec, profile) * 0.20 +
  orderScore(spec, profile) * 0.10;
```

`loadTemplateProfiles` must cross-check every profile slug against an actual parsed HTML template and reject duplicate slugs, unapproved status, missing files, and invalid capacity. Remove the hard-coded recommendation branch from `parse-source-content.ts` only after callers can use the new selector; keep the old function as a deprecated compatibility wrapper that delegates to profiles.

- [ ] **Step 4: Run selector tests and all-template QA**

Run: `node --import tsx --test tests/unit/template-selector.test.ts && npm run test:templates`

Expected: selector tests PASS and all 6 existing templates still pass.

- [ ] **Step 5: Commit template capability selection**

```bash
git add templates/green-infographic/template-profiles.json src/services/template-selector.ts src/lib/template-parser.ts src/tools/parse-source-content.ts tests/unit/template-selector.test.ts
git commit -m "feat: score approved templates by slide needs"
```

---

### Task 6: Safe Asset Generation, Local Icon Resolution, and Reuse

**Files:**
- Create: `src/services/safe-download.ts`
- Create: `src/services/asset-generator.ts`
- Create: `tests/unit/asset-generator.test.ts`

**Interfaces:**
- Consumes: `AssetSpec[]`, `ImageProvider`, asset output directory, allowed hosts, byte limit, existing asset records.
- Produces: `generateAssets(input): Promise<GeneratedAsset[]>` where each result has stable ID, prompt hash, MIME, file path, data URL, and reuse metadata.

- [ ] **Step 1: Write failing tests for Base64, host rejection, and prompt-hash reuse**

```ts
// tests/unit/asset-generator.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAssets } from "../../src/services/asset-generator.js";
import { imageSpec } from "../helpers/domain-fixtures.js";

test("persists base64 image and reuses unchanged prompt", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "ppt-assets-"));
  let calls = 0;
  const provider = { generate: async () => { calls += 1; return { kind: "base64" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" as const }; } };
  const first = await generateAssets({ specs: [imageSpec], provider, outputDir, allowedHosts: [], maxBytes: 1_000_000, existing: [] });
  const second = await generateAssets({ specs: [imageSpec], provider, outputDir, allowedHosts: [], maxBytes: 1_000_000, existing: first });
  assert.equal(calls, 1);
  assert.equal(second[0].reused, true);
});

test("rejects an image URL outside the configured allowlist", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "ppt-assets-host-"));
  const provider = { generate: async () => ({ kind: "url" as const, url: "https://untrusted.example/image.png" }) };
  await assert.rejects(
    () => generateAssets({ specs: [imageSpec], provider, outputDir, allowedHosts: ["cdn.example"], maxBytes: 1_000_000, existing: [] }),
    /host is not allowed/
  );
});
```

- [ ] **Step 2: Run the focused test and verify the asset service is missing**

Run: `node --import tsx --test tests/unit/asset-generator.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement safe downloads, icon preference, and prompt-hash cache**

`safeDownloadImage` must:

```ts
export async function safeDownloadImage(input: {
  url: string;
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs: number;
}): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
```

Reject non-HTTPS URLs, username/password URL components, hosts outside the exact allowlist, redirects to a disallowed host, non-image MIME types, responses larger than `maxBytes`, and timeouts. Write files through `file.tmp` followed by `rename`.

Resolve icon concepts against the existing audited SVG names before calling the image provider. Compute cache identity from `asset.id`, normalized prompt, requested size, model profile name, and template version. Validate decoded Base64 length and PNG/JPEG/WebP magic bytes before persistence.

- [ ] **Step 4: Run asset tests and type checking**

Run: `node --import tsx --test tests/unit/asset-generator.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit asset generation**

```bash
git add src/services/safe-download.ts src/services/asset-generator.ts tests/unit/asset-generator.test.ts
git commit -m "feat: generate and safely cache slide assets"
```

---

### Task 7: SlideSpec Mapping and Self-Contained HTML Composition

**Files:**
- Create: `src/services/slide-content-mapper.ts`
- Create: `src/services/slide-composer.ts`
- Create: `tests/unit/slide-composer.test.ts`
- Modify: `src/tools/fill-placeholders.ts`
- Modify: `src/tools/assemble-page.ts`
- Modify: `src/tools/render-icons.ts`

**Interfaces:**
- Consumes: `SlideSpec`, parsed template, `TemplateProfile`, and `GeneratedAsset[]`.
- Produces: `mapSlideContent(spec, template): FillContent` and `composeSlide(input): Promise<{ html: string; warnings: string[] }>`.

- [ ] **Step 1: Write a failing composition test against a real approved template**

```ts
// tests/unit/slide-composer.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadTemplate } from "../../src/lib/template-parser.js";
import { composeSlide } from "../../src/services/slide-composer.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { makeGeneratedAssets, makeSlideSpec } from "../helpers/domain-fixtures.js";

const templatesDir = resolve("templates");
const templateSlug = "green-infographic-bid-a4-landscape-text-image";
const template = loadTemplate(templatesDir, templateSlug);
const profile = loadTemplateProfiles(templatesDir).find((item) => item.slug === templateSlug)!;
const spec = makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 });
const assets = makeGeneratedAssets(spec.assets);

test("composes one self-contained page with no slots or remote assets", async () => {
  const result = await composeSlide({ spec, template, profile, assets });
  assert.match(result.html, /<html/i);
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /<figures|<icon|placeholder-image|img-slot|https?:\/\//i);
  assert.doesNotMatch(result.html, /<script/i);
  assert.equal((result.html.match(/data-slide-page=/g) ?? []).length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify composition fails**

Run: `node --import tsx --test tests/unit/slide-composer.test.ts`

Expected: FAIL because `slide-composer.js` does not exist.

- [ ] **Step 3: Implement deterministic mapping and inlining**

`mapSlideContent` must fill page metadata, block titles, bodies, bullets, tables, process labels, captions, and figure references based on actual placeholder counts returned by `loadTemplate`. It must fail on missing required content instead of silently leaving example text.

`composeSlide` must perform this order:

```ts
const content = mapSlideContent(input.spec, input.template);
const filled = await fillPlaceholders({ html: input.template.html, content: { direct: content } });
const withAssets = replaceAssetTags(filled.html, input.spec.assets, input.assets);
const withoutScripts = stripExecutableScripts(withAssets);
const withInlineCss = inlineTemplateCss(withoutScripts, input.template.filePath);
const html = addSinglePageMarker(withInlineCss);
return { html, warnings: [...filled.warnings, ...scanResiduals(html)] };
```

Use JSDOM node creation for text and asset replacement. Never concatenate source text into raw HTML. Inline local SVG icons as percent-encoded or Base64 data URLs and generated raster images as Base64 data URLs. Extend existing assembly and icon tools through shared helpers while preserving their public result shapes.

- [ ] **Step 4: Run composition, all-template, and legacy Demo tests**

Run: `node --import tsx --test tests/unit/slide-composer.test.ts && npm run test:templates && npm run demo`

Expected: all commands PASS.

- [ ] **Step 5: Commit single-page composition**

```bash
git add src/services/slide-content-mapper.ts src/services/slide-composer.ts src/tools/fill-placeholders.ts src/tools/assemble-page.ts src/tools/render-icons.ts tests/unit/slide-composer.test.ts
git commit -m "feat: compose self-contained single-page html"
```

---

### Task 8: Browser Rendering and Deterministic Quality Gates

**Files:**
- Create: `src/services/page-renderer.ts`
- Create: `src/services/deterministic-evaluator.ts`
- Create: `tests/render/page-renderer.test.ts`
- Create: `tests/fixtures/render/valid-page.html`
- Create: `tests/fixtures/render/overflow-page.html`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: self-contained HTML and output paths.
- Produces: `renderPage(input): Promise<RenderResult>` and `evaluateDeterministic(render): DeterministicReport`.

- [ ] **Step 1: Add a render test script and write failing valid/overflow tests**

```json
"test:render": "node --import tsx --test tests/render/*.test.ts"
```

```ts
// tests/render/page-renderer.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderPage } from "../../src/services/page-renderer.js";
import { evaluateDeterministic } from "../../src/services/deterministic-evaluator.js";

test("accepts a bounded A4 landscape page", async () => {
  const html = await readFile("tests/fixtures/render/valid-page.html", "utf8");
  const render = await renderPage({ html, screenshotPath: "output/test-render-valid.png" });
  const report = evaluateDeterministic(render);
  assert.equal(report.hardGatePassed, true);
});

test("detects text overflow", async () => {
  const html = await readFile("tests/fixtures/render/overflow-page.html", "utf8");
  const render = await renderPage({ html, screenshotPath: "output/test-render-overflow.png" });
  const report = evaluateDeterministic(render);
  assert.ok(report.issues.some((issue) => issue.category === "layout" && issue.severity === "error"));
});
```

- [ ] **Step 2: Install Playwright, install Chromium, and verify the test still fails on missing service modules**

Run: `npm install playwright@^1.55.0 && npx playwright install chromium && npm run test:render`

Expected: dependency installation succeeds, then the test FAILS with `ERR_MODULE_NOT_FOUND` for `page-renderer.js`.

- [ ] **Step 3: Implement fixed rendering and DOM measurements**

```ts
export interface RenderResult {
  screenshotPath: string;
  screenshotDataUrl: string;
  viewport: { width: 1123; height: 794 };
  pageCount: number;
  elements: Array<{
    id: string;
    rect: { x: number; y: number; width: number; height: number };
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
    fontSize: number;
    contrastRatio: number;
  }>;
  images: Array<{ src: string; complete: boolean; naturalWidth: number; naturalHeight: number; opaqueRatio: number; luminanceVariance: number }>;
  bodyScroll: { width: number; height: number };
  occupiedRatio: number;
}
```

Launch Chromium with a 1123 × 794 viewport, set HTML with `waitUntil: "networkidle"`, wait for `document.fonts.ready`, reject every network request, collect element geometry, then capture the full viewport. Draw each image to a 16 × 16 browser canvas to calculate alpha coverage and luminance variance. Deterministic evaluation must reject multiple page markers, body overflow beyond one pixel, element overflow beyond the safe page bounds, text scroll overflow, text below 11.3 CSS pixels, WCAG contrast below 4.5:1 for normal text or 3:1 for large text, images with zero dimensions or opaque ratio below 2%, unresolved placeholders, scripts, and secret-like tokens. Record low image variance and page occupied ratio outside 45%–95% as quality warnings rather than hard failures.

`DeterministicReport` contains both `safeToReturn` and `hardGatePassed`. Parsing, screenshot, one-page structure, image loading, script removal, and sensitive-data failures set both fields false. Overflow, minimum font, contrast, and unresolved content placeholders set only `hardGatePassed` false when the page remains safe to inspect.

- [ ] **Step 4: Run renderer tests twice to verify determinism**

Run: `npm run test:render && npm run test:render`

Expected: both runs PASS and produce identical page counts and issue categories.

- [ ] **Step 5: Commit rendering and deterministic gates**

```bash
git add package.json package-lock.json src/services/page-renderer.ts src/services/deterministic-evaluator.ts tests/render tests/fixtures/render
git commit -m "feat: render slides and enforce deterministic gates"
```

---

### Task 9: Multimodal Review and Weighted Quality Report

**Files:**
- Create: `src/services/slide-evaluator.ts`
- Create: `tests/helpers/quality-fixtures.ts`
- Create: `tests/unit/slide-evaluator.test.ts`

**Interfaces:**
- Consumes: `SourceDocument`, `SlideSpec`, `RenderResult`, `DeterministicReport`, and `ReviewProvider`.
- Produces: `evaluateSlide(input): Promise<QualityReport>` with fixed dimension weights and normalized issues.

- [ ] **Step 1: Write failing scoring, hard-gate, and invalid-review tests**

```ts
// tests/unit/slide-evaluator.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSlide } from "../../src/services/slide-evaluator.js";
import { makeEvaluationFixtures } from "../helpers/quality-fixtures.js";

const { source, spec, render, passingDeterministic, failingDeterministic, perfectReview } = makeEvaluationFixtures();

test("computes total score from fixed weights", async () => {
  const review = { review: async () => ({
    dimensions: { fidelity: 90, structure: 80, readability: 85, layout: 90, asset: 80, technical: 100 },
    issues: []
  }) };
  const result = await evaluateSlide({ source, spec, render, deterministic: passingDeterministic, review });
  assert.equal(result.score, 87.5);
  assert.equal(result.hardGatePassed, true);
});

test("does not allow the model to override a deterministic failure", async () => {
  const result = await evaluateSlide({ source, spec, render, deterministic: failingDeterministic, review: perfectReview });
  assert.equal(result.hardGatePassed, false);
  assert.equal(result.safeToReturn, true);
});

test("rejects a review that does not match the schema", async () => {
  await assert.rejects(() => evaluateSlide({ source, spec, render, deterministic: passingDeterministic, review: { review: async () => ({ score: 100 }) } }), /review schema/i);
});
```

Create the fixture with fully populated render and report shapes:

```ts
// tests/helpers/quality-fixtures.ts
export function makeEvaluationFixtures() {
  const source = makeSourceDocument();
  const spec = makeSlideSpec({ factIds: source.facts.map((fact) => fact.id), assetCount: 1 });
  const render: RenderResult = {
    screenshotPath: "/tmp/quality-preview.png",
    screenshotDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    viewport: { width: 1123, height: 794 },
    pageCount: 1,
    elements: [],
    images: [{ src: "data:image/png;base64,iVBORw0KGgo=", complete: true, naturalWidth: 1, naturalHeight: 1, opaqueRatio: 1, luminanceVariance: 0.2 }],
    bodyScroll: { width: 1123, height: 794 },
    occupiedRatio: 0.75
  };
  const passingDeterministic = { safeToReturn: true, hardGatePassed: true, issues: [] };
  const failingDeterministic = { safeToReturn: true, hardGatePassed: false, issues: [{ id: "det-1", severity: "error", category: "layout", evidence: "overflow", suggestedAction: "rewrite", targetId: "block-1" }] };
  const perfectReview = { review: async () => ({ dimensions: { fidelity: 100, structure: 100, readability: 100, layout: 100, asset: 100, technical: 100 }, issues: [] }) };
  return { source, spec, render, passingDeterministic, failingDeterministic, perfectReview };
}
```

- [ ] **Step 2: Run the focused test and verify evaluator is missing**

Run: `node --import tsx --test tests/unit/slide-evaluator.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement schema-only review and fixed weighted scoring**

```ts
const WEIGHTS = {
  fidelity: 0.25,
  structure: 0.15,
  readability: 0.20,
  layout: 0.20,
  asset: 0.10,
  technical: 0.10
} as const;

const score = Math.round(
  Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + dimensions[key as keyof typeof WEIGHTS] * weight, 0) * 10
) / 10;
```

The review prompt must include the screenshot, compact source facts, `SlideSpec`, deterministic issues, the exact dimension definitions, and the required `QualityIssue` fields. Merge deterministic issues before model issues and deduplicate by `category + targetId + evidence`. Set `safeToReturn` only when HTML parsing, single-page rendering, screenshot creation, image loading, script removal, and sensitive-data checks pass. Set `hardGatePassed` only when `safeToReturn` is true, every deterministic gate passes, and the review has no hard-gate fidelity error.

- [ ] **Step 4: Run evaluator and full unit tests**

Run: `node --import tsx --test tests/unit/slide-evaluator.test.ts && npm run test:unit`

Expected: PASS.

- [ ] **Step 5: Commit quality evaluation**

```bash
git add src/services/slide-evaluator.ts tests/helpers/quality-fixtures.ts tests/unit/slide-evaluator.test.ts
git commit -m "feat: add multimodal slide quality scoring"
```

---

### Task 10: Constrained Repairs and the Three-Attempt Quality Loop

**Files:**
- Create: `src/services/repair-router.ts`
- Create: `src/services/repair-executor.ts`
- Create: `src/workflow/quality-loop.ts`
- Create: `tests/helpers/quality-loop-fixtures.ts`
- Create: `tests/unit/quality-loop.test.ts`

**Interfaces:**
- Consumes: attempt `SlideSpec`, assets, template selection, `QualityReport`, and injected compose/evaluate/provider callbacks.
- Produces: `routeRepairs(report, state): RepairAction[]`, `executeRepairs(input): Promise<RepairState>`, and `runQualityLoop(input): Promise<QualityLoopResult>`.

- [ ] **Step 1: Write failing repair routing and attempt-limit tests**

```ts
// tests/unit/quality-loop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { routeRepairs } from "../../src/services/repair-router.js";
import { runQualityLoop } from "../../src/workflow/quality-loop.js";
import { makeLoopInput, reportWith } from "../helpers/quality-loop-fixtures.js";

test("routes overflow to a target block rewrite", () => {
  const actions = routeRepairs(reportWith({ category: "layout", targetId: "block-2", evidence: "text overflow" }), { attempt: 1, templateSwitched: false });
  assert.deepEqual(actions[0], { type: "rewrite_block", targetId: "block-2", reasonIssueId: "issue-1" });
});

test("switches template at most once and stops after three attempts", async () => {
  const result = await runQualityLoop(makeLoopInput({ scores: [70, 78, 82], hardGates: [true, true, true], maxAttempts: 3 }));
  assert.equal(result.status, "best_effort");
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts.filter((attempt) => attempt.actions.some((action) => action.type === "switch_template")).length, 1);
});

test("distinguishes safe best effort from failed output", async () => {
  const bestEffort = await runQualityLoop(makeLoopInput({ scores: [90], hardGates: [false], safeFlags: [true], maxAttempts: 1 }));
  const failed = await runQualityLoop(makeLoopInput({ scores: [90], hardGates: [false], safeFlags: [false], maxAttempts: 1 }));
  assert.equal(bestEffort.status, "best_effort");
  assert.equal(failed.status, "failed");
});
```

The helper must use a deterministic score queue and a complete initial repair state:

```ts
// tests/helpers/quality-loop-fixtures.ts
export function reportWith(issue: Partial<QualityIssue>): QualityReport {
  return {
    score: 70,
    safeToReturn: true,
    hardGatePassed: true,
    dimensions: { fidelity: 70, structure: 70, readability: 70, layout: 70, asset: 70, technical: 70 },
    issues: [{ id: "issue-1", severity: "error", category: "layout", evidence: "template capacity mismatch", suggestedAction: "switch template", ...issue }]
  };
}

export function makeLoopInput(options: { scores: number[]; hardGates: boolean[]; safeFlags?: boolean[]; maxAttempts: number }): QualityLoopInput {
  let evaluationIndex = 0;
  const spec = makeSlideSpec({ assetCount: 1 });
  return {
    initialState: { spec, assets: makeGeneratedAssets(spec.assets), templateSlug: "green-infographic-bid-a4-landscape", designTokens: { fontScale: 1, spacingScale: 1, contrastMode: "normal" }, templateSwitched: false },
    minScore: 85,
    maxAttempts: options.maxAttempts,
    compose: async () => ({ html: "<html><body data-slide-page=\"1\"></body></html>", screenshotPath: `/tmp/attempt-${evaluationIndex + 1}.png` }),
    evaluate: async () => {
      const index = evaluationIndex++;
      return { ...reportWith({}), score: options.scores[index], safeToReturn: options.safeFlags?.[index] ?? true, hardGatePassed: options.hardGates[index] };
    },
    repair: async ({ state, actions }) => ({ ...state, templateSwitched: state.templateSwitched || actions.some((action) => action.type === "switch_template") })
  };
}
```

- [ ] **Step 2: Run the focused test and verify repair modules are missing**

Run: `node --import tsx --test tests/unit/quality-loop.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the closed action union and bounded loop**

```ts
export type RepairAction =
  | { type: "rewrite_block"; targetId: string; reasonIssueId: string }
  | { type: "restore_fact"; factId: string; targetId: string; reasonIssueId: string }
  | { type: "regenerate_asset"; targetId: string; reasonIssueId: string }
  | { type: "switch_template"; reasonIssueId: string }
  | { type: "adjust_token"; token: "font-scale" | "spacing-scale" | "contrast-mode"; value: number | "high"; reasonIssueId: string };
```

`repair-router` must never emit raw CSS, JavaScript, file paths, or global rewrites. `repair-executor` must validate every rewritten block against its source fact IDs and preserve unchanged block and asset hashes. `runQualityLoop` must stop immediately on `hardGatePassed && score >= minScore`, retain all attempts, select the highest-scoring `safeToReturn` attempt, return `best_effort` when that safe attempt misses a hard gate or the score threshold, and return `failed` when no safe attempt exists.

- [ ] **Step 4: Run repair tests and verify unchanged assets are reused**

Run: `node --import tsx --test tests/unit/quality-loop.test.ts && npm run test:unit`

Expected: PASS; the test fake records no generation call for unchanged asset IDs.

- [ ] **Step 5: Commit the quality loop**

```bash
git add src/services/repair-router.ts src/services/repair-executor.ts src/workflow/quality-loop.ts tests/helpers/quality-loop-fixtures.ts tests/unit/quality-loop.test.ts
git commit -m "feat: add bounded slide repair loop"
```

---

### Task 11: Safe Run Store, Manifests, Idempotency, and Artifact Access

**Files:**
- Create: `src/domain/run-manifest.ts`
- Create: `src/workflow/run-store.ts`
- Create: `tests/unit/run-store.test.ts`

**Interfaces:**
- Consumes: `PPT_OUTPUT_ROOT`, validated input, stage updates, attempt records, and artifact names.
- Produces: `RunStore.createOrResume`, `RunStore.updateStage`, `RunStore.saveAttempt`, `RunStore.finalize`, `RunStore.getRun`, and `RunStore.getArtifact`.

- [ ] **Step 1: Write failing idempotency and path traversal tests**

```ts
// tests/unit/run-store.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/workflow/run-store.js";
import { canonicalInput } from "../helpers/domain-fixtures.js";

test("resumes the same request fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-"));
  const store = new RunStore(root);
  const first = await store.createOrResume({ requestId: "request-123", canonicalInput });
  const second = await store.createOrResume({ requestId: "request-123", canonicalInput });
  assert.equal(second.runId, first.runId);
  assert.equal(second.resumed, true);
});

test("rejects requestId reuse with different input", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-runs-"));
  const store = new RunStore(root);
  await store.createOrResume({ requestId: "request-123", canonicalInput });
  await assert.rejects(() => store.createOrResume({ requestId: "request-123", canonicalInput: { ...canonicalInput, audience: "不同受众" } }), /fingerprint/i);
  await assert.rejects(() => store.getArtifact("../escape", "manifest.json"), /invalid runId/i);
});
```

- [ ] **Step 2: Run the focused test and verify run-store is missing**

Run: `node --import tsx --test tests/unit/run-store.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement atomic manifests and safe artifact lookup**

```ts
export interface RunManifest {
  version: 1;
  runId: string;
  requestId?: string;
  requestFingerprint: string;
  sourceHash?: string;
  status: "running" | "delivered" | "best_effort" | "failed";
  createdAt: string;
  updatedAt: string;
  template?: { slug: string; version: string; reason: string };
  stages: Partial<Record<WorkflowStage, StageRecord>>;
  slideSpec?: SlideSpec;
  assets: Array<Pick<GeneratedAsset, "id" | "promptHash" | "mimeType" | "filePath"> & { prompt: string }>;
  attempts: AttemptRecord[];
  selectedAttempt?: number;
  finalResult?: GenerateSlideOutput;
  artifacts?: { htmlPath: string; previewPath: string; manifestPath: string };
}

export class RunStore {
  constructor(private readonly root: string) {}
  createOrResume(input: { requestId?: string; canonicalInput: unknown }): Promise<ActiveRun>;
  updateStage(runId: string, stage: WorkflowStage, update: StageRecord): Promise<RunManifest>;
  readStageOutput<T>(runId: string, stage: WorkflowStage): Promise<{ found: false } | { found: true; value: T }>;
  writeStageOutput(runId: string, stage: WorkflowStage, value: unknown): Promise<void>;
  saveAttempt(runId: string, attempt: AttemptRecord, files: AttemptFiles): Promise<RunManifest>;
  finalize(runId: string, update: FinalRecord): Promise<RunManifest>;
  getRun(runId: string): Promise<RunManifest>;
  getArtifact(runId: string, artifactName: ArtifactName): Promise<{ path: string; size: number; text?: string }>;
  runDir(runId: string): string;
}

export interface ActiveRun {
  runId: string;
  manifest: RunManifest;
  resumed: boolean;
  store: RunStore;
}
```

Build `requestFingerprint` from the canonical source input, template slug, audience, threshold, and max attempts. Store a root-level `request-index.json` using atomic temp-file replacement. Validate run IDs with UUID syntax, artifact names with a closed union, and every resolved path with `path.relative(root, target)` before reading or writing. Limit inline artifact text to 512 KiB.

- [ ] **Step 4: Run store tests including forced interruption recovery**

Run: `node --import tsx --test tests/unit/run-store.test.ts && npm run typecheck`

Expected: PASS; a manifest with a completed stage resumes from the next stage.

- [ ] **Step 5: Commit run persistence**

```bash
git add src/domain/run-manifest.ts src/workflow/run-store.ts tests/unit/run-store.test.ts
git commit -m "feat: persist resumable slide runs"
```

---

### Task 12: End-to-End Workflow Orchestrator

**Files:**
- Create: `src/workflow/generate-slide.ts`
- Create: `tests/helpers/workflow-fixtures.ts`
- Create: `tests/e2e/generate-slide-workflow.test.ts`

**Interfaces:**
- Consumes: validated `GenerateSlideInput`, `AppConfig`, injected providers, template services, renderer, evaluator, repair loop, and `RunStore`.
- Produces: `generateSlideWorkflow(input, dependencies): Promise<GenerateSlideOutput>`.

- [ ] **Step 1: Write failing offline workflow success, best-effort, and resume tests**

```ts
// tests/e2e/generate-slide-workflow.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { generateSlideWorkflow } from "../../src/workflow/generate-slide.js";
import { makeWorkflowDependencies, workflowInput } from "../helpers/workflow-fixtures.js";

test("generates a delivered self-contained slide", async () => {
  const deps = await makeWorkflowDependencies({ scores: [88], hardGates: [true] });
  const result = await generateSlideWorkflow(workflowInput, deps);
  assert.equal(result.status, "delivered");
  assert.equal(result.quality.score, 88);
  assert.match(await readFile(result.artifacts.htmlPath, "utf8"), /data:image\/png;base64,/);
  assert.equal(result.quality.attempts, 1);
});

test("returns best_effort after three safe attempts below threshold", async () => {
  const deps = await makeWorkflowDependencies({ scores: [72, 79, 83], hardGates: [true, true, true] });
  const result = await generateSlideWorkflow(workflowInput, deps);
  assert.equal(result.status, "best_effort");
  assert.equal(result.quality.attempts, 3);
});

test("does not repeat completed image generation when requestId is replayed", async () => {
  const deps = await makeWorkflowDependencies({ scores: [90], hardGates: [true] });
  const first = await generateSlideWorkflow({ ...workflowInput, requestId: "workflow-resume-1" }, deps);
  const second = await generateSlideWorkflow({ ...workflowInput, requestId: "workflow-resume-1" }, deps);
  assert.equal(second.runId, first.runId);
  assert.equal(deps.counters.imageCalls, 1);
});
```

`tests/helpers/workflow-fixtures.ts` must build a temporary `RunStore` and complete deterministic fakes rather than calling the network:

```ts
export const workflowInput = {
  sourceText: "# 服务方案\n\n## 响应机制\n项目必须在30分钟内响应，并覆盖8个服务点。",
  quality: { minScore: 85, maxAttempts: 3 }
};

export async function makeWorkflowDependencies(options: { scores: number[]; hardGates: boolean[] }) {
  const root = await mkdtemp(join(tmpdir(), "ppt-workflow-"));
  const counters = { imageCalls: 0 };
  const source = makeSourceDocument();
  const spec = makeSlideSpec({ factIds: source.facts.map((fact) => fact.id), assetCount: 1 });
  const assets = makeGeneratedAssets(spec.assets);
  return {
    counters,
    runStore: new RunStore(root),
    normalizeSource: () => source,
    buildSlideSpec: async () => spec,
    selectTemplate: () => ({ slug: "green-infographic-bid-a4-landscape-text-image", reason: "图片槽位与内容匹配", score: 95 }),
    generateAssets: async () => { counters.imageCalls += 1; return assets; },
    composeSlide: async () => ({ html: "<html><body data-slide-page=\"1\"><img src=\"data:image/png;base64,iVBORw0KGgo=\"></body></html>", warnings: [] }),
    runQualityLoop: async (input: { runDir: string }) => writeFakeAttempts(input.runDir, options.scores, options.hardGates),
    profiles: makeTemplateProfiles()
  } satisfies WorkflowDependencies & { counters: { imageCalls: number } };
}
```

`writeFakeAttempts` must create `page.html`, `preview.png`, and `quality.json` for every supplied score, then return the same `QualityLoopResult` shape as the production loop. This makes artifact promotion and idempotent replay real filesystem behavior while all model and image calls remain fake.

```ts
async function writeFakeAttempts(runDir: string, scores: number[], hardGates: boolean[]): Promise<QualityLoopResult> {
  const attempts: AttemptResult[] = [];
  for (let index = 0; index < scores.length; index += 1) {
    const attempt = index + 1;
    const dir = join(runDir, "attempts", String(attempt).padStart(2, "0"));
    await mkdir(dir, { recursive: true });
    const htmlPath = join(dir, "page.html");
    const previewPath = join(dir, "preview.png");
    const qualityPath = join(dir, "quality.json");
    const quality = { score: scores[index], safeToReturn: true, hardGatePassed: hardGates[index], dimensions: { fidelity: scores[index], structure: scores[index], readability: scores[index], layout: scores[index], asset: scores[index], technical: scores[index] }, issues: [] };
    await Promise.all([
      writeFile(htmlPath, "<html><body data-slide-page=\"1\"><img src=\"data:image/png;base64,iVBORw0KGgo=\"></body></html>"),
      writeFile(previewPath, Buffer.from("iVBORw0KGgo=", "base64")),
      writeFile(qualityPath, JSON.stringify(quality, null, 2))
    ]);
    attempts.push({ attempt, htmlPath, previewPath, qualityPath, quality, actions: [] });
  }
  const selected = attempts.filter((item) => item.quality.safeToReturn).sort((a, b) => b.quality.score - a.quality.score)[0];
  return { status: selected?.quality.hardGatePassed && selected.quality.score >= 85 ? "delivered" : selected ? "best_effort" : "failed", attempts, selectedAttempt: selected?.attempt };
}
```

- [ ] **Step 2: Run the focused E2E test and verify orchestrator is missing**

Run: `node --import tsx --test tests/e2e/generate-slide-workflow.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement ordered stages, stage persistence, and final artifact promotion**

```ts
export interface WorkflowDependencies {
  runStore: RunStore;
  profiles: TemplateProfile[];
  normalizeSource(input: GenerateSlideInput): SourceDocument;
  buildSlideSpec(source: SourceDocument, audience?: string): Promise<SlideSpec>;
  selectTemplate(spec: SlideSpec, forcedSlug?: string): TemplateSelection;
  generateAssets(runId: string, specs: AssetSpec[]): Promise<GeneratedAsset[]>;
  composeSlide(spec: SlideSpec, selection: TemplateSelection, assets: GeneratedAsset[]): Promise<ComposeResult>;
  runQualityLoop(input: WorkflowQualityInput): Promise<QualityLoopResult>;
}

export async function generateSlideWorkflow(
  rawInput: unknown,
  deps: WorkflowDependencies
): Promise<GenerateSlideOutput> {
  const input = generateSlideInputSchema.parse(rawInput);
  const run = await deps.runStore.createOrResume({ requestId: input.requestId, canonicalInput: input });
  if (run.manifest.status === "delivered" || run.manifest.status === "best_effort") return outputFromManifest(run.manifest);
  const source = await runStage(deps.runStore, run, "normalize_input", () => deps.normalizeSource(input));
  const spec = await runStage(deps.runStore, run, "build_slide_spec", () => deps.buildSlideSpec(source, input.audience));
  const selection = await runStage(deps.runStore, run, "select_template", () => deps.selectTemplate(spec, input.templateSlug));
  const assets = await runStage(deps.runStore, run, "generate_assets", () => deps.generateAssets(run.runId, spec.assets));
  const initialPage = await runStage(deps.runStore, run, "compose_html", () => deps.composeSlide(spec, selection, assets));
  const loop = await deps.runQualityLoop({ runId: run.runId, runDir: deps.runStore.runDir(run.runId), source, spec, selection, assets, initialPage, quality: input.quality });
  return finalizeWorkflowResult(run, selection, loop, input.quality.minScore);
}
```

Define the referenced helpers in the same module:

```ts
async function runStage<T>(store: RunStore, run: ActiveRun, stage: WorkflowStage, execute: () => Promise<T> | T): Promise<T> {
  const restored = await store.readStageOutput<T>(run.runId, stage);
  if (restored.found) return restored.value;
  await store.updateStage(run.runId, stage, { status: "running", startedAt: new Date().toISOString() });
  try {
    const value = await execute();
    await store.writeStageOutput(run.runId, stage, value);
    await store.updateStage(run.runId, stage, { status: "completed", completedAt: new Date().toISOString() });
    return value;
  } catch (error) {
    await store.updateStage(run.runId, stage, stageFailure(error));
    throw error;
  }
}

function outputFromManifest(manifest: RunManifest): GenerateSlideOutput {
  return generateSlideOutputSchema.parse(manifest.finalResult);
}

async function finalizeWorkflowResult(run: ActiveRun, selection: TemplateSelection, loop: QualityLoopResult, threshold: number): Promise<GenerateSlideOutput> {
  const result = buildGenerateSlideOutput(run.runId, selection, loop, threshold);
  await run.store.finalize(run.runId, { status: result.status, finalResult: result, selectedAttempt: loop.selectedAttempt });
  return result;
}
```

Add `readStageOutput`, `writeStageOutput`, and `runDir` to the Task 11 `RunStore` interface. `ActiveRun` includes its originating `store`, so finalization cannot accidentally write through a different output root.

Each stage wrapper must persist `running`, `completed`, or sanitized `failed` records with timestamps and duration. Promote the selected attempt to `final.html` and `final.png` through copy-to-temp plus rename, calculate checksums, then finalize the manifest before returning.

- [ ] **Step 4: Run E2E, unit, render, and existing template tests**

Run: `node --import tsx --test tests/e2e/generate-slide-workflow.test.ts && npm run test:unit && npm run test:render && npm run test:templates`

Expected: all commands PASS.

- [ ] **Step 5: Commit the workflow orchestrator**

```bash
git add src/workflow/generate-slide.ts tests/helpers/workflow-fixtures.ts tests/e2e/generate-slide-workflow.test.ts
git commit -m "feat: orchestrate quality-gated slide generation"
```

---

### Task 13: Structured MCP Registration and Backward-Compatible Handlers

**Files:**
- Create: `src/app.ts`
- Create: `src/mcp/tool-result.ts`
- Create: `src/mcp/register-tools.ts`
- Create: `tests/helpers/mcp-harness.ts`
- Create: `tests/contract/mcp-tools.test.ts`
- Modify: `src/server.ts`
- Modify: `src/tools/insert-asset-slots.ts`

**Interfaces:**
- Consumes: `generateSlideWorkflow`, `RunStore`, new domain schemas, and existing atomic tool functions.
- Produces: `createProductionDependencies(config): PptMcpDependencies`, `createPptMcpServer(dependencies): McpServer`, structured `generate_slide`, `evaluate_slide`, `get_run`, `get_artifact`, and registered `insert_asset_slots` tools.

- [ ] **Step 1: Write a failing in-memory MCP contract test**

```ts
// tests/contract/mcp-tools.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPptMcpServer } from "../../src/mcp/register-tools.js";
import { makeWorkflowDependencies, workflowInput } from "../helpers/workflow-fixtures.js";

test("lists workflow and compatibility tools with structured output", async (t) => {
  const dependencies = await makeWorkflowDependencies({ scores: [90], hardGates: [true] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("generate_slide"));
  assert.ok(names.includes("insert_asset_slots"));
  assert.ok(names.includes("fill_placeholders"));
  const result = await client.callTool({ name: "generate_slide", arguments: workflowInput });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.status, "delivered");
});
```

Create one reusable in-memory harness for the acceptance suite:

```ts
// tests/helpers/mcp-harness.ts
export async function callGenerateSlideThroughInMemoryMcp(
  input: GenerateSlideInput,
  dependencies: PptMcpDependencies
): Promise<GenerateSlideOutput> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPptMcpServer(dependencies);
  const client = new Client({ name: "mcp-harness", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "generate_slide", arguments: input });
    if (result.isError) throw new Error(result.content.map((item) => item.type === "text" ? item.text : "").join("\n"));
    return generateSlideOutputSchema.parse(result.structuredContent);
  } finally {
    await client.close();
    await server.close();
  }
}
```

- [ ] **Step 2: Run the contract test and verify registration module is missing**

Run: `node --import tsx --test tests/contract/mcp-tools.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Migrate to `McpServer.registerTool` and structured results**

Register new tools with Zod input and output shapes:

```ts
server.registerTool("generate_slide", {
  title: "Generate quality-gated slide",
  description: "将中文商务正文生成带真实图片的单页 A4 横向 HTML，并自动评分和修正。默认使用此工具完成完整交付。",
  inputSchema: generateSlideInputSchema,
  outputSchema: generateSlideOutputSchema
}, async (input) => toToolResult(await generateSlideWorkflow(input, dependencies)));
```

Register the remaining new tool inputs as closed shapes:

```ts
const evaluateSlideInputSchema = z.object({
  runId: z.string().uuid(),
  artifactName: z.literal("final.html").default("final.html")
}).strict();
const getRunInputSchema = z.object({ runId: z.string().uuid() }).strict();
const getArtifactInputSchema = z.object({
  runId: z.string().uuid(),
  artifactName: z.enum(["manifest.json", "final.html", "quality.json"])
}).strict();
const insertAssetSlotsInputSchema = z.object({
  html: z.string().min(1),
  iconPrompts: z.array(z.object({ position: z.string(), description: z.string(), prompt: z.string() }).strict()),
  imagePrompts: z.array(z.object({ sectionTitle: z.string(), prompt: z.string() }).strict())
}).strict();
```

`evaluate_slide` reads only the selected run artifact under `PPT_OUTPUT_ROOT`; it does not accept an arbitrary file path. `get_artifact` returns text only when the stored file is at most 512 KiB, otherwise it returns the safe path and byte count.

`toToolResult` must return both a short `content` text summary and `structuredContent`. `toToolError` must return `isError: true` with only the stable error fields. Register all existing atomic tools through adapters that preserve their current inputs. `server.ts` becomes a small composition root that loads config, creates dependencies, connects `StdioServerTransport`, and writes diagnostics only to `stderr`.

`src/app.ts` is the only production dependency factory. It creates provider clients, `RunStore`, profile catalog, renderer, evaluator, repair loop, workflow callbacks, and compatibility adapters from one validated `AppConfig`. Tests may call the same factory with a localhost mock profile and a temporary output root.

- [ ] **Step 4: Run contract, compatibility, and type tests**

Run: `node --import tsx --test tests/contract/mcp-tools.test.ts && npm run test:templates && npm run typecheck`

Expected: PASS; the tool list contains every old tool plus the five new or newly exposed tools.

- [ ] **Step 5: Commit MCP registration**

```bash
git add src/app.ts src/mcp src/server.ts src/tools/insert-asset-slots.ts tests/helpers/mcp-harness.ts tests/contract/mcp-tools.test.ts
git commit -m "feat: expose the slide workflow over mcp"
```

---

### Task 14: Production Scripts, Documentation, Offline Acceptance, and Final Verification

**Files:**
- Create: `.env.example`
- Create: `docs/workflows/generate-slide.md`
- Create: `tests/e2e/mcp-workflow.acceptance.test.ts`
- Modify: `.gitignore`
- Modify: `.mcp.json`
- Modify: `README.md`
- Modify: `tests/demo-from-source.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: completed MCP server and workflow.
- Produces: production build/start scripts, offline acceptance suite, one-page Demo, and accurate integration documentation.

- [ ] **Step 1: Write the failing acceptance test and final package scripts**

```ts
// tests/e2e/mcp-workflow.acceptance.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionDependencies } from "../../src/app.js";
import { callGenerateSlideThroughInMemoryMcp } from "../helpers/mcp-harness.js";
import { startMockOpenAIServer } from "../helpers/mock-openai-server.js";

const markdownInput = { sourceText: "# 服务方案\n\n## 响应机制\n项目必须在30分钟内响应，并覆盖8个服务点。", quality: { minScore: 85, maxAttempts: 3 } };
const sectionsInput = { sections: [{ heading: "响应机制", body: "项目必须在30分钟内响应，并覆盖8个服务点。", keyPoints: ["快速响应"] }], quality: { minScore: 85, maxAttempts: 3 } };

test("Markdown and sections both produce inspectable single-page artifacts", async (t) => {
  const mock = await startMockOpenAIServer({ reviewScore: 90, imageMode: "base64" });
  t.after(mock.close);
  const outputRoot = await mkdtemp(join(tmpdir(), "ppt-acceptance-"));
  const dependencies = createProductionDependencies(mock.configFor(outputRoot));
  for (const input of [markdownInput, sectionsInput]) {
    const result = await callGenerateSlideThroughInMemoryMcp(input, dependencies);
    assert.equal(result.status, "delivered");
    assert.ok(result.quality.score >= 85);
    assert.equal(result.quality.hardGatePassed, true);
    const html = await readFile(result.artifacts.htmlPath, "utf8");
    assert.equal((html.match(/data-slide-page=/g) ?? []).length, 1);
    assert.match(html, /data:image\/(?:png|jpeg|webp|svg\+xml)/);
    assert.doesNotMatch(html, /<figures|<icon|img-slot|prompt reference/i);
    const manifest = await readFile(result.artifacts.manifestPath, "utf8");
    assert.equal(manifest.includes(mock.apiKey), false);
    assert.equal(html.includes(mock.apiKey), false);
  }
});
```

Set final scripts:

```json
{
  "build": "tsc",
  "start": "node dist/src/server.js",
  "dev": "tsx watch src/server.ts",
  "test": "npm run test:unit && npm run test:contract && npm run test:render && npm run test:e2e && npm run test:templates",
  "test:unit": "node --import tsx --test tests/unit/*.test.ts",
  "test:contract": "node --import tsx --test tests/contract/*.test.ts",
  "test:render": "node --import tsx --test tests/render/*.test.ts",
  "test:e2e": "node --import tsx --test tests/e2e/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 2: Run acceptance and verify documentation or script expectations fail**

Run: `npm run test:e2e`

Expected: FAIL until the acceptance helper and final one-page Demo wiring are complete.

- [ ] **Step 3: Finish production wiring and exact user documentation**

`.env.example` must list every environment variable from the design with empty secret values and safe numeric defaults. `.gitignore` must ignore `.env`, `dist/`, Playwright artifacts, and `output/runs/` while keeping fixture files tracked.

Update `.mcp.json` to use `command: "node"`, `args: ["dist/src/server.js"]`, and the existing workspace `cwd`; README setup must run `npm run build` before the Agent starts the production MCP server. Keep a separate documented development configuration using `npx tsx src/server.ts`.

`docs/workflows/generate-slide.md` and `README.md` must include this minimal call:

```json
{
  "sourceText": "# 项目服务方案\n\n## 服务目标\n项目要求建立标准化服务体系。",
  "audience": "采购评审专家",
  "quality": { "minScore": 85, "maxAttempts": 3 },
  "requestId": "proposal-page-001"
}
```

Document `delivered`, `best_effort`, and `failed`; every environment variable; artifact paths; resume behavior; atomic tools; Claude Code `.mcp.json`; OpenCode; and custom stdio Agent setup. Rewrite `tests/demo-from-source.ts` to use the real high-level workflow with mock providers by default and real configured providers only when all required environment variables exist.

- [ ] **Step 4: Run the complete verification matrix from a clean build**

Run:

```bash
npm run typecheck
npm run build
npm test
npm run demo:source
git diff --check
git status --short
```

Expected:

- Type checking and production build exit 0.
- Unit, contract, render, E2E, and 6-template QA tests all pass.
- Demo produces one self-contained HTML page plus preview and manifest.
- `git diff --check` prints nothing.
- `git status --short` lists only the intended Task 14 files before commit.

- [ ] **Step 5: Commit documentation and acceptance wiring**

```bash
git add .env.example .gitignore .mcp.json README.md docs/workflows/generate-slide.md tests/demo-from-source.ts tests/e2e/mcp-workflow.acceptance.test.ts package.json package-lock.json
git commit -m "docs: ship the generate slide workflow"
```

---

## Final Acceptance Checklist

- [ ] `generate_slide` is the documented default tool and returns structured content.
- [ ] Markdown and sections inputs both produce the same canonical domain model.
- [ ] Credentials are accepted only from server environment configuration.
- [ ] Every selected template is approved and explains its score.
- [ ] Final HTML is one page, self-contained, script-free, and contains real assets.
- [ ] Deterministic and multimodal quality reports are both present.
- [ ] Repairs are typed, targeted, bounded to three attempts, and preserve unchanged assets.
- [ ] `requestId` replay resumes safely and does not duplicate image calls.
- [ ] `delivered`, `best_effort`, and `failed` match the documented status rules.
- [ ] Existing atomic tools and all 6 templates remain compatible.
- [ ] Default tests run fully offline and the production build starts from `dist/src/server.js`.
- [ ] README, workflow documentation, `.mcp.json`, and the actual tool list agree.
