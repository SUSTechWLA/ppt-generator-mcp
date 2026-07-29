import type { QualityReport } from "../domain/quality-report.js";

export type RepairAction =
  | { type: "rewrite_block"; targetId: string; reasonIssueId: string }
  | { type: "restore_fact"; factId: string; targetId: string; reasonIssueId: string }
  | { type: "regenerate_asset"; targetId: string; reasonIssueId: string }
  | { type: "switch_template"; reasonIssueId: string }
  | { type: "adjust_token"; token: "font-scale" | "spacing-scale" | "contrast-mode"; value: number | "high"; reasonIssueId: string };

export function routeRepairs(
  report: QualityReport,
  state: { attempt: number; templateSwitched: boolean },
): RepairAction[] {
  const actions: RepairAction[] = [];
  for (const issue of report.issues.filter((candidate) => candidate.severity === "error")) {
    if (issue.category === "layout") {
      if (issue.targetId?.startsWith("block-") && /overflow|溢出/i.test(issue.evidence)) {
        actions.push({ type: "rewrite_block", targetId: issue.targetId, reasonIssueId: issue.id });
      } else if (!state.templateSwitched) {
        actions.push({ type: "switch_template", reasonIssueId: issue.id });
      } else {
        actions.push({ type: "adjust_token", token: "font-scale", value: Math.max(0.86, 1 - state.attempt * 0.04), reasonIssueId: issue.id });
      }
    } else if (issue.category === "readability") {
      if (/contrast|对比度/i.test(issue.evidence)) actions.push({ type: "adjust_token", token: "contrast-mode", value: "high", reasonIssueId: issue.id });
      else if (issue.targetId?.startsWith("block-")) actions.push({ type: "rewrite_block", targetId: issue.targetId, reasonIssueId: issue.id });
    } else if (issue.category === "asset" && issue.targetId) {
      actions.push({ type: "regenerate_asset", targetId: issue.targetId.replace(/^image-/, "img-"), reasonIssueId: issue.id });
    } else if (issue.category === "fidelity") {
      const factId = issue.evidence.match(/fact-\d+/)?.[0];
      if (factId && issue.targetId) actions.push({ type: "restore_fact", factId, targetId: issue.targetId, reasonIssueId: issue.id });
      else if (issue.targetId?.startsWith("block-")) actions.push({ type: "rewrite_block", targetId: issue.targetId, reasonIssueId: issue.id });
    } else if (issue.targetId?.startsWith("block-")) {
      actions.push({ type: "rewrite_block", targetId: issue.targetId, reasonIssueId: issue.id });
    }
    if (actions.length >= 2) break;
  }
  if (actions.length === 0 && report.score < 85) {
    actions.push({ type: "adjust_token", token: "spacing-scale", value: Math.max(0.88, 1 - state.attempt * 0.03), reasonIssueId: report.issues[0]?.id ?? `score-${state.attempt}` });
  }
  return actions;
}
