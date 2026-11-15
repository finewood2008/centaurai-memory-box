import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("automatically updates one backup and restores verified data on a clean installation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-backup-flow-"));
  const uploads = new Map();
  const files = new Map();
  const folders = new Map();
  let createdFolders = 0;
  const devices = [];
  let corrupted = false, lostChunkReply = false, resetDownload = false, sequence = 0;

  function device(name, initial, saved) {
    let prefs = saved, local = initial, restored, online = true, listener, clock = Date.now();
    const client = {
      subscribe(fn) { listener = fn; return () => {}; },
      async applicationConnection() {
        return { context() {}, async request(input) {
          const url = new URL(input.path, "http://box.test");
          const [, , , collection, id, operation] = url.pathname.split("/");
          if (collection === "folders") {
            const value = JSON.parse(input.body);
            const existing = [...folders.values()].find(item => item.name === value.name);
            if (existing) return json({ detail: { code: "SPACE_NAME_CONFLICT" } }, 409);
            const entry = { id: (++createdFolders).toString(16).padStart(32, "0"), parent: "", name: value.name, kind: "folder" };
            folders.set(entry.id, entry);
            return json(entry);
          }
          if (collection === "uploads") {
            if (!id) {
              const value = JSON.parse(input.body);
              const upload = uploads.get(value.id) ?? { ...value, bytes: Buffer.alloc(0) };
              uploads.set(value.id, upload);
              return json({ offset: upload.bytes.length, state: "pending" });
            }
            const upload = uploads.get(id);
            if (operation === "complete") {
              assert.equal(JSON.parse(input.body).digest, hash(upload.bytes));
              const file = { ...upload, kind: "file", digest: hash(upload.bytes), modified: ++sequence };
              files.set(id, file);
              uploads.delete(id);
              return json(file);
            }
            assert.equal(hash(input.body), input.headers["x-content-sha256"]);
            upload.bytes = Buffer.concat([upload.bytes, input.body]);
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
          if (input.method === "DELETE") { files.delete(id); return json(null, 204); }
          const file = files.get(id);
          if (!operation) return json(file);
          if (resetDownload) {
            resetDownload = false;
            online = false;
            listener();
            void delay(180).then(() => { online = true; listener(); });
            throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          }
          const bytes = corrupted ? Buffer.from("bad") : file.bytes;
          return { status: 200, body: bytes, headers: { "x-content-sha256": hash(file.bytes), etag: file.digest } };
        } };
      },
    };
    const backup = createMemoryBackup({
      client, space: { snapshot: () => ({ scope: "owner-and-box", dataContextId: online ? "connection:" + name : null }) },
      store: { async load() { return prefs; }, async save(value) { prefs = value; } },
      protect: async () => {}, stagingRoot: path.join(root, name), intervalMs: 30, now: () => clock,
      async localRequest(route, data) {
        if (route.endsWith("/snapshot")) {
          const file = path.join(data.directory, "snapshot.sqlite");
          await writeFile(file, local);
          return { path: file };
        }
        if (data?.restoreFrom) {
          local = await readFile(data.restoreFrom, "utf8");
          restored = { id: data.id, failed: false };
          return { accepted: true };
        }
        return { result: restored };
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

  try {
    const first = device("first", "original memory");
    assert.equal((await first.status()).enabled, true, "enabled by default without a picker");
    await waitFor(() => files.size === 1);
    await waitFor(async () => { const status = await first.status(); return status.phase === "ready" && !status.busy; });
    assert.equal(createdFolders, 1);
    assert.equal([...folders.values()][0].name, "半人马AI记忆备份");
    first.online(false);
    first.change("new memory written offline");
    assert.equal(files.size, 1);
    first.online(true);
    await waitFor(() => files.size === 1 && gunzipSync([...files.values()][0].bytes).toString() === "new memory written offline");
    await waitFor(async () => { const status = await first.status(); return status.phase === "ready" && !status.busy; });
    await first.action("configure", { intervalMinutes: 15 });
    assert.equal((await first.status()).intervalMinutes, 15);
    await assert.rejects(first.action("configure", { intervalMinutes: 0 }), /备份间隔/);
    await assert.rejects(first.action("configure", { intervalMinutes: 1441 }), /备份间隔/);
    first.change("scheduled memory");
    first.advance(14 * 60_000);
    await delay(100);
    assert.equal(gunzipSync([...files.values()][0].bytes).toString(), "new memory written offline");
    first.advance(60_000);
    await waitFor(() => gunzipSync([...files.values()][0].bytes).toString() === "scheduled memory");
    await waitFor(async () => { const status = await first.status(); return status.phase === "ready" && !status.busy; });
    await first.action("disable");
    const disabledDigest = [...files.values()][0].digest;
    first.change("must not upload while disabled");
    first.online(false);
    first.online(true);
    await delay(100);
    assert.equal([...files.values()][0].digest, disabledDigest);
    assert.equal((await first.status()).enabled, false);
    first.online(false);

    const optedOut = device("opted-out", "private", first.prefs());
    await delay(100);
    assert.equal((await optedOut.status()).enabled, false, "explicit opt-out survives restart");
    assert.equal((await optedOut.status()).intervalMinutes, 15, "configured interval survives restart");
    assert.equal([...files.values()][0].digest, disabledDigest);
    optedOut.online(false);

    const second = device("second", "blank local library");
    await waitFor(async () => (await second.status()).phase === "restore-available");
    assert.equal(createdFolders, 1, "reuse the managed directory on another computer");
    assert.equal([...files.values()][0].digest, disabledDigest, "empty computer must not overwrite backup");
    const existing = (await second.status()).availableBackup;
    await assert.rejects(second.action("restore", { id: "f".repeat(32) }), /备份列表已变化/);
    corrupted = true;
    await assert.rejects(second.action("restore", { id: existing.id }), /SPACE_CHUNK_INVALID/);
    assert.equal(second.local(), "blank local library");
    corrupted = false;
    resetDownload = true;
    await second.action("restore", { id: existing.id });
    assert.equal(second.local(), "scheduled memory");
    assert.equal((await second.status()).enabled, true);
    await second.action("disable");
    second.online(false);
    await second.action("enable");
    assert.equal((await second.status()).enabled, true, "preference can change offline");
  } finally {
    await Promise.all(devices.map(backup => backup.close()));
    if (path.dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});
