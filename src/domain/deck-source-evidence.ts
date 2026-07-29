import type { PageMetadata } from "./document-context.js";
import { hashCanonical, type SourceSectionInput } from "./source-document.js";

export interface DeckSourceEvidenceSlide {
  page: PageMetadata;
  sourceSections: SourceSectionInput[];
  originalSourceSectionIds: string[];
}

export interface DeckSourceEvidenceInput {
  pageNumbers: number[];
  slides: DeckSourceEvidenceSlide[];
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function canonicalDeckSourceEvidence(input: DeckSourceEvidenceInput): unknown {
  return {
    version: 1,
    pageNumbers: input.pageNumbers,
    pages: input.slides.map((slide) => ({
      page: {
        number: slide.page.number,
        sectionTitle: normalizeLineEndings(slide.page.sectionTitle),
        partNumber: normalizeLineEndings(slide.page.partNumber),
        partLabel: normalizeLineEndings(slide.page.partLabel),
        chapterLabel: normalizeLineEndings(slide.page.chapterLabel),
        subsectionTitle: normalizeLineEndings(slide.page.subsectionTitle),
      },
      sourceSections: slide.sourceSections.map((section) => ({
        heading: normalizeLineEndings(section.heading),
        body: normalizeLineEndings(section.body),
        keyPoints: (section.keyPoints ?? []).map(normalizeLineEndings),
      })),
      originalSourceSectionIds: slide.originalSourceSectionIds,
    })),
  };
}

export function hashDeckSourceEvidence(input: DeckSourceEvidenceInput): string {
  return hashCanonical(canonicalDeckSourceEvidence(input));
}
