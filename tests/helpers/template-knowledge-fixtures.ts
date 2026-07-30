export function validTemplateBlueprint(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    displayName: "Balanced evidence layout",
    slugSeed: "balanced-evidence-layout",
    canvas: { format: "a4-landscape", widthMm: 297, heightMm: 210 },
    grid: {
      columns: 12,
      gapMm: 4,
      regions: [
        { id: "title", role: "title", component: "title-band", columnStart: 1, columnSpan: 12, row: 1 },
        { id: "body-a", role: "body", component: "fact-card", columnStart: 1, columnSpan: 6, row: 2 },
        { id: "body-b", role: "evidence", component: "evidence-card", columnStart: 7, columnSpan: 6, row: 2 },
        { id: "conclusion", role: "conclusion", component: "conclusion-band", columnStart: 1, columnSpan: 12, row: 3 },
        { id: "page", role: "page-number", component: "page-number", columnStart: 11, columnSpan: 2, row: 4 },
      ],
    },
    typography: {
      fontFamily: "Arial, sans-serif",
      bodyPt: 10,
      titlePt: 24,
      lineHeight: 1.4,
    },
    palette: {
      background: "#ffffff",
      surface: "#f4f7f6",
      text: "#17241e",
      primary: "#176b45",
      secondary: "#d9eadf",
    },
    spacing: { outerMm: 12, gapMm: 4, cardPaddingMm: 5, borderRadiusMm: 2 },
    visualRatios: { text: 0.62, image: 0, whitespace: 0.24 },
    optionalImage: { enabled: false, maxAreaRatio: 0, screenshotAsBackground: false },
    capabilityTags: ["detail", "evidence", "formal"],
    ...overrides,
  };
}

export const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XG9uAAAAAElFTkSuQmCC";
