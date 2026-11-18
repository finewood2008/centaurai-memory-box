import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createMemoryBackup } from "../shell/memory-backup.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const rootId = "";
const json = (value, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(value)) });

test("defaults to hourly backups and preserves a saved interval", async () => {
  const scope = "test-account";
  const key = "settings:" + hash(scope);
  for (const [preferences, expected] of [[{}, 60], [{ [key]: { intervalMinutes: 5 } }, 5]]) {
    const backup = createMemoryBackup({
      client: { subscribe: () => () => {} },
      space: { snapshot: () => ({ scope, dataContextId: null }) },
      store: { load: async () => preferences },
    });
    try {
      assert.equal((await backup.action("status")).intervalMinutes, expected);
    } finally {
      await backup.close();
    }
  }
});

test("independent installations keep history, recover a selected version, and retain legacy snapshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-backup-flow-"));
  const uploads = new Map();
  const files = new Map();
  const folders = new Map();
  let createdFolders = 0;
  const devices = [];
  let corrupted = false, lostChunkReply = false, resetDownload = false, stalledDownload = false, sequence = 0;
  let interrupted, activeUploads = 0, maximumUploads = 0;

  function device(name, initial, saved, library) {
    let prefs = saved, local = initial, previous, restored, online = true, listener, clock = Date.now();
    const client = {
      subscribe(fn) { listener = fn; return () => {}; },
      async applicationConnection() {
        if (!online) throw Object.assign(new Error("offline"), { code: "NETWORK_NOT_READY" });
        return { context() {}, async request(input) {
          const url = new URL(input.path, "http://box.test");
          const [, , , collection, id, operation] = url.pathname.split("/");
          if (collection === "folders") {
            const value = JSON.parse(input.body);
            const existing = [...folders.values()].find(item => item.name === value.name);
            const entry = { id: (++createdFolders).toString(16).padStart(32, "0"), parent: "",
              name: existing ? value.name + " (1)" : value.name, kind: "folder" };
            folders.set(entry.id, entry);
            return json(entry);
          }
          if (collection === "uploads") {
            if (!id) {
              const value = JSON.parse(input.body);
              if (!uploads.has(value.id)) maximumUploads = Math.max(maximumUploads, ++activeUploads);
              const upload = uploads.get(value.id) ?? { ...value, bytes: Buffer.alloc(0) };
              uploads.set(value.id, upload);
              return json({ offset: upload.bytes.length, state: "pending" });
            }
            const upload = uploads.get(id);
            if (input.method === "GET") return json({ offset: upload.bytes.length, state: "pending" });
            if (operation === "complete") {
              assert.equal(JSON.parse(input.body).digest, hash(upload.bytes));
              const file = { ...upload, kind: "file", digest: hash(upload.bytes), modified: ++sequence };
              files.set(id, file);
              uploads.delete(id);
              activeUploads--;
              return json(file);
            }
            if (input.method === "DELETE") { uploads.delete(id); activeUploads--; return json(null, 204); }
            assert.equal(hash(input.body), input.headers["x-content-sha256"]);
            upload.bytes = Buffer.concat([upload.bytes, input.body]);
            if (interrupted === name) {
              interrupted = false;
              online = false;
              listener();
              setTimeout(() => { online = true; listener(); }, 100).unref();
              throw Object.assign(new Error("upload interrupted"), { code: "ECONNRESET" });
            }
            if (!lostChunkReply) {
              lostChunkReply = true;
              return json({ detail: { code: "SPACE_CONNECTION_TIMEOUT" } }, 503);
            }
            return json({ offset: upload.bytes.length });
          }
          if (!id) {
            const parent = url.searchParams.get("parent") || rootId;
            return json({ space_id: "personal", root: rootId, parent, breadcrumbs: parent ? [{ id: parent, name: folders.get(parent).name }] : [], items: [...folders.values(), ...files.values()].filter(item => item.parent === parent) });
          }
          assert.notEqual(input.method, "DELETE", "must never delete a completed backup");
          const file = files.get(id);
          if (!operation) return json(file);
          assert.equal(Number(url.searchParams.get("length")), 1024 * 1024);
          assert.equal(input.idleTimeoutMs, 15_000);
          assert.equal(input.freshConnection, true);
          if (resetDownload) {
            resetDownload = false;
            online = false;
            listener();
            void delay(180).then(() => { online = true; listener(); });
            throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          }
          if (stalledDownload) {
            stalledDownload = false;
            throw Object.assign(new Error("chunk stalled"), { code: "SPACE_CHUNK_STALLED" });
          }
          const bytes = corrupted ? Buffer.from("bad") : file.bytes;
          return { status: 200, body: bytes, headers: { "x-content-sha256": hash(file.bytes), etag: file.digest } };
        } };
      },
    };
    const backup = createMemoryBackup({
      client, space: { snapshot: () => ({ scope: "owner-and-box", dataContextId: online ? "connection:" + name : null }) },
      sourceBinding: async () => ({ platform: "darwin", binding: hash(name) }),
      library,
      store: { async load() { return prefs; }, async save(value) { prefs = value; } },
      protect: async () => {}, stagingRoot: path.join(root, name), intervalMs: 30, now: () => clock,
      async localRequest(route, data) {
        if (route.endsWith("/snapshot")) {
          const file = path.join(data.directory, "snapshot.sqlite");
          await writeFile(file, local);
          return { path: file };
        }
        if (data?.restoreFrom) {
          previous = local;
          local = await readFile(data.restoreFrom, "utf8");
          restored = { id: data.id, failed: false };
          return { accepted: true };
        }
        if (data?.rollback) {
          [local, previous] = [previous, local];
          restored = { id: data.id, failed: false };
          return { accepted: true };
        }
        return { result: restored, rollbackAvailable: previous !== undefined, sourceProfile: library?.id };
      },
    });
    devices.push(backup);
    return {
      status: () => backup.action("status"),
      async action(action, input) {
        return backup.action(action, { context: (await backup.action("status")).context, ...input });
      },
      local: () => local,
      prefs: () => structuredClone(prefs),
      advance(ms) { clock += ms; },
      change(value) { local = value; },
      online(value) { online = value; listener(); },
    };
  }
  async function waitFor(check) {
    const deadline = Date.now() + 3_000;
    while (!await check() && Date.now() < deadline) await delay(10);
    assert.ok(await check(), "timed out waiting for automatic backup");
  }

  const ready = async target => {
    const status = await target.status();
    return status.phase === "ready" && !status.busy;
  };
  const contents = () => [...files.values()].filter(file => file.name.endsWith(".gz"))
    .map(file => gunzipSync(file.bytes).toString()).sort();
  const restoreInput = (source, entry) => ({ sourceId: source.id, id: entry.id, digest: entry.digest });

  try {
    const first = device("first", "A initial");
    const second = device("second", "B initial");
    assert.equal((await first.status()).enabled, true);
    await waitFor(async () => await ready(first) && await ready(second));
    assert.equal([...folders.values()].filter(folder => folder.name === "半人马AI记忆备份").length, 1);
    assert.equal(new Set([...files.values()].map(file => file.parent)).size, 1);
    assert.ok(maximumUploads >= 2, "both machines uploaded concurrently");
    assert.deepEqual(contents(), ["A initial", "B initial"]);

    await first.action("backup");
    assert.equal(files.size, 2, "repeated unchanged backup is reused");

    first.online(false);
    first.change("A offline");
    assert.deepEqual(contents(), ["A initial", "B initial"]);
    interrupted = "first";
    first.online(true);
    await waitFor(async () => await ready(first) && contents().includes("A offline"));
    assert.deepEqual(contents(), ["A initial", "A offline", "B initial"]);

    await first.action("configure", { intervalMinutes: 15 });
    await assert.rejects(first.action("configure", { intervalMinutes: 0 }), /备份间隔/);
    first.change("A scheduled");
    first.advance(14 * 60_000);
    await delay(100);
    assert.equal(files.size, 3);
    first.advance(60_000);
    await waitFor(async () => await ready(first) && contents().includes("A scheduled"));

    const legacy = { id: "c".repeat(32), parent: [...folders.keys()][0], kind: "file",
      name: "半人马AI-记忆备份-" + "e".repeat(32) + "-" + "d".repeat(32) + ".sqlite",
      modified: 1, size: 6, bytes: Buffer.from("legacy") };
    legacy.digest = hash(legacy.bytes);
    files.set(legacy.id, legacy);

    await first.action("disable");
    first.change("A kept locally");
    first.online(false);
    const clone = device("different-host-with-copied-profile", "C cloned", first.prefs());
    assert.equal((await clone.status()).enabled, false, "preference survives restart");
    assert.equal((await clone.status()).intervalMinutes, 15);
    await clone.action("enable");
    await waitFor(async () => await ready(clone));

    const catalog = await second.action("catalog");
    assert.equal(catalog.sources.length, 4);
    const sourceA = catalog.sources.find(source => source.snapshots.length === 3);
    const sourceB = catalog.sources.find(source => source.current);
    const sourceLegacy = catalog.sources.find(source => source.id.startsWith("legacy-"));
    assert.ok(sourceA && sourceB && sourceLegacy);
    assert.equal(sourceLegacy.snapshots[0].id, legacy.id);
    assert.equal(sourceB.snapshots.length, 1);
    assert.equal(catalog.rollbackAvailable, false);

    const older = sourceA.snapshots.at(-1);
    const input = restoreInput(sourceA, older);
    await assert.rejects(second.action("restore", { ...input, sourceId: sourceB.id }), /快照已变化/);
    await assert.rejects(second.action("restore", { ...input, digest: "0".repeat(64) }), /快照已变化/);
    corrupted = true;
    await assert.rejects(second.action("restore", input), /SPACE_CHUNK_INVALID/);
    assert.equal(second.local(), "B initial");
    corrupted = false;
    resetDownload = stalledDownload = true;
    await second.action("restore", input);
    assert.equal(stalledDownload, false);
    assert.equal(second.local(), "A initial", "restores the selected older version");
    assert.equal(first.local(), "A kept locally");
    assert.equal((await second.action("catalog")).rollbackAvailable, true);
    await second.action("backup");
    const restoredCatalog = await second.action("catalog");
    assert.equal(restoredCatalog.sources.find(source => source.current).id, sourceB.id);
    assert.equal(restoredCatalog.sources.find(source => source.current).snapshots.length, 2);
    assert.equal(restoredCatalog.sources.find(source => source.id === sourceA.id).snapshots.length, 3);
    assert.ok(files.has(legacy.id));

    await second.action("restore", restoreInput(sourceLegacy, sourceLegacy.snapshots[0]));
    assert.equal(second.local(), "legacy");
    await second.action("disable");
    second.online(false);
    assert.equal((await second.action("catalog")).rollbackAvailable, true);
    await second.action("rollback");
    assert.equal(second.local(), "A initial");
    assert.equal((await second.status()).enabled, false, "restoring does not enable automatic backup");

    const customParent = "a".repeat(32);
    folders.set(customParent, { id: customParent, parent: "", name: "旧自选目录", kind: "folder" });
    const customLegacy = { ...legacy, parent: customParent, id: "b".repeat(32) };
    files.set(customLegacy.id, customLegacy);
    const upgraded = device("previously configured installation", "local upgrade", {
      [hash("owner-and-box")]: { parent: customParent, writer: "e".repeat(32), enabled: false },
    });
    assert.equal((await upgraded.status()).enabled, false);
    await upgraded.action("backup");
    const upgradedCatalog = await upgraded.action("catalog");
    assert.equal(upgradedCatalog.sources.find(source => source.current).snapshots.length, 1);
    assert.ok(upgradedCatalog.sources.find(source => source.id === sourceLegacy.id).snapshots.some(entry => entry.id === customLegacy.id));

    const cli = device("first", "CLI only", first.prefs(), { id: "codex-cli", name: "Codex CLI" });
    const desktop = device("first", "Desktop only", first.prefs(), { id: "codex-desktop", name: "Codex Desktop" });
    await waitFor(async () => await ready(cli) && await ready(desktop));
    const cliSources = (await cli.action("catalog")).sources;
    const desktopSources = (await desktop.action("catalog")).sources;
    assert.equal(cliSources.length, 1);
    assert.equal(desktopSources.length, 1);
    assert.equal(cliSources[0].id.replace(/-codex-cli$/, ""), desktopSources[0].id.replace(/-codex-desktop$/, ""));
    await assert.rejects(desktop.action("restore", restoreInput(cliSources[0], cliSources[0].snapshots[0])), /快照已变化/);
    cli.change("CLI after backup");
    await cli.action("restore", restoreInput(cliSources[0], cliSources[0].snapshots[0]));
    assert.equal(cli.local(), "CLI only");
    assert.equal(desktop.local(), "Desktop only");
    await cli.action("rollback");
    assert.equal(cli.local(), "CLI after backup");
    assert.equal(desktop.local(), "Desktop only");
    const mixedHistory = (await upgraded.action("catalog")).sources;
    assert.ok(mixedHistory.some(source => source.id === cliSources[0].id));
    assert.ok(mixedHistory.some(source => source.id === desktopSources[0].id));
  } finally {
    await Promise.all(devices.map(backup => backup.close()));
    if (path.dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test("large backup reconciles committed chunks after repeated lost replies and stale offsets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-backup-reconcile-"));
  const original = randomBytes(6 * 1024 * 1024);
  const parent = "a".repeat(32);
  let upload, completed, created = 0, lost = 0, conflicts = 0, statusReads = 0, largestChunk = 0;
  let staleStatus = true, preferences;
  const backup = createMemoryBackup({
    accountScope: () => "account", space: { snapshot: () => ({ scope: "box", dataContextId: "session" }) },
    sourceBinding: async () => ({ platform: "win32", binding: hash("large backup test") }),
    store: { async load() { return preferences; }, async save(value) { preferences = value; } },
    stagingRoot: root, protect: async () => {},
    client: {
      subscribe() { return () => {}; },
      async applicationConnection() {
        return { context() {}, async request(input) {
          const url = new URL(input.path, "http://box.test");
          const [, , , collection, id, operation] = url.pathname.split("/");
          if (collection === "uploads") {
            if (!id) { created++; upload ??= { ...JSON.parse(input.body), bytes: Buffer.alloc(0) }; return json({ offset: upload.bytes.length }); }
            if (input.method === "GET") {
              statusReads++;
              if (staleStatus) { staleStatus = false; return json({ offset: 0 }); }
              return json({ offset: upload.bytes.length });
            }
            if (operation === "complete") {
              assert.equal(JSON.parse(input.body).digest, hash(upload.bytes));
              completed = { ...upload, kind: "file", digest: hash(upload.bytes), modified: 1 };
              return json(completed);
            }
            if (input.method === "DELETE") return json(null, 204);
            const offset = Number(url.searchParams.get("offset"));
            if (offset !== upload.bytes.length) { conflicts++; return json({ detail: { code: "SPACE_UPLOAD_OFFSET" } }, 409); }
            assert.equal(input.headers["x-content-sha256"], hash(input.body));
            largestChunk = Math.max(largestChunk, input.body.length);
            upload.bytes = Buffer.concat([upload.bytes, input.body]);
            if (lost++ < 6) {
              if (lost === 1) throw Object.assign(new Error("chunk stalled"), { code: "SPACE_CHUNK_STALLED" });
              return json({ detail: { code: "SPACE_CONNECTION_TIMEOUT" } }, 503);
            }
            return json({ offset: upload.bytes.length });
          }
          const selected = url.searchParams.get("parent") || "";
          return json({ space_id: "personal", root: "", parent: selected,
            breadcrumbs: selected ? [{ id: parent, name: "半人马AI记忆备份" }] : [],
            items: selected ? [] : [{ id: parent, parent: "", name: "半人马AI记忆备份", kind: "folder" }] });
        } };
      },
    },
    async localRequest(_route, data) {
      const file = path.join(data.directory, "memory.sqlite");
      await writeFile(file, original);
      return { path: file };
    },
  });
  try {
    const deadline = Date.now() + 15_000;
    while ((await backup.action("status")).phase !== "ready" && Date.now() < deadline) await delay(20);
    assert.equal((await backup.action("status")).phase, "ready");
    assert.equal(created, 1, "resume a single upload instead of recreating the whole backup");
    assert.ok(lost >= 6 && statusReads >= 7 && conflicts === 1);
    assert.equal(largestChunk, 1024 * 1024);
    assert.deepEqual(gunzipSync(completed.bytes), original);
  } finally {
    await backup.close();
    if (path.dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});
