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
import { nativeCatalog, nativeResult, warehouseA, warehouseB } from "./fixtures/semantica-mcp.mjs";

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
  let owner = "owner-a", box = "box-a", scope = "session-a", saved, memoryAvailable = true, unavailableSource;
  const requests = [], sourceCalls = [], memories = new Map();
  const memory = createMyAiMemoryAccess({ runtimeFile, async request(url, options) {
    assert.equal(options.headers["x-memmy-local-token"], "fixture-token");
    if (!memoryAvailable) throw new TypeError("fetch failed");
    const body = options.body && JSON.parse(options.body);
    requests.push({ path: url.pathname, body, ...(url.search && { query: Object.fromEntries(url.searchParams) }) });
    if (url.pathname === "/api/v1/health") return Response.json({ ok: true, storage: { ready: true } });
    if (url.pathname === "/api/v1/memory/add") {
      const previous = memories.get(body.requestId);
      if (previous && JSON.stringify(previous.body) !== JSON.stringify(body)) return Response.json({}, { status: 409 });
      const result = previous ?? { body, id: "memory_" + (memories.size + 1) };
      memories.set(body.requestId, result);
      return Response.json({ id: result.id, duplicate: Boolean(previous) });
    }
    if (url.pathname === "/api/v1/agent-sources") return Response.json({ sources: [
      { sourceId: "claude_code", displayName: "Claude Code", available: true },
      { sourceId: "gemini", displayName: "Gemini CLI", available: true },
    ] });
    if (url.pathname === "/api/v1/panel/items") {
      const source = url.searchParams.get("sourceAgent");
      return Response.json({ items: [{ id: source === "claude_code" ? "memory_claude" : "memory_1", title: "Fixture" }] });
    }
    if (url.pathname === "/api/v1/memory/search") return Response.json({ debug: { hits: [{ id: "memory_1", title: "Fixture" }, { id: "memory_claude", title: "Claude" }] } });
    const id = url.pathname.split("/").at(-1);
    return Response.json({ item: { id, body: "Fixture memory", status: "activated",
      metadata: { source: id === "memory_claude" ? "claude-code" : "gemini" } } });
  } });
  const sources = {
    mcpTools: async () => nativeCatalog(),
    async validate(folderId, warehouseId, check) {
      check();
      if (folderId === "forbidden") throw new Error("not allowed");
      if ((folderId && unavailableSource === "space") || (warehouseId && unavailableSource === "starlink"))
        throw new Error("source temporarily unavailable");
      return { ...(folderId && { folderId, folderName: "Folder " + folderId }),
        ...(warehouseId && { warehouseId, warehouseName: "Warehouse " + warehouseId }) };
    },
    async catalog() { return { folders: [], warehouses: [] }; },
    async direct() { throw new Error("unrestricted source access must never be used"); },
    async call(selection, name, args, check) {
      check(); sourceCalls.push({ selection, name, args });
      const result = { text: "Fixture source", matches: [{ fileId: "file-a", snippet: "Fixture source" }] };
      return name.startsWith("xingtu_") ? nativeResult(result) : result;
    },
  };
  const descriptor = path.join(home, "endpoint.json");
  const harness = listenerHarness(24511);
  const config = createMyAiMcpConfig(agent, { home, env: {}, stdioPath: path.join(home, "bridge.mjs"), descriptorPath: descriptor });
  const createAccess = (configure = config) => createMyAiAccess({ agents: [agent], sources, memory,
    owner: () => owner, box: () => box, scope: () => scope,
    store: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
    makeContext(_agent, direct) { return createCodexContext({
      sources, scope: () => scope, configure, descriptor, direct, createListener: harness.createListener,
    }); },
  });
  const access = createAccess();
  t.after(() => access.close());
  const check = () => {};
  const rpc = (method, params, headers) => harness.request(descriptor, method, params, headers);
  return { access, createAccess, home, config, descriptor, check, requests, sourceCalls, memories, agent, rpc,
    changeScope(value) { scope = value; access.sync(); },
    owner(value) { owner = value; }, box(value) { box = value; },
    memoryAvailable(value) { memoryAvailable = value; },
    unavailableSource(value) { unavailableSource = value; },
    async state() { return (await access.status(check))[agent]; },
    async call(name, args = {}) { return (await rpc("tools/call", { name, arguments: args })).result; },
    data(reply) { assert.notEqual(reply.isError, true, reply.content?.[0]?.text); return JSON.parse(reply.content[0].text); },
  };
}

test("a task can read one Agent's memory or all Agents without changing the save owner", async t => {
  const h = await fixture(t);
  assert.deepEqual((await h.access.memoryCatalog(h.check)).agents.map(source => source.id), ["claude_code", "gemini", "accessories"]);
  const chosen = { memoryEnabled: true, memoryAgent: "claude_code" };
  await h.access.selection(h.agent, chosen, h.check);
  assert.deepEqual((await h.access.selection(h.agent, undefined, h.check)).selection, chosen);
  await h.access.connect(h.agent, h.check);
  const context = h.access.context(h.agent);
  const onlyClaude = await context.prepare(chosen, h.check);
  const scoped = h.data(await h.call("memory_search", { query: "Fixture", task_id: onlyClaude.taskId }));
  assert.deepEqual(scoped.memoryIds, ["memory_claude"]);
  assert.equal(h.requests.find(request => request.path === "/api/v1/panel/items").query.sourceAgent, "claude_code");
  assert.equal((await h.call("memory_read", { memoryId: "memory_1", task_id: onlyClaude.taskId })).isError, true);
  assert.equal(h.data(await h.call("memory_read", { memoryId: "memory_claude", task_id: onlyClaude.taskId })).body, "Fixture memory");
  h.data(await h.call("memory_save", { content: "Save through Gemini.", task_id: onlyClaude.taskId }));
  assert.equal(h.requests.find(request => request.path === "/api/v1/memory/add").body.source, h.agent);

  const allAgents = await context.prepare({ memoryEnabled: true, memoryAgent: null }, h.check);
  const all = h.data(await h.call("memory_search", { query: "Fixture", task_id: allAgents.taskId }));
  assert.deepEqual(all.matches.map(hit => hit.memoryId), ["memory_1", "memory_claude"]);
  assert.equal(h.requests.find(request => request.path === "/api/v1/memory/search").body.source, undefined);
  assert.equal(h.data(await h.call("memory_read", { memoryId: "memory_1", task_id: allAgents.taskId })).body, "Fixture memory");
});

test("configuration is not reported as client loading or successful retrieval; selected scope is enforced", async t => {
  const h = await fixture(t);
  const selected = await h.access.selection(h.agent, { folderId: "folder-a", warehouseId: warehouseA }, h.check);
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
  assert.equal((await h.call("xingtu_search", { warehouseId: warehouseB, query: "fixture" })).isError, true);
  assert.equal(h.sourceCalls.length, 1);
  h.data(await h.call("xingtu_search", { query: "fixture" }));
  assert.equal(h.sourceCalls[1].selection.warehouseId, warehouseA);
  assert.equal((await h.state()).retrievalVerified, false);
  h.data(await h.call("space_read", { fileId: "file-a" }));
  h.data(await h.call("xingtu_evidence", { evidence_id: "evidence-a" }));
  assert.equal((await h.state()).retrievalVerified, true);
  assert.equal((await h.state()).available, true);
  h.memoryAvailable(false);
  assert.equal((await h.state()).available, true);
  assert.equal((await h.state()).serviceReady, true);
  assert.equal((await h.call("space_list", { folderId: "folder-b" })).isError, true);
  assert.deepEqual(h.data(await h.call("space_list")).items.map(row => row.id), ["folder-a"]);
  assert.equal((await h.rpc("tools/list", {}, { origin: "https://example.test" })).status, 403);
});

test("the MCP connection and each selected source survive an unrelated source outage", async t => {
  const h = await fixture(t);
  await h.access.selection(h.agent, { folderId: "folder-a", warehouseId: warehouseA, memoryEnabled: true }, h.check);
  h.memoryAvailable(false);
  assert.equal((await h.access.connect(h.agent, h.check)).serviceReady, true);

  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:24511/mcp");
    const { method, params } = JSON.parse(options.body);
    const { status, ...reply } = await h.rpc(method, params, { authorization: options.headers.authorization });
    return Response.json(reply, { status });
  });
  assert.equal((await h.access.test(h.agent, h.check)).connectionTested, true);
  const unavailableMemory = await h.call("memory_search", { query: "fixture" });
  assert.equal(unavailableMemory.isError, true);
  assert.match(unavailableMemory.content[0].text, /本机记忆服务暂不可用/);

  h.unavailableSource("starlink");
  h.data(await h.call("space_read", { fileId: "file-a" }));
  assert.equal((await h.call("xingtu_search", { query: "fixture" })).isError, true);
  h.unavailableSource("space");
  h.data(await h.call("xingtu_evidence", { evidence_id: "evidence-a" }));
  assert.equal((await h.state()).serviceReady, true);
  assert.equal((await h.state()).retrievalVerified, false);
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

test("restores the local MCP transport before P2P and reads all three sources only on the authorized box", async t => {
  const h = await fixture(t, "claude_desktop");
  const selection = { folderId: "folder-a", warehouseId: warehouseA, memoryEnabled: true };
  await h.access.selection(h.agent, selection, h.check);
  await h.access.connect(h.agent, h.check);
  const originalDescriptor = await readFile(h.descriptor, "utf8");
  await h.access.close();
  h.changeScope(null);
  h.box(null);

  const restarted = h.createAccess();
  t.after(() => restarted.close());
  await restarted.restore();
  const offline = (await restarted.status())[h.agent];
  assert.equal(offline.configured, true);
  assert.equal(offline.serviceReady, true);
  assert.equal(offline.boxReady, false);
  assert.equal(offline.authorized, false);
  const restoredDescriptor = await readFile(h.descriptor, "utf8");
  assert.notEqual(restoredDescriptor, originalDescriptor);
  assert.equal((await h.rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "wanx-memobox");
  assert.ok((await h.rpc("tools/list")).result.tools.some(tool => tool.name === "memory_save"));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:24511/mcp");
    assert.equal(JSON.parse(options.body).method, "ping");
    const { status, ...reply } = await h.rpc("ping", undefined, { authorization: options.headers.authorization });
    return Response.json(reply, { status });
  });
  const tested = await restarted.test(h.agent, h.check);
  assert.equal(tested.connectionTested, true);
  assert.equal(tested.boxReady, false);
  assert.equal(tested.retrievalVerified, false);
  const reads = [["space_read", { fileId: "file-a" }], ["xingtu_evidence", { evidence_id: "evidence-a" }],
    ["memory_read", { memoryId: "memory_1" }]];
  for (const [name, args] of reads) assert.equal((await h.call(name, args)).isError, true);

  h.box("box-b");
  h.changeScope("session-b");
  await restarted.restore();
  assert.equal((await restarted.status())[h.agent].serviceReady, false);
  await assert.rejects(restarted.test(h.agent, h.check), /配置智能体的本机连接/);
  for (const [name, args] of reads) assert.equal((await h.call(name, args)).isError, true);
  assert.equal(h.sourceCalls.length, 0);
  assert.equal(h.requests.length, 0);

  h.box("box-a");
  h.changeScope("session-a");
  restarted.sync();
  await restarted.restore();
  const ready = (await restarted.status())[h.agent];
  assert.equal(ready.serviceReady, true);
  assert.equal(ready.loaded, true);
  assert.equal(await readFile(h.descriptor, "utf8"), restoredDescriptor);
  const task = await restarted.context(h.agent).prepare(selection, h.check);
  for (const [name, args] of reads) h.data(await h.call(name, { ...args, task_id: task.taskId }));
  assert.equal((await restarted.status())[h.agent].retrievalVerified, true);
  assert.equal(h.data(await h.call("memory_save", { content: "Synthetic Claude restart check." })).saved, true);
});

test("Claude Code migrates an authorized old connection at startup without its endpoint file", async t => {
  const h = await fixture(t, "claude_code");
  const options = { home: h.home, env: {}, platform: "darwin", descriptorPath: h.descriptor };
  const oldApp = path.join(h.home, "记忆盒子 1.5.2 合并版.app", "Contents");
  const oldAdapter = createMyAiMcpConfig(h.agent, { ...options,
    executable: path.join(oldApp, "MacOS", "半人马AI记忆盒子"),
    stdioPath: path.join(oldApp, "Resources", "app.asar", "shell", "codex-context-stdio.mjs"),
  });
  const adapter = createMyAiMcpConfig(h.agent, { ...options, stdioPath: path.join(h.home, "bridge.mjs"), stableLauncher: true });
  const configFile = path.join(h.home, ".claude.json");
  const other = { command: "keep" };
  const reportError = error => { throw error; };

  const legacy = h.createAccess(oldAdapter);
  t.after(() => legacy.close());
  await writeFile(configFile, JSON.stringify({ mcpServers: { other } }));
  await legacy.selection(h.agent, { folderId: "folder-a" }, h.check);
  await legacy.connect(h.agent, h.check);
  await legacy.close();
  const staleConfig = await readFile(configFile, "utf8");
  await rm(h.descriptor);

  const restarted = h.createAccess(adapter);
  t.after(() => restarted.close());
  h.box("box-b");
  h.changeScope("session-b");
  await restarted.restore(reportError);
  assert.equal(await readFile(configFile, "utf8"), staleConfig);
  await assert.rejects(readFile(h.descriptor), { code: "ENOENT" });

  h.box("box-a");
  h.changeScope("session-c");
  await restarted.restore(reportError);
  assert.equal((await restarted.status())[h.agent].serviceReady, true);
  assert.equal(await adapter.isConfigured(), true);
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).mcpServers.other, other);
  h.data(await h.call("space_search", { query: "fixture" }));
  assert.equal(h.sourceCalls.at(-1).selection.folderId, "folder-a");
  assert.equal((await h.call("space_search", { query: "fixture", folderId: "folder-b" })).isError, true);

  await restarted.disconnect(h.agent, h.check);
  await restarted.close();
  await writeFile(configFile, staleConfig);
  const revoked = h.createAccess(adapter);
  t.after(() => revoked.close());
  await revoked.restore(reportError);
  assert.equal((await revoked.status())[h.agent].configured, false);
  assert.equal(await readFile(configFile, "utf8"), staleConfig);
  await assert.rejects(readFile(h.descriptor), { code: "ENOENT" });
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
  assert.equal(accessAgentId("claude_desktop", "cowork"), "claude_desktop");
});
