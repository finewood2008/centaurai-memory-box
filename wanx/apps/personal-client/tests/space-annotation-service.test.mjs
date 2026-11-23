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

test("file-only tag search crosses subfolders and retains the relative folder path", async t => {
  const f = await fixture(t);
  const inside = id("e"), outside = id("f");
  f.put({id:inside,name:"notes.txt",parent:child,kind:"file"}, "nested synthetic");
  f.put({id:outside,name:"notes.txt",parent:"",kind:"file"}, "outside synthetic");
  for (const target of [folder, outside]) {
    const annotation = await f.service.operation("annotation", {id:target});
    await f.service.operation("set-annotation", {id:target,expectedRevision:annotation.revision,tags:["跨目录标签"],reviewed:true});
  }
  const search = options => f.service.operation("search-annotations", {
    parent:folder,query:"跨目录标签",filesOnly:true,...options,
  });
  const result=await search({limit:2});
  assert.deepEqual(result.items.map(row=>[row.id,row.folder_path]),[[file,""],[inside,"nested"]]);
  assert.equal(result.truncated,false);
  const limited=await search({limit:1});
  assert.equal(limited.items.length,1);
  assert.equal(limited.truncated,true);
});

test("file-only tag search pages through more than 200 files without repeats", async t => {
  const f = await fixture(t);
  const ids = Array.from({length:223}, (_, i) => (i+1).toString(16).padStart(32,"0"));
  for (const [i,id] of [...ids].reverse().entries())
    f.put({id,name:"合成资料-"+i+".txt",parent:i%2 ? child : folder,kind:"file"}, "synthetic "+i);
  const metadata = await f.service.operation("annotation", {id:folder});
  await f.service.operation("set-annotation", {id:folder,expectedRevision:metadata.revision,tags:["分页验收"],reviewed:true});
  const input={parent:folder,query:"分页验收",limit:100,filesOnly:true};
  const first=await f.service.operation("search-annotations", input);
  const second=await f.service.operation("search-annotations", {...input,after:first.nextCursor});
  const last=await f.service.operation("search-annotations", {...input,after:second.nextCursor});
  assert.deepEqual([first.items.length,second.items.length,last.items.length],[100,100,24]);
  assert.deepEqual([...first.items,...second.items,...last.items].map(row=>row.id),[...ids,file]);
  assert.equal(last.nextCursor,null);
  assert.equal(last.scanLimited,false);
  await assert.rejects(f.service.operation("search-annotations", {...input,after:"bad"}), {code:"SPACE_ANNOTATION_INVALID"});
});

test("file-only tag search continues after an empty page across large folders and retries", async t => {
  const f = await fixture(t);
  const numberedId = number => number.toString(16).padStart(32, "0");
  for (let number = 1; number <= 2010; number++)
    f.put({ id:numberedId(number), name:`资料-${number}.txt`, parent:folder, kind:"file" }, "test");
  for (let number = 3000; number < 3130; number++)
    f.put({ id:numberedId(number), name:`目录-${number}`, parent:folder, kind:"folder" });
  const direct = numberedId(4000), nested = numberedId(4001), lateFolder = numberedId(3129);
  f.put({ id:direct, name:"尾部原件.txt", parent:folder, kind:"file" }, "test");
  f.put({ id:nested, name:"嵌套原件.txt", parent:lateFolder, kind:"file" }, "test");
  for (const id of [direct, lateFolder]) {
    const annotation = await f.service.operation("annotation", {id});
    await f.service.operation("set-annotation", {id, expectedRevision:annotation.revision, tags:["末尾验收标签"], reviewed:true});
  }
  const input = {parent:folder, query:"末尾验收标签", filesOnly:true};
  const search = after => f.service.operation("search-annotations", {...input, ...(after ? {after} : {})});
  const first = await search();
  assert.deepEqual(first.items, []);
  assert.equal(first.scanLimited, false);
  assert.ok(first.nextCursor);
  await assert.rejects(f.service.operation("search-annotations", {...input, parent:child, after:first.nextCursor}),
    {code:"SPACE_TAG_RESULTS_CHANGED"});

  const second = await search(first.nextCursor);
  assert.deepEqual(second.items.map(item => item.id), [direct]);
  assert.equal(second.scanLimited, false);
  assert.ok(second.nextCursor);
  f.before(input => {
    if (input.path.includes(`/files?parent=${lateFolder}`))
      throw Object.assign(Error("test disconnect"), {code:"BOX_CONNECTION_REQUIRED"});
  });
  await assert.rejects(search(second.nextCursor), {code:"BOX_CONNECTION_REQUIRED"});
  f.before(null);
  const last = await search(second.nextCursor);
  assert.deepEqual(last.items.map(item => [item.id,item.folder_path]), [[nested,"目录-3129"]]);
  assert.equal(last.nextCursor, null);
  assert.equal(last.scanLimited, false);

  const allIds = [];
  let after;
  do {
    const page = await f.service.operation("search-annotations",
      {...input, query:"资料-", limit:100, ...(after ? {after} : {})});
    allIds.push(...page.items.map(item => item.id));
    after = page.nextCursor;
  } while (after);
  assert.deepEqual(allIds, Array.from({length:2010}, (_, index) => numberedId(index + 1)));
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

test("synthetic Space → Starlink import binding → tag-only Agent recall returns a reference after restart", async t => {
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
  const current=await f.service.operation('annotation',{id:file});
  await f.service.operation('set-annotation',{id:file,expectedRevision:current.revision,tags:['空间后续标签'],description:'空间后续说明',reviewed:true});
  const sources = createCodexContextSources({ space: f.service, starlink: (action, input) => decorator.run(action, input, async () => ({ items: [] })) });
  const search = () => sources.call({ warehouseId: warehouse }, "starlink_search", { query: "星图合成召回词" }, () => {});
  const result = await search();
  assert.deepEqual(result.matches, []);
  const [related] = result.relatedDocuments;
  assert.equal(related.documentId, documentId);
  assert.equal(related.versionId, versionId);
  assert.equal(related.snippet, undefined);
  assert.equal(related.annotation, undefined);
  assert.equal(JSON.stringify(result).includes(text.trim()), false);
  assert.equal(related.evidenceId, undefined);
  f.put({ ...f.entries.get(file) }, "已变化的合成正文");
  assert.deepEqual((await search()).relatedDocuments, []);
});

test("an imported snapshot can find a document beyond 200 unrelated warehouse bindings", async t => {
  const f = await fixture(t);
  const space = { operation: (...args) => f.service.operation(...args) };
  const docId = "synthetic_late_document", versionId = "synthetic_version";
  const text = f.bodies.get(file);
  const bind = async (id, documentId) => {
    const annotation = await space.operation("annotation", { id });
    await space.operation("annotation-bind", { id, warehouseId: warehouse, documentId, versionId,
      digest: f.entries.get(id).digest, annotationRevision: annotation.revision, snapshot: {
        tags: annotation.tags, description: annotation.description, revision: annotation.revision,
        needsReview: annotation.needsReview, provenance: annotation.provenance,
      } });
  };
  for (let i = 1; i <= 200; i++) {
    const id = i.toString(16).padStart(32, "0");
    f.put({ id, parent: folder, name: `课程-${i}.txt`, kind: "file" }, `仅供测试的课程 ${i}。`);
    await bind(id, `synthetic_doc_${i}`);
  }
  f.put({ ...f.entries.get(file), parent: child }, text);
  const query = "蓝岸合成索引";
  const parent = await space.operation("annotation", { id: child });
  const imported = await space.operation("set-annotation", { id: child, expectedRevision: parent.revision, tags: [query], reviewed: true });
  await bind(file, docId);
  const laterTag = "空间后续标签";
  await space.operation("set-annotation", { id: child, expectedRevision: imported.revision, tags: [laterTag], reviewed: true });
  await f.restart();
  const reads = [];
  const service = { async call(action, input) {
    reads.push([action, input.id]);
    return { document: { id: docId, active_version_id: versionId, status: "ready", warehouse_id: warehouse }, segments: [{ text }] };
  } };
  const decorator = createStarlinkSpaceAnnotations({ space, service, check: () => {} });
  const search = (keyword = query) => decorator.run("search", { warehouseId: warehouse, query: keyword }, async () => ({ items: [] }));
  const result = await search();
  assert.deepEqual(reads, [["document", docId]]);
  assert.equal(Object.hasOwn(result.annotationDocuments[0], 'text'), false);
  assert.ok(result.annotationDocuments[0].annotation.provenance.some(row => row.tag === query && row.source === "inherited"));
  assert.deepEqual((await search(laterTag)).annotationDocuments, []);
  f.put({ ...f.entries.get(file) }, "更新后的合成正文");
  assert.deepEqual((await search()).annotationDocuments, []);
});
