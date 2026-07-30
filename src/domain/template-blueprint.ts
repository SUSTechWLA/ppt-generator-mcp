import * as z from "zod/v4";

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const regionRoleSchema = z.enum(["title", "body", "metric", "process", "evidence", "image", "conclusion", "page-number"]);
const componentTypeSchema = z.enum([
  "title-band", "fact-card", "metric-card", "process-card", "evidence-card", "image-card", "conclusion-band", "page-number",
]);

const regionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  role: regionRoleSchema,
  component: componentTypeSchema,
  columnStart: z.number().int().min(1).max(12),
  columnSpan: z.number().int().min(1).max(12),
  row: z.number().int().min(1).max(12),
}).strict();

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function colorContrastRatio(left: string, right: string): number {
  const light = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (light + 0.05) / (dark + 0.05);
}

export const templateBlueprintSchema = z.object({
  version: z.literal(1),
  displayName: z.string().trim().min(3).max(80),
  slugSeed: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  canvas: z.object({
    format: z.literal("a4-landscape"),
    widthMm: z.literal(297),
    heightMm: z.literal(210),
  }).strict(),
  grid: z.object({
    columns: z.number().int().min(4).max(12),
    gapMm: z.number().min(0).max(12),
    regions: z.array(regionSchema).min(3).max(12),
  }).strict(),
  typography: z.object({
    fontFamily: z.string().trim().min(3).max(120).regex(/^[\p{L}\p{N}\s,"'-]+$/u, "Unsafe font family"),
    bodyPt: z.number().min(8.5).max(18),
    titlePt: z.number().min(18).max(36),
    lineHeight: z.number().min(1.15).max(1.8),
  }).strict(),
  palette: z.object({
    background: hexColorSchema,
    surface: hexColorSchema,
    text: hexColorSchema,
    primary: hexColorSchema,
    secondary: hexColorSchema,
  }).strict(),
  spacing: z.object({
    outerMm: z.number().min(8).max(25),
    gapMm: z.number().min(2).max(12),
    cardPaddingMm: z.number().min(2).max(12),
    borderRadiusMm: z.number().min(0).max(8),
  }).strict(),
  visualRatios: z.object({
    text: z.number().min(0.3).max(0.85),
    image: z.number().min(0).max(0.55),
    whitespace: z.number().min(0.08).max(0.5),
  }).strict(),
  optionalImage: z.object({
    enabled: z.boolean(),
    regionId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
    maxAreaRatio: z.number().min(0).max(0.55),
    screenshotAsBackground: z.literal(false),
  }).strict(),
  capabilityTags: z.array(z.enum(["detail", "metric", "process", "evidence", "visual-support", "formal"])).min(1).max(6),
}).strict().superRefine((blueprint, context) => {
  const ids = blueprint.grid.regions.map((region) => region.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Region IDs must be unique", path: ["grid", "regions"] });
  if (new Set(blueprint.capabilityTags).size !== blueprint.capabilityTags.length) context.addIssue({ code: "custom", message: "Capability tags must be unique", path: ["capabilityTags"] });
  for (const [index, region] of blueprint.grid.regions.entries()) {
    if (region.columnStart + region.columnSpan - 1 > blueprint.grid.columns) {
      context.addIssue({ code: "custom", message: "Region exceeds declared grid columns", path: ["grid", "regions", index] });
    }
  }
  for (const requiredRole of ["title", "body", "page-number"] as const) {
    if (!blueprint.grid.regions.some((region) => region.role === requiredRole)) {
      context.addIssue({ code: "custom", message: `Missing required ${requiredRole} role`, path: ["grid", "regions"] });
    }
  }
  if (blueprint.grid.regions.filter((region) => region.role === "title").length !== 1
    || blueprint.grid.regions.filter((region) => region.role === "page-number").length !== 1) {
    context.addIssue({ code: "custom", message: "Title and page-number roles must be unique", path: ["grid", "regions"] });
  }
  const imageRegion = blueprint.grid.regions.find((region) => region.id === blueprint.optionalImage.regionId);
  if (blueprint.optionalImage.enabled) {
    if (!imageRegion || imageRegion.role !== "image" || blueprint.optionalImage.maxAreaRatio <= 0 || blueprint.visualRatios.image <= 0) {
      context.addIssue({ code: "custom", message: "Enabled image must reference an image region and positive ratios", path: ["optionalImage"] });
    }
  } else if (blueprint.optionalImage.regionId !== undefined || blueprint.optionalImage.maxAreaRatio !== 0 || blueprint.visualRatios.image !== 0) {
    context.addIssue({ code: "custom", message: "Disabled image must have zero ratios and no region", path: ["optionalImage"] });
  }
  if (blueprint.visualRatios.text + blueprint.visualRatios.image + blueprint.visualRatios.whitespace > 1.001) {
    context.addIssue({ code: "custom", message: "Visual ratios cannot exceed one", path: ["visualRatios"] });
  }
  if (colorContrastRatio(blueprint.palette.text, blueprint.palette.background) < 4.5
    || colorContrastRatio(blueprint.palette.text, blueprint.palette.surface) < 4.5
    || colorContrastRatio(blueprint.palette.text, blueprint.palette.secondary) < 4.5
    || colorContrastRatio(blueprint.palette.primary, blueprint.palette.background) < 4.5) {
    context.addIssue({ code: "custom", message: "Palette contrast is inaccessible", path: ["palette"] });
  }
});

export type TemplateBlueprint = z.infer<typeof templateBlueprintSchema>;
export type TemplateRegion = z.infer<typeof regionSchema>;

export const TEMPLATE_BLUEPRINT_JSON_SCHEMA = {
  ...z.toJSONSchema(templateBlueprintSchema, { target: "draft-7" }),
  $comment: "Server validation additionally enforces unique region IDs and capability tags, required unique title/page-number roles, a body role, grid containment, image-region consistency, visual-ratio totals, and WCAG contrast.",
  "x-serverValidation": [
    "unique-region-ids", "unique-capability-tags", "required-title-body-page-roles", "grid-containment",
    "image-region-consistency", "visual-ratio-total", "wcag-contrast",
  ],
};
