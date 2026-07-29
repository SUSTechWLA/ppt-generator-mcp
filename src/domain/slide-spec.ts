import * as z from "zod/v4";

export const slideBlockTypeSchema = z.enum([
  "text",
  "image",
  "table",
  "process",
  "metric",
]);

export const slideBlockSchema = z.object({
  id: z.string().regex(/^block-\d+$/),
  type: slideBlockTypeSchema,
  title: z.string().trim().min(2).max(30),
  body: z.string().trim().min(1).max(500),
  bullets: z.array(z.string().trim().min(1).max(80)).max(6),
  metrics: z.array(z.object({
    label: z.string().trim().min(1).max(20),
    value: z.string().trim().min(1).max(30),
  }).strict()).max(6),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
}).strict();

export const assetSpecSchema = z.object({
  id: z.string().regex(/^(?:p\d+-)?(?:img|icon)-\d{3}$/),
  type: z.enum(["image", "icon"]),
  blockId: z.string().regex(/^block-\d+$/),
  prompt: z.string().trim().min(10).max(1_200),
  alt: z.string().trim().min(2).max(120),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  width: z.literal(1792),
  height: z.literal(1024),
}).strict();

export const slideSpecSchema = z.object({
  title: z.string().trim().min(4).max(40),
  eyebrow: z.string().trim().max(40).optional(),
  conclusion: z.string().trim().min(4).max(160),
  blocks: z.array(slideBlockSchema).min(3).max(6),
  assets: z.array(assetSpecSchema).max(6),
  sourceFactIds: z.array(z.string().regex(/^fact-\d+$/)).min(1),
  designIntent: z.object({
    tone: z.literal("professional"),
    density: z.enum(["low", "medium", "high"]),
    visualRatio: z.number().min(0).max(1),
  }).strict(),
}).strict();

export type SlideBlockType = z.infer<typeof slideBlockTypeSchema>;
export type SlideBlock = z.infer<typeof slideBlockSchema>;
export type AssetSpec = z.infer<typeof assetSpecSchema>;
export type SlideSpec = z.infer<typeof slideSpecSchema>;

export interface GeneratedAsset {
  id: string;
  promptHash: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
  filePath: string;
  dataUrl: string;
  reused: boolean;
}
