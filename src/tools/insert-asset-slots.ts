/**
 * insert_asset_slots — Replaces <icon> and <figures> XML tags with
 * ID'd placeholder boxes ([img-001], [icon-001]) that mark where
 * generated assets will be inserted.
 *
 * Also produces an assetMap linking each ID to its full generation prompt.
 * Page 1 = layout with slots. Page 2 = prompts reference table.
 */
import { JSDOM } from "jsdom";

// ============================================================================
// Types
// ============================================================================

export interface AssetEntry {
  id: string;
  type: "image" | "icon";
  label: string;
  prompt: string;
}

export interface InsertAssetSlotsInput {
  html: string;
  iconPrompts: Array<{ position: string; description: string; prompt: string }>;
  imagePrompts: Array<{ sectionTitle: string; prompt: string }>;
}

export interface InsertAssetSlotsOutput {
  html: string;         // Page 1: layout with ID'd slots
  assetMap: AssetEntry[]; // For building Page 2
}

// ============================================================================
// Implementation
// ============================================================================

export function insertAssetSlots(input: InsertAssetSlotsInput): InsertAssetSlotsOutput {
  const dom = new JSDOM(input.html);
  const doc = dom.window.document;
  const assetMap: AssetEntry[] = [];

  // Replace <icon> tags → icon-slot placeholder boxes
  const icons = doc.querySelectorAll("icon");
  icons.forEach((el, i) => {
    const ip = input.iconPrompts[i % input.iconPrompts.length];
    const id = `icon-${String(i + 1).padStart(3, "0")}`;
    const label = ip?.position || "图标";
    const slot = doc.createElement("div");
    slot.setAttribute("class", "icon-slot");
    slot.innerHTML = `<span class="slot-id">[${id}]</span><span class="slot-label">${esc(label)}</span>`;
    el.replaceWith(slot);
    assetMap.push({ id, type: "icon", label, prompt: ip?.prompt || "" });
  });

  // Replace <figures> → img-slot placeholder boxes
  const figures = doc.querySelectorAll("figures");
  figures.forEach((el, i) => {
    const ip = input.imagePrompts[i];
    const id = `img-${String(i + 1).padStart(3, "0")}`;
    const label = ip?.sectionTitle || "配图";
    const slot = doc.createElement("div");
    slot.setAttribute("class", "img-slot");
    slot.innerHTML = `<span class="slot-id">[${id}]</span><span class="slot-size">1792×1024</span><span class="slot-label">${esc(label)}</span>`;
    el.replaceWith(slot);
    assetMap.push({ id, type: "image", label, prompt: ip?.prompt || "" });

    // Clean <figure-ref> inside parent
    const parent = el.parentElement;
    const ref = parent?.querySelector("figure-ref");
    if (ref) ref.replaceWith(doc.createTextNode(ref.textContent || ""));
  });

  // Add overflow image slots to body-grid as extra rows (one per remaining prompt)
  const bodyGrid = doc.querySelector(".body-grid");
  for (let i = figures.length; i < input.imagePrompts.length; i++) {
    const ip = input.imagePrompts[i];
    const id = `img-${String(i + 1).padStart(3, "0")}`;
    const label = ip?.sectionTitle || "配图";

    // Create a new row: image-card spanning full width
    const section = doc.createElement("section");
    section.setAttribute("class", "component img-slot span-12");
    section.innerHTML = `<span class="slot-id">[${id}]</span><span class="slot-size">1792×1024</span><span class="slot-label">${esc(label)}</span>`;

    if (bodyGrid) bodyGrid.appendChild(section);
    assetMap.push({ id, type: "image", label, prompt: ip?.prompt || "" });
  }

  return { html: dom.serialize(), assetMap };
}

// ============================================================================
// Build prompts reference page (Page 2)
// ============================================================================

export function buildPromptsPage(assetMap: AssetEntry[]): string {
  const images = assetMap.filter((a) => a.type === "image");
  const icons = assetMap.filter((a) => a.type === "icon");

  const imgRows = images.map((a) =>
    `<tr>
      <td style="padding:1.5mm 2mm;border:0.2mm solid #8FAE99;font-size:8pt;font-weight:700;color:#0B5A2A;">${esc(a.id)}</td>
      <td style="padding:1.5mm 2mm;border:0.2mm solid #8FAE99;font-size:8pt;">${esc(a.label)}</td>
      <td style="padding:1.5mm 2mm;border:0.2mm solid #8FAE99;font-size:7.5pt;line-height:1.4;color:#171A18;">${esc(a.prompt)}</td>
    </tr>`,
  ).join("");

  const iconRows = icons.map((a) =>
    `<tr>
      <td style="padding:1mm 2mm;border:0.2mm solid #8FAE99;font-size:7pt;font-weight:700;color:#0B5A2A;">${esc(a.id)}</td>
      <td style="padding:1mm 2mm;border:0.2mm solid #8FAE99;font-size:7pt;">${esc(a.label)}</td>
      <td style="padding:1mm 2mm;border:0.2mm solid #8FAE99;font-size:6.5pt;line-height:1.3;color:#6B746E;">${esc(a.prompt)}</td>
    </tr>`,
  ).join("");

  return `
    <div style="width:297mm;padding:4mm 6.5mm;background:#fff;page-break-before:always;font-family:Source Han Sans SC,Noto Sans CJK SC,sans-serif;">
      <h2 style="color:#0B5A2A;font-size:16pt;margin:0 0 1mm;">📋 图片与图标生成参考</h2>
      <p style="color:#6B746E;font-size:8pt;margin:0 0 3mm;">以下提示词可直接用于 DALL-E / Stable Diffusion 等文生图工具。生成后将图片命名为对应的 ID 并放入 assets 目录，即可自动替换交付件页面中的占位框。</p>
      ${images.length > 0 ? `
      <h3 style="color:#0B5A2A;font-size:12pt;margin:2mm 0 1mm;">🖼️ 配图提示词</h3>
      <table style="width:100%;border-collapse:collapse;border:0.3mm solid #8FAE99;">
        <thead><tr style="background:#0B5A2A;color:#fff;">
          <th style="padding:1.5mm 2mm;font-size:8pt;text-align:left;">ID</th>
          <th style="padding:1.5mm 2mm;font-size:8pt;text-align:left;width:25%;">所属卡片</th>
          <th style="padding:1.5mm 2mm;font-size:8pt;text-align:left;">生成提示词</th>
        </tr></thead>
        <tbody>${imgRows}</tbody>
      </table>` : ""}
      ${icons.length > 0 ? `
      <h3 style="color:#0B5A2A;font-size:12pt;margin:4mm 0 1mm;">🔷 图标提示词</h3>
      <table style="width:100%;border-collapse:collapse;border:0.3mm solid #8FAE99;">
        <thead><tr style="background:#0B5A2A;color:#fff;">
          <th style="padding:1mm 2mm;font-size:7pt;text-align:left;">ID</th>
          <th style="padding:1mm 2mm;font-size:7pt;text-align:left;width:20%;">概念</th>
          <th style="padding:1mm 2mm;font-size:7pt;text-align:left;">生成提示词</th>
        </tr></thead>
        <tbody>${iconRows}</tbody>
      </table>` : ""}
      <p style="color:#6B746E;font-size:7pt;margin:3mm 0 0;">生成后文件命名示例：img-001.png / icon-001.svg — 放置于 assets 目录，刷新页面即可显示。</p>
    </div>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
