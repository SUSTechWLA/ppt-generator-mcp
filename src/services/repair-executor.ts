import type { SourceDocument } from "../domain/source-document.js";
import { slideSpecSchema, type GeneratedAsset, type SlideBlock, type SlideSpec } from "../domain/slide-spec.js";
import type { RepairAction } from "./repair-router.js";

export interface RepairState {
  spec: SlideSpec;
  assets: GeneratedAsset[];
  templateSlug: string;
  designTokens: { fontScale: number; spacingScale: number; contrastMode: "normal" | "high" };
  templateSwitched: boolean;
}

function shorten(block: SlideBlock): SlideBlock {
  const maximum = Math.max(48, Math.floor(block.body.length * 0.82));
  const clipped = block.body.length > maximum ? `${block.body.slice(0, maximum - 1).replace(/[，、；：\s]+$/, "")}。` : block.body;
  return { ...block, body: clipped, bullets: block.bullets.slice(0, 4) };
}

export async function executeRepairs(input: {
  state: RepairState;
  actions: RepairAction[];
  source: SourceDocument;
  rewriteBlock?: (block: SlideBlock, action: Extract<RepairAction, { type: "rewrite_block" }>) => Promise<SlideBlock>;
  regenerateAsset?: (assetId: string, state: RepairState) => Promise<GeneratedAsset>;
  switchTemplate?: (state: RepairState) => Promise<string>;
}): Promise<RepairState> {
  let state: RepairState = structuredClone(input.state);
  for (const action of input.actions) {
    if (action.type === "rewrite_block") {
      const index = state.spec.blocks.findIndex((block) => block.id === action.targetId);
      if (index < 0) continue;
      const original = state.spec.blocks[index];
      const rewritten = input.rewriteBlock ? await input.rewriteBlock(original, action) : shorten(original);
      if (rewritten.id !== original.id || rewritten.sourceFactIds.some((id) => !original.sourceFactIds.includes(id))) {
        throw new Error(`Repair attempted to change the fact identity of ${original.id}`);
      }
      state.spec.blocks[index] = rewritten;
    } else if (action.type === "restore_fact") {
      const block = state.spec.blocks.find((candidate) => candidate.id === action.targetId);
      const fact = input.source.facts.find((candidate) => candidate.id === action.factId);
      if (block && fact) {
        block.body = `${block.body.replace(/[。；\s]+$/, "")}；${fact.text}`.slice(0, 500);
        if (!block.sourceFactIds.includes(fact.id)) block.sourceFactIds.push(fact.id);
      }
    } else if (action.type === "regenerate_asset" && input.regenerateAsset) {
      const asset = await input.regenerateAsset(action.targetId, state);
      const index = state.assets.findIndex((candidate) => candidate.id === asset.id);
      if (index >= 0) state.assets[index] = asset;
    } else if (action.type === "switch_template" && !state.templateSwitched && input.switchTemplate) {
      state.templateSlug = await input.switchTemplate(state);
      state.templateSwitched = true;
    } else if (action.type === "switch_template" && !state.templateSwitched) {
      state.templateSwitched = true;
    } else if (action.type === "adjust_token") {
      if (action.token === "font-scale" && typeof action.value === "number") state.designTokens.fontScale = action.value;
      if (action.token === "spacing-scale" && typeof action.value === "number") state.designTokens.spacingScale = action.value;
      if (action.token === "contrast-mode" && action.value === "high") state.designTokens.contrastMode = "high";
    }
  }
  state.spec = slideSpecSchema.parse(state.spec);
  return state;
}
