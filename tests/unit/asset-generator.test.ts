import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateAssets } from "../../src/services/asset-generator.js";
import { imageSpec } from "../helpers/domain-fixtures.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";

test("persists base64 image and reuses unchanged prompt", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "ppt-assets-"));
  let calls = 0;
  const provider = { generate: async () => { calls += 1; return { kind: "base64" as const, data: PNG, mimeType: "image/png" as const }; } };
  const first = await generateAssets({ specs: [imageSpec], provider, outputDir, allowedHosts: [], maxBytes: 1_000_000, existing: [] });
  const second = await generateAssets({ specs: [imageSpec], provider, outputDir, allowedHosts: [], maxBytes: 1_000_000, existing: first });
  assert.equal(calls, 1);
  assert.equal(second[0].reused, true);
  assert.deepEqual(await readFile(first[0].filePath), Buffer.from(PNG, "base64"));
});

test("rejects an image URL outside the configured allowlist", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "ppt-assets-host-"));
  const provider = { generate: async () => ({ kind: "url" as const, url: "https://untrusted.example/image.png" }) };
  await assert.rejects(
    () => generateAssets({ specs: [imageSpec], provider, outputDir, allowedHosts: ["cdn.example"], maxBytes: 1_000_000, existing: [] }),
    /host is not allowed/,
  );
});

test("accepts an Agent supplied data URL without an image provider", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "ppt-assets-agent-"));
  const [asset] = await generateAssets({
    specs: [imageSpec],
    outputDir,
    allowedHosts: [],
    maxBytes: 1_000_000,
    existing: [],
    externalAssets: [{ id: imageSpec.id, dataUrl: `data:image/png;base64,${PNG}` }],
  });
  assert.equal(asset.reused, false);
  assert.equal(asset.mimeType, "image/png");
});

test("requires an external asset when no provider is configured", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "ppt-assets-missing-"));
  await assert.rejects(
    () => generateAssets({ specs: [imageSpec], outputDir, allowedHosts: [], maxBytes: 1_000_000, existing: [] }),
    /external asset/i,
  );
});
