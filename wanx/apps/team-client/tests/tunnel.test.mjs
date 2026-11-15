import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createTunnelAgent } from "../network/tunnel.mjs";

const token = "test-proxy-token-with-no-production-value";
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const request = (url, options) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ response, body }));
      response.on("error", reject);
    });
    req.on("error", reject);
  });
async function fixture(t) {
  const cert = await readFile(
    new URL("./fixtures/tls/server-cert.pem", import.meta.url),
  );
  const key = await readFile(
    new URL("./fixtures/tls/server-key.pem", import.meta.url),
  );
  const seen = [];
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const upstream = https.createServer({ cert, key }, (req, res) => {
    seen.push({
      host: req.headers.host,
      authorization: req.headers.authorization,
      servername: req.socket.servername,
    });
    res.end("secure response");
  });
  const upstreamPort = await listen(upstream);
  upstream.on("connection", track);
  const proxy = http.createServer();
  proxy.on("connection", track);
  proxy.on("connect", (req, downstream, head) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const target = track(
      net.connect(upstreamPort, "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head);
        target.pipe(downstream);
        downstream.pipe(target);
      }),
    );
    target.on("error", () => downstream.destroy());
    downstream.on("error", () => target.destroy());
  });
  const port = await listen(proxy);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  });
  return { cert, seen, proxy: { port, token } };
}

test("HTTPS tunnel validates certificates even if a caller tries to disable verification", async (t) => {
  const { proxy } = await fixture(t);
  const url = "https://box.wanx.test:8088";
  const agent = createTunnelAgent({ url, proxy });
  t.after(() => agent.destroy());
  await assert.rejects(
    request(url, { agent, rejectUnauthorized: false }),
    (error) => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
  );
});

test("HTTPS tunnel preserves target Host and SNI and rejects a trusted wrong-host certificate", async (t) => {
  const { proxy, cert, seen } = await fixture(t);
  const url = "https://box.wanx.test:8088";
  const agent = createTunnelAgent({ url, proxy });
  t.after(() => agent.destroy());
  const { body } = await request(url, { agent, ca: cert });
  assert.equal(body, "secure response");
  assert.deepEqual(seen, [
    {
      host: "box.wanx.test:8088",
      authorization: undefined,
      servername: "box.wanx.test",
    },
  ]);
  const otherURL = "https://wrong.wanx.test:8088";
  const other = createTunnelAgent({ url: otherURL, proxy });
  t.after(() => other.destroy());
  await assert.rejects(
    request(otherURL, { agent: other, ca: cert }),
    (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
  );
});

test("destroy during pending CONNECT rejects the waiting request promptly", async (t) => {
  let accepted;
  const connected = new Promise((resolve) => {
    accepted = resolve;
  });
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", () => accepted()); // Deliberately withhold the response.
  const port = await listen(proxy);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => proxy.close(resolve));
  });
  const agent = createTunnelAgent({
    url: "http://192.0.2.1:8088",
    proxy: { port, token },
  });
  const pending = new Promise((resolve, reject) => {
    http.get("http://192.0.2.1:8088", { agent }, resolve).on("error", reject);
  });
  const rejected = assert.rejects(
    pending,
    (error) => error.code === "network_disabled",
  );
  await connected;
  agent.destroy();
  await rejected;
});

test("CONNECT rejection preserves only diagnostic HTTP status and never an authorization status", async t => {
  let status = 403;
  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nX-Private: SECRET\r\n\r\n`);
  });
  const port = await listen(proxy);
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const agent = createTunnelAgent({ url: "http://192.0.2.1:8088", proxy: { port, token } });
  t.after(() => agent.destroy());
  for (status of [401, 403, 502, 503]) {
    await assert.rejects(new Promise((resolve, reject) => {
      agent.createConnection({ host: "192.0.2.1", port: 8088 }, (error, socket) => {
        if (error) reject(error);
        else { socket.destroy(); resolve(); }
      });
    }), error => {
      assert.equal(error.code, "tunnel_rejected");
      assert.equal(error.httpStatus, status);
      assert.equal(Object.hasOwn(error, "status"), false);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|headers|token|192\.0\.2/);
      return true;
    });
  }
});


test("transport reset retains reusable agent without replaying an interrupted write", async (t) => {
  let writes = 0;
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    if (req.method === "POST") { writes++; return; }
    res.end("reconnected");
  });
  const targetPort = await listen(upstream);
  const proxy = http.createServer();
  proxy.on("connect", (_req, downstream) => {
    sockets.add(downstream);
    downstream.on("close", () => sockets.delete(downstream));
    const target = net.connect(targetPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      downstream.pipe(target); target.pipe(downstream);
    });
    sockets.add(target);
    target.on("error", () => downstream.destroy());
    downstream.on("error", () => target.destroy());
    target.on("close", () => sockets.delete(target));
  });
  const port = await listen(proxy);
  const agent = createTunnelAgent({ url: "http://100.90.1.2:8088", proxy: { port, token } });
  t.after(async () => {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    await Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => proxy.close(r))]);
  });
  const received = once(upstream, "request");
  const failed = new Promise((resolve) => {
    const req = http.request("http://100.90.1.2:8088/action", { agent, method: "POST" });
    req.once("error", resolve);
    req.end("write once");
  });
  await received;
  agent.resetConnections();
  await failed;
  const result = await new Promise((resolve, reject) => {
    http.get("http://100.90.1.2:8088/", { agent }, (res) => {
      let body = "";
      res.on("data", (data) => { body += data; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  assert.equal(result, "reconnected");
  assert.equal(writes, 1);
  assert.equal(await agent.probe(), true);
  assert.equal(writes, 1, "health probe must send no application request");
});

async function idleFixture(t, handler = (_request, response) => response.end("healthy"), delayedEndMs = 0) {
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };
  const upstream = http.createServer(handler);
  upstream.keepAliveTimeout = 5000;
  upstream.on("connection", track);
  const targetPort = await listen(upstream);
  const proxy = http.createServer();
  proxy.on("connection", track);
  proxy.on("connect", (_request, socket, head) => {
    const destination = net.connect(targetPort, "127.0.0.1");
    track(destination);
    destination.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) destination.write(head);
      socket.pipe(destination);
      destination.pipe(socket, { end: delayedEndMs === 0 });
      if (delayedEndMs) destination.once("end", () => {
        const timer = setTimeout(() => socket.end(), delayedEndMs);
        timer.unref();
      });
    });
    socket.once("close", () => destination.destroy());
    destination.once("error", () => socket.destroy());
    destination.once("close", () => { if (!delayedEndMs) socket.destroy(); });
  });
  const port = await listen(proxy), url = "http://192.0.2.1:8088";
  const agent = createTunnelAgent({ url, proxy: { port, token } });
  t.after(async () => {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const read = (method = "GET") => new Promise((resolve, reject) => {
    const request = http.request(url, { agent, method }, response => {
      let body = "";
      response.on("data", bytes => { body += bytes; });
      response.once("error", reject);
      response.once("end", () => resolve({ body, reused: request.reusedSocket }));
    });
    request.once("error", reject);
    request.end();
  });
  return { url, agent, read, upstream };
}

test("tunnels reuse recent HTTP connections but retire idle ones before the box's five-second close", async t => {
  let writes = 0;
  const f = await idleFixture(t, (request, response) => {
    if (request.method === "POST") writes++;
    response.end("healthy");
  });
  assert.deepEqual(await f.read(), { body: "healthy", reused: false });
  assert.deepEqual(await f.read(), { body: "healthy", reused: true });
  await new Promise(resolve => setTimeout(resolve, 4250));
  assert.deepEqual(await f.read("POST"), { body: "healthy", reused: false });
  assert.equal(writes, 1, "retiring an idle connection must not replay a business write");
});

test("reusing a pooled tunnel for an active stream cancels its idle expiry", async t => {
  let finish;
  const release = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = await idleFixture(t, async (request, response) => {
    if (request.url !== "/stream") return response.end("healthy");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: start\n\n");
    await release;
    response.end("data: finish\n\n");
  });
  await f.read();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const result = new Promise((resolve, reject) => {
    const request = http.get(f.url + "/stream", { agent: f.agent }, response => {
      let body = "";
      response.on("data", bytes => { body += bytes; ready(); });
      response.once("error", reject);
      response.once("end", () => resolve({ body, reused: request.reusedSocket }));
    });
    request.once("error", reject);
  });
  // Install the rejection observer before waiting past the old free deadline.
  const completed = assert.doesNotReject(async () => {
    assert.deepEqual(await result, { body: "data: start\n\ndata: finish\n\n", reused: true });
  });
  await started;
  await new Promise(resolve => setTimeout(resolve, 4250));
  finish();
  await completed;
});

test("upgrading a reused tunnel to WebSocket removes its free-socket deadline", async t => {
  const f = await idleFixture(t);
  const server = new WebSocketServer({ noServer: true });
  f.upstream.on("upgrade", (request, socket, head) => {
    server.handleUpgrade(request, socket, head, stream => {
      stream.on("message", bytes => stream.send(bytes));
    });
  });
  await f.read();
  const stream = new WebSocket(f.url.replace("http:", "ws:"), { agent: f.agent });
  t.after(() => { stream.terminate(); server.close(); });
  await once(stream, "open");
  await new Promise(resolve => setTimeout(resolve, 4250));
  const reply = once(stream, "message");
  stream.send("still connected");
  const [bytes] = await reply;
  assert.equal(bytes.toString(), "still connected");
});


test("idle retirement avoids reusing a CONNECT tunnel whose upstream FIN is delayed", async t => {
  let writes = 0;
  const f = await idleFixture(t, (request, response) => {
    if (request.method === "POST") writes++;
    // Like the box ingress, keep the HTTP connection without advertising its
    // idle timeout. The sidecar can learn about the peer's FIN later than us.
    response.once("finish", () => {
      const timer = setTimeout(() => request.socket.end(), 5000);
      timer.unref();
    });
    response.end("healthy");
  }, 500);
  f.upstream.keepAliveTimeout = 0;
  assert.deepEqual(await f.read(), { body: "healthy", reused: false });
  assert.deepEqual(await f.read(), { body: "healthy", reused: true });
  await new Promise(resolve => setTimeout(resolve, 5150));
  assert.deepEqual(await f.read("POST"), { body: "healthy", reused: false });
  assert.equal(writes, 1, "an idle reset must not replay a business request");
});
