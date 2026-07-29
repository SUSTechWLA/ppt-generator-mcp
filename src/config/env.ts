import * as path from "node:path";

import { DEFAULT_LIMITS, type AppLimits } from "./limits.js";
import { WorkflowError } from "../domain/workflow-error.js";

export interface ProviderProfile {
  baseUrl: string;
  model: string;
  readonly secret: string;
}

export interface ImageProviderProfile extends ProviderProfile {
  allowedHosts: string[];
}

export interface AppConfig {
  llm?: ProviderProfile;
  image?: ImageProviderProfile;
  review?: ProviderProfile;
  outputRoot: string;
  limits: AppLimits;
}

type Environment = Record<string, string | undefined>;

function positiveInteger(
  env: Environment,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new WorkflowError({
      code: "CONFIG_MISSING",
      stage: "config",
      retryable: false,
      message: `${name} must be an integer between 1 and ${maximum}`,
    });
  }
  return value;
}

function providerProfile(
  env: Environment,
  prefix: "PPT_LLM" | "PPT_IMAGE" | "PPT_REVIEW",
): ProviderProfile | undefined {
  const baseUrl = env[`${prefix}_BASE_URL`]?.trim();
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  const model = env[`${prefix}_MODEL`]?.trim();
  const supplied = [baseUrl, apiKey, model].filter(Boolean).length;
  if (supplied === 0) return undefined;
  if (supplied !== 3) {
    const missing = [
      [`${prefix}_BASE_URL`, baseUrl],
      [`${prefix}_API_KEY`, apiKey],
      [`${prefix}_MODEL`, model],
    ].filter(([, value]) => !value).map(([name]) => name);
    throw new WorkflowError({
      code: "CONFIG_MISSING",
      stage: "config",
      retryable: false,
      message: `Missing configuration: ${missing.join(", ")}`,
    });
  }

  const profile = { baseUrl: baseUrl!, model: model! } as ProviderProfile;
  Object.defineProperty(profile, "secret", {
    value: apiKey!,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return profile;
}

export function loadAppConfig(env: Environment = process.env): AppConfig {
  const llm = providerProfile(env, "PPT_LLM");
  const review = providerProfile(env, "PPT_REVIEW");
  const rawImage = providerProfile(env, "PPT_IMAGE");
  const image = rawImage
    ? Object.assign(rawImage, {
        allowedHosts: (env.PPT_IMAGE_ALLOWED_HOSTS || "")
          .split(",")
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
      }) as ImageProviderProfile
    : undefined;

  return {
    llm,
    image,
    review,
    outputRoot: path.resolve(env.PPT_OUTPUT_ROOT || path.join(process.cwd(), "output", "runs")),
    limits: {
      maxConcurrency: positiveInteger(env, "PPT_MAX_CONCURRENCY", DEFAULT_LIMITS.maxConcurrency, 16),
      requestTimeoutMs: positiveInteger(env, "PPT_REQUEST_TIMEOUT_MS", DEFAULT_LIMITS.requestTimeoutMs, 300_000),
      maxInputChars: positiveInteger(env, "PPT_MAX_INPUT_CHARS", DEFAULT_LIMITS.maxInputChars, 1_000_000),
      maxImageBytes: positiveInteger(env, "PPT_MAX_IMAGE_BYTES", DEFAULT_LIMITS.maxImageBytes, 100 * 1024 * 1024),
      maxAssets: DEFAULT_LIMITS.maxAssets,
      maxAttempts: DEFAULT_LIMITS.maxAttempts,
    },
  };
}

export interface RequiredWorkflowConfig extends AppConfig {
  llm: ProviderProfile;
  image: ImageProviderProfile;
  review: ProviderProfile;
}

export function requireWorkflowConfig(config: AppConfig): RequiredWorkflowConfig {
  const missing = [
    ["PPT_LLM_*", config.llm],
    ["PPT_IMAGE_*", config.image],
    ["PPT_REVIEW_*", config.review],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new WorkflowError({
      code: "CONFIG_MISSING",
      stage: "config",
      retryable: false,
      message: `Missing provider profiles: ${missing.join(", ")}`,
    });
  }
  return config as RequiredWorkflowConfig;
}
