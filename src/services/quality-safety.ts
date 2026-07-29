import {
  generateSlideOutputSchema,
  qualityReportSchema,
  type GenerateSlideOutput,
  type QualityIssue,
  type QualityReport,
} from "../domain/quality-report.js";

const CLOSED_EVIDENCE = "External review diagnostic removed by safety policy";
const CLOSED_ACTION = "Re-run the closed quality checks without external diagnostic details";
const MAX_DIAGNOSTIC_SCAN_LENGTH = 8_192;
// Canonicalization transforms are linear and non-amplifying after the first NFKC pass.
// A fixed round budget keeps adversarial nesting O(n); one final probe distinguishes
// a stable boundary result from an unfinished value that must fail closed.
const MAX_CANONICALIZATION_ROUNDS = 32;
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bsol: "\\",
  colon: ":",
  equals: "=",
  gt: ">",
  lt: "<",
  newline: "\n",
  num: "#",
  period: ".",
  quot: "\"",
  semi: ";",
  sol: "/",
  tab: "\t",
};

function decodePercentOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]+));/giu, (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (decimal !== undefined || hex !== undefined) {
      const codePoint = Number.parseInt(decimal ?? hex!, decimal !== undefined ? 10 : 16);
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return HTML_ENTITIES[named!.toLowerCase()] ?? match;
  });
}

interface CanonicalDiagnosticViews {
  views: string[];
  exhausted: boolean;
}

function canonicalizeOnce(value: string): string {
  return decodeHtmlEntitiesOnce(decodePercentOnce(value)).normalize("NFKC");
}

function diagnosticViews(value: string): CanonicalDiagnosticViews {
  const decoded: string[] = [value.normalize("NFKC")];
  let stable = false;
  for (let round = 0; round < MAX_CANONICALIZATION_ROUNDS; round += 1) {
    const next = canonicalizeOnce(decoded.at(-1)!);
    if (next === decoded.at(-1)) break;
    decoded.push(next);
    if (round === MAX_CANONICALIZATION_ROUNDS - 1) stable = canonicalizeOnce(next) === next;
  }
  const views = new Set<string>();
  for (const candidate of decoded) {
    views.add(candidate);
    views.add(candidate.replace(/[\p{White_Space}\p{Cf}\p{Cc}]+/gu, " "));
    views.add(candidate.replace(/[\p{White_Space}\p{Cf}\p{Cc}]+/gu, ""));
  }
  return {
    views: [...views],
    exhausted: decoded.length === MAX_CANONICALIZATION_ROUNDS + 1 && !stable,
  };
}

function structurallyUnsafeCanonicalView(value: string): boolean {
  return /(?:https?|file|ftp):\/\//iu.test(value)
    || /data:[^\s,;]+(?:;base64)?,/iu.test(value)
    || /\bbase64\b/iu.test(value)
    || /(?:^|[\s("'=])(?:\.{1,2}\/|\/(?:[^/\s"'<>]+\/)+[^/\s"'<>]*)/u.test(value)
    || /(?:^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+/u.test(value)
    || /(?:\\n|\n)\s*at\s+[^\n]+:\d+:\d+/u.test(value)
    || /\b(?:Bearer|Basic)\s*[A-Za-z0-9._~+/=-]{8,}/iu.test(value)
    || /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,})\b/u.test(value)
    || /\b(?:authorization|x-api-key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|database_url)\s*[:=]\s*["']?[^\s;"']{4,}/iu.test(value)
    || /\b[A-Za-z0-9_-]{2,}:\/\/[^\s:@/]+:[^\s@/]+@/u.test(value)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(value);
}

function decodedSensitiveBase64(value: string): boolean {
  const tokens = value.match(/\b[A-Za-z0-9+/_-]{8,}={0,2}\b/gu) ?? [];
  for (const token of tokens) {
    const normalized = token.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/u, "");
    if (normalized.length % 4 === 1) continue;
    try {
      const decodedBytes = Buffer.from(normalized, "base64");
      const canonicalBase64 = decodedBytes.toString("base64").replace(/=+$/u, "");
      if (canonicalBase64 !== normalized) continue;
      const decoded = decodedBytes.toString("utf8");
      if (!Buffer.from(decoded, "utf8").equals(decodedBytes)) continue;
      const decodedViews = diagnosticViews(decoded);
      if (decodedViews.exhausted || decodedViews.views.some(structurallyUnsafeCanonicalView)) return true;
    } catch {
      // Invalid base64 is ordinary text, not a decoded diagnostic channel.
    }
  }
  return false;
}

export interface DiagnosticSafetyOptions {
  allowLong?: boolean;
  allowOpaqueBase64?: boolean;
}

export function hasUnsafeDiagnosticText(value: string, options: DiagnosticSafetyOptions = {}): boolean {
  if (!options.allowLong && value.length > MAX_DIAGNOSTIC_SCAN_LENGTH) return true;
  const canonical = diagnosticViews(value);
  if (canonical.exhausted || canonical.views.some(structurallyUnsafeCanonicalView)) return true;
  if (decodedSensitiveBase64(value)) return true;
  return options.allowOpaqueBase64 === false
    ? false
    : (value.normalize("NFKC").match(/[A-Za-z0-9+/]{40,}={0,2}/gu) ?? [])
      .some((token) => /[+/]/u.test(token) || /=+$/u.test(token));
}

function normalizeIssue(issue: QualityIssue, index: number): QualityIssue {
  if (![issue.id, issue.evidence, issue.targetId ?? "", issue.suggestedAction].some((value) => hasUnsafeDiagnosticText(value))) return issue;
  return {
    id: `closed-external-diagnostic-${index + 1}`,
    severity: issue.severity,
    category: issue.category,
    evidence: CLOSED_EVIDENCE,
    suggestedAction: CLOSED_ACTION,
  };
}

export function normalizeQualityReportDiagnostics(report: QualityReport): QualityReport {
  const parsed = qualityReportSchema.parse(report);
  return qualityReportSchema.parse({
    ...parsed,
    issues: parsed.issues.map(normalizeIssue),
  });
}

function unsafeDiagnosticValue(value: unknown, depth: number, seen: Set<object>): boolean {
  if (typeof value === "string") return hasUnsafeDiagnosticText(value);
  if (!value || typeof value !== "object") return false;
  if (depth > 20 || seen.has(value)) return true;
  seen.add(value);
  try {
    return (Array.isArray(value) ? value : Object.values(value)).some((item) => unsafeDiagnosticValue(item, depth + 1, seen));
  } finally {
    seen.delete(value);
  }
}

export function hasUnsafeDiagnosticValue(value: unknown): boolean {
  return unsafeDiagnosticValue(value, 0, new Set<object>());
}

export function normalizePersistedQualityArtifact(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (hasUnsafeDiagnosticValue(value)) throw new Error("Unsafe quality diagnostics rejected");
    return value;
  }
  const record = value as Record<string, unknown>;
  const report = qualityReportSchema.safeParse({
    score: record.score,
    safeToReturn: record.safeToReturn,
    hardGatePassed: record.hardGatePassed,
    dimensions: record.dimensions,
    issues: record.issues,
  });
  if (report.success) return { ...record, ...normalizeQualityReportDiagnostics(report.data) };
  if (hasUnsafeDiagnosticValue(value)) throw new Error("Unsafe quality diagnostics rejected");
  return value;
}

export function normalizeGenerateSlideOutputDiagnostics(output: GenerateSlideOutput): GenerateSlideOutput {
  const parsed = generateSlideOutputSchema.parse(output);
  const selectedTemplateReason = hasUnsafeDiagnosticText(parsed.selectedTemplate.reason)
    ? CLOSED_EVIDENCE
    : parsed.selectedTemplate.reason;
  const summary = hasUnsafeDiagnosticText(parsed.summary) ? CLOSED_EVIDENCE : parsed.summary;
  return generateSlideOutputSchema.parse({
    ...parsed,
    selectedTemplate: { ...parsed.selectedTemplate, reason: selectedTemplateReason },
    quality: {
      ...parsed.quality,
      remainingIssues: parsed.quality.remainingIssues.map(normalizeIssue),
    },
    summary,
  });
}
