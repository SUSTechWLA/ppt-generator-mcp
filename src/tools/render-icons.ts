import { JSDOM } from "jsdom";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Replace <icon name="xxx">description</icon> with actual <img> tags.
 */
export interface RenderIconsInput {
  html: string;
  iconBasePath: string; // absolute path to icons directory
  iconsRelativePath?: string; // relative path for src attribute, e.g. "./assets/icons/"
}

export interface RenderIconsOutput {
  html: string;
  iconCount: number;
  replaced: Array<{ name: string; src: string }>;
  missingIcons: string[];
}

export function renderIcons(input: RenderIconsInput): RenderIconsOutput {
  const dom = new JSDOM(input.html);
  const doc = dom.window.document;
  const iconElements = doc.querySelectorAll("icon");
  const replaced: Array<{ name: string; src: string }> = [];
  const missingIcons: string[] = [];

  const iconBase = input.iconBasePath;
  const iconRel = input.iconsRelativePath || "./assets/icons/";

  iconElements.forEach((el) => {
    const name = el.getAttribute("name") || "unknown";
    const description = el.textContent?.trim() || name;

    // Check if icon SVG file exists
    const svgPath = path.join(iconBase, `${name}.svg`);
    const src = `${iconRel}${name}.svg`;

    if (fs.existsSync(svgPath)) {
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      img.setAttribute("alt", description);
      el.replaceWith(img);
      replaced.push({ name, src });
    } else {
      missingIcons.push(name);
      // Keep the text as fallback
      const span = doc.createElement("span");
      span.textContent = description;
      el.replaceWith(span);
    }
  });

  return {
    html: dom.serialize(),
    iconCount: iconElements.length + replaced.length - missingIcons.length,
    replaced,
    missingIcons,
  };
}
