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

// Closed class of titles and document labels whose period normally introduces a continuation.
const CONTINUATION_ABBREVIATIONS = new Set([
  "dr",
  "eq",
  "fig",
  "mr",
  "mrs",
  "ms",
  "no",
  "prof",
  "sec",
  "vol",
]);

type PeriodDecision =
  | { kind: "protected" }
  | { kind: "terminal"; end: number };

function isTerminal(character: string | undefined): boolean {
  return character !== undefined && (/[。！？!?；;.]/.test(character) || character === "…");
}

function isDecimalPoint(value: string, index: number): boolean {
  return value[index] === "."
    && /\d/.test(value[index - 1] ?? "")
    && /\d/.test(value[index + 1] ?? "");
}

function isLetterOrNumber(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

function isLetter(character: string | undefined): boolean {
  return character !== undefined && /\p{L}/u.test(character);
}

function nextNonWhitespaceIndex(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function isTokenInternalPeriod(value: string, index: number): boolean {
  return value[index] === "."
    && isLetterOrNumber(value[index - 1])
    && isLetterOrNumber(value[index + 1]);
}

function initialismBefore(value: string, index: number): string | undefined {
  let cursor = index;
  const letters: string[] = [];
  while (cursor > 0 && value[cursor] === "." && isLetter(value[cursor - 1])) {
    letters.unshift(value[cursor - 1]);
    cursor -= 2;
  }
  return letters.length >= 2 && !isLetterOrNumber(value[cursor]) ? letters.join("") : undefined;
}

function wordBefore(value: string, index: number): string {
  let start = index;
  while (start > 0 && isLetter(value[start - 1])) start -= 1;
  return value.slice(start, index);
}

function isContextualNumberedMarker(value: string, index: number): boolean {
  let start = index;
  while (start > 0 && /\d/.test(value[start - 1])) start -= 1;
  if (start === index || isLetterOrNumber(value[start - 1])) return false;
  if (!/\s/.test(value[index + 1] ?? "")) return false;
  return isLetter(value[nextNonWhitespaceIndex(value, index + 1)]);
}

function isClosedClassAbbreviation(value: string, index: number): boolean {
  const abbreviation = wordBefore(value, index).toLowerCase();
  if (!CONTINUATION_ABBREVIATIONS.has(abbreviation)) return false;
  if (!/\s/.test(value[index + 1] ?? "")) return false;
  return isLetterOrNumber(value[nextNonWhitespaceIndex(value, index + 1)]);
}

function initialismContinues(value: string, index: number, initialism: string): boolean {
  const nextIndex = nextNonWhitespaceIndex(value, index + 1);
  if (nextIndex >= value.length) return false;
  if (initialism === initialism.toLowerCase()) return true;
  return /[\p{Ll}\p{N}]/u.test(value[nextIndex]);
}

function classifyPeriod(value: string, index: number): PeriodDecision {
  let runEnd = index + 1;
  while (value[runEnd] === ".") runEnd += 1;
  if (runEnd - index >= 2) return { kind: "terminal", end: runEnd };

  if (isDecimalPoint(value, index)
    || isContextualNumberedMarker(value, index)
    || isClosedClassAbbreviation(value, index)
    || isTokenInternalPeriod(value, index)) return { kind: "protected" };

  const initialism = initialismBefore(value, index);
  if (initialism && initialismContinues(value, index, initialism)) return { kind: "protected" };
  return { kind: "terminal", end: index + 1 };
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
    if (character === ".") {
      const decision = classifyPeriod(value, index);
      if (decision.kind === "protected") continue;
      pushSegment(decision.end);
      index = decision.end - 1;
      continue;
    }
    if (!isTerminal(character)) continue;
    pushSegment(index + 1);
  }

  pushSegment(value.length);
  return segments;
}
