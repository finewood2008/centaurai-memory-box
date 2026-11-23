import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { requiredRuntimeFiles } from "../../../tools/stage-local-memory.mjs";
import {
  assertPackagedMemoryTarget,
  packagedMemoryResources,
  preparePackagedMemory,
  verifyPackagedMemoryLayout,
} from "../tools/package-client-memory.mjs";

const darwinOrWindows = ["darwin", "win32"].includes(process.platform);
const target = { platform: process.platform, arch: process.arch };

test("managed release build ignores local-only overrides and copies root dependencies explicitly", {
  skip: !darwinOrWindows && "native client packaging is limited to macOS and Windows",
}, async () => {
  const clientRoot = path.resolve("sample/client");
  const runtime = path.join(clientRoot, "build", "local-memory");
  const output = path.join(clientRoot, "build", "app", "local-ui", "memory");
  const env = { WANX_MEMORY_BOX_ROOT: "/external/source", MEMMY_RUNTIME_CONFIG_PATH: "/external/runtime.json" };
  const result = await preparePackagedMemory({
    clientRoot, env,
    build: options => {
      assert.deepEqual(options, { clientRoot, env: {} });
      return { runtime, output };
    },
    probe: options => {
      assert.deepEqual(options, { runtime, clientRoot, env: {} });
      return { ...target, ok: true };
    },
  });
  assert.deepEqual(result, { runtime, output, extraResources: [
    { from: runtime, to: "local-memory" },
    { from: path.join(runtime, "node_modules"), to: "local-memory/node_modules" },
  ] });
  assert.deepEqual(result.extraResources, packagedMemoryResources(clientRoot));
  assert.equal(env.WANX_MEMORY_BOX_ROOT, "/external/source");
});

test("native release guard rejects another architecture or platform", () => {
  const otherArch = process.arch === "arm64" ? "x64" : "arm64";
  const otherPlatform = process.platform === "win32" ? "darwin" : "win32";
  assert.throws(() => assertPackagedMemoryTarget({ ...target, arch: otherArch }), /CLIENT_MEMORY_TARGET_HOST_MISMATCH/);
  assert.throws(() => assertPackagedMemoryTarget({ ...target, platform: otherPlatform }), /CLIENT_MEMORY_TARGET_HOST_MISMATCH/);
});

test("a runtime prepared with the wrong Electron architecture cannot be packaged", {
  skip: !darwinOrWindows && "native client packaging is limited to macOS and Windows",
}, async () => {
  await assert.rejects(preparePackagedMemory({
    clientRoot: "/fixture",
    build: () => ({ runtime: "/fixture/build/local-memory" }),
    probe: () => ({ ...target, ok: true, arch: process.arch === "arm64" ? "x64" : "arm64" }),
  }), /CLIENT_MEMORY_NATIVE_SMOKE_FAILED/);
});

async function fixture(t, { css = true, native = true, acl = true, sqlitePath = true, worker = true, drive = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-memory-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "resources");
  const app = path.join(root, "app"), frontend = path.join(app, "local-ui", "memory");
  const runtime = path.join(resourcesPath, "local-memory");
  const nativeModules = [
    "node_modules/better-sqlite3",
    "Memory/AgentSourceReaders/node_modules/better-sqlite3",
  ];
  const put = async (dir, file, contents = "{}") => {
    const absolute = path.join(dir, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  };
  await put(frontend, "wanx-memory.html",
    '<script src="./assets/entry.js"></script><link rel="stylesheet" href="./assets/page.css">');
  await put(frontend, "assets/entry.js");
  if (css) await put(frontend, "assets/page.css");
  if (worker) await put(app, "shell/local-memory-worker.mjs");
  if (drive) await put(app, "host-sdk/drive.cjs");
  else await put(resourcesPath, "accessory-host/drive.cjs");
  for (const name of ["package.json", ...requiredRuntimeFiles]) await put(runtime, name);
  await put(runtime, "runtime-manifest.json", JSON.stringify({
    schemaVersion: 1, nativeModules: sqlitePath ? nativeModules : ["../better-sqlite3"],
  }));
  if (native) for (const name of nativeModules) await put(runtime, name + "/package.json");
  if (acl) await put(resourcesPath, "security/windows-private-acl.ps1");
  await createPackage(app, path.join(resourcesPath, "app.asar"));
  return { resourcesPath, runtime };
}

test("both package layouts include the compiled frontend and every recorded SQLite package", async t => {
  const { resourcesPath, runtime } = await fixture(t);
  for (const platform of ["darwin", "win32"])
    assert.equal(await verifyPackagedMemoryLayout({ resourcesPath, platform }), runtime);
});

test("packaging rejects missing assets, worker, native packages and Windows private ACL script", async t => {
  for (const [options, error] of [
    [{ css: false }, /CLIENT_MEMORY_FRONTEND_MISSING/],
    [{ worker: false }, /CLIENT_MEMORY_WORKER_MISSING/],
    [{ drive: false }, /CLIENT_MEMORY_BACKUP_SDK_MISSING:host-sdk\/drive\.cjs/],
    [{ native: false }, /CLIENT_MEMORY_RESOURCE_MISSING:node_modules\/better-sqlite3\/package.json/],
    [{ acl: false }, /CLIENT_MEMORY_RESOURCE_MISSING:security\/windows-private-acl.ps1/],
    [{ sqlitePath: false }, /CLIENT_MEMORY_NATIVE_MANIFEST_INVALID/],
  ]) {
    const { resourcesPath } = await fixture(t, options);
    await assert.rejects(verifyPackagedMemoryLayout({ resourcesPath, platform: "win32" }), error);
  }
});
