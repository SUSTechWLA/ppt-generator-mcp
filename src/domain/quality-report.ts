import * as z from "zod/v4";

export const qualityCategorySchema = z.enum([
  "fidelity",
  "structure",
  "readability",
  "layout",
  "asset",
  "technical",
]);

export const qualityIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  category: qualityCategorySchema,
  evidence: z.string().min(1).max(500),
  targetId: z.string().max(100).optional(),
  suggestedAction: z.string().min(1).max(300),
}).strict();

export const qualityDimensionsSchema = z.object({
  fidelity: z.number().min(0).max(100),
  structure: z.number().min(0).max(100),
  readability: z.number().min(0).max(100),
  layout: z.number().min(0).max(100),
  asset: z.number().min(0).max(100),
  technical: z.number().min(0).max(100),
}).strict();

export const qualityReportSchema = z.object({
  score: z.number().min(0).max(100),
  safeToReturn: z.boolean(),
  hardGatePassed: z.boolean(),
  dimensions: qualityDimensionsSchema,
  issues: z.array(qualityIssueSchema),
}).strict();

export type QualityCategory = z.infer<typeof qualityCategorySchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type QualityDimensions = z.infer<typeof qualityDimensionsSchema>;
export type QualityReport = z.infer<typeof qualityReportSchema>;
export type WorkflowStatus = "delivered" | "best_effort" | "failed";

export const generateSlideOutputSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["delivered", "best_effort", "failed"]),
  selectedTemplate: z.object({
    slug: z.string(),
    reason: z.string(),
  }).strict(),
  artifacts: z.object({
    htmlPath: z.string(),
    previewPath: z.string(),
    manifestPath: z.string(),
  }).strict(),
  quality: z.object({
    score: z.number().min(0).max(100),
    threshold: z.number().min(70).max(95),
    hardGatePassed: z.boolean(),
    attempts: z.number().int().min(1).max(3),
    dimensions: qualityDimensionsSchema,
    remainingIssues: z.array(qualityIssueSchema),
  }).strict(),
  summary: z.string().min(1).max(500),
}).strict();

export type GenerateSlideOutput = z.infer<typeof generateSlideOutputSchema>;
