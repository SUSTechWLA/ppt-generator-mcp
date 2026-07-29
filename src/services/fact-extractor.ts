import type { SourceFact, SourceSection } from "../domain/source-document.js";
import { isSynthesizedKeyPointBody } from "./semantic-source-content.js";
import { segmentSemanticText } from "./semantic-text-segmenter.js";

const NUMBER = /\d[\d,.]*(?:%|万元|元|天|小时|分钟|㎡|个|名|项|次|年|月|日)?/;
const REQUIREMENT = /必须|不得|应当|应在|应于|需在|要求|确保|不超过|至少|严禁/;
const NAME = /《[^》]+》|“[^”]+”|「[^」]+」/;

export function extractFacts(sections: SourceSection[]): SourceFact[] {
  const facts: SourceFact[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    const semanticValues = isSynthesizedKeyPointBody(section)
      ? section.keyPoints
      : [section.body, ...section.keyPoints];
    const candidates = semanticValues
      .flatMap((value) => segmentSemanticText(value).map((segment) => segment.text));

    for (const candidate of candidates) {
      const text = candidate.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);

      const kind: SourceFact["kind"] = REQUIREMENT.test(text)
        ? "requirement"
        : NUMBER.test(text)
          ? "number"
          : NAME.test(text)
            ? "name"
            : "conclusion";

      facts.push({
        id: `fact-${facts.length + 1}`,
        text: text.slice(0, 500),
        kind,
        sourceSectionId: section.id,
      });

      if (facts.length >= 200) return facts;
    }
  }

  return facts;
}
