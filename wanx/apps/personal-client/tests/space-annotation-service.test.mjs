import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPersonalSpace } from "../shell/personal-space.mjs";
import { createCodexContextSources } from "../shell/codex-context-sources.mjs";
import { createStarlinkSpaceAnnotations } from "../../builder/integration/personal-client/starlink-space-annotations.mjs";

const id = char => char.repeat(32), folder = id("a"), file = id("b"), child = id("c");
const digest = text => createHash("sha256").update(text).digest("hex");
const warehouse = "12345678-1234-1234-1234-123456789abc";
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "memobox-annotations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let state = { phase: "ready", account: { phase: "authenticated", accountId: "synthetic-owner" }, connection: { deviceId: "synthetic-box" } };
  const listeners = new Set(), entries = new Map(), bodies = new Map(), calls = [], uploads = new Map();
  let before, after, savedTransfers = [];
  const put = (entry, text) => { if (text !== undefined) { bodies.set(entry.id, text); entry = { ...entry, digest: digest(text), size: Buffer.byteLength(text) }; } entries.set(entry.id, { space_id: "personal", version: 1, ...entry }); };
  put({ id: folder, name: "项目资料", parent: "", kind: "folder" });
  put({ id: file, name: "notes.txt", parent: folder, kind: "file" }, "仅供测试的原始正文，不含检索标签。\n");
  put({ id: child, name: "nested", parent: folder, kind: "folder" });
  const client = { snapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async applicationConnection() {
    const captured = JSON.stringify(state);
    const context = () => { if (JSON.stringify(state) !== captured || state.phase !== "ready") throw Object.assign(Error("SPACE_CONTEXT_CHANGED"), { code: "SPACE_CONTEXT_CHANGED" }); return { writable: state.connection.writable }; };
    return { context, async request(input) {
      context(); calls.push(input); await before?.(input); context();
      const url = new URL(input.path, "https://synthetic.invalid"), parts = url.pathname.split("/").slice(3);
      let value, bytes;
      if (parts[0] === "uploads") {
        if (parts.length === 1) { const body = JSON.parse(input.body); if (!uploads.has(body.id)) uploads.set(body.id, { ...body, offset: 0, state: "pending", bytes: Buffer.alloc(0) }); value = uploads.get(body.id); }
        else {
          const upload = uploads.get(parts[1]);
          if (parts[2] === "complete") { assert.equal(digest(upload.bytes), JSON.parse(input.body).digest); upload.state = "complete"; put({ id: upload.id, parent: upload.parent, name: upload.name, kind: "file" }, upload.bytes.toString("utf8")); value = { id: upload.id }; }
          else { upload.bytes = Buffer.concat([upload.bytes, input.body]); upload.offset += input.body.length; value = { offset: upload.offset }; }
        }
      }
      else if (parts[0] === "overview") value = { protocolVersion: 1 };
      else if (parts[0] === "files" && parts.length === 1) {
        const parent = url.searchParams.get("parent") || "", breadcrumbs = [];
        for (let current = entries.get(parent); current; current = entries.get(current.parent)) breadcrumbs.unshift({ id: current.id, name: current.name });
        value = { space_id: "personal", parent, root: "", breadcrumbs, items: [...entries.values()].filter(entry => entry.parent === parent && entry.trashed == null) };
      } else if (parts[0] === "files") {
        const entry = entries.get(parts[1]);
        if (!entry) return { status: 404, headers: {}, body: Buffer.from(JSON.stringify({ error: { code: "SPACE_NOT_FOUND" } })) };
        if (parts[2] === "content") bytes = Buffer.from(bodies.get(entry.id));
        else value = entry;
      } else throw Error("unexpected synthetic route " + input.path);
      await after?.(input);
      return { status: 200, headers: bytes ? { "x-content-sha256": digest(bytes) } : {}, body: bytes || Buffer.from(JSON.stringify(value)) };
    } };
  } };
  const storePath = path.join(directory, "synthetic-store.json");
  const annotationStore = { async load() { try { return JSON.parse(await readFile(storePath, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }, async save(value) { await writeFile(storePath, JSON.stringify(value)); } };
  // The production entry injects the OS encrypted store. This synthetic store
  // deliberately contains only fabricated fixtures, so restart is observable.
  const options = { client, serviceURL: "https://synthetic.invalid", annotationStore, store: { load: async () => structuredClone(savedTransfers), save: async value => { savedTransfers = structuredClone(value); } } };
  let service = await createPersonalSpace(options);
  t.after(() => service.close());
  return { entries, bodies, put, calls, directory, get service() { return service; },
    async restart() { await service.close(); service = await createPersonalSpace(options); },
    switch(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(); },
    before(fn) { before = fn; }, after(fn) { after = fn; } };
}

test("actual PersonalSpace operations persist automatic/manual annotations and inherited recall across restart", async t => {
  const f = await fixture(t);
  const page = await f.service.operation("list", { parent: folder });
  assert.ok(page.items.find(row => row.id === file).annotation.tags.includes("项目"));
  const prior = await f.service.operation("annotation", { id: folder });
  await f.service.operation("set-annotation", { id: folder, expectedRevision: prior.revision, tags: ["合成空间专用标签"], description: "合成项目说明", reviewed: true });
  const own = await f.service.operation("annotation", { id: file });
  await f.service.operation("set-annotation", { id: file, expectedRevision: own.revision, tags: ["独立召回词"], description: "人工说明", reviewed: true });
  await f.restart();
  const found = await f.service.operation("search-annotations", { parent: folder, query: "合成空间专用标签" });
  assert.ok(found.items.some(row => row.id === file));
  assert.ok(found.items.find(row => row.id === file).annotation.provenance.some(row => row.itemId === folder && row.source === "inherited"));
  const sources = createCodexContextSources({ space: f.service, starlink: async () => ({ items: [] }) });
  const result = await sources.call({ folderId: folder }, "space_search", { query: "独立召回词" }, () => {});
  assert.equal(result.matches[0].fileId, file);
  assert.equal(result.matches[0].snippet, f.bodies.get(file));
  assert.equal((await sources.call({ folderId: folder }, "space_read", { fileId: file }, () => {})).text, f.bodies.get(file));
});

test("verified content extraction is durable, content changes require manual review and stale CAS cannot save", async t => {
  const f = await fixture(t);
  f.put({ ...f.entries.get(file) }, "项目预算会议纪要。synthetic only");
  let annotation = await f.service.operation("auto-annotate", { id: file });
  assert.ok(annotation.tags.includes("财务"));
  annotation = await f.service.operation("set-annotation", { id: file, expectedRevision: annotation.revision, tags: ["旧人工标签"], reviewed: true });
  f.put({ ...f.entries.get(file) }, "完全不同的新正文");
  await assert.rejects(f.service.operation("set-annotation", { id: file, expectedRevision: annotation.revision, tags: ["不得覆盖"] }), { code: "SPACE_ANNOTATION_CONFLICT" });
  const changed = await f.service.operation("annotation", { id: file });
  assert.equal(changed.needsReview, true);
  assert.ok(!changed.tags.includes("旧人工标签"));
  assert.deepEqual((await f.service.operation("search-annotations", { parent: folder, query: "旧人工标签" })).items, []);
  await f.service.operation("set-annotation", { id: file, expectedRevision: changed.revision, reviewed: true });
  assert.ok((await f.service.operation("annotation", { id: file })).tags.includes("旧人工标签"));
});

test("late network responses after logout or box switch do not expose previous annotations", async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => release = resolve), observed = new Promise(resolve => entered = resolve);
  f.before(async input => { if (input.path.endsWith(`/files/${file}`)) { entered(); await gate; } });
  const pending = f.service.operation("annotation", { id: file });
  await observed; f.switch({ account: { phase: "authenticated", accountId: "synthetic-other" } }); release();
  await assert.rejects(pending, { code: "SPACE_CONTEXT_CHANGED" });
  f.before(null);
  const another = await f.service.operation("annotation", { id: file });
  assert.equal(another.manual, null);
  f.switch({ phase: "offline" });
  await assert.rejects(f.service.operation("set-annotation", { id: file, expectedRevision: another.revision, tags: ["offline"] }), { code: "BOX_CONNECTION_REQUIRED" });
  f.switch({ phase: "ready", connection: { deviceId: "synthetic-other-box" } });
  assert.equal((await f.service.operation("annotation", { id: file })).manual, null);
});

test("scope-limited search drops descendants moved out while scanning and bounds output", async t => {
  const f = await fixture(t);
  const other = id("d");
  f.put({ id: other, name: "outside", kind: "folder", parent: "" });
  const initial = await f.service.operation("annotation", { id: file });
  await f.service.operation("set-annotation", { id: file, expectedRevision: initial.revision, tags: ["专属词"], reviewed: true });
  let seen = false;
  f.before(input => { if (seen && input.path.includes(`/files?parent=${child}`)) f.entries.get(file).parent = other; if (input.path.includes(`/files?parent=${folder}`)) seen = true; });
  assert.deepEqual((await f.service.operation("search-annotations", { parent: folder, query: "专属词" })).items, []);
  f.before(null);
  const limited = await f.service.operation("search-annotations", { query: "项目", limit: 1 });
  assert.ok(limited.items.length <= 1);
});

test("starlink bindings persist in the same account/box namespace and reject changed source bytes", async t => {
  const f = await fixture(t), annotation = await f.service.operation("annotation", { id: file });
  const binding = { id: file, space_id: "personal", warehouseId: warehouse, documentId: "synthetic_document", versionId: "synthetic_version", digest: f.entries.get(file).digest, annotationRevision: annotation.revision, snapshot: { tags: annotation.tags, description: annotation.description, provenance: annotation.provenance } };
  await f.service.operation("annotation-bind", binding);
  await f.restart();
  assert.equal((await f.service.operation("annotation-imports", { warehouseId: warehouse })).length, 1);
  f.put({ ...f.entries.get(file) }, "new bytes");
  await assert.rejects(f.service.operation("annotation-bind", binding), { code: "SPACE_REMOTE_FILE_CHANGED" });
  f.switch({ account: { phase: "authenticated", accountId: "another" } });
  assert.deepEqual(await f.service.operation("annotation-imports", { warehouseId: warehouse }), []);
});

test("native upload automatically extracts and durably saves rule annotations before completion", async t => {
  const f = await fixture(t), source = path.join(f.directory, "synthetic-upload.txt");
  await writeFile(source, "合成数据：预算发票用于财务核对。");
  await f.service.uploads(folder, [source]);
  const deadline = Date.now() + 5000;
  while (f.service.snapshot().tasks[0]?.phase !== "complete" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.service.snapshot().tasks[0].phase, "complete");
  assert.equal(f.service.snapshot().tasks[0].annotationError, null);
  const uploadedId = f.service.snapshot().tasks[0].id;
  await f.restart();
  const annotation = await f.service.operation("annotation", { id: uploadedId });
  assert.ok(annotation.tags.includes("财务"));
  assert.equal(annotation.manual, null);
  assert.match(annotation.description, /预算发票/);
});

test("a completed upload retains a durable annotation retry and never uploads its bytes again", async t => {
  const f = await fixture(t), source = path.join(f.directory, "retry.txt");
  await writeFile(source, "预算会议：合成恢复测试。");
  f.before(input => { if (input.path.includes("/content")) throw Object.assign(Error("synthetic disconnect"), { code: "ECONNRESET" }); });
  await f.service.uploads(folder, [source]);
  let deadline = Date.now() + 5000;
  while (f.service.snapshot().tasks[0]?.phase !== "complete" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.service.snapshot().tasks[0].annotationPending, true);
  assert.equal(f.service.snapshot().tasks[0].annotationError, "ECONNRESET");
  const taskId = f.service.snapshot().tasks[0].id;
  await f.service.transfer("clear-completed");
  assert.equal(f.service.snapshot().tasks[0].id, taskId);
  await f.restart(); f.before(null);
  assert.equal(f.service.snapshot().tasks[0].annotationPending, true);
  await f.service.transfer("retry-annotations", taskId);
  deadline = Date.now() + 5000;
  while (f.service.snapshot().tasks[0].annotationPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.service.snapshot().tasks[0].annotationPending, false);
  assert.equal(f.calls.filter(input => input.path.endsWith("/complete")).length, 1);
  assert.ok((await f.service.operation("annotation", { id: taskId })).tags.includes("财务"));
});

test("the main-process annotation operation rejects explicit read-only metadata and connections", async t => {
  const f = await fixture(t);
  f.entries.get(file).writable = false;
  let annotation = await f.service.operation("annotation", { id: file });
  await assert.rejects(f.service.operation("set-annotation", { id: file, expectedRevision: annotation.revision, tags: ["forbidden"] }), { code: "SPACE_ANNOTATION_READ_ONLY" });
  await assert.rejects(f.service.operation("auto-annotate", { id: file }), { code: "SPACE_ANNOTATION_READ_ONLY" });
  assert.equal((await f.service.operation("annotation", { id: file })).manual, null);
  f.entries.get(file).writable = true;
  f.switch({ connection: { deviceId: "synthetic-box", writable: false } });
  annotation = await f.service.operation("annotation", { id: file });
  await assert.rejects(f.service.operation("set-annotation", { id: file, expectedRevision: annotation.revision, tags: ["forbidden"] }), { code: "SPACE_ANNOTATION_READ_ONLY" });
});

test("synthetic Space → Starlink import binding → tag-only Agent recall returns original text after restart", async t => {
  const f = await fixture(t), annotation = await f.service.operation("annotation", { id: file });
  await f.service.operation("set-annotation", { id: file, expectedRevision: annotation.revision, tags: ["星图合成召回词"], description: "独立标注说明", reviewed: true });
  const text = f.bodies.get(file), documentId = "synthetic_doc", versionId = "synthetic_version";
  const document = { document: { id: documentId, warehouse_id: warehouse, status: "ready", active_version_id: versionId }, version: { id: versionId }, segments: [{ text, source_locator: { page: 1 } }] };
  const service = { async call(action) { assert.equal(action, "document"); return structuredClone(document); } };
  const space = { operation: (...args) => f.service.operation(...args) };
  let decorator = createStarlinkSpaceAnnotations({ space, service, check: () => {} });
  await decorator.run("select-space-files", { warehouseId: warehouse, entries: [{ id: file, digest: f.entries.get(file).digest }] }, async () => [{ handle: "synthetic_handle", spaceId: file }]);
  const imported = await decorator.run("upload", { warehouseId: warehouse, handle: "synthetic_handle" }, async () => structuredClone(document));
  assert.equal(imported.annotationIndex.status, "saved");
  await f.restart();
  decorator = createStarlinkSpaceAnnotations({ space, service, check: () => {} });
  const sources = createCodexContextSources({ space: f.service, starlink: (action, input) => decorator.run(action, input, async () => ({ items: [] })) });
  const matches = await sources.call({ warehouseId: warehouse }, "starlink_search", { query: "星图合成召回词" }, () => {});
  assert.equal(matches.matches[0].documentId, documentId);
  assert.equal(matches.matches[0].versionId, versionId);
  assert.equal(matches.matches[0].snippet, text.trim());
  assert.equal(matches.matches[0].evidenceId, undefined);
  f.put({ ...f.entries.get(file) }, "已变化的合成正文");
  assert.deepEqual((await sources.call({ warehouseId: warehouse }, "starlink_search", { query: "星图合成召回词" }, () => {})).matches, []);
});
