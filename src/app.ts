import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AppConfig } from "./config/env.js";
import type { GeneratedAsset } from "./domain/slide-spec.js";
import type { PptMcpDependencies } from "./mcp/register-tools.js";
import {
  createOpenAICompatibleImageProvider,
  createOpenAICompatibleReviewProvider,
  createOpenAICompatibleTextProvider,
} from "./providers/openai-compatible.js";
import { generateAssets } from "./services/asset-generator.js";
import { composeSlide } from "./services/slide-composer.js";
import { normalizeSource } from "./services/content-normalizer.js";
import { buildDeterministicSlideSpec, constrainSlideSpecToPlanningPolicy } from "./services/deterministic-slide-spec.js";
import { evaluateDeterministic } from "./services/deterministic-evaluator.js";
import { renderPage, type RenderResult } from "./services/page-renderer.js";
import { executeRepairs } from "./services/repair-executor.js";
import { evaluateSlide } from "./services/slide-evaluator.js";
import { normalizeQualityReportDiagnostics } from "./services/quality-safety.js";
import { buildSlideSpec } from "./services/slide-spec-builder.js";
import { getDocumentTemplatePolicy, loadTemplateProfiles, selectTemplate } from "./services/template-selector.js";
import { loadTemplate } from "./lib/template-parser.js";
import { runQualityLoop } from "./workflow/quality-loop.js";
import { RunStore } from "./workflow/run-store.js";
import { DeckStore } from "./workflow/deck-store.js";
import {
  createPlanDeckDependencies,
  planDeckWorkflow,
  type PlanDeckDependencies,
} from "./workflow/plan-deck.js";
import {
  createGenerateDeckDependencies,
  generateDeckWorkflow,
  type GenerateDeckDependencies,
} from "./workflow/generate-deck.js";
import { generatePreparedSlideWorkflow } from "./workflow/generate-slide.js";

export interface ProductionDependencies extends PptMcpDependencies {
  deckStore: DeckStore;
  planDeckDependencies: PlanDeckDependencies;
  planDeck(rawInput: unknown): ReturnType<typeof planDeckWorkflow>;
  generateDeckDependencies: GenerateDeckDependencies;
  generateDeck(rawInput: unknown): ReturnType<typeof generateDeckWorkflow>;
}

export function createProductionDependencies(
  config: AppConfig,
  options: { templatesDir?: string } = {},
): ProductionDependencies {
  const templatesDir = resolve(options.templatesDir ?? join(process.cwd(), "templates"));
  const profiles = loadTemplateProfiles(templatesDir);
  const defaultIconBasePath = join(dirname(loadTemplate(templatesDir, profiles[0].slug).filePath), "assets", "icons");
  const textProvider = config.llm
    ? createOpenAICompatibleTextProvider(config.llm, config.limits.requestTimeoutMs)
    : undefined;
  const imageProvider = config.image
    ? createOpenAICompatibleImageProvider(config.image, config.limits.requestTimeoutMs)
    : undefined;
  const reviewProvider = config.review
    ? createOpenAICompatibleReviewProvider(config.review, config.limits.requestTimeoutMs)
    : undefined;
  const runStore = new RunStore(config.outputRoot);
  const deckStore = new DeckStore(config.outputRoot);
  const planDeckDependencies = createPlanDeckDependencies({ deckStore, profiles });

  const baseDependencies: Omit<ProductionDependencies, "generateDeckDependencies" | "generateDeck"> = {
    templatesDir,
    runStore,
    profiles,
    deckStore,
    planDeckDependencies,
    planDeck: (rawInput) => planDeckWorkflow(rawInput, planDeckDependencies),
    normalizeSource,
    buildSlideSpec: async (source, audience, documentType) => {
      const policy = getDocumentTemplatePolicy(documentType ?? "presentation");
      const planningPolicy = { maxRasterAreaRatio: policy.maxRasterAreaRatio, maxImageAssets: policy.maxImageAssets };
      return textProvider
        ? constrainSlideSpecToPlanningPolicy(await buildSlideSpec(source, textProvider, audience), planningPolicy)
        : buildDeterministicSlideSpec(source, planningPolicy);
    },
    selectTemplate: (spec, forcedSlug, documentType, preferredThemeId) => selectTemplate(spec, profiles, forcedSlug, documentType, preferredThemeId),
    generateAssets: async (runId, specs, externalAssets) => generateAssets({
      specs,
      provider: imageProvider,
      outputDir: join(runStore.runDir(runId), "assets"),
      allowedHosts: config.image?.allowedHosts ?? [],
      maxBytes: config.limits.maxImageBytes,
      timeoutMs: config.limits.requestTimeoutMs,
      existing: [],
      externalAssets,
      iconBasePath: defaultIconBasePath,
      cacheIdentity: { model: config.image?.model ?? "agent-imagegen", templateVersion: "1.0.0" },
    }),
    composeSlide: async (spec, selection, assets, page) => {
      const profile = profiles.find((candidate) => candidate.slug === selection.slug);
      if (!profile) throw new Error(`Approved profile not found: ${selection.slug}`);
      return composeSlide({ spec, template: loadTemplate(templatesDir, selection.slug), profile, assets, page });
    },
    runQualityLoop: async (workflowInput) => {
      const renderByAttempt = new Map<number, RenderResult>();
      const initialState = {
        spec: workflowInput.spec,
        assets: workflowInput.assets,
        templateSlug: workflowInput.selection.slug,
        designTokens: { fontScale: 1, spacingScale: 1, contrastMode: "normal" as const },
        templateSwitched: false,
      };
      return runQualityLoop({
        initialState,
        minScore: workflowInput.quality.minScore,
        maxAttempts: workflowInput.quality.maxAttempts,
        compose: async ({ state, attempt }) => {
          const directory = join(workflowInput.runDir, "attempts", String(attempt).padStart(2, "0"));
          await mkdir(directory, { recursive: true });
          const htmlPath = join(directory, "page.html");
          const screenshotPath = join(directory, "preview.png");
          const qualityPath = join(directory, "quality.json");
          const profile = profiles.find((candidate) => candidate.slug === state.templateSlug);
          if (!profile) throw new Error(`Approved profile not found: ${state.templateSlug}`);
          if (workflowInput.requiredThemeId && (profile.themeId !== workflowInput.requiredThemeId
            || profile.format !== workflowInput.initialProfile?.format
            || (workflowInput.documentType && !profile.documentCompatibility[workflowInput.documentType]))) {
            throw new Error("Repair template is incompatible with the persisted theme, format, or document policy");
          }
          const composed = attempt === 1 && state.templateSlug === workflowInput.selection.slug
            ? workflowInput.initialPage
            : await composeSlide({
                spec: state.spec,
                template: loadTemplate(templatesDir, state.templateSlug),
                profile,
                assets: state.assets,
                page: workflowInput.page,
                designTokens: state.designTokens,
              });
          await writeFile(htmlPath, composed.html);
          const render = await renderPage({
            html: composed.html,
            screenshotPath,
            validatedOverlapPairs: profile.overlapExemptions,
          });
          renderByAttempt.set(attempt, render);
          return { html: composed.html, htmlPath, screenshotPath, qualityPath };
        },
        evaluate: async ({ state, attempt, composed }) => {
          const render = renderByAttempt.get(attempt);
          if (!render) throw new Error(`Render result missing for attempt ${attempt}`);
          const profile = profiles.find((candidate) => candidate.slug === state.templateSlug);
          if (!profile) throw new Error(`Approved profile not found: ${state.templateSlug}`);
          const policy = workflowInput.documentPolicy ?? getDocumentTemplatePolicy(workflowInput.documentType ?? "presentation");
          const deterministic = evaluateDeterministic(render, {
            maxRasterAreaRatio: Math.min(profile.maxRasterAreaRatio, policy.maxRasterAreaRatio),
            maximumRasterAssets: policy.maxImageAssets,
            minimumBodyFontPt: Math.max(profile.minimumBodyFontPt, policy.minimumBodyFontPt),
            profile,
            documentPolicy: policy,
            ...(workflowInput.page ? { expectedPageNumber: workflowInput.page.number } : {}),
            ...(workflowInput.expectedMetadataBindings ? { expectedMetadataBindings: workflowInput.expectedMetadataBindings } : {}),
            ...(workflowInput.displayPlan ? { displayPlan: workflowInput.displayPlan, plannedSpec: workflowInput.spec } : {}),
          });
          const quality = normalizeQualityReportDiagnostics(await evaluateSlide({
            source: workflowInput.source,
            spec: state.spec,
            render,
            deterministic,
            review: reviewProvider,
          }));
          if (!composed.qualityPath) throw new Error(`Quality path missing for attempt ${attempt}`);
          await writeFile(composed.qualityPath, `${JSON.stringify({ ...quality, deterministic }, null, 2)}\n`);
          return quality;
        },
        repair: async ({ state, actions }) => executeRepairs({
          state,
          actions,
          source: workflowInput.source,
          switchTemplate: async (current) => {
            const compatibleProfiles = workflowInput.requiredThemeId
              ? profiles.filter((profile) => profile.themeId === workflowInput.requiredThemeId
                && profile.format === workflowInput.initialProfile?.format
                && (!workflowInput.documentType || profile.documentCompatibility[workflowInput.documentType]))
              : profiles;
            const selection = selectTemplate(
              current.spec,
              compatibleProfiles,
              undefined,
              workflowInput.documentType,
              workflowInput.requiredThemeId ?? workflowInput.preferredThemeId,
            );
            return selection.candidates.find((candidate) => candidate.slug !== current.templateSlug)?.slug ?? current.templateSlug;
          },
          regenerateAsset: async (assetId, current) => {
            const spec = current.spec.assets.find((candidate) => candidate.id === assetId);
            if (!spec || !imageProvider) return current.assets.find((candidate) => candidate.id === assetId) as GeneratedAsset;
            const [asset] = await generateAssets({
              specs: [spec],
              provider: imageProvider,
              outputDir: join(workflowInput.runDir, "assets"),
              allowedHosts: config.image?.allowedHosts ?? [],
              maxBytes: config.limits.maxImageBytes,
              timeoutMs: config.limits.requestTimeoutMs,
              existing: [],
              cacheIdentity: { model: config.image?.model, templateVersion: "repair" },
            });
            return asset;
          },
        }),
      });
    },
  };
  const generateDeckDependencies = createGenerateDeckDependencies({
    deckStore,
    profiles,
    maxImageBytes: config.limits.maxImageBytes,
    generatePage: (input) => generatePreparedSlideWorkflow({
      source: input.source,
      plannedSpec: input.plannedSpec,
      selection: input.selection,
      profile: input.profile,
      externalAssets: input.externalAssets,
      quality: input.quality,
      documentType: input.documentPolicy.documentType,
      page: input.page,
      displayPlan: input.displayPlan,
      expectedMetadataBindings: input.expectedMetadataBindings,
      requiredThemeId: input.themeId,
      documentPolicy: input.documentPolicy,
      requestId: input.requestId,
    }, baseDependencies),
    inspectDeliveredPage: async (input, result) => {
      const selectedProfile = profiles.find((profile) => profile.slug === result.selectedTemplate.slug);
      if (!selectedProfile) throw new Error("Delivered page references an unknown approved profile");
      const artifact = await runStore.getArtifact(result.runId, "final.html");
      if (!artifact.text) throw new Error("Delivered page HTML is unavailable for consistency inspection");
      const render = await renderPage({
        html: artifact.text,
        screenshotPath: join(runStore.runDir(result.runId), "final.png"),
        validatedOverlapPairs: selectedProfile.overlapExemptions,
      });
      return {
        pageNumber: input.page.number,
        status: result.status,
        selectedTemplateSlug: result.selectedTemplate.slug,
        quality: result.quality,
        render,
      };
    },
  });
  return {
    ...baseDependencies,
    generateDeckDependencies,
    generateDeck: (rawInput) => generateDeckWorkflow(rawInput, generateDeckDependencies),
  };
}
