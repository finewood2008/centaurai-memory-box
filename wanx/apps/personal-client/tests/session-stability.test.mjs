import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createClient } from "../client.mjs";
import { createPlatformSession } from "../octop/platform.mjs";

// Exercise the real HTTP decoder: proxies often return HTML, empty or malformed errors.
async function boxFailure(status, body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { "content-type": "text/html" }); response.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await createPlatformSession({ url: `http://127.0.0.1:${server.address().port}/`,
      account: { getIdentity: () => ({ accountId: "account", clientId: "client" }) },
      device: { deviceId: "box" }, networkSessionId: "network" });
    assert.fail("the unsuccessful HTTP response must reject");
  } catch (error) { assert.equal(error.status, status); return error; }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const tick = async (t, ms) => { t.mock.timers.tick(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function connected(t, renew) {
  const originalAgent = {}, replacementAgent = {};
  let agent = originalAgent, disrupted = false;
  const network = {
    snapshot: () => ({ enabled: true, phase: "ready", peers: [{ ip: "100.90.1.2", connected: true }] }),
    subscribe: () => () => {},
    resolveEndpoint: async input => ({ url: input.url, agent }),
    networkChanged: async () => { agent = replacementAgent; }, close() {},
  };
  const client = createClient({ network,
    probe: async (_url, input) => { if (disrupted && input.agent === originalAgent) throw new Error("health_timeout"); },
    createGateway: async () => ({ url: "http://127.0.0.1:19000", close() {} }),
  });
  t.after(() => client.close());
  let initial = true;
  await client.connect({ deviceId: "box", mode: "netbird", url: "http://100.90.1.2:8088/" }, {
    createSession: async input => {
      if (!initial) return renew(input);
      initial = false; return { getToken: () => "fixture-token", close() {} };
    },
  });
  return {
    client,
    async disrupt() {
      disrupted = true;
      for (const delay of [30_000, 1000, 1000, 2000, 5000]) await tick(t, delay);
    },
  };
}

for (const [status, body] of [[502, "<html>upstream unavailable</html>"], [503, "{"], [429, ""]])
  test(`HTTP ${status} during session recovery keeps retrying and recovers with fresh authorization`, async t => {
    const failure = await boxFailure(status, body);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let unavailable = true;
    const h = await connected(t, async () => {
      if (unavailable) throw failure;
      return { getToken: () => "fresh-token", close() {} };
    });
    await h.disrupt();
    assert.equal(h.client.snapshot().phase, "recovering");
    assert.equal(h.client.snapshot().connection.deviceId, "box");
    for (let i = 0; i < 4; i++) await tick(t, 60000);
    assert.equal(h.client.snapshot().phase, "recovering", "a longer outage must not abandon the user's selection");
    unavailable = false; await tick(t, 60000);
    assert.equal(h.client.snapshot().phase, "ready");
    assert.equal(h.client.snapshot().connection.deviceId, "box");
  });

for (const status of [401, 403]) test(`HTTP ${status} during recovery closes the unauthorized connection`, async t => {
  const failure = await boxFailure(status, "<html>denied</html>");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await connected(t, async () => { throw failure; });
  await h.disrupt();
  assert.equal(h.client.snapshot().phase, "disconnected");
  assert.equal(h.client.snapshot().connection, null);
  assert.equal(h.client.snapshot().reason, "connection_authorization_required");
});

for (const stop of ["disconnect", "close"]) test(`late session renewal cannot reconnect after ${stop}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release, disposed = false;
  const h = await connected(t, () => new Promise(resolve => { release = resolve; }));
  await h.disrupt();
  assert.equal(typeof release, "function");
  const stopping = h.client[stop]();
  release({ getToken: () => "late-token", close() { disposed = true; } });
  await stopping; await tick(t, 60000);
  assert.equal(h.client.snapshot().connection, null); assert.equal(disposed, true);
});


test("natural expiry keeps the application origin while obtaining a fresh signed box session", async t => {
  const { createDashboardGateway } = await import("../octop/gateway.mjs");
  const { setTimeout: delay } = await import("node:timers/promises");
  let issued = 0, grants = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the bounded test request */ }
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith("/challenge")) response.end(JSON.stringify({ challengeReceipt: "fixture-challenge" }));
    else if (request.url.endsWith("/exchange")) response.end(JSON.stringify({ access_token: `fixture-${++issued}`, token_type: "Bearer", expires_in: 60 }));
    else response.end(JSON.stringify({ authorization: request.headers.authorization }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  let session, gateway;
  const network = { snapshot: () => ({ enabled: true, phase: "ready", peers: [] }), subscribe: () => () => {},
    resolveEndpoint: async () => ({ url }), close() {} };
  const client = createClient({ network, probe: async () => {},
    createGateway: async input => { gateway = await createDashboardGateway(input); return gateway; } });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); });
  await client.connect({ deviceId: "box", mode: "direct", url }, { createSession: async input => {
    session = await createPlatformSession({ ...input, device: { deviceId: "box" }, networkSessionId: "network",
      account: { getIdentity: () => ({ accountId: "account", clientId: "client" }),
        request: async () => { grants++; return { grant: "fixture-signed-grant" }; } },
      onExpired: reason => { if (reason === "expired") client.recoverSession(); else void client.disconnect(); },
    });
    return session;
  } });
  const origin = client.snapshot().connection.gatewayURL;
  const lease = client.applicationConnection("fixture.app");
  session.expire("expired");
  assert.equal(session.getToken(), "", "expired credentials must be unusable during recovery");
  for (let i = 0; i < 100 && client.snapshot().phase !== "ready"; i++) await delay(10);
  assert.equal(client.snapshot().phase, "ready"); assert.equal(grants, 2);
  assert.equal(client.snapshot().connection.gatewayURL, origin);
  const response = await lease.request({ path: "/api/auth/me" });
  assert.equal(JSON.parse(response.body).authorization, "Bearer fixture-2");
  session.expire("denied");
  assert.equal(client.snapshot().connection, null);
  await assert.rejects(async () => lease.request({ path: "/api/auth/me" }), /SESSION_CLOSED|GATEWAY_CLOSED/);
});
