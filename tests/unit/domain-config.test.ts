import assert from "node:assert/strict";
import test from "node:test";

import { loadAppConfig, requireWorkflowConfig } from "../../src/config/env.js";
import { generateSlideInputSchema } from "../../src/domain/source-document.js";

test("generate_slide accepts exactly one source input", () => {
  const fromText = generateSlideInputSchema.safeParse({
    sourceText: "# 项目方案\n\n正文内容足够长，可用于生成页面。",
  });
  const fromSections = generateSlideInputSchema.safeParse({
    sections: [{ heading: "项目方案", body: "正文内容足够长。" }],
  });
  const both = generateSlideInputSchema.safeParse({
    sourceText: "# 项目方案\n\n正文内容足够长。",
    sections: [{ heading: "项目方案", body: "正文内容足够长。" }],
  });
  const unknown = generateSlideInputSchema.safeParse({
    sourceText: "# 项目方案\n\n正文内容足够长。",
    apiKey: "must-not-be-accepted",
  });

  assert.equal(fromText.success, true);
  assert.equal(fromSections.success, true);
  assert.equal(both.success, false);
  assert.equal(unknown.success, false);
});

test("workflow config keeps provider secrets server-side", () => {
  const config = loadAppConfig({
    PPT_LLM_BASE_URL: "https://model.example/v1",
    PPT_LLM_API_KEY: "llm-secret",
    PPT_LLM_MODEL: "text-model",
    PPT_IMAGE_BASE_URL: "https://model.example/v1",
    PPT_IMAGE_API_KEY: "image-secret",
    PPT_IMAGE_MODEL: "image-model",
    PPT_IMAGE_ALLOWED_HOSTS: "cdn.example",
    PPT_REVIEW_BASE_URL: "https://model.example/v1",
    PPT_REVIEW_API_KEY: "review-secret",
    PPT_REVIEW_MODEL: "vision-model",
    PPT_OUTPUT_ROOT: "/tmp/ppt-generator-runs",
  });

  assert.equal(requireWorkflowConfig(config).llm.model, "text-model");
  assert.equal(JSON.stringify(config).includes("llm-secret"), false);
  assert.equal(JSON.stringify(config).includes("image-secret"), false);
  assert.equal(JSON.stringify(config).includes("review-secret"), false);
});
