import { pageBlueprintSchema, type PageBlueprint, type SemanticRole } from "../domain/page-blueprint.js";
import { slideSpecSchema, type SlideBlock, type SlideSpec } from "../domain/slide-spec.js";
import type { SemanticSlot, TemplateProfile } from "../domain/template-profile.js";

interface SemanticItem {
  id: string;
  order: number;
  role: SemanticRole;
  title: string;
  body: string;
  sourceFactIds: string[];
}

export interface SlotAssignment {
  groupId: string;
  slotId: string;
  itemIndex: number;
  role: SemanticRole;
  usedChars: number;
  maxChars: number;
  sourceFactIds: string[];
  transformation: "none";
}

export interface SlotCapacityUse {
  slotId: string;
  usedItems: number;
  itemCapacity: number;
  usedChars: number;
  characterCapacity: number;
}

export interface SlotDiagnostic {
  groupId: string;
  role: SemanticRole;
  sourceFactIds: string[];
  reason: string;
}

export interface TemplateSlotSolution {
  feasible: boolean;
  assignments: SlotAssignment[];
  capacityUse: SlotCapacityUse[];
  transformations: Array<{ type: "merge" | "compress"; groupIds: string[]; detail: string }>;
  unmatched: SlotDiagnostic[];
  representedFactIds: string[];
  unrepresentedFactIds: string[];
}

function roleForBlock(block: SlideBlock): SemanticRole {
  if (block.semanticRole) return block.semanticRole;
  if (block.type === "process") return "process";
  if (block.type === "metric") return "metric";
  if (block.type === "table") return "comparison";
  if (block.type === "image") return "visual";
  return "fact";
}

function semanticItems(content: PageBlueprint | SlideSpec): { items: SemanticItem[]; sourceFactIds: string[] } {
  if ("version" in content) {
    const blueprint = pageBlueprintSchema.parse(content);
    return {
      items: blueprint.groups.map((group) => ({
        id: group.id,
        order: group.order,
        role: group.role,
        title: group.title,
        body: group.body,
        sourceFactIds: group.sourceFactIds,
      })),
      sourceFactIds: blueprint.sourceFactIds,
    };
  }
  const spec = slideSpecSchema.parse(content);
  return {
    items: spec.blocks.map((block, index) => ({
      id: block.id,
      order: index,
      role: roleForBlock(block),
      title: block.title,
      body: [block.body, ...block.bullets].filter(Boolean).join("；"),
      sourceFactIds: block.sourceFactIds,
    })),
    sourceFactIds: spec.sourceFactIds,
  };
}

function orderedSlots(profile: TemplateProfile): SemanticSlot[] {
  return profile.semanticSlots
    .map((slot, catalogIndex) => ({ slot, catalogIndex }))
    .sort((left, right) => left.slot.priority - right.slot.priority || left.catalogIndex - right.catalogIndex)
    .map(({ slot }) => slot);
}

function reasonFor(item: SemanticItem, compatible: SemanticSlot[], lengthCompatible: SemanticSlot[], blockedByOrder: boolean): string {
  if (compatible.length === 0) return `没有接受语义角色 ${item.role} 的槽位`;
  if (lengthCompatible.length === 0) {
    return `内容超出语义槽位的单项字符上限`;
  }
  if (blockedByOrder) return "可兼容槽位位于已分配内容之前，无法保持源顺序";
  return "可兼容语义槽位的项目容量已满";
}

export function solveTemplateSlots(content: PageBlueprint | SlideSpec, profile: TemplateProfile): TemplateSlotSolution {
  const { items, sourceFactIds } = semanticItems(content);
  const slots = orderedSlots(profile);
  const used = new Map(slots.map((slot) => [slot.id, 0]));
  const positions = slots.flatMap((slot) => Array.from({ length: slot.itemCapacity }, (_, itemIndex) => ({ slot, itemIndex })));
  const usedPositions = new Set<number>();
  let lastPosition = -1;
  const assignments: SlotAssignment[] = [];
  const unmatched: SlotDiagnostic[] = [];

  for (const item of [...items].sort((left, right) => left.order - right.order)) {
    const roleCompatible = profile.supportedRoles.includes(item.role)
      ? slots.filter((slot) => slot.acceptedRoles.includes(item.role))
      : [];
    const lengthCompatible = roleCompatible.filter((slot) => Array.from(item.body).length <= slot.maxCharsPerItem);
    const compatibleIds = new Set(lengthCompatible.map((slot) => slot.id));
    const positionIndex = positions.findIndex(({ slot }, index) => index > lastPosition && compatibleIds.has(slot.id));
    const position = positionIndex >= 0 ? positions[positionIndex] : undefined;
    if (!position) {
      const blockedByOrder = positions.some(({ slot }, index) => index <= lastPosition && !usedPositions.has(index) && compatibleIds.has(slot.id));
      unmatched.push({
        groupId: item.id,
        role: item.role,
        sourceFactIds: item.sourceFactIds,
        reason: reasonFor(item, roleCompatible, lengthCompatible, blockedByOrder),
      });
      continue;
    }
    const { slot, itemIndex } = position;
    const usedChars = Array.from(item.body).length;
    assignments.push({
      groupId: item.id,
      slotId: slot.id,
      itemIndex,
      role: item.role,
      usedChars,
      maxChars: slot.maxCharsPerItem,
      sourceFactIds: item.sourceFactIds,
      transformation: "none",
    });
    used.set(slot.id, itemIndex + 1);
    usedPositions.add(positionIndex);
    lastPosition = positionIndex;
  }

  for (const slot of slots) {
    if (slot.required && (used.get(slot.id) ?? 0) === 0) {
      unmatched.push({ groupId: "", role: slot.acceptedRoles[0], sourceFactIds: [], reason: `必需语义槽位 ${slot.id} 未分配内容` });
    }
  }

  const representedFactIds = assignments.flatMap((assignment) => assignment.sourceFactIds);
  const represented = new Set(representedFactIds);
  const unrepresentedFactIds = sourceFactIds.filter((factId) => !represented.has(factId));
  return {
    feasible: unmatched.length === 0 && unrepresentedFactIds.length === 0,
    assignments,
    capacityUse: slots.map((slot) => {
      const slotAssignments = assignments.filter((assignment) => assignment.slotId === slot.id);
      return {
        slotId: slot.id,
        usedItems: slotAssignments.length,
        itemCapacity: slot.itemCapacity,
        usedChars: slotAssignments.reduce((total, assignment) => total + assignment.usedChars, 0),
        characterCapacity: slot.itemCapacity * slot.maxCharsPerItem,
      };
    }),
    transformations: [],
    unmatched,
    representedFactIds,
    unrepresentedFactIds,
  };
}
