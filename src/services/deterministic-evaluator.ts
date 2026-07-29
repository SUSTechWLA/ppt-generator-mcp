import type { QualityIssue } from "../domain/quality-report.js";
import type { RenderResult } from "./page-renderer.js";

export interface DeterministicReport {
  safeToReturn: boolean;
  hardGatePassed: boolean;
  issues: QualityIssue[];
}

export function evaluateDeterministic(render: RenderResult): DeterministicReport {
  const issues: QualityIssue[] = [];
  let safeToReturn = true;
  let hardGatePassed = true;
  const issue = (value: Omit<QualityIssue, "id">, unsafe = false) => {
    issues.push({ id: `det-${issues.length + 1}`, ...value });
    if (value.severity === "error") hardGatePassed = false;
    if (unsafe) safeToReturn = false;
  };

  if (!render.signals.screenshotCreated) issue({ severity: "error", category: "technical", evidence: "浏览器未生成预览图", suggestedAction: "重新渲染页面" }, true);
  if (render.pageCount !== 1) issue({ severity: "error", category: "structure", evidence: `页面标记数量为 ${render.pageCount}，要求恰好一页`, suggestedAction: "仅保留一个 data-slide-page 页面" }, true);
  if (render.signals.hasScripts) issue({ severity: "error", category: "technical", evidence: "最终 HTML 包含可执行脚本", suggestedAction: "移除全部脚本" }, true);
  if (render.signals.networkRequests.length > 0) issue({ severity: "error", category: "technical", evidence: `页面尝试加载 ${render.signals.networkRequests.length} 个远程资源`, suggestedAction: "将资源内联为 data URL" }, true);
  if (render.signals.hasSecretLikeText) issue({ severity: "error", category: "technical", evidence: "页面疑似包含密钥或令牌", suggestedAction: "从交付件中移除敏感配置" }, true);
  if (render.signals.hasUnresolvedPlaceholders) issue({ severity: "error", category: "structure", evidence: "页面仍包含模板占位符", suggestedAction: "补齐内容和资产映射" });

  if (render.bodyScroll.width > render.viewport.width + 1 || render.bodyScroll.height > render.viewport.height + 1) {
    issue({ severity: "error", category: "layout", evidence: `页面滚动尺寸 ${render.bodyScroll.width}×${render.bodyScroll.height} 超过画布`, suggestedAction: "压缩内容或切换更高容量模板" });
  }

  for (const element of render.elements) {
    const { rect } = element;
    if (rect.x < -1 || rect.y < -1 || rect.x + rect.width > render.viewport.width + 1 || rect.y + rect.height > render.viewport.height + 1) {
      issue({ severity: "error", category: "layout", targetId: element.id, evidence: `${element.tag} 超出安全画布边界`, suggestedAction: "调整模板间距或缩短目标内容" });
    }
    if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
      issue({ severity: "error", category: "layout", targetId: element.id, evidence: `${element.tag} 存在文本滚动溢出`, suggestedAction: "定向改写该模块或切换模板" });
    }
    if (element.text && element.fontSize < 11.3) {
      issue({ severity: "error", category: "readability", targetId: element.id, evidence: `字号 ${element.fontSize.toFixed(1)}px 低于最小可读值`, suggestedAction: "提高字号并压缩文案" });
    }
    const minimumContrast = element.largeText ? 3 : 4.5;
    if (element.text && element.contrastMeasurable && element.contrastRatio < minimumContrast) {
      issue({ severity: "error", category: "readability", targetId: element.id, evidence: `文字对比度 ${element.contrastRatio.toFixed(2)}:1 低于 ${minimumContrast}:1`, suggestedAction: "启用高对比配色" });
    }
  }

  for (const [index, image] of render.images.entries()) {
    if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0 || image.opaqueRatio < 0.02) {
      issue({ severity: "error", category: "asset", targetId: `image-${index + 1}`, evidence: "图片未加载或有效像素不足", suggestedAction: "重新注入有效图片资产" }, true);
    } else if (image.luminanceVariance < 0.0005) {
      issue({ severity: "warning", category: "asset", targetId: `image-${index + 1}`, evidence: "图片视觉变化过低，可能是占位色块", suggestedAction: "检查或重新生成图片" });
    }
  }
  if (render.occupiedRatio < 0.05 || render.occupiedRatio > 0.95) {
    issue({ severity: "warning", category: "layout", evidence: `内容占用率 ${(render.occupiedRatio * 100).toFixed(1)}% 异常`, suggestedAction: "检查页面信息密度" });
  }

  return { safeToReturn, hardGatePassed: hardGatePassed && safeToReturn, issues };
}
