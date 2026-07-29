import type { QualityReport, WorkflowStatus } from "../domain/quality-report.js";
import type { RepairState } from "../services/repair-executor.js";
import { routeRepairs, type RepairAction } from "../services/repair-router.js";

export interface ComposedAttempt {
  html: string;
  screenshotPath: string;
  htmlPath?: string;
  qualityPath?: string;
}

export interface AttemptResult extends ComposedAttempt {
  attempt: number;
  quality: QualityReport;
  actions: RepairAction[];
  state: RepairState;
}

export interface QualityLoopInput {
  initialState: RepairState;
  minScore: number;
  maxAttempts: number;
  compose(input: { state: RepairState; attempt: number }): Promise<ComposedAttempt>;
  evaluate(input: { state: RepairState; attempt: number; composed: ComposedAttempt }): Promise<QualityReport>;
  repair(input: { state: RepairState; actions: RepairAction[]; attempt: number }): Promise<RepairState>;
}

export interface QualityLoopResult {
  status: WorkflowStatus;
  attempts: AttemptResult[];
  selectedAttempt?: number;
}

export async function runQualityLoop(input: QualityLoopInput): Promise<QualityLoopResult> {
  const attempts: AttemptResult[] = [];
  let state = input.initialState;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const composed = await input.compose({ state, attempt });
    const quality = await input.evaluate({ state, attempt, composed });
    if (quality.safeToReturn && quality.hardGatePassed && quality.score >= input.minScore) {
      attempts.push({ ...composed, attempt, quality, actions: [], state });
      return { status: "delivered", attempts, selectedAttempt: attempt };
    }
    const actions = attempt < input.maxAttempts
      ? routeRepairs(quality, { attempt, templateSwitched: state.templateSwitched })
      : [];
    attempts.push({ ...composed, attempt, quality, actions, state });
    if (attempt < input.maxAttempts) state = await input.repair({ state, actions, attempt });
  }

  const selected = attempts
    .filter((attempt) => attempt.quality.safeToReturn)
    .sort((left, right) => right.quality.score - left.quality.score || left.attempt - right.attempt)[0];
  return selected
    ? { status: "best_effort", attempts, selectedAttempt: selected.attempt }
    : { status: "failed", attempts };
}
