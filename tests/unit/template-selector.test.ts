import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { loadTemplateProfiles, selectTemplate } from "../../src/services/template-selector.js";
import type { TemplateProfile } from "../../src/domain/template-profile.js";
import { makeSlideSpec, makeTemplateProfiles } from "../helpers/domain-fixtures.js";

function capabilityProfile(overrides: Record<string, unknown> = {}): TemplateProfile {
  return {
    slug: "layout-alpha",
    version: "1.0.0",
    themeId: "neutral-paper",
    pageIntents: ["detail", "process", "comparison", "evidence", "visual-support"],
    supportedRoles: ["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence", "visual"],
    semanticSlots: [{
      id: "content",
      priority: 1,
      required: true,
      itemCapacity: 6,
      maxCharsPerItem: 240,
      acceptedRoles: ["headline", "conclusion", "fact", "metric", "process", "comparison", "evidence"],
      bindings: { title: "component-title", body: "paragraph" },
    }],
    blockCapacity: 6,
    supportedBlocks: ["text", "image", "table", "process", "metric"],
    imageSlots: 1,
    densityRange: ["low", "high"],
    maxCharsBySlot: { body: 240, summary: 120 },
    maxRasterAreaRatio: 0.18,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    documentCompatibility: { bid: true, proposal: true, presentation: true },
    format: "a4-landscape",
    status: "approved",
    ...overrides,
  } as unknown as TemplateProfile;
}

test("prefers a text-image template for four image-backed blocks", () => {
  const selection = selectTemplate(
    makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 }),
    makeTemplateProfiles(),
  );
  assert.equal(selection.slug, "green-infographic-bid-a4-landscape-text-image");
  assert.match(selection.reason, /图片槽位/);
});

test("rejects a forced template with insufficient capacity", () => {
  assert.throws(
    () => selectTemplate(
      makeSlideSpec({ blockTypes: ["table", "table", "table"], assetCount: 3 }),
      makeTemplateProfiles(),
      "green-infographic-bid-a4-landscape-table-text",
    ),
    /不兼容/,
  );
});

test("loads one approved profile for every repository template", () => {
  const profiles = loadTemplateProfiles(resolve("templates"));
  assert.equal(profiles.length, 6);
  assert.equal(new Set(profiles.map((profile) => profile.slug)).size, 6);
});

test("forced unknown templates fail with an actionable message", () => {
  assert.throws(
    () => selectTemplate(makeSlideSpec(), makeTemplateProfiles(), "missing-template"),
    /不存在/,
  );
});

test("renaming every slug does not change capability ranking", () => {
  const profiles = loadTemplateProfiles(resolve("templates"));
  const renamed = profiles.map((profile, index) => ({ ...profile, slug: `renamed-${index + 1}` }));
  const original = selectTemplate(makeSlideSpec({ assetCount: 1 }), profiles, undefined, "proposal");
  const changed = selectTemplate(makeSlideSpec({ assetCount: 1 }), renamed, undefined, "proposal");
  assert.deepEqual(original.candidates.map((candidate) => candidate.score), changed.candidates.map((candidate) => candidate.score));
});

test("bid raster policy depends on declared capability rather than slug wording", () => {
  const selection = selectTemplate(makeSlideSpec({ assetCount: 1 }), [
    capabilityProfile({ slug: "layout-alpha", maxRasterAreaRatio: 0.55 }),
    capabilityProfile({ slug: "visual-layout", maxRasterAreaRatio: 0.18 }),
  ], undefined, "bid");
  assert.equal(selection.slug, "visual-layout");
  assert.deepEqual(selection.candidates.map((candidate) => candidate.slug), ["visual-layout"]);
});

test("forced templates must satisfy the same document policy", () => {
  assert.throws(
    () => selectTemplate(
      makeSlideSpec({ assetCount: 1 }),
      [capabilityProfile({ slug: "arbitrary-layout", maxRasterAreaRatio: 0.55 })],
      "arbitrary-layout",
      "bid",
    ),
    /不满足.*文档策略/,
  );
});

test("bid policy requires minimum fact, evidence, metric, and process capabilities", () => {
  assert.throws(
    () => selectTemplate(makeSlideSpec({ assetCount: 1 }), [capabilityProfile({
      slug: "low-raster-but-no-evidence",
      supportedRoles: ["fact", "metric", "process", "visual"],
    })], undefined, "bid"),
    /没有.*文档策略兼容/,
  );
});
