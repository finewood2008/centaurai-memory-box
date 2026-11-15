import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createNotificationCenter } from "../shell/notification-center.mjs";

const health = { ok: true, db: true, started_at: 1, users_loaded: 1, agents_running: 0 };
const ready = { phase: "ready", peers: [{ ip: "198.51.100.9", connected: true }] };
const stale = { phase: "recovering", reason: "network_status_stale", peers: [] };

// Only the native SDK boundary is simulated. Health requests cross a real
// CONNECT tunnel and use the production network, client and notification code.
async function connected(t, { persistentFailure = false } = {}) {
  const sockets = new Set(), events = [], phases = [], sidecarCalls = [];
  let reads = 0, gatewayCloses = 0, status = ready, finished;
  const recoveryFinished = new Promise(resolve => { finished = resolve; });
  const track = socket => {
    sockets.add(socket); socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/api/health");
    if (++reads === 2 || persistentFailure && reads > 2) { request.socket.destroy(); return; }
    response.end(JSON.stringify(health));
  });
  upstream.on("connection", track);
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const proxy = http.createServer();
  proxy.on("connection", track);
  proxy.on("connect", (request, socket, head) => {
    assert.equal(request.url, "198.51.100.9:8088");
    const destination = net.connect(upstream.address().port, "127.0.0.1");
    track(destination);
    destination.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) destination.write(head);
      socket.pipe(destination).pipe(socket);
    });
    socket.once("close", () => destination.destroy());
    destination.once("close", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const network = createNetwork({ pollIntervalMs: 60_000,
    createSidecar: () => ({
      async request(method) {
        sidecarCalls.push(method);
        return method === "start" ? { proxy: { port: proxy.address().port, token: "fixture-test-token-only" }, status } : status;
      }, close() {},
    }),
  });
  const client = createClient({ network,
    onRecovery(event) {
      events.push(event);
      if (["transient", "restored", "waiting"].includes(event.action)) finished();
    },
    createGateway: async () => ({ url: "http://127.0.0.1:19000", close() { gatewayCloses++; } }),
  });
  const notifications = await createNotificationCenter({
    client: {
      snapshot: () => ({ ...client.snapshot(), account: { phase: "authenticated", accountId: "test-account", clientId: "test-client" } }),
      subscribe: listener => client.subscribe(listener),
      async applicationStream() { throw new Error("fixture-unavailable"); },
      async applicationRequest() { throw new Error("fixture-unavailable"); },
    },
    serviceURL: "https://fixture.invalid", store: { async load() { return null; }, async save() {} },
  });
  t.after(async () => {
    await notifications.close(); await client.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  await client.setNetworkEnabled(true);
  await client.connect({ deviceId: "fixture-box", url: "http://198.51.100.9:8088", mode: "netbird" });
  client.subscribe(value => phases.push(value.phase));
  return {
    client, network, events, phases, sidecarCalls,
    get reads() { return reads; }, get gatewayCloses() { return gatewayCloses; },
    notifications: () => notifications.snapshot().items.filter(item => item.title === "盒子连接中断"),
    async disrupt({ fresh = false } = {}) {
      status = stale; await network.refresh();
      if (fresh) status = ready;
      await recoveryFinished; await new Promise(setImmediate);
    },
  };
}

for (const fresh of [false, true]) {
  test(`one real health reset with ${fresh ? "fresh" : "stale"} peer status preserves views without an outage notification`, { timeout: 3000 }, async t => {
    const h = await connected(t);
    await h.disrupt({ fresh });
    assert.equal(h.client.snapshot().phase, "ready");
    assert.equal(h.client.snapshot().recovery, null);
    assert.equal(h.phases.includes("recovering"), false);
    assert.equal(h.notifications().length, 0);
    assert.equal(h.reads, 3);
    assert.equal(h.gatewayCloses, 0);
    assert.deepEqual(h.events.map(event => event.action), ["transient"]);
    assert.equal(h.events[0].errorCode, "health_unavailable");
    assert.equal(h.sidecarCalls.includes("recover"), false);
  });
}

test("persistent real health resets still enter recovery and announce one outage", { timeout: 3000 }, async t => {
  const h = await connected(t, { persistentFailure: true });
  await h.disrupt();
  assert.equal(h.client.snapshot().phase, "recovering");
  assert.equal(h.notifications().length, 1);
  assert.equal(h.reads, 3, "the confirmation must fail before announcing the outage");
  assert.equal(h.gatewayCloses, 0);
  assert.deepEqual(h.events.map(event => event.action), ["detected", "attempt", "waiting"]);
  assert.equal(h.events.at(-1).errorCode, "netbird_peer_unknown");
});
