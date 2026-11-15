import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectAiBrowserData } from "../applications/ai-browser-data.mjs";

const manifest = {
  applicationId: "centaurai.wanx.ai-browser", protocolVersion: 3,
  runtime: "electron", launchMode: "shared", entrypoint: "shell/main.mjs",
  compatibility: { localDataSchema: { writeVersion: "9.0.0" } },
};
const threadScope = JSON.stringify(["box-a", 42, "agent-a"]);
const learningScope = JSON.stringify(["box-a", 42]);
const threads = { [threadScope]: { thread_id: "thread-a" } };
const learning = { [learningScope]: {
  recordingId: "learn_" + "a".repeat(32), name: "填写表单", goal: "完成演示表单", agentId: "agent-a",
} };
const recognized = { localDataPresent: true, localDataSchemaVersion: "1.0.0" };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-browser-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = [path.join(root, "applications", ".runtime", manifest.applicationId), path.join(root, "application-data", manifest.applicationId)];
  const inspect = input => inspectAiBrowserData({ manifest, profileDirectories: profiles, ...input });
  async function file(name, value, profile = profiles[0]) {
    const target = path.join(profile, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
    return target;
  }
  return { root, profiles, inspect, file };
}

test("absent and empty browser profiles contain no retained data", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.inspect(), { localDataPresent: false });
  await mkdir(f.profiles[0], { recursive: true });
  assert.deepEqual(await f.inspect(), { localDataPresent: false });
});

test("recognizes actual thread and learning registries without changing bytes or trusting writeVersion", async t => {
  const f = await fixture(t);
  const threadBytes = JSON.stringify(threads, null, 2) + "\n";
  const learningBytes = JSON.stringify(learning, null, 2) + "\n";
  const first = await f.file("threads.json", threadBytes);
  const second = await f.file("learning.json", learningBytes, f.profiles[1]);
  assert.deepEqual(await f.inspect(), recognized);
  assert.equal(await readFile(first, "utf8"), threadBytes);
  assert.equal(await readFile(second, "utf8"), learningBytes);
  await f.file("threads.json", {}, f.profiles[1]);
  assert.deepEqual(await f.inspect(), recognized);
});

test("local identity profile uses the same audited data layout", async t => {
  const f = await fixture(t);
  const profile = path.join(f.root, "applications", ".runtime", "local", "b".repeat(64), manifest.applicationId);
  await f.file("threads.json", threads, profile);
  assert.deepEqual(await f.inspect({ profileDirectories: [profile] }), recognized);
});

test("Chromium-only browser data remains present and readable, including DIPS and sidebar storage", async t => {
  const f = await fixture(t);
  for (const name of ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Local Storage", "Session Storage", "Shared Dictionary", "blob_storage"])
    await mkdir(path.join(f.profiles[0], name), { recursive: true });
  const entries = ["DIPS", "Network Persistent State", "Preferences", "SharedStorage", "Trust Tokens", "Trust Tokens-journal", "Local Storage/sidebar.leveldb"];
  for (const name of entries) await f.file(name, "opaque runtime bytes");
  assert.deepEqual(await f.inspect(), recognized);
  for (const name of entries) assert.equal(await readFile(path.join(f.profiles[0], name), "utf8"), "opaque runtime bytes");
});

test("all retained profiles must be understood even when current threads are readable", async t => {
  const f = await fixture(t);
  await f.file("threads.json", threads);
  await f.file("future-data.json", {}, f.profiles[1]);
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("unknown files, temporary writes and malformed registries cannot establish data compatibility", async t => {
  const cases = [
    ["future.json", {}], ["threads.json.tmp", threads], ["learning.json.tmp", learning],
    ["threads.json", "{broken"], ["threads.json", null], ["threads.json", []],
    ["threads.json", { schemaVersion: 2, threads }],
    ["threads.json", { not_a_scope: { thread_id: "thread-a" } }],
    ["threads.json", { [JSON.stringify(["box-a", 42])]: { thread_id: "thread-a" } }],
    ["threads.json", { [JSON.stringify(["box-a", {}, "agent-a"])]: { thread_id: "thread-a" } }],
    ["threads.json", { [threadScope]: { thread_id: 7 } }],
    ["threads.json", { [threadScope]: { thread_id: "thread-a", future: true } }],
    ["learning.json", "{broken"], ["learning.json", []],
    ["learning.json", { [learningScope]: { ...learning[learningScope], recordingId: "invalid" } }],
    ["learning.json", { [learningScope]: { ...learning[learningScope], agentId: null } }],
    ["learning.json", { [learningScope]: { ...learning[learningScope], name: "" } }],
    ["learning.json", { [learningScope]: { ...learning[learningScope], name: "n".repeat(81) } }],
    ["learning.json", { [learningScope]: { ...learning[learningScope], goal: "g".repeat(241) } }],
    ["learning.json", { [learningScope]: { ...learning[learningScope], schemaVersion: 2 } }],
  ];
  for (const [index, [name, value]] of cases.entries()) await t.test(String(index), async t => {
    const f = await fixture(t);
    await f.file(name, value);
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
});

test("oversized registries and non-directory profiles stay unknown", async t => {
  const f = await fixture(t);
  await f.file("threads.json", " ".repeat(1024 * 1024 + 1));
  assert.deepEqual(await f.inspect(), { status: "unknown" });
  await rm(f.profiles[0], { recursive: true });
  await writeFile(f.profiles[0], "not a directory");
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("hard-linked business files do not establish schema evidence", async t => {
  const f = await fixture(t);
  const original = await f.file("threads.json", threads);
  await link(original, path.join(f.root, "elsewhere.json"));
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("linked profiles, business files and Chromium entries remain unknown", { skip: process.platform === "win32" }, async t => {
  for (const name of ["", "threads.json", "Cache", "Preferences", "DIPS"]) await t.test(name || "profile", async t => {
    const f = await fixture(t);
    const target = path.join(f.root, "elsewhere");
    if (!name || name === "Cache") await mkdir(target);
    else await writeFile(target, JSON.stringify(threads));
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
    if (!dangling) await f.file("threads.json", threads, path.join(target, manifest.applicationId));
    await symlink(target, path.join(f.root, "application-data"));
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
});

test("only the audited shared browser manifest can use this reader", async t => {
  const f = await fixture(t);
  await f.file("threads.json", threads);
  for (const override of [{ applicationId: "other.app" }, { protocolVersion: 1 }, { protocolVersion: 4 }, { runtime: "web" }, { launchMode: "bundled" }, { entrypoint: "other.mjs" }])
    assert.equal(await f.inspect({ manifest: { ...manifest, ...override } }), null);
  assert.deepEqual(await f.inspect({ profileDirectories: [] }), { status: "unknown" });
});
