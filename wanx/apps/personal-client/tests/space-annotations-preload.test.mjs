import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { registerControlActions } from "../shell/control.mjs";

const source = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
const methods = ["annotation", "set-annotation", "auto-annotate", "search-annotations"];
const input = { id: "a".repeat(32), space_id: "personal", expectedRevision: 3, tags: ["synthetic"],
  description: "Synthetic annotation", inherit: true, reviewed: true, query: "synthetic", parent: "b".repeat(32) };

function harness() {
  const handlers = new Map(), ipcCalls = [], operations = [], exposed = {};
  const frame = { url: "file:///client/local-ui/renderer/index.html" }, webContents = { mainFrame: frame };
  const event = { sender: webContents, senderFrame: frame };
  let failure = null;
  registerControlActions({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url,
    client: { snapshot: () => ({ account: { phase: "authenticated", accountId: "synthetic-owner" } }) },
    personalSpace: { async preview() {
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      return { type: "text/plain", data: "dGVzdA==" };
    }, async operation(method, value) {
      operations.push([method, value]);
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      return { method, annotation: { revision: 4, tags: ["synthetic"] } };
    } },
  });
  vm.runInNewContext(source, {
    process: { platform: "darwin" },
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        ipcRenderer: { on() {}, removeListener() {}, async invoke(channel, value) {
          ipcCalls.push([channel, value]);
          const handler = handlers.get(channel);
          assert.ok(handler, `main-process handler exists for ${channel}`);
          return handler(event, value);
        } },
      };
    },
  });
  return { api: exposed.wanxClient, ipcCalls, operations, handlers, event, fail(code) { failure = code; } };
}

for (const method of methods) {
  test(`real preload and control forward space.${method} without dropping annotation parameters`, async () => {
    const h = harness();
    const result = await h.api.action(`space.${method}`, input);
    assert.equal(result.ok, true);
    assert.equal(result.value.method, method);
    assert.deepEqual(Array.from(result.value.annotation.tags), ["synthetic"]);
    assert.deepEqual(h.ipcCalls.filter(([channel]) => channel !== "wanx-client:get-state"), [[`wanx-client:space-${method}`, input]]);
    assert.deepEqual(h.operations, [[method, input]]);
  });
}

test("annotation failures retain their main-process error codes through the real preload bridge", async () => {
  const h = harness();
  for (const [method, code] of [["annotation", "SPACE_ANNOTATION_UNAVAILABLE"], ["set-annotation", "SPACE_ANNOTATION_CONFLICT"],
    ["auto-annotate", "SPACE_ANNOTATION_READ_ONLY"], ["search-annotations", "SPACE_CONTEXT_CHANGED"]]) {
    h.fail(code);
    const result = await h.api.action(`space.${method}`, input);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
});

test("preview download-only outcomes cross IPC without an Electron handler error", async () => {
  const h = harness();
  const handle = h.handlers.get("wanx-client:space-preview");
  for (const code of ["SPACE_PREVIEW_DOWNLOAD", "SPACE_PREVIEW_TOO_LARGE", "SPACE_PREVIEW_UNSUPPORTED"]) {
    h.fail(code);
    assert.deepEqual(await handle(h.event, input), { previewRejection: code });
    const result = await h.api.action("space.preview", input);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
  h.fail("SPACE_CHUNK_INVALID");
  await assert.rejects(handle(h.event, input), { code: "SPACE_CHUNK_INVALID" });
  h.fail(null);
  assert.equal((await h.api.action("space.preview", input)).value.data, "dGVzdA==");
});

test("annotation bridge keeps unknown operations closed and main-process sender checks intact", async () => {
  const h = harness();
  for (const method of ["annotation-arbitrary", "annotation-bind", "annotation-stage-import", "annotation-pending-imports"]) {
    const result = await h.api.action(`space.${method}`, input);
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNKNOWN_CLIENT_ACTION");
  }
  assert.equal(h.operations.length, 0);
  assert.equal(h.ipcCalls.filter(([channel]) => channel !== "wanx-client:get-state").length, 0);
  for (const method of methods) {
    const handler = h.handlers.get(`wanx-client:space-${method}`);
    assert.throws(() => handler({ ...h.event, senderFrame: { url: h.event.senderFrame.url } }, input), /无权/);
  }
});
