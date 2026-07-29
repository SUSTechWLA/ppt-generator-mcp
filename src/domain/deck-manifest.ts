import type { GenerateSlideOutput } from "./quality-report.js";

export type DeckStatus = "needs_assets" | "running" | "partial" | "delivered" | "failed";

export interface DeckPageRecord {
  pageNumber: number;
  status: "running" | "delivered" | "best_effort" | "failed";
  runId?: string;
  result?: GenerateSlideOutput;
  error?: { code?: string; message: string; retryable?: boolean };
}

export interface DeckManifest {
  version: 1;
  deckRunId: string;
  deckPlanId: string;
  requestId?: string;
  requestFingerprint: string;
  status: DeckStatus;
  createdAt: string;
  updatedAt: string;
  assetHashes: Record<string, string>;
  missingAssetIds: string[];
  pages: DeckPageRecord[];
  consistency?: { passed: boolean; issues: string[] };
}
