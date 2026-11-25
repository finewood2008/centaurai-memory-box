import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {createSpaceMcpRelay} from "../shell/space-mcp-relay.mjs";

const key = "k".repeat(43);
const warehouseKey = "xg_" + "w".repeat(43);
const headers = {authorization: "Bearer " + key, accept: "application/json, text/event-stream", "content-type": "application/json"};
async function fixture(t, handler) {
  const calls = [], state = {}, target = "http://100.98.0.5:8088";
  let owner = "account-A:box-A", generation = 1, saved;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString()});
    const expected = req.url === "/mcp/starlink" ? "Bearer " + warehouseKey : headers.authorization;
    if (req.headers.authorization !== expected) { res.writeHead(401); res.end("invalid key"); return; }
    if (handler) return handler(req, res);
    res.writeHead(200, {"content-type": "application/json", "mcp-session-id": "box-session"});
    res.end(JSON.stringify({jsonrpc: "2.0", id: 1, result: {ok: true}}));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const agent = new http.Agent();
  // The overlay address is deliberately unreachable through the system network.
  // Only the app-owned transport knows how to dial this fixture.
  agent.createConnection = options => {
    assert.equal(options.host, "100.98.0.5");
    assert.equal(Number(options.port), 8088);
    return net.connect(upstream.address().port, "127.0.0.1");
  };
  const scope = () => owner ? owner + ":" + generation : null;
  const make = () => createSpaceMcpRelay({state, persist: async () => {saved = structuredClone(state);},
    scope, storageScope: () => owner,
    assertScope: bound => { if (!bound || bound !== scope()) throw Error("SPACE_CONTEXT_CHANGED"); },
    client: {snapshot: () => ({connection: {mode: "netbird"}}), mcpConnection: () => {
      const bound = scope();
      return {url: target, agent, context() { if (bound !== scope()) throw Error("SESSION_CLOSED"); }};
    }},
  });
  const relay = make();
  t.after(async () => { await relay.close(); agent.destroy(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  return {relay, calls, state, make, get saved() {return saved;},
    change(value) {owner = value; generation++; relay.contextChanged();},
  };
}

test("MCP uses the app transport and original key, protocol headers and body without desktop authority", async t => {
  const f = await fixture(t), url = await f.relay.url();
  const body = JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-03-26"}});
  const response = await fetch(url, {method: "POST", headers: {...headers,
    "mcp-protocol-version": "2025-03-26", "mcp-session-id": "client-session", cookie: "account=private",
    "x-forwarded-host": "evil.invalid"}, body});
  assert.equal(response.status, 200); assert.equal((await response.json()).result.ok, true);
  assert.equal(response.headers.get("mcp-session-id"), "box-session");
  assert.equal(f.calls[0].body, body); assert.equal(f.calls[0].headers.authorization, headers.authorization);
  assert.equal(f.calls[0].headers["mcp-protocol-version"], "2025-03-26");
  assert.equal(f.calls[0].headers["mcp-session-id"], "client-session");
  assert.equal(f.calls[0].headers.cookie, undefined); assert.equal(f.calls[0].headers["x-forwarded-host"], undefined);
  assert.equal(f.calls[0].headers.host, "100.98.0.5:8088");
  assert.ok(!JSON.stringify(f.saved).includes(key));
  const invalid = await fetch(url, {method: "POST", headers: {...headers, authorization: "Bearer " + "z".repeat(43)}, body});
  assert.equal(invalid.status, 401); assert.equal(await invalid.text(), "invalid key");
});

test("routes exported Starlink calls through NetBird with the original warehouse key", async t => {
  const f = await fixture(t), origin = await f.relay.url();
  const url = new URL("/mcp/starlink", origin);
  const body = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call",
    params: {name: "xingtu_search", arguments: {query: "synthetic"}}});
  const starlinkHeaders = {...headers, authorization: "Bearer " + warehouseKey};
  const response = await fetch(url, {method: "POST", headers: starlinkHeaders, body});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.ok, true);
  assert.equal(f.calls[0].path, "/mcp/starlink");
  assert.equal(f.calls[0].headers.authorization, starlinkHeaders.authorization);
  assert.equal(f.calls[0].body, body);
  assert.ok(!JSON.stringify(f.saved).includes(warehouseKey));

  const wrongKey = await fetch(url, {method: "POST", headers, body});
  assert.equal(wrongKey.status, 401);
  await wrongKey.text();
  const wrongPath = await fetch(new URL("/mcp/starlink/other", origin), {method: "POST", headers: starlinkHeaders, body});
  assert.equal(wrongPath.status, 404);
  await wrongPath.text();
  assert.equal(f.calls.length, 2);
});

test("rejects browser origins, unrelated paths, missing keys and alternate Host values before forwarding", async t => {
  const f = await fixture(t), url = await f.relay.url();
  for (const [suffix, options, status] of [
    ["", {method: "POST", headers: {...headers, origin: "https://evil.invalid"}, body: "{}"}, 403],
    ["", {headers: {...headers, "sec-fetch-site": "cross-site"}}, 403],
    ["", {headers: {...headers, host: "evil.invalid"}}, 403],
    ["", {method: "POST", body: "{}"}, 401],
    ["", {method: "PUT", headers}, 405],
    ["?target=http://evil.invalid", {headers}, 404],
    ["/other", {headers}, 404],
  ]) {
    const actual = await new Promise((resolve, reject) => {
      const req = http.request(url + suffix, options, res => {res.resume(); res.once("end", () => resolve(res.statusCode));});
      req.once("error", reject); req.end(options.body);
    });
    assert.equal(actual, status, JSON.stringify([suffix, options]));
  }
  assert.equal(f.calls.length, 0);
});

test("keeps copied ports across restart and renewal, and never sends an old endpoint to another owner/box", async t => {
  const f = await fixture(t), first = await f.relay.url();
  await f.relay.close();
  const restarted = f.make(); t.after(() => restarted.close());
  assert.equal(await restarted.url(), first);
  f.change("account-B:box-B");
  let response = await fetch(first, {headers}); assert.equal(response.status, 503); await response.text();
  assert.equal(f.calls.length, 0);
  const second = await restarted.url(); assert.notEqual(first, second);
  response = await fetch(second, {headers}); assert.equal(response.status, 200); await response.text();
  f.change("account-A:box-A");
  assert.equal(await restarted.url(), first);
  response = await fetch(first, {headers}); assert.equal(response.status, 200); await response.text();
});

test("streams SSE immediately and cancels it when the data interaction changes", async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => {upstreamClosed = resolve;});
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, {"content-type": "text/event-stream"});
    res.write('event: message\ndata: {"jsonrpc":"2.0"}\n\n');
    res.once("close", upstreamClosed);
  });
  const response = await fetch(await f.relay.url(), {headers}), reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: message/);
  f.change("account-B:box-B");
  await assert.rejects(reader.read());
  await closed;
});


test("an occupied saved port fails explicitly until the user resets the endpoint", async t => {
  const f = await fixture(t), first = await f.relay.url();
  await f.relay.close();
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(Number(new URL(first).port), "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const restarted = f.make(); t.after(() => restarted.close());
  await assert.rejects(restarted.url(), {code: "MCP_PORT_IN_USE"});
  await assert.rejects(restarted.url(), {code: "MCP_PORT_IN_USE"});
  assert.equal(f.state.mcpRelays[0].port, Number(new URL(first).port));
  const [renewed, concurrent] = await Promise.all([restarted.reset(), restarted.reset()]);
  assert.equal(concurrent, renewed);
  assert.notEqual(renewed, first);
  assert.equal(await restarted.url(), renewed);
  const response = await fetch(renewed, {headers});
  assert.equal(response.status, 200); await response.text();
  assert.ok(f.saved.mcpRelays[0].retiredPorts.includes(Number(new URL(first).port)));
});

test("reset aborts old streams and the new endpoint survives restart", async t => {
  let upstreamClosed;
  const ended = new Promise(resolve => { upstreamClosed = resolve; });
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, {"content-type": "text/event-stream"});
    res.write('data: {}\n\n'); res.once("close", upstreamClosed);
  });
  const first = await f.relay.url();
  const response = await fetch(first, {headers}), reader = response.body.getReader();
  await reader.read();
  const failedRead = assert.rejects(reader.read());
  const renewed = await f.relay.reset();
  await failedRead; await ended;
  assert.notEqual(renewed, first);
  await assert.rejects(fetch(first, {headers}));
  await f.relay.close();
  const restarted = f.make(); t.after(() => restarted.close());
  assert.equal(await restarted.url(), renewed);
});


test("a new owner cannot inherit a saved endpoint when the OS offers its port after restart", async t => {
  const f = await fixture(t), first = await f.relay.url();
  await f.relay.close();
  f.change("account-B:box-B");
  const listen = http.Server.prototype.listen; let offered = false;
  t.mock.method(http.Server.prototype, "listen", function(...args) {
    if (args[0] === 0 && !offered) { offered = true; args[0] = Number(new URL(first).port); }
    return listen.apply(this, args);
  });
  const restarted = f.make(); t.after(() => restarted.close());
  const second = await restarted.url();
  assert.ok(offered); assert.notEqual(first, second);
  f.change("account-A:box-A");
  assert.equal(await restarted.url(), first);
});
