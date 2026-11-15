import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { windowsReleaseConfiguration } from "../tools/package-client-windows.mjs";

async function input() {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return { pkg, arch: "x64", out: "output", trustFile: "production-trust.json",
    publisherName: "Example Publisher", certificateSha1: "a".repeat(40),
    build: { buildId: "test-build", channel: pkg.wanxEdition === "team" ? "stable-studio" : "stable" } };
}

test("Windows defaults both architectures to the source package version without changing it", async () => {
  const options = await input(), original = structuredClone(options.pkg);
  for (const arch of ["x64", "arm64"]) {
    const config = windowsReleaseConfiguration({ ...options, arch });
    assert.equal(config.extraMetadata.version, options.pkg.version);
    assert.deepEqual(config.win.target, [{ target: "nsis", arch: [arch] }]);
    assert.equal(config.forceCodeSigning, true);
  }
  const changed = { ...options.pkg, version: "7.8.9" };
  assert.equal(windowsReleaseConfiguration({ ...options, pkg: changed }).extraMetadata.version, "7.8.9");
  assert.deepEqual(options.pkg, original);
});

test("Windows explicit release version overrides only build metadata", async () => {
  const options = await input(), original = structuredClone(options.pkg);
  for (const version of ["2.3.4", "2.3.4-beta.1"]) {
    const config = windowsReleaseConfiguration({ ...options, version });
    assert.equal(config.extraMetadata.version, version);
    assert.equal(config.win.artifactName, "WANX-${version}-win-${arch}.${ext}");
    assert.deepEqual(options.pkg, original);
  }
});

test("Windows rejects invalid explicit versions rather than silently falling back", async () => {
  const options = await input();
  for (const version of ["", null, "v1.0.2", "1.2", " 1.0.2", 102])
    assert.throws(() => windowsReleaseConfiguration({ ...options, version }), /package\.json|--version/);
  for (const version of [undefined, "", "v1.0.2", "1.2"])
    assert.throws(() => windowsReleaseConfiguration({ ...options, pkg: { ...options.pkg, version } }), /package\.json|--version/);
});
