import type { SourceFact, SourceSection } from "../domain/source-document.js";
import { isSynthesizedKeyPointBody } from "./semantic-source-content.js";
import { segmentSemanticText } from "./semantic-text-segmenter.js";

const NUMBER = /\d[\d,.]*(?:%|万元|元|天|小时|分钟|㎡|个|名|项|次|年|月|日)?/;
const REQUIREMENT = /必须|不得|应当|应在|应于|需在|要求|确保|不超过|至少|严禁/;
const NAME = /《[^》]+》|“[^”]+”|「[^」]+」/;

export function extractFacts(sections: SourceSection[], factStart = 1): SourceFact[] {
  const facts: SourceFact[] = [];

  const losslessSegments = (value: string): string[] => {
    const segments: string[] = [];
    let start = 0;
    while (start < value.length) {
      let end = Math.min(value.length, start + 500);
      if (end < value.length) {
        const code = value.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      if (end <= start) end = Math.min(value.length, start + 1);
      segments.push(value.slice(start, end));
      start = end;
    }
    return segments;
  };

  for (const section of sections) {
    const semanticValues = isSynthesizedKeyPointBody(section)
      ? section.keyPoints
      : [section.body, ...section.keyPoints];
    const candidates = semanticValues
      .flatMap((value) => segmentSemanticText(value).map((segment) => segment.text));

    for (const candidate of candidates) {
      const text = candidate.trim();
      if (!text) continue;

      const kind: SourceFact["kind"] = REQUIREMENT.test(text)
        ? "requirement"
        : NUMBER.test(text)
          ? "number"
          : NAME.test(text)
            ? "name"
            : "conclusion";

      for (const segment of losslessSegments(text)) {
        facts.push({
          id: `fact-${factStart + facts.length}`,
          text: segment,
          kind,
          sourceSectionId: section.id,
        });
      }
    }
  }

  return facts;
}
