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
const MAX_PERCENT_DECODE_ROUNDS = 4;

function decodePercentOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
}

function diagnosticViews(value: string): string[] {
  const decoded: string[] = [value.normalize("NFKC")];
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    const next = decodePercentOnce(decoded.at(-1)!).normalize("NFKC");
    if (next === decoded.at(-1)) break;
    decoded.push(next);
  }
  const views = new Set<string>();
  for (const candidate of decoded) {
    views.add(candidate);
    views.add(candidate.replace(/[\p{White_Space}\p{Cf}\p{Cc}]+/gu, " "));
    views.add(candidate.replace(/[\p{White_Space}\p{Cf}\p{Cc}]+/gu, ""));
  }
  return [...views];
}

function unsafeCanonicalView(value: string): boolean {
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
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(value)
    || /\b[A-Za-z0-9+/]{40,}={0,2}\b/u.test(value);
}

export function hasUnsafeDiagnosticText(value: string): boolean {
  if (value.length > MAX_DIAGNOSTIC_SCAN_LENGTH) return true;
  return diagnosticViews(value).some(unsafeCanonicalView);
}

function normalizeIssue(issue: QualityIssue, index: number): QualityIssue {
  if (![issue.id, issue.evidence, issue.targetId ?? "", issue.suggestedAction].some(hasUnsafeDiagnosticText)) return issue;
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
