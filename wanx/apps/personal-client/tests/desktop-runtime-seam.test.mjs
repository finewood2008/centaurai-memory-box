import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { prepareDesktopRuntime, resolveDesktopApplication } from "../tools/start-desktop.mjs";
import { nativeBinaryPaths } from "../shell/native-binaries.mjs";
import { prepareClientBuild } from "../../builder/tools/client-build-directory.mjs";

test("macOS development bundle presents MemoBox while preserving Electron and account identity", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-desktop-seam-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "electron/Electron.app");
  await mkdir(path.join(source, "Contents/MacOS"), { recursive: true });
  await mkdir(path.join(source, "Contents/Resources"));
  const electronPath = path.join(source, "Contents/MacOS/Electron");
  await writeFile(electronPath, "native runtime fixture");
  const originalPlist = JSON.stringify({ CFBundleName: "Electron", CFBundleDisplayName: "Electron", CFBundleExecutable: "Electron", CFBundleVersion: "37.10.3" });
  await writeFile(path.join(source, "Contents/Info.plist"), originalPlist);
  const config = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packageText = JSON.stringify(config);
  await writeFile(path.join(root, "package.json"), packageText);
  await mkdir(path.join(root, "resources"));
  const icon = await readFile(new URL("../resources/icon.icns", import.meta.url));
  await writeFile(path.join(root, config.build.mac.icon), icon);
  const signed = [];
  const options = { root, electronPath, sign: (bundle) => signed.push(bundle) };
  const executable = await prepareDesktopRuntime(options);
  const bundle = path.join(root, "release/dev", `${config.build.productName}.app`);
  assert.equal(executable, path.join(bundle, "Contents/MacOS/Electron"));
  const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Contents/Info.plist")], { encoding: "utf8" }));
  assert.equal(plist.CFBundleDisplayName, "半人马AI-记忆盒子");
  assert.equal(plist.CFBundleName, "半人马AI-记忆盒子");
  assert.equal(plist.CFBundleIdentifier, config.build.appId);
  assert.equal(plist.NSBluetoothAlwaysUsageDescription, config.build.mac.extendInfo.NSBluetoothAlwaysUsageDescription);
  assert.deepEqual(await readFile(path.join(bundle, "Contents/Resources", plist.CFBundleIconFile)), icon);
  assert.equal(await readFile(path.join(source, "Contents/Info.plist"), "utf8"), originalPlist);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), packageText);
  assert.equal(config.name, "centuarai-wanx-client");
  assert.equal(await prepareDesktopRuntime(options), executable);
  assert.equal(signed.length, 1, "unchanged launches reuse the signed runtime");
  await writeFile(path.join(root, config.build.mac.icon), Buffer.concat([icon, Buffer.from("updated")]));
  await assert.rejects(prepareDesktopRuntime({ ...options, sign() { throw new Error("signing failed"); } }), /signing failed/);
  await prepareDesktopRuntime(options);
  assert.equal(signed.length, 2, "an icon change refreshes the bundle and a failed signing is retryable");
});

test("non-macOS development keeps the supplied runtime without touching a bundle", async () => {
  const executable = path.join("runtime", "electron.exe");
  assert.equal(await prepareDesktopRuntime({ platform: "win32", electronPath: executable, root: "unused" }), executable);
});

test("development startup requires the assembled app and never falls back to source", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-development-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "shell"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ main: "shell/entry.mjs" }));
  await writeFile(path.join(root, "shell/entry.mjs"), "// source entry");
  await assert.rejects(resolveDesktopApplication(root), /CLIENT_BUILD_REQUIRED/);
  const application = path.join(root, "build/app");
  await mkdir(path.join(application, "shell"), { recursive: true });
  await writeFile(path.join(application, "package.json"), JSON.stringify({ main: "shell/entry.mjs" }));
  await assert.rejects(resolveDesktopApplication(root), /CLIENT_BUILD_REQUIRED/);
  await writeFile(path.join(application, "shell/entry.mjs"), "// assembled entry");
  assert.equal(await resolveDesktopApplication(root), application);
});

test("development network helpers remain available after rebuilding the app", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-development-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, ".gitignore"), "/build/\n/native/bin/\n");
  const appPath = path.join(root, "build/app");
  const source = path.join(root, "native/bin");
  const oldRuntime = path.join(appPath, "native/bin");
  const helpers = ["wanx-netbird-darwin-arm64", "wanx-discovery-darwin-arm64"];
  for (const directory of [source, oldRuntime]) {
    await mkdir(directory, { recursive: true });
    for (const helper of helpers) await writeFile(path.join(directory, helper), helper);
  }
  const paths = nativeBinaryPaths({ appPath, resourcesPath: path.join(root, "electron/Resources"),
    packaged: false, platform: "darwin", arch: "arm64" });
  await prepareClientBuild(root, { edition: "personal", dependencies: false });
  await assert.rejects(readFile(path.join(oldRuntime, helpers[0])), { code: "ENOENT" });
  assert.deepEqual(await Promise.all(Object.values(paths).map(file => readFile(file, "utf8"))), helpers);
});
