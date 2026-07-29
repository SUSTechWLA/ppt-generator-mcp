import * as z from "zod/v4";

export const documentTypeSchema = z.enum(["bid", "proposal", "presentation"]);
export const pageMetadataSchema = z.object({
  number: z.number().int().min(1).max(9999),
  sectionTitle: z.string().trim().min(1).max(60),
  partNumber: z.string().trim().min(1).max(20),
  partLabel: z.string().trim().min(1).max(30),
  chapterLabel: z.string().trim().min(1).max(80),
  subsectionTitle: z.string().trim().min(1).max(100),
}).strict();

export type DocumentType = z.infer<typeof documentTypeSchema>;
export type PageMetadata = z.infer<typeof pageMetadataSchema>;
