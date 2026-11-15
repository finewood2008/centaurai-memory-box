import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMyAiMemoryTransfer, inspectMemoryBundle } from "../shell/my-ai-memory-transfer.mjs";

const bundle = (ids = ["test-memory"]) => ({ schemaVersion: 2, exportedAt: "2026-11-15T00:00:00Z",
  manifest: { service: "memmy-memory-service", tables: ["memories", "memory_vectors"] },
  tables: { memories: ids.map(id => ({ id, content: "Synthetic memory only" })), memory_vectors: [] } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "memobox-transfer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeFile = path.join(directory, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:3456", localToken: "synthetic-token" }));
  const input = path.join(directory, "input.json");
  const output = path.join(directory, "export.json");
  await writeFile(input, JSON.stringify(bundle()));
  let scope = "Alice/BoxA/session1", identity = "Alice/BoxA";
  let records = ["existing-memory"], restoreResult, rejectSnapshot = false;
  const calls = [];
  let chosen = input;
  const options = { directory, runtimeFile, scope: () => scope, identity: () => identity,
    chooseImportFile: async () => chosen, saveExportFile: async () => output,
    request: async (url, init) => {
      const data = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, body: data });
      assert.equal(init.headers["x-memmy-local-token"], "synthetic-token");
      assert.equal(init.headers["x-memmy-viewer"], undefined);
      if (url.pathname === "/api/local-data/bundle") return Response.json(bundle(records));
      if (url.pathname === "/api/local-data/bundle/import") {
        assert.equal(data.conflictStrategy, "skip");
        let inserted = 0, skipped = 0;
        for (const { id } of data.bundle.tables.memories) {
          if (records.includes(id)) skipped++;
          else { records.push(id); inserted++; }
        }
        return Response.json({ ok: true, inserted: { memories: inserted }, skipped: { memories: skipped } });
      }
      if (url.pathname.endsWith("/snapshot")) {
        if (rejectSnapshot) return Response.json({ error: { message: "snapshot unavailable" } }, { status: 409 });
        const file = path.join(directory, "snapshot-" + calls.length + ".sqlite");
        await writeFile(file, JSON.stringify(records));
        return Response.json({ path: file });
      }
      if (url.pathname === "/api/local-data/wanx-storage") {
        if (data) {
          records = JSON.parse(await readFile(data.restoreFrom, "utf8"));
          restoreResult = { id: data.id, failed: false };
          return Response.json({ accepted: true });
        }
        return Response.json({ result: restoreResult });
      }
      throw new Error("Unexpected synthetic route");
    } };
  return { directory, input, output, calls, transfer: createMyAiMemoryTransfer(options),
    reopen: () => createMyAiMemoryTransfer(options), records: () => records,
    setScope(value) { scope = value; }, setIdentity(value) { identity = value; },
    setChosen(value) { chosen = value; }, rejectSnapshot() { rejectSnapshot = true; } };
}

test("memory bundle preview cannot mutate, import skips duplicates and verified snapshot rollback removes new rows", async t => {
  const h = await fixture(t);
  const preview = await h.transfer.action("preview");
  assert.equal(preview.rows, 1);
  assert.deepEqual(h.records(), ["existing-memory"]);
  assert.ok(h.calls.every(call => call.path === "/api/local-data/bundle"));
  const first = await h.transfer.action("import", { previewId: preview.previewId });
  assert.equal(first.inserted.memories, 1);
  assert.equal((await h.transfer.action("status")).rollbackAvailable, true);
  const rollback = h.reopen();
  await assert.rejects(rollback.action("rollback"), /确认/);
  assert.deepEqual(await rollback.action("rollback", { confirm: true }), { restoring: true, rollbackAvailable: false });
  assert.deepEqual(await rollback.action("status"), { rollbackAvailable: false, restored: true });
  assert.deepEqual(h.records(), ["existing-memory"]);
  const next = await h.transfer.action("preview");
  await h.transfer.action("import", { previewId: next.previewId });
  const duplicate = await h.transfer.action("preview");
  const result = await h.transfer.action("import", { previewId: duplicate.previewId });
  assert.equal(result.inserted.memories, 0);
  assert.equal(result.skipped.memories, 1);
});

test("pending import is invalid after file, account, or connection changes", async t => {
  const h = await fixture(t);
  let preview = await h.transfer.action("preview");
  await writeFile(h.input, JSON.stringify(bundle(["modified"])));
  await assert.rejects(h.transfer.action("import", { previewId: preview.previewId }), /变化/);
  preview = await h.transfer.action("preview");
  h.setScope("Alice/BoxA/session2");
  await assert.rejects(h.transfer.action("import", { previewId: preview.previewId }), /失效/);
  preview = await h.transfer.action("preview");
  h.setIdentity("Bob/BoxB");
  await assert.rejects(h.transfer.action("import", { previewId: preview.previewId }), /失效/);
  assert.deepEqual(h.records(), ["existing-memory"]);
  assert.equal((await h.transfer.action("status")).rollbackAvailable, false);
});

test("invalid, newer, unknown-table, symbolic-link and canceled inputs do not reach import", async t => {
  const h = await fixture(t);
  for (const value of ["not JSON", JSON.stringify({ tables: {} }), JSON.stringify({ ...bundle(), schemaVersion: 999 }),
    JSON.stringify({ ...bundle(), tables: { credentials: [{ token: "fake" }] } })]) {
    await writeFile(h.input, value);
    await assert.rejects(h.transfer.action("preview"));
  }
  const link = path.join(h.directory, "link.json");
  await symlink(h.input, link); h.setChosen(link);
  await assert.rejects(h.transfer.action("preview"), /不可读取/);
  h.setChosen(null);
  assert.deepEqual(await h.transfer.action("preview"), { canceled: true });
  assert.ok(h.calls.every(call => call.path === "/api/local-data/bundle"));
});

test("snapshot failure stops import and export writes only the selected JSON file", async t => {
  const h = await fixture(t);
  const preview = await h.transfer.action("preview");
  h.rejectSnapshot();
  await assert.rejects(h.transfer.action("import", { previewId: preview.previewId }), /snapshot unavailable/);
  assert.ok(!h.calls.some(call => call.path === "/api/local-data/bundle/import"));
  const exported = await h.transfer.action("export");
  assert.equal(exported.path, h.output);
  assert.deepEqual(JSON.parse(await readFile(h.output, "utf8")).tables.memories.map(row => row.id), ["existing-memory"]);
});

test("bundle validation rejects arrays used as records", () => {
  assert.throws(() => inspectMemoryBundle({ ...bundle(), tables: { memories: [[]] } }, bundle()), /格式/);
});
