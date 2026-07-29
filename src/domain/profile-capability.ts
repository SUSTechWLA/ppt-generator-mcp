import type { SemanticSlot, TemplateProfile } from "./template-profile.js";

export interface EffectiveProfilePosition {
  slot: SemanticSlot;
  itemIndex: number;
  maxChars: number;
  catalogIndex: number;
}

export function orderedProfileSlots(profile: TemplateProfile): SemanticSlot[] {
  return profile.semanticSlots
    .map((slot, catalogIndex) => ({ slot, catalogIndex }))
    .sort((left, right) => left.slot.priority - right.slot.priority || left.catalogIndex - right.catalogIndex)
    .map(({ slot }) => slot);
}

export function effectiveProfilePositions(profile: TemplateProfile): EffectiveProfilePosition[] {
  const auxiliaryFactLimits = Object.entries(profile.auxiliaryBindings ?? {})
    .filter(([field]) => ["body", "narrativeBody", "tableCell"].includes(field))
    .map(([, tag]) => profile.maxCharsBySlot[tag])
    .filter((limit): limit is number => typeof limit === "number" && limit > 0);
  const slots = profile.semanticSlots
    .map((slot, catalogIndex) => ({ slot, catalogIndex }))
    .sort((left, right) => left.slot.priority - right.slot.priority || left.catalogIndex - right.catalogIndex);
  return slots.flatMap(({ slot, catalogIndex }) => {
    const factTag = slot.bindings[slot.factBearingBinding];
    const limits = [slot.maxCharsPerItem, factTag ? profile.maxCharsBySlot[factTag] : undefined, ...auxiliaryFactLimits]
      .filter((limit): limit is number => typeof limit === "number" && limit > 0);
    const maxChars = Math.min(...limits);
    return Array.from({ length: slot.itemCapacity }, (_, itemIndex) => ({ slot, itemIndex, maxChars, catalogIndex }));
  });
}
