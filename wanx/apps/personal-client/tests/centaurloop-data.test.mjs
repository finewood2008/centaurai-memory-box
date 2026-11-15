import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCentaurloopData } from "../applications/centaurloop-data.mjs";

const manifest = {
  applicationId: "centaurai.wanx.centaurloop", version: "0.10.4", protocolVersion: 3,
  runtime: "electron", launchMode: "shared", entrypoint: "shell/main.cjs",
  compatibility: { localDataSchema: { writeVersion: "9.0.0" } },
};
const recognized = { localDataPresent: true, localDataSchemaVersion: "1.0.0" };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "centaurloop-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = [path.join(root, "applications", ".runtime", manifest.applicationId), path.join(root, "application-data", manifest.applicationId)];
  const inspect = input => inspectCentaurloopData({ manifest, profileDirectories: profiles, ...input });
  async function file(name, value = "opaque Chromium bytes", profile = profiles[0]) {
    const target = path.join(profile, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
    return target;
  }
  return { root, profiles, inspect, file };
}

test("absent and empty CentaurLoop profiles contain no retained data", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.inspect(), { localDataPresent: false });
  await mkdir(f.profiles[0], { recursive: true });
  assert.deepEqual(await f.inspect(), { localDataPresent: false });
});

test("recognizes retained Chromium data without modifying bytes or trusting writeVersion", async t => {
  const f = await fixture(t);
  for (const name of ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Local Storage", "Session Storage", "Shared Dictionary", "blob_storage"])
    await mkdir(path.join(f.profiles[0], name), { recursive: true });
  const files = ["Preferences", "Network Persistent State", "DIPS", "SharedStorage", "Trust Tokens", "Trust Tokens-journal", "Local Storage/retained.leveldb"];
  for (const name of files) await f.file(name);
  await f.file("Preferences", "legacy runtime bytes", f.profiles[1]);
  assert.deepEqual(await f.inspect(), recognized);
  for (const name of files) assert.equal(await readFile(path.join(f.profiles[0], name), "utf8"), "opaque Chromium bytes");
  assert.equal(await readFile(path.join(f.profiles[1], "Preferences"), "utf8"), "legacy runtime bytes");
});

test("recognizes the selected local identity profile independently", async t => {
  const f = await fixture(t);
  const profile = path.join(f.root, "applications", ".runtime", "local", "a".repeat(64), manifest.applicationId);
  await f.file("Preferences", "local profile", profile);
  await f.file("unknown-business.json", "{}", f.profiles[0]);
  assert.deepEqual(await f.inspect({ profileDirectories: [profile] }), recognized);
});

test("unknown retained files in either profile prevent compatibility evidence", async t => {
  const f = await fixture(t);
  await f.file("Preferences");
  await f.file("tasks.json", "{}", f.profiles[1]);
  assert.deepEqual(await f.inspect(), { status: "unknown" });
  assert.equal(await readFile(path.join(f.profiles[1], "tasks.json"), "utf8"), "{}");
});

test("unknown business files, temporary writes and wrong entry types stay unknown", async t => {
  for (const name of ["tasks.json", "Preferences.tmp", "Cache"]) await t.test(name, async t => {
    const f = await fixture(t);
    await f.file(name);
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
  await t.test("file replaced by directory", async t => {
    const f = await fixture(t);
    await mkdir(path.join(f.profiles[0], "Preferences"), { recursive: true });
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
  await t.test("profile is a file", async t => {
    const f = await fixture(t);
    await mkdir(path.dirname(f.profiles[0]), { recursive: true });
    await writeFile(f.profiles[0], "not a directory");
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
});

test("hard-linked runtime files cannot establish data compatibility", async t => {
  const f = await fixture(t);
  const original = await f.file("Preferences");
  await link(original, path.join(f.root, "elsewhere"));
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("linked profiles and runtime entries remain unknown", { skip: process.platform === "win32" }, async t => {
  for (const name of ["", "Cache", "Preferences"]) await t.test(name || "profile", async t => {
    const f = await fixture(t);
    const target = path.join(f.root, "elsewhere");
    if (name === "Preferences") await writeFile(target, "opaque Chromium bytes");
    else await mkdir(target);
    const destination = path.join(f.profiles[0], name);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(target, destination);
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
});

test("linked profile parents cannot redirect or hide retained data", { skip: process.platform === "win32" }, async t => {
  for (const dangling of [false, true]) await t.test(String(dangling), async t => {
    const f = await fixture(t);
    const target = path.join(f.root, "elsewhere");
    if (!dangling) await f.file("Preferences", "opaque bytes", path.join(target, manifest.applicationId));
    await symlink(target, path.join(f.root, "application-data"));
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
});

test("only audited shared CentaurLoop manifests use this reader", async t => {
  const f = await fixture(t);
  await f.file("Preferences");
  for (const version of ["0.10.4", "1.0.0"])
    assert.deepEqual(await f.inspect({ manifest: { ...manifest, version } }), recognized);
  for (const override of [{ applicationId: "other.app" }, { protocolVersion: 1 }, { protocolVersion: 2 }, { protocolVersion: 4 }, { version: "0.10.3" }, { version: "1.0.1" }, { version: undefined }, { runtime: "web" }, { launchMode: "bundled" }, { entrypoint: "other.cjs" }])
    assert.equal(await f.inspect({ manifest: { ...manifest, ...override } }), null);
  assert.deepEqual(await f.inspect({ profileDirectories: [] }), { status: "unknown" });
  assert.deepEqual(await f.inspect({ profileDirectories: ["relative/profile"] }), { status: "unknown" });
});
