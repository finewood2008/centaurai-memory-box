import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexContext } from "../shell/codex-context.mjs";
import { createMyAiTask } from "../shell/my-ai-task.mjs";
import { nativeCatalog, nativeResult, nativeTools, warehouseA, warehouseB } from "./fixtures/semantica-mcp.mjs";

function localListener(onListen) {
  return () => Object.assign(new EventEmitter(), {
    listen(port, host, done) { onListen(this, port, host, done); },
    address: () => ({ port: 24512 }),
    close() {}, closeAllConnections() {},
  });
}

test("starts the loopback service before registering the Agent and repairs a missing endpoint", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memobox-context-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const descriptor = path.join(dir, "endpoint.json");
  let listenFailed = true, ensureCalls = 0;
  const check = () => {};
  const context = createCodexContext({
    descriptor, scope: () => "fixture-account/box-one", sources: {},
    createListener: localListener((listener, port, host, done) => {
      assert.equal(port, 0);
      assert.equal(host, "127.0.0.1");
      if (listenFailed) listener.emit("error", new Error("fixture listen failure"));
      else done();
    }),
    configure: {
      async ensure() {
        ensureCalls++;
        assert.equal(JSON.parse(await readFile(descriptor, "utf8")).port, 24512);
      },
    },
  });
  t.after(() => context.close());
  await assert.rejects(context.manage("connect", {}, check), { code: "MY_AI_MCP_START_FAILED" });
  assert.equal(ensureCalls, 0);
  assert.equal((await context.manage("status", {}, check)).serviceReady, false);
  listenFailed = false;
  assert.equal((await context.manage("connect", {}, check)).serviceReady, true);
  const previous = await readFile(descriptor, "utf8");
  await rm(descriptor);
  assert.equal((await context.manage("connect", {}, check)).serviceReady, true);
  assert.equal(await readFile(descriptor, "utf8"), previous);
});

test("restores a missing endpoint only for an already authorized and configured Agent", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "memobox-context-restore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const descriptor = path.join(dir, "endpoint.json");
  let access, configured = false;
  const check = () => {};
  const context = createCodexContext({
    descriptor, scope: () => "fixture-account/box-one", sources: {},
    createListener: localListener((_listener, _port, _host, done) => done()),
    direct: { current: () => access },
    configure: { isConfigured: async () => configured },
  });
  t.after(() => context.close());
  configured = true;
  await context.restore(check);
  await assert.rejects(readFile(descriptor), { code: "ENOENT" });
  access = { selection: {} };
  configured = false;
  await context.restore(check);
  await assert.rejects(readFile(descriptor), { code: "ENOENT" });
  configured = true;
  await context.restore(check);
  assert.equal((await context.manage("status", {}, check)).serviceReady, true);
  assert.equal(JSON.parse(await readFile(descriptor, "utf8")).port, 24512);
  access = null;
  await assert.rejects(context.prepare({}, check), /连接当前智能体/);
});

test("Codex MCP connects once and keeps concurrent grants separate, expiring or revoking access", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const descriptor = path.join(dir, "descriptor.json");
  let scope = "fixture-account/box-one";
  let now = Date.now();
  let connectorConfigured = true;
  let nativeAvailable = true;
  const calls = [];
  const context = createCodexContext({
    scope: () => scope, now: () => now, descriptor,
    configure: { ensure: async () => {}, isConfigured: async () => connectorConfigured },
    sources: {
      mcpTools: async () => { if (!nativeAvailable) throw new Error("unavailable"); return nativeCatalog(); },
      catalog: async () => ({ folders: [], warehouses: [] }),
      async validate(folderId, warehouseId, check) {
        check();
        return { folderId, warehouseId, folderName: "空间\n项目\u202eA", warehouseName: "星图知识库" };
      },
      async call(selection, tool, args, check) {
        check();
        calls.push({ selection, tool, args });
        const result = { project: selection.folderId, warehouse: selection.warehouseId, input: args.fileId ?? args.query };
        return tool.startsWith("xingtu_") ? nativeResult(result) : result;
      },
    },
  });
  t.after(() => context.close());
  const assertScope = () => {};
  assert.deepEqual(await context.describe({ folderId: "folder-a" }, assertScope), { folder: { id: "folder-a", name: "空间 项目 A" } });
  await assert.rejects(context.describe({ folderId: null, warehouseId: "" }, assertScope), { status: 400 });
  assert.equal((await context.manage("status", {}, assertScope)).connected, false);
  const connected = await context.manage("connect", {}, assertScope);
  assert.equal(connected.connected, true);
  assert.equal(connected.available, false);
  assert.equal(connected.loaded, false);
  const tested = await context.manage("test", {}, assertScope);
  assert.equal(tested.connectionTested, true);
  assert.equal(tested.loaded, false);
  assert.equal(tested.retrievalVerified, false);
  assert.equal(calls.length, 0);
  const urls = [];
  const task = createMyAiTask({
    codexContext: context, protocolRegistered: () => true,
    openExternal: async value => { urls.push(new URL(value)); },
  });
  const first = { folderId: "folder-a", warehouseId: warehouseA };
  const second = { folderId: "folder-b", warehouseId: warehouseB };
  const submit = codexContext => task("handoff", { agent: "codex", text: "Inspect the test resource", codexContext }, assertScope);
  assert.deepEqual(await submit(first), { opened: true, delivery: "draft" });
  assert.deepEqual(await submit(second), { opened: true, delivery: "draft" });
  const ids = urls.map(url => url.searchParams.get("prompt").match(/task_id: ([a-f0-9]{36})/)[1]);
  assert.notEqual(ids[0], ids[1]);
  const { port, token } = JSON.parse(await readFile(descriptor, "utf8"));
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const rpc = (method, params, overrides = {}) => fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST", headers: { ...headers, ...overrides },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const invoke = async (name, task_id, args = { query: "marker" }) => {
    const response = await rpc("tools/call", { name, arguments: { task_id, ...args } });
    return (await response.json()).result;
  };
  assert.equal((await rpc("tools/list", {},{ origin: "http://evil.test" })).status, 403);
  const catalog = await (await rpc("tools/list")).json();
  assert.equal(catalog.result.tools.length, 6);
  assert.ok(catalog.result.tools.every(tool => !tool.name.startsWith("starlink_")));
  assert.deepEqual(catalog.result.tools.find(tool => tool.name === "xingtu_reasoning_search").inputSchema.properties.arguments,
    nativeTools.find(tool => tool.name === "xingtu_reasoning_search").inputSchema.properties.arguments);
  nativeAvailable = false;
  const degraded = (await (await rpc("tools/list")).json()).result;
  assert.deepEqual(degraded.tools.map(tool => tool.name), ["space_search", "space_read"]);
  assert.equal(degraded._meta.semantica, "unavailable");
  nativeAvailable = true;
  assert.equal((await context.manage("status", {}, assertScope)).loaded, true);
  connectorConfigured = false;
  await assert.rejects(context.manage("test", {}, assertScope), /配置缺失或已变更/);
  assert.equal((await context.manage("status", {}, assertScope)).connectionTested, false);
  connectorConfigured = true;
  assert.equal((await invoke("space_search", ids[0])).isError, undefined);
  assert.equal((await invoke("xingtu_search", ids[1])).isError, undefined);
  assert.deepEqual(calls.map(({ selection, tool }) => ({ folderId: selection.folderId, warehouseId: selection.warehouseId, tool })), [
    { ...first, tool: "space_search" }, { ...second, tool: "xingtu_search" },
  ]);
  assert.equal((await invoke("space_search", ids[0], { folderId: "folder-b", query: "marker" })).isError, true);
  assert.equal((await invoke("space_search", "a".repeat(36))).isError, true);
  const spaceOnly = await context.prepare({ folderId: "folder-a" }, assertScope);
  const starlinkOnly = await context.prepare({ warehouseId: warehouseA }, assertScope);
  assert.deepEqual(spaceOnly.resources, { folder: { id: "folder-a", name: "空间 项目 A" } });
  assert.deepEqual(starlinkOnly.resources, { warehouse: { id: warehouseA, name: "星图知识库" } });
  assert.ok(!spaceOnly.instruction.includes("xingtu_search") && !starlinkOnly.instruction.includes("space_search"));
  assert.equal((await invoke("xingtu_search", spaceOnly.taskId)).isError, true);
  assert.equal((await invoke("space_search", starlinkOnly.taskId)).isError, true);
  assert.equal(calls.length, 2);
  assert.equal((await invoke("space_search", spaceOnly.taskId)).isError, undefined);
  assert.equal((await invoke("xingtu_search", starlinkOnly.taskId)).isError, undefined);
  now += 2 * 60 * 60 * 1000;
  assert.equal((await invoke("space_search", ids[1])).isError, true);
  const reference = await context.prepare(first, assertScope);
  const nested = { arguments: { preparation_id: "preparation", query: "native arguments" } };
  const nativeReply = await invoke("xingtu_reasoning_search", reference.taskId, nested);
  assert.equal(nativeReply.isError, undefined);
  assert.ok(nativeReply.structuredContent);
  assert.deepEqual(calls.at(-1).args.arguments, nested.arguments);
  assert.equal((await invoke("starlink_search", reference.taskId)).isError, true);
  scope = "fixture-account/box-two";
  context.sync();
  scope = "fixture-account/box-one";
  const id = reference.instruction.match(/task_id: ([a-f0-9]{36})/)[1];
  assert.equal((await invoke("space_search", id)).isError, true);
  assert.equal((await invoke("xingtu_reasoning_search", id, nested)).isError, true);
  await context.manage("disconnect", {}, assertScope);
  assert.equal((await context.manage("status", {}, assertScope)).connected, false);
});
