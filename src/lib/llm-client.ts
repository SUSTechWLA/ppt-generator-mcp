import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// ============================================================================
// Types
// ============================================================================

export type LLMProvider = "openai" | "anthropic";

export interface LLMConfig {
  provider: LLMProvider;
  model?: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ImageGenConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface PlaceholderFillRequest {
  html: string;
  content: {
    // Direct text replacements: tag -> text
    direct?: Record<string, string | string[]>;
    // Key points for LLM expansion: tag -> { index?, keyPoints, style }
    expand?: Record<
      string,
      Array<{
        index?: number;
        keyPoints: string[];
        style?: string;
      }>
    >;
  };
}

export interface ImageGenRequest {
  prompt: string;
  size?: "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
}

export interface ImageGenResult {
  prompt: string;
  revisedPrompt?: string;
  imageUrl?: string;
}

// ============================================================================
// LLM Client
// ============================================================================

const SYSTEM_PROMPT = `你是一个专业的技术文档撰写助手。你的任务是根据提供的内容要点，生成正式、专业、通顺的中文技术文档段落。

要求：
1. 语言风格：正式、专业、简洁，适合标书或技术方案文档
2. 字数控制：正文段落150-250字
3. 标题用词精炼，8-15字
4. 保持逻辑清晰、语句通顺
5. 直接输出结果文本，不要输出任何解释或前缀`;

/**
 * Get the default model for a provider.
 */
export function getDefaultModel(provider: LLMProvider): string {
  switch (provider) {
    case "openai":
      return "gpt-4o";
    case "anthropic":
      return "claude-sonnet-5-20251001";
  }
}

/**
 * Call LLM for text generation.
 */
export async function generateText(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const model = config.model || getDefaultModel(config.provider);

  switch (config.provider) {
    case "openai": {
      const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl || "https://api.openai.com/v1",
      });
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      });
      return response.choices[0]?.message?.content || "";
    }
    case "anthropic": {
      const client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl || undefined,
      });
      const response = await client.messages.create({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: 4096,
      });
      // Extract text from the first text block
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.type === "text" ? textBlock.text : "";
    }
  }
}

/**
 * Generate image via DALL-E API.
 */
export async function generateImage(
  config: ImageGenConfig,
  request: ImageGenRequest,
): Promise<ImageGenResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || "https://api.openai.com/v1",
  });

  const response = await client.images.generate({
    model: config.model || "dall-e-3",
    prompt: request.prompt,
    n: 1,
    size: request.size || "1024x1024",
    quality: request.quality || "standard",
  });

  return {
    prompt: request.prompt,
    revisedPrompt: response.data?.[0]?.revised_prompt || undefined,
    imageUrl: response.data?.[0]?.url || undefined,
  };
}

/**
 * Download an image from a URL to a local file.
 */
export async function downloadImage(
  url: string,
  filePath: string,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download image: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const fs = await import("node:fs");
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
