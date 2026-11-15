import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readClientIdentity } from "../updates/identity.mjs";

async function appFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-client-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ wanxEdition: "personal",
    wanxBuild: { distributionClass: "formal", buildId: "build-1" } }));
  return { isPackaged: true, getAppPath: () => root, getVersion: () => "1.0.4" };
}

test("macOS identity reports runtime product version separately from Darwin kernel", async t => {
  const app = await appFixture(t);
  const identity = await readClientIdentity({ app, platform: "darwin", arch: "arm64",
    osRelease: () => "25.6.0", getSystemVersion: () => "26.6" });
  assert.equal(identity.osVersion, "25.6.0");
  assert.equal(identity.osProductVersion, "26.6");
  assert.equal(Object.hasOwn(identity, "windowsProductType"), false);
  assert.equal(Object.isFrozen(identity), true);
});

test("macOS probe failure keeps explicit unknown facts instead of claiming legacy scope", async t => {
  const app = await appFixture(t);
  for (const getSystemVersion of [() => { throw new Error("probe failed"); }, () => undefined,
    () => "", () => "x".repeat(129), () => "26.6\nprivate"]) {
    const identity = await readClientIdentity({ app, platform: "darwin", osRelease: () => "25.6.0", getSystemVersion });
    assert.equal(identity.osProductVersion, "unknown");
  }
});

function windowsProbe(value, inspect = () => {}) {
  return (file, args, options, callback) => { inspect(file, args, options); callback(null, JSON.stringify(value), ""); };
}

test("Windows identity distinguishes workstation, domain controller and Server with a bounded native probe", async t => {
  const app = await appFixture(t);
  for (const productType of [1, 2, 3]) {
    const identity = await readClientIdentity({ app, platform: "win32", arch: "x64", osRelease: () => "10.0.26200.1234",
      execFile: windowsProbe({ ProductType: productType, BuildNumber: "26200" }, (file, args, options) => {
        assert.equal(path.win32.isAbsolute(file), true);
        assert.equal(path.win32.basename(file), "powershell.exe");
        assert.ok(args.includes("-NoProfile") && args.includes("-NonInteractive"));
        assert.ok(args.some(arg => arg.includes("Get-CimInstance") && arg.includes("Win32_OperatingSystem")));
        assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 16 * 1024);
        assert.equal(options.windowsHide, true); assert.notEqual(options.shell, true);
      }) });
    assert.equal(identity.windowsProductType, productType);
    assert.equal(identity.osVersion, "10.0.26200.1234");
    assert.equal(Object.hasOwn(identity, "osProductVersion"), false);
  }
});

test("Windows facts fail closed on unknown product type, inconsistent build or command failure", async t => {
  const app = await appFixture(t);
  for (const execFile of [windowsProbe({ ProductType: 0, BuildNumber: "26200" }),
    windowsProbe({ ProductType: 1, BuildNumber: "26100" }), windowsProbe({ ProductType: "1", BuildNumber: "26200" }),
    windowsProbe({ ProductType: 1, BuildNumber: "invalid" }),
    (_file, _args, _options, callback) => callback(new Error("timeout"), "", ""),
    (_file, _args, _options, callback) => queueMicrotask(() => callback(null, "not json", "")),
    (_file, _args, _options, callback) => callback(null, '{"ProductType":1,"BuildNumber":"26200"}', "probe error")]) {
    const identity = await readClientIdentity({ app, platform: "win32", osRelease: () => "10.0.26200", execFile });
    assert.equal(identity.windowsProductType, 0);
  }
});

test("other platforms do not collect or report client OS policy facts", async t => {
  const app = await appFixture(t);
  const identity = await readClientIdentity({ app, platform: "linux", osRelease: () => "6.18.0",
    getSystemVersion: () => { throw new Error("must not probe"); },
    execFile: () => { throw new Error("must not probe"); } });
  assert.equal(identity.osVersion, "6.18.0");
  assert.equal(Object.hasOwn(identity, "osProductVersion"), false);
  assert.equal(Object.hasOwn(identity, "windowsProductType"), false);
});
