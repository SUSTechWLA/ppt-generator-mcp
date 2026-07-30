# Deck Template Diversity Design

**Date:** 2026-07-30

**Status:** Approved for implementation
**Scope:** `plan_deck` template selection only

> Main-branch note: this document describes an approved next-stage design, not the current production contract. The current main branch still selects the local best successful candidate independently for each page; `templateDiversity` must not be advertised as available until the implementation and real MCP verification are merged.

## Goal

Select templates as a coherent deck instead of choosing the same per-page winner independently. The planner should increase layout variety when several candidates are genuinely deliverable, while preserving factual grounding, profile capacity, document policy, determinism, resumability, and image-asset transparency.

The behavior must be generic. It must not inspect page numbers, source phrases, template filenames beyond their declared identity, or the current four-page demo.

## Non-goals

- Do not redesign the existing HTML templates.
- Do not add a mandatory LLM call for ranking.
- Do not create images implicitly.
- Do not weaken fact coverage, critical-anchor, minimum-font, metadata-capacity, or document-policy gates.
- Do not force every page to use a unique template when the compatible catalog cannot support it.

## Decision

Use two-stage deterministic selection:

1. Build every honest, profile-budgeted candidate for every page.
2. Select the deck-wide candidate sequence with a bounded global optimizer.

Content understanding continues to come from the page blueprint and semantic planning result. The MCP then performs deterministic capability filtering and sequence optimization, so the feature works without an LLM API and produces the same result for the same source, catalog, and settings.

## Public contract

Add an optional `templateDiversity` field to `plan_deck`:

```ts
type TemplateDiversity = "off" | "conservative" | "balanced" | "expressive";
```

- Omitted means `balanced` for new plans.
- `off` preserves independent per-page winner selection.
- `conservative` breaks near-ties and avoids unnecessary adjacent repetition.
- `balanced` is the default and trades only a small bounded quality difference for useful layout rhythm.
- `expressive` admits a wider near-best band, but never bypasses hard compatibility gates.
- An explicit `templateSlug` disables diversity optimization and fixes every page to that template.
- `preferredThemeId` remains a theme filter; diversity may operate among compatible profiles within that theme.

New plans persist the effective mode in `plannedDeck.templateDiversity`. The field is optional when parsing historical plans so existing immutable artifacts remain readable. New plan fingerprints include the effective mode. Existing fingerprints remain valid because historical plans do not acquire a synthesized field during parsing.

## Candidate generation

`selectProfilePlan` becomes a candidate collector rather than an immediate winner selector. For each page and each identity-allowed profile, the current pipeline still performs:

- grounded display planning;
- critical-anchor preservation;
- deterministic template compatibility scoring;
- semantic slot solving;
- metadata and prompt-binding capacity checks;
- deterministic slide-spec materialization.

Failures remain bounded local diagnostics. Only fully feasible `CandidatePlan` values enter deck optimization.

For each page, the existing comparator identifies its quality reference candidate. Every other successful candidate receives:

- `retainedCharacterLoss`: best retained characters minus candidate retained characters;
- `retainedLossPercent`: that loss divided by the best retained characters;
- `selectionScoreLoss`: best template score minus candidate template score;
- catalog index for deterministic tie-breaking.

## Quality bands

Hard compatibility is identical in every mode. Diversity changes only which near-best candidates may compete.

| Mode | Retained-character loss | Selection-score loss |
|---|---:|---:|
| `off` | winner only | winner only |
| `conservative` | `0` | at most `3` |
| `balanced` | at most `min(18, max(6, floor(best × 3%)))` | at most `8` |
| `expressive` | at most `min(40, max(12, floor(best × 7%)))` | at most `15` |

These are relative-to-best admission bands, not permission to omit source facts or critical anchors. A candidate outside the selected band is unavailable to the global optimizer.

## Global optimizer

Use deterministic bounded beam dynamic programming with a compact state:

```text
page index × last template × sorted used-template set
```

The diversity objective needs only first use and adjacent repetition; it does not need arbitrary source history. To remain safe as learned template catalogs grow, retain at most the best 12 admitted candidates per page, deduplicate equivalent states by last template plus used-template set, and retain the best 256 states after every page. With the existing 30-page input bound, expansion is limited to at most `30 × 256 × 12` transitions. The same tie-breaker is used for pruning and final selection, so the result remains deterministic.

For an admitted candidate:

```text
qualityLoss = retainedLossPercent × 2 + selectionScoreLoss
utility = -qualityLoss
          + firstUseBonus(mode)
          - adjacentRepeatPenalty(mode)
```

| Mode | First-use bonus | Adjacent-repeat penalty |
|---|---:|---:|
| `off` | `0` | `0` |
| `conservative` | `2` | `4` |
| `balanced` | `8` | `10` |
| `expressive` | `14` | `18` |

Tie-breaking order is deterministic:

1. higher total utility;
2. higher total retained characters;
3. higher total template-selection score;
4. fewer adjacent repeats;
5. lexicographically smaller catalog-index sequence.

This rewards layout coverage without making uniqueness a hard constraint. Non-consecutive reuse is allowed and often desirable.

## Persisted evidence

Each selected slide continues to persist its complete `profileSnapshot`, capability hash, assignments, capacity use, candidate scores, source facts, display plan, and deterministic slide spec.

`templateMatch.selectionReason` gains a bounded deck-level suffix containing:

- effective diversity mode;
- candidate quality loss relative to the page winner;
- whether this was the first use of the template;
- whether an adjacent repeat was unavoidable or selected on quality grounds.

No physical paths, hidden prompts, arbitrary diagnostics, or raw model reasoning are persisted.

## Asset behavior

Different candidates may produce different deterministic image intents because their profile image capacities differ. Only assets belonging to the final selected sequence are returned from `plan_deck`.

If a selected template requires an image, the existing `needs_assets` contract remains unchanged. The MCP does not invoke an image provider and does not silently switch templates during `generate_deck`.

## Failure and degradation behavior

- One admitted candidate on a page: select it, even if it repeats the prior template.
- No admitted candidates after the quality band: retain the local quality winner as a safety fallback.
- No successful profile candidate: preserve the existing page planning error and bounded diagnostics.
- Explicit `templateSlug`: bypass the global optimizer and validate the forced profile per page.
- `off`: choose the current local winner for every page.
- Persisted plan resume: return the immutable stored sequence after catalog-capability validation; never re-optimize it.

## Compatibility

- `planDeckInputSchema.templateDiversity` is optional rather than schema-defaulted, preserving request canonicalization for callers that omit it.
- The workflow computes `effectiveTemplateDiversity = input.templateDiversity ?? "balanced"` for new plans.
- `plannedDeckSchema.templateDiversity` is optional for historical plan parsing, but present on all newly created plans.
- `hashPlannedDeckFingerprint` includes the field only when present, preserving historical fingerprints.
- Output sanitization and `get_deck` expose the effective persisted mode as ordinary non-sensitive plan evidence.

## Tests

Use test-first development with real candidate structures and workflow calls.

1. Four pages with multiple close compatible candidates select at least two template slugs in `balanced` mode and avoid an unnecessary adjacent repeat.
2. Heterogeneous page intents form a text/table/image-capable sequence when those candidates fall inside the quality band.
3. A candidate outside the retention or score band is never selected for novelty.
4. A page with only one successful candidate repeats safely.
5. Explicit `templateSlug` fixes all pages to the requested template.
6. `off` reproduces the current per-page winner sequence.
7. Repeated identical planning inputs produce the same template sequence and fingerprint.
8. Historical planned-deck fixtures without `templateDiversity` continue to parse and validate.
9. A 30-page catalog-growth fixture remains within the 12-candidate and 256-state bounds.
10. A real MCP `plan_deck` run over local `test.md` validates four pages, reports the selected template sequence and keeps every page's grounding and profile evidence valid.

## Acceptance criteria

- Default `balanced` produces more than one template for the current four-page source when at least two near-best compatible profiles exist.
- No selected page violates the existing hard gates.
- No special-case page, phrase, slug, or template-family logic is introduced.
- The selection is deterministic and resumable.
- README documents the new input and quality-first behavior.
- Type checking, production build, optimizer regression tests, plan schema compatibility tests, and real MCP planning smoke test pass.
