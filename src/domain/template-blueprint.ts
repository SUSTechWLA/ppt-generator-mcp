import * as z from "zod/v4";

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const regionRoleSchema = z.enum(["title", "body", "metric", "process", "evidence", "image", "conclusion", "page-number"]);
const componentTypeSchema = z.enum([
  "title-band", "fact-card", "metric-card", "process-card", "evidence-card", "image-card", "conclusion-band", "page-number",
]);

export const TEMPLATE_REGION_COMPONENTS = {
  title: "title-band",
  body: "fact-card",
  metric: "metric-card",
  process: "process-card",
  evidence: "evidence-card",
  image: "image-card",
  conclusion: "conclusion-band",
  "page-number": "page-number",
} as const;

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
    if (region.component !== TEMPLATE_REGION_COMPONENTS[region.role]) {
      context.addIssue({ code: "custom", message: `Region role ${region.role} requires component ${TEMPLATE_REGION_COMPONENTS[region.role]}`, path: ["grid", "regions", index, "component"] });
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
  const imageRegions = blueprint.grid.regions.filter((region) => region.role === "image");
  if (blueprint.optionalImage.enabled) {
    if (!imageRegion || imageRegion.role !== "image" || imageRegions.length !== 1 || blueprint.optionalImage.maxAreaRatio <= 0 || blueprint.visualRatios.image <= 0) {
      context.addIssue({ code: "custom", message: "Enabled image must reference an image region and positive ratios", path: ["optionalImage"] });
    }
  } else if (blueprint.optionalImage.regionId !== undefined || imageRegions.length !== 0 || blueprint.optionalImage.maxAreaRatio !== 0 || blueprint.visualRatios.image !== 0) {
    context.addIssue({ code: "custom", message: "Disabled image must have zero ratios and no region", path: ["optionalImage"] });
  }
  for (const role of ["metric", "process", "evidence"] as const) {
    const hasRegion = blueprint.grid.regions.some((region) => region.role === role);
    const hasCapability = blueprint.capabilityTags.includes(role);
    if (hasRegion !== hasCapability) {
      context.addIssue({ code: "custom", message: `Capability ${role} must exactly match its region`, path: ["capabilityTags"] });
    }
  }
  const hasVisualCapability = blueprint.capabilityTags.includes("visual-support");
  if (hasVisualCapability !== blueprint.optionalImage.enabled) {
    context.addIssue({ code: "custom", message: "Capability visual-support must exactly match the enabled image region", path: ["capabilityTags"] });
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
  $comment: "This JSON Schema describes bounded field shapes. Cross-field rules are the combined JSON Schema + serverValidation contract below and are enforced by the server.",
  "x-roleComponentMapping": TEMPLATE_REGION_COMPONENTS,
  "x-capabilityRegionMapping": {
    metric: "metric",
    process: "process",
    evidence: "evidence",
    "visual-support": "enabled optionalImage with exactly one referenced image region",
  },
  "x-serverValidation": [
    { id: "unique-region-ids", description: "Every grid region id is unique." },
    { id: "unique-capability-tags", description: "Every capability tag is unique." },
    { id: "required-role-cardinality", description: "Exactly one title, at least one body, and exactly one page-number region are required." },
    { id: "grid-containment", description: "Every region ends within the declared grid column count." },
    { id: "role-component-mapping", description: "Every region role uses exactly the component declared by x-roleComponentMapping." },
    { id: "capability-region-bidirectional", description: "metric, process, and evidence tags exist if and only if matching regions exist; visual-support exists if and only if optionalImage is enabled." },
    { id: "single-enabled-image-region", description: "Enabled optionalImage references exactly one image role region and both image ratios are positive." },
    { id: "disabled-image-zero-state", description: "Disabled optionalImage has no image region or regionId and both image ratios are zero." },
    { id: "screenshot-background-forbidden", description: "optionalImage.screenshotAsBackground is always false." },
    { id: "visual-ratio-total", description: "text + image + whitespace ratios do not exceed 1.001." },
    { id: "wcag-contrast-4.5", description: "Text against background, surface and secondary plus primary against background each have contrast ratio at least 4.5." },
  ],
};
