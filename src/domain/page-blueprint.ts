import * as z from "zod/v4";

import { documentTypeSchema } from "./document-context.js";

const factIdSchema = z.string().regex(/^fact-\d+$/);

export const semanticRoleSchema = z.enum([
  "headline",
  "conclusion",
  "fact",
  "metric",
  "process",
  "comparison",
  "evidence",
  "visual",
]);

export const blueprintDensitySchema = z.enum(["low", "medium", "high"]);
export const visualNeedSchema = z.enum(["none", "supporting"]);

export const pageContentGroupSchema = z.object({
  id: z.string().regex(/^group-\d+$/),
  order: z.number().int().nonnegative(),
  role: semanticRoleSchema,
  title: z.string().trim().min(2).max(60),
  body: z.string().trim().min(1).max(500),
  sourceSectionIds: z.array(z.string().regex(/^section-\d+$/)).min(1).max(50),
  sourceFactIds: z.array(factIdSchema).min(1).max(200),
}).strict();

export const pageVisualIntentSchema = z.object({
  id: z.string().regex(/^p\d+-img-\d{3}$/),
  role: z.literal("visual"),
  groupId: z.string().regex(/^group-\d+$/),
  prompt: z.string().trim().min(10).max(1_200),
  alt: z.string().trim().min(2).max(120),
  sourceFactIds: z.array(factIdSchema).min(1).max(200),
  width: z.literal(1792),
  height: z.literal(1024),
}).strict();

export const pageBlueprintSchema = z.object({
  version: z.literal(1),
  pageNumber: z.number().int().positive().max(9999),
  title: z.string().trim().min(1).max(100),
  documentType: documentTypeSchema,
  audience: z.string().trim().min(1).max(200).optional(),
  groups: z.array(pageContentGroupSchema).min(1).max(12),
  sourceFactIds: z.array(factIdSchema).min(1).max(200),
  density: blueprintDensitySchema,
  visualNeed: visualNeedSchema,
  assets: z.array(pageVisualIntentSchema).max(1),
}).strict().superRefine((blueprint, context) => {
  const expectedGroupIds = blueprint.groups.map((_, index) => `group-${index + 1}`);
  const actualGroupIds = blueprint.groups.map((group) => group.id);
  if (actualGroupIds.some((id, index) => id !== expectedGroupIds[index])) {
    context.addIssue({ code: "custom", message: "Content group IDs must be ordered and contiguous", path: ["groups"] });
  }
  if (blueprint.groups.some((group, index) => group.order !== index)) {
    context.addIssue({ code: "custom", message: "Content group order must match source order", path: ["groups"] });
  }

  const groupedFactIds = blueprint.groups.flatMap((group) => group.sourceFactIds);
  const uniqueSourceFactIds = new Set(blueprint.sourceFactIds);
  if (uniqueSourceFactIds.size !== blueprint.sourceFactIds.length) {
    context.addIssue({ code: "custom", message: "Page source fact IDs must be unique", path: ["sourceFactIds"] });
  }
  if (groupedFactIds.length !== blueprint.sourceFactIds.length
    || groupedFactIds.some((factId, index) => factId !== blueprint.sourceFactIds[index])) {
    context.addIssue({
      code: "custom",
      message: "Content groups must cover every page fact exactly once in source order",
      path: ["groups"],
    });
  }

  const groupById = new Map(blueprint.groups.map((group) => [group.id, group]));
  const knownFactIds = new Set(blueprint.sourceFactIds);
  for (const asset of blueprint.assets) {
    const group = groupById.get(asset.groupId);
    if (!group) {
      context.addIssue({ code: "custom", message: `Visual asset references unknown group ${asset.groupId}`, path: ["assets"] });
    }
    if (!asset.id.startsWith(`p${blueprint.pageNumber}-`)) {
      context.addIssue({ code: "custom", message: "Visual asset ID must be scoped to the blueprint page", path: ["assets"] });
    }
    if (asset.sourceFactIds.some((factId) => !knownFactIds.has(factId))) {
      context.addIssue({ code: "custom", message: "Visual asset references an unknown page fact", path: ["assets"] });
    }
    if (group && asset.sourceFactIds.some((factId) => !group.sourceFactIds.includes(factId))) {
      context.addIssue({ code: "custom", message: "Visual asset facts must belong to its content group", path: ["assets"] });
    }
  }

  if ((blueprint.visualNeed === "none" && blueprint.assets.length !== 0)
    || (blueprint.visualNeed === "supporting" && blueprint.assets.length !== 1)) {
    context.addIssue({ code: "custom", message: "Visual need and asset intent must agree", path: ["assets"] });
  }
});

export type SemanticRole = z.infer<typeof semanticRoleSchema>;
export type BlueprintDensity = z.infer<typeof blueprintDensitySchema>;
export type VisualNeed = z.infer<typeof visualNeedSchema>;
export type PageContentGroup = z.infer<typeof pageContentGroupSchema>;
export type PageVisualIntent = z.infer<typeof pageVisualIntentSchema>;
export type PageBlueprint = z.infer<typeof pageBlueprintSchema>;
