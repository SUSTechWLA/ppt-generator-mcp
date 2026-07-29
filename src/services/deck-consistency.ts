import { deckConsistencySchema } from "../domain/deck-manifest.js";
import { plannedDeckSchema, type PlannedDeck } from "../domain/deck-plan.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { RenderResult, RenderStructure } from "./page-renderer.js";
import { validatePlanAgainstProfiles } from "./plan-profile-validator.js";

export interface DeckConsistencyPage {
  pageNumber: number;
  status: "running" | "delivered" | "best_effort" | "failed";
  selectedTemplateSlug?: string;
  quality?: { score: number; threshold: number; hardGatePassed: boolean };
  render: Pick<RenderResult, "viewport" | "pageCount" | "structure">;
}

export interface DeckConsistencyInput {
  plannedDeck: PlannedDeck;
  loadedProfiles: TemplateProfile[];
  pages: DeckConsistencyPage[];
}

export interface DeckConsistencyReport {
  passed: boolean;
  issues: string[];
}

function orderedEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringArrayEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value.replace(/\s+/gu, "") === right[index].replace(/\s+/gu, ""));
}

function tokenFingerprint(tokens: RenderStructure["designTokens"]): string {
  return JSON.stringify({
    fontFamily: tokens.fontFamily,
    textColor: tokens.textColor,
    backgroundColor: tokens.backgroundColor,
    fontScale: tokens.fontScale,
    spacingScale: tokens.spacingScale,
    contrastMode: tokens.contrastMode,
  });
}

function rhythmFingerprint(structure: RenderStructure): string {
  const keys = ["page-header", "chapter-band", "subsection-title", "page-footer"] as const;
  return JSON.stringify(keys.map((key) => (structure.landmarkRects[key] ?? []).map((rect) => ({
    x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
  }))));
}

function formatCanvas(format: TemplateProfile["format"]): { width: number; height: number } {
  if (format === "a4-landscape") return { width: 1123, height: 794 };
  return { width: 0, height: 0 };
}

function boundedIssue(issues: string[], value: string): void {
  if (issues.length < 100) issues.push(value.slice(0, 500));
}

export function evaluateDeckConsistency(input: DeckConsistencyInput): DeckConsistencyReport {
  const issues: string[] = [];
  const parsed = plannedDeckSchema.safeParse(input.plannedDeck);
  if (!parsed.success) return deckConsistencySchema.parse({ passed: false, issues: ["Persisted deck plan failed strict validation"] });
  let profileValidation;
  try {
    profileValidation = validatePlanAgainstProfiles(parsed.data, input.loadedProfiles);
  } catch {
    return deckConsistencySchema.parse({ passed: false, issues: ["Loaded template profile validation failed"] });
  }
  for (const validationIssue of profileValidation.issues) boundedIssue(issues, `Profile snapshot mismatch: ${validationIssue}`);

  const expectedNumbers = parsed.data.pageNumbers;
  const actualNumbers = input.pages.map((page) => page.pageNumber);
  if (!orderedEqual(actualNumbers, expectedNumbers)) boundedIssue(issues, `Rendered page sequence ${actualNumbers.join(",")} does not equal persisted explicit sequence ${expectedNumbers.join(",")}`);

  const expectedTheme = parsed.data.slides[0]?.templateMatch.themeId;
  const expectedFormat = parsed.data.slides[0]?.templateMatch.profileSnapshot.format;
  const firstTokens = input.pages[0] ? tokenFingerprint(input.pages[0].render.structure.designTokens) : undefined;
  const firstRhythm = input.pages[0] ? rhythmFingerprint(input.pages[0].render.structure) : undefined;

  for (const [index, slide] of parsed.data.slides.entries()) {
    const page = input.pages[index];
    if (!page) {
      boundedIssue(issues, `Planned page ${slide.page.number} has no rendered delivery record`);
      continue;
    }
    if (page.pageNumber !== slide.page.number) boundedIssue(issues, `Delivery record at index ${index} does not match planned page ${slide.page.number}`);
    if (page.status !== "delivered") boundedIssue(issues, `Page ${slide.page.number} status is ${page.status}, not delivered`);
    if (!page.quality || !page.quality.hardGatePassed
      || !Number.isFinite(page.quality.score) || !Number.isFinite(page.quality.threshold)
      || page.quality.score < 0 || page.quality.score > 100
      || page.quality.threshold < 70 || page.quality.threshold > 95
      || page.quality.score < page.quality.threshold) {
      boundedIssue(issues, `Page ${slide.page.number} did not independently pass its hard gates and requested score threshold`);
    }
    if (page.selectedTemplateSlug !== slide.templateSlug) boundedIssue(issues, `Page ${slide.page.number} selected template does not equal its persisted plan`);
    if (page.render.pageCount !== 1 || page.render.structure.pageNumber !== String(slide.page.number)) boundedIssue(issues, `Page ${slide.page.number} render does not contain exactly its one expected page marker`);

    const identity = page.render.structure.profile;
    const snapshot = slide.templateMatch.profileSnapshot;
    if (!identity || identity.slug !== slide.templateSlug || identity.version !== snapshot.version
      || identity.themeId !== snapshot.themeId || identity.format !== snapshot.format) {
      boundedIssue(issues, `Page ${slide.page.number} rendered template identity is not truthful to its profile snapshot`);
    }
    if (slide.templateMatch.themeId !== expectedTheme) boundedIssue(issues, `Page ${slide.page.number} declares an incompatible themeId`);
    if (snapshot.format !== expectedFormat) boundedIssue(issues, `Page ${slide.page.number} declares an incompatible document format`);
    const canvas = formatCanvas(snapshot.format);
    if (page.render.viewport.width !== canvas.width || page.render.viewport.height !== canvas.height) boundedIssue(issues, `Page ${slide.page.number} canvas does not match ${snapshot.format}`);

    for (const landmark of snapshot.requiredLandmarks) {
      if (page.render.structure.landmarkCounts[landmark] !== 1) boundedIssue(issues, `Page ${slide.page.number} required landmark ${landmark} is missing or duplicated`);
    }
    for (const binding of slide.templateMatch.metadataBindings) {
      const actual = page.render.structure.pageFields[binding.field] ?? [];
      if (!stringArrayEqual(actual, binding.values)) boundedIssue(issues, `Page ${slide.page.number} visible metadata ${binding.field} does not match its own plan`);
    }
    if (firstTokens !== undefined && tokenFingerprint(page.render.structure.designTokens) !== firstTokens) boundedIssue(issues, `Page ${slide.page.number} typography, color, spacing, or contrast design tokens are inconsistent`);
    if (firstRhythm !== undefined && rhythmFingerprint(page.render.structure) !== firstRhythm) boundedIssue(issues, `Page ${slide.page.number} heading and footer hierarchy placement rhythm is inconsistent`);
  }

  if (input.pages.length > parsed.data.slides.length) boundedIssue(issues, "Rendered delivery includes pages that are not present in the persisted plan");
  return deckConsistencySchema.parse({ passed: issues.length === 0, issues });
}
