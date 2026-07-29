import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DEFAULT_LIMITS } from "../../src/config/limits.js";
import type { AppConfig, ImageProviderProfile, ProviderProfile } from "../../src/config/env.js";

interface MockOptions {
  imageMode?: "base64" | "url";
  failFirstChatWith?: number;
  reviewScore?: number;
}

export interface RecordedRequest {
  url: string;
  body: unknown;
}

function profile(baseUrl: string, model: string, secret: string): ProviderProfile {
  const result = { baseUrl, model } as ProviderProfile;
  Object.defineProperty(result, "secret", { value: secret, enumerable: false });
  return result;
}

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";

export async function startMockOpenAIServer(options: MockOptions = {}) {
  const requests: RecordedRequest[] = [];
  const apiKey = "mock-provider-secret";
  let chatCalls = 0;

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ url: request.url ?? "", body });

    if (request.url?.endsWith("/chat/completions")) {
      chatCalls += 1;
      if (chatCalls === 1 && options.failFirstChatWith) {
        response.writeHead(options.failFirstChatWith, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `secret=${apiKey}` } }));
        return;
      }
      const serialized = JSON.stringify(body);
      const isReview = serialized.includes("image_url");
      const schemaName = serialized.includes("test_payload") ? "test_payload" : "unknown";
      const score = options.reviewScore ?? 90;
      const content = isReview
        ? {
            dimensions: { fidelity: score, structure: score, readability: score, layout: score, asset: score, technical: score },
            issues: [],
          }
        : schemaName === "test_payload" ? { ok: true } : { ok: true };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      return;
    }

    if (request.url?.endsWith("/images/generations")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [options.imageMode === "url" ? { url: "https://cdn.example/mock.png" } : { b64_json: TINY_PNG }] }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const llm = profile(baseUrl, "mock-text", apiKey);
  const review = profile(baseUrl, "mock-review", apiKey);
  const image = Object.assign(profile(baseUrl, "mock-image", apiKey), { allowedHosts: ["cdn.example"] }) as ImageProviderProfile;
  const config: AppConfig = {
    llm,
    image,
    review,
    outputRoot: "/tmp/ppt-mock-runs",
    limits: { ...DEFAULT_LIMITS },
  };

  return {
    apiKey,
    requests,
    config,
    configFor(outputRoot: string): AppConfig {
      return { ...config, outputRoot };
    },
    close: async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
