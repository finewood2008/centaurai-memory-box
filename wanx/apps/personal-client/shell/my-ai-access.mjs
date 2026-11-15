import { createHash } from "node:crypto";
import { readMemoryConnection } from "./local-memory-runtime.mjs";

const failure = message => Object.assign(new Error(message), { status: 400 });
const hash = value => value ? createHash("sha256").update(value).digest("hex") : null;
const shorten = (value, size) => typeof value === "string" ? value.slice(0, size).toWellFormed() : undefined;
const environmentNote = "这条记忆描述来源设备和记录时的环境。执行操作前，请在当前设备核实路径、工作目录、分支和环境。";
const defaults = () => ({ memoryEnabled: false });
const object = value => value && typeof value === "object" && !Array.isArray(value);

export function accessAgentId(agent, mode) {
  if (agent === "codex_cli") return "codex";
  if (agent === "claude_desktop") {
    if (mode === "code") return "claude_code";
    if (mode !== undefined && mode !== "chat") return null;
  }
  return agent;
}

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
    if (!response.ok) throw failure(route === "/api/v1/memory/add"
      ? response.status === 409 ? "保存标识已用于不同内容，请使用新的保存标识。" : "记忆保存未完成，请检查记忆服务和当前授权后重试。"
      : "记忆服务暂不可用，或该记忆已不可读取。");
    const result = await response.json();
    check();
    return result;
  }
  return {
    async ready(check) {
      const health = await read("/api/v1/health", undefined, check);
      if (health?.ok !== true || health?.storage?.ready !== true) throw failure("请先连接本机记忆服务。");
    },
    async call(tool, args, check, agent, binding = "") {
      if (tool === "memory_save") {
        if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 12_000 || args.content.includes("\0") ||
            (args.title !== undefined && (typeof args.title !== "string" || args.title.length > 300)) ||
            (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.idempotencyKey))))
          throw failure("请提供有效的记忆内容和保存标识。");
        // The source and idempotency namespace belong to the connected client,
        // never to fields supplied by an agent's tool arguments.
        const requestId = hash(JSON.stringify([binding, agent, args.idempotencyKey ?? [args.content, args.title ?? ""]]));
        const result = await read("/api/v1/memory/add", {
          content: args.content, ...(args.title !== undefined && { title: args.title }),
          layer: "L1", source: agent, sourceAgentId: agent, adapterId: "my-ai:" + agent, requestId,
        }, check);
        if (typeof result.id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(result.id))
          throw failure("记忆服务未返回已保存的记忆标识，请检查后重试。");
        return { saved: true, memoryId: result.id, duplicate: result.duplicate === true };
      }
      if (tool === "memory_search") {
        const result = await read("/api/v1/memory/search", { query: args.query.trim(), source: agent, limit: 10, verbose: true }, check);
        return {
          environmentNote,
          context: shorten(result.injectedContext, 12_000),
          matches: (result.debug?.hits ?? []).slice(0, 10).map(hit => ({
            memoryId: hit.id ?? hit.memoryId, title: shorten(hit.title, 300),
            snippet: shorten(hit.snippet ?? hit.summary ?? hit.content, 900),
          })).filter(hit => typeof hit.memoryId === "string"),
          memoryIds: (result.debug?.sourceMemoryIds ?? []).slice(0, 20),
        };
      }
      if (tool !== "memory_read" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(args.memoryId)) throw failure("记忆标识无效。");
      const result = await read("/api/v1/memory/" + encodeURIComponent(args.memoryId), undefined, check);
      const item = result.item ?? result;
      if (item.id !== args.memoryId) throw failure("该记忆不可读取。");
      return {
        environmentNote, memoryId: item.id, layer: item.memoryLayer, title: shorten(item.title, 300),
        summary: shorten(item.summary, 1500), body: shorten(item.body ?? item.content ?? item.sourceText, 12_000),
      };
    },
  };
}

export function createMyAiAccess({ makeContext, agents, sources, memory, store, scope, owner, box }) {
  let records = {};
  const loaded = store.load().then(value => { records = object(value) ? value : {}; });
  void loaded.catch(() => {});
  let changes = Promise.resolve();
  let closed = false;
  const binding = () => hash(JSON.stringify([hash(owner()), hash(box())]));
  const matching = agent => records[agent]?.owner === hash(owner()) && records[agent]?.box === hash(box());
  const chosen = agent => {
    const selection = matching(agent) ? records[agent].selection : records.$selections?.[agent]?.[binding()];
    return {
      ...(typeof selection?.folderId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(selection.folderId) && { folderId: selection.folderId }),
      ...(typeof selection?.warehouseId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(selection.warehouseId) && { warehouseId: selection.warehouseId }),
      memoryEnabled: selection?.memoryEnabled === true,
    };
  };
  function guard(assertScope) {
    const bound = scope(), ownerKey = hash(owner()), boxKey = hash(box());
    if (!bound || !ownerKey || !boxKey) throw failure("请先连接当前账号的盒子。");
    return () => {
      assertScope();
      if (closed || scope() !== bound || hash(owner()) !== ownerKey || hash(box()) !== boxKey)
        throw failure("盒子或账号已切换，请重新连接。");
    };
  }
  function serialize(perform) {
    const change = changes.then(async () => { await loaded; return perform(); });
    changes = change.catch(() => {});
    return change;
  }
  async function resolveSelection(selection, check) {
    if (!object(selection) || Object.keys(selection).some(key => !["folderId", "warehouseId", "memoryEnabled"].includes(key)) ||
        (selection.memoryEnabled !== undefined && typeof selection.memoryEnabled !== "boolean") ||
        [selection.folderId, selection.warehouseId].some(value => value !== undefined &&
          (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))))
      throw failure("资料范围无效，请重新选择。");
    const selected = { ...defaults(), ...selection };
    const resolved = selected.folderId || selected.warehouseId
      ? await sources.validate(selected.folderId, selected.warehouseId, check) : {};
    check();
    return { selection: selected, resources: {
      ...(resolved.folderId && { folder: { id: resolved.folderId, name: resolved.folderName } }),
      ...(resolved.warehouseId && { warehouse: { id: resolved.warehouseId, name: resolved.warehouseName } }),
    }, resolved: { ...resolved, memoryEnabled: selected.memoryEnabled } };
  }
  const access = new Map(agents.map(agent => {
    const current = () => {
      const record = records[agent];
      return !closed && scope() && matching(agent) && record.connected !== false ? record : null;
    };
    return [agent, makeContext(agent, {
      current,
      grant: async () => { await loaded; return current(); },
      async call(name, args, check, taskSelection) {
        const selected = taskSelection ?? chosen(agent);
        if (name.startsWith("memory_")) {
          if (name !== "memory_save" && !selected.memoryEnabled) throw failure("请先在「我的 AI」开启历史记忆读取。");
          return memory.call(name, args, check, agent, binding());
        }
        const { resolved } = await resolveSelection({
          ...(selected.folderId && { folderId: selected.folderId }),
          ...(selected.warehouseId && { warehouseId: selected.warehouseId }),
          memoryEnabled: selected.memoryEnabled === true,
        }, check);
        if (name.startsWith("space_") && !resolved.folderId) throw failure("请先选择允许检索的空间文件夹。");
        if (name.startsWith("starlink_") && !resolved.warehouseId) throw failure("请先选择允许检索的星图仓库。");
        if (name === "space_list") {
          if (args.folderId !== undefined && args.folderId !== resolved.folderId)
            throw failure("此入口仅列出所选目录；请使用 space_search 检索其文件和子目录。");
          return { items: [{ id: resolved.folderId, name: resolved.folderName, kind: "folder" }], selectedRoot: true };
        }
        if (name === "starlink_warehouses") return { warehouses: [{ id: resolved.warehouseId, name: resolved.warehouseName }] };
        if (args.warehouseId !== undefined && args.warehouseId !== resolved.warehouseId)
          throw failure("目标不在所选星图仓库内。");
        return sources.call(resolved, name, args, check);
      },
    })];
  }));

  const publicState = (agent, running, underlyingReady = true) => {
    const authorized = matching(agent) && records[agent].connected !== false && Boolean(scope());
    const selection = chosen(agent);
    const required = [selection.folderId && ["space", selection.folderId], selection.warehouseId && ["starlink", selection.warehouseId],
      selection.memoryEnabled && ["memory", true]].filter(Boolean);
    const retrievalVerified = Boolean(authorized && required.length && required.every(([source, id]) => running?.verifiedScopes?.[source] === id));
    return {
      authorized, connected: Boolean(authorized && running?.configured), configured: Boolean(authorized && running?.configured),
      serviceReady: Boolean(authorized && underlyingReady && running?.serviceReady), loaded: Boolean(authorized && running?.loaded),
      retrievalVerified, memorySaved: authorized ? running?.memorySaved ?? null : null,
      available: Boolean(authorized && underlyingReady && running?.serviceReady && retrievalVerified), boxReady: Boolean(scope()),
      guided: running?.guided === true, selection,
      taskIdRequired: authorized && running?.taskIdRequired === true,
    };
  };

  function action(agent, method, assertScope) {
    agent = accessAgentId(agent);
    const context = access.get(agent);
    if (!context) throw failure("此 Agent 暂无可自动配置的资料接口。");
    return serialize(async () => {
      assertScope();
      if (closed) throw failure("客户端正在关闭。");
      if (method === "disconnect") {
        if (matching(agent)) {
          const updated = { ...records, [agent]: { ...records[agent], connected: false } };
          const previous = records;
          records = updated; // Deny new and in-flight calls while the revocation is saved.
          try { await store.save(updated); } catch (error) { records = previous; throw error; }
          await context.manage("disconnect", {}, () => {});
        }
        return publicState(agent, await context.manage("status", {}, assertScope));
      }
      const ownerKey = hash(owner());
      const boxKey = hash(box());
      const check = guard(assertScope);
      const verify = async (test, message) => {
        try { await test(); } catch { check(); throw failure(message); }
      };
      await Promise.all([
        verify(() => memory.ready(check), "本机记忆服务暂不可用，请重连后再试。"),
        resolveSelection(chosen(agent), check),
      ]);
      check();
      try {
        await context.manage("connect", {}, check);
      } catch (error) {
        check();
        if (error.code === "EACCES" || error.code === "EPERM") throw failure("无法写入 Agent 配置，请检查本机配置权限。");
        const code = error.code ?? error.message;
        const messages = {
          MCP_CONFIG_NAME_CONFLICT: "Agent 中已存在不同的 wanx-memobox 连接。请在 Agent 设置中核对原连接后重试。",
          CODEX_CLI_NOT_FOUND: "未找到 Codex CLI，请先安装 Codex CLI 后重新配置资料工具。",
          CODEX_MCP_DISABLED: "Codex 已禁用记忆盒子资料连接，请在 Codex 的 MCP 设置中启用 wanx-memobox 后重试。",
          CODEX_MCP_REPAIR_CANCELLED: "已取消更新，原来的 Codex 资料连接已保留。",
          CODEX_MCP_READ_FAILED: "无法读取 Codex 的 MCP 配置，请检查 Codex CLI 和配置文件格式后重试。",
          CODEX_MCP_CLI_FAILED: "Codex CLI 未能更新 MCP 配置，请检查配置文件格式和本机 Codex CLI 后重试。",
          MCP_CONFIG_INVALID: "Agent 的 MCP 配置格式或文件类型不受支持，请检查配置文件后重试。",
          MCP_CONFIG_AMBIGUOUS: "检测到多份 Agent MCP 配置，请先在 Agent 中确认使用的配置文件。",
          MCP_CONFIG_CHANGED: "Agent 配置刚被其他程序修改，未覆盖该修改，请重新配置资料工具。",
          MCP_CONFIG_VERIFY_FAILED: "Agent 的 MCP 配置写入后校验未通过，请检查配置后重试。",
        };
        if (messages[code]) throw failure(messages[code]);
        throw failure("无法自动写入 Agent 的 MCP 配置，请检查安装和配置文件后重试。");
      }
      check();
      const previous = records;
      const updated = { ...previous, [agent]: { owner: ownerKey, box: boxKey, connected: true, selection: chosen(agent) } };
      await store.save(updated);
      try { check(); } catch (error) { await store.save(previous); throw error; }
      records = updated;
      return publicState(agent, await context.manage("status", {}, assertScope));
    });
  }

  return {
    codex: access.get("codex"),
    context: (agent, mode) => access.get(accessAgentId(agent, mode)),
    supports: (agent, mode) => access.has(accessAgentId(agent, mode)),
    connect: (agent, check) => action(agent, "connect", check),
    disconnect: (agent, check) => access.has(accessAgentId(agent)) && action(agent, "disconnect", check),
    async selection(agent, input, assertScope = () => {}) {
      agent = accessAgentId(agent);
      if (!access.has(agent)) throw failure("此 Agent 不在当前管理目录。");
      if (input === undefined) {
        await changes; await loaded;
        const { selection, resources } = await resolveSelection(chosen(agent), guard(assertScope));
        return { selection, resources };
      }
      return serialize(async () => {
        const check = guard(assertScope);
        const { selection, resources } = await resolveSelection(input, check);
        const previousChoice = chosen(agent);
        if (matching(agent) && ["folderId", "warehouseId", "memoryEnabled"].every(key => previousChoice[key] === selection[key]))
          return { selection, resources };
        const preferences = { ...records.$selections, [agent]: { ...records.$selections?.[agent], [binding()]: selection } };
        const previous = records;
        const updated = { ...previous, $selections: preferences, [agent]: {
          owner: hash(owner()), box: hash(box()), connected: matching(agent) && records[agent].connected !== false, selection,
        } };
        await store.save(updated);
        try { check(); } catch (error) { await store.save(previous); throw error; }
        records = updated;
        access.get(agent).invalidate?.();
        return { selection, resources };
      });
    },
    async configuration(agent, check = () => {}) {
      await loaded;
      const assertScope = guard(check);
      assertScope();
      const context = access.get(accessAgentId(agent));
      if (!context) throw failure("此 Agent 不在当前管理目录。");
      const configuration = await context.configuration();
      assertScope();
      return configuration;
    },
    async status(check = () => {}) {
      await changes;
      await loaded;
      let underlyingReady = true;
      if (scope()) {
        try { await memory.ready(check); }
        catch { check(); underlyingReady = false; }
      }
      return Object.fromEntries(await Promise.all([...access].map(async ([agent, context]) => [
        agent, publicState(agent, await context.manage("status", {}, check), underlyingReady),
      ])));
    },
    async restore(reportError) {
      await loaded;
      await Promise.all([...access].filter(([agent]) => matching(agent) && records[agent].connected !== false)
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
