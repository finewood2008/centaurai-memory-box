// ../builder/integration/team-client/space-mcp-tools.mjs
import { createHash, randomUUID } from "node:crypto";
var MAX_CHUNK = 4 * 1024 * 1024;
var hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
var fail = (code) => Object.assign(Error(code), { code });
var actions = ["describe", "stat", "list", "read", "mkdir", "move", "trash", "restore", "restore-version", "begin-write", "write-chunk", "commit-write", "write-status", "cancel-write"];
var schema = {
  type: "object",
  additionalProperties: false,
  required: ["link", "action"],
  properties: {
    link: { type: "string", description: "Exact localhost access link copied from WANX. Never a public URL." },
    action: { type: "string", enum: actions },
    target: { type: "string", description: "Resource ID within the authorized scope; omitted means its root. For mkdir and new writes, the destination folder. stat returns metadata for a known recycled item too, but read cannot read recycled content." },
    parent: { type: "string", description: "For mkdir, alias of target for the destination folder; if both are provided they must match. For move, the destination folder ID within the same scope." },
    name: { type: "string" },
    expected: { type: "integer", minimum: 1, description: "Observed resource version, required for move, trash, restore, restore-version and overwrites. trash returns the updated version; use it or query stat before restore. Never guess a version." },
    upload_id: { type: "string" },
    size: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 },
    length: { type: "integer", minimum: 1, maximum: MAX_CHUNK },
    digest: { type: "string" },
    data: { type: "string", description: "Base64 chunk" }
  }
};
async function callTool(name, args, request) {
  const rawRequest = request;
  const binding = Object.fromEntries(["task_id", "policy_revision", "progress", "operation_id"].filter((k) => args[k] !== void 0).map((k) => [k, args[k]]));
  if (args.task_id && !binding.operation_id) binding.operation_id = randomUUID();
  request = (input) => rawRequest({ ...binding, ...input });
  if (name === "space") return request(args);
  if (name === "space_read_text") {
    const entry = await request({ link: args.link, grant_id: args.grant_id, target: args.target, action: "stat" });
    if (entry.kind !== "file" || entry.size > 1024 * 1024) throw fail("SPACE_TEXT_LIMIT");
    const result = await request({ link: args.link, grant_id: args.grant_id, target: args.target, action: "read", length: 1024 * 1024, expected: entry.version });
    const bytes = Buffer.from(result.data, "base64");
    if (hash(bytes) !== entry.digest) throw fail("SPACE_CHUNK_INVALID");
    return { ...entry, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }
  if (name !== "space_write_text") throw fail("SPACE_TOOL_NOT_FOUND");
  if (typeof args.text !== "string" || Buffer.byteLength(args.text) > 1024 * 1024) throw fail("SPACE_TEXT_LIMIT");
  const data = Buffer.from(args.text), upload_id = randomUUID().replaceAll("-", "");
  await request({ link: args.link, grant_id: args.grant_id, action: "begin-write", target: args.target, name: args.name, expected: args.expected, upload_id, size: data.length });
  try {
    if (data.length) await request({ link: args.link, grant_id: args.grant_id, action: "write-chunk", upload_id, offset: 0, data: data.toString("base64"), digest: hash(data) });
    return await request({ link: args.link, grant_id: args.grant_id, action: "commit-write", upload_id, digest: hash(data) });
  } catch (error) {
    await request({ link: args.link, grant_id: args.grant_id, action: "cancel-write", upload_id }).catch(() => {
    });
    throw error;
  }
}

// ../builder/integration/team-client/wanx-mcp.mjs
var versions = ["2025-03-26", "2025-06-18", "2025-11-25"];
var fail2 = (code, status = 400) => Object.assign(Error(code), { code, status });
var object = (properties) => ({ type: "object", additionalProperties: false, properties });
var string = { type: "string", maxLength: 128 };
var integer = (min, max) => ({ type: "integer", minimum: min, maximum: max });
var identifier = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" };
var spaceSchema = structuredClone(schema);
delete spaceSchema.properties.link;
spaceSchema.required = ["action"];
spaceSchema.properties.grant_id = string;
var tool = (name, description, inputSchema, readOnlyHint = true) => ({ name, description, inputSchema, annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false } });
var spaceTools = [
  tool("space_access", "\u67E5\u770B Key \u83B7\u51C6\u7684\u7A7A\u95F4\u548C\u6587\u4EF6\u8303\u56F4\u3002\u8865\u5145\u76EE\u5F55\u4ECD\u9700\u6240\u6709\u8005\u6388\u6743\u3002", object({}), true),
  tool("space", "\u5728 Key \u83B7\u51C6\u8303\u56F4\u5185\u64CD\u4F5C\u6587\u4EF6\u3002\u5199\u5165\u9700\u8981\u5DF2\u8BFB\u53D6\u7684\u7248\u672C\uFF1B\u5220\u9664\u8FDB\u5165\u56DE\u6536\u7AD9\u3002", spaceSchema, false),
  tool("space_read_text", "\u8BFB\u53D6\u83B7\u51C6\u8303\u56F4\u5185\u7684 UTF-8 \u6587\u672C\uFF0C\u6700\u591A 1 MiB\uFF0C\u8FD4\u56DE\u7248\u672C\u548C\u6458\u8981\u3002", object({ target: string, grant_id: string })),
  tool("space_write_text", "\u521B\u5EFA\u6216\u66F4\u65B0\u83B7\u51C6\u8303\u56F4\u5185\u7684 UTF-8 \u6587\u672C\u3002\u8986\u76D6\u9700\u8981 expected \u7248\u672C\u3002", { ...object({ target: string, grant_id: string, name: { type: "string", maxLength: 240 }, expected: integer(1, Number.MAX_SAFE_INTEGER), text: { type: "string", maxLength: 1024 * 1024 } }), required: ["text"] }, false)
];
var knowledgeTools = [
  tool("xingtu_warehouse", "\u8BFB\u53D6 Key \u5BF9\u5E94\u7684\u661F\u56FE\u4ED3\u5E93\u6982\u51B5\u3002\u4ED3\u5E93\u7531 Key \u51B3\u5B9A\u3002", object({})),
  tool("xingtu_documents", "\u8BFB\u53D6\u6388\u6743\u4ED3\u7684\u6750\u6599\u4FE1\u606F\u3002", object({ limit: integer(1, 200), offset: integer(0, Number.MAX_SAFE_INTEGER) })),
  tool("xingtu_graph", "\u8BFB\u53D6\u672C\u673A\u4F1A\u8BDD\u6240\u6279\u51C6\u4ED3\u5E93\u7684\u77E5\u8BC6\u56FE\u8C31\u4E0E\u6765\u6E90\uFF0C\u9075\u5FAA\u5F53\u524D\u4FDD\u62A4\u89C4\u5219\u3002", object({ limit: integer(1, 500), entity_id: identifier })),
  tool("xingtu_search", "\u68C0\u7D22\u6388\u6743\u4ED3\u7684\u8BC1\u636E\uFF0C\u8FD4\u56DE\u53D7\u4FDD\u62A4\u7684\u7247\u6BB5\u53CA\u6765\u6E90\u3002", { ...object({ query: { type: "string", minLength: 1, maxLength: 2e3 }, limit: integer(1, 50) }), required: ["query"] }),
  tool("xingtu_evidence", "\u6309 ID \u8BFB\u53D6\u672C\u673A\u4F1A\u8BDD\u6240\u6279\u51C6\u4ED3\u5E93\u5185\u7684\u53D7\u4FDD\u62A4\u8BC1\u636E\u3002", { ...object({ evidence_id: identifier }), required: ["evidence_id"] })
];
function validate(args, s) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => !Object.hasOwn(s.properties, k))) throw fail2("MCP_ARGUMENT_INVALID");
  for (const k of s.required || []) if (args[k] === void 0) throw fail2("MCP_ARGUMENT_INVALID");
  for (const [key, value] of Object.entries(args)) {
    const p = s.properties[key];
    if (p.type === "string" && (typeof value !== "string" || value.length < (p.minLength || 0) || value.length > (p.maxLength || Infinity) || p.enum && !p.enum.includes(value) || p.pattern && !new RegExp(p.pattern).test(value))) throw fail2("MCP_ARGUMENT_INVALID");
    if (p.type === "integer" && (!Number.isSafeInteger(value) || value < p.minimum || value > p.maximum)) throw fail2("MCP_ARGUMENT_INVALID");
  }
}
function mcpConfiguration(url, kind) {
  return { mcpServers: { [kind === "space" ? "wanx-space" : "xingtu"]: { url, headers: { Authorization: "Bearer <\u8BBF\u95EE Key>" } } } };
}
function createWanxMcp({ resolve, kind }) {
  if (!["space", "knowledge"].includes(kind)) throw Error("MCP_SURFACE_REQUIRED");
  const tools = kind === "space" ? spaceTools : knowledgeTools;
  return async function handle(req, res) {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...status === 405 ? { allow: "POST" } : {} });
      res.end(value === void 0 ? "" : JSON.stringify(value));
    };
    let id = null;
    try {
      if (req.headers.origin) throw fail2("MCP_ORIGIN_DENIED", 403);
      const raw = req.headers.authorization;
      if (typeof raw !== "string" || !/^Bearer [A-Za-z0-9_-]{20,100}$/.test(raw)) throw fail2("MCP_KEY_REQUIRED", 401);
      const access = await resolve(raw.slice(7));
      if (access.kind !== kind) throw fail2("MCP_KEY_INVALID", 401);
      if (req.method !== "POST") return send(405, { error: { code: "MCP_METHOD_NOT_ALLOWED" } });
      const protocol = req.headers["mcp-protocol-version"];
      if (protocol && !versions.includes(protocol)) throw fail2("MCP_VERSION_UNSUPPORTED");
      if (!String(req.headers.accept).includes("application/json") || !String(req.headers.accept).includes("text/event-stream")) throw fail2("MCP_ACCEPT_REQUIRED", 406);
      if (!String(req.headers["content-type"]).startsWith("application/json")) throw fail2("MCP_JSON_REQUIRED", 415);
      const chunks = [];
      let size = 0;
      for await (const b of req) {
        size += b.length;
        if (size > 6 * 1024 * 1024) throw fail2("MCP_REQUEST_TOO_LARGE", 413);
        chunks.push(b);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw fail2("MCP_INVALID_JSON");
      }
      if (!body || body.jsonrpc !== "2.0" || Array.isArray(body) || typeof body.method !== "string" || body.id !== void 0 && typeof body.id !== "string" && typeof body.id !== "number") throw fail2("MCP_INVALID_REQUEST");
      id = body.id ?? null;
      const reply = (result) => send(200, { jsonrpc: "2.0", id, result });
      if (body.id === void 0) {
        if (!["notifications/initialized", "notifications/cancelled"].includes(body.method)) throw fail2("MCP_INVALID_NOTIFICATION");
        return send(202);
      }
      if (body.method === "initialize") return reply({ protocolVersion: versions.includes(body.params?.protocolVersion) ? body.params.protocolVersion : versions.at(-1), capabilities: { tools: {} }, serverInfo: { name: kind === "space" ? "wanx-space" : "xingtu", title: kind === "space" ? "\u7A7A\u95F4 MCP" : "\u661F\u56FE MCP", version: "1.0.0" }, instructions: kind === "space" ? "\u4EC5\u64CD\u4F5C\u7A7A\u95F4 Key \u83B7\u51C6\u7684\u6587\u4EF6\u8303\u56F4\u3002\u661F\u56FE\u4F7F\u7528\u72EC\u7ACB MCP \u5730\u5740\u548C\u4ED3\u5E93 Key\u3002\u5BA2\u6237\u7AEF\u9700\u4FDD\u6301\u8FD0\u884C\u3002" : "\u4EC5\u8BBF\u95EE\u672C\u673A\u4F1A\u8BDD Key \u7ED1\u5B9A\u7684\u5DF2\u6279\u51C6\u661F\u56FE\u4ED3\u5E93\uFF1B\u4EC5\u6750\u6599\u3001\u56FE\u8C31\u3001\u8BC1\u636E\u8BFB\u53D6\u548C\u8131\u654F\u68C0\u7D22\u3002\u7A7A\u95F4\u6587\u4EF6\u4F7F\u7528\u72EC\u7ACB MCP \u5730\u5740\u548C\u7A7A\u95F4 Key\u3002\u5BA2\u6237\u7AEF\u9700\u4FDD\u6301\u8FD0\u884C\u3002" });
      if (body.method === "ping") return reply({});
      if (body.method === "tools/list") return reply({ tools });
      if (body.method === "tools/call") {
        const name = body.params?.name, args = body.params?.arguments ?? {}, definition = tools.find((t) => t.name === name);
        if (!definition) return send(200, { jsonrpc: "2.0", id, error: { code: -32602, message: "MCP_TOOL_DENIED" } });
        validate(args, definition.inputSchema);
        try {
          let value;
          if (access.kind === "space") value = name === "space_access" ? await access.request({ action: "access" }) : await callTool(name, args, access.request);
          else {
            const paths = { xingtu_warehouse: "/warehouse", xingtu_documents: "/documents", xingtu_graph: "/graph", xingtu_search: "/search", xingtu_evidence: "/evidence/" + encodeURIComponent(args.evidence_id || "") };
            let path = paths[name];
            if (name === "xingtu_search") value = await access.request(path, { method: "POST", body: args });
            else {
              const query = new URLSearchParams(Object.entries(args).filter(([k]) => k !== "evidence_id"));
              if (query.size) path += "?" + query;
              value = await access.request(path);
            }
          }
          await access.check();
          return reply({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value && typeof value === "object" && !Array.isArray(value) ? value : { result: value } });
        } catch (error) {
          return reply({ isError: true, content: [{ type: "text", text: error.code || "MCP_RESOURCE_UNAVAILABLE" }] });
        }
      }
      return send(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "MCP_METHOD_NOT_FOUND" } });
    } catch (error) {
      send(error.status || 503, { jsonrpc: "2.0", id, error: { code: -32e3, message: error.code || "MCP_UNAVAILABLE" } });
    }
  };
}

// ../builder/integration/team-client/wanx-mcp-bridge.mjs
import { createHash as createHash2, timingSafeEqual } from "node:crypto";
var same = (a, b) => typeof a === "string" && typeof b === "string" && timingSafeEqual(createHash2("sha256").update(a).digest(), createHash2("sha256").update(b).digest());
var fail3 = (code, status = 403) => Object.assign(Error(code), { code, status });
function createWanxMcpBridge({ client, state, scope, assertScope, access, remote }) {
  async function resolveCloudKnowledge(key) {
    if (!key.startsWith("xg_")) throw fail3("MCP_KEY_INVALID", 401);
    const bound = scope();
    assertScope(bound);
    const captured = client.snapshot(), identity = [captured.account?.accountId, captured.account?.clientId, captured.connection?.deviceId];
    const checkIdentity = (connection) => {
      const current = client.snapshot();
      if (current.phase !== "ready" || current.account?.phase !== "authenticated" || current.dataIdentity || current.connection?.authorization != null || !identity.every((value) => typeof value === "string" && value.length > 0) || JSON.stringify(identity) !== JSON.stringify([current.account?.accountId, current.account?.clientId, current.connection?.deviceId])) throw fail3("MCP_SESSION_CLOSED");
      if (connection) {
        const context = connection.context();
        if (context.authorization != null || context.dataIdentity || context.principalId || JSON.stringify(identity) !== JSON.stringify([context.accountId, context.clientId, context.boxId])) throw fail3("MCP_SESSION_CLOSED");
      }
      assertScope(bound);
    };
    checkIdentity();
    async function request(path, options = {}) {
      checkIdentity();
      const connection = await client.applicationConnection("wanx");
      checkIdentity(connection);
      const response = await connection.request({
        path: "/api/semantica/open/v1" + path,
        method: options.method || "GET",
        headers: { "X-Xingtu-Key": key, "content-type": "application/json" },
        ...options.body ? { body: Buffer.from(JSON.stringify(options.body)) } : {}
      });
      checkIdentity(connection);
      if (response.body.length > 8 * 1024 * 1024) throw fail3("MCP_RESPONSE_TOO_LARGE");
      let value;
      try {
        value = JSON.parse(Buffer.from(response.body).toString("utf8"));
      } catch {
        throw fail3("MCP_KNOWLEDGE_UNAVAILABLE", 503);
      }
      if (response.status < 200 || response.status >= 300) throw fail3(typeof value?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(value.code) ? value.code : "MCP_KNOWLEDGE_DENIED", response.status === 401 ? 401 : response.status === 403 ? 403 : 503);
      return value;
    }
    const check = () => request("/warehouse");
    await check();
    return { kind: "knowledge", request, check };
  }
  async function resolveSpace(key) {
    const bound = scope();
    assertScope(bound);
    const link = state.links.find((r) => same(r.key, key) && r.scope === bound && !r.revoked);
    if (!link) throw fail3("MCP_KEY_INVALID", 401);
    const execute = (input) => access(link, { ...input, action: input.action === "access" ? "describe" : input.action });
    const check = async () => {
      await execute({ action: "describe" });
      assertScope(bound);
    };
    await check();
    return { kind: "space", check, request: async (input) => {
      if (input.grant_id) throw fail3("SPACE_ACCESS_DENIED");
      const { grant_id, ...rest } = input;
      const response = await execute(rest);
      assertScope(bound);
      if (input.action === "read") return { data: response.bytes.toString("base64"), size: response.bytes.length, encoding: "base64", version: Number(response.headers.etag), digest: response.headers["x-file-sha256"] };
      return response.value;
    } };
  }
  async function details(kind = "space") {
    if (!["space", "starlink"].includes(kind)) throw fail3("MCP_SURFACE_INVALID", 400);
    const bound = scope();
    assertScope(bound);
    const url = `http://127.0.0.1:${state.port}/mcp/${kind}`;
    if (kind === "starlink") return { url, transport: "Streamable HTTP", authentication: "Authorization: Bearer <\u4ED3\u5E93 Key>", configuration: mcpConfiguration(url, "knowledge"), keys: [], capabilities: ["\u661F\u56FE\u77E5\u8BC6\u8BFB\u53D6"], localOnly: true };
    const links = await remote(bound, "/agent-links");
    assertScope(bound);
    const keys = state.links.filter((r) => r.scope === bound && !r.revoked).flatMap((r) => {
      const live = links.value.find((v) => v.id === r.id && !v.revoked && (!v.expires || v.expires * 1e3 > Date.now()));
      return live ? [{ id: r.id, name: live.name || "\u6587\u4EF6\u8BBF\u95EE\u6388\u6743", prefix: r.key.slice(0, 8), kind: "\u6587\u4EF6\u8303\u56F4", status: "\u6709\u6548" }] : [];
    });
    return { url, transport: "Streamable HTTP", authentication: "Authorization: Bearer <\u7A7A\u95F4 Key>", configuration: mcpConfiguration(url, "space"), keys, capabilities: ["\u7A7A\u95F4\u6587\u4EF6\u8BBF\u95EE"], localOnly: true };
  }
  async function spaceKey(id) {
    const d = await details();
    if (!d.keys.some((k) => k.id === id && k.status === "\u6709\u6548")) throw fail3("MCP_KEY_INVALID", 401);
    const bound = scope(), r = state.links.find((r2) => r2.id === id && r2.scope === bound);
    if (!r) throw fail3("MCP_KEY_INVALID", 401);
    await resolveSpace(r.key);
    assertScope(bound);
    return r.key;
  }
  const handlers = {
    "/mcp/space": createWanxMcp({ kind: "space", resolve: resolveSpace }),
    "/mcp/starlink": createWanxMcp({ kind: "knowledge", resolve: resolveCloudKnowledge })
  };
  async function handle(req, res) {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (handlers[path]) return handlers[path](req, res);
    res.writeHead(path === "/mcp" ? 410 : 404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: { code: path === "/mcp" ? "MCP_SEPARATE_ENDPOINTS_REQUIRED" : "MCP_NOT_FOUND" } }));
  }
  return { handle, details, spaceKey };
}
export {
  createWanxMcpBridge
};
