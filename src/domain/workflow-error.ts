export type WorkflowErrorCode =
  | "INPUT_INVALID"
  | "CONFIG_MISSING"
  | "TEMPLATE_FAILED"
  | "MODEL_FAILED"
  | "ASSET_FAILED"
  | "RENDER_FAILED"
  | "QUALITY_FAILED"
  | "INTERNAL_ERROR";

export interface WorkflowErrorInit {
  code: WorkflowErrorCode;
  stage: string;
  retryable: boolean;
  message: string;
  runId?: string;
  recovery?: string;
  cause?: unknown;
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly stage: string;
  readonly retryable: boolean;
  readonly runId?: string;
  readonly recovery?: string;

  constructor(init: WorkflowErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "WorkflowError";
    this.code = init.code;
    this.stage = init.stage;
    this.retryable = init.retryable;
    this.runId = init.runId;
    this.recovery = init.recovery;
  }

  toJSON(): Omit<WorkflowErrorInit, "cause"> {
    return {
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      message: this.message,
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.recovery ? { recovery: this.recovery } : {}),
    };
  }
}

export function asWorkflowError(error: unknown, stage: string): WorkflowError {
  if (error instanceof WorkflowError) return error;
  return new WorkflowError({
    code: "INTERNAL_ERROR",
    stage,
    retryable: false,
    message: error instanceof Error ? error.message : "Unknown workflow error",
    cause: error,
  });
}
