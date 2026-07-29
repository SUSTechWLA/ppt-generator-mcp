import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { WorkflowError } from "../domain/workflow-error.js";
import { hasUnsafeDiagnosticValue } from "../services/quality-safety.js";

function safeWorkflowError(error: WorkflowError): boolean {
  return !hasUnsafeDiagnosticValue({
    message: error.message,
    recovery: error.recovery ?? "",
    stage: error.stage,
    code: error.code,
  });
}

export function toToolResult<T extends Record<string, unknown>>(value: T, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: value,
  };
}

export function toJsonToolResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function toToolError(error: unknown, stage = "mcp_tool"): CallToolResult {
  const safe = error instanceof WorkflowError && safeWorkflowError(error)
    ? error
    : new WorkflowError({
        code: "INTERNAL_ERROR",
        stage,
        retryable: false,
        message: "The MCP tool could not complete the request safely",
        recovery: "Retry with validated identifiers and inputs; inspect server logs if the failure persists.",
      });
  const payload = {
    code: safe.code,
    stage: safe.stage,
    retryable: safe.retryable,
    message: safe.message,
    ...(safe.runId ? { runId: safe.runId } : {}),
    ...(safe.recovery ? { recovery: safe.recovery } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export async function safeTool(handler: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return toToolError(error);
  }
}
