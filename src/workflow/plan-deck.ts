import {
  planDeckInputSchema,
  planDeckOutputSchema,
  plannedDeckSchema,
  hashPlannedDeckFingerprint,
  type deckTemplateMatchSchema,
} from "../domain/deck-plan.js";
import type { PageMetadata } from "../domain/document-context.js";
import { hashCanonical, type SourceDocument } from "../domain/source-document.js";
import type { PageBlueprint } from "../domain/page-blueprint.js";
import type { SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile, TemplateSelection } from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { extractCanonicalAnchors } from "../domain/critical-anchor.js";
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
import { validatePlanAgainstProfiles } from "../services/plan-profile-validator.js";
import { hashDeckSourceEvidence } from "../domain/deck-source-evidence.js";

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
  plannedSpec: SlideSpec;
  pageBindings: TemplateProfile["pageBindings"];
  metadataBindings: Array<{
    field: keyof TemplateProfile["pageBindings"];
    tag: string;
    values: string[];
    usedChars: number[];
    maxChars: number;
  }>;
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

const diagnosticErrorCodes = new Set([
  "INPUT_INVALID",
  "CONFIG_MISSING",
  "TEMPLATE_FAILED",
  "MODEL_FAILED",
  "ASSET_FAILED",
  "RENDER_FAILED",
  "QUALITY_FAILED",
  "INTERNAL_ERROR",
]);

const diagnosticStages = new Set([
  "build_page_blueprint",
  "select_template",
  "partition_deck_source",
  "parse_explicit_pages",
]);

function safeProfileIdentifier(slug: string): string {
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ? slug : "invalid-profile";
}

function safeFailureIdentity(error: unknown): { code: string; stage: string } {
  if (!(error instanceof WorkflowError)) return { code: "INTERNAL_ERROR", stage: "workflow" };
  return {
    code: diagnosticErrorCodes.has(error.code) ? error.code : "INTERNAL_ERROR",
    stage: diagnosticStages.has(error.stage) ? error.stage : "workflow",
  };
}

function knownMetadataOverflows(
  partition: ExplicitPagePartition,
  page: PageMetadata,
  profile: TemplateProfile,
): string {
  const knownValues: Partial<Record<keyof TemplateProfile["pageBindings"], string[]>> = {
    pageTitle: [partition.title],
    pageNumber: [String(page.number)],
    sectionTitle: [page.sectionTitle],
    partNumber: [page.partNumber],
    partLabel: [page.partLabel],
    chapterLabel: [page.chapterLabel],
    topicTitle: [partition.title],
    subsectionTitle: [page.subsectionTitle],
  };
  const failures: string[] = [];
  for (const [field, values] of Object.entries(knownValues)) {
    const typedField = field as keyof TemplateProfile["pageBindings"];
    const tag = profile.pageBindings[typedField];
    if (!tag) {
      failures.push(`${field}:capacity=invalid`);
      continue;
    }
    const maximum = profile.maxCharsBySlot[tag];
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      failures.push(`${field}:capacity=invalid`);
      continue;
    }
    const used = Math.max(...(values ?? []).map((value) => Array.from(value).length), 0);
    if (used > maximum) failures.push(`${field}:used=${used},max=${maximum}`);
  }
  return failures.join("|") || "none";
}

/**
 * Build candidate diagnostics exclusively from already-validated local structures.
 * Dependency-provided messages, recoveries, causes, run ids, and stack traces must
 * never become part of the public planning error.
 */
function localCandidateDiagnostic(
  error: unknown,
  partition: ExplicitPagePartition,
  page: PageMetadata,
  profile: TemplateProfile,
): string {
  const identity = safeFailureIdentity(error);
  const facts = partition.normalizedSource.facts;
  const semanticPositions = profile.semanticSlots.reduce((total, slot) => total + slot.itemCapacity, 0);
  const factBindingPositions = profile.semanticSlots.reduce(
    (total, slot) => {
      const expansion = slot.bindingExpansion[slot.factBearingBinding];
      const hasCompleteFactBinding = Boolean(slot.bindings[slot.factBearingBinding])
        && expansion !== undefined
        && slot.factBearingValueIndex < expansion;
      return total + (hasCompleteFactBinding ? slot.itemCapacity : 0);
    },
    0,
  );
  const factBearingLimits = profile.semanticSlots
    .map((slot) => {
      const tag = slot.bindings[slot.factBearingBinding];
      return tag ? (profile.maxCharsBySlot[tag] ?? slot.maxCharsPerItem) : slot.maxCharsPerItem;
    })
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const effectivePositions = Math.min(profile.blockCapacity, semanticPositions, factBindingPositions);
  const maxFactChars = facts.reduce((maximum, fact) => Math.max(maximum, Array.from(fact.text).length), 0);
  return [
    `profile=${safeProfileIdentifier(profile.slug)}`,
    `code=${identity.code}`,
    `stage=${identity.stage}`,
    `facts=${facts.length}`,
    `anchors=${extractCanonicalAnchors(partition.body).length}`,
    `sourceChars=${Array.from(partition.body).length}`,
    `maxFactChars=${maxFactChars}`,
    `blockCapacity=${profile.blockCapacity}`,
    `semanticPositions=${semanticPositions}`,
    `factBindingPositions=${factBindingPositions}`,
    `effectivePositions=${effectivePositions}`,
    `tightestFactChars=${factBearingLimits.length > 0 ? Math.min(...factBearingLimits) : 0}`,
    `metadataOverflow=${knownMetadataOverflows(partition, page, profile)}`,
  ].join("; ");
}

function planForProfile(
  partition: ExplicitPagePartition,
  page: PageMetadata,
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
  const plannedSpec = deps.materializeSlideSpec(grounded.blueprint);
  const blockById = new Map(plannedSpec.blocks.map((block) => [block.id, block]));
  const images = plannedSpec.assets.filter((asset) => asset.type === "image");
  const values: Record<keyof TemplateProfile["pageBindings"], string[]> = {
    pageTitle: [plannedSpec.title],
    pageNumber: [String(page.number)],
    sectionTitle: [page.sectionTitle],
    partNumber: [page.partNumber],
    partLabel: [page.partLabel],
    chapterLabel: [page.chapterLabel],
    topicTitle: [plannedSpec.title],
    subsectionTitle: [page.subsectionTitle],
    summaryText: [plannedSpec.conclusion],
    imageCaption: images.map((asset) => asset.alt),
    figureRef: images.map((asset) => blockById.get(asset.blockId)?.title ?? asset.alt),
  };
  const metadataBindings = Object.entries(profile.pageBindings).map(([field, tag]) => {
    const typedField = field as keyof TemplateProfile["pageBindings"];
    const maxChars = profile.maxCharsBySlot[tag];
    if (!maxChars) {
      planningError(
        "Profile page binding has no declared character capacity",
        `profile=${profile.slug}; field=${field}; tag=${tag}`,
      );
    }
    const emitted = values[typedField];
    const usedChars = emitted.map((value) => Array.from(value).length);
    const overflow = usedChars.find((used) => used > maxChars);
    if (overflow !== undefined) {
      planningError(
        "Page metadata does not fit the candidate profile",
        `profile=${profile.slug}; field=${field}; tag=${tag}; used=${overflow}; max=${maxChars}`,
      );
    }
    return { field: typedField, tag, values: emitted, usedChars, maxChars };
  });
  return { profile, grounded, selection, solution, plannedSpec, pageBindings: profile.pageBindings, metadataBindings };
}

function selectProfilePlan(
  partition: ExplicitPagePartition,
  page: PageMetadata,
  input: PlanDeckInput,
  deps: PlanDeckDependencies,
): CandidatePlan {
  const successes: CandidatePlan[] = [];
  const diagnostics: string[] = [];
  for (const profile of allowedProfiles(input, deps.profiles)) {
    try {
      successes.push(planForProfile(partition, page, input, profile, deps));
    } catch (error) {
      diagnostics.push(localCandidateDiagnostic(error, partition, page, profile));
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
    pageBindings: candidate.pageBindings,
    metadataBindings: candidate.metadataBindings,
    profileSnapshot: candidate.profile,
    profileCapabilityHash: hashCanonical(candidate.profile),
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
  if (active.plan !== undefined) {
    const resumed = planDeckOutputSchema.parse(active.plan);
    const validation = validatePlanAgainstProfiles(resumed.plannedDeck, deps.profiles);
    if (!validation.passed) planningError("Persisted plan profile capabilities no longer match the loaded catalog", validation.issues.join("; "));
    return resumed;
  }

  const partitions = deps.partitionDeckSource({ sourceText, pageNumbers: input.pageNumbers });
  const slides = partitions.map((partition, pageIndex) => {
    const page = buildPageMetadata(partition, pageIndex);
    const candidate = selectProfilePlan(partition, page, input, deps);
    return {
      page,
      sourceSections: partition.sourceSections,
      originalSourceSectionIds: partition.originalSourceSectionIds,
      originalSourceFactIds: partition.originalSourceFactIds,
      originalSourceFacts: partition.normalizedSource.facts,
      displayPlan: candidate.grounded.displayPlan,
      plannedSpec: candidate.plannedSpec,
      templateSlug: candidate.profile.slug,
      templateMatch: templateMatch(candidate),
    };
  });
  const planEvidence = {
    version: 1,
    deckPlanId: active.deckPlanId,
    sourceHash: hashDeckSourceEvidence({ pageNumbers: input.pageNumbers, slides }),
    documentType: input.documentType,
    quality: input.quality,
    ...(input.preferredThemeId ? { preferredThemeId: input.preferredThemeId } : {}),
    pageNumbers: input.pageNumbers,
    slides,
  } as const;
  const plannedDeck = plannedDeckSchema.parse({
    ...planEvidence,
    planFingerprint: hashPlannedDeckFingerprint(planEvidence),
  });
  const profileValidation = validatePlanAgainstProfiles(plannedDeck, deps.profiles);
  if (!profileValidation.passed) {
    planningError("Planned deck profile capabilities do not match the loaded catalog", profileValidation.issues.join("; "));
  }
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
