// Compatibility entrypoint. The production Demo calls the complete MCP workflow,
// injects the checked-in Agent imagegen asset, renders in Chromium, and persists QA.
export {};
await import("../scripts/generate-personnel-deliverable.js");
