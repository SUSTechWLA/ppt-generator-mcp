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
  bullets: string[];
  metrics: string[];
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
  transformations: Array<{ type: "merge" | "compress" | "project-decorative"; groupIds: string[]; detail: string }>;
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
        bullets: [],
        metrics: [],
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
      body: block.body,
      sourceFactIds: block.sourceFactIds,
      bullets: block.bullets,
      metrics: block.metrics.map((metric) => `${metric.label}：${metric.value}`),
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

function hasLosslessFactBinding(slot: SemanticSlot): boolean {
  const declared = slot.factBearingBinding;
  if (declared) return declared in slot.bindings;
  return ["body", "narrativeBody", "tableCell"].some((field) => field in slot.bindings);
}

const ROLE_LABELS: Record<SemanticRole, string> = {
  headline: "页面主题",
  conclusion: "核心结论",
  fact: "事实要点",
  metric: "量化指标",
  process: "实施流程",
  comparison: "对比分析",
  evidence: "事实依据",
  visual: "视觉说明",
};

function fieldValues(field: string, item: SemanticItem): string[] {
  if (field === "body" || field === "narrativeBody") return [[item.body, ...item.bullets].filter(Boolean).join("；")];
  if (field === "tableCell") return [item.title, [item.body, ...item.bullets].filter(Boolean).join("；"), item.metrics.join("；") || "—", ROLE_LABELS[item.role]];
  if (["label", "stepLabel", "stageLabel", "itemLabel", "nodeLabel"].includes(field)) return [ROLE_LABELS[item.role]];
  if (["sequence", "stepNumber", "stageNumber"].includes(field)) return [String(item.order + 1).padStart(2, "0")];
  if (field === "metric") return [item.metrics.join("；") || item.title];
  if (field === "bullet") return [item.bullets[0] ?? item.title];
  return [item.title];
}

function bindingValuesFit(item: SemanticItem, slot: SemanticSlot, profile: TemplateProfile): boolean {
  const factBearing = slot.factBearingBinding
    ?? (["body", "narrativeBody", "tableCell"].find((field) => field in slot.bindings) as SemanticSlot["factBearingBinding"] | undefined);
  return Object.entries(slot.bindings).every(([field, tag]) => {
    const limit = profile.maxCharsBySlot[tag];
    if (!limit) return false;
    const expansion = slot.bindingExpansion?.[field] ?? 1;
    const emittedFit = fieldValues(field, item).slice(0, expansion).every((value) => Array.from(value).length <= limit);
    const factFits = field === factBearing ? Array.from(item.body).length <= limit : true;
    return emittedFit && factFits;
  });
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
    const roleSlots = profile.supportedRoles.includes(item.role)
      ? slots.filter((slot) => slot.acceptedRoles.includes(item.role))
      : [];
    const roleCompatible = roleSlots.filter(hasLosslessFactBinding);
    if (roleSlots.length > 0 && roleCompatible.length === 0) {
      unmatched.push({
        groupId: item.id,
        role: item.role,
        sourceFactIds: item.sourceFactIds,
        reason: "可兼容槽位没有声明无损事实承载绑定",
      });
      continue;
    }
    const lengthCompatible = roleCompatible.filter((slot) => Array.from(item.body).length <= slot.maxCharsPerItem && bindingValuesFit(item, slot, profile));
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
    transformations: Object.entries(profile.auxiliaryBindings ?? {}).flatMap(([field]) => {
      const capacity = profile.auxiliaryCapacities?.[field]?.itemCapacity;
      if (!capacity || assignments.length <= capacity || field === "tableHeader") return [];
      return [{
        type: "project-decorative" as const,
        groupIds: assignments.slice(capacity).map((assignment) => assignment.groupId),
        detail: `Decorative binding ${field} projects ${capacity} items while facts remain in lossless bindings.`,
      }];
    }),
    unmatched,
    representedFactIds,
    unrepresentedFactIds,
  };
}
