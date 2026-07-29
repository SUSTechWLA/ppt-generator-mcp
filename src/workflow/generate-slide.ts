import { performance } from "node:perf_hooks";
import { join } from "node:path";

import { generateSlideOutputSchema, type GenerateSlideOutput } from "../domain/quality-report.js";
import type { DocumentType, PageMetadata } from "../domain/document-context.js";
import type { DisplayPlan } from "../domain/display-plan.js";
import type { RunManifest, StageRecord, WorkflowStage } from "../domain/run-manifest.js";
import {
  generateSlideInputSchema,
  hashCanonical,
  qualitySettingsSchema,
  sourceDocumentSchema,
  type GenerateSlideRequest,
  type SourceDocument,
} from "../domain/source-document.js";
import type { AssetSpec, GeneratedAsset, SlideSpec } from "../domain/slide-spec.js";
import { templateProfileSchema, type TemplateProfile, type TemplateSelection } from "../domain/template-profile.js";
import { asWorkflowError } from "../domain/workflow-error.js";
import type { ComposeResult } from "../services/slide-composer.js";
import type { ExternalAsset } from "../services/asset-generator.js";
import type { DocumentTemplatePolicy } from "../services/template-selector.js";
import { validateFactReferences } from "../services/slide-spec-builder.js";
import {
  hasUnsafeDiagnosticValue,
  normalizeGenerateSlideOutputDiagnostics,
  normalizeQualityReportDiagnostics,
} from "../services/quality-safety.js";
import type { ActiveRun, RunStore } from "./run-store.js";
import type { QualityLoopResult } from "./quality-loop.js";

export interface WorkflowQualityInput {
  runId: string;
  runDir: string;
  source: SourceDocument;
  spec: SlideSpec;
  selection: TemplateSelection;
  assets: GeneratedAsset[];
  initialPage: ComposeResult;
  quality: GenerateSlideRequest["quality"];
  documentType?: DocumentType;
  preferredThemeId?: string;
  page?: PageMetadata;
  displayPlan?: DisplayPlan;
  expectedMetadataBindings?: Array<{ field: string; values: string[] }>;
  initialProfile?: TemplateProfile;
  requiredThemeId?: string;
  documentPolicy?: DocumentTemplatePolicy;
}

export interface PreparedSlideWorkflowInput {
  source: SourceDocument;
  plannedSpec: SlideSpec;
  selection: TemplateSelection;
  profile: TemplateProfile;
  externalAssets: ExternalAsset[];
  quality: GenerateSlideRequest["quality"];
  documentType: DocumentType;
  page: PageMetadata;
  displayPlan: DisplayPlan;
  expectedMetadataBindings: Array<{ field: string; values: string[] }>;
  requiredThemeId: string;
  documentPolicy: DocumentTemplatePolicy;
  requestId?: string;
}

export interface WorkflowDependencies {
  runStore: RunStore;
  profiles: TemplateProfile[];
  normalizeSource(input: GenerateSlideRequest): SourceDocument;
  buildSlideSpec(source: SourceDocument, audience?: string, documentType?: DocumentType): Promise<SlideSpec>;
  selectTemplate(spec: SlideSpec, forcedSlug?: string, documentType?: DocumentType, preferredThemeId?: string): TemplateSelection;
  generateAssets(runId: string, specs: AssetSpec[], externalAssets?: ExternalAsset[]): Promise<GeneratedAsset[]>;
  composeSlide(spec: SlideSpec, selection: TemplateSelection, assets: GeneratedAsset[], page?: PageMetadata): Promise<ComposeResult>;
  runQualityLoop(input: WorkflowQualityInput): Promise<QualityLoopResult>;
}

function outputFromManifest(manifest: RunManifest): GenerateSlideOutput {
  return generateSlideOutputSchema.parse(manifest.finalResult);
}

function stageFailure(error: unknown, startedAt: string, start: number): StageRecord {
  const safe = asWorkflowError(error, "workflow_stage");
  return {
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    error: { code: safe.code, message: safe.message, retryable: safe.retryable },
  };
}

async function runStage<T>(
  store: RunStore,
  run: ActiveRun,
  stage: WorkflowStage,
  execute: () => Promise<T> | T,
): Promise<T> {
  const restored = await store.readStageOutput<T>(run.runId, stage);
  if (restored.found) return restored.value;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  await store.updateStage(run.runId, stage, { status: "running", startedAt });
  try {
    const value = await execute();
    await store.writeStageOutput(run.runId, stage, value);
    await store.updateStage(run.runId, stage, {
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - start),
    });
    return value;
  } catch (error) {
    await store.updateStage(run.runId, stage, stageFailure(error, startedAt, start));
    throw error;
  }
}

interface ResolvedSlideWorkflowInput {
  source: SourceDocument;
  spec: SlideSpec;
  selection: TemplateSelection;
  externalAssets?: ExternalAsset[];
  quality: GenerateSlideRequest["quality"];
  documentType?: DocumentType;
  preferredThemeId?: string;
  page?: PageMetadata;
  displayPlan?: DisplayPlan;
  expectedMetadataBindings?: Array<{ field: string; values: string[] }>;
  initialProfile?: TemplateProfile;
  requiredThemeId?: string;
  documentPolicy?: DocumentTemplatePolicy;
}

async function executeResolvedSlideWorkflow(
  run: ActiveRun,
  input: ResolvedSlideWorkflowInput,
  deps: WorkflowDependencies,
): Promise<GenerateSlideOutput> {
  const { source, spec, selection } = input;
  const assets = await runStage(deps.runStore, run, "generate_assets", () => deps.generateAssets(run.runId, spec.assets, input.externalAssets));
  const initialPage = await runStage(deps.runStore, run, "compose_html", () => deps.composeSlide(spec, selection, assets, input.page));
  const profile = deps.profiles.find((candidate) => candidate.slug === selection.slug);
  await deps.runStore.updateWorkflowData(run.runId, {
    sourceHash: source.sourceHash,
    slideSpec: spec,
    assets: assets.map(({ id, promptHash, mimeType, filePath }) => ({ id, promptHash, mimeType, filePath, prompt: spec.assets.find((asset) => asset.id === id)?.prompt })),
    ...(profile ? { template: { slug: selection.slug, version: profile.version, reason: selection.reason } } : {}),
  });

  const rawLoop = await deps.runQualityLoop({
    runId: run.runId,
    runDir: deps.runStore.runDir(run.runId),
    source,
    spec,
    selection,
    assets,
    initialPage,
    quality: input.quality,
    documentType: input.documentType,
    preferredThemeId: input.preferredThemeId,
    page: input.page,
    displayPlan: input.displayPlan,
    expectedMetadataBindings: input.expectedMetadataBindings,
    initialProfile: input.initialProfile,
    requiredThemeId: input.requiredThemeId,
    documentPolicy: input.documentPolicy,
  });
  const loop: QualityLoopResult = {
    ...rawLoop,
    attempts: rawLoop.attempts.map((attempt) => ({
      ...attempt,
      quality: normalizeQualityReportDiagnostics(attempt.quality),
      actions: hasUnsafeDiagnosticValue(attempt.actions) ? [] : attempt.actions,
    })),
  };
  for (const attempt of loop.attempts) {
    if (!attempt.htmlPath || !attempt.qualityPath) throw new Error(`Attempt ${attempt.attempt} did not persist all artifacts`);
    await deps.runStore.saveAttempt(run.runId, {
      attempt: attempt.attempt,
      htmlPath: attempt.htmlPath,
      previewPath: attempt.screenshotPath,
      qualityPath: attempt.qualityPath,
      score: attempt.quality.score,
      hardGatePassed: attempt.quality.hardGatePassed,
      safeToReturn: attempt.quality.safeToReturn,
      actions: attempt.actions,
    });
  }

  const selectedNumber = loop.selectedAttempt ?? loop.attempts.at(-1)?.attempt;
  const selected = loop.attempts.find((attempt) => attempt.attempt === selectedNumber);
  if (!selected || !selected.htmlPath || !selected.qualityPath) throw new Error("Quality loop produced no selectable artifact");
  const selectedTemplateSlug = selected.state.templateSlug;
  const selectedProfile = deps.profiles.find((candidate) => candidate.slug === selectedTemplateSlug);
  if (!selectedProfile) throw new Error(`Selected attempt references an unknown template profile: ${selectedTemplateSlug}`);
  if (input.requiredThemeId && (selectedProfile.themeId !== input.requiredThemeId
    || selectedProfile.format !== input.initialProfile?.format
    || (input.documentType && !selectedProfile.documentCompatibility[input.documentType]))) {
    throw new Error("Selected repair template is not compatible with the persisted page theme, format, and document policy");
  }
  const selectedTemplateReason = selectedTemplateSlug === selection.slug
    ? selection.reason
    : "质量修复后切换到通过同一能力策略校验的替代模板。";
  await deps.runStore.updateWorkflowData(run.runId, {
    template: { slug: selectedTemplateSlug, version: selectedProfile.version, reason: selectedTemplateReason },
  });
  const promoted = await deps.runStore.promoteAttempt(run.runId, {
    attempt: selected.attempt,
    htmlPath: selected.htmlPath,
    previewPath: selected.screenshotPath,
    qualityPath: selected.qualityPath,
    score: selected.quality.score,
    hardGatePassed: selected.quality.hardGatePassed,
    safeToReturn: selected.quality.safeToReturn,
    actions: selected.actions,
  });
  const manifestPath = join(deps.runStore.runDir(run.runId), "manifest.json");
  const result = normalizeGenerateSlideOutputDiagnostics(generateSlideOutputSchema.parse({
    runId: run.runId,
    status: loop.status,
    selectedTemplate: { slug: selectedTemplateSlug, reason: selectedTemplateReason },
    artifacts: { htmlPath: promoted.htmlPath, previewPath: promoted.previewPath, manifestPath },
    quality: {
      score: selected.quality.score,
      threshold: input.quality.minScore,
      hardGatePassed: selected.quality.hardGatePassed,
      attempts: loop.attempts.length,
      dimensions: selected.quality.dimensions,
      remainingIssues: selected.quality.issues,
    },
    summary: loop.status === "delivered"
      ? `单页已通过全部硬门禁，质量分 ${selected.quality.score}。`
      : loop.status === "best_effort"
        ? `返回安全的最佳尝试，质量分 ${selected.quality.score}，请查看剩余问题。`
        : "没有尝试通过安全返回门禁，请检查质量报告。",
  }));
  await deps.runStore.finalize(run.runId, {
    status: result.status,
    selectedAttempt: selected.attempt,
    finalResult: result,
    artifacts: { htmlPath: promoted.htmlPath, previewPath: promoted.previewPath, qualityPath: promoted.qualityPath, manifestPath },
  });
  return result;
}

export async function generateSlideWorkflow(rawInput: unknown, deps: WorkflowDependencies): Promise<GenerateSlideOutput> {
  const input = generateSlideInputSchema.parse(rawInput);
  const run = await deps.runStore.createOrResume({ requestId: input.requestId, canonicalInput: input });
  if ((run.manifest.status === "delivered" || run.manifest.status === "best_effort") && run.manifest.finalResult) {
    return outputFromManifest(run.manifest);
  }

  const source = await runStage(deps.runStore, run, "normalize_input", () => deps.normalizeSource(input));
  const spec = await runStage(deps.runStore, run, "build_slide_spec", async () => {
    if (input.plannedSpec) {
      validateFactReferences(source, input.plannedSpec);
      return input.plannedSpec;
    }
    return deps.buildSlideSpec(source, input.audience, input.documentType);
  });
  const selection = await runStage(deps.runStore, run, "select_template", () => deps.selectTemplate(spec, input.templateSlug, input.documentType, input.preferredThemeId));
  return executeResolvedSlideWorkflow(run, {
    source,
    spec,
    selection,
    externalAssets: input.externalAssets,
    quality: input.quality,
    documentType: input.documentType,
    preferredThemeId: input.preferredThemeId,
    page: input.page,
  }, deps);
}

export async function generatePreparedSlideWorkflow(
  rawInput: PreparedSlideWorkflowInput,
  deps: WorkflowDependencies,
): Promise<GenerateSlideOutput> {
  const input = {
    ...rawInput,
    source: sourceDocumentSchema.parse(rawInput.source),
    profile: templateProfileSchema.parse(rawInput.profile),
    quality: qualitySettingsSchema.parse(rawInput.quality),
  };
  const loaded = deps.profiles.filter((profile) => profile.slug === input.profile.slug);
  if (loaded.length !== 1 || hashCanonical(loaded[0]) !== hashCanonical(input.profile)
    || input.selection.slug !== input.profile.slug
    || input.requiredThemeId !== input.profile.themeId
    || input.documentPolicy.documentType !== input.documentType
    || !input.profile.documentCompatibility[input.documentType]) {
    throw new Error("Prepared page profile context does not match the loaded persisted capability snapshot");
  }
  const run = await deps.runStore.createOrResume({
    requestId: input.requestId,
    canonicalInput: {
      sourceHash: input.source.sourceHash,
      plannedSpec: input.plannedSpec,
      selection: input.selection,
      page: input.page,
      quality: input.quality,
      requiredThemeId: input.requiredThemeId,
      externalAssetHashes: input.externalAssets.map((asset) => ({ id: asset.id, hash: hashCanonical(asset.dataUrl) })),
    },
  });
  if ((run.manifest.status === "delivered" || run.manifest.status === "best_effort") && run.manifest.finalResult) {
    return outputFromManifest(run.manifest);
  }
  return executeResolvedSlideWorkflow(run, {
    source: input.source,
    spec: input.plannedSpec,
    selection: input.selection,
    externalAssets: input.externalAssets,
    quality: input.quality,
    documentType: input.documentType,
    page: input.page,
    displayPlan: input.displayPlan,
    expectedMetadataBindings: input.expectedMetadataBindings,
    initialProfile: input.profile,
    requiredThemeId: input.requiredThemeId,
    documentPolicy: input.documentPolicy,
  }, deps);
}
