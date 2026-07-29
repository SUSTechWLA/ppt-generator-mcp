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

function rawTagCount(html: string, tag: string): number {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  return (withoutComments.match(new RegExp(`<${tag}(?:\\s|>)`, "gi")) ?? []).length;
}

function actualPlaceholderCount(template: ReturnType<typeof loadTemplate>, tag: string): number {
  if (tag === "page-title") return rawTagCount(template.html, tag);
  return template.placeholders.find((placeholder) => placeholder.tag === tag)?.count ?? 0;
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
    const declaredTags = [...new Set(declaredPlaceholderTags(profile))];
    const missing = declaredTags.filter((tag) => actualPlaceholderCount(template, tag) === 0);
    if (missing.length > 0) throw new Error(`Template profile ${profile.slug} declares missing placeholders: ${[...new Set(missing)].join(", ")}`);
    const undeclared = template.placeholders
      .map((placeholder) => placeholder.tag)
      .filter((tag) => !["figures", "icon"].includes(tag) && !declaredTags.includes(tag));
    if (undeclared.length > 0) throw new Error(`Template profile ${profile.slug} has undeclared placeholders: ${[...new Set(undeclared)].join(", ")}`);
    for (const tag of declaredTags) {
      if (!profile.maxCharsBySlot[tag]) throw new Error(`Template profile ${profile.slug} has no character capacity for bound placeholder ${tag}`);
    }
    for (const slot of profile.semanticSlots) {
      for (const [field, tag] of Object.entries(slot.bindings)) {
        const expansion = slot.bindingExpansion[field];
        const actual = actualPlaceholderCount(template, tag);
        if (slot.itemCapacity * expansion !== actual) {
          throw new Error(`Template profile ${profile.slug} semantic binding ${tag} cardinality ${slot.itemCapacity}x${expansion} does not match placeholder count ${actual}`);
        }
      }
    }
    for (const [field, tag] of Object.entries(profile.auxiliaryBindings ?? {})) {
      const cardinality = profile.auxiliaryCapacities?.[field];
      const actual = actualPlaceholderCount(template, tag);
      if (!cardinality || cardinality.itemCapacity * cardinality.valuesPerItem !== actual) {
        throw new Error(`Template profile ${profile.slug} auxiliary binding ${tag} cardinality does not match placeholder count ${actual}`);
      }
    }
    for (const [field, tag] of Object.entries(profile.pageBindings)) {
      const expected = field === "imageCaption" || field === "figureRef" ? profile.imageSlots.placeholderCount : 1;
      const actual = actualPlaceholderCount(template, tag);
      if (actual !== expected) throw new Error(`Template profile ${profile.slug} page binding ${tag} cardinality ${actual} does not match ${expected}`);
    }
    const actualImageSlots = template.placeholders.find((placeholder) => placeholder.tag === profile.imageSlots.placeholderTag)?.count ?? 0;
    if (actualImageSlots !== profile.imageSlots.placeholderCount || profile.imageSlots.maxAssets !== actualImageSlots) {
      throw new Error(`Template profile ${profile.slug} image slot capacity ${profile.imageSlots.placeholderCount} does not match HTML count ${actualImageSlots}`);
    }
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

function emittedCapacityErrors(content: PageBlueprint | SlideSpec, profile: TemplateProfile): string[] {
  const errors: string[] = [];
  const check = (tag: string | undefined, value: string): void => {
    if (!tag) return;
    const limit = profile.maxCharsBySlot[tag];
    if (!limit || Array.from(value).length > limit) errors.push(`绑定 ${tag} 超出字符容量 ${limit ?? 0}`);
  };
  if (profile.pageBindings) {
    check(profile.pageBindings.pageTitle, content.title);
    if (!("version" in content)) check(profile.pageBindings.summaryText, content.conclusion);
  }
  const items = "version" in content
    ? content.groups.map((group) => ({ title: group.title, body: group.body, role: group.role, bullets: [] as string[], metrics: [] as string[] }))
    : content.blocks.map((block) => ({
        title: block.title,
        body: [block.body, ...block.bullets].filter(Boolean).join("；"),
        role: roleForBlock(block.type, block.semanticRole),
        bullets: block.bullets,
        metrics: block.metrics.map((metric) => `${metric.label}：${metric.value}`),
      }));
  const roleLabels: Record<SemanticRole, string> = {
    headline: "页面主题", conclusion: "核心结论", fact: "事实要点", metric: "量化指标",
    process: "实施流程", comparison: "对比分析", evidence: "事实依据", visual: "视觉说明",
  };
  for (const [field, tag] of Object.entries(profile.auxiliaryBindings ?? {})) {
    const cardinality = profile.auxiliaryCapacities?.[field];
    const itemLimit = cardinality?.itemCapacity ?? items.length;
    const expansion = cardinality?.valuesPerItem ?? 1;
    if (field === "tableHeader") {
      for (const value of ["语义主题", "原文事实", "量化信息", "内容类型"].slice(0, expansion)) check(tag, value);
      continue;
    }
    for (const [index, item] of items.slice(0, itemLimit).entries()) {
      let values: string[];
      if (field === "body" || field === "narrativeBody") values = [item.body];
      else if (field === "tableCell") values = [item.title, item.body, item.metrics.join("；") || "—", roleLabels[item.role]];
      else if (["label", "stepLabel", "stageLabel", "itemLabel", "nodeLabel"].includes(field)) values = [roleLabels[item.role]];
      else if (field === "metric") values = [item.metrics.join("；") || item.title];
      else if (field === "bullet") values = [item.bullets[0] ?? item.title];
      else if (["sequence", "stepNumber", "stageNumber"].includes(field)) values = [String(index + 1).padStart(2, "0")];
      else values = [item.title];
      for (const value of values.slice(0, expansion)) check(tag, value);
    }
  }
  return [...new Set(errors)];
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
  if (requested.visualRatio > profile.maxRasterAreaRatio) errors.push(`请求视觉占比 ${requested.visualRatio} 超过模板位图容量 ${profile.maxRasterAreaRatio}`);
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
  if (requested.imageCount < profile.imageSlots.minAssets) errors.push(`图片资产少于模板必需数 ${profile.imageSlots.minAssets}`);
  if (requested.imageCount > profile.imageSlots.maxAssets) errors.push(`图片资产超过模板实际槽位数 ${profile.imageSlots.maxAssets}`);
  if (!profile.pageIntents.includes(requested.pageIntent)) errors.push(`不支持页面意图：${requested.pageIntent}`);
  const solution = solveTemplateSlots(content, profile);
  if (!solution.feasible) errors.push(...solution.unmatched.map((item) => item.reason));
  if (solution.unrepresentedFactIds.length > 0) errors.push(`未覆盖事实：${solution.unrepresentedFactIds.join("、")}`);
  errors.push(...emittedCapacityErrors(content, profile));
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
    ? (profile.imageSlots.maxAssets === 0 ? 100 : 85)
    : Math.min(100, requested.imageCount / Math.max(1, profile.imageSlots.maxAssets) * 100);
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
    reason: `语义角色 ${[...new Set(requested.roles)].join("、")}，容量 ${requested.blockCount}/${winner.profile.blockCapacity}，图片槽位 ${requested.imageCount}/${winner.profile.imageSlots.maxAssets}，位图上限 ${winner.profile.maxRasterAreaRatio}，内容密度 ${requested.density}`,
    candidates: candidates.map((candidate) => ({ slug: candidate.profile.slug, score: candidate.score })),
  };
}
