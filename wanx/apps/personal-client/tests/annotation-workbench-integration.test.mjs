import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecureAccountStore } from "../account/store.mjs";
import { createPersonalSpace } from "../shell/personal-space.mjs";
import { registerControlActions } from "../shell/control.mjs";
import { createCodexContextSources } from "../shell/codex-context-sources.mjs";

const rootId = "f".repeat(32);
const nestedId = "e".repeat(32);
const itemId = index => (index + 1).toString(16).padStart(32, "0");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const fail = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
async function abortable(work, signal) {
  if (!signal) return work;
  if (signal.aborted) throw signal.reason || fail("SPACE_ANNOTATION_CANCELED");
  let abort;
  try {
    return await Promise.race([work, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason || fail("SPACE_ANNOTATION_CANCELED"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
const waitFor = async (work, description = "workbench operation") => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await work();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

// Test credentials and file bodies are fabricated. The production encrypted
// store is exercised with a temporary AES key instead of touching OS Keychain.
async function fixture(t, { count = 12, ai = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "memobox-workbench-integration-"));
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "synthetic_aes_gcm",
    encryptString(text) {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  const saveCounts = { annotations: 0, jobs: 0 };
  let afterSave, failNextJobSave = false;
  const store = name => {
    const inner = createSecureAccountStore({ filePath: path.join(directory, `${name}.enc`), safeStorage });
    return { load: () => inner.load(), async save(value) {
      if (Object.hasOwn(saveCounts, name)) saveCounts[name]++;
      if (name === "jobs" && failNextJobSave) { failNextJobSave = false; throw fail("SYNTHETIC_DISK_WRITE_FAILED"); }
      await inner.save(value); await afterSave?.(name, value);
    } };
  };
  let state = { phase: "ready", account: { phase: "authenticated", accountId: "synthetic-owner" }, connection: { deviceId: "synthetic-box" } };
  const listeners = new Set(), entries = new Map(), contents = new Map(), denied = new Set(), calls = [], modelCalls = [];
  let beforeRequest, beforeModel, beforeExtract;
  const put = (entry, text) => {
    const body = Buffer.from(text ?? "synthetic binary fixture");
    contents.set(entry.id, body);
    entries.set(entry.id, { space_id: "personal", version: 1, modified: 1, ...entry,
      size: entry.kind === "folder" ? 0 : body.length, digest: entry.kind === "folder" ? null : sha256(body) });
  };
  put({ id: rootId, parent: "", kind: "folder", name: "合成工作台资料" });
  // These mixed entry types exercise scanning and batch selection. Actual
  // PDF/Office binary parsing uses valid samples in annotation-content.test.
  const extensions = ["txt", "md", "pdf", "docx", "xlsx", "pptx", "png", "zip", "bin", "csv"];
  for (let index = 0; index < count; index++) put({ id: itemId(index), parent: rootId, kind: "file", name: `synthetic-${String(index).padStart(4, "0")}.${extensions[index % extensions.length]}` }, `Synthetic original body ${index}.\n`);
  const client = {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async applicationConnection() {
      const captured = JSON.stringify(state);
      const context = () => {
        if (state.phase !== "ready" || JSON.stringify(state) !== captured) throw fail("SPACE_CONTEXT_CHANGED");
        return { writable: state.connection.writable };
      };
      return { context, async request(input) {
        context(); calls.push(input);
        assert.equal(input.method, "GET", "annotation workbench must not mutate source files on the box");
        await abortable(Promise.resolve(beforeRequest?.(input)), input.signal); context();
        if (input.signal?.aborted) throw input.signal.reason || fail("SPACE_PAUSED");
        const url = new URL(input.path, "https://synthetic.invalid"), pieces = url.pathname.split("/").slice(3);
        let value, bytes;
        if (pieces[0] === "overview") value = { protocolVersion: 1 };
        else if (pieces[0] === "files" && pieces.length === 1) {
          const parent = url.searchParams.get("parent") || "", breadcrumbs = [];
          for (let node = entries.get(parent); node; node = entries.get(node.parent)) breadcrumbs.unshift({ id: node.id, name: node.name });
          value = { space_id: "personal", root: "", parent, breadcrumbs,
            items: [...entries.values()].filter(entry => entry.parent === parent && entry.trashed == null) };
        } else if (pieces[0] === "files") {
          const entry = entries.get(pieces[1]);
          if (!entry || denied.has(pieces[1])) return { status: denied.has(pieces[1]) ? 403 : 404, headers: {}, body: Buffer.from(JSON.stringify({ error: { code: "SPACE_NOT_FOUND" } })) };
          if (pieces[2] === "content") {
            const source = contents.get(entry.id), offset = Number(url.searchParams.get("offset") || 0), length = Number(url.searchParams.get("length") || source.length);
            bytes = source.subarray(offset, offset + length);
          } else value = entry;
        } else throw new Error(`Unexpected synthetic route ${input.path}`);
        return { status: 200, headers: bytes ? { "x-content-sha256": sha256(bytes), "x-file-sha256": entries.get(pieces[1]).digest } : {},
          body: bytes ?? Buffer.from(JSON.stringify(value)) };
      } };
    },
  };
  const options = {
    client, serviceURL: "https://synthetic.invalid", store: store("transfers"),
    annotationStore: store("annotations"), workbenchStore: store("jobs"),
    annotationAI: {
      async models() { return ai ? { available: true, presets: [{ id: "synthetic-model", name: "Synthetic local model", provider: "synthetic" }] } : { available: false, presets: [], reason: "not-configured" }; },
      async suggest(input, { signal } = {}) {
        modelCalls.push(structuredClone(input));
        const override = await abortable(Promise.resolve(beforeModel?.(input, signal)), signal);
        if (signal?.aborted) throw signal.reason || fail("SPACE_ANNOTATION_CANCELED");
        if (override !== undefined) return override;
        return { tags: ["合成AI建议"], description: `Suggestion for ${input.file.name}`,
          model: { id: "synthetic-model", provider: "synthetic" }, usage: { inputTokens: 10, outputTokens: 5 },
          contentMode: input.file.contentMode, truncated: input.file.truncated || false };
      },
    },
    annotationExtract: async input => {
      const override = await beforeExtract?.(input);
      if (override !== undefined) return override;
      const { entry, bytes } = input;
      return { content: entry.name.endsWith(".txt") || entry.name.endsWith(".md") ? bytes.toString("utf8") : "",
        mode: entry.name.endsWith(".txt") || entry.name.endsWith(".md") ? "content" : "name-only", format: entry.name.split(".").at(-1), truncated: false };
    },
  };
  let service = await createPersonalSpace(options);
  let handlers, exposed;
  const frame = { url: "file:///synthetic/local-ui/renderer/index.html" }, webContents = { mainFrame: frame }, event = { sender: webContents, senderFrame: frame };
  async function bridge() {
    handlers = new Map(); exposed = {};
    registerControlActions({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
      client, personalSpace: service, getState: () => structuredClone(state) });
    vm.runInNewContext(await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8"), {
      process: { platform: "darwin" }, require(name) {
        assert.equal(name, "electron");
        return { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
          ipcRenderer: { on() {}, removeListener() {}, async invoke(channel, input) {
            const handler = handlers.get(channel); assert.ok(handler, `Real main-process handler exists: ${channel}`);
            return handler(event, input);
          } } };
      },
    });
  }
  await bridge();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  async function op(op, input = {}) {
    const result = await exposed.wanxClient.action("space.annotation-workbench", { op, ...input });
    assert.equal(result.ok, true, `space.annotation-workbench ${op}: ${result.code || "failed"}`);
    return result.value;
  }
  async function ready(jobId) {
    const result = await waitFor(async () => { const value = await op("list", { jobId, limit: 200 }); return value.job.scanComplete ? value : null; }, "directory scan");
    await new Promise(resolve => setImmediate(resolve)); return result;
  }
  async function idle(jobId) {
    const result = await waitFor(async () => {
      const value = await op("list", { jobId, limit: 200 });
      return !["scanning", "applying", "suggesting", "undoing"].includes(value.job.status) ? value : null;
    }, "workbench task completion");
    await new Promise(resolve => setImmediate(resolve)); return result;
  }
  return {
    get service() { return service; }, op, ready, idle, entries, contents, put, denied, calls, modelCalls, saveCounts, directory,
    loadAnnotations: () => options.annotationStore.load(),
    loadJobs: () => options.workbenchStore.load(),
    afterSave(fn) { afterSave = fn; }, failNextJobSave() { failNextJobSave = true; },
    get handlers() { return handlers; }, get event() { return event; },
    async raw(input) { return exposed.wanxClient.action("space.annotation-workbench", input); },
    beforeRequest(fn) { beforeRequest = fn; }, beforeModel(fn) { beforeModel = fn; }, beforeExtract(fn) { beforeExtract = fn; },
    switch(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(); },
    async restart() { await service.close(); service = await createPersonalSpace(options); await bridge(); },
  };
}

const change = (tags, extra = {}) => ({ tagMode: "add", tags, descriptionMode: "keep", description: "", ...extra });
async function apply(f, jobId, selection, edits, extra = {}) {
  const plan = await f.op("prepare", { jobId, selection, change: edits, ...extra });
  assert.ok(plan.planId);
  await f.op("apply", { jobId, planId: plan.planId });
  await f.idle(jobId);
  return plan;
}

test("real preload/control scans 1000 mixed files, distinguishes cross-page targets and applies idempotently in blocks", async t => {
  const f = await fixture(t, { count: 1000 });
  const opened = await f.op("open", { space_id: "personal", parent: rootId, recursive: false });
  const jobId = opened.job.id, first = await f.ready(jobId);
  assert.equal(first.total, 1000);
  assert.ok(first.items.length <= 200);
  const second = await f.op("list", { jobId, offset: 200, limit: 200 });
  assert.equal(second.items.length, 200);
  assert.notEqual(first.items[0].id, second.items[0].id);
  const selected = [first.items[0].id, second.items[0].id];
  const plan = await apply(f, jobId, { ids: selected }, change(["跨页合成标签"]));
  assert.equal(plan.targetCount, 2);
  await waitFor(async () => (await f.service.operation("annotation", { id: selected[1] })).tags.includes("跨页合成标签"));
  assert.ok(!(await f.service.operation("annotation", { id: first.items[1].id })).tags.includes("跨页合成标签"));
  const revision = (await f.service.operation("annotation", { id: selected[0] })).revision;
  await f.op("apply", { jobId, planId: plan.planId });
  await f.idle(jobId);
  assert.equal((await f.service.operation("annotation", { id: selected[0] })).revision, revision);
  const all = await apply(f, jobId, { allMatching: { query: "", type: "", status: "" } }, change(["全批合成标签"]));
  assert.equal(all.targetCount, 1000);
  await waitFor(async () => {
    const saved = await f.loadAnnotations(), files = saved.records.filter(row => row.kind === "file");
    return files.length === 1000 && files.every(row => row.manual?.tags?.includes("全批合成标签"));
  }, "all 1000 persisted changes");
  assert.ok(f.saveCounts.annotations < 150, `batch annotation persistence is bounded: ${f.saveCounts.annotations}`);
  assert.equal((await readFile(path.join(f.directory, "annotations.enc"))).includes(Buffer.from("全批合成标签")), false);
});

test("filtered summaries include all 1000 matching files and distinguish own fields from inherited values", async t => {
  const f = await fixture(t, { count: 1000 });
  const parent = await f.service.operation("annotation", { id: rootId });
  await f.service.operation("set-annotation", { id: rootId, expectedRevision: parent.revision,
    tags: ["仅父继承的合成标签"], description: "全目录共同的有效说明", inherit: true, reviewed: true });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  const countTags = summary => Object.fromEntries(Array.from(summary.tagCounts, row => [row.tag, row.count]));
  const inherited = await f.op("list", { jobId, query: "仅父继承的合成标签", type: "file", offset: 800, limit: 1 });
  assert.equal(inherited.filteredTotal, 1000);
  assert.equal(inherited.items.length, 1);
  assert.equal(inherited.filteredSummary.count, 1000);
  assert.deepEqual(countTags(inherited.filteredSummary), { "文档": 400, "表格": 200, "演示": 100, "图片": 100 });
  assert.equal(inherited.filteredSummary.emptyDescriptions, 0);
  assert.equal(inherited.filteredSummary.commonDescription, "全目录共同的有效说明");
  assert.equal(inherited.filteredSummary.inheritOn, 1000);
  assert.equal(inherited.filteredSummary.inheritOff, 0);
  assert.ok(inherited.items.every(row => row.annotation.tags.includes("仅父继承的合成标签")));
  const firstPage = await f.op("list", { jobId, query: "仅父继承的合成标签", type: "file", offset: 0, limit: 1 });
  assert.deepEqual(inherited.filteredSummary, firstPage.filteredSummary, "a later page has the same full filtered summary");

  await apply(f, jobId, { ids: Array.from({ length: 100 }, (_, index) => itemId(index)) },
    change(["本项手工合成标签"], { tagMode: "replace", descriptionMode: "replace", description: "", inherit: false }));
  await apply(f, jobId, { ids: Array.from({ length: 50 }, (_, index) => itemId(index)) }, change([], { tagMode: "replace" }));
  const mixed = await f.op("list", { jobId, query: "synthetic-", type: "file", offset: 800, limit: 100 });
  assert.equal(mixed.filteredSummary.count, 1000);
  assert.deepEqual(countTags(mixed.filteredSummary), { "文档": 360, "表格": 180, "演示": 90, "图片": 90, "本项手工合成标签": 50 });
  assert.equal(mixed.filteredSummary.emptyDescriptions, 100);
  assert.equal(mixed.filteredSummary.commonDescription, null);
  assert.equal(mixed.filteredSummary.inheritOn, 900);
  assert.equal(mixed.filteredSummary.inheritOff, 100);
  const empty = await f.op("list", { jobId, query: "synthetic-00", type: "file", limit: 10 });
  assert.equal(empty.filteredSummary.count, 100);
  assert.deepEqual(countTags(empty.filteredSummary), { "本项手工合成标签": 50 }, "an empty manual tag list also suppresses the item's automatic tags");
  assert.equal(empty.filteredSummary.emptyDescriptions, 100);
  assert.equal(empty.filteredSummary.commonDescription, "");
  assert.equal(empty.filteredSummary.inheritOn, 0);
  assert.equal(empty.filteredSummary.inheritOff, 100);
  const absent = await f.op("list", { jobId, query: "没有任何合成文件匹配此词", limit: 1 });
  assert.equal(absent.filteredSummary.count, 0);
  assert.equal(absent.filteredSummary.commonDescription, null, "no matches differ from matches sharing an empty description");
});

test("batch undo survives restart and never overwrites a later edit", async t => {
  const f = await fixture(t, { count: 3 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  await apply(f, jobId, { ids: [itemId(0), itemId(1)] }, change(["待撤销合成标签"]));
  await waitFor(async () => (await f.service.operation("annotation", { id: itemId(1) })).tags.includes("待撤销合成标签"));
  const current = await f.service.operation("annotation", { id: itemId(0) });
  await f.service.operation("set-annotation", { id: itemId(0), expectedRevision: current.revision, tags: ["后续人工修改"], reviewed: true });
  await f.restart();
  await f.op("undo", { jobId });
  await waitFor(async () => !(await f.service.operation("annotation", { id: itemId(1) })).tags.includes("待撤销合成标签"));
  assert.deepEqual((await f.service.operation("annotation", { id: itemId(0) })).manual.tags, ["后续人工修改"]);
});

test("a wholly failed batch keeps the most recent actual modification available for undo", async t => {
  const f = await fixture(t, { count: 2 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  const successful = await apply(f, jobId, { ids: [itemId(0)] }, change(["最近实际成功的修改"]));
  const failed = await f.op("prepare", { jobId, selection: { ids: [itemId(1)] }, change: change(["完全无权限的尝试"]) });
  f.denied.add(itemId(1));
  await f.op("apply", { jobId, planId: failed.planId });
  const partial = await f.idle(jobId);
  assert.equal(partial.job.status, "partial");
  assert.ok(partial.items.find(row => row.id === itemId(1)).error);
  assert.equal(partial.job.lastBatch.id, successful.operationId, "a zero-change attempt must not replace the successful undo target");
  f.denied.delete(itemId(1));
  await f.op("undo", { jobId });
  const undone = await f.idle(jobId);
  assert.equal(undone.job.undone, true);
  assert.ok(!(await f.service.operation("annotation", { id: itemId(0) })).tags.includes("最近实际成功的修改"));
  assert.ok(!(await f.service.operation("annotation", { id: itemId(1) })).tags.includes("完全无权限的尝试"));
});

test("AI creates per-file suggestions and preserves drafts until explicit acceptance", async t => {
  const f = await fixture(t, { count: 2 });
  const manual = await f.service.operation("annotation", { id: itemId(1) });
  await f.service.operation("set-annotation", { id: itemId(1), expectedRevision: manual.revision,
    tags: ["已有人工标签"], description: "已有人工说明必须保留", reviewed: true });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  await f.op("draft", { jobId, id: itemId(0), patch: { tags: ["未提交草稿"], description: "Per-file draft", inherit: true } });
  await f.op("suggest", { jobId, selection: { ids: [itemId(0), itemId(1)] }, modelPresetId: "synthetic-model", instructions: "Classify synthetic data only" });
  const suggested = await waitFor(async () => {
    const result = await f.op("list", { jobId, limit: 200 });
    return result.items.filter(row => row.suggestion).length === 2 ? result : null;
  }, "AI proposals");
  assert.equal(f.modelCalls.length, 2);
  assert.notEqual(suggested.items[0].suggestion.description, suggested.items[1].suggestion.description);
  assert.ok(!(await f.service.operation("annotation", { id: itemId(0) })).tags.includes("合成AI建议"));
  await f.restart();
  const restored = await f.op("list", { jobId, limit: 200 });
  assert.deepEqual(Array.from(restored.items.find(row => row.id === itemId(0)).draft.tags), ["未提交草稿"]);
  assert.equal(restored.items.filter(row => row.suggestion).length, 2);
  await apply(f, jobId, { ids: [itemId(1)] }, change([], { tagMode: "add", descriptionMode: "fill-empty" }), { acceptSuggestions: true });
  await waitFor(async () => (await f.service.operation("annotation", { id: itemId(1) })).tags.includes("合成AI建议"));
  const accepted = await f.service.operation("annotation", { id: itemId(1) });
  assert.ok(accepted.tags.includes("已有人工标签"));
  assert.equal(accepted.description, "已有人工说明必须保留");
  assert.ok(!(await f.service.operation("annotation", { id: itemId(0) })).tags.includes("合成AI建议"));
});

test("AI skip persists without manual writes, resume honors it and explicit generation refreshes selected suggestions", async t => {
  const f = await fixture(t, { count: 2 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  let entered = false, block = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  const secondName = f.entries.get(itemId(1)).name;
  f.beforeModel(async input => {
    if (input.file.name === secondName && block) { block = false; entered = true; await gate; }
    return { tags: ["可审核合成建议"], description: `${input.instructions}: ${input.file.name}` };
  });
  try {
    await f.op("suggest", { jobId, selection: { ids: [itemId(0), itemId(1)] }, modelPresetId: "synthetic-model", instructions: "第一轮合成要求" });
    await waitFor(() => entered, "AI first result committed and second result in progress");
    await f.op("pause", { jobId }); release();
    await f.restart();
    const paused = await f.op("list", { jobId });
    assert.equal(paused.job.status, "paused");
    assert.equal(paused.items.find(row => row.id === itemId(0)).suggestion.description, `第一轮合成要求: ${f.entries.get(itemId(0)).name}`);
    const savedAnnotations = await f.loadAnnotations(), saveCount = f.saveCounts.annotations;
    const skipped = await f.op("skip-suggestions", { jobId, selection: { ids: [itemId(0)] } });
    const first = skipped.items.find(row => row.id === itemId(0));
    assert.equal(first.suggestion, undefined);
    assert.equal(first.suggestionSkipped, true);
    assert.equal(first.annotation.manual, null);
    assert.equal(f.saveCounts.annotations, saveCount, "skipping only writes workbench state");
    assert.deepEqual(await f.loadAnnotations(), savedAnnotations);
    await f.restart();
    const durable = await f.op("list", { jobId });
    assert.equal(durable.items.find(row => row.id === itemId(0)).suggestionSkipped, true);
    assert.equal(f.modelCalls.length, 2, "restart must not automatically regenerate a skipped suggestion");
    await f.op("resume", { jobId });
    const resumed = await f.idle(jobId);
    assert.equal(f.modelCalls.filter(input => input.file.name === f.entries.get(itemId(0)).name).length, 1, "resuming the same task skips the dismissed result");
    assert.equal(f.modelCalls.filter(input => input.file.name === secondName).length, 2);
    assert.equal(resumed.items.find(row => row.id === itemId(0)).suggestion, undefined);
    assert.ok(resumed.items.find(row => row.id === itemId(1)).suggestion);

    await f.op("suggest", { jobId, selection: { ids: [itemId(1)] }, modelPresetId: "synthetic-model", instructions: "替换旧建议的新要求" });
    const regenerated = await f.idle(jobId);
    assert.equal(f.modelCalls.filter(input => input.file.name === secondName).length, 3, "an explicit request replaces the old suggestion instead of silently reusing it");
    assert.equal(regenerated.items.find(row => row.id === itemId(1)).suggestion.description, `替换旧建议的新要求: ${secondName}`);
    assert.equal(regenerated.items.find(row => row.id === itemId(0)).suggestionSkipped, true, "regeneration only resets the selected rows");
    await f.op("suggest", { jobId, selection: { ids: [itemId(0)] }, modelPresetId: "synthetic-model", instructions: "跳过后明确重新生成" });
    const unskipped = await f.idle(jobId), row = unskipped.items.find(row => row.id === itemId(0));
    assert.equal(f.modelCalls.filter(input => input.file.name === f.entries.get(itemId(0)).name).length, 2);
    assert.equal(row.suggestionSkipped, undefined);
    assert.equal(row.suggestion.description, `跳过后明确重新生成: ${row.name}`);
    assert.equal(row.annotation.manual, null);
    assert.deepEqual(await f.loadAnnotations(), savedAnnotations, "generating, skipping and resuming never commit suggestions as manual annotations");
  } finally { release(); f.beforeModel(null); }
});

test("accepting suggestions respects explicit keep fields and supplies safe defaults only when modes are absent", async t => {
  const f = await fixture(t, { count: 4 });
  for (const index of [0, 1, 2]) {
    const current = await f.service.operation("annotation", { id: itemId(index) });
    await f.service.operation("set-annotation", { id: itemId(index), expectedRevision: current.revision,
      tags: [`已有手工标签${index}`], description: index === 1 ? "已有手工说明必须保留" : "", reviewed: true });
  }
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  await f.op("suggest", { jobId, selection: { allMatching: {} }, modelPresetId: "synthetic-model" });
  await f.idle(jobId);
  const keep = await f.raw({ op: "prepare", jobId, selection: { ids: [itemId(0)] }, acceptSuggestions: true,
    change: { tagMode: "keep", descriptionMode: "keep" } });
  assert.equal(keep.ok, false);
  assert.equal(keep.code, "SPACE_ANNOTATION_NO_CHANGES");
  await apply(f, jobId, { ids: [itemId(0)] }, { tagMode: "keep", descriptionMode: "replace" }, { acceptSuggestions: true });
  const descriptionOnly = await f.service.operation("annotation", { id: itemId(0) });
  assert.deepEqual(descriptionOnly.manual.tags, ["已有手工标签0"]);
  assert.equal(descriptionOnly.manual.description, `Suggestion for ${f.entries.get(itemId(0)).name}`);
  await apply(f, jobId, { ids: [itemId(1), itemId(2)] }, { tagMode: "replace", descriptionMode: "keep" }, { acceptSuggestions: true });
  const tagsOnly = await f.service.operation("annotation", { id: itemId(1) });
  const emptyKept = await f.service.operation("annotation", { id: itemId(2) });
  assert.deepEqual(tagsOnly.manual.tags, ["合成AI建议"]);
  assert.equal(tagsOnly.manual.description, "已有手工说明必须保留");
  assert.deepEqual(emptyKept.manual.tags, ["合成AI建议"]);
  assert.equal(emptyKept.manual.description, "", "explicit keep also preserves an intentionally empty manual description");
  const beforeDefault = await f.service.operation("annotation", { id: itemId(3) });
  await apply(f, jobId, { ids: [itemId(3)] }, {}, { acceptSuggestions: true });
  const defaults = await f.service.operation("annotation", { id: itemId(3) });
  assert.deepEqual(defaults.manual.tags, [...beforeDefault.automatic.tags, "合成AI建议"]);
  assert.equal(defaults.manual.description, `Suggestion for ${f.entries.get(itemId(3)).name}`);
});

test("bulk removal, replacement and fill-empty descriptions preserve fields not selected for editing", async t => {
  const f = await fixture(t, { count: 3 });
  for (const index of [0, 1]) {
    const current = await f.service.operation("annotation", { id: itemId(index) });
    await f.service.operation("set-annotation", { id: itemId(index), expectedRevision: current.revision,
      tags: index === 0 ? ["保留标签", "待移除标签"] : ["待移除标签"], description: index === 0 ? "已有说明" : "", reviewed: true });
  }
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  await apply(f, jobId, { ids: [itemId(0), itemId(1)] }, change(["待移除标签"], { tagMode: "remove", descriptionMode: "fill-empty", description: "批量填空说明" }));
  await waitFor(async () => (await f.service.operation("annotation", { id: itemId(1) })).description === "批量填空说明");
  const first = await f.service.operation("annotation", { id: itemId(0) });
  assert.deepEqual(first.manual.tags, ["保留标签"]);
  assert.equal(first.description, "已有说明");
  const automatic = await f.service.operation("annotation", { id: itemId(2) });
  assert.equal(automatic.manual, null);
  const confirmation = await f.op("prepare", { jobId, selection: { ids: [itemId(2)] }, change: change(automatic.automatic.tags, { tagMode: "replace" }) });
  assert.equal(confirmation.changeCount, 1, "confirming an automatic value creates a manual field even when its text is unchanged");
  await apply(f, jobId, { ids: [itemId(2)] }, change(["明确替换标签"], { tagMode: "replace" }));
  await waitFor(async () => (await f.service.operation("annotation", { id: itemId(2) })).manual?.tags.includes("明确替换标签"));
  assert.deepEqual((await f.service.operation("annotation", { id: itemId(2) })).manual.tags, ["明确替换标签"]);
  const unchanged = await f.raw({ op: "prepare", jobId, selection: { ids: [itemId(2)] }, change: change(["明确替换标签"], { tagMode: "replace" }) });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.code, "SPACE_ANNOTATION_NO_CHANGES");
  const mixed = await f.op("prepare", { jobId, selection: { ids: [itemId(0), itemId(2)] }, change: change(["明确替换标签"], { tagMode: "replace" }) });
  assert.equal(mixed.targetCount, 2);
  assert.equal(mixed.changeCount, 1, "an already identical manual field does not inflate the impact count");
});

test("fill-empty preserves effective inherited and automatic descriptions and fills only the truly empty item", async t => {
  const f = await fixture(t, { count: 3 });
  const parent = await f.service.operation("annotation", { id: rootId });
  await f.service.operation("set-annotation", { id: rootId, expectedRevision: parent.revision,
    description: "父目录提供的有效说明", inherit: true, reviewed: true });
  const automatic = await f.service.operation("auto-annotate", { id: itemId(1) });
  assert.equal(automatic.descriptionSource.source, "automatic");
  const empty = await f.service.operation("annotation", { id: itemId(2) });
  await f.service.operation("set-annotation", { id: itemId(2), expectedRevision: empty.revision, description: "", reviewed: true });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  const before = await f.ready(jobId);
  assert.equal(before.items.find(row => row.id === itemId(0)).annotation.descriptionSource.source, "inherited");
  assert.equal(before.items.find(row => row.id === itemId(2)).annotation.description, "");
  const plan = await apply(f, jobId, { ids: [itemId(0), itemId(1), itemId(2)] },
    change([], { tagMode: "keep", descriptionMode: "fill-empty", description: "仅真正空白项填入" }));
  assert.equal(plan.targetCount, 3);
  assert.equal(plan.changeCount, 1);
  assert.equal(plan.examples[0].id, itemId(2));
  const inherited = await f.service.operation("annotation", { id: itemId(0) });
  const preserved = await f.service.operation("annotation", { id: itemId(1) });
  const filled = await f.service.operation("annotation", { id: itemId(2) });
  assert.equal(inherited.description, "父目录提供的有效说明");
  assert.equal(inherited.manual, null, "preserving a parent description must not manufacture a manual override");
  assert.equal(preserved.description, automatic.description);
  assert.equal(preserved.manual, null, "preserving an automatic description must not manufacture a manual override");
  assert.equal(filled.manual.description, "仅真正空白项填入");
});

test("AI deduplicates identical scheme instructions and rejects an over-budget combination before starting a model", async t => {
  const f = await fixture(t, { count: 2 });
  const instructions = "合成".repeat(2000);
  const scheme = await f.op("save-scheme", { scheme: { name: "去重合成方案", tags: ["合成项目"], instructions } });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  await f.op("suggest", { jobId, selection: { ids: [itemId(0)] }, modelPresetId: "synthetic-model", schemeId: scheme.id, instructions });
  await f.idle(jobId);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.modelCalls[0].instructions, instructions, "the scheme and free-text requirements reach the model only once");
  const long = await f.op("save-scheme", { scheme: { name: "超预算合成方案", tags: [], instructions: "A".repeat(2500) } });
  const rejected = await f.raw({ op: "suggest", jobId, selection: { ids: [itemId(0)] }, modelPresetId: "synthetic-model", schemeId: long.id, instructions: "B".repeat(1500) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "SPACE_ANNOTATION_INSTRUCTIONS_TOO_LONG");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.modelCalls.length, 1, "neither individually valid input may start a model when the joined instructions exceed 4000 characters");
  const unchanged = await f.op("list", { jobId });
  assert.equal(unchanged.job.status, "ready");
  assert.equal(unchanged.job.instructions, instructions);
  const boundary = await f.op("save-scheme", { scheme: { name: "边界合成方案", tags: [], instructions: "A".repeat(2499) } });
  await f.op("suggest", { jobId, selection: { ids: [itemId(1)] }, modelPresetId: "synthetic-model", schemeId: boundary.id, instructions: "B".repeat(1500) });
  await f.idle(jobId);
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.modelCalls[1].instructions, `${"A".repeat(2499)}\n${"B".repeat(1500)}`, "different instructions totaling exactly 4000 characters reach the model unchanged");
});

test("workbench tasks and reusable schemes remain isolated across account/box changes", async t => {
  const f = await fixture(t, { count: 2, ai: false });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  const models = await f.op("models");
  assert.equal(models.aiAvailable, false);
  assert.ok(models.presets.some(preset => preset.id === "rules"));
  await f.op("save-scheme", { scheme: { name: "合成方案", tags: ["合成项目"], instructions: "one sentence", inherit: true } });
  assert.equal((await f.op("schemes")).items.length, 1);
  f.switch({ account: { phase: "authenticated", accountId: "synthetic-other" } });
  assert.equal((await f.raw({ op: "list", jobId })).ok, false);
  assert.equal((await f.op("schemes")).items.length, 0);
  f.switch({ account: { phase: "authenticated", accountId: "synthetic-owner" }, connection: { deviceId: "other-box" } });
  assert.equal((await f.raw({ op: "list", jobId })).ok, false);
  assert.equal((await f.op("schemes")).items.length, 1, "schemes belong to the account rather than a particular box");
});

test("saved draft tags remain reusable after restart and stay isolated by account and box", async t => {
  const f = await fixture(t, { count: 2, ai: false });
  const opened = await f.op("open", { parent: rootId });
  const page = await f.ready(opened.job.id);
  await f.op("draft", { jobId: opened.job.id, id: page.items[0].id, patch: { tags: ["历史复用标签"] } });
  await f.restart();
  assert.ok((await f.op("schemes")).tags.includes("历史复用标签"));
  f.switch({ account: { phase: "authenticated", accountId: "synthetic-other" } });
  assert.equal((await f.op("schemes")).tags.includes("历史复用标签"), false);
  f.switch({ account: { phase: "authenticated", accountId: "synthetic-owner" }, connection: { deviceId: "other-box" } });
  assert.equal((await f.op("schemes")).tags.includes("历史复用标签"), false);
});

test("an account switch during a durable draft save withholds the late response", async t => {
  const f = await fixture(t, { count: 2 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  let entered, release, blocked = false;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.afterSave(async name => { if (!blocked && name === "jobs") { blocked = true; entered(); await gate; } });
  const pending = f.raw({ op: "draft", jobId, id: itemId(0), patch: { tags: ["原账号草稿"] } });
  await started;
  f.switch({ account: { phase: "authenticated", accountId: "synthetic-other" } }); release();
  assert.equal((await pending).ok, false);
  assert.equal((await f.raw({ op: "list", jobId })).ok, false);
  f.switch({ account: { phase: "authenticated", accountId: "synthetic-owner" } });
  const original = await f.op("list", { jobId, limit: 200 });
  assert.deepEqual(Array.from(original.items.find(row => row.id === itemId(0)).draft.tags), ["原账号草稿"]);
});

test("lost job checkpoint after an atomic annotation commit replays its receipt without reapplying labels", async t => {
  const f = await fixture(t, { count: 3 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  let injected = false;
  f.afterSave((name, value) => {
    if (!injected && name === "annotations" && value.batchReceipts?.length) {
      injected = true; f.failNextJobSave();
    }
  });
  const plan = await f.op("prepare", { jobId, selection: { ids: [itemId(0), itemId(1)] }, change: change(["幂等回执合成标签"]) });
  await f.op("apply", { jobId, planId: plan.planId });
  const paused = await f.idle(jobId);
  assert.equal(injected, true);
  assert.equal(paused.job.status, "paused");
  const committedRevision = (await f.service.operation("annotation", { id: itemId(0) })).revision;
  assert.ok((await f.service.operation("annotation", { id: itemId(1) })).tags.includes("幂等回执合成标签"));
  await f.restart();
  await f.op("resume", { jobId });
  const completed = await f.idle(jobId);
  assert.equal(completed.job.status, "complete");
  assert.equal((await f.service.operation("annotation", { id: itemId(0) })).revision, committedRevision);
});

test("cancel after the first 50-item chunk retains a batch that can be undone", async t => {
  const f = await fixture(t, { count: 55 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.beforeRequest(async input => {
    if (!entered && new URL(input.path, "https://synthetic.invalid").pathname.endsWith(`/files/${itemId(50)}`)) {
      entered = true; await gate;
    }
  });
  try {
    const plan = await f.op("prepare", { jobId, selection: { allMatching: {} }, change: change(["取消后可撤销的批次"]) });
    await f.op("apply", { jobId, planId: plan.planId });
    await waitFor(() => entered, "second batch chunk preflight");
    const saved = await f.loadAnnotations(), applied = saved.records.filter(row => row.manual?.tags?.includes("取消后可撤销的批次"));
    assert.equal(applied.length, 50, "the first chunk is durable while the second chunk is blocked");
    const draft = await f.raw({ op: "draft", jobId, id: itemId(0), patch: { tags: ["运行时禁止草稿"] } });
    assert.equal(draft.ok, false);
    assert.equal(draft.code, "SPACE_ANNOTATION_BUSY");
    const canceled = await f.op("cancel", { jobId });
    assert.equal(canceled.job.status, "canceled");
    release();
    const checkpoint = await waitFor(async () => {
      const page = await f.op("list", { jobId, limit: 200 });
      return page.job.completed === 55 ? page : null;
    }, "canceled in-flight chunk receipt checkpoint");
    assert.equal(checkpoint.job.status, "canceled");
    assert.equal(checkpoint.items.filter(row => row.annotation.tags.includes("取消后可撤销的批次")).length, 55,
      "a committed in-flight chunk remains visible even after cancel");
    await f.op("undo", { jobId });
    const undone = await f.idle(jobId);
    assert.equal(undone.job.undone, true);
    assert.ok(undone.items.every(row => !row.draft), "the rejected draft was never persisted");
    const restored = await f.loadAnnotations();
    assert.ok(restored.records.every(row => !row.manual?.tags?.includes("取消后可撤销的批次")), "undo also discovers any committed in-flight chunk through its receipt");
  } finally { release(); f.beforeRequest(null); }
});

test("restart can undo an atomic index commit whose workbench checkpoint was lost", async t => {
  const f = await fixture(t, { count: 3 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  let injected = false;
  f.afterSave((name, value) => {
    if (!injected && name === "annotations" && value.batchReceipts?.length) {
      injected = true; f.failNextJobSave();
    }
  });
  const plan = await f.op("prepare", { jobId, selection: { ids: [itemId(0), itemId(1)] }, change: change(["仅回执可恢复的撤销"]) });
  await f.op("apply", { jobId, planId: plan.planId });
  const paused = await f.idle(jobId);
  assert.equal(injected, true);
  assert.equal(paused.job.status, "paused");
  const committed = await f.loadAnnotations(), checkpoint = (await f.loadJobs()).jobs.find(job => job.id === jobId);
  assert.ok(committed.batchReceipts.some(receipt => receipt.operationId === `${jobId}:${plan.operationId}:0` && receipt.items.filter(item => item.status === "applied").length === 2));
  assert.deepEqual(checkpoint.completedChunks, [], "the index receipt exists but the workbench never checkpointed this chunk");
  assert.equal(checkpoint.lastBatch, undefined);
  await f.restart();
  await f.op("undo", { jobId });
  const undone = await f.idle(jobId);
  assert.equal(undone.job.undone, true);
  assert.ok((await f.loadAnnotations()).records.every(row => !row.manual?.tags?.includes("仅回执可恢复的撤销")));
  assert.ok(!(await f.service.operation("annotation", { id: itemId(0) })).tags.includes("仅回执可恢复的撤销"));
});

test("prepare refuses a preserved draft from an older annotation revision", async t => {
  const f = await fixture(t, { count: 1 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  await f.op("draft", { jobId, id: itemId(0), patch: { tags: ["旧版本草稿"] } });
  const current = await f.service.operation("annotation", { id: itemId(0) });
  await f.service.operation("set-annotation", { id: itemId(0), expectedRevision: current.revision, tags: ["另一窗口已保存"], reviewed: true });
  const refreshed = await f.op("refresh-item", { jobId, id: itemId(0), discardDraft: false });
  assert.deepEqual(Array.from(refreshed.items[0].draft.tags), ["旧版本草稿"]);
  assert.notEqual(refreshed.items[0].draftRevision, refreshed.items[0].annotation.revision);
  const prepared = await f.raw({ op: "prepare", jobId, selection: { ids: [itemId(0)] }, change: { tagMode: "keep", descriptionMode: "keep" }, useDrafts: true });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, "SPACE_ANNOTATION_CONFLICT");
  assert.deepEqual((await f.service.operation("annotation", { id: itemId(0) })).manual.tags, ["另一窗口已保存"]);
});

test("fallback preview withholds extracted text when an ancestor leaves scope during I/O", async t => {
  for (const stage of ["read", "extract"]) await t.test(stage, async t => {
    const f = await fixture(t, { count: 5 }), id = itemId(4);
    f.put({ id: nestedId, parent: rootId, kind: "folder", name: "合成预览范围" });
    f.entries.get(id).parent = nestedId;
    const opened = await f.op("open", { parent: rootId, recursive: true }), jobId = opened.job.id;
    await f.ready(jobId);
    let entered = false, extracted = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    if (stage === "read") f.beforeRequest(async input => {
      if (!entered && new URL(input.path, "https://synthetic.invalid").pathname.endsWith(`/files/${id}/content`)) {
        entered = true; await gate;
      }
    });
    f.beforeExtract(async () => {
      extracted = true;
      if (stage === "extract") { entered = true; await gate; }
      return { content: "Synthetic preview text must remain inside the selected subtree", mode: "content", format: "xlsx", truncated: false };
    });
    let pending;
    try {
      pending = f.raw({ op: "preview", jobId, id });
      await waitFor(() => entered, `fallback preview ${stage}`);
      // Moving only the ancestor preserves the file's own sourceVersion.
      f.entries.get(nestedId).parent = "";
      release();
      const result = await pending;
      if (stage === "extract") assert.equal(extracted, true, "the extractor was already running when the ancestor moved");
      assert.equal(result.ok, false);
      assert.equal(result.code, "SPACE_LINK_SCOPE");
      assert.equal(result.value, undefined, "no extracted content crosses the changed subtree boundary");
    } finally { release(); f.beforeRequest(null); f.beforeExtract(null); await pending; }
  });
});

test("fresh permission/content checks exclude invalidated items while preserving valid batch changes", async t => {
  const f = await fixture(t, { count: 4 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  const plan = await f.op("prepare", { jobId, selection: { ids: [itemId(0), itemId(1), itemId(2)] }, change: change(["安全批次"]) });
  f.denied.add(itemId(0));
  f.put({ ...f.entries.get(itemId(1)), version: 2 }, "Changed synthetic content");
  await f.op("apply", { jobId, planId: plan.planId });
  await waitFor(async () => (await f.service.operation("annotation", { id: itemId(2) })).tags.includes("安全批次"));
  assert.ok(!(await f.service.operation("annotation", { id: itemId(1) })).tags.includes("安全批次"));
  const page = await f.op("list", { jobId, limit: 200 });
  assert.ok(page.items.find(row => row.id === itemId(0)).error);
  assert.ok(page.items.find(row => row.id === itemId(1)).error);
  const handler = f.handlers.get("wanx-client:space-annotation-workbench");
  assert.throws(() => handler({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }, { op: "list", jobId }), /无权/);
  assert.equal((await f.raw({ op: "arbitrary-network-request", url: "https://synthetic.invalid" })).ok, false);
});

test("moving an ancestor outside the selected subtree invalidates a prepared child edit", async t => {
  const f = await fixture(t, { count: 1 });
  f.put({ id: nestedId, parent: rootId, kind: "folder", name: "合成授权子目录" });
  f.entries.get(itemId(0)).parent = nestedId;
  const opened = await f.op("open", { parent: rootId, recursive: true }), jobId = opened.job.id;
  await f.ready(jobId);
  const plan = await f.op("prepare", { jobId, selection: { ids: [itemId(0)] }, change: change(["不得越界提交"]) });
  // Only the ancestor moves: the child's own parent, digest and version stay
  // the same, so a file-only fingerprint check cannot enforce this boundary.
  f.entries.get(nestedId).parent = "";
  await f.op("apply", { jobId, planId: plan.planId });
  const result = await f.idle(jobId);
  assert.ok(result.items.find(row => row.id === itemId(0)).error);
  assert.ok(!(await f.service.operation("annotation", { id: itemId(0) })).tags.includes("不得越界提交"));
});

test("folder batch labeling is inherited by authorized descendants and consumed by real Space search", async t => {
  const f = await fixture(t, { count: 1 });
  f.put({ id: nestedId, parent: rootId, kind: "folder", name: "合成子目录" });
  f.entries.get(itemId(0)).parent = nestedId;
  const opened = await f.op("open", { parent: rootId, ids: [nestedId], recursive: false }), jobId = opened.job.id;
  await f.ready(jobId);
  await apply(f, jobId, { ids: [nestedId] }, change(["父目录专属合成标签"]));
  await waitFor(async () => (await f.service.operation("annotation", { id: nestedId })).tags.includes("父目录专属合成标签"));
  const child = await f.service.operation("annotation", { id: itemId(0) });
  assert.equal(child.manual, null);
  assert.ok(child.provenance.some(row => row.tag === "父目录专属合成标签" && row.itemId === nestedId && row.source === "inherited"));
  const sources = createCodexContextSources({ space: f.service, starlink: async () => ({ items: [] }) });
  const result = await sources.call({ folderId: rootId }, "space_search", { query: "父目录专属合成标签" }, () => {});
  assert.equal(result.matches[0].fileId, itemId(0));
  assert.equal(result.matches[0].snippet, f.contents.get(itemId(0)).toString("utf8"));
});

test("an interrupted AI task persists as paused and only resumes model work on explicit request", async t => {
  const f = await fixture(t, { count: 3 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id;
  await f.ready(jobId);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.beforeModel(async () => { entered(); await gate; });
  await f.op("suggest", { jobId, selection: { ids: [itemId(0), itemId(1), itemId(2)] }, modelPresetId: "synthetic-model", instructions: "Synthetic pause test" });
  await started;
  f.switch({ phase: "offline" }); release();
  await f.restart();
  const callsAtRestart = f.modelCalls.length;
  f.switch({ phase: "ready" });
  const paused = await f.op("list", { jobId, limit: 200 });
  assert.equal(paused.job.status, "paused");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.modelCalls.length, callsAtRestart, "reopening the client must not restart paid model requests");
  assert.equal((await f.service.operation("annotation", { id: itemId(0) })).manual, null);
  f.beforeModel(null);
  await f.op("resume", { jobId });
  await waitFor(async () => (await f.op("list", { jobId, limit: 200 })).items.filter(row => row.suggestion).length === 3, "explicitly resumed AI task");
  assert.ok(f.modelCalls.length <= 4, "completed suggestions should not be recomputed");
});


test("empty rule descriptions do not create human overrides that hide later folder inheritance", async t => {
  const f = await fixture(t, { count: 9 });
  const opened = await f.op("open", { parent: rootId }), jobId = opened.job.id, id = itemId(8);
  await f.ready(jobId);
  await f.op("suggest", { jobId, selection: { ids: [id] }, modelPresetId: "rules" });
  const suggested = await f.idle(jobId);
  assert.equal(suggested.items.find(row => row.id === id).suggestion.description, "");
  const plan = await f.op("prepare", { jobId, selection: { ids: [id] }, change: { tagMode: "add", descriptionMode: "fill-empty" }, acceptSuggestions: true });
  assert.equal(Object.hasOwn(plan.examples[0].after, "description"), false);
  await f.op("apply", { jobId, planId: plan.planId }); await f.idle(jobId);
  const parent = await f.service.operation("annotation", { id: rootId });
  await f.service.operation("set-annotation", { id: rootId, expectedRevision: parent.revision, description: "合成父级说明仍可继承", reviewed: true });
  const child = await f.service.operation("annotation", { id });
  assert.equal(Object.hasOwn(child.manual, "description"), false);
  assert.equal(child.description, "合成父级说明仍可继承");
});
