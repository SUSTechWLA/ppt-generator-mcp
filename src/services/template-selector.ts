import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

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
  maxImageAssets: number;
  minimumBodyFontPt: number;
  requiredLandmarks: SemanticLandmark[];
  requiredSupportedRoles: SemanticRole[];
  minimumSemanticSlotCapacity: number;
}

const DOCUMENT_POLICIES: Record<DocumentType, DocumentTemplatePolicy> = {
  bid: {
    documentType: "bid",
    maxRasterAreaRatio: 0.18,
    maxImageAssets: 1,
    minimumBodyFontPt: 8.5,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    requiredSupportedRoles: ["fact", "evidence", "metric", "process"],
    minimumSemanticSlotCapacity: 1,
  },
  proposal: {
    documentType: "proposal",
    maxRasterAreaRatio: 0.35,
    maxImageAssets: 4,
    minimumBodyFontPt: 8.5,
    requiredLandmarks: ["page-header", "subsection-title", "summary-band", "page-footer"],
    requiredSupportedRoles: ["fact", "metric"],
    minimumSemanticSlotCapacity: 1,
  },
  presentation: {
    documentType: "presentation",
    maxRasterAreaRatio: 0.65,
    maxImageAssets: 12,
    minimumBodyFontPt: 8.5,
    requiredLandmarks: ["page-header", "page-footer"],
    requiredSupportedRoles: ["fact"],
    minimumSemanticSlotCapacity: 1,
  },
};

export function getDocumentTemplatePolicy(documentType: DocumentType): DocumentTemplatePolicy {
  return DOCUMENT_POLICIES[documentType];
}

export interface TemplateProfileAudit {
  slug: string;
  themeId: string;
  approved: boolean;
  rejectionReasons: string[];
  compatibleIntents: PageIntent[];
  capacity: {
    blocks: number;
    semanticItems: number;
    maxAssets: number;
    maxRasterAreaRatio: number;
    minimumBodyFontPt: number;
  };
}

export interface TemplateFamilyAudit {
  documentType: DocumentType;
  policy: DocumentTemplatePolicy;
  families: Array<{
    themeId: string;
    approvedProfiles: string[];
    rejectedProfiles: Array<{ slug: string; reasons: string[] }>;
    profiles: TemplateProfileAudit[];
  }>;
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

interface BindingEmission {
  tag: string;
  count: number;
  source: string;
}

function declaredBindingEmissions(profile: TemplateProfile): BindingEmission[] {
  const emissions: BindingEmission[] = [];
  for (const slot of profile.semanticSlots) {
    for (const [field, tag] of Object.entries(slot.bindings)) {
      emissions.push({ tag, count: slot.itemCapacity * slot.bindingExpansion[field], source: `semantic slot ${slot.id}.${field}` });
    }
  }
  for (const [field, tag] of Object.entries(profile.auxiliaryBindings ?? {})) {
    const cardinality = profile.auxiliaryCapacities?.[field];
    if (!cardinality) throw new Error(`Auxiliary binding ${field} has no declared cardinality`);
    emissions.push({ tag, count: cardinality.itemCapacity * cardinality.valuesPerItem, source: `auxiliary binding ${field}` });
  }
  for (const [field, tag] of Object.entries(profile.pageBindings)) {
    const count = field === "imageCaption" || field === "figureRef" ? profile.imageSlots.placeholderCount : 1;
    emissions.push({ tag, count, source: `page binding ${field}` });
  }
  return emissions;
}

function rawTagCount(html: string, tag: string): number {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  return (withoutComments.match(new RegExp(`<${tag}(?:\\s|>)`, "gi")) ?? []).length;
}

function actualPlaceholderCount(template: ReturnType<typeof loadTemplate>, tag: string): number {
  if (tag === "page-title") return rawTagCount(template.html, tag);
  return template.placeholders.find((placeholder) => placeholder.tag === tag)?.count ?? 0;
}

const SIMPLE_LOCAL_SELECTOR = /^(?:[a-z][a-z0-9-]*|[.#][A-Za-z_][A-Za-z0-9_-]*)$/;
const FORBIDDEN_IMAGE_CONTAINER_SELECTORS = new Set(["html", "body", "article", "main", ".bid-page"]);
const LANDMARK_SELECTORS: Record<SemanticLandmark, string> = {
  "page-header": "header, .page-header, .visual-header",
  "chapter-band": ".chapter-band, chapter-label",
  "subsection-title": ".subsection-title, subsection-title",
  "summary-band": ".summary-band, .visual-summary, [data-component=\"summary-band\"]",
  "page-footer": "footer, .page-footer, .visual-footer",
};

function validateImageContainerSelector(template: ReturnType<typeof loadTemplate>, profile: TemplateProfile): void {
  if (profile.imageSlots.unusedPolicy !== "remove-container") return;
  const selector = profile.imageSlots.containerSelector;
  if (!selector || !SIMPLE_LOCAL_SELECTOR.test(selector) || FORBIDDEN_IMAGE_CONTAINER_SELECTORS.has(selector.toLowerCase())) {
    throw new Error(`Template profile ${profile.slug} has an unsafe image container selector: ${selector ?? "missing"}`);
  }
  const doc = new JSDOM(template.html).window.document;
  const placeholders = Array.from(doc.querySelectorAll(profile.imageSlots.placeholderTag));
  const containers = placeholders.map((placeholder) => placeholder.closest(selector));
  if (containers.some((container) => !container)) {
    throw new Error(`Template profile ${profile.slug} image container selector ${selector} does not match every image placeholder`);
  }
  const resolved = containers.filter((container): container is Element => Boolean(container));
  const distinct = new Set(resolved);
  if (distinct.size !== placeholders.length) {
    throw new Error(`Template profile ${profile.slug} image container selector ${selector} must resolve to a distinct container per placeholder`);
  }
  const selectorMatches = Array.from(doc.querySelectorAll(selector));
  if (selectorMatches.length !== distinct.size || selectorMatches.some((element) => !distinct.has(element))) {
    throw new Error(`Template profile ${profile.slug} image container selector ${selector} is too broad for its image placeholders`);
  }
  const pageRoots = new Set<Element>([
    doc.documentElement,
    doc.body,
    ...Array.from(doc.querySelectorAll("article, .bid-page, [data-slide-page], [data-page-number]")),
  ]);
  const protectedLandmarks = profile.requiredLandmarks.flatMap((landmark) => Array.from(doc.querySelectorAll(LANDMARK_SELECTORS[landmark])));
  for (const container of distinct) {
    if (pageRoots.has(container)) {
      throw new Error(`Template profile ${profile.slug} image container selector ${selector} resolves to a page root`);
    }
    if (protectedLandmarks.some((landmark) => container === landmark || container.contains(landmark))) {
      throw new Error(`Template profile ${profile.slug} image container selector ${selector} contains a required semantic landmark`);
    }
  }
}

function validateAuxiliaryGroups(template: ReturnType<typeof loadTemplate>, profile: TemplateProfile): void {
  const doc = new JSDOM(template.html).window.document;
  const rootNodes = new Set<Element>([
    doc.documentElement,
    doc.body,
    ...Array.from(doc.querySelectorAll("article, main, .bid-page, .body-grid, [data-slide-page], [data-page-number]")),
  ]);
  const landmarkNodes = new Set(profile.requiredLandmarks.flatMap((landmark) => Array.from(doc.querySelectorAll(LANDMARK_SELECTORS[landmark]))));
  const semanticNodes = new Set(Array.from(doc.querySelectorAll("[data-semantic-slot]")));
  const imagePlaceholders = Array.from(doc.querySelectorAll(profile.imageSlots.placeholderTag));
  const imageContainers = profile.imageSlots.containerSelector
    ? imagePlaceholders.map((placeholder) => placeholder.closest(profile.imageSlots.containerSelector!)).filter((element): element is Element => Boolean(element))
    : [];
  const imageNodes = new Set<Element>([...imagePlaceholders, ...imageContainers]);
  const bindingTags = new Set(declaredBindingEmissions(profile).map((emission) => emission.tag));
  const ownedNodes: Array<{ element: Element; groupId: string; kind: "item" | "connector" }> = [];
  const overlaps = (left: Element, right: Element): boolean => left === right || left.contains(right) || right.contains(left);
  const countTag = (element: Element, tag: string): number => (element.matches(tag) ? 1 : 0) + element.querySelectorAll(tag).length;
  const validateProtectedOwnership = (element: Element, groupId: string): void => {
    if ([...rootNodes].some((root) => element === root || element.contains(root))) {
      throw new Error(`Template profile ${profile.slug} auxiliary group ${groupId} cannot own a page structure root`);
    }
    if ([...landmarkNodes].some((landmark) => element === landmark || element.contains(landmark))) {
      throw new Error(`Template profile ${profile.slug} auxiliary group ${groupId} cannot own a required landmark`);
    }
    if ([...semanticNodes].some((semantic) => element === semantic || element.contains(semantic))) {
      throw new Error(`Template profile ${profile.slug} auxiliary group ${groupId} overlaps semantic fact ownership`);
    }
    if ([...imageNodes].some((image) => element === image || element.contains(image))) {
      throw new Error(`Template profile ${profile.slug} auxiliary group ${groupId} overlaps image slot ownership`);
    }
  };

  for (const group of profile.auxiliaryGroups ?? []) {
    for (const selector of [group.itemSelector, group.connectorSelector].filter((value): value is string => Boolean(value))) {
      if (!SIMPLE_LOCAL_SELECTOR.test(selector) || FORBIDDEN_IMAGE_CONTAINER_SELECTORS.has(selector.toLowerCase())) {
        throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} has an unsafe or malformed selector`);
      }
    }
    const capacity = group.itemCapacity;
    const items = Array.from(doc.querySelectorAll(group.itemSelector));
    if (items.length !== capacity) {
      throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} item selector count ${items.length} does not match capacity ${capacity}`);
    }
    const connectors = group.connectorSelector ? Array.from(doc.querySelectorAll(group.connectorSelector)) : [];
    if (group.connectorSelector) {
      if (connectors.length !== Math.max(0, capacity - 1)) {
        throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} connector selector count ${connectors.length} does not match capacity ${capacity}`);
      }
      for (const connector of connectors) {
        if ([...bindingTags].some((tag) => countTag(connector, tag) > 0)) {
          throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} connector cannot contain a placeholder`);
        }
        validateProtectedOwnership(connector, group.id);
        ownedNodes.push({ element: connector, groupId: group.id, kind: "connector" });
      }
      const following = doc.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING;
      for (const [index, connector] of connectors.entries()) {
        const afterItem = Boolean(items[index].compareDocumentPosition(connector) & following);
        const beforeNextItem = Boolean(connector.compareDocumentPosition(items[index + 1]) & following);
        if (!afterItem || !beforeNextItem) {
          throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} connector order must alternate between owned items`);
        }
      }
    }
    const expectedTags = new Map<string, number>();
    for (const field of group.bindingFields) {
      const tag = (profile.auxiliaryBindings as Record<string, string> | undefined)?.[field];
      const valuesPerItem = profile.auxiliaryCapacities?.[field]?.valuesPerItem;
      if (!tag || !valuesPerItem) throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} has an undeclared binding`);
      expectedTags.set(tag, (expectedTags.get(tag) ?? 0) + valuesPerItem);
    }
    for (const item of items) {
      validateProtectedOwnership(item, group.id);
      for (const [tag, expectedCount] of expectedTags) {
        const actualCount = countTag(item, tag);
        if (actualCount !== expectedCount) {
          throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} item must own exactly ${expectedCount} bound placeholder ${tag}; found ${actualCount}`);
        }
      }
      const foreignTags = [...bindingTags].filter((tag) => !expectedTags.has(tag) && countTag(item, tag) > 0);
      if (foreignTags.length > 0) {
        throw new Error(`Template profile ${profile.slug} auxiliary group ${group.id} item ownership includes placeholders from another binding: ${foreignTags.join(", ")}`);
      }
      ownedNodes.push({ element: item, groupId: group.id, kind: "item" });
    }
  }

  for (let leftIndex = 0; leftIndex < ownedNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ownedNodes.length; rightIndex += 1) {
      const left = ownedNodes[leftIndex];
      const right = ownedNodes[rightIndex];
      if (overlaps(left.element, right.element)) {
        throw new Error(`Template profile ${profile.slug} auxiliary group ownership must be pairwise disjoint; ${left.groupId}.${left.kind} overlaps ${right.groupId}.${right.kind}`);
      }
    }
  }
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
    const emissions = declaredBindingEmissions(profile);
    const emissionsByTag = new Map<string, BindingEmission[]>();
    for (const emission of emissions) emissionsByTag.set(emission.tag, [...(emissionsByTag.get(emission.tag) ?? []), emission]);
    const duplicateTargets = [...emissionsByTag.entries()].filter(([, targets]) => targets.length > 1);
    if (duplicateTargets.length > 0) {
      throw new Error(`Template profile ${profile.slug} has duplicate placeholder target tags: ${duplicateTargets.map(([tag, targets]) => `${tag} (${targets.map((target) => target.source).join(", ")})`).join("; ")}`);
    }
    const declaredTags = [...emissionsByTag.keys()];
    const missing = declaredTags.filter((tag) => actualPlaceholderCount(template, tag) === 0);
    if (missing.length > 0) throw new Error(`Template profile ${profile.slug} declares missing placeholders: ${[...new Set(missing)].join(", ")}`);
    const undeclared = template.placeholders
      .map((placeholder) => placeholder.tag)
      .filter((tag) => !["figures", "icon"].includes(tag) && !declaredTags.includes(tag));
    if (undeclared.length > 0) throw new Error(`Template profile ${profile.slug} has undeclared placeholders: ${[...new Set(undeclared)].join(", ")}`);
    for (const tag of declaredTags) {
      if (!profile.maxCharsBySlot[tag]) throw new Error(`Template profile ${profile.slug} has no character capacity for bound placeholder ${tag}`);
    }
    for (const [tag, targets] of emissionsByTag) {
      const declaredCount = targets.reduce((total, target) => total + target.count, 0);
      const actualCount = actualPlaceholderCount(template, tag);
      if (declaredCount !== actualCount) {
        throw new Error(`Template profile ${profile.slug} binding ${tag} cardinality ${declaredCount} does not match placeholder count ${actualCount}`);
      }
    }
    const templateDocument = new JSDOM(template.html).window.document;
    const declaredSlotIds = new Set(profile.semanticSlots.map((slot) => slot.id));
    for (const slot of profile.semanticSlots) {
      const markerCount = templateDocument.querySelectorAll(`[data-semantic-slot="${slot.id}"]`).length;
      if (markerCount !== slot.itemCapacity) {
        throw new Error(`Template profile ${profile.slug} semantic item marker ${slot.id} count ${markerCount} does not match item capacity ${slot.itemCapacity}`);
      }
    }
    const undeclaredMarkers = Array.from(templateDocument.querySelectorAll("[data-semantic-slot]"))
      .map((element) => element.getAttribute("data-semantic-slot") ?? "")
      .filter((slotId) => !declaredSlotIds.has(slotId));
    if (undeclaredMarkers.length > 0) {
      throw new Error(`Template profile ${profile.slug} has undeclared semantic item markers: ${[...new Set(undeclaredMarkers)].join(", ")}`);
    }
    const actualImageSlots = template.placeholders.find((placeholder) => placeholder.tag === profile.imageSlots.placeholderTag)?.count ?? 0;
    if (actualImageSlots !== profile.imageSlots.placeholderCount || profile.imageSlots.maxAssets !== actualImageSlots) {
      throw new Error(`Template profile ${profile.slug} image slot capacity ${profile.imageSlots.placeholderCount} does not match HTML count ${actualImageSlots}`);
    }
    validateImageContainerSelector(template, profile);
    validateAuxiliaryGroups(template, profile);
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

function profilePolicyErrors(profile: TemplateProfile, policy: DocumentTemplatePolicy): string[] {
  const errors: string[] = [];
  if (!profile.documentCompatibility[policy.documentType]) errors.push(`不支持 ${policy.documentType} 文档`);
  if (profile.maxRasterAreaRatio > policy.maxRasterAreaRatio) {
    errors.push(`位图面积上限 ${profile.maxRasterAreaRatio} 超过策略 ${policy.maxRasterAreaRatio}`);
  }
  if (profile.imageSlots.maxAssets > policy.maxImageAssets) {
    errors.push(`图片槽位上限 ${profile.imageSlots.maxAssets} 超过策略 ${policy.maxImageAssets}`);
  }
  if (profile.minimumBodyFontPt < policy.minimumBodyFontPt) {
    errors.push(`正文字号下限 ${profile.minimumBodyFontPt}pt 低于策略 ${policy.minimumBodyFontPt}pt`);
  }
  const missingLandmarks = policy.requiredLandmarks.filter((landmark) => !profile.requiredLandmarks.includes(landmark));
  if (missingLandmarks.length > 0) errors.push(`缺少必需语义结构：${missingLandmarks.join("、")}`);
  const missingPolicyRoles = policy.requiredSupportedRoles.filter((role) => !profile.supportedRoles.includes(role));
  if (missingPolicyRoles.length > 0) errors.push(`缺少文档策略必需语义能力：${missingPolicyRoles.join("、")}`);
  const slotCapacity = profile.semanticSlots.reduce((total, slot) => total + slot.itemCapacity, 0);
  if (slotCapacity < policy.minimumSemanticSlotCapacity) errors.push("可读语义槽位不足");
  return errors;
}

export function auditTemplateFamilies(profiles: TemplateProfile[], documentType: DocumentType): TemplateFamilyAudit {
  const policy = getDocumentTemplatePolicy(documentType);
  const byTheme = new Map<string, TemplateProfileAudit[]>();
  for (const profile of profiles) {
    const rejectionReasons = profilePolicyErrors(profile, policy);
    const record: TemplateProfileAudit = {
      slug: profile.slug,
      themeId: profile.themeId,
      approved: rejectionReasons.length === 0,
      rejectionReasons,
      compatibleIntents: rejectionReasons.length === 0 ? [...profile.pageIntents] : [],
      capacity: {
        blocks: profile.blockCapacity,
        semanticItems: profile.semanticSlots.reduce((total, slot) => total + slot.itemCapacity, 0),
        maxAssets: profile.imageSlots.maxAssets,
        maxRasterAreaRatio: profile.maxRasterAreaRatio,
        minimumBodyFontPt: profile.minimumBodyFontPt,
      },
    };
    byTheme.set(profile.themeId, [...(byTheme.get(profile.themeId) ?? []), record]);
  }
  return {
    documentType,
    policy: { ...policy, requiredLandmarks: [...policy.requiredLandmarks], requiredSupportedRoles: [...policy.requiredSupportedRoles] },
    families: [...byTheme.entries()].map(([themeId, familyProfiles]) => ({
      themeId,
      approvedProfiles: familyProfiles.filter((profile) => profile.approved).map((profile) => profile.slug),
      rejectedProfiles: familyProfiles
        .filter((profile) => !profile.approved)
        .map((profile) => ({ slug: profile.slug, reasons: [...profile.rejectionReasons] })),
      profiles: familyProfiles,
    })),
  };
}

function compatibility(
  content: PageBlueprint | SlideSpec,
  profile: TemplateProfile,
  documentType: DocumentType,
): string[] {
  const requested = contentCapabilities(content);
  const policy = getDocumentTemplatePolicy(documentType);
  const errors: string[] = profilePolicyErrors(profile, policy);
  if (requested.visualRatio > profile.maxRasterAreaRatio) errors.push(`请求视觉占比 ${requested.visualRatio} 超过模板位图容量 ${profile.maxRasterAreaRatio}`);
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
