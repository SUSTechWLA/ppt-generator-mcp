import { createHash, randomUUID } from "node:crypto";

import {
  generateDeckInputSchema,
  generateDeckOutputSchema,
  planDeckOutputSchema,
  type PlannedDeck,
} from "../domain/deck-plan.js";
import type { DisplayPlan } from "../domain/display-plan.js";
import type { PageMetadata } from "../domain/document-context.js";
import { generateSlideOutputSchema, type GenerateSlideOutput } from "../domain/quality-report.js";
import {
  hashCanonical,
  sourceDocumentSchema,
  type SourceDocument,
  type SourceSectionInput,
} from "../domain/source-document.js";
import type { SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile, TemplateSelection } from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { validateExternalAssetDataUrl, type ExternalAsset } from "../services/asset-generator.js";
import {
  evaluateDeckConsistency,
  type DeckConsistencyPage,
  type DeckConsistencyReport,
} from "../services/deck-consistency.js";
import { validatePlanAgainstProfiles } from "../services/plan-profile-validator.js";
import { normalizeGenerateSlideOutputDiagnostics } from "../services/quality-safety.js";
import {
  getDocumentTemplatePolicy,
  type DocumentTemplatePolicy,
} from "../services/template-selector.js";
import type { DeckStoreApi } from "./deck-store.js";

type GenerateDeckOutput = ReturnType<typeof generateDeckOutputSchema.parse>;
type DeckSlidePlan = PlannedDeck["slides"][number];

export interface PlannedPageWorkflowInput {
  deckPlanId: string;
  deckRunId: string;
  pageIndex: number;
  sourceSections: SourceSectionInput[];
  source: SourceDocument;
  displayPlan: DisplayPlan;
  plannedSpec: SlideSpec;
  page: PageMetadata;
  selection: TemplateSelection;
  profile: TemplateProfile;
  themeId: string;
  documentPolicy: DocumentTemplatePolicy;
  expectedMetadataBindings: Array<{ field: string; values: string[] }>;
  externalAssets: ExternalAsset[];
  quality: { minScore: number; maxAttempts: number };
  requestId: string;
}

export interface GenerateDeckDependencies {
  deckStore: Pick<DeckStoreApi,
    | "getPlan"
    | "createOrResumeRun"
    | "mergeAssetHashes"
    | "markNeedsAssets"
    | "markUnavailableBytes"
    | "hasDeliveredPage"
    | "savePageResult"
    | "savePageFailure"
    | "listPageRecords"
    | "finalizeRun"
    | "getRun"
  >;
  profiles: TemplateProfile[];
  generatePage(input: PlannedPageWorkflowInput): Promise<GenerateSlideOutput>;
  inspectDeliveredPage(input: PlannedPageWorkflowInput, result: GenerateSlideOutput): Promise<DeckConsistencyPage>;
  validateExternalAsset(dataUrl: string): { bytes: Buffer };
  evaluateConsistency(input: {
    plannedDeck: PlannedDeck;
    loadedProfiles: TemplateProfile[];
    pages: DeckConsistencyPage[];
  }): DeckConsistencyReport;
  getDocumentPolicy(documentType: PlannedDeck["documentType"]): DocumentTemplatePolicy;
}

export function createGenerateDeckDependencies(input: {
  deckStore: GenerateDeckDependencies["deckStore"];
  profiles: TemplateProfile[];
  generatePage: GenerateDeckDependencies["generatePage"];
  inspectDeliveredPage: GenerateDeckDependencies["inspectDeliveredPage"];
  maxImageBytes?: number;
}): GenerateDeckDependencies {
  const maxImageBytes = input.maxImageBytes ?? Number.MAX_SAFE_INTEGER;
  return {
    ...input,
    validateExternalAsset: (dataUrl) => validateExternalAssetDataUrl(dataUrl, maxImageBytes),
    evaluateConsistency: evaluateDeckConsistency,
    getDocumentPolicy: getDocumentTemplatePolicy,
  };
}

function assetHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pageSource(slide: DeckSlidePlan): SourceDocument {
  return sourceDocumentSchema.parse({
    language: "zh-CN",
    title: slide.page.subsectionTitle,
    sections: slide.sourceSections.map((section, index) => ({
      id: slide.originalSourceSectionIds[index],
      heading: section.heading,
      body: section.body,
      keyPoints: section.keyPoints ?? [],
      order: index,
    })),
    facts: slide.originalSourceFacts,
    sourceHash: hashCanonical({
      sectionIds: slide.originalSourceSectionIds,
      sections: slide.sourceSections,
      facts: slide.originalSourceFacts,
    }),
  });
}

function pageInput(
  deck: PlannedDeck,
  deckRunId: string,
  slide: DeckSlidePlan,
  pageIndex: number,
  externalAssets: ExternalAsset[],
  policy: DocumentTemplatePolicy,
): PlannedPageWorkflowInput {
  return {
    deckPlanId: deck.deckPlanId,
    deckRunId,
    pageIndex,
    sourceSections: slide.sourceSections,
    source: pageSource(slide),
    displayPlan: slide.displayPlan,
    plannedSpec: slide.plannedSpec,
    page: slide.page,
    selection: {
      slug: slide.templateSlug,
      score: slide.templateMatch.selectionScore,
      reason: slide.templateMatch.selectionReason,
      candidates: slide.templateMatch.candidateScores,
    },
    profile: slide.templateMatch.profileSnapshot,
    themeId: slide.templateMatch.themeId,
    documentPolicy: policy,
    expectedMetadataBindings: slide.templateMatch.metadataBindings.map(({ field, values }) => ({ field, values })),
    externalAssets,
    quality: deck.quality,
    requestId: `${deckRunId}-${slide.page.number}-${randomUUID()}`,
  };
}

function validatePageResult(result: unknown, input: PlannedPageWorkflowInput, profiles: TemplateProfile[]): GenerateSlideOutput {
  const parsed = normalizeGenerateSlideOutputDiagnostics(generateSlideOutputSchema.parse(result));
  if (parsed.quality.threshold !== input.quality.minScore
    || parsed.quality.attempts > input.quality.maxAttempts) {
    throw new WorkflowError({
      code: "QUALITY_FAILED",
      stage: "quality_loop",
      retryable: true,
      message: "Page result did not use the persisted deck quality bounds",
    });
  }
  if (parsed.status === "delivered" && (!parsed.quality.hardGatePassed || parsed.quality.score < input.quality.minScore)) {
    throw new WorkflowError({
      code: "QUALITY_FAILED",
      stage: "quality_loop",
      retryable: true,
      message: "Page claimed delivery without passing persisted quality gates",
    });
  }
  const matches = profiles.filter((profile) => profile.slug === parsed.selectedTemplate.slug);
  const selected = matches[0];
  if (matches.length !== 1 || !selected || selected.themeId !== input.themeId
    || selected.format !== input.profile.format
    || !selected.documentCompatibility[input.documentPolicy.documentType]) {
    throw new WorkflowError({
      code: "TEMPLATE_FAILED",
      stage: "select_template",
      retryable: true,
      message: "Page result selected a template outside the persisted compatible theme",
    });
  }
  return parsed;
}

function orderedPages(output: GenerateDeckOutput, pageNumbers: number[]): GenerateDeckOutput {
  const order = new Map(pageNumbers.map((pageNumber, index) => [pageNumber, index]));
  return generateDeckOutputSchema.parse({
    ...output,
    pages: output.pages.slice().sort((left, right) => (order.get(left.pageNumber) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.pageNumber) ?? Number.MAX_SAFE_INTEGER)),
  });
}

async function saveResultMonotonically(
  deps: GenerateDeckDependencies,
  deckRunId: string,
  pageNumber: number,
  result: GenerateSlideOutput,
  verifiedAssetHashes: Record<string, string>,
): Promise<void> {
  try {
    await deps.deckStore.savePageResult(deckRunId, pageNumber, result, verifiedAssetHashes);
  } catch (error) {
    if (await deps.deckStore.hasDeliveredPage(deckRunId, pageNumber)) return;
    throw error;
  }
}

async function saveFailureMonotonically(
  deps: GenerateDeckDependencies,
  deckRunId: string,
  pageNumber: number,
  error: unknown,
  verifiedAssetHashes: Record<string, string>,
): Promise<void> {
  try {
    await deps.deckStore.savePageFailure(deckRunId, pageNumber, error, verifiedAssetHashes);
  } catch (mutationError) {
    if (await deps.deckStore.hasDeliveredPage(deckRunId, pageNumber)) return;
    throw mutationError;
  }
}

function requiredAssets(deck: PlannedDeck): Set<string> {
  return new Set(deck.slides.flatMap((slide) => slide.plannedSpec.assets.map((asset) => asset.id)));
}

export async function generateDeckWorkflow(rawInput: unknown, deps: GenerateDeckDependencies): Promise<GenerateDeckOutput> {
  const input = generateDeckInputSchema.parse(rawInput);
  const persisted = planDeckOutputSchema.parse(await deps.deckStore.getPlan(input.deckPlanId));
  const deck = persisted.plannedDeck;
  if (deck.deckPlanId !== input.deckPlanId) throw new Error("Persisted deck plan identity mismatch");
  const profileValidation = validatePlanAgainstProfiles(deck, deps.profiles);
  if (!profileValidation.passed) throw new Error("Persisted plan profile capabilities no longer match the loaded catalog");

  const allAssetIds = requiredAssets(deck);
  const suppliedIds = input.externalAssets.map((asset) => asset.id);
  if (new Set(suppliedIds).size !== suppliedIds.length) throw new Error("Duplicate external asset IDs are not allowed");
  const unknown = suppliedIds.filter((assetId) => !allAssetIds.has(assetId));
  if (unknown.length > 0) throw new Error(`Unknown external asset IDs: ${unknown.join(",")}`);

  const suppliedHashes = Object.fromEntries(input.externalAssets.map((asset) => {
    const parsed = deps.validateExternalAsset(asset.dataUrl);
    return [asset.id, assetHash(parsed.bytes)];
  }));

  const active = await deps.deckStore.createOrResumeRun({
    requestId: input.requestId,
    canonicalInput: { deckPlanId: deck.deckPlanId },
    deckPlanId: deck.deckPlanId,
  });
  for (const [assetId, hash] of Object.entries(suppliedHashes)) {
    const existing = active.manifest.assetHashes[assetId];
    if (existing && existing !== hash) throw new Error(`Asset hash replacement rejected for ${assetId}`);
  }

  if (active.manifest.status === "delivered") {
    const output = await deps.deckStore.finalizeRun(active.deckRunId, {
      pages: active.manifest.pages,
      ...(active.manifest.consistency ? { consistency: active.manifest.consistency } : {}),
    });
    return orderedPages(output, deck.pageNumbers);
  }

  const deliveredNumbers = new Set(active.manifest.pages.filter((record) => record.status === "delivered").map((record) => record.pageNumber));
  const pendingAssetScopes = deck.slides
    .filter((slide) => !deliveredNumbers.has(slide.page.number))
    .map((slide) => ({
      pageNumber: slide.page.number,
      assetIds: slide.plannedSpec.assets.map((asset) => asset.id).filter((assetId) => !suppliedIds.includes(assetId)),
    }))
    .filter((scope) => scope.assetIds.length > 0);
  const supplied = new Set(suppliedIds);
  const missing = pendingAssetScopes.flatMap((scope) => scope.assetIds).filter((assetId) => !supplied.has(assetId));
  if (missing.length > 0) {
    return orderedPages(await deps.deckStore.markUnavailableBytes(active.deckRunId, missing, pendingAssetScopes), deck.pageNumbers);
  }
  await deps.deckStore.mergeAssetHashes(active.deckRunId, suppliedHashes);

  const policy = deps.getDocumentPolicy(deck.documentType);
  const assetsById = new Map(input.externalAssets.map((asset) => [asset.id, asset]));
  for (const [pageIndex, slide] of deck.slides.entries()) {
    if (await deps.deckStore.hasDeliveredPage(active.deckRunId, slide.page.number)) continue;
    const pageAssets = slide.plannedSpec.assets.map((asset) => assetsById.get(asset.id)).filter((asset): asset is ExternalAsset => Boolean(asset));
    const workflowInput = pageInput(deck, active.deckRunId, slide, pageIndex, pageAssets, policy);
    try {
      const result = validatePageResult(await deps.generatePage(workflowInput), workflowInput, deps.profiles);
      await saveResultMonotonically(deps, active.deckRunId, slide.page.number, result, suppliedHashes);
    } catch (error) {
      await saveFailureMonotonically(deps, active.deckRunId, slide.page.number, error, suppliedHashes);
    }
  }

  const records = await deps.deckStore.listPageRecords(active.deckRunId);
  const recordByNumber = new Map(records.map((record) => [record.pageNumber, record]));
  const orderedRecords = deck.pageNumbers.map((pageNumber) => recordByNumber.get(pageNumber)).filter((record): record is NonNullable<typeof record> => Boolean(record));
  let consistency: DeckConsistencyReport | undefined;
  if (orderedRecords.length === deck.slides.length && orderedRecords.every((record) => record.status === "delivered" && record.result)) {
    try {
      const pages: DeckConsistencyPage[] = [];
      for (const [pageIndex, slide] of deck.slides.entries()) {
        const record = recordByNumber.get(slide.page.number)!;
        const workflowInput = pageInput(deck, active.deckRunId, slide, pageIndex, [], policy);
        pages.push(await deps.inspectDeliveredPage(workflowInput, record.result!));
      }
      consistency = deps.evaluateConsistency({ plannedDeck: deck, loadedProfiles: deps.profiles, pages });
    } catch {
      consistency = { passed: false, issues: ["Deck consistency evaluation failed"] };
    }
  }
  const output = await deps.deckStore.finalizeRun(active.deckRunId, {
    pages: orderedRecords,
    ...(consistency ? { consistency } : {}),
  });
  return orderedPages(output, deck.pageNumbers);
}
