import { WorkflowError } from "../domain/workflow-error.js";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

function checkedUrl(raw: string, allowedHosts: string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Image URL must use HTTPS");
  if (url.username || url.password) throw new Error("Image URL credentials are not allowed");
  if (!allowedHosts.includes(url.hostname.toLowerCase())) throw new Error(`Image URL host is not allowed: ${url.hostname}`);
  return url;
}

export async function safeDownloadImage(input: {
  url: string;
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  let current = checkedUrl(input.url, input.allowedHosts.map((host) => host.toLowerCase()));
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(input.timeoutMs) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("Image redirect could not be resolved safely");
      current = checkedUrl(new URL(location, current).toString(), input.allowedHosts);
      continue;
    }
    if (!response.ok) throw new WorkflowError({ code: "ASSET_FAILED", stage: "download_asset", retryable: response.status >= 500, message: `Image download failed with status ${response.status}` });
    const rawMime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!rawMime || !ALLOWED_MIME.has(rawMime)) throw new Error(`Unsupported image MIME type: ${rawMime ?? "missing"}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > input.maxBytes) throw new Error("Image exceeds maximum byte size");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > input.maxBytes) throw new Error("Image exceeds maximum byte size");
    return { bytes, mimeType: rawMime as "image/png" | "image/jpeg" | "image/webp" };
  }
  throw new Error("Image download redirect limit exceeded");
}
