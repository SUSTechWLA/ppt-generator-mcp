import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { WorkflowError } from "../domain/workflow-error.js";

function unsafeErrorText(value: string): boolean {
  const normalized = value.normalize("NFKC");
  const compact = normalized.replace(/[\p{White_Space}\p{Cf}\p{Cc}]+/gu, "");
  const directUnsafe = /(?:https?|file|ftp):\/\/|data:[^,;]+(?:;base64)?,|(?:^|[\s("'=])\/(?:Users|private|home|var|tmp)\/|(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+|(?:\n|\r)\s*at\s+[^\n]+:\d+|\b(?:Bearer|Basic)\s+\S+|\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,})\b|\b(?:authorization|x-api-key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|database_url)\s*[:=]/iu;
  const compactUnsafe = /(?:https?|file|ftp):\/\/|data:[^,;]+(?:;base64)?,|(?:[A-Za-z]:[\\/]|\\\\)|(?:Bearer|Basic)[A-Za-z0-9._~+/=-]{8,}|(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,})|(?:authorization|x-api-key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|database_url)[:=]/iu;
  return directUnsafe.test(normalized)
    || compactUnsafe.test(compact)
    || /\b[A-Za-z0-9+/]{80,}={0,2}\b/u.test(normalized);
}

function safeWorkflowError(error: WorkflowError): boolean {
  return [error.message, error.recovery ?? "", error.stage, error.code].every((value) => !unsafeErrorText(value));
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
