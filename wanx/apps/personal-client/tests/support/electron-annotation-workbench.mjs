// Native IPC acceptance fixture. This is an isolated coding test, not a
// controller for the installed app. Box responses and the encryption key are
// synthetic; the preload, Electron transport, handlers and stores are real.
import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSecureAccountStore } from "../../account/store.mjs";
import { createPersonalSpace } from "../../shell/personal-space.mjs";
import { registerControlActions } from "../../shell/control.mjs";

const [phase, profile] = process.argv.slice(2);
assert.ok(["write", "read"].includes(phase));
assert.ok(path.isAbsolute(profile) && path.basename(profile).startsWith("memobox-annotation-electron-"));
assert.match(process.env.WANX_ANNOTATION_TEST_AES_KEY || "", /^[a-f0-9]{64}$/);
const key = Buffer.from(process.env.WANX_ANNOTATION_TEST_AES_KEY, "hex");
delete process.env.WANX_ANNOTATION_TEST_AES_KEY;
console.log("ANNOTATION_NATIVE_STAGE module-loaded");
app.setName("MemoBox Annotation IPC Synthetic Test");
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const rootId = "f".repeat(32), itemId = index => (index + 1).toString(16).padStart(32, "0");
const allTag = "native-ipc-all-synthetic", crossTag = "native-ipc-cross-page-synthetic";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const contents = new Map(), entries = new Map();
const extensions = ["txt", "md", "pdf", "docx", "xlsx", "pptx", "png", "zip", "bin", "csv"];
entries.set(rootId, { id: rootId, parent: "", kind: "folder", name: "SYNTHETIC IPC QA", space_id: "personal", version: 1, modified: 1, size: 0, digest: null });
for (let index = 0; index < 1000; index++) {
  // Mixed metadata tests selection/indexing. Valid binary parsers are covered
  // separately by annotation-content.test.mjs and the synthetic upload set.
  const bytes = Buffer.from(`SYNTHETIC IPC BODY ${index}. Not a real user document.\n`);
  contents.set(itemId(index), bytes);
  entries.set(itemId(index), { id: itemId(index), parent: rootId, kind: "file", name: `synthetic-${String(index).padStart(4, "0")}.${extensions[index % extensions.length]}`,
    space_id: "personal", version: 1, modified: 1, size: bytes.length, digest: digest(bytes) });
}
const state = { phase: "ready", account: { phase: "authenticated", accountId: "synthetic-native-ipc-owner" }, connection: { mode: "local", deviceId: "synthetic-native-ipc-box" } };
const client = {
  snapshot: () => state, subscribe: () => () => {},
  async applicationConnection() {
    return { context: () => ({ writable: true }), async request(input) {
      assert.equal(input.method, "GET", "synthetic acceptance cannot mutate box source files");
      const url = new URL(input.path, "https://synthetic.invalid"), pieces = url.pathname.split("/").slice(3);
      let value, bytes;
      if (pieces[0] === "overview") value = { protocolVersion: 1 };
      else if (pieces[0] === "files" && pieces.length === 1) {
        const parent = url.searchParams.get("parent") || "";
        value = { parent, root: "", space_id: "personal", breadcrumbs: parent ? [{ id: rootId, name: "SYNTHETIC IPC QA" }] : [],
          items: [...entries.values()].filter(entry => entry.parent === parent) };
      } else if (pieces[0] === "files") {
        value = entries.get(pieces[1]); assert.ok(value, "only synthetic file ids can be read");
        if (pieces[2] === "content") {
          const body = contents.get(value.id), offset = Number(url.searchParams.get("offset") || 0), length = Number(url.searchParams.get("length") || body.length);
          bytes = body.subarray(offset, offset + length);
        }
      } else throw Error(`Unexpected synthetic request: ${input.path}`);
      return { status: 200, headers: bytes ? { "x-content-sha256": digest(bytes), "x-file-sha256": value.digest } : {}, body: bytes ?? Buffer.from(JSON.stringify(value)) };
    } };
  },
};
const safeStorage = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "synthetic_aes_gcm",
  encryptString(text) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  },
  decryptString(bytes) {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  },
};
const stores = Object.fromEntries(["transfers", "annotations", "jobs"].map(name => [name, createSecureAccountStore({ filePath: path.join(profile, `${name}.enc`), safeStorage })]));
let atomicCommits = 0;
const annotationStore = { load: () => stores.annotations.load(), async save(value) {
  const records = new Map(value.records.map(record => [record.id, record]));
  for (const receipt of value.batchReceipts || []) for (const item of receipt.items) if (item.status === "applied") {
    assert.ok(records.get(item.id)?.revision >= item.postRevision, "receipt and its annotation revision must commit together");
  }
  if (value.batchReceipts?.length) atomicCommits++;
  await stores.annotations.save(value);
} };

// Executed by the sandboxed renderer's own HTML script; there is no Node API,
// test preload or webContents.executeJavaScript shim in this chain.
async function rendererTest(config) {
  const { phase, rootId, allTag, crossTag } = config;
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const action = async (name, input) => {
    const result = await window.wanxClient.action(name, input);
    assert(result.ok, `${name}: ${result.code}`); return result.value;
  };
  const op = (op, input = {}) => action("space.annotation-workbench", { op, ...input });
  const wait = async work => {
    const until = Date.now() + 25_000;
    do { const value = await work(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < until);
    throw Error("Synthetic native IPC operation timed out");
  };
  const idle = jobId => wait(async () => { const value = await op("list", { jobId, limit: 200 }); return !["scanning", "applying", "suggesting", "undoing"].includes(value.job.status) ? value : null; });
  assert(typeof require === "undefined" && typeof process === "undefined", "renderer Node access must stay disabled");
  assert(window.wanxClient && typeof window.wanxClient.action === "function", "production preload was not exposed");
  if (phase === "foreign") {
    let denied;
    try { const result = await window.wanxClient.action("space.annotation-workbench", { op: "models" }); denied = result.ok ? "" : result.code; }
    catch (error) { denied = String(error.message || error); }
    assert(/无权/.test(denied), "another renderer must not reach the trusted control handler");
    return { foreignRendererRejected: true };
  }
  const models = await op("models"); assert(models.presets.some(preset => preset.id === "rules"), "manual/local rules must work without an AI model");
  const invalid = await window.wanxClient.action("space.annotation-workbench", { op: "arbitrary-url", url: "https://synthetic.invalid" });
  assert(!invalid.ok && /SPACE_ANNOTATION_INVALID/.test(invalid.code), "preload must reject operations outside the fixed contract");
  const opened = await op("open", { space_id: "personal", parent: rootId }), jobId = opened.job.id;
  const first = await wait(async () => { const value = await op("list", { jobId, limit: 200 }); return value.job.scanComplete ? value : null; });
  assert(first.total === 1000 && first.items.length === 200, "scan manifest must cover all 1000 files while paging renderer rows");
  const second = await op("list", { jobId, offset: 200, limit: 200 });
  assert(second.items.length === 200 && second.items[0].id !== first.items[0].id, "page selection must span distinct files");
  const ids = [first.items[0].id, second.items[0].id];
  const apply = async (selection, tags) => {
    const plan = await op("prepare", { jobId, selection, change: { tagMode: "add", tags, descriptionMode: "keep" } });
    await op("apply", { jobId, planId: plan.planId }); const result = await idle(jobId);
    assert(result.job.status === "complete", "synthetic batch should complete without conflicts"); return plan;
  };
  if (phase === "write") {
    const cross = await apply({ ids }, [crossTag]); assert(cross.changeCount === 2, "cross-page selection should change exactly two targets");
    const before = await action("space.annotation", { id: ids[0] });
    await op("apply", { jobId, planId: cross.planId }); await idle(jobId);
    assert((await action("space.annotation", { id: ids[0] })).revision === before.revision, "duplicate submission must not create another revision");
    const untouched = await action("space.annotation", { id: first.items[1].id });
    assert(!untouched.tags.includes(crossTag), "cross-page selection cannot affect unselected files");
    const all = await apply({ allMatching: {} }, [allTag]); assert(all.changeCount === 1000, "full-filter manifest must commit every target");
    const page = await op("list", { jobId, offset: 800, limit: 200 });
    assert(page.items.every(row => row.annotation.tags.includes(allTag) && row.status === "confirmed"), "last page must expose persisted human labels");
    await op("draft", { jobId, id: ids[0], patch: { description: "SYNTHETIC UNSUBMITTED DRAFT" } });
    return { jobId, ids, files: all.targetCount, crossPageTargets: cross.changeCount, rendererSandboxed: true };
  }
  assert(first.items.every(row => row.annotation.tags.includes(allTag)), "a new Electron process must restore annotations");
  assert(first.items[0].draft?.description === "SYNTHETIC UNSUBMITTED DRAFT", "encrypted task drafts must survive process restart without applying themselves");
  const annotation = await action("space.annotation", { id: ids[0] });
  assert(annotation.description !== "SYNTHETIC UNSUBMITTED DRAFT", "restored draft must remain unsubmitted");
  const matches = await action("space.search-annotations", { query: allTag, parent: rootId, limit: 100 });
  assert(matches.items.length === 100 && matches.items.every(row => row.annotation.tags.includes(allTag)), "Space search must consume the same persisted label index");
  const preview = await action("space.preview", { id: ids[0] });
  assert(atob(preview.data).includes("SYNTHETIC IPC BODY 0"), "a recalled authorized file must retain its actual content");
  await op("undo", { jobId }); const undone = await idle(jobId);
  assert(undone.job.undone && undone.items.every(row => !row.annotation.tags.includes(allTag)), "undo must restore the latest batch after a process restart");
  const retained = await Promise.all(ids.map(id => action("space.annotation", { id })));
  assert(retained.every(row => row.tags.includes(crossTag)), "undo must preserve earlier independent human edits");
  return { jobId, restoredFiles: first.total, searchMatches: matches.items.length, undoRestored: 1000, retainedEarlierEdits: 2, rendererSandboxed: true };
}

let service, control;
const windows = new Set();
async function testWindow(htmlFile, phase, trusted = false) {
  const url = pathToFileURL(htmlFile); url.searchParams.set("phase", phase);
  const window = new BrowserWindow({ show: false, webPreferences: { preload: fileURLToPath(new URL("../../local-ui/remote-preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windows.add(window); window.on("closed", () => windows.delete(window));
  if (trusted) {
    control = window;
    registerControlActions({ ipcMain, control, controlURL: url.href, client, personalSpace: service, getState: () => structuredClone(state) });
  }
  const result = new Promise((resolve, reject) => {
    window.webContents.on("console-message", event => {
      if (event.message.startsWith("ANNOTATION_RENDERER_RESULT ")) resolve(JSON.parse(event.message.slice("ANNOTATION_RENDERER_RESULT ".length)));
      if (event.message.startsWith("ANNOTATION_RENDERER_ERROR ")) reject(Error(event.message.slice("ANNOTATION_RENDERER_ERROR ".length)));
    });
    window.webContents.once("render-process-gone", (_event, details) => reject(Error(`Synthetic renderer ended: ${details.reason}`)));
    window.webContents.once("preload-error", (_event, _file, cause) => reject(cause));
  });
  await window.loadURL(url.href);
  return { window, value: await result };
}
async function verify() {
try {
  await app.whenReady(); app.dock?.hide();
  console.log("ANNOTATION_NATIVE_STAGE app-ready");
  service = await createPersonalSpace({ client, serviceURL: "https://synthetic.invalid", store: stores.transfers, annotationStore, workbenchStore: stores.jobs });
  const htmlFile = path.join(profile, "synthetic-native-ipc.html");
  const config = { rootId, allTag, crossTag };
  await writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-synthetic-native-ipc'"><title>Synthetic annotation IPC acceptance</title><script nonce="synthetic-native-ipc">(${rendererTest.toString()})({...${JSON.stringify(config)},phase:new URL(location.href).searchParams.get('phase')}).then(value=>console.log('ANNOTATION_RENDERER_RESULT '+JSON.stringify(value))).catch(error=>console.error('ANNOTATION_RENDERER_ERROR '+String(error.stack||error)));</script>`);
  console.log("ANNOTATION_NATIVE_STAGE service-ready");
  const trusted = await testWindow(htmlFile, phase, true);
  const foreign = await testWindow(htmlFile, "foreign"); foreign.window.destroy();
  const saved = await stores.annotations.load(), records = saved.records.filter(row => row.kind === "file");
  assert.equal(records.length, 1000);
  if (phase === "write") {
    assert.ok(records.every(row => row.manual?.tags?.includes(allTag)));
    assert.equal(saved.batchReceipts.length, 21);
    assert.ok(saved.batchReceipts.every(receipt => receipt.items.length <= 50));
    assert.ok(atomicCommits >= 21);
    for (const name of ["annotations", "jobs"]) {
      const bytes = await readFile(path.join(profile, `${name}.enc`));
      assert.ok(!bytes.includes(Buffer.from(allTag)), "private labels cannot appear as plaintext in the encrypted store");
      assert.throws(() => JSON.parse(bytes.toString("utf8")));
    }
  } else {
    assert.ok(records.every(row => !row.manual?.tags?.includes(allTag)));
    assert.equal(records.filter(row => row.manual?.tags?.includes(crossTag)).length, 2);
  }
  await service.close(); service = null;
  trusted.window.destroy();
  console.log("ANNOTATION_WORKBENCH_ELECTRON_PASS " + JSON.stringify({ phase, pid: process.pid, ...trusted.value, ...foreign.value,
    ...(phase === "write" ? { batchReceipts: saved.batchReceipts.length, atomicCommits } : {}) }));
  app.exit(0);
} catch (error) {
  console.error(error);
  await service?.close().catch(() => {});
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(1);
}
}
void verify();
