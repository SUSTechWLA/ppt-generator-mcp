import {
  generateSlideInputSchema,
  hashCanonical,
  sourceDocumentSchema,
  type GenerateSlideInput,
  type SourceDocument,
  type SourceSection,
} from "../domain/source-document.js";
import { joinChineseClauses, normalizeChinesePunctuation } from "../domain/chinese-punctuation.js";
import { WorkflowError } from "../domain/workflow-error.js";
import { extractFacts } from "./fact-extractor.js";

interface DraftSection {
  heading: string;
  paragraphs: string[];
  keyPoints: string[];
}

function normalizeText(value: string): string {
  return normalizeChinesePunctuation(value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ \u00a0]+\n/g, "\n")
    .trim());
}

function markdownSections(sourceText: string): {
  title?: string;
  sections: Array<Omit<SourceSection, "id" | "order">>;
} {
  const text = normalizeText(sourceText);
  const lines = text.split("\n");
  const drafts: DraftSection[] = [];
  let title: string | undefined;
  let current: DraftSection | undefined;
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    const paragraph = paragraphBuffer.join(" ").trim();
    paragraphBuffer = [];
    if (!paragraph) return;
    if (!current) current = { heading: "正文", paragraphs: [], keyPoints: [] };
    current.paragraphs.push(paragraph);
  };

  const flushSection = () => {
    flushParagraph();
    if (!current) return;
    if (current.paragraphs.length > 0 || current.keyPoints.length > 0) {
      drafts.push(current);
    }
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushSection();
      const headingText = heading[2].replace(/^[\d.、]+\s*/, "").trim();
      if (!title) {
        title = headingText;
        current = { heading: headingText, paragraphs: [], keyPoints: [] };
      } else {
        current = { heading: headingText, paragraphs: [], keyPoints: [] };
      }
      continue;
    }

    const bullet = line.match(/^(?:[-*•]|\d+[.、)])\s*(.+)$/);
    if (bullet) {
      flushParagraph();
      if (!current) current = { heading: "正文", paragraphs: [], keyPoints: [] };
      current.keyPoints.push(bullet[1].trim());
      continue;
    }

    if (!line) {
      flushParagraph();
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushSection();

  return {
    title,
    sections: drafts.map((draft) => ({
      heading: draft.heading,
      body: draft.paragraphs.join("\n\n") || joinChineseClauses(draft.keyPoints),
      keyPoints: draft.keyPoints,
    })),
  };
}

export function normalizeSource(rawInput: GenerateSlideInput): SourceDocument {
  const input = generateSlideInputSchema.parse(rawInput);
  const parsed = input.sourceText
    ? markdownSections(input.sourceText)
    : {
        title: input.sections?.[0]?.heading,
        sections: (input.sections ?? []).map((section) => ({
          heading: normalizeText(section.heading),
          body: normalizeText(section.body),
          keyPoints: (section.keyPoints ?? []).map(normalizeText).filter(Boolean),
        })),
      };

  if (parsed.sections.length === 0) {
    throw new WorkflowError({
      code: "INPUT_INVALID",
      stage: "normalize_input",
      retryable: false,
      message: "Source content does not contain a usable section",
    });
  }

  const sections: SourceSection[] = parsed.sections.map((section, index) => ({
    id: `section-${index + 1}`,
    heading: section.heading,
    body: section.body,
    keyPoints: section.keyPoints,
    order: index,
  }));
  const facts = extractFacts(sections);
  const canonical = {
    language: "zh-CN" as const,
    title: parsed.title,
    sections,
    facts,
  };

  return sourceDocumentSchema.parse({
    ...canonical,
    sourceHash: hashCanonical(canonical),
  });
}
