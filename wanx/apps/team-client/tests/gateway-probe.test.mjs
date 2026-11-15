import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { probeEndpoint } from "../octop/probe.mjs";

const health = {
  ok: true,
  started_at: 123,
  db: true,
  users_loaded: 1,
  agents_running: 0,
};

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("probe verifies public WANX health without login credentials", async (t) => {
  const url = await fixture(t, (request, response) => {
    assert.equal(request.url, "/api/health");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    response.end(JSON.stringify(health));
  });
  assert.deepEqual(await probeEndpoint(url), health);
});

test("probe permits an uninitialized WANX so the normal setup page can load", async (t) => {
  const pending = { ...health, db: false, users_loaded: 0 };
  const url = await fixture(t, (_request, response) =>
    response.end(JSON.stringify(pending)),
  );
  assert.deepEqual(await probeEndpoint(url), pending);
});

test("probe rejects unrelated services, malformed JSON and oversized responses", async (t) => {
  for (const body of [
    '{"ok":true}',
    "<html>ok</html>",
    JSON.stringify({ ...health, ok: false }),
    " ".repeat(17 * 1024),
  ]) {
    const url = await fixture(t, (_request, response) => response.end(body));
    await assert.rejects(probeEndpoint(url), { code: "health_invalid" });
  }
});

test("probe does not follow redirects", async (t) => {
  let calls = 0;
  const url = await fixture(t, (_request, response) => {
    calls++;
    response.writeHead(302, { location: "/api/health?again=1" });
    response.end();
  });
  await assert.rejects(probeEndpoint(url), { code: "health_invalid" });
  assert.equal(calls, 1);
});

test(
  "probe cancellation destroys an in-flight health request",
  { timeout: 3_000 },
  async (t) => {
    let started;
    const received = new Promise((resolve) => {
      started = resolve;
    });
    const url = await fixture(t, (_request, response) => {
      started();
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
    });
    const controller = new AbortController();
    const pending = probeEndpoint(url, { signal: controller.signal });
    await received;
    const rejected = assert.rejects(pending, { name: "AbortError" });
    controller.abort();
    await rejected;
  },
);

test("probe bounds unavailable endpoint errors", async (t) => {
  const url = await fixture(t, (request) => request.socket.destroy());
  await assert.rejects(probeEndpoint(url), {
    code: "health_unavailable", transportCode: "ECONNRESET", reusedSocket: false,
  });
});

test("probe distinguishes a reused socket reset without changing the public health error", async t => {
  let calls = 0;
  const url = await fixture(t, (request, response) => {
    if (++calls === 1) response.end(JSON.stringify(health));
    else request.socket.destroy();
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await probeEndpoint(url, { agent });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(probeEndpoint(url, { agent }), error => {
    assert.equal(error.code, "health_unavailable");
    assert.equal(error.transportCode, "ECONNRESET");
    assert.equal(error.reusedSocket, true);
    assert.equal(Object.hasOwn(error, "status"), false);
    return true;
  });
  assert.equal(calls, 2, "diagnostics must not retry the failed request");
});

test("probe keeps response status as diagnostic data without exposing response contents", async t => {
  const url = await fixture(t, (_request, response) => {
    response.writeHead(503, { "x-private": "SECRET" });
    response.end("SECRET https://private.example/?token=SECRET");
  });
  await assert.rejects(probeEndpoint(url), error => {
    assert.equal(error.code, "health_invalid");
    assert.equal(error.httpStatus, 503);
    assert.equal(error.reusedSocket, false);
    assert.equal(Object.hasOwn(error, "status"), false);
    assert.doesNotMatch(JSON.stringify(error), /SECRET|private\.example|headers|body/);
    return true;
  });
});

test("probe copies only bounded transport diagnostics from connection failures", async t => {
  const cases = [
    { code: "tunnel_rejected", httpStatus: 403, expectedCode: "tunnel_rejected", expectedStatus: 403 },
    { code: "network_recovering", httpStatus: 502, expectedCode: "network_recovering", expectedStatus: 502 },
    { code: "SECRET_CODE", httpStatus: "SECRET" },
    { code: "https://private.example/?token=SECRET", httpStatus: 600 },
    { code: "ECONNRESET", httpStatus: 99, expectedCode: "ECONNRESET" },
    { code: "ETIMEDOUT", httpStatus: 503.5, expectedCode: "ETIMEDOUT" },
  ];
  for (const input of cases) {
    const agent = new http.Agent();
    t.after(() => agent.destroy());
    agent.createConnection = (_options, callback) => {
      callback(Object.assign(new Error("SECRET socket message"), {
        code: input.code, httpStatus: input.httpStatus,
        status: 401, proxyToken: "SECRET", headers: { authorization: "SECRET" },
      }));
    };
    await assert.rejects(probeEndpoint("http://192.0.2.1:8088", { agent }), error => {
      assert.equal(error.code, "health_unavailable");
      assert.equal(error.transportCode, input.expectedCode);
      assert.equal(error.httpStatus, input.expectedStatus);
      assert.equal(error.reusedSocket, false);
      assert.equal(Object.hasOwn(error, "status"), false);
      assert.equal(error.message, "health_unavailable");
      assert.doesNotMatch(JSON.stringify(error), /SECRET|private\.example|proxyToken|headers/);
      return true;
    });
  }
});
