import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAC_DMG_LAYOUT, macDmgPresentation } from "../tools/installer-presentation.mjs";
import { TEST_PRODUCT_NAME } from "../updates/test-build.mjs";

const require = createRequire(import.meta.url);
const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
const { DmgTarget, getImageSizeUsingSips, transformBackgroundFileIfNeed } = require("dmg-builder");
const background = fileURLToPath(new URL("../resources/installer/redesign/mac-dmg.png", import.meta.url));

test("the one-step Mac layout is accepted by the actual builder configuration schema", async () => {
  const dmg = macDmgPresentation({ appName: "半人马AI记忆盒子", background });
  await validateConfiguration({ dmg }, { isEnabled: false });
  const [application, applications] = dmg.contents;
  assert.equal(application.type, "file");
  assert.equal(application.path, undefined, "the builder supplies the actual built application");
  assert.equal(application.name, undefined, "the actual bundle basename must be preserved");
  assert.equal(applications.type, "link");
  assert.equal(applications.path, "/Applications");
  assert.equal(dmg.contents.length, 2, "no CLI or extra installation step is added");
  assert.ok(application.x < applications.x);
  assert.equal(application.y, applications.y);
  const halfIcon = dmg.iconSize / 2;
  for (const item of dmg.contents) {
    assert.ok(item.x - halfIcon > 0 && item.x + halfIcon < dmg.window.width);
    assert.ok(item.y - halfIcon > 100 && item.y + halfIcon + 42 < dmg.window.height - 50,
      "icons, two-line labels and the footer must have separate space");
  }
});

test("the actual DMG target retains normal and isolated test volume identities", async () => {
  for (const appName of ["半人马AI记忆盒子", TEST_PRODUCT_NAME]) {
    const dmg = macDmgPresentation({ appName, background });
    const resources = [];
    const packager = {
      config: { dmg }, compression: "normal",
      appInfo: { productFilename: appName, productName: appName, name: "unchanged-package-name", version: "1.0.6" },
      platformSpecificBuildOptions: { defaultArch: "x64" },
      getIconPath: async () => "/fixture/resources/icon.icns",
      getResource: async value => { resources.push(value); return value; },
    };
    const target = new DmgTarget(packager, "/fixture/output");
    const result = await target.computeDmgOptions(path.join("/fixture/output", `${appName}.app`));
    assert.equal(target.computeVolumeName(3, result.title), appName);
    assert.deepEqual(result.contents, dmg.contents);
    assert.equal(result.background, background);
    assert.deepEqual(resources, [background]);
    assert.equal(result.format, "UDZO");
    assert.equal(result.icon, "/fixture/resources/icon.icns");
  }
});

test("layouts are independent and refuse a Retina image used as the logical base", () => {
  const first = macDmgPresentation({ appName: "半人马AI记忆盒子", background });
  first.window.width = 10; first.contents[0].x = -100;
  const next = macDmgPresentation({ appName: TEST_PRODUCT_NAME, background });
  assert.equal(next.window.width, MAC_DMG_LAYOUT.width);
  assert.equal(next.contents[0].x, MAC_DMG_LAYOUT.appX);
  assert.throws(() => macDmgPresentation({ appName: "", background }), /APP_NAME_REQUIRED/);
  assert.throws(() => macDmgPresentation({ appName: "半人马AI记忆盒子", background: background.replace(".png", "@2x.png") }), /BASE_BACKGROUND_REQUIRED/);
});

test("the actual 1x and 2x backgrounds match Finder's logical window and Retina scale", async () => {
  const dmg = macDmgPresentation({ appName: "半人马AI记忆盒子", background });
  for (const density of [1, 2]) {
    const data = await readFile(density === 1 ? background : background.replace(".png", "@2x.png"));
    assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(data.readUInt32BE(16), dmg.window.width * density);
    assert.equal(data.readUInt32BE(20), dmg.window.height * density);
  }
});

test("the native builder creates a Retina TIFF with the intended logical Finder size", { skip: process.platform !== "darwin" }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memobox-dmg-background-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const converted = await transformBackgroundFileIfNeed(background, {
    getTempFile: async ({ suffix }) => path.join(directory, `background${suffix}`),
  });
  assert.notEqual(converted, background, "the actual @2x sibling must be detected");
  assert.equal(path.extname(converted), ".tiff");
  const logical = await getImageSizeUsingSips(converted);
  assert.deepEqual(logical, { width: MAC_DMG_LAYOUT.width, height: MAC_DMG_LAYOUT.height });
});
