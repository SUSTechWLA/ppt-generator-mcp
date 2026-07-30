# Deck Template Diversity Implementation Plan

> **Main-branch status:** Planned, not implemented. The task checkboxes below are execution instructions and do not describe the currently published MCP contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `plan_deck` choose a deterministic, quality-bounded sequence of varied compatible templates across the full deck.

**Architecture:** Keep the existing per-profile grounded planning and hard compatibility checks. Add a pure bounded deck-sequence optimizer that receives successful page candidates, applies mode-specific near-best quality bands, and chooses a deterministic sequence with first-use rewards and adjacent-repeat penalties. Persist the effective mode and selection evidence in immutable plan artifacts.

**Tech Stack:** TypeScript 7, Zod 4, Node.js test runner, MCP SDK, existing grounded display and template-profile services.

## Global Constraints

- Fact coverage, critical anchors, capacity, minimum font, metadata bindings, image slots, and document policy remain hard gates.
- Default mode is `balanced`; supported values are `off`, `conservative`, `balanced`, and `expressive`.
- Explicit `templateSlug` forces one template and makes the effective diversity mode `off`.
- No mandatory LLM or image-provider call is added.
- Search retains at most 12 candidates per page and 256 states per page across at most 30 pages.
- Selection must be deterministic for identical source, profile catalog, and input.
- Historical plans without `templateDiversity` must remain valid with their original fingerprint.
- Do not add page-number, source-phrase, template-slug, or current-demo special cases.

---

### Task 1: Add the backwards-compatible public contract

**Files:**
- Modify: `package.json`
- Modify: `src/domain/deck-plan.ts`
- Create: `tests/deck-template-diversity.test.ts`

**Interfaces:**
- Produces: `templateDiversityModeSchema`
- Produces: `TemplateDiversityMode`
- Adds: `planDeckInputSchema.templateDiversity?: TemplateDiversityMode`
- Adds: `plannedDeckSchema.templateDiversity?: TemplateDiversityMode`
- Extends: `hashPlannedDeckFingerprint(input)` to bind the field only when present

- [ ] **Step 1: Add the test command and failing contract tests**

Add this script to `package.json`:

```json
"test": "node --import tsx --test tests/*.test.ts"
```

Create `tests/deck-template-diversity.test.ts` with Node's real assertion library. Start with tests that parse all four modes, reject an unknown mode, and prove that an omitted input remains omitted rather than being schema-defaulted:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { planDeckInputSchema } from "../src/domain/deck-plan.js";

const baseInput = {
  sourceText: "<page 1>\n一级标题：示例\n正文：\n事实内容足够用于页面规划和模板选择。",
  pageNumbers: [1],
};

test("accepts explicit template diversity modes without schema-defaulting omission", () => {
  for (const mode of ["off", "conservative", "balanced", "expressive"] as const) {
    assert.equal(planDeckInputSchema.parse({ ...baseInput, templateDiversity: mode }).templateDiversity, mode);
  }
  assert.equal(planDeckInputSchema.parse(baseInput).templateDiversity, undefined);
  assert.equal(planDeckInputSchema.safeParse({ ...baseInput, templateDiversity: "random" }).success, false);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm test`

Expected: FAIL because `templateDiversity` is rejected by the strict input schema.

- [ ] **Step 3: Implement the contract minimally**

In `src/domain/deck-plan.ts`, define and export:

```ts
export const templateDiversityModeSchema = z.enum(["off", "conservative", "balanced", "expressive"]);
export type TemplateDiversityMode = z.infer<typeof templateDiversityModeSchema>;
```

Add `templateDiversity: templateDiversityModeSchema.optional()` to `planDeckInputSchema` and `plannedDeckSchema`. Extend the fingerprint input type and canonical object with:

```ts
...(input.templateDiversity ? { templateDiversity: input.templateDiversity } : {}),
```

Do not add `.default("balanced")` at schema level.

- [ ] **Step 4: Run tests and type checking**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add package.json src/domain/deck-plan.ts tests/deck-template-diversity.test.ts
git commit -m "feat: add deck template diversity contract"
```

---

### Task 2: Build the pure bounded sequence optimizer

**Files:**
- Create: `src/services/deck-template-diversity.ts`
- Modify: `tests/deck-template-diversity.test.ts`

**Interfaces:**
- Consumes: `TemplateDiversityMode`
- Produces: `MAX_DIVERSITY_CANDIDATES_PER_PAGE = 12`
- Produces: `MAX_DIVERSITY_STATES = 256`
- Produces: `DeckTemplateCandidateScore`
- Produces: `DeckTemplateDecision`
- Produces: `selectDeckTemplateSequence(pages, mode)`

Use these public shapes:

```ts
export interface DeckTemplateCandidateScore {
  templateSlug: string;
  retainedCharacterCount: number;
  selectionScore: number;
  catalogIndex: number;
}

export interface DeckTemplateDecision {
  candidateIndex: number;
  retainedCharacterLoss: number;
  retainedLossPercent: number;
  selectionScoreLoss: number;
  firstUse: boolean;
  adjacentRepeat: boolean;
  diversityAdjustment: number;
}

export function selectDeckTemplateSequence(
  pages: readonly (readonly DeckTemplateCandidateScore[])[],
  mode: TemplateDiversityMode,
): DeckTemplateDecision[];
```

The caller must pass every page's candidates already sorted by the existing local quality comparator, so index `0` is the quality reference.

- [ ] **Step 1: Add a failing optimizer export contract**

Add a dynamic import contract before the new production file exists, converting the expected missing-module condition into a real assertion failure:

```ts
test("exports the deck template sequence optimizer", async () => {
  let exported: unknown;
  try {
    exported = (await import("../src/services/deck-template-diversity.js")).selectDeckTemplateSequence;
  } catch {
    exported = undefined;
  }
  assert.equal(typeof exported, "function");
});
```

- [ ] **Step 2: Run the export contract and verify RED**

Run: `npm test`

Expected: FAIL with `actual: "undefined", expected: "function"`.

- [ ] **Step 3: Create the typed optimizer shell**

Create `src/services/deck-template-diversity.ts` with the documented constants, interfaces, and a minimal `selectDeckTemplateSequence` that validates every page has a candidate and returns candidate index `0` with zeroed evidence for every page. This is sufficient only for the export contract and preserves existing local-winner behavior.

- [ ] **Step 4: Run the export contract and verify GREEN**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Add failing optimizer behavior tests**

Replace the dynamic access with a static import and add:

```ts
test("balanced selects varied near-best templates without adjacent repetition", () => {
  const pages = Array.from({ length: 4 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 198, selectionScore: 90, catalogIndex: 1 },
    { templateSlug: "layout-c", retainedCharacterCount: 197, selectionScore: 89, catalogIndex: 2 },
  ]);
  const decisions = selectDeckTemplateSequence(pages, "balanced");
  const slugs = decisions.map((decision, page) => pages[page][decision.candidateIndex].templateSlug);
  assert.ok(new Set(slugs).size >= 2);
  assert.equal(slugs.some((slug, index) => index > 0 && slug === slugs[index - 1]), false);
});

test("balanced rejects novelty outside the quality band", () => {
  const pages = [[
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 150, selectionScore: 70, catalogIndex: 1 },
  ]];
  assert.equal(selectDeckTemplateSequence(pages, "balanced")[0].candidateIndex, 0);
});

test("off preserves local winners and sequence selection is deterministic", () => {
  const pages = Array.from({ length: 4 }, () => [
    { templateSlug: "layout-a", retainedCharacterCount: 200, selectionScore: 92, catalogIndex: 0 },
    { templateSlug: "layout-b", retainedCharacterCount: 199, selectionScore: 91, catalogIndex: 1 },
  ]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "off").map((item) => item.candidateIndex), [0, 0, 0, 0]);
  assert.deepEqual(selectDeckTemplateSequence(pages, "balanced"), selectDeckTemplateSequence(pages, "balanced"));
});
```

Add explicit assertions that a single candidate produces index `0`, conservative rejects retained-character loss, expressive admits a candidate inside its wider band, and a 30-page input with 20 candidates per page returns exactly 30 decisions whose indexes are all below 12.

- [ ] **Step 6: Run the optimizer behavior tests and verify RED**

Run: `npm test`

Expected: FAIL because the typed shell returns local winner index `0` for every mode, leaving avoidable adjacent repeats.

- [ ] **Step 7: Implement quality-band admission**

Implement mode constants exactly as specified:

```ts
const MODE_POLICY = {
  off: { scoreLoss: 0, firstUseBonus: 0, adjacentPenalty: 0 },
  conservative: { scoreLoss: 3, firstUseBonus: 2, adjacentPenalty: 4 },
  balanced: { scoreLoss: 8, firstUseBonus: 8, adjacentPenalty: 10 },
  expressive: { scoreLoss: 15, firstUseBonus: 14, adjacentPenalty: 18 },
} as const;
```

Compute retained-character limits from the approved spec. Always keep candidate `0` as the safety fallback. Sort admitted candidates by their original local rank and retain at most 12.

- [ ] **Step 8: Implement bounded deterministic beam DP**

Represent a state with decisions, used slugs, last slug, total utility, total retained characters, total selection score, adjacent repeat count, and catalog-index sequence. Deduplicate each expansion layer by `lastSlug + sorted usedSlugs`, compare states with the five documented tie-breakers, and retain at most 256.

For each transition compute:

```ts
const qualityLoss = retainedLossPercent * 2 + selectionScoreLoss;
const diversityAdjustment = (firstUse ? policy.firstUseBonus : 0)
  - (adjacentRepeat ? policy.adjacentPenalty : 0);
const utility = diversityAdjustment - qualityLoss;
```

- [ ] **Step 9: Run optimizer tests and type checking**

Run: `npm test && npm run typecheck`

Expected: PASS, including deterministic 30-page bounds.

- [ ] **Step 10: Commit the optimizer**

```bash
git add src/services/deck-template-diversity.ts tests/deck-template-diversity.test.ts
git commit -m "feat: optimize template diversity across decks"
```

---

### Task 3: Integrate global selection into `plan_deck`

**Files:**
- Modify: `src/workflow/plan-deck.ts`
- Modify: `src/domain/deck-plan.ts`
- Modify: `tests/deck-template-diversity.test.ts`

**Interfaces:**
- Consumes: `selectDeckTemplateSequence`
- Changes: `selectProfilePlan(...)` to `candidatePlansForPage(...)`
- Changes: `templateMatch(candidate, diversityEvidence, pageCandidates)`
- Persists: `plannedDeck.templateDiversity`

- [ ] **Step 1: Add failing real workflow tests**

Use `mkdtemp`, `DeckStore`, `loadTemplateProfiles`, `createPlanDeckDependencies`, and `planDeckWorkflow` with the real template catalog. Use this four-page explicit source fixture with process, numeric comparison, evidence, and operational-detail pages:

```ts
const fourPageSource = `<page 1>
一级标题：实施方案
二级标题：服务流程
三级标题：全过程闭环管理
正文：
项目启动后依次完成现场交接、任务分派、过程巡查和结果复核。每项任务记录责任人、完成时限和验收结果，异常事项进入整改闭环。
<page 2>
一级标题：实施方案
二级标题：资源对比
三级标题：多项目资源配置
正文：
服务覆盖8个项目，总面积96,252.66平方米。常态任务与临时任务分别配置人员、设备和物资，项目负责人根据工作量对比结果实施跨项目调度。
<page 3>
一级标题：质量保障
二级标题：证据管理
三级标题：全过程资料留痕
正文：
计划、工单、现场照片、材料记录、复核意见和整改结果统一编号归档。月度考核前检查资料完整性，保证工作内容与验收依据相互印证。
<page 4>
一级标题：质量保障
二级标题：现场控制
三级标题：安全与秩序管理
正文：
机械作业避开人员集中时段，作业区域设置警示和引导。枝叶、草屑及包装物随产随清，完成一个作业面后复查植物、道路、设备和防护设施。`;
```

Assert:

```ts
const output = await planDeckWorkflow({
  sourceText: fourPageSource,
  pageNumbers: [1, 2, 3, 4],
  documentType: "bid",
  preferredThemeId: "green-infographic-v1",
  templateDiversity: "balanced",
  requestId: "template-diversity-balanced-001",
}, dependencies);

const slugs = output.plannedDeck.slides.map((slide) => slide.templateSlug);
assert.ok(new Set(slugs).size >= 2);
assert.equal(output.plannedDeck.templateDiversity, "balanced");
assert.ok(output.plannedDeck.slides.every((slide) => slide.templateMatch.unmatched.length === 0));
assert.ok(output.plannedDeck.slides.every((slide) => slide.templateMatch.unrepresentedFactIds.length === 0));
```

Create the store under `await mkdtemp(join(tmpdir(), "deck-diversity-test-"))` and remove it in `finally` with `rm(root, { recursive: true, force: true })`. Add separate calls proving `off` preserves the local winner sequence and explicit `templateSlug` persists effective mode `off` with one slug.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `npm test`

Expected: FAIL because workflow still selects each page independently and does not persist the effective mode.

- [ ] **Step 3: Collect all successful candidates per page**

Replace the immediate winner helper with a helper that returns `successes.sort(compareCandidates)` and only throws the current bounded page error when the array is empty. Preserve all existing local diagnostics and hard gates.

Build page metadata and candidate arrays first, then map each `CandidatePlan` to `DeckTemplateCandidateScore`. Set:

```ts
const effectiveTemplateDiversity = input.templateSlug
  ? "off"
  : input.templateDiversity ?? "balanced";
```

Call `selectDeckTemplateSequence` once for the full deck and map decision indexes back to `CandidatePlan` objects.

- [ ] **Step 4: Persist transparent selection evidence**

Make `templateMatch` receive the page's complete successful candidate list and the selected `DeckTemplateDecision`. Persist all successful candidate scores in deterministic local order. Append a bounded reason suffix containing mode, retained loss, score loss, first-use status, and adjacent-repeat status.

Add `templateDiversity: effectiveTemplateDiversity` to new `planEvidence`. Ensure `hashPlannedDeckFingerprint` binds it.

- [ ] **Step 5: Add historical fingerprint compatibility test**

Take a newly generated `off` plan, construct a historical-shaped copy by deleting `templateDiversity`, recompute its fingerprint with `hashPlannedDeckFingerprint`, and assert `plannedDeckSchema.parse(historicalPlan)` succeeds. This proves parsing does not synthesize a new field into old immutable artifacts.

- [ ] **Step 6: Run workflow tests and full checks**

Run: `npm test && npm run check`

Expected: PASS.

- [ ] **Step 7: Commit workflow integration**

```bash
git add src/workflow/plan-deck.ts src/domain/deck-plan.ts tests/deck-template-diversity.test.ts
git commit -m "feat: select templates at deck scope"
```

---

### Task 4: Document and verify the production MCP workflow

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-30-deck-template-diversity-design.md`
- Test: local `test.md` through production MCP stdio

**Interfaces:**
- Documents: `plan_deck.templateDiversity`
- Verifies: actual four-page source, tool contract, deterministic repeat, and build

- [ ] **Step 1: Update README**

Document the four modes, default `balanced`, hard-gate priority, explicit `templateSlug` override, deterministic behavior, and the possibility that a selected image-capable layout returns additional `assets` for the caller to supply.

Add this field to the planning JSON example:

```json
"templateDiversity": "balanced"
```

- [ ] **Step 2: Run the current four-page source through MCP twice**

Create `/tmp/verify-deck-diversity.ts`, run it with `node --import tsx`, and move it to Trash afterward. The script must start `dist/src/server.js` through the SDK stdio client and use the untracked local `test.md`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const outputRoot = await mkdtemp(join(tmpdir(), "deck-diversity-mcp-"));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/src/server.js"],
  cwd: process.cwd(),
  env: { ...inheritedEnv, PPT_OUTPUT_ROOT: outputRoot },
});
const client = new Client({ name: "deck-diversity-verifier", version: "1.0.0" });
try {
  await client.connect(transport);
  const sourceText = await readFile("test.md", "utf8");
  const args = {
    sourceText,
    pageNumbers: [59, 60, 61, 62],
    documentType: "bid",
    preferredThemeId: "green-infographic-v1",
    templateDiversity: "balanced",
    requestId: "deck-diversity-real-20260730",
  };
  const first = await client.callTool({ name: "plan_deck", arguments: args });
  const second = await client.callTool({ name: "plan_deck", arguments: args });
  assert.equal(first.isError, false);
  assert.deepEqual(second.structuredContent, first.structuredContent);
  const output = first.structuredContent as any;
  const slides = output.plannedDeck.slides;
  const slugs = slides.map((slide: any) => slide.templateSlug);
  assert.ok(new Set(slugs).size >= 2);
  assert.ok(slides.every((slide: any) => slide.templateMatch.unmatched.length === 0));
  assert.ok(slides.every((slide: any) => slide.templateMatch.unrepresentedFactIds.length === 0));
  assert.deepEqual(output.assets, slides.flatMap((slide: any) => slide.plannedSpec.assets));
  console.log(JSON.stringify({ slugs, fingerprint: output.plannedDeck.planFingerprint }));
} finally {
  await client.close();
  await rm(outputRoot, { recursive: true, force: true });
}
```

This verifies immutable resume identity because both calls use the same request ID. Assert:

- both results and template slug sequences are identical;
- both calls return the same deck ID and fingerprint through immutable resume;
- at least two template slugs are selected when at least two candidates lie inside the balanced band;
- every slide has complete represented facts and no unmatched slots;
- returned assets equal the selected slides' assets.

If the real content exposes only one candidate inside the approved quality band on a page, report that evidence rather than widening the band or adding a content special case.

- [ ] **Step 3: Run final verification**

Run:

```bash
npm test
npm run check
git diff --check
```

Then run the MCP stdio smoke test and inspect `git status -sb` to ensure `test.md`, `output/`, `dist/`, and `node_modules/` are not staged.

- [ ] **Step 4: Mark the approved design implemented**

After the automated and MCP checks pass, change the design status to `Implemented`.

- [ ] **Step 5: Commit documentation and final verification metadata**

```bash
git add README.md docs/superpowers/specs/2026-07-30-deck-template-diversity-design.md
git commit -m "docs: document deck template diversity"
```

- [ ] **Step 6: Push main after completion approval**

```bash
git push origin main
```
