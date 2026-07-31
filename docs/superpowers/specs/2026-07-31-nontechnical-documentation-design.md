# Nontechnical Documentation Design

**Date:** 2026-07-31

**Status:** Approved
**Scope:** User-facing documentation only

## Goal

Make PPT Generator MCP understandable and usable by people who do not maintain
software. The documentation must support both common starting points:

1. a user who already has an MCP-capable Agent and wants a copyable setup and
   prompt;
2. a user who needs to install Node.js, start the MCP service, and connect it
   from zero.

The guide should explain what the product does, how to obtain an HTML
deliverable, and why the workflow can produce stable high-quality pages without
requiring the reader to understand the TypeScript implementation.

## Audience

- proposal, tender, consulting, and content-production users;
- Agent workflow designers;
- local operators who can copy commands but are not expected to write code;
- technical maintainers who need a clear route to the existing architecture
  reference.

## Decision

Use a three-layer documentation structure.

### README: five-minute entry point

The repository README is the front door. It will lead with outcomes and contain:

- a plain-language product summary;
- the shortest path for an existing MCP-capable Agent;
- a from-zero installation path;
- a copyable Agent prompt;
- the accepted numbered-page source format;
- the recommended end-to-end workflow;
- links to the detailed user and architecture guides.

It will keep the public tool reference and configuration summary, but move
implementation-heavy explanation behind the dedicated architecture link.

### User guide: complete operating handbook

Add `docs/user-guide.md` as a task-oriented guide containing:

- capabilities and current boundaries;
- installation and MCP connection;
- source preparation and numbered-page examples;
- copyable prompts for first use and production use;
- template and deck-diversity choices in ordinary language;
- asset handling with and without an image-generation API;
- `plan_deck` → asset completion → `generate_deck` → `get_deck`;
- status interpretation, delivery-file locations, and common troubleshooting;
- a plain-language explanation of grounding, template matching, whole-deck
  selection, and page-by-page QA;
- the safe high-level tool surface and the advanced trusted-local boundary.

### Architecture guide: technical reference

Keep `docs/architecture.md` as the implementation reference. Add a short reader
route near the beginning so nontechnical users are directed to the user guide,
while maintainers retain the current detailed contracts and algorithms.

## Information design

The first-use path should answer four questions in order:

1. What can I give it?
2. What do I ask my Agent to do?
3. What happens while it runs?
4. Where is the finished HTML?

Commands and prompts will be copyable blocks. Terms will be introduced only
when needed:

- **正文**: numbered source content supplied by the upstream workflow;
- **模板**: a reusable page structure and capability declaration;
- **素材**: an image or other external visual required by the selected page;
- **计划**: the immutable, grounded page and template decision;
- **交付件**: the generated HTML pages and their QA evidence.

The guide will include one compact workflow diagram:

```text
编号正文 → 逐页理解 → 兼容模板候选 → 整套选择
        → 补齐图片素材 → 生成 HTML → 逐页 QA → 交付
```

## Defaults and safety

- Recommend `templateDiversity: "balanced"` for normal use.
- Explain that variety is considered only among candidates already close to the
  page's best quality; facts, capacity, font size, image semantics, and document
  policy remain hard constraints.
- Recommend the six high-level MCP tools for ordinary workflows.
- Mark legacy/atomic tools as trusted-local advanced functions rather than part
  of first use.
- State that the MCP creates image requirements but does not secretly invoke an
  image provider. An Agent may use an available image-generation capability and
  return the resulting asset through the documented contract.
- Do not present local test content, page numbers, or one template family as
  product-specific logic.

## Verification

Before publishing:

- validate that every relative documentation link resolves;
- check Markdown for whitespace errors and unfinished placeholders;
- run the project typecheck/build and automated tests to ensure documented
  commands still match the repository;
- inspect the final diff and stage only documentation files;
- preserve the untracked local `test.md`.

## Acceptance criteria

- A nontechnical reader can reach a first HTML deliverable by following one
  linear path.
- Both existing-MCP and from-zero users have explicit instructions.
- Copyable Agent prompts and source examples are present.
- Basic principles are explained without requiring code knowledge.
- Detailed technical material remains available without dominating the README.
- No product behavior or runtime code changes are included.
