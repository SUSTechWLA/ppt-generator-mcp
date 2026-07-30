const CLAUSE_END = /[；;。！？!?，,:：、…](?:[”’」』》）】〕])*$/u;
const LEADING_CLOSING_PUNCTUATION = /^[；;。！？!?，,:：、”’」』》）】〕]/u;
const HORIZONTAL_SPACE = "[ \\t\\u00a0]*";

/**
 * Remove punctuation combinations that are mechanically introduced by text
 * generation or fragment assembly while preserving meaningful mixed marks
 * such as `！？` and Chinese quotation pairs.
 */
export function normalizeChinesePunctuation(value: string): string {
  return value
    .replace(new RegExp(`；(?:${HORIZONTAL_SPACE}；)+`, "gu"), "；")
    .replace(new RegExp(`([。！？])(?:${HORIZONTAL_SPACE}；)+`, "gu"), "$1")
    .replace(new RegExp(`；${HORIZONTAL_SPACE}([。！？])`, "gu"), "$1")
    .replace(new RegExp(`，${HORIZONTAL_SPACE}；`, "gu"), "；")
    .replace(new RegExp(`；${HORIZONTAL_SPACE}，`, "gu"), "；")
    .replace(new RegExp(`([。！？])(?:${HORIZONTAL_SPACE}\\1)+`, "gu"), "$1");
}

export function chineseClauseSeparator(
  left: string,
  right: string,
  separator = "；",
): string {
  const normalizedLeft = normalizeChinesePunctuation(left).trimEnd();
  const normalizedRight = normalizeChinesePunctuation(right).trimStart();
  if (!normalizedLeft || !normalizedRight) return "";
  if (CLAUSE_END.test(normalizedLeft) || LEADING_CLOSING_PUNCTUATION.test(normalizedRight)) return "";
  return separator;
}

export function joinChineseClauses(values: readonly string[], separator = "；"): string {
  let joined = "";
  for (const rawValue of values) {
    const value = normalizeChinesePunctuation(rawValue).trim();
    if (!value) continue;
    joined = joined
      ? `${joined}${chineseClauseSeparator(joined, value, separator)}${value}`
      : value;
  }
  return normalizeChinesePunctuation(joined);
}
