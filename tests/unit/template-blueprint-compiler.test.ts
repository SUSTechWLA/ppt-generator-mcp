import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { templateBlueprintSchema } from "../../src/domain/template-blueprint.js";
import { compileTemplateBlueprint } from "../../src/services/template-blueprint-compiler.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { validTemplateBlueprint } from "../helpers/template-knowledge-fixtures.js";

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
