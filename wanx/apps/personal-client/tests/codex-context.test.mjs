import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexContext } from "../shell/codex-context.mjs";
import { createMyAiTask } from "../shell/my-ai-task.mjs";

test("Codex MCP connects once and keeps concurrent grants separate, expiring or revoking access", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const descriptor = path.join(dir, "descriptor.json");
  let scope = "fixture-account/box-one";
  let now = Date.now();
  const calls = [];
  const context = createCodexContext({
    scope: () => scope, now: () => now, descriptor,
    configure: { ensure: async () => {}, isConfigured: async () => true },
    sources: {
      catalog: async () => ({ folders: [], warehouses: [] }),
      async validate(folderId, warehouseId, check) {
        check();
        return { folderId, warehouseId, folderName: "空间\n项目\u202eA", warehouseName: "星图知识库" };
      },
      async call(selection, tool, args, check) {
        check();
        calls.push({ selection, tool });
        return { project: selection.folderId, warehouse: selection.warehouseId, input: args.fileId ?? args.query };
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
  const urls = [];
  const task = createMyAiTask({
    codexContext: context, protocolRegistered: () => true,
    openExternal: async value => { urls.push(new URL(value)); },
  });
  const first = { folderId: "folder-a", warehouseId: "warehouse-a" };
  const second = { folderId: "folder-b", warehouseId: "warehouse-b" };
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
  assert.equal(catalog.result.tools.length, 4);
  assert.equal((await invoke("space_search", ids[0])).isError, undefined);
  assert.equal((await invoke("starlink_search", ids[1])).isError, undefined);
  assert.deepEqual(calls.map(({ selection, tool }) => ({ folderId: selection.folderId, warehouseId: selection.warehouseId, tool })), [
    { ...first, tool: "space_search" }, { ...second, tool: "starlink_search" },
  ]);
  assert.equal((await invoke("space_search", ids[0], { folderId: "folder-b", query: "marker" })).isError, true);
  assert.equal((await invoke("space_search", "a".repeat(36))).isError, true);
  const spaceOnly = await context.prepare({ folderId: "folder-a" }, assertScope);
  const starlinkOnly = await context.prepare({ warehouseId: "warehouse-a" }, assertScope);
  assert.deepEqual(spaceOnly.resources, { folder: { id: "folder-a", name: "空间 项目 A" } });
  assert.deepEqual(starlinkOnly.resources, { warehouse: { id: "warehouse-a", name: "星图知识库" } });
  assert.ok(!spaceOnly.instruction.includes("starlink_search") && !starlinkOnly.instruction.includes("space_search"));
  assert.equal((await invoke("starlink_search", spaceOnly.taskId)).isError, true);
  assert.equal((await invoke("space_search", starlinkOnly.taskId)).isError, true);
  assert.equal(calls.length, 2);
  assert.equal((await invoke("space_search", spaceOnly.taskId)).isError, undefined);
  assert.equal((await invoke("starlink_search", starlinkOnly.taskId)).isError, undefined);
  now += 2 * 60 * 60 * 1000;
  assert.equal((await invoke("space_search", ids[1])).isError, true);
  const reference = await context.prepare(first, assertScope);
  scope = "fixture-account/box-two";
  context.sync();
  scope = "fixture-account/box-one";
  const id = reference.instruction.match(/task_id: ([a-f0-9]{36})/)[1];
  assert.equal((await invoke("space_search", id)).isError, true);
  await context.manage("disconnect", {}, assertScope);
  assert.equal((await context.manage("status", {}, assertScope)).connected, false);
});
