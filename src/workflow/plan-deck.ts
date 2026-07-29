import {
  planDeckInputSchema,
  planDeckOutputSchema,
  plannedDeckSchema,
  type deckTemplateMatchSchema,
} from "../domain/deck-plan.js";
import type { PageMetadata } from "../domain/document-context.js";
import { hashCanonical, type SourceDocument } from "../domain/source-document.js";
import type { PageBlueprint } from "../domain/page-blueprint.js";
import type { TemplateProfile, TemplateSelection } from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import {
  partitionDeckSource,
  type ExplicitPagePartition,
} from "../services/explicit-page-parser.js";
import {
  planGroundedDisplay,
  type GroundedDisplayContext,
  type GroundedDisplayResult,
} from "../services/grounded-display-planner.js";
import { materializeSlideSpec } from "../services/page-blueprint-builder.js";
import { selectTemplate } from "../services/template-selector.js";
import { solveTemplateSlots, type TemplateSlotSolution } from "../services/template-slot-solver.js";
import type { DeckStoreApi } from "./deck-store.js";

type PlanDeckInput = ReturnType<typeof planDeckInputSchema.parse>;
type PlanDeckOutput = ReturnType<typeof planDeckOutputSchema.parse>;
type DeckTemplateMatch = ReturnType<typeof deckTemplateMatchSchema.parse>;

export interface PlanDeckDependencies {
  deckStore: Pick<DeckStoreApi, "createOrResumePlan" | "savePlan" | "getPlan">;
  profiles: TemplateProfile[];
  partitionDeckSource(input: { sourceText: string; pageNumbers: number[] }): ExplicitPagePartition[];
  planGroundedDisplay(source: SourceDocument, context: GroundedDisplayContext): GroundedDisplayResult;
  selectTemplate(
    content: PageBlueprint,
    profiles: TemplateProfile[],
    forcedSlug?: string,
    documentType?: PlanDeckInput["documentType"],
    preferredThemeId?: string,
  ): TemplateSelection;
  solveTemplateSlots(content: PageBlueprint, profile: TemplateProfile): TemplateSlotSolution;
  materializeSlideSpec(content: PageBlueprint): ReturnType<typeof materializeSlideSpec>;
}

export function createPlanDeckDependencies(input: {
  deckStore: PlanDeckDependencies["deckStore"];
  profiles: TemplateProfile[];
}): PlanDeckDependencies {
  return {
    deckStore: input.deckStore,
    profiles: input.profiles,
    partitionDeckSource,
    planGroundedDisplay,
    selectTemplate,
    solveTemplateSlots,
    materializeSlideSpec,
  };
}

function planningError(message: string, recovery: string): never {
  throw new WorkflowError({
    code: "INPUT_INVALID",
    stage: "build_page_blueprint",
    retryable: false,
    message,
    recovery,
  });
}

function boundedHeading(value: string | undefined, fallback: string, maximum: number, label: string): string {
  const selected = value?.trim() || fallback;
  if (selected.length > maximum) {
    planningError(
      `${label} exceeds the display metadata capacity of ${maximum} characters`,
      `Shorten the labeled upstream heading without changing the page body. Received ${selected.length} characters.`,
    );
  }
  return selected;
}

function buildPageMetadata(partition: ExplicitPagePartition, pageIndex: number): PageMetadata {
  const headings = partition.headingMetadata;
  return {
    number: partition.pageNumber,
    sectionTitle: boundedHeading(headings.level1, "展示方案", 60, "一级标题"),
    partNumber: `PART.${String(pageIndex + 1).padStart(2, "0")}`,
    partLabel: boundedHeading(headings.level2, "方案响应", 30, "二级标题"),
    chapterLabel: boundedHeading(headings.level3 ?? headings.level2, "实施方案", 80, "三级标题"),
    subsectionTitle: boundedHeading(headings.level4 ?? partition.title, "关键要求", 100, "四级标题"),
  };
}

interface CandidatePlan {
  profile: TemplateProfile;
  grounded: GroundedDisplayResult;
  selection: TemplateSelection;
  solution: TemplateSlotSolution;
}

function allowedProfiles(input: PlanDeckInput, profiles: TemplateProfile[]): TemplateProfile[] {
  let candidates = profiles;
  if (input.templateSlug) candidates = candidates.filter((profile) => profile.slug === input.templateSlug);
  if (input.preferredThemeId) candidates = candidates.filter((profile) => profile.themeId === input.preferredThemeId);
  if (candidates.length === 0) {
    planningError(
      "No approved template profile matches the requested identity-independent constraints",
      `templateSlug=${input.templateSlug ?? "any"}; preferredThemeId=${input.preferredThemeId ?? "any"}. Inspect approved profile capabilities before retrying.`,
    );
  }
  return candidates;
}

function compareCandidates(left: CandidatePlan, right: CandidatePlan): number {
  if (left.grounded.retainedCharacterCount !== right.grounded.retainedCharacterCount) {
    return right.grounded.retainedCharacterCount - left.grounded.retainedCharacterCount;
  }
  if (left.selection.score !== right.selection.score) return right.selection.score - left.selection.score;
  const leftCapacityUse = left.grounded.blueprint.groups.length / left.profile.blockCapacity;
  const rightCapacityUse = right.grounded.blueprint.groups.length / right.profile.blockCapacity;
  if (leftCapacityUse !== rightCapacityUse) return Math.abs(1 - leftCapacityUse) - Math.abs(1 - rightCapacityUse);
  return left.profile.version.localeCompare(right.profile.version);
}

function planForProfile(
  partition: ExplicitPagePartition,
  input: PlanDeckInput,
  profile: TemplateProfile,
  deps: PlanDeckDependencies,
): CandidatePlan {
  const grounded = deps.planGroundedDisplay(partition.normalizedSource, {
    pageNumber: partition.pageNumber,
    title: partition.title,
    documentType: input.documentType,
    profile,
    ...(input.audience ? { audience: input.audience } : {}),
  });
  const selection = deps.selectTemplate(
    grounded.blueprint,
    [profile],
    profile.slug,
    input.documentType,
    input.preferredThemeId,
  );
  const solution = deps.solveTemplateSlots(grounded.blueprint, profile);
  if (!solution.feasible || solution.unmatched.length > 0 || solution.unrepresentedFactIds.length > 0) {
    planningError(
      "Grounded display plan does not fit its selected template profile",
      `profile=${profile.slug}; unmatched=${solution.unmatched.map((item) => item.reason).join(" | ") || "none"}; unrepresented=${solution.unrepresentedFactIds.join(",") || "none"}`,
    );
  }
  return { profile, grounded, selection, solution };
}

function selectProfilePlan(
  partition: ExplicitPagePartition,
  input: PlanDeckInput,
  deps: PlanDeckDependencies,
): CandidatePlan {
  const successes: CandidatePlan[] = [];
  const diagnostics: string[] = [];
  for (const profile of allowedProfiles(input, deps.profiles)) {
    try {
      successes.push(planForProfile(partition, input, profile, deps));
    } catch (error) {
      const structured = error instanceof WorkflowError
        ? `code=${error.code}; stage=${error.stage}; recovery=${error.recovery ?? "none"}`
        : "unstructured";
      diagnostics.push(`${profile.slug}: ${error instanceof Error ? error.message : "planning failed"} [${structured}]`.slice(0, 2_000));
    }
  }
  const winner = successes.sort(compareCandidates)[0];
  if (!winner) {
    planningError(
      `Page ${partition.pageNumber} has no honest profile-budgeted display plan`,
      diagnostics.join("; ").slice(0, 4_000) || "No compatible approved profiles were evaluated.",
    );
  }
  return winner;
}

function templateMatch(candidate: CandidatePlan): DeckTemplateMatch {
  const semanticItemCapacity = candidate.profile.semanticSlots.reduce((total, slot) => total + slot.itemCapacity, 0);
  return {
    themeId: candidate.profile.themeId,
    profileVersion: candidate.profile.version,
    selectionScore: candidate.selection.score,
    selectionReason: candidate.selection.reason,
    candidateScores: candidate.selection.candidates,
    blockCapacity: candidate.profile.blockCapacity,
    semanticItemCapacity,
    effectiveItemCapacity: candidate.grounded.displayPlan.targetBudget.itemCapacity,
    effectiveMaxCharsPerItem: candidate.grounded.displayPlan.targetBudget.maxCharsPerItem,
    minimumBodyFontPt: candidate.profile.minimumBodyFontPt,
    maxRasterAreaRatio: candidate.profile.maxRasterAreaRatio,
    assignments: candidate.solution.assignments,
    capacityUse: candidate.solution.capacityUse,
    transformations: candidate.solution.transformations,
    unmatched: candidate.solution.unmatched,
    representedFactIds: candidate.solution.representedFactIds,
    unrepresentedFactIds: candidate.solution.unrepresentedFactIds,
  };
}

export async function planDeckWorkflow(rawInput: unknown, deps: PlanDeckDependencies): Promise<PlanDeckOutput> {
  const input = planDeckInputSchema.parse(rawInput);
  const sourceText = input.sourceMarkdown ?? input.sourceText;
  if (!sourceText) planningError("Deck source string is missing", "Provide exactly one sourceMarkdown or sourceText string.");
  const active = await deps.deckStore.createOrResumePlan({ requestId: input.requestId, canonicalInput: input });
  if (active.plan !== undefined) return planDeckOutputSchema.parse(active.plan);

  const partitions = deps.partitionDeckSource({ sourceText, pageNumbers: input.pageNumbers });
  const slides = partitions.map((partition, pageIndex) => {
    const candidate = selectProfilePlan(partition, input, deps);
    const plannedSpec = deps.materializeSlideSpec(candidate.grounded.blueprint);
    return {
      page: buildPageMetadata(partition, pageIndex),
      sourceSections: partition.sourceSections,
      originalSourceSectionIds: partition.originalSourceSectionIds,
      originalSourceFactIds: partition.originalSourceFactIds,
      originalSourceFacts: partition.normalizedSource.facts,
      displayPlan: candidate.grounded.displayPlan,
      plannedSpec,
      templateSlug: candidate.profile.slug,
      templateMatch: templateMatch(candidate),
    };
  });
  const plannedDeck = plannedDeckSchema.parse({
    version: 1,
    deckPlanId: active.deckPlanId,
    sourceHash: hashCanonical({ sourceText }),
    documentType: input.documentType,
    ...(input.preferredThemeId ? { preferredThemeId: input.preferredThemeId } : {}),
    pageNumbers: input.pageNumbers,
    slides,
  });
  const assets = slides.flatMap((slide) => slide.plannedSpec.assets);
  const output = planDeckOutputSchema.parse({
    plannedDeck,
    assets,
    nextStep: assets.length > 0
      ? "Generate the returned page-scoped assets, then call generate_deck with externalAssets."
      : "No external image is required; call generate_deck with an empty externalAssets array.",
  });
  await deps.deckStore.savePlan(active.deckPlanId, output);
  return output;
}
