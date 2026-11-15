import { createHash } from "node:crypto";
import { readMemoryConnection } from "./local-memory-runtime.mjs";

const failure = message => Object.assign(new Error(message), { status: 400 });
const hash = value => value ? createHash("sha256").update(value).digest("hex") : null;
const shorten = (value, size) => typeof value === "string" ? value.slice(0, size).toWellFormed() : undefined;

export function createMyAiMemoryAccess({ runtimeFile, request = fetch }) {
  async function read(route, body, check) {
    check();
    const { base, token } = await readMemoryConnection(runtimeFile);
    check();
    const response = await request(new URL(route, base), {
      method: body ? "POST" : "GET",
      headers: { "x-memmy-local-token": token, ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw failure("记忆服务暂不可用，或该记忆已不可读取。");
    const result = await response.json();
    check();
    return result;
  }
  return {
    async ready(check) {
      const health = await read("/api/v1/health", undefined, check);
      if (health?.ok !== true || health?.storage?.ready !== true) throw failure("请先连接本机记忆服务。");
    },
    async call(tool, args, check, agent) {
      if (tool === "memory_search") {
        const result = await read("/api/v1/memory/search", { query: args.query.trim(), source: agent, limit: 10, verbose: true }, check);
        return {
          context: shorten(result.injectedContext, 12_000),
          matches: (result.debug?.hits ?? []).slice(0, 10).map(hit => ({
            memoryId: hit.id ?? hit.memoryId, title: shorten(hit.title, 300),
            snippet: shorten(hit.snippet ?? hit.summary ?? hit.content, 900),
          })).filter(hit => typeof hit.memoryId === "string"),
          memoryIds: (result.debug?.sourceMemoryIds ?? []).slice(0, 20),
        };
      }
      if (tool !== "memory_read" || !/^[A-Za-z0-9_-]{1,128}$/.test(args.memoryId)) throw failure("记忆标识无效。");
      const result = await read("/api/v1/memory/" + encodeURIComponent(args.memoryId), undefined, check);
      const item = result.item ?? result;
      if (item.id !== args.memoryId) throw failure("该记忆不可读取。");
      return {
        memoryId: item.id, layer: item.memoryLayer, title: shorten(item.title, 300),
        summary: shorten(item.summary, 1500), body: shorten(item.body ?? item.content ?? item.sourceText, 12_000),
      };
    },
  };
}

export function createMyAiAccess({ makeContext, agents, sources, memory, store, scope, owner, box }) {
  let records = {};
  const loaded = store.load().then(value => { records = value ?? {}; });
  void loaded.catch(() => {});
  let changes = Promise.resolve();
  let closed = false;
  const access = new Map(agents.map(agent => {
    const current = () => {
      const record = records[agent];
      return !closed && scope() && record?.owner === hash(owner()) && record?.box === hash(box()) ? record : null;
    };
    return [agent, makeContext(agent, {
      current,
      grant: async () => { await loaded; return current(); },
      call: (name, args, check) => name.startsWith("memory_")
        ? memory.call(name, args, check, agent)
        : sources.direct(name, args, check),
    })];
  }));

  const publicState = (agent, running) => ({
    connected: Boolean(records[agent] && records[agent].owner === hash(owner()) && running?.connected),
    available: Boolean(running?.connected && scope() && records[agent]?.owner === hash(owner()) && records[agent]?.box === hash(box())),
    boxReady: Boolean(scope()),
  });

  function action(agent, method, assertScope) {
    const context = access.get(agent);
    if (!context) throw failure("此 Agent 暂无可自动配置的资料接口。");
    const change = changes.then(async () => {
      await loaded;
      assertScope();
      if (closed) throw failure("客户端正在关闭。");
      if (method === "disconnect") {
        if (records[agent]?.owner === hash(owner())) {
          const updated = { ...records };
          delete updated[agent];
          const previous = records;
          records = updated; // Deny new and in-flight calls while the revocation is saved.
          try { await store.save(updated); } catch (error) { records = previous; throw error; }
          await context.manage("disconnect", {}, () => {});
        }
        return { connected: false, available: false, boxReady: Boolean(scope()) };
      }
      const bound = scope();
      const ownerKey = hash(owner());
      const boxKey = hash(box());
      if (!bound || !ownerKey || !boxKey) throw failure("请先连接当前账号的盒子。");
      const check = () => {
        assertScope();
        if (closed || scope() !== bound || hash(owner()) !== ownerKey || hash(box()) !== boxKey)
          throw failure("盒子或账号已切换，请重新连接。");
      };
      const verify = async (test, message) => {
        try { await test(); } catch { check(); throw failure(message); }
      };
      await Promise.all([
        verify(() => memory.ready(check), "本机记忆服务暂不可用，请重连后再试。"),
        verify(() => sources.catalog("", check, "space"), "当前盒子的个人空间暂不可用。"),
        verify(() => sources.catalog("", check, "starlink"), "当前盒子的星图仓库暂不可用。"),
      ]);
      check();
      try {
        await context.manage("connect", {}, check);
      } catch (error) {
        check();
        if (error.code === "EACCES" || error.code === "EPERM") throw failure("无法写入 Agent 配置，请检查本机配置权限。");
        if (error.message === "MCP_CONFIG_NAME_CONFLICT") throw failure("Agent 中的 wanx-memobox 名称已被占用，请检查原配置。");
        throw failure("无法自动写入 Agent 的 MCP 配置，请检查安装和配置文件后重试。");
      }
      check();
      const previous = records;
      const updated = { ...previous, [agent]: { owner: ownerKey, box: boxKey } };
      await store.save(updated);
      try { check(); } catch (error) { await store.save(previous); throw error; }
      records = updated;
      return { connected: true, available: true, boxReady: true };
    });
    changes = change.catch(() => {});
    return change;
  }

  return {
    codex: access.get("codex"),
    supports: agent => access.has(agent),
    connect: (agent, check) => action(agent, "connect", check),
    disconnect: (agent, check) => access.has(agent) && action(agent, "disconnect", check),
    async status(check) {
      await changes;
      await loaded;
      return Object.fromEntries(await Promise.all([...access].map(async ([agent, context]) => [
        agent, publicState(agent, await context.manage("status", {}, check)),
      ])));
    },
    async restore(reportError) {
      await loaded;
      await Promise.all([...access].filter(([agent]) => agent === "codex" || records[agent])
        .map(([, context]) => context.restore().catch(reportError)));
    },
    sync() { for (const context of access.values()) context.sync(); },
    async close() {
      closed = true;
      await changes;
      await Promise.all([...access.values()].map(context => context.close()));
    },
  };
}
