import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createSemanticaMcpClient } from "../shell/semantica-mcp-client.mjs";
import { createCodexContextSources } from "../shell/codex-context-sources.mjs";
import { nativeTools, nativeResult, warehouseA, warehouseB } from "./fixtures/semantica-mcp.mjs";

async function fixture(t) {
  let scope = "owner/box/session", now = Date.now(), mode, waiting;
  const requests = [], issued = [], revoked = [], listeners = new Set();
  const agent = new http.Agent({ keepAlive: false });
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({ path: request.url, headers: request.headers, body });
    if (body.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    if (mode === "wait" && body.method === "tools/call") { waiting?.(); return; }
    if ((mode === "drop-once" || mode === "drop") && body.method === "tools/call") {
      if (mode === "drop-once") mode = undefined;
      request.socket.destroy();
      return;
    }
    if (mode === "denied") { response.writeHead(403).end(); return; }
    if (mode === "missing") { response.writeHead(404).end(); return; }
    const result = body.method === "initialize" ? { serverInfo: { name: "wanx-starlink" }, capabilities: { tools: {} } }
      : body.method === "tools/list" ? { tools: mode === "invalid" ? [{ name: "space_read" }] : nativeTools }
      : mode === "tool-error" ? { isError: true, content: [{ type: "text", text: "EVIDENCE_FORBIDDEN" }] }
      : nativeResult({ received: body.params });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = createSemanticaMcpClient({
    client: { subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      async mcpConnection() {
        const captured = scope;
        return { url: `http://127.0.0.1:${server.address().port}`, agent,
          context() { assert.equal(scope, captured); } };
      } },
    scope: () => scope, now: () => now,
    starlink: async () => ({ items: [warehouseA, warehouseB].map(id => ({ id, name: id, state: "active" })) }),
    async issueKey(id) {
      const token = "xg_" + String(issued.length).padStart(40, "0");
      issued.push({ id, token });
      return { token, expiresAt: now + 60000, async revoke() { revoked.push(token); } };
    },
  });
  t.after(async () => { await provider.close(); agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { provider, requests, issued, revoked, mode(value) { mode = value; },
    tick(value) { now += value; }, switch() { scope += "/next"; for (const listener of listeners) listener(); },
    waiting() { return new Promise(resolve => { waiting = resolve; }); } };
}

test("native MCP initializes over the app transport, preserves schemas/results and uses warehouse keys", async t => {
  const h = await fixture(t), check = () => {};
  const catalogs = await Promise.all([h.provider.discover(check), h.provider.discover(check)]);
  assert.deepEqual(catalogs[0].tools, nativeTools);
  assert.equal(h.issued.length, 1);
  assert.deepEqual(h.requests.map(row => row.body.method), ["initialize", "notifications/initialized", "tools/list"]);
  const args = { arguments: { query: "原生推理" } };
  const reply = await h.provider.call(warehouseB, "xingtu_reasoning_search", args, check);
  assert.deepEqual(reply, nativeResult({ received: { name: "xingtu_reasoning_search", arguments: args } }));
  assert.equal(h.issued[1].id, warehouseB);
  for (const row of h.requests) {
    assert.equal(row.path, "/mcp/starlink");
    assert.equal(row.headers["mcp-protocol-version"], "2025-03-26");
    assert.ok(h.issued.some(item => row.headers.authorization === "Bearer " + item.token));
    assert.equal(row.headers["x-wanx-data-context"], undefined);
    assert.equal(row.headers.cookie, undefined);
  }
  h.mode("tool-error");
  assert.deepEqual(await h.provider.call(warehouseA, "xingtu_evidence", { evidence_id: "private" }, check),
    { isError: true, content: [{ type: "text", text: "EVIDENCE_FORBIDDEN" }] });
  const count = h.requests.length;
  await assert.rejects(h.provider.call(warehouseA, "space_read", {}, check), { code: "SEMANTICA_MCP_TOOL_UNAVAILABLE" });
  assert.equal(h.requests.length, count);
});

test("scope changes abort old requests and revoke old keys; concurrent expiry refreshes only once", async t => {
  const h = await fixture(t), check = () => {};
  await h.provider.discover(check);
  h.tick(61000);
  await Promise.all([h.provider.call(warehouseA, "xingtu_search", { query: "x" }, check), h.provider.call(warehouseA, "xingtu_search", { query: "y" }, check)]);
  assert.equal(h.issued.length, 2);
  assert.equal(h.revoked[0], h.issued[0].token);
  h.mode("wait");
  const waiting = h.waiting();
  const pending = h.provider.call(warehouseA, "xingtu_search", { query: "late" }, check);
  const rejected = assert.rejects(pending);
  await waiting;
  h.switch();
  await rejected;
  h.mode(undefined);
  await h.provider.discover(check);
  assert.equal(h.issued.length, 3);
  assert.ok(h.revoked.includes(h.issued[1].token));
  await h.provider.close();
  assert.ok(h.revoked.includes(h.issued[2].token));
  await assert.rejects(h.provider.discover(check), { code: "HOST_SESSION_EXPIRED" });
});

test("starlink retries a dropped read once and leaves reasoning calls single-attempt", async t => {
  const h = await fixture(t), check = () => {};
  await h.provider.discover(check);
  const countCalls = () => h.requests.filter(row => row.body.method === "tools/call").length;
  h.mode("drop-once");
  await h.provider.call(warehouseA, "xingtu_evidence", { evidence_id: "example" }, check);
  assert.equal(countCalls(), 2);
  h.mode("drop");
  await assert.rejects(h.provider.call(warehouseA, "xingtu_search", { query: "x" }, check), { code: "SEMANTICA_MCP_UNAVAILABLE" });
  assert.equal(countCalls(), 4);
  await assert.rejects(h.provider.call(warehouseA, "xingtu_reasoning_search", { arguments: { query: "x" } }, check),
    { code: "SEMANTICA_MCP_UNAVAILABLE" });
  assert.equal(countCalls(), 5);
});

for (const [mode, code] of [["denied", "SEMANTICA_MCP_ACCESS_DENIED"], ["missing", "SEMANTICA_MCP_UPGRADE_REQUIRED"], ["invalid", "SEMANTICA_MCP_INVALID_REPLY"]]) {
  test(`native ${mode} never falls back to session business APIs`, async t => {
    const h = await fixture(t); h.mode(mode);
    await assert.rejects(h.provider.discover(() => {}), { code });
    assert.ok(h.requests.every(row => row.path === "/mcp/starlink"));
  });
}

test("source routing strips task metadata and refuses other warehouses before forwarding", async () => {
  const calls = [], check = () => {};
  const sources = createCodexContextSources({ starlinkMcp: {
    async call(...args) { calls.push(args); return nativeResult({ ok: true }); },
  }, starlink: async () => ({ items: [warehouseA, warehouseB].map(id => ({ id, state: "active" })) }) });
  await sources.call({ warehouseId: warehouseA }, "xingtu_reasoning_search", {
    warehouseId: warehouseA, task_id: "a".repeat(36), arguments: { query: "x" },
  }, check);
  assert.deepEqual(calls[0], [warehouseA, "xingtu_reasoning_search", { arguments: { query: "x" } }, check]);
  await assert.rejects(sources.call({ warehouseId: warehouseA }, "xingtu_search", { warehouseId: warehouseB }, check), { status: 403 });
  await assert.rejects(sources.call({}, "xingtu_warehouse", {}, check), { status: 403 });
  await assert.rejects(sources.direct("xingtu_search", { query: "x" }, check), { status: 400 });
  assert.equal(calls.length, 1);
  await sources.direct("xingtu_warehouse", { warehouseId: warehouseB }, check);
  assert.equal(calls[1][0], warehouseB);
});
