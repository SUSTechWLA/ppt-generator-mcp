import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { loadTemplateProfiles, selectTemplate } from "../../src/services/template-selector.js";
import { makeSlideSpec, makeTemplateProfiles } from "../helpers/domain-fixtures.js";

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
