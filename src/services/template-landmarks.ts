import type { SemanticLandmark } from "../domain/template-profile.js";

/** Standard semantic landmark vocabulary shared by template audit and runtime QA. */
export const SEMANTIC_LANDMARK_SELECTORS: Record<SemanticLandmark, string> = {
  "page-header": "header, .page-header, .visual-header",
  "chapter-band": ".chapter-band, chapter-label",
  "subsection-title": ".subsection-title, subsection-title",
  "summary-band": ".summary-band, .visual-summary, [data-component=\"summary-band\"]",
  "page-footer": "footer, .page-footer, .visual-footer",
};

export const SEMANTIC_LANDMARKS = Object.keys(SEMANTIC_LANDMARK_SELECTORS) as SemanticLandmark[];
