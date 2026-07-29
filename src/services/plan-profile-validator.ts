import { plannedDeckSchema, type PlannedDeck } from "../domain/deck-plan.js";
import { templateProfileSchema, type TemplateProfile } from "../domain/template-profile.js";
import { hashCanonical } from "../domain/source-document.js";

export interface PlanProfileValidation {
  passed: boolean;
  issues: string[];
}

export function validatePlanAgainstProfiles(
  rawPlan: PlannedDeck,
  loadedProfiles: TemplateProfile[],
): PlanProfileValidation {
  const plan = plannedDeckSchema.parse(rawPlan);
  const profiles = loadedProfiles.map((profile) => templateProfileSchema.parse(profile));
  const issues: string[] = [];
  for (const slide of plan.slides) {
    const matches = profiles.filter((profile) => profile.slug === slide.templateSlug);
    if (matches.length !== 1) {
      issues.push(`page=${slide.page.number}; profile=${slide.templateSlug}; loadedMatches=${matches.length}`);
      continue;
    }
    if (hashCanonical(matches[0]) !== hashCanonical(slide.templateMatch.profileSnapshot)) {
      issues.push(`page=${slide.page.number}; profile=${slide.templateSlug}; capabilitySnapshot=stale`);
    }
  }
  return { passed: issues.length === 0, issues };
}
