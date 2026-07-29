export interface SemanticTextSegment {
  text: string;
  start: number;
  end: number;
  gapBefore: string;
}

const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "“": "”",
  "‘": "’",
  "「": "」",
  "『": "』",
  "《": "》",
};

function isTerminal(character: string | undefined): boolean {
  return character !== undefined && /[。！？!?；;.]/.test(character);
}

function isDecimalPoint(value: string, index: number): boolean {
  return value[index] === "."
    && /\d/.test(value[index - 1] ?? "")
    && /\d/.test(value[index + 1] ?? "");
}

function isOrderedListMarkerPeriod(value: string, index: number, segmentStart: number): boolean {
  return value[index] === "."
    && /^\d+$/.test(value.slice(segmentStart, index).trim())
    && /\s/.test(value[index + 1] ?? "");
}

function isLetterOrNumber(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

function isTokenInternalPeriod(value: string, index: number): boolean {
  return value[index] === "."
    && isLetterOrNumber(value[index - 1])
    && isLetterOrNumber(value[index + 1]);
}

function isInitialismPeriod(value: string, index: number): boolean {
  if (value[index] !== ".") return false;

  let cursor = index;
  let groupCount = 0;
  while (cursor > 0 && value[cursor] === "." && /\p{L}/u.test(value[cursor - 1])) {
    groupCount += 1;
    cursor -= 2;
  }
  return groupCount >= 2 && !isLetterOrNumber(value[cursor]);
}

export function segmentSemanticText(value: string): SemanticTextSegment[] {
  const segments: SemanticTextSegment[] = [];
  const quoteStack: string[] = [];
  let segmentStart = 0;

  const pushSegment = (end: number): void => {
    let start = segmentStart;
    let trimmedEnd = end;
    while (start < trimmedEnd && /\s/.test(value[start])) start += 1;
    while (trimmedEnd > start && /\s/.test(value[trimmedEnd - 1])) trimmedEnd -= 1;

    if (trimmedEnd > start) {
      const previousEnd = segments.at(-1)?.end ?? 0;
      segments.push({
        text: value.slice(start, trimmedEnd),
        start,
        end: trimmedEnd,
        gapBefore: value.slice(previousEnd, start),
      });
    }

    segmentStart = end;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const expectedClose = quoteStack.at(-1);

    if (character === "\"") {
      if (expectedClose === "\"") quoteStack.pop();
      else quoteStack.push("\"");
      if (quoteStack.length === 0 && isTerminal(value[index - 1])) pushSegment(index + 1);
      continue;
    }

    if (QUOTE_PAIRS[character]) {
      quoteStack.push(QUOTE_PAIRS[character]);
      continue;
    }

    if (expectedClose === character) {
      quoteStack.pop();
      if (quoteStack.length === 0 && isTerminal(value[index - 1])) pushSegment(index + 1);
      continue;
    }

    if (quoteStack.length > 0) continue;
    if (character === "\n" || character === "\r") {
      pushSegment(index);
      continue;
    }
    if (!isTerminal(character)
      || isDecimalPoint(value, index)
      || isOrderedListMarkerPeriod(value, index, segmentStart)
      || isTokenInternalPeriod(value, index)
      || isInitialismPeriod(value, index)) continue;
    pushSegment(index + 1);
  }

  pushSegment(value.length);
  return segments;
}
