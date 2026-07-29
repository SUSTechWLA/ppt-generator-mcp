import type { AppConfig, ProviderProfile } from "../config/env.js";
import { WorkflowError } from "../domain/workflow-error.js";
import type { GeneratedImage, ImageProvider, ProviderBundle, ReviewProvider, TextProvider } from "./contracts.js";

interface Runtime {
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  fetch: typeof globalThis.fetch;
}

const defaultRuntime: Runtime = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
  fetch: globalThis.fetch,
};

function endpoint(profile: ProviderProfile, path: string): string {
  return `${profile.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function sanitizeMessage(status: number): string {
  if (status === 401 || status === 403) return "Provider authentication failed";
  if (status === 429) return "Provider rate limit exceeded";
  if (status >= 500) return "Provider temporarily unavailable";
  return `Provider request failed with status ${status}`;
}

async function requestJson(
  profile: ProviderProfile,
  path: string,
  body: unknown,
  runtime: Runtime,
  timeoutMs: number,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await runtime.fetch(endpoint(profile, path), {
        method: "POST",
        headers: {
          authorization: `Bearer ${profile.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new WorkflowError({
          code: "MODEL_FAILED",
          stage: "provider_request",
          retryable,
          message: sanitizeMessage(response.status),
        });
        if (!retryable || attempt === 2) throw error;
        lastError = error;
      } else {
        try {
          return await response.json();
        } catch (cause) {
          throw new WorkflowError({
            code: "MODEL_FAILED",
            stage: "provider_response",
            retryable: false,
            message: "Provider returned invalid JSON",
            cause,
          });
        }
      }
    } catch (error) {
      if (error instanceof WorkflowError && !error.retryable) throw error;
      lastError = error;
      if (attempt === 2) {
        throw error instanceof WorkflowError
          ? error
          : new WorkflowError({
              code: "MODEL_FAILED",
              stage: "provider_request",
              retryable: true,
              message: "Provider request timed out or could not be completed",
              cause: error,
            });
      }
    }
    await runtime.sleep(250 * (2 ** attempt) + Math.floor(runtime.random() * 100));
  }
  throw lastError;
}

function extractMessageJson(response: unknown): unknown {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new WorkflowError({
      code: "MODEL_FAILED",
      stage: "provider_response",
      retryable: false,
      message: "Provider response did not contain JSON content",
    });
  }
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new WorkflowError({
      code: "MODEL_FAILED",
      stage: "provider_response",
      retryable: false,
      message: "Provider returned invalid JSON content",
      cause,
    });
  }
}

export function createOpenAICompatibleProviders(
  config: AppConfig,
  runtimeOverrides: Partial<Runtime> = {},
): ProviderBundle {
  if (!config.llm || !config.image || !config.review) {
    throw new WorkflowError({
      code: "CONFIG_MISSING",
      stage: "provider_setup",
      retryable: false,
      message: "Text, image, and review provider profiles are required",
    });
  }
  const runtime = { ...defaultRuntime, ...runtimeOverrides };
  const timeout = config.limits.requestTimeoutMs;

  return {
    text: {
      async generateJson(input) {
        const raw = await requestJson(config.llm!, "chat/completions", {
          model: config.llm!.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: JSON.stringify({ schemaName: input.schemaName, payload: input.payload }) },
          ],
        }, runtime, timeout);
        return extractMessageJson(raw);
      },
    },
    image: {
      async generate(input): Promise<GeneratedImage> {
        const raw = await requestJson(config.image!, "images/generations", {
          model: config.image!.model,
          prompt: input.prompt,
          size: input.size,
          n: 1,
          response_format: "b64_json",
        }, runtime, timeout) as { data?: Array<{ b64_json?: string; url?: string }> };
        const first = raw.data?.[0];
        if (first?.b64_json) return { kind: "base64", data: first.b64_json, mimeType: "image/png" };
        if (first?.url) return { kind: "url", url: first.url };
        throw new WorkflowError({
          code: "ASSET_FAILED",
          stage: "provider_response",
          retryable: false,
          message: "Image provider returned no image",
        });
      },
    },
    review: {
      async review(input) {
        const raw = await requestJson(config.review!, "chat/completions", {
          model: config.review!.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            {
              role: "user",
              content: [
                { type: "text", text: JSON.stringify(input.payload) },
                { type: "image_url", image_url: { url: input.screenshotDataUrl } },
              ],
            },
          ],
        }, runtime, timeout);
        return extractMessageJson(raw);
      },
    },
  };
}

function mergedRuntime(runtimeOverrides: Partial<Runtime>): Runtime {
  return { ...defaultRuntime, ...runtimeOverrides };
}

export function createOpenAICompatibleTextProvider(
  profile: ProviderProfile,
  timeoutMs = 60_000,
  runtimeOverrides: Partial<Runtime> = {},
): TextProvider {
  const runtime = mergedRuntime(runtimeOverrides);
  return {
    async generateJson(input) {
      const raw = await requestJson(profile, "chat/completions", {
        model: profile.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: JSON.stringify({ schemaName: input.schemaName, payload: input.payload }) },
        ],
      }, runtime, timeoutMs);
      return extractMessageJson(raw);
    },
  };
}

export function createOpenAICompatibleImageProvider(
  profile: ProviderProfile,
  timeoutMs = 60_000,
  runtimeOverrides: Partial<Runtime> = {},
): ImageProvider {
  const runtime = mergedRuntime(runtimeOverrides);
  return {
    async generate(input): Promise<GeneratedImage> {
      const raw = await requestJson(profile, "images/generations", {
        model: profile.model,
        prompt: input.prompt,
        size: input.size,
        n: 1,
        response_format: "b64_json",
      }, runtime, timeoutMs) as { data?: Array<{ b64_json?: string; url?: string }> };
      const first = raw.data?.[0];
      if (first?.b64_json) return { kind: "base64", data: first.b64_json, mimeType: "image/png" };
      if (first?.url) return { kind: "url", url: first.url };
      throw new WorkflowError({ code: "ASSET_FAILED", stage: "provider_response", retryable: false, message: "Image provider returned no image" });
    },
  };
}

export function createOpenAICompatibleReviewProvider(
  profile: ProviderProfile,
  timeoutMs = 60_000,
  runtimeOverrides: Partial<Runtime> = {},
): ReviewProvider {
  const runtime = mergedRuntime(runtimeOverrides);
  return {
    async review(input) {
      const raw = await requestJson(profile, "chat/completions", {
        model: profile.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: [{ type: "text", text: JSON.stringify(input.payload) }, { type: "image_url", image_url: { url: input.screenshotDataUrl } }] },
        ],
      }, runtime, timeoutMs);
      return extractMessageJson(raw);
    },
  };
}
