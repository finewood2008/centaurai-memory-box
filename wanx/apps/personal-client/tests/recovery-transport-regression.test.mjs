import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createNetwork } from "../network/index.mjs";
import { createClient } from "../client.mjs";
import { createPlatformSession } from "../octop/platform.mjs";

// The SDK/RPC observation is the only fake network seam. HTTP CONNECT, its
// pooled agents, health checks, session exchanges and gateway rotation are real.
const selected = { deviceId: "fixture-box", name: "Fixture", mode: "netbird", url: "http://100.90.1.2:8088/" };
const ready = () => ({ phase: "ready", peers: [{ ip: "100.90.1.2", connected: true, name: "fixture" }] });
const turn = () => new Promise(setImmediate);
async function pump(t, condition, milliseconds = 0) {
  t.mock.timers.tick(milliseconds);
  for (let count = 0; count < 300 && !condition(); count++) await turn();
  assert.ok(condition(), "real transport did not settle within the bounded local fixture");
}

async function fixture(t, expiresIn = 3600) {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); return socket; };
  let exchanges = 0, challenges = 0, proxyOnline = true, status = ready(), recoverStatus = ready(), recoveries = 0;
  const box = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* bounded synthetic fixture only */ }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ ok: true, db: true, started_at: 1, users_loaded: 1, agents_running: 0 }));
    else if (request.url === "/api/auth/platform/challenge") { challenges++; response.end(JSON.stringify({ challengeReceipt: "fixture-challenge" })); }
    else if (request.url === "/api/auth/platform/exchange") response.end(JSON.stringify({ access_token: "fixture-session-" + ++exchanges, token_type: "Bearer", expires_in: expiresIn }));
    else { response.writeHead(404); response.end("{}"); }
  });
  box.on("connection", track);
  box.listen(0, "127.0.0.1"); await once(box, "listening");
  const proxy = http.createServer();
  proxy.on("connection", track);
  proxy.on("connect", (request, downstream, head) => {
    assert.equal(request.url, "100.90.1.2:8088");
    assert.equal(request.headers.authorization, "Bearer fixture-proxy-token-not-a-real-secret");
    if (!proxyOnline) { downstream.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); return; }
    const upstream = track(net.connect(box.address().port, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(downstream); downstream.pipe(upstream);
    }));
    downstream.on("close", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const network = createNetwork({ pollIntervalMs: 1000, createSidecar: () => ({
    async request(method) {
      if (method === "status") return structuredClone(status);
      if (method === "recover") { recoveries++; status = structuredClone(recoverStatus); proxyOnline = true; }
      return { proxy: { port: proxy.address().port, token: "fixture-proxy-token-not-a-real-secret" }, status: structuredClone(status) };
    },
    close() {},
  }) });
  const client = createClient({ network });
  const sessions = [], sessionFailures = [];
  const createSession = async input => {
    const session = await createPlatformSession({ ...input,
      account: { getIdentity: () => ({ accountId: "fixture-account", clientId: "fixture-client" }), request: async () => ({ grant: "fixture-grant" }) },
      device: { deviceId: selected.deviceId }, networkSessionId: "fixture-network-session",
      measure: async (step, operation) => {
        try { return await operation(); }
        catch (error) { sessionFailures.push({ step, code: error.code }); throw error; }
      },
      onExpired: reason => { if (reason === "expired") client.recoverSession(); else void client.disconnect(); },
    });
    sessions.push(session); return session;
  };
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => box.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  await client.setNetworkEnabled(true);
  await client.connect(selected, { createSession });
  const originalAgent = (await network.resolveEndpoint(selected)).agent;
  return { network, client, sessions, sessionFailures, originalAgent,
    setStatus: value => { status = value; },
    setRecoveryStatus: value => { recoverStatus = value; },
    stopProxy: () => { proxyOnline = false; for (const socket of sockets) socket.destroy(); },
    get exchanges() { return exchanges; }, get challenges() { return challenges; }, get recoveries() { return recoveries; },
  };
}

for (const observation of ["unavailable", "removed-peer"]) {
  test(`real transport automatically replaces an invalidated agent after ${observation}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await fixture(t);
    f.setStatus(observation === "unavailable" ? { phase: "unavailable", peers: [] } : { phase: "ready", peers: [] });
    await f.network.refresh();
    f.setStatus(ready());
    await pump(t, () => f.client.snapshot().phase === "ready" && f.exchanges === 2, 0);
    assert.equal(f.client.snapshot().connection.deviceId, selected.deviceId);
    assert.notEqual((await f.network.resolveEndpoint(selected)).agent, f.originalAgent);
    assert.equal(f.challenges, 2);
    assert.equal(f.sessions[0].getToken(), "", "old platform session is closed only after authorized replacement");
    assert.ok(f.sessions[1].getToken());
  });
}

test("real CONNECT survives engine recovery with a temporary missing peer map without replacing its session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  f.stopProxy();
  f.setRecoveryStatus({ phase: "recovering", reason: "network_unavailable", peers: [] });
  await f.network.networkChanged();
  assert.equal(f.recoveries, 1);
  f.setStatus(ready());
  await f.network.refresh();
  await pump(t, () => f.client.snapshot().phase === "ready", 0);
  assert.equal((await f.network.resolveEndpoint(selected)).agent, f.originalAgent);
  assert.equal(f.exchanges, 1);
  assert.ok(f.sessions[0].getToken());
});

test("an expired session using an invalidated tunnel reauthorizes with the restored peer's new agent", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, 120);
  f.setStatus({ phase: "ready", peers: [] });
  await f.network.refresh();
  await pump(t, () => f.sessionFailures.some(row => row.step === "box.challenge" && row.code === "network_disabled"), 60_000);
  assert.equal(f.client.snapshot().phase, "recovering");
  assert.equal(f.challenges, 1, "the retired agent rejects renewal before any HTTP challenge reaches the box");
  await pump(t, () => f.sessions[0].getToken() === "", 60_000);
  f.setStatus(ready());
  // A refresh may still be awaiting the previous peer-less observation. Let
  // the production one-second sampler read the restored map, then advance its
  // actual retry deadline; one large fake-clock jump coalesces those reads.
  for (let count = 0; count < 10 && f.exchanges < 2; count++) {
    t.mock.timers.tick(1000);
    for (let turnCount = 0; turnCount < 30; turnCount++) await turn();
  }
  await pump(t, () => f.client.snapshot().phase === "ready" && f.exchanges === 2);
  assert.notEqual((await f.network.resolveEndpoint(selected)).agent, f.originalAgent);
  assert.equal(f.challenges, 2);
  assert.ok(f.sessions[1].getToken());
});
