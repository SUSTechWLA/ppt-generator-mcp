import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { loadTemplate } from "../../src/lib/template-parser.js";
import { composeSlide } from "../../src/services/slide-composer.js";
import { loadTemplateProfiles } from "../../src/services/template-selector.js";
import { makeGeneratedAssets, makeSlideSpec } from "../helpers/domain-fixtures.js";

const templatesDir = resolve("templates");
const templateSlug = "green-infographic-bid-a4-landscape-text-image";
const template = loadTemplate(templatesDir, templateSlug);
const profile = loadTemplateProfiles(templatesDir).find((item) => item.slug === templateSlug)!;
const spec = makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 });
const assets = makeGeneratedAssets(spec.assets);
const page = {
  number: 17,
  sectionTitle: "第二部分 履约响应",
  partNumber: "PART.02",
  partLabel: "履约方案",
  chapterLabel: "2.3 交付与审批机制",
  subsectionTitle: "2.3.1 稳定交付流程",
};

test("composes one self-contained page with no slots or remote assets", async () => {
  const result = await composeSlide({ spec, template, profile, assets });
  assert.match(result.html, /<html/i);
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /<figures|<icon|placeholder-image|img-slot|https?:\/\//i);
  assert.doesNotMatch(result.html, /<script/i);
  assert.equal((result.html.match(/data-slide-page=/g) ?? []).length, 1);
  assert.equal(result.warnings.length, 0);
});

test("escapes model-provided text instead of treating it as markup", async () => {
  const unsafe = makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 });
  unsafe.blocks[0].body = "<script>alert('x')</script> 项目要求";
  const result = await composeSlide({ spec: unsafe, template, profile, assets });
  assert.doesNotMatch(result.html, /<script>alert/);
  assert.match(result.html, /&lt;script&gt;/);
});

test("fails when a declared image has no generated asset", async () => {
  await assert.rejects(
    () => composeSlide({ spec, template, profile, assets: assets.slice(0, 3) }),
    /Missing generated asset: img-004/,
  );
});

test("caller page metadata survives initial and repair compositions", async () => {
  const initial = await composeSlide({ spec, template, profile, assets, page });
  const repaired = await composeSlide({
    spec,
    template,
    profile,
    assets,
    page,
    designTokens: { spacingScale: 0.94, fontScale: 1, contrastMode: "high" },
  });
  for (const result of [initial, repaired]) {
    assert.match(result.html, />17</);
    assert.match(result.html, /第二部分 履约响应/);
    assert.match(result.html, /2\.3 交付与审批机制/);
    assert.match(result.html, /2\.3\.1 稳定交付流程/);
    assert.match(result.html, /data-slide-page="17"/);
  }
});
