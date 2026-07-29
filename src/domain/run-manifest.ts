import type { GenerateSlideOutput, WorkflowStatus } from "./quality-report.js";
import type { GeneratedAsset, SlideSpec } from "./slide-spec.js";

export type WorkflowStage =
  | "normalize_input"
  | "build_slide_spec"
  | "select_template"
  | "generate_assets"
  | "compose_html"
  | "quality_loop"
  | "finalize";

export interface StageRecord {
  status: "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: { code?: string; message: string; retryable?: boolean };
}

export interface AttemptRecord {
  attempt: number;
  htmlPath: string;
  previewPath: string;
  qualityPath: string;
  score: number;
  hardGatePassed: boolean;
  safeToReturn: boolean;
  actions: unknown[];
}

export interface RunManifest {
  version: 1;
  runId: string;
  requestId?: string;
  requestFingerprint: string;
  sourceHash?: string;
  status: "running" | WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  template?: { slug: string; version: string; reason: string };
  stages: Partial<Record<WorkflowStage, StageRecord>>;
  slideSpec?: SlideSpec;
  assets: Array<Pick<GeneratedAsset, "id" | "promptHash" | "mimeType" | "filePath"> & { prompt?: string }>;
  attempts: AttemptRecord[];
  selectedAttempt?: number;
  finalResult?: GenerateSlideOutput;
  artifacts?: { htmlPath: string; previewPath: string; manifestPath: string; qualityPath?: string };
}

export type ArtifactName = "manifest.json" | "final.html" | "final.png" | "quality.json";
