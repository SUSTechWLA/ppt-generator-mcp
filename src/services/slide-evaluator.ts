import * as z from "zod/v4";

import { qualityDimensionsSchema, qualityIssueSchema, qualityReportSchema, type QualityCategory, type QualityDimensions, type QualityIssue, type QualityReport } from "../domain/quality-report.js";
import type { SourceDocument } from "../domain/source-document.js";
import type { SlideSpec } from "../domain/slide-spec.js";
import type { ReviewProvider } from "../providers/contracts.js";
import type { DeterministicReport } from "./deterministic-evaluator.js";
import type { RenderResult } from "./page-renderer.js";

const reviewSchema = z.object({
  dimensions: qualityDimensionsSchema,
  issues: z.array(qualityIssueSchema),
}).strict();

const WEIGHTS = {
  fidelity: 0.25,
  structure: 0.15,
  readability: 0.20,
  layout: 0.20,
  asset: 0.10,
  technical: 0.10,
} as const;

function localDimensions(deterministic: DeterministicReport): QualityDimensions {
  const dimensions: QualityDimensions = {
    fidelity: 92,
    structure: 95,
    readability: 96,
    layout: 96,
    asset: 92,
    technical: 100,
  };
  for (const issue of deterministic.issues) {
    const deduction = issue.severity === "error" ? 25 : 6;
    dimensions[issue.category] = Math.max(0, dimensions[issue.category] - deduction);
  }
  return dimensions;
}

function deduplicateIssues(issues: QualityIssue[]): QualityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}|${issue.targetId ?? ""}|${issue.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((issue, index) => ({ ...issue, id: issue.id || `quality-${index + 1}` }));
}

export async function evaluateSlide(input: {
  source: SourceDocument;
  spec: SlideSpec;
  render: RenderResult;
  deterministic: DeterministicReport;
  review?: ReviewProvider;
}): Promise<QualityReport> {
  let dimensions: QualityDimensions;
  let reviewIssues: QualityIssue[] = [];
  if (input.review) {
    const raw = await input.review.review({
      system: `你是严格的中文商务单页 QA。仅返回 JSON，按六个维度各打 0–100 分：fidelity 忠实原文；structure 结论与层次；readability 可读性；layout 视觉布局；asset 图片相关性和质量；technical 技术完整性。issues 必须包含 id、severity、category、evidence、suggestedAction，可选 targetId。不得忽略确定性检查失败。`,
      screenshotDataUrl: input.render.screenshotDataUrl,
      payload: {
        sourceFacts: input.source.facts,
        slideSpec: input.spec,
        deterministicIssues: input.deterministic.issues,
      },
    });
    const parsed = reviewSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Review schema validation failed: ${z.prettifyError(parsed.error)}`);
    dimensions = parsed.data.dimensions;
    reviewIssues = parsed.data.issues;
  } else {
    dimensions = localDimensions(input.deterministic);
  }

  const score = Math.round((Object.entries(WEIGHTS) as Array<[QualityCategory, number]>).reduce(
    (sum, [category, weight]) => sum + dimensions[category] * weight,
    0,
  ) * 10) / 10;
  const issues = deduplicateIssues([...input.deterministic.issues, ...reviewIssues]);
  const fidelityHardFailure = reviewIssues.some((issue) => issue.category === "fidelity" && issue.severity === "error");
  return qualityReportSchema.parse({
    score,
    safeToReturn: input.deterministic.safeToReturn,
    hardGatePassed: input.deterministic.hardGatePassed && input.deterministic.safeToReturn && !fidelityHardFailure,
    dimensions,
    issues,
  });
}
