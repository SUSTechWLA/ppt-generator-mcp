# Nontechnical Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give existing-MCP users and from-zero local users a clear, copyable path from numbered Chinese source text to a QA-approved HTML deliverable, while preserving a separate technical reference.

**Architecture:** Use three documentation layers: the root README as a five-minute entry point, `docs/user-guide.md` as the complete operating handbook, and `docs/architecture.md` as the implementation reference. All user-facing examples describe the existing high-level MCP contracts and recommend deterministic `balanced` template diversity without changing runtime behavior.

**Tech Stack:** GitHub-flavored Markdown, Mermaid, Node.js 22+, MCP stdio, existing npm verification scripts

## Global Constraints

- Modify documentation only; do not change runtime code, schemas, templates, or tests.
- Cover both users who already have an MCP-capable Agent and users installing locally from zero.
- Treat `test.md` as local untracked user content: do not modify, stage, delete, or commit it.
- Recommend `plan_deck`, `generate_deck`, `get_deck`, `inspect_template`, `create_template_from_reference`, and `list_template_knowledge` as the ordinary high-level surface.
- Recommend `templateDiversity: "balanced"`; never describe diversity as permission to weaken facts, capacity, font size, image semantics, or document policy.
- Do not imply that the MCP silently calls an image provider or automatically infers page boundaries.
- Keep implementation details in `docs/architecture.md`, linked from the user-facing layers.

---

### Task 1: Complete Nontechnical User Guide

**Files:**
- Create: `docs/user-guide.md`

**Interfaces:**
- Consumes: current `.mcp.json`, `package.json` scripts, public high-level tool contracts, and the approved documentation design
- Produces: the canonical task-oriented operating guide linked by README and architecture documentation

- [x] **Step 1: Write the guide structure and first-use routes**

Create `docs/user-guide.md` with this reader order:

```text
What the MCP delivers
Choose your starting point
Route A: connect an existing MCP-capable Agent
Route B: install Node.js 22+, dependencies, Chromium, build, and connect
Prepare numbered source text
Copyable Agent prompts
Understand the four-step production workflow
Choose template diversity
Handle image assets with or without an API
Read statuses and collect final.html
Learn templates from references
Understand the basic principles
Troubleshoot common failures
Know the safe and advanced tool boundaries
```

Use short numbered procedures and copyable command, JSON, source-text, and Agent-prompt blocks. Explain the five ordinary terms `正文`, `模板`, `素材`, `计划`, and `交付件` before the workflow.

- [x] **Step 2: Add a complete copyable operating example**

The example must contain an exact numbered source shape and an Agent instruction that asks the Agent to:

```text
1. validate the full-line <page N> markers and pageNumbers;
2. call plan_deck with documentType=bid and templateDiversity=balanced;
3. generate only the returned asset IDs when assets are required;
4. call generate_deck with the same IDs as data URLs;
5. resume needs_assets with the same requestId;
6. accept only delivered pages and report final.html plus QA evidence.
```

Explain that page numbers such as 59–62 are examples of upstream numbering, not template-selection rules.

- [x] **Step 3: Verify guide completeness and forbidden claims**

Run:

```bash
rg -n "已有 MCP|从零安装|Node.js 22|plan_deck|generate_deck|get_deck|balanced|needs_assets|delivered|final.html|逐页 QA|不自动分页|图片" docs/user-guide.md
rg -n "自动推测分页|自动调用图片|保证每页不同|强化学习" docs/user-guide.md
```

Expected: the first command finds every required topic; any second-command matches must explicitly negate the incorrect claim or explain that the selector is not reinforcement learning.

- [x] **Step 4: Commit the complete user guide**

```bash
git add -- docs/user-guide.md
git commit -m "docs: add nontechnical user guide"
```

### Task 2: Rebuild README as the Five-Minute Entry Point

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/user-guide.md` as the detailed operating reference and `docs/architecture.md` as the technical reference
- Produces: a concise repository front door with two visible starting paths

- [x] **Step 1: Reorder README around user outcomes**

Lead with the HTML deliverable and add the following sections before implementation detail:

```text
5 分钟上手
路径 A：已有支持 MCP 的 Agent
路径 B：从零安装和启动
可直接复制给 Agent 的提示词
正文必须长什么样
运行结果在哪里
```

Keep exact installation commands, `.mcp.json`, the numbered-page example, and the high-level tool table. Link to `docs/user-guide.md` for full operating details and `docs/architecture.md` for algorithms, contracts, security, and extension guidance.

- [x] **Step 2: Compress technical duplication without losing contract facts**

Retain these truths in plain language:

```text
The upstream workflow must paginate first.
The default diversity mode is balanced.
Images are returned as stable requirements and supplied externally.
Only status=delivered is a formal deliverable.
The result is self-contained A4 landscape HTML rather than a required .pptx.
Atomic and compatibility tools are trusted-local advanced functions.
```

Move long optimizer thresholds and provider-boundary detail behind architecture links. Update the project tree to include `docs/user-guide.md`.

- [x] **Step 3: Verify the README entry path and links**

Run:

```bash
rg -n "5 分钟上手|已有支持 MCP|从零安装|复制给 Agent|user-guide.md|architecture.md|final.html|status.*delivered" README.md
test -f docs/user-guide.md
test -f docs/architecture.md
```

Expected: all entry-point topics are present and both linked files exist.

- [x] **Step 4: Commit the README rewrite**

```bash
git add -- README.md
git commit -m "docs: simplify the quick start"
```

### Task 3: Add the Architecture Reader Route and Publish

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-07-31-nontechnical-documentation.md`

**Interfaces:**
- Consumes: the final README and user guide
- Produces: a clear nontechnical-to-technical navigation path and verified published documentation

- [x] **Step 1: Add a reader-route notice to architecture documentation**

Immediately below the architecture introduction, add a short note with this meaning:

```text
Nontechnical and first-time users should start with README and docs/user-guide.md.
This document is for maintainers and workflow designers who need data flow,
selection, persistence, QA, security, and extension details.
```

Do not rewrite or dilute the existing technical sections.

- [x] **Step 2: Validate every relative Markdown link**

Run a small read-only Node.js check that extracts non-HTTP Markdown links from the three public documents, strips fragments, resolves them relative to each document, and fails when a target is missing:

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const files = ['README.md', 'docs/user-guide.md', 'docs/architecture.md'];
let failed = false;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = decodeURIComponent(href.split('#')[0]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      console.error(`${file}: missing ${href}`);
      failed = true;
    }
  }
}
process.exitCode = failed ? 1 : 0;
NODE
```

Expected: exit code `0` and no missing-link output.

- [x] **Step 3: Run documentation and repository verification**

Run:

```bash
git diff --check
rg -n "T[B]D|T[O]DO|填充|稍后补充" README.md docs/user-guide.md docs/architecture.md
npm test
npm run check
git status --short
```

Expected: no whitespace errors or placeholders; all automated tests, typecheck, and production build pass; only approved documentation changes plus untracked `test.md` appear.

- [x] **Step 4: Mark this plan completed and inspect the final diff**

Change every checkbox in this plan from `[ ]` to `[x]`, then run:

```bash
git diff --check
git diff --stat 20d8ab5
git diff -- README.md docs/user-guide.md docs/architecture.md docs/superpowers/plans/2026-07-31-nontechnical-documentation.md
```

Expected: documentation-only changes matching the approved design, with no `test.md` diff.

- [x] **Step 5: Commit final navigation and verification evidence**

```bash
git add -- docs/architecture.md docs/superpowers/plans/2026-07-31-nontechnical-documentation.md
git commit -m "docs: complete nontechnical documentation"
```

- [x] **Step 6: Push and verify the remote branch**

```bash
git push origin main
git rev-parse HEAD
git rev-parse origin/main
git ls-remote --heads origin main
```

Expected: local `HEAD`, `origin/main`, and the remote `main` hash are identical; untracked `test.md` remains local.
