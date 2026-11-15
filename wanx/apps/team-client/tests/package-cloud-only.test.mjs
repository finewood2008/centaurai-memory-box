import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FileMatcher, copyFiles } from "app-builder-lib/out/fileMatcher.js";
import { build } from "esbuild";
import { windowsReleaseConfiguration } from "../tools/package-client-windows.mjs";
import { windowsInternalFiles } from "../shell/package-win.mjs";
import { assertCloudOnlyPackage } from "../tools/package-client-files.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const removed = [
  "device-trust/coordinator.mjs", "device-trust/data-context.mjs",
  "local-ui/device-trust/index.html", "local-ui/device-trust/view.mjs",
  "local-ui/device-trust/styles.css", "local-ui/device-trust-preload.cjs",
  "shell/device-trust-window.mjs", "shell/device-trust-lifecycle.mjs",
  "shell/identity-security.mjs", "shell/recovery-files.mjs", "shell/backup-files.mjs",
  "shell/wanx-mcp-knowledge.mjs",
  "shell/identity-security.json", "shell/local-device-identity/identity-vault.json",
];
const retained = [
  "account/index.mjs", "account/store.mjs", "account/local-encryption.mjs",
  "shell/private-storage.mjs", "shell/windows-private-acl.ps1",
  "shell/entry.mjs", "shell/main.mjs", "local-ui/remote-preload.cjs",
  "local-ui/renderer/index.html", "updates/identity.mjs", "package.json",
];
const formal = windowsReleaseConfiguration({ pkg, version: pkg.version, arch: "x64", out: "output",
  trustFile: "production-trust.json", publisherName: "Fixture Publisher", certificateSha1: "a".repeat(40),
  build: { buildId: "test-build", channel: "stable-studio" } });

async function packageFixture(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-cloud-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source"), destination = path.join(directory, "app");
  for (const relative of [...removed, ...retained]) {
    const target = path.join(source, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, relative === "package.json" ? JSON.stringify({ name: "fixture", main: "shell/entry.mjs" }) : relative);
  }
  const customerIdentity = path.join(directory, "userData", "local-device-identity", "identity-vault.json");
  await mkdir(path.dirname(customerIdentity), { recursive: true });
  await writeFile(customerIdentity, "customer identity must remain untouched");
  await copyFiles([new FileMatcher(source, destination, value => value, files)], null, false);
  const archive = path.join(directory, "app.asar");
  await require("@electron/asar").createPackage(destination, archive);
  const entries = require("@electron/asar").listPackage(archive).map(value => value.replaceAll("\\", "/").replace(/^\//, ""));
  for (const relative of retained) assert.ok(entries.includes(relative), `normal cloud runtime was omitted: ${relative}`);
  assert.equal(await readFile(customerIdentity, "utf8"), "customer identity must remain untouched");
  return { archive, entries };
}

for (const [name, files] of [["default", pkg.build.files], ["formal Windows", formal.files], ["internal Windows", windowsInternalFiles(pkg)]]) {
  test(`${name} package excludes local identity code and UI while preserving cloud signing and storage`, async t => {
    const { entries, archive } = await packageFixture(t, files);
    assert.deepEqual(entries.filter(entry => removed.includes(entry)), []);
    assertCloudOnlyPackage(archive);
  });
}

test("the archive gate rejects reintroduced identity code even when a build includes it", async t => {
  const { archive } = await packageFixture(t, ["**/*"]);
  assert.throws(() => assertCloudOnlyPackage(archive), /CLIENT_LOCAL_IDENTITY_PACKAGED:/);
});

test("packaged startup and preload dependencies resolve without local identity modules", async () => {
  // Resolve real source imports through esbuild while enforcing the actual builder filter.
  // This catches a hidden top-level import even after its target is excluded from ASAR.
  const accepts = new FileMatcher(root, root, value => value, pkg.build.files).createFilter();
  await build({ entryPoints: [path.join(root, "shell/entry.mjs"), path.join(root, "local-ui/remote-preload.cjs")],
    outdir: "unused", bundle: true, write: false, platform: "node", format: "esm", packages: "external", logLevel: "silent",
    plugins: [{ name: "packaged-source-closure", setup(builder) {
      builder.onLoad({ filter: /\.[cm]?js$/ }, async args => {
        const relative = path.relative(root, args.path).replaceAll("\\", "/");
        if (relative.startsWith("device-trust/") || !accepts(args.path, await stat(args.path))) {
          return { errors: [{ text: `PACKAGED_IMPORT_EXCLUDED:${relative}` }] };
        }
        return undefined;
      });
    } }],
  });
});
