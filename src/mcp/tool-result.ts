import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { asWorkflowError } from "../domain/workflow-error.js";

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
  const safe = asWorkflowError(error, stage);
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
