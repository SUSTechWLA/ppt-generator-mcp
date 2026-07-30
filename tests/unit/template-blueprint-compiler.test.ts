import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { templateBlueprintSchema } from "../../src/domain/template-blueprint.js";
import { compileTemplateBlueprint } from "../../src/services/template-blueprint-compiler.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { validImageTemplateBlueprint, validMetricTemplateBlueprint, validTemplateBlueprint } from "../helpers/template-knowledge-fixtures.js";

test("valid blueprint compiles self-contained template accepted by the ordinary catalog loader", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "learned-template-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compiled = compileTemplateBlueprint(templateBlueprintSchema.parse(validTemplateBlueprint()));
  assert.match(compiled.html, /<!doctype html>/i);
  assert.match(compiled.html, /<page-title>/);
  assert.match(compiled.html, /data-semantic-slot="main-content"/);
  assert.doesNotMatch(compiled.html, /<script|https?:\/\/|url\s*\(|data:image|background-image/i);
  assert.equal(compiled.profile.slug, "balanced-evidence-layout");

  const family = join(root, "learned");
  await mkdir(family, { recursive: true });
  await writeFile(join(family, `${compiled.profile.slug}.html`), compiled.html);
  await writeFile(join(family, "template-profiles.json"), `${JSON.stringify([compiled.profile])}\n`);
  assert.deepEqual(loadTemplateProfiles(root).map((profile) => profile.slug), [compiled.profile.slug]);
});

test("blueprint schema rejects unsafe identities, duplicate slots, invalid ranges, low contrast, missing roles and screenshot backgrounds", () => {
  const cases = [
    validTemplateBlueprint({ slugSeed: "../../escape" }),
    validTemplateBlueprint({ grid: { ...(validTemplateBlueprint().grid as object), regions: [
      { id: "same", role: "title", component: "title-band", columnStart: 1, columnSpan: 12, row: 1 },
      { id: "same", role: "body", component: "fact-card", columnStart: 1, columnSpan: 12, row: 2 },
      { id: "page", role: "page-number", component: "page-number", columnStart: 11, columnSpan: 2, row: 4 },
    ] } }),
    validTemplateBlueprint({ spacing: { outerMm: 99, gapMm: 4, cardPaddingMm: 5, borderRadiusMm: 2 } }),
    validTemplateBlueprint({ palette: { background: "#ffffff", surface: "#ffffff", text: "#eeeeee", primary: "#fefefe", secondary: "#ffffff" } }),
    validTemplateBlueprint({ grid: { ...(validTemplateBlueprint().grid as object), regions: [{ id: "title", role: "title", component: "title-band", columnStart: 1, columnSpan: 12, row: 1 }] } }),
    validTemplateBlueprint({ optionalImage: { enabled: true, regionId: "body-a", maxAreaRatio: 0.4, screenshotAsBackground: true } }),
  ];
  for (const value of cases) assert.equal(templateBlueprintSchema.safeParse(value).success, false);
});

test("blueprint roles, components and capability tags must describe the same real capability", () => {
  const base = validTemplateBlueprint();
  const mutateRegion = (id: string, update: Record<string, unknown>) => ({
    ...base,
    grid: { ...(base.grid as object), regions: (base.grid as { regions: Array<Record<string, unknown>> }).regions.map((region) => region.id === id ? { ...region, ...update } : region) },
  });
  const cases = [
    mutateRegion("title", { component: "fact-card" }),
    mutateRegion("body-a", { component: "page-number" }),
    mutateRegion("page", { component: "process-card" }),
    mutateRegion("body-a", { component: "process-card" }),
    { ...base, capabilityTags: ["detail", "process", "formal"] },
    { ...base, capabilityTags: ["detail", "metric", "formal"] },
    validTemplateBlueprint({ capabilityTags: ["detail", "visual-support", "formal"] }),
    mutateRegion("body-a", { role: "process", component: "process-card" }),
    mutateRegion("body-a", { role: "metric", component: "metric-card" }),
  ];
  for (const value of cases) assert.equal(templateBlueprintSchema.safeParse(value).success, false, JSON.stringify(value));
});

test("compiler profile advertises only roles, blocks and intents backed by regions", () => {
  const text = compileTemplateBlueprint(templateBlueprintSchema.parse(validTemplateBlueprint())).profile;
  assert.deepEqual(text.supportedRoles.sort(), ["conclusion", "evidence", "fact", "headline"].sort());
  assert.deepEqual(text.supportedBlocks, ["text"]);
  assert.deepEqual(text.pageIntents.sort(), ["detail", "evidence"].sort());

  const image = compileTemplateBlueprint(templateBlueprintSchema.parse(validImageTemplateBlueprint())).profile;
  assert.deepEqual(image.supportedRoles.sort(), ["conclusion", "fact", "headline", "visual"].sort());
  assert.deepEqual(image.supportedBlocks.sort(), ["image", "text"].sort());
  assert.deepEqual(image.pageIntents.sort(), ["detail", "visual-support"].sort());

  const metric = compileTemplateBlueprint(templateBlueprintSchema.parse(validMetricTemplateBlueprint())).profile;
  assert.deepEqual(metric.supportedRoles.sort(), ["conclusion", "fact", "headline", "metric"].sort());
  assert.deepEqual(metric.supportedBlocks.sort(), ["metric", "text"].sort());
  assert.deepEqual(metric.pageIntents, ["detail"]);
});
