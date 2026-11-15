import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCodexContext } from "../shell/codex-context.mjs";
import { accessAgentId, createMyAiAccess, createMyAiMemoryAccess } from "../shell/my-ai-access.mjs";
import { createMyAiMcpConfig } from "../shell/my-ai-mcp-config.mjs";

// Exercise the real HTTP/RPC handler without requiring a listening socket in
// the executor sandbox. Requests still pass descriptor-token authentication.
function listenerHarness(port) {
  let handle;
  return {
    createListener(callback) {
      handle = callback;
      return Object.assign(new EventEmitter(), {
        listen(_port, _host, done) { done(); }, address: () => ({ port }),
        close() {}, closeAllConnections() {},
      });
    },
    async request(descriptor, method, params, headers = {}) {
      const { token } = JSON.parse(await readFile(descriptor, "utf8"));
      return new Promise(resolve => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))]), {
          method: "POST", url: "/mcp", headers: { host: "127.0.0.1:" + port, authorization: "Bearer " + token, ...headers },
        });
        let status;
        handle(request, {
          writeHead(value) { status = value; },
          end(payload) { resolve({ status, ...(payload && JSON.parse(payload)) }); },
        });
      });
    },
  };
}

async function fixture(t, agent = "gemini") {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-scoped-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeFile = path.join(home, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:19535", localToken: "fixture-token" }));
  let owner = "owner-a", box = "box-a", scope = "session-a", saved, healthy = true;
  const requests = [], sourceCalls = [], memories = new Map();
  const memory = createMyAiMemoryAccess({ runtimeFile, async request(url, options) {
    assert.equal(options.headers["x-memmy-local-token"], "fixture-token");
    const body = options.body && JSON.parse(options.body);
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/api/v1/health") return Response.json({ ok: healthy, storage: { ready: healthy } });
    if (url.pathname === "/api/v1/memory/add") {
      const previous = memories.get(body.requestId);
      if (previous && JSON.stringify(previous.body) !== JSON.stringify(body)) return Response.json({}, { status: 409 });
      const result = previous ?? { body, id: "memory_" + (memories.size + 1) };
      memories.set(body.requestId, result);
      return Response.json({ id: result.id, duplicate: Boolean(previous) });
    }
    if (url.pathname === "/api/v1/memory/search") return Response.json({ debug: { hits: [{ id: "memory_1", title: "Fixture" }] } });
    return Response.json({ item: { id: url.pathname.split("/").at(-1), body: "Fixture memory" } });
  } });
  const sources = {
    async validate(folderId, warehouseId, check) {
      check();
      if (folderId === "forbidden") throw new Error("not allowed");
      return { ...(folderId && { folderId, folderName: "Folder " + folderId }),
        ...(warehouseId && { warehouseId, warehouseName: "Warehouse " + warehouseId }) };
    },
    async catalog() { return { folders: [], warehouses: [] }; },
    async direct() { throw new Error("unrestricted source access must never be used"); },
    async call(selection, name, args, check) {
      check(); sourceCalls.push({ selection, name, args });
      return { text: "Fixture source", matches: [{ fileId: "file-a", snippet: "Fixture source" }] };
    },
  };
  const descriptor = path.join(home, "endpoint.json");
  const harness = listenerHarness(24511);
  const config = createMyAiMcpConfig(agent, { home, env: {}, stdioPath: path.join(home, "bridge.mjs"), descriptorPath: descriptor });
  const access = createMyAiAccess({ agents: [agent], sources, memory,
    owner: () => owner, box: () => box, scope: () => scope,
    store: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
    makeContext(_agent, direct) { return createCodexContext({
      sources, scope: () => scope, configure: config, descriptor, direct, createListener: harness.createListener,
    }); },
  });
  t.after(() => access.close());
  const check = () => {};
  const rpc = (method, params, headers) => harness.request(descriptor, method, params, headers);
  return { access, home, config, descriptor, check, requests, sourceCalls, memories, agent, rpc,
    changeScope(value) { scope = value; access.sync(); },
    owner(value) { owner = value; }, box(value) { box = value; },
    healthy(value) { healthy = value; },
    async state() { return (await access.status(check))[agent]; },
    async call(name, args = {}) { return (await rpc("tools/call", { name, arguments: args })).result; },
    data(reply) { assert.notEqual(reply.isError, true, reply.content?.[0]?.text); return JSON.parse(reply.content[0].text); },
  };
}

test("configuration is not reported as client loading or successful retrieval; selected scope is enforced", async t => {
  const h = await fixture(t);
  const selected = await h.access.selection(h.agent, { folderId: "folder-a", warehouseId: "warehouse-a" }, h.check);
  assert.equal(selected.resources.folder.name, "Folder folder-a");
  const connected = await h.access.connect(h.agent, h.check);
  assert.equal(connected.configured, true);
  assert.equal(connected.serviceReady, true);
  assert.equal(connected.loaded, false);
  assert.equal(connected.available, false);
  assert.equal((await h.rpc("tools/list")).result.tools.find(tool => tool.name === "memory_save").annotations.readOnlyHint, false);
  assert.equal((await h.state()).loaded, true);
  assert.equal((await h.state()).retrievalVerified, false);
  assert.equal((await h.call("memory_search", { query: "fixture" })).isError, true);
  h.data(await h.call("space_search", { query: "fixture" }));
  assert.equal(h.sourceCalls[0].selection.folderId, "folder-a");
  assert.equal((await h.state()).retrievalVerified, false);
  assert.equal((await h.call("starlink_search", { warehouseId: "warehouse-b", query: "fixture" })).isError, true);
  assert.equal(h.sourceCalls.length, 1);
  h.data(await h.call("starlink_search", { query: "fixture" }));
  assert.equal(h.sourceCalls[1].selection.warehouseId, "warehouse-a");
  assert.equal((await h.state()).retrievalVerified, false);
  h.data(await h.call("space_read", { fileId: "file-a" }));
  h.data(await h.call("starlink_evidence", { evidenceId: "evidence-a" }));
  assert.equal((await h.state()).retrievalVerified, true);
  assert.equal((await h.state()).available, true);
  h.healthy(false);
  assert.equal((await h.state()).available, false);
  assert.equal((await h.state()).serviceReady, false);
  h.healthy(true);
  assert.equal((await h.call("space_list", { folderId: "folder-b" })).isError, true);
  assert.deepEqual(h.data(await h.call("space_list")).items.map(row => row.id), ["folder-a"]);
  assert.equal((await h.rpc("tools/list", {}, { origin: "https://example.test" })).status, 403);
});

test("memory_save works with recall off, derives durable idempotency and cannot spoof the source", async t => {
  const h = await fixture(t);
  await h.access.connect(h.agent, h.check);
  const first = h.data(await h.call("memory_save", { content: "A wholly fictional memory.", idempotencyKey: "fixture-1" }));
  const second = h.data(await h.call("memory_save", { content: "A wholly fictional memory.", idempotencyKey: "fixture-1" }));
  assert.equal(first.saved, true); assert.equal(first.memoryId, second.memoryId); assert.equal(second.duplicate, true);
  assert.equal(h.memories.size, 1);
  const added = h.requests.find(row => row.path.endsWith("/add")).body;
  assert.equal(added.source, "gemini"); assert.equal(added.sourceAgentId, "gemini");
  assert.equal(added.adapterId, "my-ai:gemini"); assert.match(added.requestId, /^[a-f0-9]{64}$/);
  assert.equal((await h.call("memory_save", { content: "changed", idempotencyKey: "fixture-1" })).isError, true);
  assert.equal((await h.call("memory_save", { content: "fixture", source: "another-agent" })).isError, true);
  assert.equal((await h.state()).memorySaved, first.memoryId);
  assert.equal((await h.state()).available, false);
});

test("memory-only task grants and current selection revocation also cover task-id tool calls", async t => {
  const h = await fixture(t);
  await h.access.selection(h.agent, { memoryEnabled: true }, h.check);
  await h.access.connect(h.agent, h.check);
  const task = await h.access.context(h.agent).prepare({ memoryEnabled: true }, h.check);
  assert.match(task.instruction, /memory_search\/memory_read/);
  h.data(await h.call("memory_search", { query: "fixture", task_id: task.taskId }));
  assert.equal((await h.state()).retrievalVerified, false);
  h.data(await h.call("memory_read", { memoryId: "memory_1", task_id: task.taskId }));
  assert.equal((await h.state()).retrievalVerified, true);
  assert.equal((await h.call("space_search", { query: "fixture", task_id: task.taskId })).isError, true);
  await h.access.selection(h.agent, { memoryEnabled: false }, h.check);
  assert.equal((await h.call("memory_search", { query: "fixture", task_id: task.taskId })).isError, true);
  assert.equal((await h.call("memory_search", { query: "fixture" })).isError, true);
  const saved = h.data(await h.call("memory_save", { content: "Explicit save is independent of recall." }));
  assert.equal(saved.saved, true);
  await h.access.disconnect(h.agent, h.check);
  assert.equal((await h.state()).serviceReady, false);
  await assert.rejects(h.call("memory_save", { content: "revoked" }), { code: "ENOENT" });
});

test("preferences are bound to owner and box, and returning to a box restores only its choices", async t => {
  const h = await fixture(t);
  await h.access.selection(h.agent, { folderId: "folder-a", memoryEnabled: true }, h.check);
  await h.access.connect(h.agent, h.check);
  h.owner("owner-b"); h.changeScope("session-b");
  assert.deepEqual((await h.access.selection(h.agent, undefined, h.check)).selection, { memoryEnabled: false });
  assert.equal((await h.call("space_search", { query: "fixture" })).isError, true);
  h.owner("owner-a"); h.box("box-b"); h.changeScope("session-c");
  assert.deepEqual((await h.access.selection(h.agent, undefined, h.check)).selection, { memoryEnabled: false });
  await h.access.selection(h.agent, { folderId: "folder-b" }, h.check);
  h.box("box-a"); h.changeScope("session-d");
  assert.deepEqual((await h.access.selection(h.agent, undefined, h.check)).selection, { folderId: "folder-a", memoryEnabled: true });
  assert.equal((await h.state()).serviceReady, false);
  await h.access.connect(h.agent, h.check);
  h.data(await h.call("space_search", { query: "fixture" }));
  assert.equal(h.sourceCalls.at(-1).selection.folderId, "folder-a");
});

test("guided connectors export local stdio settings and become configured only after actual client use", async t => {
  const h = await fixture(t, "workbuddy");
  const connected = await h.access.connect(h.agent, h.check);
  assert.equal(connected.guided, true); assert.equal(connected.configured, false); assert.equal(connected.loaded, false);
  const config = await h.access.configuration(h.agent, h.check);
  assert.equal(typeof config.mcpServers["wanx-memobox"].command, "string");
  assert.equal(JSON.stringify(config).includes("fixture-token"), false);
  await assert.rejects(readFile(path.join(h.home, ".workbuddy", "mcp.json")), { code: "ENOENT" });
  await h.rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal((await h.state()).configured, true); assert.equal((await h.state()).retrievalVerified, false);
});

test("a body read for a different task scope cannot verify the remembered default scope", async t => {
  const h = await fixture(t);
  await h.access.selection(h.agent, { folderId: "folder-a" }, h.check);
  await h.access.connect(h.agent, h.check);
  const task = await h.access.context(h.agent).prepare({ folderId: "folder-b" }, h.check);
  h.data(await h.call("space_read", { fileId: "file-b", task_id: task.taskId }));
  assert.equal((await h.state()).retrievalVerified, false);
  const defaultTask = await h.access.context(h.agent).prepare({ folderId: "folder-a" }, h.check);
  h.data(await h.call("space_read", { fileId: "file-a", task_id: defaultTask.taskId }));
  assert.equal((await h.state()).retrievalVerified, true);
  await h.access.selection(h.agent, { folderId: "folder-a" }, h.check);
  assert.equal((await h.state()).retrievalVerified, true);
});

test("a successful HTTP response without a stored memory ID is never reported as saved", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-save-invalid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeFile = path.join(home, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:19535", localToken: "fixture-token" }));
  const memory = createMyAiMemoryAccess({ runtimeFile, request: async () => Response.json({ accepted: true }) });
  await assert.rejects(memory.call("memory_save", { content: "Fictional unsaved memory" }, () => {}, "gemini", "fixture-binding"), /未返回已保存的记忆标识/);
});

test("zero-scope tasks reject omitted IDs and cannot fall back to a wider product selection", async t => {
  const h = await fixture(t);
  await h.access.selection(h.agent, { folderId: "folder-a", memoryEnabled: true }, h.check);
  await h.access.connect(h.agent, h.check);
  const denied = await h.access.context(h.agent).prepare({ memoryEnabled: false }, h.check);
  assert.match(denied.instruction, /No retrieval sources/);
  assert.equal((await h.state()).taskIdRequired, true);
  const omitted = await h.call("space_read", { fileId: "file-a" });
  assert.equal(omitted.isError, true); assert.match(omitted.content[0].text, /task_id/);
  assert.equal((await h.call("space_search", { query: "fixture", task_id: denied.taskId })).isError, true);
  assert.equal((await h.call("memory_search", { query: "fixture", task_id: denied.taskId })).isError, true);
  assert.equal(h.sourceCalls.length, 0);
  const allowed = await h.access.context(h.agent).prepare({ folderId: "folder-b" }, h.check);
  h.data(await h.call("space_read", { fileId: "file-b", task_id: allowed.taskId }));
  assert.equal(h.sourceCalls[0].selection.folderId, "folder-b");
  denied.revoke(); allowed.revoke();
  assert.equal((await h.state()).taskIdRequired, false);
  h.data(await h.call("space_read", { fileId: "file-a" }));
  assert.equal(h.sourceCalls.at(-1).selection.folderId, "folder-a");
});

test("launcher aliases share a product integration without sharing Claude Chat and Code configs", () => {
  assert.equal(accessAgentId("codex_cli"), "codex");
  assert.equal(accessAgentId("claude_desktop", "code"), "claude_code");
  assert.equal(accessAgentId("claude_desktop", "chat"), "claude_desktop");
  assert.equal(accessAgentId("claude_desktop", "cowork"), null);
});
