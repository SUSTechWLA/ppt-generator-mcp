import type { SourceSection } from "../domain/source-document.js";
import { joinChineseClauses } from "../domain/chinese-punctuation.js";

function normalizeSemanticValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Markdown bullet-only sections retain a synthesized body for schema compatibility.
 * Key points are the canonical semantic source in that representation.
 */
export function isSynthesizedKeyPointBody(
  section: Pick<SourceSection, "body" | "keyPoints">,
): boolean {
  return section.keyPoints.length > 0
    && normalizeSemanticValue(section.body) === normalizeSemanticValue(joinChineseClauses(section.keyPoints));
}
