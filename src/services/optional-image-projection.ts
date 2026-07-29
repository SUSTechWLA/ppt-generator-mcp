import type { PageBlueprint } from "../domain/page-blueprint.js";
import type { SlideSpec } from "../domain/slide-spec.js";

export interface OptionalImageProjection {
  assets: Array<{ id: string; alt: string }>;
  captions: string[];
  figureRefs: string[];
}

export function projectOptionalImages(content: PageBlueprint | SlideSpec): OptionalImageProjection {
  if ("version" in content) {
    const groupById = new Map(content.groups.map((group) => [group.id, group]));
    return {
      assets: content.assets.map((asset) => ({ id: asset.id, alt: asset.alt })),
      captions: content.assets.map((asset) => asset.alt),
      figureRefs: content.assets.map((asset) => groupById.get(asset.groupId)?.title ?? asset.alt),
    };
  }

  const blockById = new Map(content.blocks.map((block) => [block.id, block]));
  const assets = content.assets.filter((asset) => asset.type === "image");
  return {
    assets: assets.map((asset) => ({ id: asset.id, alt: asset.alt })),
    captions: assets.map((asset) => asset.alt),
    figureRefs: assets.map((asset) => blockById.get(asset.blockId)?.title ?? asset.alt),
  };
}
