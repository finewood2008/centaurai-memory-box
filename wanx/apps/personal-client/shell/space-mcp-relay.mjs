import http from "node:http";
import https from "node:https";

const routes = new Set(["/mcp/space", "/mcp/starlink"]);
const requestHeaders = ["authorization", "accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const responseHeaders = ["content-type", "mcp-protocol-version", "mcp-session-id", "www-authenticate", "allow", "retry-after"];
const select = (headers, names) => Object.fromEntries(names.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]));
const failure = code => Object.assign(new Error(code), {code});

// Transport only: the selected box authenticates the caller's original MCP Key.
// Never attach the desktop's account/session token or accept a caller's target.
export function createSpaceMcpRelay({state, persist, scope, storageScope, assertScope, client}) {
  const servers = new Map(), resets = new Map(), requests = new Map();
  let closed = false;
  const reject = (res, status, code) => {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"});
    res.end(JSON.stringify({error: code}));
  };

  async function open(owner, renew = false) {
    let origin;
    const server = http.createServer(async (req, res) => {
      if (req.headers.host !== new URL(origin).host || req.headers.origin ||
          ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]))
        return reject(res, 403, "MCP_ORIGIN_DENIED");
      const route = req.url;
      if (!routes.has(route)) return reject(res, 404, "MCP_NOT_FOUND");
      if (!["GET", "POST", "DELETE"].includes(req.method)) return reject(res, 405, "MCP_METHOD_NOT_ALLOWED");
      if (!/^Bearer [A-Za-z0-9_-]{20,100}$/.test(req.headers.authorization || ""))
        return reject(res, 401, "MCP_KEY_REQUIRED");
      const controller = new AbortController();
      requests.set(controller, owner);
      const finish = () => { requests.delete(controller); controller.abort(); };
      res.once("close", finish);
      req.once("aborted", finish);
      try {
        const bound = scope();
        assertScope(bound);
        if (closed || storageScope() !== owner) throw failure("SPACE_CONTEXT_CHANGED");
        const endpoint = await client.mcpConnection();
        assertScope(bound);
        endpoint.context();
        if (controller.signal.aborted || storageScope() !== owner) throw failure("SPACE_CONTEXT_CHANGED");
        const target = new URL(route, endpoint.url);
        const transport = target.protocol === "https:" ? https : http;
        const upstream = transport.request(target, {
          method: req.method, agent: endpoint.agent ?? false,
          signal: controller.signal, headers: select(req.headers, requestHeaders),
        });
        upstream.once("error", () => { reject(res, 503, "MCP_TRANSPORT_UNAVAILABLE"); finish(); });
        upstream.once("response", incoming => {
          try {
            assertScope(bound); endpoint.context();
            if (storageScope() !== owner) throw failure("SPACE_CONTEXT_CHANGED");
          } catch {
            incoming.destroy(); reject(res, 503, "SPACE_CONTEXT_CHANGED"); finish(); return;
          }
          res.writeHead(incoming.statusCode, {...select(incoming.headers, responseHeaders), "cache-control": "no-store"});
          incoming.once("error", () => { res.destroy(); finish(); });
          incoming.pipe(res);
        });
        req.pipe(upstream);
      } catch {
        reject(res, 503, "MCP_TRANSPORT_UNAVAILABLE"); finish();
      }
    });
    const saved = state.mcpRelays?.find(record => record.scope === owner);
    const reserved = new Set((state.mcpRelays || []).flatMap(record => [record.port, ...(record.retiredPorts || [])]));
    try {
      const fixed = !renew && saved?.port;
      // An old copied address must never become another account/box's endpoint,
      // including after restart or an explicit address reset.
      for (let attempt = 0; ; attempt++) {
        await new Promise((resolve, reject) => {
          const failed = error => { server.removeListener("listening", ready); reject(error); };
          const ready = () => { server.removeListener("error", failed); resolve(); };
          server.once("error", failed); server.once("listening", ready);
          server.listen(fixed || 0, "127.0.0.1");
        });
        if (fixed || !reserved.has(server.address().port)) break;
        await stop(server);
        if (attempt >= 31) throw failure("MCP_TRANSPORT_UNAVAILABLE");
      }
      origin = `http://127.0.0.1:${server.address().port}`;
      if (!saved || renew) {
        state.mcpRelays ||= [];
        const replacement = {scope: owner, port: server.address().port,
          ...(saved ? {retiredPorts: [...new Set([...(saved.retiredPorts || []), saved.port])]} : {})};
        if (saved) state.mcpRelays[state.mcpRelays.indexOf(saved)] = replacement;
        else state.mcpRelays.push(replacement);
        try { await persist(); }
        catch (error) {
          if (saved) state.mcpRelays[state.mcpRelays.indexOf(replacement)] = saved;
          else state.mcpRelays.splice(state.mcpRelays.indexOf(replacement), 1);
          throw error;
        }
      }
      if (closed) throw failure("MCP_TRANSPORT_UNAVAILABLE");
      return {server, url: origin + "/mcp/space"};
    } catch (error) {
      await stop(server);
      throw failure(error.code === "EADDRINUSE" ? "MCP_PORT_IN_USE" : "MCP_TRANSPORT_UNAVAILABLE");
    }
  }

  async function stop(server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  function remember(owner, pending) {
    servers.set(owner, pending);
    pending.catch(() => { if (servers.get(owner) === pending) servers.delete(owner); });
    return pending;
  }

  async function url() {
    const bound = scope(), owner = storageScope();
    assertScope(bound);
    if (closed || !owner) throw failure("MCP_TRANSPORT_UNAVAILABLE");
    if (!servers.has(owner)) {
      remember(owner, open(owner));
    }
    const result = await servers.get(owner);
    assertScope(bound);
    return result.url;
  }
  async function reset() {
    const bound = scope(), owner = storageScope();
    assertScope(bound);
    if (closed || !owner) throw failure("MCP_TRANSPORT_UNAVAILABLE");
    if (!resets.has(owner)) {
      const previous = servers.get(owner);
      const pending = (async () => {
        const entry = await previous?.catch(() => null);
        for (const [controller, requestOwner] of requests) if (requestOwner === owner) controller.abort();
        if (entry) await stop(entry.server);
        assertScope(bound);
        return open(owner, true);
      })();
      resets.set(owner, pending); remember(owner, pending);
      pending.finally(() => { if (resets.get(owner) === pending) resets.delete(owner); }).catch(() => {});
    }
    const result = await resets.get(owner);
    assertScope(bound);
    return result.url;
  }
  function contextChanged() {
    for (const controller of requests.keys()) controller.abort();
    requests.clear();
    // Reopen an already copied endpoint after restart/reconnect, on its saved port.
    if (!closed && client.snapshot().connection?.mode === "netbird" &&
        state.mcpRelays?.some(record => record.scope === storageScope())) void url().catch(() => {});
  }
  return {
    url, reset, contextChanged,
    async close() {
      closed = true; contextChanged();
      await Promise.all([...servers.values()].map(async pending => {
        const entry = await pending.catch(() => null);
        if (entry) await stop(entry.server);
      }));
      servers.clear();
    },
  };
}
