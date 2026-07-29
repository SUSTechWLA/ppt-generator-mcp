import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DocumentType } from "../domain/document-context.js";
import type { PageBlueprint, SemanticRole } from "../domain/page-blueprint.js";
import type { SlideBlockType, SlideSpec } from "../domain/slide-spec.js";
import {
  templateProfileSchema,
  type PageIntent,
  type SemanticLandmark,
  type TemplateProfile,
  type TemplateSelection,
} from "../domain/template-profile.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { listTemplates, loadTemplate } from "../lib/template-parser.js";
import { solveTemplateSlots } from "./template-slot-solver.js";

const DENSITIES = ["low", "medium", "high"] as const;

export interface DocumentTemplatePolicy {
  documentType: DocumentType;
  maxRasterAreaRatio: number;
  requiredLandmarks: SemanticLandmark[];
  requiredSupportedRoles: SemanticRole[];
  minimumSemanticSlotCapacity: number;
}

const DOCUMENT_POLICIES: Record<DocumentType, DocumentTemplatePolicy> = {
  bid: {
    documentType: "bid",
    maxRasterAreaRatio: 0.18,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    requiredSupportedRoles: ["fact", "evidence", "metric", "process"],
    minimumSemanticSlotCapacity: 1,
  },
  proposal: {
    documentType: "proposal",
    maxRasterAreaRatio: 0.35,
    requiredLandmarks: ["page-header", "subsection-title", "summary-band", "page-footer"],
    requiredSupportedRoles: ["fact", "metric"],
    minimumSemanticSlotCapacity: 1,
  },
  presentation: {
    documentType: "presentation",
    maxRasterAreaRatio: 0.65,
    requiredLandmarks: ["page-header", "page-footer"],
    requiredSupportedRoles: ["fact"],
    minimumSemanticSlotCapacity: 1,
  },
};

export function getDocumentTemplatePolicy(documentType: DocumentType): DocumentTemplatePolicy {
  return DOCUMENT_POLICIES[documentType];
}

function findProfileCatalogs(root: string): string[] {
  const catalogs: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["assets", "node_modules", "output"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === "template-profiles.json") catalogs.push(path);
    }
  };
  visit(root);
  return catalogs;
}

function declaredPlaceholderTags(profile: TemplateProfile): string[] {
  return [
    ...Object.values(profile.pageBindings),
    ...profile.semanticSlots.flatMap((slot) => Object.values(slot.bindings)),
    ...Object.values(profile.auxiliaryBindings ?? {}),
  ].filter((tag): tag is string => Boolean(tag));
}

export function loadTemplateProfiles(templatesDir: string): TemplateProfile[] {
  const catalogs = findProfileCatalogs(templatesDir);
  if (catalogs.length === 0) {
    throw new WorkflowError({ code: "TEMPLATE_FAILED", stage: "load_template_profiles", retryable: false, message: "Template profile catalog was not found" });
  }
  const rawProfiles: unknown[] = [];
  for (const profilePath of catalogs) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(profilePath, "utf8"));
    } catch (cause) {
      throw new WorkflowError({ code: "TEMPLATE_FAILED", stage: "load_template_profiles", retryable: false, message: "Template profile catalog contains invalid JSON", cause });
    }
    if (!Array.isArray(raw)) throw new Error(`Template profile catalog must be an array: ${profilePath}`);
    rawProfiles.push(...raw);
  }
  const profiles = rawProfiles.map((item) => templateProfileSchema.parse(item));
  const slugs = profiles.map((profile) => profile.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error("Template profile catalog contains duplicate slugs");

  const actual = new Set(listTemplates(templatesDir).map((template) => template.slug));
  for (const profile of profiles) {
    if (!actual.has(profile.slug)) throw new Error(`Template profile has no matching HTML: ${profile.slug}`);
    const template = loadTemplate(templatesDir, profile.slug);
    const available = new Set(template.placeholders.map((placeholder) => placeholder.tag));
    const missing = declaredPlaceholderTags(profile).filter((tag) => tag !== "page-title" && !available.has(tag));
    if (missing.length > 0) throw new Error(`Template profile ${profile.slug} declares missing placeholders: ${[...new Set(missing)].join(", ")}`);
  }
  for (const slug of actual) {
    if (!slugs.includes(slug)) throw new Error(`HTML template has no approved profile: ${slug}`);
  }
  return profiles;
}

interface ContentCapabilities {
  roles: SemanticRole[];
  blockTypes: SlideBlockType[];
  blockCount: number;
  imageCount: number;
  density: "low" | "medium" | "high";
  visualRatio: number;
  pageIntent: PageIntent;
}

function roleForBlock(type: SlideBlockType, semanticRole?: SemanticRole): SemanticRole {
  if (semanticRole) return semanticRole;
  if (type === "process") return "process";
  if (type === "metric") return "metric";
  if (type === "table") return "comparison";
  if (type === "image") return "visual";
  return "fact";
}

function intentFor(roles: SemanticRole[], imageCount: number): PageIntent {
  if (roles.includes("comparison")) return "comparison";
  if (roles.includes("process")) return "process";
  if (roles.includes("evidence")) return "evidence";
  if (imageCount > 0) return "visual-support";
  return "detail";
}

function contentCapabilities(content: PageBlueprint | SlideSpec): ContentCapabilities {
  if ("version" in content) {
    const roles = content.groups.map((group) => group.role);
    const imageCount = content.assets.length;
    return {
      roles,
      blockTypes: roles.map((role) => role === "process" ? "process" : role === "metric" ? "metric" : role === "comparison" ? "table" : role === "visual" ? "image" : "text"),
      blockCount: content.groups.length,
      imageCount,
      density: content.density,
      visualRatio: imageCount > 0 ? 0.18 : 0,
      pageIntent: intentFor(roles, imageCount),
    };
  }
  const roles = content.blocks.map((block) => roleForBlock(block.type, block.semanticRole));
  const imageCount = content.assets.filter((asset) => asset.type === "image").length;
  return {
    roles,
    blockTypes: content.blocks.map((block) => block.type),
    blockCount: content.blocks.length,
    imageCount,
    density: content.designIntent.density,
    visualRatio: content.designIntent.visualRatio,
    pageIntent: intentFor(roles, imageCount),
  };
}

function compatibility(
  content: PageBlueprint | SlideSpec,
  profile: TemplateProfile,
  documentType: DocumentType,
): string[] {
  const requested = contentCapabilities(content);
  const policy = getDocumentTemplatePolicy(documentType);
  const errors: string[] = [];
  if (!profile.documentCompatibility[documentType]) errors.push(`不支持 ${documentType} 文档`);
  if (profile.maxRasterAreaRatio > policy.maxRasterAreaRatio) errors.push(`位图面积上限 ${profile.maxRasterAreaRatio} 超过策略 ${policy.maxRasterAreaRatio}`);
  const missingLandmarks = policy.requiredLandmarks.filter((landmark) => !profile.requiredLandmarks.includes(landmark));
  if (missingLandmarks.length > 0) errors.push(`缺少必需语义结构：${missingLandmarks.join("、")}`);
  const missingPolicyRoles = policy.requiredSupportedRoles.filter((role) => !profile.supportedRoles.includes(role));
  if (missingPolicyRoles.length > 0) errors.push(`缺少文档策略必需语义能力：${missingPolicyRoles.join("、")}`);
  const slotCapacity = profile.semanticSlots.reduce((total, slot) => total + slot.itemCapacity, 0);
  if (slotCapacity < policy.minimumSemanticSlotCapacity) errors.push("可读语义槽位不足");
  if (requested.blockCount > profile.blockCapacity) errors.push("内容模块超过模板容量");
  const unsupportedBlocks = [...new Set(requested.blockTypes.filter((type) => !profile.supportedBlocks.includes(type)))];
  if (unsupportedBlocks.length > 0) errors.push(`不支持模块类型：${unsupportedBlocks.join("、")}`);
  const unsupportedRoles = [...new Set(requested.roles.filter((role) => !profile.supportedRoles.includes(role)))];
  if (unsupportedRoles.length > 0) errors.push(`不支持语义角色：${unsupportedRoles.join("、")}`);
  if (requested.imageCount > profile.imageSlots) errors.push("图片槽位不足");
  if (!profile.pageIntents.includes(requested.pageIntent)) errors.push(`不支持页面意图：${requested.pageIntent}`);
  const solution = solveTemplateSlots(content, profile);
  if (!solution.feasible) errors.push(...solution.unmatched.map((item) => item.reason));
  if (solution.unrepresentedFactIds.length > 0) errors.push(`未覆盖事实：${solution.unrepresentedFactIds.join("、")}`);
  return [...new Set(errors)];
}

function rangeDistance(density: ContentCapabilities["density"], profile: TemplateProfile): number {
  const value = DENSITIES.indexOf(density);
  const min = DENSITIES.indexOf(profile.densityRange[0]);
  const max = DENSITIES.indexOf(profile.densityRange[1]);
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function scoreProfile(content: PageBlueprint | SlideSpec, profile: TemplateProfile, preferredThemeId?: string): number {
  const requested = contentCapabilities(content);
  const uniqueRoles = [...new Set(requested.roles)];
  const roleCoverage = uniqueRoles.filter((role) => profile.supportedRoles.includes(role)).length / Math.max(1, uniqueRoles.length) * 100;
  const capacityUse = requested.blockCount / profile.blockCapacity;
  const capacityScore = Math.max(0, 100 - Math.abs(1 - capacityUse) * 55);
  const densityScore = Math.max(0, 100 - rangeDistance(requested.density, profile) * 45);
  const imageUse = requested.imageCount === 0
    ? (profile.imageSlots === 0 ? 100 : 85)
    : Math.min(100, requested.imageCount / Math.max(1, profile.imageSlots) * 100);
  const ratioScore = Math.max(0, 100 - Math.abs(requested.visualRatio - Math.min(requested.visualRatio, profile.maxRasterAreaRatio)) * 100);
  const visualScore = (imageUse + ratioScore) / 2;
  const intentScore = profile.pageIntents.includes(requested.pageIntent) ? 100 : 0;
  const themeScore = preferredThemeId ? (profile.themeId === preferredThemeId ? 100 : 50) : 100;
  return Math.round((roleCoverage * 0.24 + capacityScore * 0.22 + densityScore * 0.18 + visualScore * 0.16 + intentScore * 0.14 + themeScore * 0.06) * 10) / 10;
}

export function selectTemplate(
  content: PageBlueprint | SlideSpec,
  profiles: TemplateProfile[],
  forcedSlug?: string,
  documentType?: DocumentType,
  preferredThemeId?: string,
): TemplateSelection {
  const effectiveDocumentType = documentType ?? ("version" in content ? content.documentType : "presentation");
  const evaluated = profiles.map((profile, catalogIndex) => ({
    profile,
    catalogIndex,
    score: scoreProfile(content, profile, preferredThemeId),
    errors: compatibility(content, profile, effectiveDocumentType),
  }));

  if (forcedSlug) {
    const forced = evaluated.find((candidate) => candidate.profile.slug === forcedSlug);
    if (!forced) throw new Error(`指定模板不存在：${forcedSlug}`);
    if (forced.errors.length > 0) throw new Error(`指定模板不兼容，且不满足文档策略或内容能力：${forced.errors.join("；")}`);
    return {
      slug: forced.profile.slug,
      score: forced.score,
      reason: `按调用方指定模板；容量、语义槽位与 ${effectiveDocumentType} 策略校验通过`,
      candidates: [{ slug: forced.profile.slug, score: forced.score }],
    };
  }

  const candidates = evaluated
    .filter((candidate) => candidate.errors.length === 0)
    .sort((left, right) => right.score - left.score || left.catalogIndex - right.catalogIndex);
  if (candidates.length === 0) throw new Error("没有与当前内容结构和文档策略兼容的已批准模板");
  const winner = candidates[0];
  const requested = contentCapabilities(content);
  return {
    slug: winner.profile.slug,
    score: winner.score,
    reason: `语义角色 ${[...new Set(requested.roles)].join("、")}，容量 ${requested.blockCount}/${winner.profile.blockCapacity}，图片槽位 ${requested.imageCount}/${winner.profile.imageSlots}，位图上限 ${winner.profile.maxRasterAreaRatio}，内容密度 ${requested.density}`,
    candidates: candidates.map((candidate) => ({ slug: candidate.profile.slug, score: candidate.score })),
  };
}
