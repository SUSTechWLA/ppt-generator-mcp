import { JSDOM } from "jsdom";
import {
  generateImage,
  downloadImage,
  type ImageGenConfig,
} from "../lib/llm-client.js";

// ============================================================================
// Types
// ============================================================================

export interface GenerateImageInput {
  html: string;
  imageConfig: ImageGenConfig;
  outputDir: string; // absolute path to save images
  outputUrlPrefix?: string; // prefix for src attribute, e.g. "./assets/images/"
}

export interface GenerateImageOutput {
  html: string;
  images: Array<{
    id: string;
    prompt: string;
    filePath: string;
    revisedPrompt?: string;
  }>;
}

// ============================================================================
// Implementation
// ============================================================================

export async function generateImages(
  input: GenerateImageInput,
): Promise<GenerateImageOutput> {
  const dom = new JSDOM(input.html);
  const doc = dom.window.document;
  const figuresElements = doc.querySelectorAll("figures");
  const images: GenerateImageOutput["images"] = [];

  const urlPrefix = input.outputUrlPrefix || "./assets/images/";
  const fs = await import("node:fs");
  const path = await import("node:path");

  // Ensure output directory exists
  if (!fs.existsSync(input.outputDir)) {
    fs.mkdirSync(input.outputDir, { recursive: true });
  }

  for (let i = 0; i < figuresElements.length; i++) {
    const el = figuresElements[i];
    const parent = el.parentElement;
    const prompt = el.textContent?.trim() || "";

    if (!prompt) continue;

    // Find associated image-caption
    const captionEl = parent?.querySelector("image-caption");
    const captionText = captionEl?.textContent?.trim() || "AI生成图片";

    const id = `img-${Date.now().toString(36)}-${i}`;

    try {
      // Call DALL-E
      const result = await generateImage(input.imageConfig, {
        prompt,
        size: "1792x1024", // landscape for A4
        quality: "hd",
      });

      let filePath = "";
      const filename = `${id}.png`;

      if (result.imageUrl) {
        filePath = path.join(input.outputDir, filename);
        await downloadImage(result.imageUrl, filePath);
      }

      images.push({
        id,
        prompt,
        filePath,
        revisedPrompt: result.revisedPrompt,
      });

      // Replace <figures> with <img>
      const imgEl = doc.createElement("img");
      imgEl.setAttribute("src", `${urlPrefix}${filename}`);
      imgEl.setAttribute("alt", captionText);
      el.replaceWith(imgEl);

      // Replace <image-caption> with plain text
      if (captionEl) {
        const span = doc.createElement("span");
        span.textContent = captionText;
        captionEl.replaceWith(span);
      }
    } catch (err) {
      console.error(`Image generation failed for "${id}":`, err);
      // Keep the prompt text as placeholder
      const placeholderImg = doc.createElement("div");
      placeholderImg.setAttribute("class", "placeholder-image");
      placeholderImg.textContent = `[图片: ${prompt.slice(0, 100)}...]`;
      el.replaceWith(placeholderImg);
    }
  }

  return {
    html: dom.serialize(),
    images,
  };
}

/**
 * Generate a single image from a prompt without needing HTML.
 */
export async function generateSingleImage(
  config: ImageGenConfig,
  prompt: string,
  outputDir: string,
  filename?: string,
): Promise<{ filePath: string; revisedPrompt?: string; url?: string }> {
  const result = await generateImage(config, {
    prompt,
    size: "1792x1024",
    quality: "hd",
  });

  const fs = await import("node:fs");
  const path = await import("node:path");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const name = filename || `img-${Date.now().toString(36)}.png`;
  const filePath = path.join(outputDir, name);

  if (result.imageUrl) {
    await downloadImage(result.imageUrl, filePath);
  }

  return {
    filePath,
    revisedPrompt: result.revisedPrompt,
    url: result.imageUrl,
  };
}
