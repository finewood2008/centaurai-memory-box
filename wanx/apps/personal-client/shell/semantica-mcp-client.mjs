import http from "node:http";
import https from "node:https";

const warehouseId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const toolName = /^xingtu_[a-z0-9_]{1,100}$/;
const messages = {
  SEMANTICA_MCP_UPGRADE_REQUIRED: "当前盒子尚未提供 Semantica MCP，请更新并重启盒端服务。",
  SEMANTICA_MCP_ACCESS_DENIED: "Semantica MCP 拒绝访问，请检查仓库权限与 Key 状态。",
  SEMANTICA_MCP_UNAVAILABLE: "无法连接 Semantica MCP，请检查当前盒子连接。",
};
const failure = code => Object.assign(new Error(messages[code] ?? code), { code, status: 400 });

// Only the main process sees warehouse keys. The app's existing MCP transport
// supplies the direct/NetBird connection; never export its URL or credentials.
export function createSemanticaMcpClient({ client, scope, starlink, issueKey, now = Date.now }) {
  let bound, catalog, catalogExpires = 0, closed = false, serial = 0;
  const leases = new Map(), requests = new Set(), retiring = new Set();
  function retire(pending) {
    const work = pending.then(lease => lease.revoke()).catch(() => {}).finally(() => retiring.delete(work));
    retiring.add(work);
    return work;
  }
  function sync() {
    const next = scope();
    if (next !== bound) {
      bound = next;
      catalog = undefined;
      for (const controller of requests) controller.abort();
      for (const pending of leases.values()) retire(pending);
      leases.clear();
    }
    return next;
  }
  function guard(expected, check) {
    check();
    if (closed || !expected || sync() !== expected) throw failure("HOST_SESSION_EXPIRED");
  }
  async function leaseFor(id, expected, check) {
    guard(expected, check);
    if (!warehouseId.test(id)) throw failure("SEMANTICA_MCP_WAREHOUSE_REQUIRED");
    let pending = leases.get(id);
    if (pending && (await pending).expiresAt <= now()) {
      if (leases.get(id) === pending) {
        leases.delete(id);
        retire(pending);
      }
      pending = leases.get(id);
    }
    guard(expected, check);
    if (!pending) {
      pending = Promise.resolve().then(() => issueKey(id)).then(async lease => {
        if (!lease || !/^xg_[A-Za-z0-9_-]{30,80}$/.test(lease.token) ||
            !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now() || typeof lease.revoke !== "function") {
          await lease?.revoke?.().catch(() => {});
          throw failure("SEMANTICA_MCP_KEY_UNAVAILABLE");
        }
        return lease;
      });
      leases.set(id, pending);
      pending.catch(() => { if (leases.get(id) === pending) leases.delete(id); });
    }
    const lease = await pending;
    guard(expected, check);
    return lease;
  }
  async function rpc(id, method, params, expected, check) {
    const lease = await leaseFor(id, expected, check);
    const endpoint = await client.mcpConnection();
    guard(expected, check);
    endpoint.context();
    const target = new URL("/mcp/starlink", endpoint.url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
      throw failure("SEMANTICA_MCP_ADDRESS_INVALID");
    const notification = method === "notifications/initialized";
    const requestId = ++serial;
    const body = JSON.stringify({ jsonrpc: "2.0", ...(!notification && { id: requestId }), method, ...(params && { params }) });
    const controller = new AbortController();
    requests.add(controller);
    const deadline = setTimeout(() => controller.abort(), params?.name?.startsWith("xingtu_reasoning_") ? 330_000 : 95_000);
    deadline.unref?.();
    try {
      return await new Promise((resolve, reject) => {
        const outgoing = (target.protocol === "https:" ? https : http).request(target, {
          method: "POST", agent: endpoint.agent ?? false, signal: controller.signal,
          headers: { authorization: "Bearer " + lease.token, accept: "application/json, text/event-stream",
            "content-type": "application/json", "content-length": Buffer.byteLength(body), "mcp-protocol-version": "2025-03-26" },
        }, response => {
          const chunks = [];
          let size = 0;
          response.on("error", () => reject(failure("SEMANTICA_MCP_UNAVAILABLE")));
          response.on("data", chunk => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              response.destroy();
              reject(failure("SEMANTICA_MCP_RESPONSE_TOO_LARGE"));
            } else chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              guard(expected, check);
              endpoint.context();
              if (response.statusCode === 401 || response.statusCode === 403) throw failure("SEMANTICA_MCP_ACCESS_DENIED");
              if (response.statusCode === 404) throw failure("SEMANTICA_MCP_UPGRADE_REQUIRED");
              if (response.statusCode < 200 || response.statusCode >= 300) throw failure("SEMANTICA_MCP_UNAVAILABLE");
              if (notification) return resolve();
              let value;
              try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
              catch { throw failure("SEMANTICA_MCP_INVALID_REPLY"); }
              if (value?.jsonrpc !== "2.0" || value.id !== requestId || value.error || !value.result)
                throw failure("SEMANTICA_MCP_INVALID_REPLY");
              resolve(value.result);
            } catch (error) { reject(error); }
          });
        });
        outgoing.on("error", () => reject(failure("SEMANTICA_MCP_UNAVAILABLE")));
        outgoing.end(body);
      });
    } finally { clearTimeout(deadline); requests.delete(controller); }
  }
  async function discover(check) {
    const expected = sync();
    guard(expected, check);
    if (now() >= catalogExpires) catalog = undefined;
    if (!catalog) {
      const pending = (async () => {
        const result = await starlink("warehouses");
        guard(expected, check);
        if (!Array.isArray(result?.items)) throw failure("SEMANTICA_MCP_INVALID_REPLY");
        const warehouses = result.items.filter(row => warehouseId.test(row?.id) && row.state === "active")
          .map(row => ({ id: row.id, name: String(row.name || "星图仓库").slice(0, 160) }));
        if (!warehouses.length) return { tools: [], warehouses };
        const id = warehouses[0].id;
        const initialized = await rpc(id, "initialize", { protocolVersion: "2025-03-26", capabilities: {},
          clientInfo: { name: "wanx-memobox", version: "1.0.0" } }, expected, check);
        if (!initialized.serverInfo || !initialized.capabilities?.tools) throw failure("SEMANTICA_MCP_INVALID_REPLY");
        await rpc(id, "notifications/initialized", undefined, expected, check);
        const listed = await rpc(id, "tools/list", {}, expected, check);
        if (!Array.isArray(listed.tools) || listed.tools.length > 64 ||
            new Set(listed.tools.map(tool => tool.name)).size !== listed.tools.length ||
            listed.tools.some(tool => !toolName.test(tool.name) || tool.inputSchema?.type !== "object" ||
              Object.hasOwn(tool.inputSchema.properties ?? {}, "task_id") || Object.hasOwn(tool.inputSchema.properties ?? {}, "warehouseId")))
          throw failure("SEMANTICA_MCP_INVALID_REPLY");
        return { tools: listed.tools, warehouses };
      })();
      catalog = pending;
      catalogExpires = now() + 30_000;
      pending.catch(() => { if (catalog === pending) catalog = undefined; });
    }
    const result = await catalog;
    guard(expected, check);
    return result;
  }
  const unsubscribe = client.subscribe(sync);
  return {
    discover,
    async call(id, name, args, check) {
      const expected = sync();
      const { tools } = await discover(check);
      guard(expected, check);
      if (!tools.some(tool => tool.name === name)) throw failure("SEMANTICA_MCP_TOOL_UNAVAILABLE");
      const result = await rpc(id, "tools/call", { name, arguments: args }, expected, check);
      if (!Array.isArray(result.content)) throw failure("SEMANTICA_MCP_INVALID_REPLY");
      return result;
    },
    async close() {
      closed = true;
      unsubscribe();
      for (const controller of requests) controller.abort();
      for (const pending of leases.values()) retire(pending);
      leases.clear();
      await Promise.all([...retiring]);
    },
  };
}
