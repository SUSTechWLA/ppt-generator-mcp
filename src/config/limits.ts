export const DEFAULT_LIMITS = {
  maxConcurrency: 2,
  requestTimeoutMs: 60_000,
  maxInputChars: 120_000,
  maxImageBytes: 12 * 1024 * 1024,
  maxAssets: 6,
  maxAttempts: 3,
} as const;

export interface AppLimits {
  maxConcurrency: number;
  requestTimeoutMs: number;
  maxInputChars: number;
  maxImageBytes: number;
  maxAssets: number;
  maxAttempts: number;
}
