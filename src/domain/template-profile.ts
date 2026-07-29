import * as z from "zod/v4";

import { slideBlockTypeSchema } from "./slide-spec.js";

const densitySchema = z.enum(["low", "medium", "high"]);

export const templateProfileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  blockCapacity: z.number().int().min(1).max(12),
  supportedBlocks: z.array(slideBlockTypeSchema).min(1),
  imageSlots: z.number().int().min(0).max(12),
  densityRange: z.tuple([densitySchema, densitySchema]),
  maxCharsBySlot: z.record(z.string(), z.number().int().positive()),
  format: z.literal("a4-landscape"),
  status: z.literal("approved"),
}).strict();

export type TemplateProfile = z.infer<typeof templateProfileSchema>;

export interface TemplateSelection {
  slug: string;
  score: number;
  reason: string;
  candidates: Array<{ slug: string; score: number }>;
}
