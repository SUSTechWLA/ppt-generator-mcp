import type { TemplateDiversityMode } from "../domain/deck-plan.js";

export const MAX_DIVERSITY_CANDIDATES_PER_PAGE = 12;
export const MAX_DIVERSITY_STATES = 256;

export interface DeckTemplateCandidateScore {
  templateSlug: string;
  retainedCharacterCount: number;
  selectionScore: number;
  catalogIndex: number;
}

export interface DeckTemplateDecision {
  candidateIndex: number;
  retainedCharacterLoss: number;
  retainedLossPercent: number;
  selectionScoreLoss: number;
  firstUse: boolean;
  adjacentRepeat: boolean;
  repeatDisposition: "none" | "unavoidable" | "quality-preferred";
  diversityAdjustment: number;
}

const MODE_POLICY = {
  off: { scoreLoss: 0, firstUseBonus: 0, adjacentPenalty: 0 },
  conservative: { scoreLoss: 3, firstUseBonus: 2, adjacentPenalty: 4 },
  balanced: { scoreLoss: 8, firstUseBonus: 8, adjacentPenalty: 10 },
  expressive: { scoreLoss: 15, firstUseBonus: 14, adjacentPenalty: 18 },
} as const;

interface AdmittedCandidate {
  candidate: DeckTemplateCandidateScore;
  candidateIndex: number;
  retainedCharacterLoss: number;
  retainedLossPercent: number;
  selectionScoreLoss: number;
}

interface SequenceState {
  decisions: DeckTemplateDecision[];
  usedSlugs: Set<string>;
  lastSlug: string | undefined;
  totalUtility: number;
  totalRetainedCharacters: number;
  totalSelectionScore: number;
  adjacentRepeatCount: number;
  catalogIndexSequence: number[];
}

function retainedCharacterLimit(bestRetainedCharacterCount: number, mode: TemplateDiversityMode): number {
  if (mode === "off" || mode === "conservative") return 0;
  if (mode === "balanced") {
    return Math.min(18, Math.max(6, Math.floor(bestRetainedCharacterCount * 0.03)));
  }
  return Math.min(40, Math.max(12, Math.floor(bestRetainedCharacterCount * 0.07)));
}

function admittedCandidates(
  candidates: readonly DeckTemplateCandidateScore[],
  mode: TemplateDiversityMode,
): AdmittedCandidate[] {
  const best = candidates[0];
  const policy = MODE_POLICY[mode];
  const retainedLimit = retainedCharacterLimit(best.retainedCharacterCount, mode);

  return candidates.flatMap((candidate, candidateIndex) => {
    const retainedCharacterLoss = Math.max(0, best.retainedCharacterCount - candidate.retainedCharacterCount);
    const retainedLossPercent = best.retainedCharacterCount > 0
      ? retainedCharacterLoss * 100 / best.retainedCharacterCount
      : 0;
    const selectionScoreLoss = best.selectionScore - candidate.selectionScore;
    const admitted = candidateIndex === 0 || (mode !== "off"
      && retainedCharacterLoss <= retainedLimit
      && selectionScoreLoss <= policy.scoreLoss);
    return admitted ? [{
      candidate,
      candidateIndex,
      retainedCharacterLoss,
      retainedLossPercent,
      selectionScoreLoss,
    }] : [];
  }).slice(0, MAX_DIVERSITY_CANDIDATES_PER_PAGE);
}

function compareCatalogIndexSequences(left: readonly number[], right: readonly number[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function compareStates(left: SequenceState, right: SequenceState): number {
  if (left.totalUtility !== right.totalUtility) return right.totalUtility - left.totalUtility;
  if (left.totalRetainedCharacters !== right.totalRetainedCharacters) {
    return right.totalRetainedCharacters - left.totalRetainedCharacters;
  }
  if (left.totalSelectionScore !== right.totalSelectionScore) {
    return right.totalSelectionScore - left.totalSelectionScore;
  }
  if (left.adjacentRepeatCount !== right.adjacentRepeatCount) {
    return left.adjacentRepeatCount - right.adjacentRepeatCount;
  }
  return compareCatalogIndexSequences(left.catalogIndexSequence, right.catalogIndexSequence);
}

function stateIdentity(state: SequenceState): string {
  return JSON.stringify([state.lastSlug, [...state.usedSlugs].sort()]);
}

export function selectDeckTemplateSequence(
  pages: readonly (readonly DeckTemplateCandidateScore[])[],
  mode: TemplateDiversityMode,
): DeckTemplateDecision[] {
  let states: SequenceState[] = [{
    decisions: [],
    usedSlugs: new Set(),
    lastSlug: undefined,
    totalUtility: 0,
    totalRetainedCharacters: 0,
    totalSelectionScore: 0,
    adjacentRepeatCount: 0,
    catalogIndexSequence: [],
  }];

  for (const candidates of pages) {
    if (candidates.length === 0) throw new Error("Every page must have at least one template candidate");
    const admitted = admittedCandidates(candidates, mode);
    const policy = MODE_POLICY[mode];
    const deduplicated = new Map<string, SequenceState>();

    for (const state of states) {
      for (const candidate of admitted) {
        const firstUse = !state.usedSlugs.has(candidate.candidate.templateSlug);
        const adjacentRepeat = state.lastSlug === candidate.candidate.templateSlug;
        const repeatDisposition = !adjacentRepeat
          ? "none"
          : admitted.some((alternative) => alternative.candidate.templateSlug !== state.lastSlug)
            ? "quality-preferred"
            : "unavoidable";
        const diversityAdjustment = (firstUse ? policy.firstUseBonus : 0)
          - (adjacentRepeat ? policy.adjacentPenalty : 0);
        const qualityLoss = candidate.retainedLossPercent * 2 + candidate.selectionScoreLoss;
        const decision: DeckTemplateDecision = {
          candidateIndex: candidate.candidateIndex,
          retainedCharacterLoss: candidate.retainedCharacterLoss,
          retainedLossPercent: candidate.retainedLossPercent,
          selectionScoreLoss: candidate.selectionScoreLoss,
          firstUse,
          adjacentRepeat,
          repeatDisposition,
          diversityAdjustment,
        };
        const next: SequenceState = {
          decisions: [...state.decisions, decision],
          usedSlugs: new Set([...state.usedSlugs, candidate.candidate.templateSlug]),
          lastSlug: candidate.candidate.templateSlug,
          totalUtility: state.totalUtility + diversityAdjustment - qualityLoss,
          totalRetainedCharacters: state.totalRetainedCharacters + candidate.candidate.retainedCharacterCount,
          totalSelectionScore: state.totalSelectionScore + candidate.candidate.selectionScore,
          adjacentRepeatCount: state.adjacentRepeatCount + Number(adjacentRepeat),
          catalogIndexSequence: [...state.catalogIndexSequence, candidate.candidate.catalogIndex],
        };
        const identity = stateIdentity(next);
        const existing = deduplicated.get(identity);
        if (!existing || compareStates(next, existing) < 0) deduplicated.set(identity, next);
      }
    }

    states = [...deduplicated.values()].sort(compareStates).slice(0, MAX_DIVERSITY_STATES);
  }

  return states[0].decisions;
}
