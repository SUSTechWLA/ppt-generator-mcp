import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import { listTemplates, loadTemplate } from "../../src/lib/template-parser.js";
import { auditTemplateFamilies, loadTemplateProfiles, selectTemplate } from "../../src/services/template-selector.js";
import { templateProfileSchema, type TemplateProfile } from "../../src/domain/template-profile.js";
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
    imageSlots: { placeholderTag: "figures", placeholderCount: 1, minAssets: 0, maxAssets: 1, unusedPolicy: "remove-container", containerSelector: "figure" },
    densityRange: ["low", "high"],
    maxCharsBySlot: { "component-title": 60, paragraph: 240, "page-title": 100, "summary-text": 160 },
    maxRasterAreaRatio: 0.18,
    minimumBodyFontPt: 8.5,
    requiredLandmarks: ["page-header", "chapter-band", "subsection-title", "summary-band", "page-footer"],
    documentCompatibility: { bid: true, proposal: true, presentation: true },
    format: "a4-landscape",
    status: "approved",
    ...overrides,
  } as unknown as TemplateProfile;
}

function withImageSlots(profile: TemplateProfile, minimum: number, count: number): TemplateProfile {
  return {
    ...profile,
    imageSlots: {
      placeholderTag: "figures",
      placeholderCount: count,
      minAssets: minimum,
      maxAssets: count,
      unusedPolicy: "remove-container",
      containerSelector: "figure",
    },
  } as unknown as TemplateProfile;
}

test("prefers a text-image template for four image-backed blocks", () => {
  const spec = makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 });
  spec.designIntent.visualRatio = 0.45;
  const selection = selectTemplate(
    spec,
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
  const templates = listTemplates(resolve("templates"));
  assert.equal(profiles.length, 6);
  assert.equal(profiles.length, templates.length);
  assert.ok(profiles.every((profile) => profile.designContract?.version === 1));
  assert.equal(new Set(profiles.map((profile) => profile.slug)).size, 6);
  assert.deepEqual(
    profiles.map((profile) => profile.slug).sort(),
    templates.map((template) => template.slug).sort(),
  );
  const promptProfiles = profiles.filter((profile) => profile.assetPromptBindings?.figureRef);
  assert.equal(promptProfiles.length, 3);
  assert.ok(promptProfiles.every((profile) => profile.assetPromptBindings!.figureRef !== profile.imageSlots.placeholderTag));
});

test("green visual baseline preserves canonical placeholder cardinality", () => {
  const template = loadTemplate(resolve("templates"), "green-infographic-bid-a4-landscape-visual");
  const counts = Object.fromEntries(template.placeholders.map((placeholder) => [placeholder.tag, placeholder.count]));
  assert.deepEqual(
    {
      componentTitle: counts["component-title"],
      paragraph: counts.paragraph,
      stepLabel: counts["step-label"],
      itemLabel: counts["item-label"],
      bullet: counts.bullet,
      figures: counts.figures,
    },
    { componentTitle: 3, paragraph: 3, stepLabel: 4, itemLabel: 4, bullet: undefined, figures: 1 },
  );
});

test("selects the optional-image base profile for a no-image page at the declared page-title boundary", () => {
  const profiles = loadTemplateProfiles(resolve("templates"));
  const base = profiles.find((candidate) => candidate.slug === "green-infographic-bid-a4-landscape")!;
  const spec = makeSlideSpec({ assetCount: 0 });
  spec.title = "页".repeat(base.maxCharsBySlot[base.pageBindings.pageTitle]);
  const selection = selectTemplate(spec, profiles, base.slug, "bid", base.themeId);
  assert.equal(selection.slug, base.slug);
});

test("optional-image selection rejects page-title cap plus one but accepts active image bindings at their caps", () => {
  const profiles = loadTemplateProfiles(resolve("templates"));
  const base = profiles.find((candidate) => candidate.slug === "green-infographic-bid-a4-landscape")!;
  const tooLong = makeSlideSpec({ assetCount: 0 });
  tooLong.title = "页".repeat(base.maxCharsBySlot[base.pageBindings.pageTitle] + 1);
  assert.throws(() => selectTemplate(tooLong, profiles, base.slug, "bid", base.themeId));

  const withImage = makeSlideSpec({ assetCount: 1 });
  withImage.designIntent.visualRatio = base.maxRasterAreaRatio;
  withImage.title = "页".repeat(base.maxCharsBySlot[base.pageBindings.pageTitle]);
  withImage.blocks[0].title = "图".repeat(base.maxCharsBySlot[base.assetPromptBindings!.figureRef!]);
  withImage.assets[0].alt = "场".repeat(base.maxCharsBySlot[base.pageBindings.imageCaption!]);
  assert.equal(selectTemplate(withImage, profiles, base.slug, "bid", base.themeId).slug, base.slug);
});

test("every repeated auxiliary binding is fully covered by declarative pruning groups", () => {
  const profiles = loadTemplateProfiles(resolve("templates"));
  for (const profile of profiles) {
    for (const [field, capacity] of Object.entries(profile.auxiliaryCapacities ?? {})) {
      if (capacity.itemCapacity <= 1) continue;
      const covered = ((profile.auxiliaryGroups ?? []) as Array<{ bindingFields: string[]; itemCapacity?: number }>)
        .filter((group) => group.bindingFields.includes(field))
        .reduce((total, group) => total + (group.itemCapacity ?? 0), 0);
      assert.equal(covered, capacity.itemCapacity, `${profile.slug}.${field} must be covered exactly once across its visible repeated groups`);
    }
  }
});

test("family audit hard-excludes bid profiles above raster or image limits", () => {
  const profiles = loadTemplateProfiles(resolve("templates"));
  const bid = auditTemplateFamilies(profiles, "bid");
  const presentation = auditTemplateFamilies(profiles, "presentation");
  const bidRecords = bid.families.flatMap((family) => family.profiles);
  const presentationRecords = presentation.families.flatMap((family) => family.profiles);

  assert.ok(bidRecords.some((record) => !record.approved && record.rejectionReasons.some((reason) => /位图|图片/.test(reason))));
  assert.ok(bidRecords.filter((record) => record.approved).every((record) => record.capacity.maxRasterAreaRatio <= 0.18));
  assert.ok(bidRecords.filter((record) => record.approved).every((record) => record.capacity.maxAssets <= 1));
  assert.ok(presentationRecords.some((record) => record.approved && record.capacity.maxRasterAreaRatio > 0.18));
});

test("preferred theme is applied only after hard compatibility", () => {
  const spec = makeSlideSpec({ assetCount: 1 });
  spec.designIntent.visualRatio = 0.18;
  const incompatiblePreferred = capabilityProfile({
    slug: "preferred-but-incompatible",
    themeId: "preferred-theme",
    maxRasterAreaRatio: 0.55,
  });
  const compatibleFallback = capabilityProfile({ slug: "compatible-fallback", themeId: "fallback-theme" });
  const selection = selectTemplate(spec, [incompatiblePreferred, compatibleFallback], undefined, "bid", "preferred-theme");
  assert.equal(selection.slug, "compatible-fallback");
});

test("schema requires an explicit fact-bearing emitted value position", () => {
  const candidate = structuredClone(makeTemplateProfiles()[0]) as unknown as { semanticSlots: Array<Record<string, unknown>> };
  delete candidate.semanticSlots[0].factBearingValueIndex;
  assert.equal(templateProfileSchema.safeParse(candidate).success, false);
});

test("schema requires an explicit minimum body font capability", () => {
  const candidate = structuredClone(makeTemplateProfiles()[0]) as unknown as Record<string, unknown>;
  delete candidate.minimumBodyFontPt;
  assert.equal(templateProfileSchema.safeParse(candidate).success, false);
});

test("schema rejects semantic capacity above any emitted complete-fact binding", () => {
  const candidate = structuredClone(loadTemplateProfiles(resolve("templates"))[0]);
  candidate.semanticSlots[0].maxCharsPerItem += 1;
  assert.equal(templateProfileSchema.safeParse(candidate).success, false);
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
  const spec = makeSlideSpec({ assetCount: 1 });
  spec.designIntent.visualRatio = 0.18;
  const original = selectTemplate(spec, profiles, undefined, "proposal");
  const changed = selectTemplate(spec, renamed, undefined, "proposal");
  assert.deepEqual(original.candidates.map((candidate) => candidate.score), changed.candidates.map((candidate) => candidate.score));
});

test("renaming every template file and slug preserves catalog structure and audit capabilities", async () => {
  const sourceProfiles = loadTemplateProfiles(resolve("templates"));
  const directory = await mkdtemp(join(tmpdir(), "renamed-green-family-"));
  try {
    const renamedProfiles = sourceProfiles.map((profile, index) => ({ ...structuredClone(profile), slug: `layout-${index + 1}` }));
    for (const [index, profile] of sourceProfiles.entries()) {
      const template = loadTemplate(resolve("templates"), profile.slug);
      await writeFile(
        join(directory, `${renamedProfiles[index].slug}.html`),
        template.html.replaceAll(profile.slug, renamedProfiles[index].slug),
      );
    }
    await writeFile(join(directory, "template-profiles.json"), JSON.stringify(renamedProfiles));
    const loaded = loadTemplateProfiles(directory);

    const withoutIdentity = (profile: TemplateProfile) => {
      const { slug: _slug, ...capabilities } = profile;
      return capabilities;
    };
    assert.deepEqual(loaded.map(withoutIdentity), sourceProfiles.map(withoutIdentity));
    assert.deepEqual(
      loaded.map((profile) => loadTemplate(directory, profile.slug).placeholders.map(({ tag, count }) => ({ tag, count }))),
      sourceProfiles.map((profile) => loadTemplate(resolve("templates"), profile.slug).placeholders.map(({ tag, count }) => ({ tag, count }))),
    );

    const auditShape = (profiles: TemplateProfile[]) => auditTemplateFamilies(profiles, "bid").families.map((family) => ({
      themeId: family.themeId,
      approvedCount: family.approvedProfiles.length,
      rejectedReasons: family.profiles.filter((profile) => !profile.approved).map((profile) => profile.rejectionReasons),
      capabilities: family.profiles.map((profile) => ({ approved: profile.approved, intents: profile.compatibleIntents, capacity: profile.capacity })),
    }));
    assert.deepEqual(auditShape(loaded), auditShape(sourceProfiles));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bid raster policy depends on declared capability rather than slug wording", () => {
  const spec = makeSlideSpec({ assetCount: 1 });
  spec.designIntent.visualRatio = 0.18;
  const selection = selectTemplate(spec, [
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

test("requested visual ratio cannot exceed a bid profile raster capacity", () => {
  const spec = makeSlideSpec({ assetCount: 1 });
  spec.designIntent.visualRatio = 0.9;
  assert.throws(
    () => selectTemplate(spec, [capabilityProfile({ maxRasterAreaRatio: 0.18 })], undefined, "bid"),
    /没有.*文档策略兼容/,
  );
});

test("requested visual ratio is enforced for non-bid and forced selection", () => {
  const spec = makeSlideSpec({ assetCount: 1 });
  spec.designIntent.visualRatio = 0.9;
  assert.throws(
    () => selectTemplate(spec, [capabilityProfile({ slug: "limited-layout", maxRasterAreaRatio: 0.18 })], undefined, "presentation"),
    /没有.*文档策略兼容/,
  );
  assert.throws(
    () => selectTemplate(spec, [capabilityProfile({ slug: "limited-layout", maxRasterAreaRatio: 0.18 })], "limited-layout", "presentation"),
    /不兼容/,
  );
});

test("selector enforces declared minimum and actual image slot count", () => {
  const profile = withImageSlots(capabilityProfile({ maxRasterAreaRatio: 0.55 }), 1, 1);
  const noImage = makeSlideSpec({ assetCount: 0 });
  const tooMany = makeSlideSpec({ assetCount: 2 });
  tooMany.designIntent.visualRatio = 0.5;
  assert.throws(() => selectTemplate(noImage, [profile], undefined, "presentation"), /没有.*兼容/);
  assert.throws(() => selectTemplate(tooMany, [profile], undefined, "presentation"), /没有.*兼容/);
});

test("selector rejects emitted table-cell text above the declared tag capacity", () => {
  const spec = makeSlideSpec({ blockTypes: ["table", "table", "table"], assetCount: 0 });
  spec.blocks[0].body = "一".repeat(40);
  const profile = withImageSlots(capabilityProfile({
    semanticSlots: [{
      id: "matrix",
      priority: 1,
      required: true,
      itemCapacity: 6,
      maxCharsPerItem: 120,
      acceptedRoles: ["comparison"],
      bindings: { tableCell: "table-cell" },
    }],
    maxCharsBySlot: { "table-cell": 24 },
  }), 0, 0);
  assert.throws(() => selectTemplate(spec, [profile], undefined, "presentation"), /没有.*兼容/);
});

async function temporaryCatalog(
  mutate: (profile: TemplateProfile, html: string) => { profile: TemplateProfile; html: string },
  selectProfile: (profiles: TemplateProfile[]) => TemplateProfile = (profiles) => profiles[0],
): Promise<{ directory: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "template-profile-test-"));
  const sourceProfile = structuredClone(selectProfile(loadTemplateProfiles(resolve("templates"))));
  const sourceTemplate = loadTemplate(resolve("templates"), sourceProfile.slug);
  const changed = mutate(sourceProfile, sourceTemplate.html);
  await writeFile(join(directory, "fixture.html"), changed.html);
  await writeFile(join(directory, "template-profiles.json"), JSON.stringify([changed.profile]));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function serializeTemplateMutation(dom: JSDOM, originalHtml: string): string {
  const rawTitle = originalHtml.match(/<title>[\s\S]*?<\/title>/i)?.[0];
  const serialized = dom.serialize();
  return rawTitle ? serialized.replace(/<title>[\s\S]*?<\/title>/i, rawTitle) : serialized;
}

test("loader rejects a profile whose raw page-title binding is absent", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile,
    html: html.replace(/<page-title>[\s\S]*?<\/page-title>/, "Static title"),
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /missing placeholders: page-title/);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects semantic binding cardinality above actual placeholders", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    profile.semanticSlots[0].itemCapacity += 1;
    return { profile, html };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /cardinality|placeholder count/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects semantic HTML placeholders above declared binding cardinality", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile,
    html: html.replace("</body>", "<component-title>extra</component-title></body>"),
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /cardinality|placeholder count/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects a semantic item marker count that differs from declared slot capacity", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile,
    html: html.replace(new RegExp(`\\sdata-semantic-slot=["']${profile.semanticSlots[0].id}["']`), ""),
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /semantic item marker|slot marker|item capacity/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects two semantic slots that emit to the same placeholder tag", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    profile.semanticSlots.push({
      ...structuredClone(profile.semanticSlots[0]),
      id: "duplicate-target",
      priority: profile.semanticSlots[0].priority + 1,
      required: false,
    });
    return { profile, html };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /duplicate.*placeholder|multiple bindings|target tag/i);
  } finally {
    await fixture.cleanup();
  }
});

type PromptCapableProfile = TemplateProfile & { assetPromptBindings?: { figureRef?: string } };

function promptReferenceProfile(profiles: TemplateProfile[]): TemplateProfile {
  return profiles.find((profile) => profile.slug === "green-infographic-bid-a4-landscape")!;
}

for (const conflict of [
  { label: "image directive", tag: "figures" },
  { label: "visible page binding", tag: "image-caption" },
  { label: "semantic binding", tag: "component-title" },
  { label: "auxiliary binding", tag: "step-label" },
]) {
  test(`loader rejects asset prompt tag ownership shared with ${conflict.label}`, async () => {
    const fixture = await temporaryCatalog((profile, html) => {
      (profile as PromptCapableProfile).assetPromptBindings = { figureRef: conflict.tag };
      profile.maxCharsBySlot[conflict.tag] ??= 240;
      if (conflict.tag === profile.imageSlots.placeholderTag) {
        html = html.replace(/<figure-ref>([\s\S]*?)<\/figure-ref>/i, "$1");
      }
      return { profile, html };
    }, promptReferenceProfile);
    try {
      assert.throws(
        () => loadTemplateProfiles(fixture.directory),
        (error: unknown) => error instanceof Error
          && /tag ownership conflict/i.test(error.message)
          && error.message.includes(conflict.tag),
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

test("loader requires prompt-only references to be owned exactly once by each non-rendered image directive", async () => {
  const omitted = await temporaryCatalog((profile, html) => {
    delete (profile as PromptCapableProfile).assetPromptBindings;
    return { profile, html };
  }, promptReferenceProfile);
  try {
    assert.throws(() => loadTemplateProfiles(omitted.directory), /undeclared placeholders: figure-ref/i);
  } finally {
    await omitted.cleanup();
  }

  const outside = await temporaryCatalog((profile, html) => {
    const promptProfile = profile as PromptCapableProfile;
    delete promptProfile.pageBindings.figureRef;
    promptProfile.assetPromptBindings = { figureRef: "figure-ref" };
    const dom = new JSDOM(html);
    const reference = dom.window.document.querySelector("figure-ref")!;
    dom.window.document.querySelector(".bid-page")!.append(reference);
    return { profile, html: serializeTemplateMutation(dom, html) };
  }, promptReferenceProfile);
  try {
    assert.throws(
      () => loadTemplateProfiles(outside.directory),
      /prompt.*(?:inside|within|owned).*(?:directive|image)|directive.*prompt/i,
    );
  } finally {
    await outside.cleanup();
  }

  const falseCardinality = await temporaryCatalog((profile, html) => {
    const promptProfile = profile as PromptCapableProfile;
    delete promptProfile.pageBindings.figureRef;
    promptProfile.assetPromptBindings = { figureRef: "figure-ref" };
    return { profile, html: html.replace("</figures>\n        <figcaption", "<figure-ref>duplicate</figure-ref></figures>\n        <figcaption") };
  }, promptReferenceProfile);
  try {
    assert.throws(
      () => loadTemplateProfiles(falseCardinality.directory),
      /prompt.*(?:cardinality|exactly|one)|cardinality.*prompt/i,
    );
  } finally {
    await falseCardinality.cleanup();
  }
});

test("loader rejects confused visible and prompt-only ownership but accepts a genuinely visible figure reference", async () => {
  const shared = await temporaryCatalog((profile, html) => {
    profile.pageBindings.figureRef = "figure-ref";
    return { profile, html };
  }, promptReferenceProfile);
  try {
    assert.throws(
      () => loadTemplateProfiles(shared.directory),
      /duplicate.*placeholder|shared.*binding|visible.*prompt|prompt.*visible/i,
    );
  } finally {
    await shared.cleanup();
  }

  const visible = await temporaryCatalog((profile, html) => {
    delete (profile as PromptCapableProfile).assetPromptBindings;
    profile.pageBindings.figureRef = "figure-ref";
    const dom = new JSDOM(html);
    const reference = dom.window.document.querySelector("figure-ref")!;
    dom.window.document.querySelector(".bid-page")!.append(reference);
    return { profile, html: serializeTemplateMutation(dom, html) };
  }, promptReferenceProfile);
  try {
    const [loaded] = loadTemplateProfiles(visible.directory);
    assert.equal(loaded.pageBindings.figureRef, "figure-ref");
    assert.equal((loaded as PromptCapableProfile).assetPromptBindings, undefined);
  } finally {
    await visible.cleanup();
  }
});

for (const selector of ["html", "body", ".bid-page"]) {
  test(`loader rejects page-root image container selector ${selector}`, async () => {
    const fixture = await temporaryCatalog((profile, html) => ({
      profile: { ...profile, imageSlots: { ...profile.imageSlots, containerSelector: selector } },
      html,
    }));
    try {
      assert.throws(() => loadTemplateProfiles(fixture.directory), /image container selector|unsafe|page root/i);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("loader rejects a nonmatching image container selector", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile: { ...profile, imageSlots: { ...profile.imageSlots, containerSelector: ".missing-image-container" } },
    html,
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /image container selector|does not match/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects a malformed image container selector", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile: { ...profile, imageSlots: { ...profile.imageSlots, containerSelector: "figure[" } },
    html,
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /image container selector|malformed|simple/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader accepts only one explicitly selected image-caption node pair", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    const dom = new JSDOM(html);
    dom.window.document.querySelector("figures")!.classList.add("qa-overlap-image");
    dom.window.document.querySelector("figcaption")!.classList.add("qa-overlap-caption");
    return {
      profile: {
        ...profile,
        overlapExemptions: [{ imageSelector: ".qa-overlap-image", captionSelector: ".qa-overlap-caption" }],
      },
      html: serializeTemplateMutation(dom, html),
    };
  });
  try {
    const [loaded] = loadTemplateProfiles(fixture.directory);
    assert.deepEqual(loaded.overlapExemptions, [{ imageSelector: ".qa-overlap-image", captionSelector: ".qa-overlap-caption" }]);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects an overlap exemption whose caption selector targets ordinary landmark text", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile: {
      ...profile,
      overlapExemptions: [{ imageSelector: ".image-card", captionSelector: ".summary-band" }],
    },
    html,
  }));
  try {
    assert.throws(
      () => loadTemplateProfiles(fixture.directory),
      /overlap exemption.*(?:image|caption|semantic|landmark|owned|unsafe|node pair)/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects an image selector that resolves all placeholders to one shared container", async () => {
  const fixture = await temporaryCatalog(
    (profile, html) => ({
      profile: { ...profile, imageSlots: { ...profile.imageSlots, containerSelector: ".body-grid" } },
      html,
    }),
    (profiles) => profiles.find((profile) => profile.imageSlots.placeholderCount === 4)!,
  );
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /image container selector|distinct|shared/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects a bound placeholder without a declared character capacity", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile: { ...profile, maxCharsBySlot: {} },
    html,
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /character capacity/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects duplicate embedded template slugs before profile matching", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({ profile, html }));
  try {
    const duplicate = await readFile(join(fixture.directory, "fixture.html"), "utf8");
    await writeFile(join(fixture.directory, "duplicate.html"), duplicate);
    assert.throws(() => loadTemplateProfiles(fixture.directory), /duplicate.*template slug/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects template HTML without an embedded slug", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile,
    html: html
      .replace(/^\s*@slug\s+.*$/m, "")
      .replace(/<meta\s+name=["']template-slug["'][^>]*>/i, ""),
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /missing.*template slug/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects conflicting comment and HTML template slugs", async () => {
  const fixture = await temporaryCatalog((profile, html) => ({
    profile,
    html: html.replace("<head>", '<head><meta name="template-slug" content="conflicting-slug">'),
  }));
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /conflicting.*template slug/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects an auxiliary selector borrowed from another repeated group", async () => {
  const fixture = await temporaryCatalog(
    (profile, html) => {
      profile.auxiliaryGroups!.find((group) => group.id === "capability")!.itemSelector = ".process-step";
      return { profile, html };
    },
    (profiles) => profiles.find((profile) => profile.slug.endsWith("-visual"))!,
  );
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*(?:binding|placeholder|ownership|overlap)/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects swapped auxiliary group item selectors", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    const capability = profile.auxiliaryGroups!.find((group) => group.id === "capability")!;
    const organization = profile.auxiliaryGroups!.find((group) => group.id === "organization")!;
    [capability.itemSelector, organization.itemSelector] = [organization.itemSelector, capability.itemSelector];
    return { profile, html };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*(?:binding|placeholder|ownership)/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects shared auxiliary item ownership even when both bindings are present", async () => {
  const fixture = await temporaryCatalog(
    (profile, html) => {
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      const processItems = Array.from(doc.querySelectorAll(".process-step"));
      Array.from(doc.querySelectorAll(".capability-item item-label")).forEach((label, index) => processItems[index].append(label));
      profile.auxiliaryGroups!.find((group) => group.id === "capability")!.itemSelector = ".process-step";
      return { profile, html: serializeTemplateMutation(dom, html) };
    },
    (profiles) => profiles.find((profile) => profile.slug.endsWith("-visual"))!,
  );
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*(?:shared|overlap|ownership|disjoint)/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects nested auxiliary item ownership", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const organizationLevels = Array.from(doc.querySelectorAll(".org-level"));
    Array.from(doc.querySelectorAll(".capability-item item-label")).forEach((label, index) => organizationLevels[index].append(label));
    profile.auxiliaryGroups!.find((group) => group.id === "capability")!.itemSelector = ".org-level";
    profile.auxiliaryGroups!.find((group) => group.id === "organization")!.itemSelector = ".org-node";
    return { profile, html: serializeTemplateMutation(dom, html) };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*(?:nested|overlap|ownership|disjoint)/i);
  } finally {
    await fixture.cleanup();
  }
});

for (const [name, selector] of [["required landmark", ".summary-band"], ["page structure root", ".body-grid"]] as const) {
  test(`loader rejects an auxiliary group that owns a ${name}`, async () => {
    const fixture = await temporaryCatalog((profile, html) => {
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      const protectedNode = doc.querySelector(selector)!;
      protectedNode.append(doc.querySelector("step-label")!);
      doc.querySelectorAll(".process-step, .process-arrow").forEach((element) => element.remove());
      profile.auxiliaryCapacities!.stepLabel.itemCapacity = 1;
      const process = profile.auxiliaryGroups!.find((group) => group.id === "process")!;
      process.itemCapacity = 1;
      process.itemSelector = selector;
      delete process.connectorSelector;
      return { profile, html: serializeTemplateMutation(dom, html) };
    });
    try {
      assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*(?:landmark|root|structure|ownership)/i);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("loader rejects an auxiliary item without its declared bound placeholder", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    profile.auxiliaryGroups!.find((group) => group.id === "capability")!.itemSelector = ".org-node";
    return { profile, html };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*(?:bound placeholder|binding|item-label)/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects auxiliary connectors outside the order of their owned items", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    const dom = new JSDOM(html);
    const process = dom.window.document.querySelector('[data-component="icon-process"]')!;
    Array.from(process.querySelectorAll(":scope > .process-arrow")).forEach((arrow) => process.append(arrow));
    return { profile, html: serializeTemplateMutation(dom, html) };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*connector.*order/i);
  } finally {
    await fixture.cleanup();
  }
});

test("loader rejects an auxiliary connector that contains a placeholder", async () => {
  const fixture = await temporaryCatalog((profile, html) => {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    doc.querySelector(".process-arrow")!.append(doc.querySelector(".process-step step-label")!);
    return { profile, html: serializeTemplateMutation(dom, html) };
  });
  try {
    assert.throws(() => loadTemplateProfiles(fixture.directory), /auxiliary group.*connector.*placeholder/i);
  } finally {
    await fixture.cleanup();
  }
});
