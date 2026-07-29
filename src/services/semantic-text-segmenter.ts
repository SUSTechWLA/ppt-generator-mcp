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

// Generic English policy for period roles that cannot be resolved from punctuation alone.
const ENGLISH_PERIOD_POLICY = {
  titleAbbreviations: new Set(["dr", "mr", "mrs", "ms", "prof"]),
  labelAbbreviations: new Set(["eq", "fig", "no", "sec", "vol"]),
  companySuffixAbbreviations: new Set(["co", "corp", "inc", "llc", "ltd", "plc"]),
  addressAbbreviations: new Set(["ft", "mt", "st"]),
  locationPrepositions: new Set(["at", "from", "in", "near", "to"]),
  continuationInitialisms: new Set(["eg", "ie"]),
  organizationContinuations: new Set([
    "administration",
    "agency",
    "air",
    "army",
    "association",
    "bureau",
    "congress",
    "council",
    "department",
    "embassy",
    "force",
    "government",
    "mission",
    "navy",
    "office",
    "security",
  ]),
  enumerativeCues: new Set(["comprises", "consists", "contains", "following", "include", "includes", "including", "namely"]),
};

const LIST_INTRODUCERS = new Set(["(", ":", ";", "[", "{", "：", "；"]);

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

function previousNonWhitespaceIndex(value: string, start: number): number {
  let index = start;
  while (index >= 0 && /\s/.test(value[index])) index -= 1;
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

function wordAt(value: string, index: number): string {
  let end = index;
  while (end < value.length && isLetterOrNumber(value[end])) end += 1;
  return value.slice(index, end);
}

function isTitleCaseWord(value: string): boolean {
  return /^\p{Lu}[\p{L}\p{N}]*$/u.test(value);
}

function isContextualNumberedMarker(value: string, index: number, segmentStart: number): boolean {
  let start = index;
  while (start > 0 && /\d/.test(value[start - 1])) start -= 1;
  if (start === index || isLetterOrNumber(value[start - 1])) return false;
  if (!/\s/.test(value[index + 1] ?? "")) return false;
  if (!isLetter(value[nextNonWhitespaceIndex(value, index + 1)])) return false;

  if (value.slice(segmentStart, start).trim() === "") return true;
  const previousIndex = previousNonWhitespaceIndex(value, start - 1);
  if (LIST_INTRODUCERS.has(value[previousIndex])) return true;
  return ENGLISH_PERIOD_POLICY.enumerativeCues.has(wordBefore(value, previousIndex + 1).toLowerCase());
}

function isClosedClassAbbreviation(value: string, index: number, segmentStart: number): boolean {
  const abbreviation = wordBefore(value, index).toLowerCase();
  if (!/\s/.test(value[index + 1] ?? "")) return false;
  const nextIndex = nextNonWhitespaceIndex(value, index + 1);
  const nextToken = wordAt(value, nextIndex);
  if (/^\p{Ll}/u.test(nextToken)) {
    return ENGLISH_PERIOD_POLICY.titleAbbreviations.has(abbreviation)
      || ENGLISH_PERIOD_POLICY.labelAbbreviations.has(abbreviation)
      || ENGLISH_PERIOD_POLICY.companySuffixAbbreviations.has(abbreviation)
      || ENGLISH_PERIOD_POLICY.addressAbbreviations.has(abbreviation);
  }
  if (ENGLISH_PERIOD_POLICY.titleAbbreviations.has(abbreviation)) return nextToken.length > 0;
  if (ENGLISH_PERIOD_POLICY.labelAbbreviations.has(abbreviation)) {
    return /^\d/.test(nextToken) || /^[A-Z]$/.test(nextToken);
  }
  if (!ENGLISH_PERIOD_POLICY.addressAbbreviations.has(abbreviation) || !isTitleCaseWord(nextToken)) return false;

  const abbreviationStart = index - abbreviation.length;
  if (value.slice(segmentStart, abbreviationStart).trim() === "") return true;
  const previousIndex = previousNonWhitespaceIndex(value, abbreviationStart - 1);
  return ENGLISH_PERIOD_POLICY.locationPrepositions.has(wordBefore(value, previousIndex + 1).toLowerCase());
}

function initialismContinues(value: string, index: number, initialism: string): boolean {
  const nextIndex = nextNonWhitespaceIndex(value, index + 1);
  if (nextIndex >= value.length) return false;
  if (ENGLISH_PERIOD_POLICY.continuationInitialisms.has(initialism.toLowerCase())) return true;
  if (/[\p{Ll}\p{N}]/u.test(value[nextIndex])) return true;
  const nextToken = wordAt(value, nextIndex);
  if (ENGLISH_PERIOD_POLICY.organizationContinuations.has(nextToken.toLowerCase())) return true;
  const followingIndex = nextNonWhitespaceIndex(value, nextIndex + nextToken.length);
  return isTitleCaseWord(nextToken) && isTitleCaseWord(wordAt(value, followingIndex));
}

function classifyPeriod(value: string, index: number, segmentStart: number): PeriodDecision {
  let runEnd = index + 1;
  while (value[runEnd] === ".") runEnd += 1;
  if (runEnd - index >= 2) return { kind: "terminal", end: runEnd };

  if (value[nextNonWhitespaceIndex(value, index + 1)] === ","
    || isDecimalPoint(value, index)
    || isContextualNumberedMarker(value, index, segmentStart)
    || isClosedClassAbbreviation(value, index, segmentStart)
    || isTokenInternalPeriod(value, index)) return { kind: "protected" };

  const initialism = initialismBefore(value, index);
  if (initialism && initialismContinues(value, index, initialism)) return { kind: "protected" };
  return { kind: "terminal", end: index + 1 };
}

export function segmentSemanticText(value: string): SemanticTextSegment[] {
  const segments: SemanticTextSegment[] = [];
  const quoteStack: string[] = [];
  let segmentStart = 0;
  let pendingPunctuationStart: number | undefined;
  let pendingPunctuationEnd = 0;

  const pushSegment = (end: number): void => {
    let start = segmentStart;
    let trimmedEnd = end;
    while (start < trimmedEnd && /\s/.test(value[start])) start += 1;
    while (trimmedEnd > start && /\s/.test(value[trimmedEnd - 1])) trimmedEnd -= 1;

    if (trimmedEnd > start && /[\p{L}\p{N}]/u.test(value.slice(start, trimmedEnd))) {
      if (pendingPunctuationStart !== undefined) start = pendingPunctuationStart;
      const previousEnd = segments.at(-1)?.end ?? 0;
      segments.push({
        text: value.slice(start, trimmedEnd),
        start,
        end: trimmedEnd,
        gapBefore: value.slice(previousEnd, start),
      });
      pendingPunctuationStart = undefined;
      pendingPunctuationEnd = 0;
    } else if (trimmedEnd > start) {
      pendingPunctuationStart ??= start;
      pendingPunctuationEnd = trimmedEnd;
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
      const decision = classifyPeriod(value, index, segmentStart);
      if (decision.kind === "protected") continue;
      pushSegment(decision.end);
      index = decision.end - 1;
      continue;
    }
    if (character === "…") {
      let runEnd = index + 1;
      while (value[runEnd] === "…") runEnd += 1;
      pushSegment(runEnd);
      index = runEnd - 1;
      continue;
    }
    if (!isTerminal(character)) continue;
    pushSegment(index + 1);
  }

  pushSegment(value.length);
  if (pendingPunctuationStart !== undefined && segments.length > 0) {
    const previous = segments[segments.length - 1];
    previous.text = value.slice(previous.start, pendingPunctuationEnd);
    previous.end = pendingPunctuationEnd;
  }
  return segments;
}
