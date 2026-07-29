import {
  hashCanonical,
  sourceDocumentSchema,
  type SourceDocument,
} from "../domain/source-document.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { normalizeSource } from "./content-normalizer.js";
import type { PagePartition } from "./semantic-paginator.js";

export interface AdditionalHeadingLabel {
  label: string;
  value: string;
}

export interface ExplicitHeadingMetadata {
  level1?: string;
  level2?: string;
  level3?: string;
  level4?: string;
  additionalLabels: AdditionalHeadingLabel[];
}

export interface ExplicitPageChunk {
  pageNumber: number;
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
  body: string;
  bodyStart: number;
  bodyEnd: number;
  title: string;
  headingMetadata: ExplicitHeadingMetadata;
}

export type ExplicitPageParseResult =
  | { mode: "explicit"; pages: ExplicitPageChunk[] }
  | { mode: "unmarked" };

export interface PartitionDeckSourceInput {
  sourceText: string;
  pageNumbers: number[];
}

export interface ExplicitPagePartition extends PagePartition {
  body: string;
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
  bodyStart: number;
  bodyEnd: number;
  headingMetadata: ExplicitHeadingMetadata;
  normalizedSource: SourceDocument;
}

interface SourceLine {
  start: number;
  contentEnd: number;
  end: number;
  text: string;
}

interface Marker {
  pageNumber: number;
  lineIndex: number;
  start: number;
}

const PAGE_MARKER = /^[\t ]*<page[\t ]+([0-9]+)>[\t ]*$/i;
const MARKER_LIKE = /^[\t ]*<[\t ]*page\b/i;
const BODY_LABEL = /^[\t ]*正文[\t ]*[：:][\t ]*(.*)$/u;
const HEADING_LABEL = /^([^:：\r\n]{1,40})[：:]\s*(.*)$/u;
const LEVEL_LABELS = new Map<string, keyof Pick<ExplicitHeadingMetadata, "level1" | "level2" | "level3" | "level4">>([
  ["一级标题", "level1"],
  ["二级标题", "level2"],
  ["三级标题", "level3"],
  ["四级标题", "level4"],
]);

function explicitPageError(message: string, recovery: string): never {
  throw new WorkflowError({
    code: "INPUT_INVALID",
    stage: "parse_explicit_pages",
    retryable: false,
    message,
    recovery,
  });
}

function partitionError(message: string, recovery: string): never {
  throw new WorkflowError({
    code: "INPUT_INVALID",
    stage: "partition_deck_source",
    retryable: false,
    message,
    recovery,
  });
}

function scanLines(sourceText: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start < sourceText.length) {
    const newline = sourceText.indexOf("\n", start);
    const end = newline === -1 ? sourceText.length : newline + 1;
    let contentEnd = newline === -1 ? sourceText.length : newline;
    if (contentEnd > start && sourceText[contentEnd - 1] === "\r") contentEnd -= 1;
    lines.push({
      start,
      contentEnd,
      end,
      text: sourceText.slice(start, contentEnd),
    });
    start = end;
  }

  return lines;
}

function trimRange(sourceText: string, start: number, end: number): { start: number; end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(sourceText[trimmedStart])) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/u.test(sourceText[trimmedEnd - 1])) trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}

function titleFor(metadata: ExplicitHeadingMetadata, pageNumber: number): string {
  const title = metadata.level4 ?? metadata.level3 ?? metadata.level2 ?? metadata.level1;
  if (!title) {
    explicitPageError(
      `Page ${pageNumber} does not declare a supported heading level`,
      "Add at least one labeled heading such as 一级标题： before 正文：.",
    );
  }
  return title;
}

function parseChunk(
  sourceText: string,
  lines: SourceLine[],
  marker: Marker,
  sourceEnd: number,
): ExplicitPageChunk {
  const metadata: ExplicitHeadingMetadata = { additionalLabels: [] };
  let bodyLabelLine: SourceLine | undefined;

  for (let index = marker.lineIndex + 1; index < lines.length && lines[index].start < sourceEnd; index += 1) {
    const line = lines[index];
    const trimmed = line.text.trim();
    if (!trimmed) continue;

    if (BODY_LABEL.test(line.text)) {
      bodyLabelLine = line;
      break;
    }

    const labelMatch = trimmed.match(HEADING_LABEL);
    if (!labelMatch) {
      explicitPageError(
        `Page ${marker.pageNumber} contains unlabeled metadata before 正文：`,
        "Use labeled heading lines before 正文：, or move the content into the page body.",
      );
    }

    const label = labelMatch[1].trim();
    const value = labelMatch[2].trim();
    const levelKey = LEVEL_LABELS.get(label);
    if (!levelKey) {
      metadata.additionalLabels.push({ label, value });
      continue;
    }
    if (!value) {
      explicitPageError(
        `Page ${marker.pageNumber} has an empty ${label}`,
        `Provide heading text after ${label}：.`,
      );
    }
    if (metadata[levelKey] !== undefined) {
      explicitPageError(
        `Page ${marker.pageNumber} declares ${label} more than once`,
        `Keep exactly one ${label}： line on each page.`,
      );
    }
    metadata[levelKey] = value;
  }

  if (!bodyLabelLine) {
    explicitPageError(
      `Page ${marker.pageNumber} is missing the 正文： label`,
      "Add a full labeled 正文： line after the page headings.",
    );
  }

  const colonIndex = bodyLabelLine.text.search(/[：:]/u);
  const contentAfterLabel = bodyLabelLine.text.slice(colonIndex + 1);
  const inlineWhitespace = contentAfterLabel.match(/^[\t ]*/u)?.[0].length ?? 0;
  const untrimmedBodyStart = contentAfterLabel.slice(inlineWhitespace).length > 0
    ? bodyLabelLine.start + colonIndex + 1 + inlineWhitespace
    : bodyLabelLine.end;
  const bodyRange = trimRange(sourceText, untrimmedBodyStart, sourceEnd);
  if (bodyRange.start === bodyRange.end) {
    explicitPageError(
      `Page ${marker.pageNumber} body is empty`,
      "Add fact-bearing body content after 正文：.",
    );
  }

  return {
    pageNumber: marker.pageNumber,
    sourceText: sourceText.slice(marker.start, sourceEnd),
    sourceStart: marker.start,
    sourceEnd,
    body: sourceText.slice(bodyRange.start, bodyRange.end),
    bodyStart: bodyRange.start,
    bodyEnd: bodyRange.end,
    title: titleFor(metadata, marker.pageNumber),
    headingMetadata: metadata,
  };
}

export function parseExplicitPages(sourceText: string): ExplicitPageParseResult {
  const lines = scanLines(sourceText);
  const markers: Marker[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const markerMatch = line.text.match(PAGE_MARKER);
    if (markerMatch) {
      const pageNumber = Number(markerMatch[1]);
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        explicitPageError(
          `Explicit page number must be a positive safe integer: ${markerMatch[1]}`,
          "Use a marker such as <page 1> on its own line.",
        );
      }
      markers.push({ pageNumber, lineIndex: index, start: line.start });
      continue;
    }

    if (MARKER_LIKE.test(line.text)) {
      explicitPageError(
        `Malformed explicit page marker: ${line.text.trim()}`,
        "Use the exact full-line form <page N>, where N is a positive integer.",
      );
    }
  }

  if (markers.length === 0) return { mode: "unmarked" };

  const preamble = sourceText.slice(0, markers[0].start);
  if (preamble.trim().length > 0) {
    explicitPageError(
      "Lexical content before the first explicit page marker has no declared page",
      "Move that content after a <page N> marker or remove it from the deck source.",
    );
  }

  if (markers.some((marker, index) => index > 0 && marker.pageNumber <= markers[index - 1].pageNumber)) {
    explicitPageError(
      "Explicit page markers must be unique and strictly increasing",
      "Renumber the full-line <page N> markers in ascending order without duplicates.",
    );
  }

  return {
    mode: "explicit",
    pages: markers.map((marker, index) => parseChunk(
      sourceText,
      lines,
      marker,
      markers[index + 1]?.start ?? sourceText.length,
    )),
  };
}

function validateRequestedPages(pageNumbers: number[]): void {
  if (pageNumbers.length === 0
    || pageNumbers.some((pageNumber) => !Number.isSafeInteger(pageNumber) || pageNumber < 1)
    || pageNumbers.some((pageNumber, index) => index > 0 && pageNumber <= pageNumbers[index - 1])) {
    partitionError(
      "Requested page numbers must be a non-empty strictly increasing sequence of positive integers",
      "Provide requested page numbers in the same ascending order as the source markers.",
    );
  }
}

function reindexSource(source: SourceDocument, sectionStart: number, factStart: number): SourceDocument {
  const sectionIdMap = new Map<string, string>();
  const sections = source.sections.map((section, index) => {
    const id = `section-${sectionStart + index}`;
    sectionIdMap.set(section.id, id);
    return { ...section, id };
  });
  const facts = source.facts.map((fact, index) => ({
    ...fact,
    id: `fact-${factStart + index}`,
    sourceSectionId: sectionIdMap.get(fact.sourceSectionId) ?? fact.sourceSectionId,
  }));
  const canonical = {
    language: source.language,
    title: source.title,
    sections,
    facts,
  };

  return sourceDocumentSchema.parse({
    ...canonical,
    sourceHash: hashCanonical(canonical),
  });
}

export function partitionDeckSource(input: PartitionDeckSourceInput): ExplicitPagePartition[] {
  validateRequestedPages(input.pageNumbers);
  const parsed = parseExplicitPages(input.sourceText);
  if (parsed.mode === "unmarked") {
    partitionError(
      "Deck source must use explicit <page N> boundaries",
      "Format every page as a full-line <page N> marker, labeled headings, 正文：, and body content.",
    );
  }

  const declaredNumbers = parsed.pages.map((page) => page.pageNumber);
  if (declaredNumbers.length !== input.pageNumbers.length
    || declaredNumbers.some((pageNumber, index) => pageNumber !== input.pageNumbers[index])) {
    const declared = declaredNumbers.join(", ");
    partitionError(
      `Requested page numbers must exactly match explicit markers ${declared}`,
      `Use the requested page list ${declared}, or correct the source markers before planning.`,
    );
  }

  let nextSectionId = 1;
  let nextFactId = 1;

  return parsed.pages.map((chunk) => {
    const localSource = normalizeSource({
      sections: [{ heading: chunk.title, body: chunk.body }],
    });
    const normalizedSource = reindexSource(localSource, nextSectionId, nextFactId);
    nextSectionId += normalizedSource.sections.length;
    nextFactId += normalizedSource.facts.length;

    if (normalizedSource.facts.length === 0) {
      partitionError(
        `Page ${chunk.pageNumber} body does not contain extractable facts`,
        "Add factual body sentences that can be planned into a presentation page.",
      );
    }

    return {
      pageNumber: chunk.pageNumber,
      title: chunk.title,
      body: chunk.body,
      sourceText: chunk.sourceText,
      sourceStart: chunk.sourceStart,
      sourceEnd: chunk.sourceEnd,
      bodyStart: chunk.bodyStart,
      bodyEnd: chunk.bodyEnd,
      headingMetadata: chunk.headingMetadata,
      normalizedSource,
      sourceSections: normalizedSource.sections.map((section) => ({
        heading: section.heading,
        body: section.body,
        ...(section.keyPoints.length > 0 ? { keyPoints: section.keyPoints } : {}),
      })),
      originalSourceSectionIds: normalizedSource.sections.map((section) => section.id),
      originalSourceFactIds: normalizedSource.facts.map((fact) => fact.id),
    };
  });
}
