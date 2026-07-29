import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SlideSpec } from "../domain/slide-spec.js";
import { templateProfileSchema, type TemplateProfile, type TemplateSelection } from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { listTemplates } from "../lib/template-parser.js";

const DENSITIES = ["low", "medium", "high"] as const;

export function loadTemplateProfiles(templatesDir: string): TemplateProfile[] {
  const candidates = [
    join(templatesDir, "template-profiles.json"),
    join(templatesDir, "green-infographic", "template-profiles.json"),
  ];
  const profilePath = candidates.find(existsSync);
  if (!profilePath) {
    throw new WorkflowError({ code: "TEMPLATE_FAILED", stage: "load_template_profiles", retryable: false, message: "Template profile catalog was not found" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (cause) {
    throw new WorkflowError({ code: "TEMPLATE_FAILED", stage: "load_template_profiles", retryable: false, message: "Template profile catalog contains invalid JSON", cause });
  }
  if (!Array.isArray(raw)) throw new Error("Template profile catalog must be an array");
  const profiles = raw.map((item) => templateProfileSchema.parse(item));
  const slugs = profiles.map((profile) => profile.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error("Template profile catalog contains duplicate slugs");

  const actual = new Set(listTemplates(templatesDir).map((template) => template.slug));
  for (const profile of profiles) {
    if (!actual.has(profile.slug)) throw new Error(`Template profile has no matching HTML: ${profile.slug}`);
  }
  for (const slug of actual) {
    if (!slugs.includes(slug)) throw new Error(`HTML template has no approved profile: ${slug}`);
  }
  return profiles;
}

function compatibility(spec: SlideSpec, profile: TemplateProfile): string[] {
  const errors: string[] = [];
  if (spec.blocks.length > profile.blockCapacity) errors.push("内容模块超过模板容量");
  const unsupported = [...new Set(spec.blocks.map((block) => block.type).filter((type) => !profile.supportedBlocks.includes(type)))];
  if (unsupported.length) errors.push(`不支持模块类型：${unsupported.join("、")}`);
  if (spec.assets.filter((asset) => asset.type === "image").length > profile.imageSlots) errors.push("图片槽位不足");
  return errors;
}

function scoreProfile(spec: SlideSpec, profile: TemplateProfile): number {
  const capacityScore = spec.blocks.length <= profile.blockCapacity
    ? 100 - Math.max(0, profile.blockCapacity - spec.blocks.length) * 8
    : 0;
  const supported = spec.blocks.filter((block) => profile.supportedBlocks.includes(block.type)).length;
  const blockTypeScore = supported / spec.blocks.length * 100;
  const imageCount = spec.assets.filter((asset) => asset.type === "image").length;
  const imageSlotScore = imageCount === 0
    ? (profile.imageSlots === 0 ? 100 : 75)
    : profile.imageSlots >= imageCount
      ? 100 - Math.min(30, (profile.imageSlots - imageCount) * 6)
      : profile.imageSlots / imageCount * 100;
  const density = DENSITIES.indexOf(spec.designIntent.density);
  const min = DENSITIES.indexOf(profile.densityRange[0]);
  const max = DENSITIES.indexOf(profile.densityRange[1]);
  const densityScore = density >= min && density <= max ? 100 : 35;
  const orderScore = profile.slug.includes("text-image") && imageCount >= 2 ? 100 : 80;
  return Math.round((capacityScore * 0.25 + blockTypeScore * 0.25 + imageSlotScore * 0.20 + densityScore * 0.20 + orderScore * 0.10) * 10) / 10;
}

export function selectTemplate(
  spec: SlideSpec,
  profiles: TemplateProfile[],
  forcedSlug?: string,
): TemplateSelection {
  if (forcedSlug) {
    const profile = profiles.find((candidate) => candidate.slug === forcedSlug);
    if (!profile) throw new Error(`指定模板不存在：${forcedSlug}`);
    const errors = compatibility(spec, profile);
    if (errors.length) throw new Error(`指定模板不兼容：${errors.join("；")}`);
    const score = scoreProfile(spec, profile);
    return { slug: profile.slug, score, reason: `按调用方指定模板；容量与图片槽位校验通过`, candidates: [{ slug: profile.slug, score }] };
  }

  const candidates = profiles
    .map((profile) => ({ profile, score: scoreProfile(spec, profile), errors: compatibility(spec, profile) }))
    .filter((candidate) => candidate.errors.length === 0)
    .sort((left, right) => right.score - left.score || left.profile.slug.localeCompare(right.profile.slug));
  if (!candidates.length) throw new Error("没有与当前内容结构兼容的已批准模板");
  const winner = candidates[0];
  const images = spec.assets.filter((asset) => asset.type === "image").length;
  return {
    slug: winner.profile.slug,
    score: winner.score,
    reason: `容量 ${spec.blocks.length}/${winner.profile.blockCapacity}，图片槽位 ${images}/${winner.profile.imageSlots}，内容密度 ${spec.designIntent.density}`,
    candidates: candidates.map((candidate) => ({ slug: candidate.profile.slug, score: candidate.score })),
  };
}
