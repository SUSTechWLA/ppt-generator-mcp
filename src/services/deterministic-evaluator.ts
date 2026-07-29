import type { DisplayPlan } from "../domain/display-plan.js";
import type { QualityIssue } from "../domain/quality-report.js";
import type { SlideSpec } from "../domain/slide-spec.js";
import type { TemplateProfile } from "../domain/template-profile.js";
import type { RenderResult } from "./page-renderer.js";
import { semanticBindingValues, type BindingField } from "./slide-content-mapper.js";
import type { DocumentTemplatePolicy } from "./template-selector.js";

export interface DeterministicReport {
  safeToReturn: boolean;
  hardGatePassed: boolean;
  issues: QualityIssue[];
}

export interface DeterministicEvaluationPolicy {
  maxRasterAreaRatio?: number;
  maximumRasterAssets?: number;
  minimumBodyFontPt?: number;
  profile?: TemplateProfile;
  documentPolicy?: DocumentTemplatePolicy;
  expectedPageNumber?: number;
  expectedMetadataBindings?: Array<{ field: string; values: string[] }>;
  displayPlan?: DisplayPlan;
  plannedSpec?: SlideSpec;
}

function strictMinimum(values: Array<number | undefined>, fallback: number): number {
  const available = values.filter((value): value is number => value !== undefined);
  return available.length > 0 ? Math.min(...available) : fallback;
}

function strictMaximum(values: Array<number | undefined>, fallback: number): number {
  const available = values.filter((value): value is number => value !== undefined);
  return available.length > 0 ? Math.max(...available) : fallback;
}

function normalizedVisibleText(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

function orderedEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function evaluateDeterministic(render: RenderResult, policy: DeterministicEvaluationPolicy = {}): DeterministicReport {
  const issues: QualityIssue[] = [];
  let safeToReturn = true;
  let hardGatePassed = true;
  const issue = (value: Omit<QualityIssue, "id">, unsafe = false) => {
    issues.push({ id: `det-${issues.length + 1}`, ...value });
    if (value.severity === "error") hardGatePassed = false;
    if (unsafe) safeToReturn = false;
  };

  if (!render.signals.screenshotCreated) issue({ severity: "error", category: "technical", evidence: "\u6d4f\u89c8\u5668\u672a\u751f\u6210\u9884\u89c8\u56fe", suggestedAction: "\u91cd\u65b0\u6e32\u67d3\u9875\u9762" }, true);
  if (render.pageCount !== 1) issue({ severity: "error", category: "structure", evidence: `\u9875\u9762\u6807\u8bb0\u6570\u91cf\u4e3a ${render.pageCount}\uff0c\u8981\u6c42\u6070\u597d\u4e00\u9875`, suggestedAction: "\u4ec5\u4fdd\u7559\u4e00\u4e2a data-slide-page \u9875\u9762" }, true);
  if (render.signals.hasScripts) issue({ severity: "error", category: "technical", evidence: "\u6700\u7ec8 HTML \u5305\u542b\u53ef\u6267\u884c\u811a\u672c", suggestedAction: "\u79fb\u9664\u5168\u90e8\u811a\u672c" }, true);
  if (render.signals.hasExecutableDom && !render.signals.hasScripts) issue({ severity: "error", category: "technical", evidence: "\u6700\u7ec8 HTML \u5305\u542b\u4e8b\u4ef6\u5904\u7406\u5668\u3001\u5d4c\u5165\u6587\u6863\u6216\u5176\u4ed6\u53ef\u6267\u884c DOM", suggestedAction: "\u79fb\u9664\u5168\u90e8\u53ef\u6267\u884c DOM \u5165\u53e3" }, true);
  if (render.signals.networkRequests.length > 0) issue({ severity: "error", category: "technical", evidence: `\u9875\u9762\u5c1d\u8bd5\u52a0\u8f7d ${render.signals.networkRequests.length} \u4e2a\u8fdc\u7a0b\u8d44\u6e90`, suggestedAction: "\u5c06\u8d44\u6e90\u5185\u8054\u4e3a data URL" }, true);
  if (render.signals.hasSecretLikeText) issue({ severity: "error", category: "technical", evidence: "\u9875\u9762\u7591\u4f3c\u5305\u542b\u5bc6\u94a5\u6216\u4ee4\u724c", suggestedAction: "\u4ece\u4ea4\u4ed8\u4ef6\u4e2d\u79fb\u9664\u654f\u611f\u914d\u7f6e" }, true);
  if (render.signals.hasUnresolvedPlaceholders) issue({ severity: "error", category: "structure", evidence: "\u9875\u9762\u4ecd\u5305\u542b\u6a21\u677f\u5360\u4f4d\u7b26", suggestedAction: "\u8865\u9f50\u5185\u5bb9\u548c\u8d44\u4ea7\u6620\u5c04" });

  if (policy.expectedPageNumber !== undefined && render.structure.pageNumber !== String(policy.expectedPageNumber)) {
    issue({ severity: "error", category: "structure", evidence: `\u6e32\u67d3\u9875\u7801 ${render.structure.pageNumber ?? "\u7f3a\u5931"} \u4e0e\u8ba1\u5212 ${policy.expectedPageNumber} \u4e0d\u4e00\u81f4`, suggestedAction: "\u4f7f\u7528\u663e\u5f0f\u9875\u8ba1\u5212\u7684\u9875\u7801" });
  }
  if (policy.profile) {
    const actual = render.structure.profile;
    if (!actual || actual.slug !== policy.profile.slug || actual.version !== policy.profile.version
      || actual.themeId !== policy.profile.themeId || actual.format !== policy.profile.format) {
      issue({ severity: "error", category: "structure", evidence: "\u6e32\u67d3 HTML \u7684\u6a21\u677f\u3001\u4e3b\u9898\u6216\u683c\u5f0f\u5143\u6570\u636e\u4e0e\u6240\u9009 profile \u4e0d\u4e00\u81f4", suggestedAction: "\u4ece\u6240\u9009 profile \u91cd\u65b0\u7ec4\u88c5\u9875\u9762" });
    }
    if (policy.documentPolicy && !policy.profile.documentCompatibility[policy.documentPolicy.documentType]) {
      issue({ severity: "error", category: "structure", evidence: `\u6240\u9009 profile \u4e0d\u652f\u6301 ${policy.documentPolicy.documentType} \u6587\u6863`, suggestedAction: "\u9009\u62e9\u6587\u6863\u7b56\u7565\u517c\u5bb9 profile" });
    }
  }
  const requiredLandmarks = [...new Set([...(policy.profile?.requiredLandmarks ?? []), ...(policy.documentPolicy?.requiredLandmarks ?? [])])];
  for (const landmark of requiredLandmarks) {
    const count = render.structure.landmarkCounts[landmark] ?? 0;
    if (count !== 1) issue({ severity: "error", category: "structure", evidence: `\u5fc5\u9700\u5730\u6807 ${landmark} \u7684\u53ef\u89c1\u6570\u91cf\u4e3a ${count}\uff0c\u8981\u6c42\u6070\u597d 1 \u4e2a`, suggestedAction: "\u6062\u590d profile \u58f0\u660e\u7684\u552f\u4e00\u8bed\u4e49\u5730\u6807" });
  }
  for (const component of render.structure.blankComponents) {
    issue({ severity: "error", category: "structure", targetId: component, evidence: `\u526a\u679d\u540e\u4ecd\u5b58\u5728\u7a7a\u767d\u53ef\u89c1\u7ec4\u4ef6 ${component}`, suggestedAction: "\u79fb\u9664\u7a7a\u767d\u7ec4\u4ef6\u6216\u5b8c\u6210\u5176\u5185\u5bb9\u6620\u5c04" });
  }
  for (const expected of policy.expectedMetadataBindings ?? []) {
    const actual = (render.structure.pageFields[expected.field] ?? []).map(normalizedVisibleText);
    const wanted = expected.values.map(normalizedVisibleText).filter(Boolean);
    if (!orderedEqual(actual, wanted)) issue({ severity: "error", category: "structure", targetId: expected.field, evidence: `\u53ef\u89c1\u9875\u5143\u6570\u636e ${expected.field} \u4e0e\u5f53\u9875\u6301\u4e45\u5316\u8ba1\u5212\u4e0d\u4e00\u81f4`, suggestedAction: "\u6309\u5f53\u9875 metadata binding \u91cd\u65b0\u586b\u5145" });
  }
  for (const generated of render.structure.protectedGeneratedText ?? []) {
    issue({ severity: "error", category: "fidelity", targetId: generated.owner, evidence: `${generated.zone} \u53d7\u4fdd\u62a4\u6587\u672c\u533a\u4f7f\u7528\u672a\u7eb3\u5165 DOM \u8bed\u4e49\u6d4b\u91cf\u7684\u4f2a\u5143\u7d20\u8bcd\u6cd5\u5185\u5bb9`, suggestedAction: "\u5c06\u5e94\u5c55\u793a\u7684\u8bcd\u6cd5\u5185\u5bb9\u4f5c\u4e3a\u53ef\u5f52\u56e0 DOM \u6587\u672c\u586b\u5145\uff1b\u4f2a\u5143\u7d20\u4ec5\u7528\u4e8e\u65e0\u6587\u5b57\u88c5\u9970" });
  }
  if (policy.displayPlan) {
    const expectedItems = policy.displayPlan.items;
    const actualItems = render.structure.semanticItems;
    if (actualItems.length !== expectedItems.length) issue({ severity: "error", category: "structure", evidence: `\u53ef\u89c1\u8bed\u4e49\u9879\u6570 ${actualItems.length} \u4e0e\u8ba1\u5212 ${expectedItems.length} \u4e0d\u4e00\u81f4`, suggestedAction: "\u6062\u590d\u6bcf\u4e2a\u5df2\u5206\u914d\u8bed\u4e49\u69fd\u4e14\u79fb\u9664\u91cd\u590d\u9879" });
    for (const [index, expected] of expectedItems.entries()) {
      const actual = actualItems[index];
      const budget = policy.displayPlan.targetBudget.positionBudgets.find((entry) => entry.displayItemId === expected.id);
      if (!actual || !actual.blockId || actual.slotId !== budget?.slotId || !orderedEqual(actual.sourceFactIds, expected.sourceFactIds)) {
        issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u7684\u69fd\u4f4d\u6216 source fact \u5f52\u5c5e\u4e0d\u662f\u8ba1\u5212\u7684\u552f\u4e00\u6709\u5e8f\u6620\u5c04`, suggestedAction: "\u4f7f\u7528\u8ba1\u5212\u4e2d\u7684 slot/item/fact \u6620\u5c04\u91cd\u65b0\u7ec4\u88c5" });
        continue;
      }
      if (actual.factTextOwnerCount !== 1 || actual.visibleFactTextOwnerCount !== 1) issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u5fc5\u987b\u6709\u4e14\u4ec5\u6709\u4e00\u4e2a\u53ef\u89c1 fact-bearing text owner`, suggestedAction: "\u79fb\u9664\u9690\u85cf\u6216\u91cd\u590d\u4e8b\u5b9e\u6587\u672c\u5bb9\u5668" });
      if (actual.titleTextOwnerCount !== 1 || actual.visibleTitleTextOwnerCount !== 1) issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u5fc5\u987b\u6709\u4e14\u4ec5\u6709\u4e00\u4e2a\u53ef\u89c1 title-bearing text owner`, suggestedAction: "\u6062\u590d profile \u58f0\u660e\u7684\u6807\u9898\u6587\u672c\u5bb9\u5668" });
      if (normalizedVisibleText(actual.titleText) !== normalizedVisibleText(expected.title)) issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u7684\u53ef\u89c1\u6807\u9898\u4e0d\u7b49\u4e8e grounded display title\uff0c\u53ef\u80fd\u542b\u672a\u5f52\u56e0\u6570\u5b57\u6216\u540d\u79f0`, suggestedAction: "\u4ec5\u6e32\u67d3 displayPlan \u7684\u8bed\u4e49\u6807\u9898" });
      if (normalizedVisibleText(actual.factText) !== normalizedVisibleText(expected.body)) issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u7684\u53ef\u89c1\u4e8b\u5b9e\u6587\u672c\u4e0d\u7b49\u4e8e grounded display text\uff0c\u53ef\u80fd\u7f3a\u5931\u5173\u952e\u9528\u70b9\u6216\u542b\u672a\u5f52\u56e0\u6570\u5b57/\u540d\u79f0`, suggestedAction: "\u4ec5\u6e32\u67d3 displayPlan \u7684\u62bd\u53d6\u5f0f\u6587\u672c" });
      const slot = policy.profile?.semanticSlots.find((candidate) => candidate.id === actual.slotId);
      const plannedBlock = policy.plannedSpec?.blocks.find((candidate) => candidate.id === expected.id);
      const expectedBindingKeys = Object.entries(slot?.bindingExpansion ?? {}).flatMap(([field, count]) => (
        Array.from({ length: count }, (_, valueIndex) => `${field}:${valueIndex}`)
      )).sort();
      const actualBindingKeys = actual.bindingTexts.map((binding) => `${binding.field}:${binding.valueIndex}`).sort();
      if (expectedBindingKeys.length > 0 && !orderedEqual(actualBindingKeys, expectedBindingKeys)) {
        issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u7684\u53ef\u89c1\u7ed1\u5b9a owner \u4e0d\u7b49\u4e8e profile \u58f0\u660e`, suggestedAction: "\u6309 profile binding expansion \u91cd\u65b0\u7ec4\u88c5\u8bed\u4e49\u9879" });
      }
      const expectedWholeParts: string[] = [];
      for (const binding of actual.bindingTexts) {
        let expectedValue: string | undefined;
        if (plannedBlock) {
          expectedValue = semanticBindingValues(binding.field as BindingField, plannedBlock, expected.role, budget?.itemIndex ?? index)[binding.valueIndex];
        } else if (["title", "shortTitle", "figureRef"].includes(binding.field) || (binding.field === "tableCell" && binding.valueIndex === 0)) {
          expectedValue = expected.title;
        } else if (["body", "narrativeBody"].includes(binding.field) || (binding.field === "tableCell" && binding.valueIndex === 1)) {
          expectedValue = expected.body;
        }
        if (!binding.visible || expectedValue === undefined || normalizedVisibleText(binding.text) !== normalizedVisibleText(expectedValue)) {
          issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u7684 ${binding.field}[${binding.valueIndex}] \u53ef\u89c1\u7ed1\u5b9a\u6587\u672c\u4e0e\u6301\u4e45\u5316\u8ba1\u5212\u4e0d\u4e00\u81f4`, suggestedAction: "\u4ec5\u4f7f\u7528\u786e\u5b9a\u6027\u8bed\u4e49\u7ed1\u5b9a\u503c" });
        }
        if (expectedValue !== undefined) expectedWholeParts.push(expectedValue);
      }
      if (expectedWholeParts.length > 0 && normalizedVisibleText(actual.visibleText) !== normalizedVisibleText(expectedWholeParts.join(""))) {
        issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u8bed\u4e49\u9879 ${expected.id} \u6574\u4e2a\u53ef\u89c1\u6587\u672c\u4e0d\u7b49\u4e8e profile-driven \u7ed1\u5b9a\u6295\u5f71`, suggestedAction: "\u79fb\u9664\u672a\u7ed1\u5b9a\u6216\u672a\u5f52\u56e0\u7684\u8bed\u4e49\u9879\u6587\u672c" });
      }
      for (const factId of expected.sourceFactIds) {
        const coverage = policy.displayPlan.factCoverages.find((candidate) => candidate.factId === factId);
        for (const anchor of coverage?.criticalAnchors ?? []) {
          if (!actual.factText.includes(anchor.text)) issue({ severity: "error", category: "fidelity", targetId: expected.id, evidence: `\u53ef\u89c1\u6587\u672c\u7f3a\u5c11 ${factId} \u7684\u5173\u952e ${anchor.kind} \u9528\u70b9`, suggestedAction: "\u6062\u590d displayPlan \u4fdd\u7559\u7684\u5173\u952e\u6e90\u6587\u5b50\u4e32" });
        }
      }
    }
    const actualFactOrder = actualItems.flatMap((item) => item.sourceFactIds);
    const expectedFactOrder = expectedItems.flatMap((item) => item.sourceFactIds);
    if (!orderedEqual(actualFactOrder, expectedFactOrder)) issue({ severity: "error", category: "fidelity", evidence: "\u53ef\u89c1\u8bed\u4e49\u9879\u672a\u5c06\u6240\u6709\u8ba1\u5212 fact ID \u6070\u597d\u4e00\u6b21\u4e14\u6309\u539f\u987a\u5e8f\u5c55\u793a", suggestedAction: "\u6309 displayPlan \u987a\u5e8f\u4fee\u590d fact \u6620\u5c04" });
    if (new Set(actualItems.map((item) => item.blockId)).size !== actualItems.length) issue({ severity: "error", category: "structure", evidence: "\u53ef\u89c1\u8bed\u4e49\u9879\u7684 DOM block owner \u6807\u8bc6\u5fc5\u987b\u552f\u4e00", suggestedAction: "\u4e3a\u6bcf\u4e2a\u5206\u914d\u9879\u4fdd\u7559\u552f\u4e00 block owner" });
    for (const slot of policy.profile?.semanticSlots.filter((candidate) => candidate.required) ?? []) {
      if (!actualItems.some((item) => item.slotId === slot.id)) issue({ severity: "error", category: "structure", targetId: slot.id, evidence: `\u5fc5\u9700\u8bed\u4e49\u69fd ${slot.id} \u5728\u526a\u679d\u540e\u7f3a\u5931`, suggestedAction: "\u4e3a\u5fc5\u9700\u69fd\u4fdd\u7559\u81f3\u5c11\u4e00\u4e2a\u5df2\u5206\u914d\u9879" });
    }
  }

  if (render.bodyScroll.width > render.viewport.width + 1 || render.bodyScroll.height > render.viewport.height + 1) issue({ severity: "error", category: "layout", evidence: `\u9875\u9762\u6eda\u52a8\u5c3a\u5bf8 ${render.bodyScroll.width}\u00d7${render.bodyScroll.height} \u8d85\u8fc7\u753b\u5e03`, suggestedAction: "\u538b\u7f29\u5185\u5bb9\u6216\u5207\u6362\u66f4\u9ad8\u5bb9\u91cf\u6a21\u677f" });
  for (const violation of render.layout.containmentViolations) issue({ severity: "error", category: "layout", targetId: violation.targetId, evidence: `\u53ef\u89c1\u5185\u5bb9\u8d85\u51fa\u6216\u88ab\u7956\u5148\u5bb9\u5668 ${violation.ancestorId} \u88c1\u5207`, suggestedAction: "\u8c03\u6574\u5bb9\u5668\u5bb9\u91cf\u3001\u5b57\u53f7\u6216\u95f4\u8ddd" });
  for (const collision of render.layout.collisions) issue({ severity: "error", category: "layout", targetId: collision.firstId, evidence: `\u53ef\u89c1\u5185\u5bb9\u4e0e ${collision.secondId} \u53d1\u751f\u91cd\u53e0\u78b0\u649e`, suggestedAction: "\u8c03\u6574\u5e03\u5c40\u8f68\u9053\u6216\u7f29\u77ed\u76ee\u6807\u5185\u5bb9" });

  const minimumBodyFontPt = strictMaximum([policy.minimumBodyFontPt, policy.profile?.minimumBodyFontPt, policy.documentPolicy?.minimumBodyFontPt], 8.5);
  const minimumBodyFontPx = minimumBodyFontPt * (96 / 72);
  const maxRasterAreaRatio = strictMinimum([policy.maxRasterAreaRatio, policy.profile?.maxRasterAreaRatio, policy.documentPolicy?.maxRasterAreaRatio], 1);
  if (render.rasterAreaRatio > maxRasterAreaRatio + 0.001) issue({ severity: "error", category: "asset", evidence: `\u4f4d\u56fe\u9762\u79ef\u5360\u6bd4 ${(render.rasterAreaRatio * 100).toFixed(1)}% \u8d85\u8fc7\u4e0a\u9650 ${(maxRasterAreaRatio * 100).toFixed(1)}%`, suggestedAction: "\u7f29\u5c0f\u4f4d\u56fe\u5bb9\u5668\u6216\u5207\u6362\u4f4e\u4f4d\u56fe\u5360\u6bd4\u6a21\u677f" });
  const maximumRasterAssets = strictMinimum([policy.maximumRasterAssets, policy.profile?.imageSlots.maxAssets, policy.documentPolicy?.maxImageAssets], Number.MAX_SAFE_INTEGER);
  if (render.raster.visibleCount > maximumRasterAssets) issue({ severity: "error", category: "asset", evidence: `\u53ef\u89c1\u4f4d\u56fe\u8d44\u4ea7\u6570\u91cf ${render.raster.visibleCount} \u8d85\u8fc7\u4e0a\u9650 ${maximumRasterAssets}`, suggestedAction: "\u51cf\u5c11\u4f4d\u56fe\u8d44\u4ea7\u6216\u5207\u6362\u517c\u5bb9\u6a21\u677f" });

  for (const element of render.elements) {
    const { rect } = element;
    if (rect.x < -1 || rect.y < -1 || rect.x + rect.width > render.viewport.width + 1 || rect.y + rect.height > render.viewport.height + 1) issue({ severity: "error", category: "layout", targetId: element.id, evidence: `${element.tag} \u8d85\u51fa\u5b89\u5168\u753b\u5e03\u8fb9\u754c`, suggestedAction: "\u8c03\u6574\u6a21\u677f\u95f4\u8ddd\u6216\u7f29\u77ed\u76ee\u6807\u5185\u5bb9" });
    const clippedHorizontally = element.overflowX !== "visible" && element.scrollWidth > element.clientWidth + 1;
    const clippedVertically = element.overflowY !== "visible" && element.scrollHeight > element.clientHeight + 1;
    if (clippedHorizontally || clippedVertically) issue({ severity: "error", category: "layout", targetId: element.id, evidence: `${element.tag} \u5b58\u5728\u6587\u672c\u6eda\u52a8\u6ea2\u51fa`, suggestedAction: "\u5b9a\u5411\u6539\u5199\u8be5\u6a21\u5757\u6216\u5207\u6362\u6a21\u677f" });
    if (element.text && element.bodyText && element.fontSize + 0.001 < minimumBodyFontPx) issue({ severity: "error", category: "readability", targetId: element.id, evidence: `\u5b57\u53f7 ${element.fontSize.toFixed(2)}px \u4f4e\u4e8e ${minimumBodyFontPt}pt \u6700\u5c0f\u53ef\u8bfb\u503c`, suggestedAction: "\u63d0\u9ad8\u5b57\u53f7\u5e76\u538b\u7f29\u6587\u6848" });
    const minimumContrast = element.largeText ? 3 : 4.5;
    if (element.text && element.contrastMeasurable && element.contrastRatio < minimumContrast) issue({ severity: "error", category: "readability", targetId: element.id, evidence: `\u6587\u5b57\u5bf9\u6bd4\u5ea6 ${element.contrastRatio.toFixed(2)}:1 \u4f4e\u4e8e ${minimumContrast}:1`, suggestedAction: "\u542f\u7528\u9ad8\u5bf9\u6bd4\u914d\u8272" });
  }

  for (const [index, image] of render.images.entries()) {
    if (!/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/i.test(image.src)) issue({ severity: "error", category: "asset", targetId: `image-${index + 1}`, evidence: "\u56fe\u7247\u4e0d\u662f\u5141\u8bb8\u7684\u5185\u8054\u672c\u5730\u4f4d\u56fe\u6216\u77e2\u91cf\u8d44\u4ea7", suggestedAction: "\u5c06\u5df2\u9a8c\u8bc1\u56fe\u7247\u5185\u8054\u4e3a data URL" }, true);
    else if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0 || image.opaqueRatio < 0.02) issue({ severity: "error", category: "asset", targetId: `image-${index + 1}`, evidence: "\u56fe\u7247\u672a\u52a0\u8f7d\u6216\u6709\u6548\u50cf\u7d20\u4e0d\u8db3", suggestedAction: "\u91cd\u65b0\u6ce8\u5165\u6709\u6548\u56fe\u7247\u8d44\u4ea7" }, true);
    else if (!image.isVector && image.luminanceVariance < 0.0005) issue({ severity: "warning", category: "asset", targetId: `image-${index + 1}`, evidence: "\u56fe\u7247\u89c6\u89c9\u53d8\u5316\u8fc7\u4f4e\uff0c\u53ef\u80fd\u662f\u5360\u4f4d\u8272\u5757", suggestedAction: "\u68c0\u67e5\u6216\u91cd\u65b0\u751f\u6210\u56fe\u7247" });
  }
  if (render.occupiedRatio < 0.05 || render.occupiedRatio > 0.95) issue({ severity: "warning", category: "layout", evidence: `\u5185\u5bb9\u5360\u7528\u7387 ${(render.occupiedRatio * 100).toFixed(1)}% \u5f02\u5e38`, suggestedAction: "\u68c0\u67e5\u9875\u9762\u4fe1\u606f\u5bc6\u5ea6" });

  return { safeToReturn, hardGatePassed: hardGatePassed && safeToReturn, issues };
}
