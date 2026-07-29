import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import { loadTemplate } from "../../src/lib/template-parser.js";
import { renderPage } from "../../src/services/page-renderer.js";
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

test("removes an unused optional figure instead of requiring or fabricating an image", async () => {
  const optionalTemplateSlug = "green-infographic-bid-a4-landscape";
  const optionalTemplate = loadTemplate(templatesDir, optionalTemplateSlug);
  const optionalProfile = {
    ...loadTemplateProfiles(templatesDir).find((item) => item.slug === optionalTemplateSlug)!,
    imageSlots: { placeholderTag: "figures", placeholderCount: 1, minAssets: 0, maxAssets: 1, unusedPolicy: "remove-container", containerSelector: "figure" },
  } as unknown as typeof profile;
  const noImageSpec = makeSlideSpec({ assetCount: 0 });
  noImageSpec.title = "无图页面标题".repeat(8).slice(0, optionalProfile.maxCharsBySlot[optionalProfile.pageBindings.pageTitle]);
  const result = await composeSlide({ spec: noImageSpec, template: optionalTemplate, profile: optionalProfile, assets: [] });
  assert.doesNotMatch(result.html, /<figures|data-asset-id=/);
  assert.doesNotMatch(result.html, /<figure-ref|<image-caption|方案场景示意图/);
  assert.match(result.html, new RegExp(noImageSpec.title));
});

test("optional image projection rejects only the page title cap plus one and preserves image bindings when an image exists", async () => {
  const optionalTemplateSlug = "green-infographic-bid-a4-landscape";
  const optionalTemplate = loadTemplate(templatesDir, optionalTemplateSlug);
  const optionalProfile = loadTemplateProfiles(templatesDir).find((item) => item.slug === optionalTemplateSlug)!;
  const titleCap = optionalProfile.maxCharsBySlot[optionalProfile.pageBindings.pageTitle];
  const tooLong = makeSlideSpec({ assetCount: 0 });
  tooLong.title = "页".repeat(titleCap + 1);
  await assert.rejects(
    () => composeSlide({ spec: tooLong, template: optionalTemplate, profile: optionalProfile, assets: [] }),
    /字符|capacity|too_big|40/i,
  );

  const withImage = makeSlideSpec({ assetCount: 1 });
  withImage.title = "页".repeat(titleCap);
  withImage.blocks[0].title = "图".repeat(optionalProfile.maxCharsBySlot[optionalProfile.pageBindings.figureRef!]);
  withImage.assets[0].alt = "场".repeat(optionalProfile.maxCharsBySlot[optionalProfile.pageBindings.imageCaption!]);
  const composed = await composeSlide({
    spec: withImage,
    template: optionalTemplate,
    profile: optionalProfile,
    assets: makeGeneratedAssets(withImage.assets),
  });
  assert.match(composed.html, /data-asset-id="img-001"/);
  assert.match(composed.html, new RegExp(withImage.assets[0].alt));
});

test("four-figure template requires exact cardinality and never reuses an asset", async () => {
  const exactProfile = {
    ...profile,
    imageSlots: { placeholderTag: "figures", placeholderCount: 4, minAssets: 4, maxAssets: 4, unusedPolicy: "remove-container", containerSelector: "figure" },
  } as unknown as typeof profile;
  const fourSpec = makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 4 });
  const fourAssets = makeGeneratedAssets(fourSpec.assets);
  const delivered = await composeSlide({ spec: fourSpec, template, profile: exactProfile, assets: fourAssets });
  for (const asset of fourAssets) {
    assert.equal((delivered.html.match(new RegExp(`data-asset-id="${asset.id}"`, "g")) ?? []).length, 1);
  }

  const threeSpec = makeSlideSpec({ blockTypes: ["image", "image", "image", "image"], assetCount: 3 });
  await assert.rejects(
    () => composeSlide({ spec: threeSpec, template, profile: exactProfile, assets: makeGeneratedAssets(threeSpec.assets) }),
    /requires exactly 4 image assets/,
  );
});

test("declarative auxiliary groups prune unused repeated UI for two through four blocks", async () => {
  const baseSlug = "green-infographic-bid-a4-landscape";
  const baseTemplate = loadTemplate(templatesDir, baseSlug);
  const baseProfile = loadTemplateProfiles(templatesDir).find((item) => item.slug === baseSlug)!;

  for (const blockCount of [2, 3, 4]) {
    const sparseSpec = makeSlideSpec({ assetCount: 0 });
    sparseSpec.blocks = sparseSpec.blocks.slice(0, blockCount);
    if (blockCount === 4) {
      sparseSpec.blocks.push({ ...sparseSpec.blocks[0], id: "block-4", title: "方案要点4" });
    }
    const result = await composeSlide({ spec: sparseSpec, template: baseTemplate, profile: baseProfile, assets: [] });
    const doc = new JSDOM(result.html).window.document;
    const expectedProcess = Math.min(blockCount, 5);
    const expectedCompact = Math.min(blockCount, 3);
    assert.equal(doc.querySelectorAll(".process-step").length, expectedProcess, `process item count for ${blockCount} blocks`);
    assert.equal(doc.querySelectorAll(".process-arrow").length, Math.max(0, expectedProcess - 1), `process connector count for ${blockCount} blocks`);
    assert.equal(doc.querySelectorAll(".timeline-stage").length, Math.min(blockCount, 4), `timeline item count for ${blockCount} blocks`);
    assert.equal(doc.querySelectorAll(".capability-item").length, blockCount >= 3 ? expectedCompact : 0, `capability item count for ${blockCount} blocks`);
    assert.equal(doc.querySelectorAll(".org-node").length, blockCount >= 3 ? expectedCompact : 0, `org item count for ${blockCount} blocks`);
    assert.equal(doc.querySelectorAll(".org-connector").length, blockCount >= 3 ? Math.max(0, expectedCompact - 1) : 0, `org connector count for ${blockCount} blocks`);
    for (const element of Array.from(doc.querySelectorAll(".process-step, .timeline-stage, .capability-item, .org-node"))) {
      assert.ok(element.textContent?.trim(), `visible auxiliary item must not be blank for ${blockCount} blocks`);
    }
  }
});

test("every green family profile prunes all declared repeated UI for supported sparse counts", async () => {
  const familyProfiles = loadTemplateProfiles(templatesDir);
  for (const familyProfile of familyProfiles) {
    const familyTemplate = loadTemplate(templatesDir, familyProfile.slug);
    const usesTableFacts = familyProfile.semanticSlots.some((slot) => slot.bindings.tableCell);
    const blockType = usesTableFacts ? "table" : familyProfile.supportedBlocks.includes("text") ? "text" : familyProfile.supportedBlocks[0];
    for (let blockCount = 2; blockCount <= Math.min(4, familyProfile.blockCapacity); blockCount += 1) {
      const sparseSpec = makeSlideSpec({ blockTypes: Array.from({ length: Math.max(3, blockCount) }, () => blockType), assetCount: 0 });
      sparseSpec.blocks = sparseSpec.blocks.slice(0, blockCount);
      sparseSpec.assets = Array.from({ length: familyProfile.imageSlots.minAssets }, (_, index) => ({
        id: `img-${String(index + 1).padStart(3, "0")}`,
        type: "image" as const,
        blockId: sparseSpec.blocks[index % sparseSpec.blocks.length].id,
        prompt: "professional bid illustration, no text",
        alt: "服务方案示意图",
        sourceFactIds: sparseSpec.blocks[index % sparseSpec.blocks.length].sourceFactIds,
        width: 1792 as const,
        height: 1024 as const,
      }));
      sparseSpec.designIntent.visualRatio = sparseSpec.assets.length > 0 ? Math.min(familyProfile.maxRasterAreaRatio, 0.18) : 0;
      const result = await composeSlide({
        spec: sparseSpec,
        template: familyTemplate,
        profile: familyProfile,
        assets: makeGeneratedAssets(sparseSpec.assets),
      });
      const outputDocument = new JSDOM(result.html).window.document;
      const sourceDocument = new JSDOM(familyTemplate.html).window.document;
      for (const group of familyProfile.auxiliaryGroups ?? []) {
        const sourceItem = sourceDocument.querySelector(group.itemSelector);
        const gatedParent = sourceItem?.closest("[data-min-semantic-items]");
        const minimum = Number.parseInt(gatedParent?.getAttribute("data-min-semantic-items") ?? "0", 10);
        const expectedItems = minimum > blockCount ? 0 : Math.min(blockCount, group.itemCapacity);
        const visibleItems = Array.from(outputDocument.querySelectorAll(group.itemSelector));
        assert.equal(visibleItems.length, expectedItems, `${familyProfile.slug}.${group.id} item count for ${blockCount} blocks`);
        assert.ok(visibleItems.every((element) => Boolean(element.textContent?.trim())), `${familyProfile.slug}.${group.id} contains a blank visible item`);
        if (group.connectorSelector) {
          const expectedConnectors = expectedItems === 0 ? 0 : Math.max(0, expectedItems - 1);
          assert.equal(outputDocument.querySelectorAll(group.connectorSelector).length, expectedConnectors, `${familyProfile.slug}.${group.id} connector count for ${blockCount} blocks`);
        }
      }
    }
  }
});

async function cssSecurityFixture(href: string, css?: string) {
  const root = await mkdtemp(join(tmpdir(), "template-css-security-"));
  const family = join(root, "family");
  await mkdir(family);
  if (css !== undefined) await writeFile(join(family, "theme.css"), css);
  return {
    root,
    family,
    parsed: {
      ...template,
      filePath: join(family, "template.html"),
      html: template.html.replace(/href="[^"]+\.css"/, `href="${href}"`),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("stylesheet traversal cannot read or inline files outside the template family", async () => {
  const fixture = await cssSecurityFixture("../secret.css");
  const secret = "LOCAL_SECRET_MUST_NOT_LEAK";
  await writeFile(join(fixture.root, "secret.css"), `:root{--secret:"${secret}"}`);
  try {
    await assert.rejects(
      () => composeSlide({ spec, template: fixture.parsed, profile, assets }),
      (error: unknown) => error instanceof Error && /stylesheet|template family|outside/i.test(error.message) && !error.message.includes(secret),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stylesheet symlinks cannot escape the template family", async () => {
  const fixture = await cssSecurityFixture("./theme.css");
  await rm(join(fixture.family, "theme.css"), { force: true });
  await writeFile(join(fixture.root, "secret.css"), ":root{--secret:outside}");
  await symlink(join(fixture.root, "secret.css"), join(fixture.family, "theme.css"));
  try {
    await assert.rejects(
      () => composeSlide({ spec, template: fixture.parsed, profile, assets }),
      /stylesheet|template family|symlink|outside/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

for (const [name, unsafeCss] of [
  ["import", '@import "https://example.com/theme.css";'],
  ["remote URL", ".x{background:url(https://example.com/a.png)}"],
  ["file URL", ".x{background:url(file:///etc/passwd)}"],
  ["data URL", ".x{background:url(data:text/plain;base64,U0VDUkVU)}"],
  ["relative URL", ".x{background:url(../secret.png)}"],
] as const) {
  test(`rejects CSS ${name} resource loading`, async () => {
    const fixture = await cssSecurityFixture("./theme.css", unsafeCss);
    try {
      await assert.rejects(
        () => composeSlide({ spec, template: fixture.parsed, profile, assets }),
        /unsafe stylesheet|@import|url\(\)|resource/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const [name, unsafeCss] of [
  ["import", '@import "file:///tmp/private-theme.css";'],
  ["URL", ".x{background-image:url(https://example.invalid/private.png)}"],
  ["image-set", ".x{background-image:image-set('https://example.invalid/a.png' 1x)}"],
  ["escaped resource function", ".x{background-image:u\\72l(https://example.invalid/a.png)}"],
  ["commented URL", "/* https://example.invalid/private.png */ .x{color:#171a18}"],
] as const) {
  test(`rejects unsafe inline style block ${name} before composing final HTML`, async () => {
    const injectedUrl = "https://example.invalid/private.png";
    const parsed = {
      ...template,
      html: template.html.replace("</head>", `<style>${unsafeCss}</style></head>`),
    };
    await assert.rejects(
      () => composeSlide({ spec, template: parsed, profile, assets }),
      (error: unknown) => error instanceof Error
        && /unsafe.*style|resource directive/i.test(error.message)
        && !error.message.includes(injectedUrl)
        && !error.message.includes("/tmp/private-theme.css"),
    );
  });
}

for (const [name, unsafeStyle] of [
  ["remote URL", "background-image:url(https://example.invalid/private.png)"],
  ["file URL", "--private-source:file:///tmp/private.css"],
  ["data URL", "list-style-image:url(data:image/svg+xml;base64,PHN2Zz4=)"],
] as const) {
  test(`rejects unsafe style attribute ${name} before composing final HTML`, async () => {
    const parsed = {
      ...template,
      html: template.html.replace('class="bid-page"', `class="bid-page" style="${unsafeStyle}"`),
    };
    await assert.rejects(
      () => composeSlide({ spec, template: parsed, profile, assets }),
      (error: unknown) => error instanceof Error
        && /unsafe.*style|resource directive/i.test(error.message)
        && !error.message.includes("example.invalid")
        && !error.message.includes("/tmp/private.css"),
    );
  });
}

for (const rel of ["stylesheet preload", "preload stylesheet", "StyleSheet PRELOAD"] as const) {
  test(`inlines stylesheet rel token permutation ${rel} and leaves Chromium with no network request`, async () => {
    const fixture = await cssSecurityFixture("./theme.css", ".safe-token-style{color:#171a18}");
    fixture.parsed.html = fixture.parsed.html.replace('rel="stylesheet"', `rel="${rel}"`);
    try {
      const composed = await composeSlide({ spec, template: fixture.parsed, profile, assets });
      assert.doesNotMatch(composed.html, /<link\b/i);
      assert.match(composed.html, /data-inline-source="\.\/theme\.css"/);
      const output = await mkdtemp(join(tmpdir(), "mixed-rel-network-"));
      const render = await renderPage({ html: composed.html, screenshotPath: join(output, "page.png") });
      assert.deepEqual(render.signals.networkRequests, []);
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const rel of ["stylesheet preload", "preload stylesheet", "StyleSheet PRELOAD"] as const) {
  test(`rejects remote stylesheet rel token permutation ${rel} without leaking the URL`, async () => {
    const remote = "https://example.invalid/private.css";
    const parsed = {
      ...template,
      html: template.html.replace('rel="stylesheet" href="./green-infographic-theme.css"', `rel="${rel}" href="${remote}"`),
    };
    await assert.rejects(
      () => composeSlide({ spec, template: parsed, profile, assets }),
      (error: unknown) => error instanceof Error && /stylesheet|resource/i.test(error.message) && !error.message.includes(remote),
    );
  });
}

test("rejects residual resource-bearing elements before returning final HTML", async () => {
  const remote = "https://example.invalid/private-frame";
  const parsed = { ...template, html: template.html.replace("</body>", `<iframe src="${remote}"></iframe></body>`) };
  await assert.rejects(
    () => composeSlide({ spec, template: parsed, profile, assets }),
    (error: unknown) => error instanceof Error && /resource/i.test(error.message) && !error.message.includes(remote),
  );
});

test("rejects legacy resource-loading attributes before returning final HTML", async () => {
  const remote = "https://example.invalid/private-background";
  const parsed = { ...template, html: template.html.replace("<body>", `<body background="${remote}">`) };
  await assert.rejects(
    () => composeSlide({ spec, template: parsed, profile, assets }),
    (error: unknown) => error instanceof Error && /resource/i.test(error.message) && !error.message.includes(remote),
  );
});
