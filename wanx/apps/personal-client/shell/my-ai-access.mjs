import { createHash } from "node:crypto";
import { catalogAgent } from "./my-ai-catalog.mjs";
import { readMemoryConnection } from "./local-memory-runtime.mjs";

const failure = message => Object.assign(new Error(message), { status: 400 });
const hash = value => value ? createHash("sha256").update(value).digest("hex") : null;
const shorten = (value, size) => typeof value === "string" ? value.slice(0, size).toWellFormed() : undefined;
const environmentNote = "这条记忆描述来源设备和记录时的环境。执行操作前，请在当前设备核实路径、工作目录、分支和环境。";
const defaults = () => ({ memoryEnabled: false });
export const validMemoryAgent = value => value === undefined || value === null ||
  (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value));
const sourceKey = value => typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
const object = value => value && typeof value === "object" && !Array.isArray(value);

export const verificationScopes = (selection = {}) => selection.allPersonalReadOnly
  ? ["space", "starlink", "memory"].map(source => [source, "all-personal"])
  : [selection.folderId && ["space", selection.folderId], selection.warehouseId && ["starlink", selection.warehouseId],
    selection.memoryEnabled && ["memory", selection.memoryAgent ?? true]].filter(Boolean);

export function accessAgentId(agent, mode) {
  if (agent === "codex_cli") return "codex";
  if (agent === "claude_desktop") {
    if (mode === "code") return "claude_code";
    if (mode !== undefined && mode !== "chat" && mode !== "cowork") return null;
  }
  return agent;
}

export function createMyAiMemoryAccess({ runtimeFile, request = fetch }) {
  async function read(route, body, check) {
    const unavailable = () => {
      check();
      throw failure("本机记忆服务暂不可用，请在记忆盒子中恢复服务后重试。");
    };
    check();
    const { base, token } = await readMemoryConnection(runtimeFile).catch(unavailable);
    check();
    const response = await request(new URL(route, base), {
      method: body ? "POST" : "GET",
      headers: { "x-memmy-local-token": token, ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000),
    }).catch(unavailable);
    check();
    if (!response.ok) throw Object.assign(failure(route === "/api/v1/memory/add"
      ? response.status === 409 ? "保存标识已用于不同内容，请使用新的保存标识。" : "记忆保存未完成，请检查记忆服务和当前授权后重试。"
      : "本机记忆服务暂不可用，或该记忆已不可读取。"), { httpStatus: response.status });
    const result = await response.json().catch(unavailable);
    check();
    return result;
  }
  async function searchSource(query, source, check) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(source)) throw failure("记忆来源无效。");
    const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(query)]
      .filter(word => word.isWordLike && word.segment.length >= 2 &&
        !["知君", "记得", "上次", "帮我", "什么", "我们", "一下", "之前", "哪里", "哪个"].includes(word.segment))
      .map(word => word.segment);
    const terms = [...new Set([query, ...words])].slice(0, 5);
    const results = await Promise.all(terms.map(q => read("/api/v1/panel/items?" +
      new URLSearchParams({ q, sourceAgent: source, status: "activated" }), undefined, check)));
    const items = new Map(results.flatMap(result => result.items ?? []).map(item => [item.id, item]));
    return { matches: [...items.values()].slice(0, 10).map(item => ({
      memoryId: item.id, title: shorten(item.title, 300), snippet: shorten(item.sourceText || item.summary || item.content, 900),
    })) };
  }
  return {
    async sourceCatalog(check) {
      const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
      let agents;
      try {
        const result = await read("/api/v1/agent-sources", undefined, check);
        agents = (result.sources ?? []).filter(source => validId(source.sourceId) &&
            (source.available || source.messageCount > 0 || source.lastScannedAt))
          .map(source => ({ id: source.sourceId, name: source.displayName || source.sourceId }));
      } catch (error) {
        if (error.httpStatus !== 404) throw error;
        const { sourceDistribution = [] } = await read("/api/v1/panel/overview", undefined, check);
        const names = { codex: "Codex", claude_code: "Claude Code", claude_desktop: "Claude 客户端", gemini: "Gemini CLI" };
        agents = sourceDistribution.filter(row => row.count > 0 && validId(row.source))
          .map(row => ({ id: row.source, name: Object.hasOwn(names, row.source) ? names[row.source] : row.source }));
      }
      return [...agents.filter(source => source.id !== "accessories"), {id:"accessories", name:"配件"}];
    },
    searchSource,
    async call(tool, args, check, agent, binding = "", memoryAgent) {
      if (tool === "memory_save") {
        if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 12_000 || args.content.includes("\0") ||
            (args.title !== undefined && (typeof args.title !== "string" || args.title.length > 300)) ||
            (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.idempotencyKey))))
          throw failure("请提供有效的记忆内容和保存标识。");
        // The source and idempotency namespace belong to the connected client,
        // never to fields supplied by an agent's tool arguments.
        const requestId = hash(JSON.stringify([binding, agent, args.idempotencyKey ?? [args.content, args.title ?? ""]]));
        const source = catalogAgent(agent)?.sourceId ?? agent;
        const result = await read("/api/v1/memory/add", {
          content: args.content, ...(args.title !== undefined && { title: args.title }),
          layer: "L1", source, sourceAgentId: source, adapterId: "my-ai:" + agent, requestId,
        }, check);
        if (typeof result.id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(result.id))
          throw failure("记忆服务未返回已保存的记忆标识，请检查后重试。");
        return { saved: true, memoryId: result.id, duplicate: result.duplicate === true };
      }
      if (tool === "memory_search") {
        if (typeof memoryAgent === "string") {
          const { matches } = await searchSource(args.query.trim(), memoryAgent, check);
          return { environmentNote, matches, memoryIds: matches.map(item => item.memoryId) };
        }
        const result = await read("/api/v1/memory/search", {
          query: args.query.trim(), ...(memoryAgent === undefined && agent && { source: agent }), limit: 10, verbose: true,
        }, check);
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
      if (typeof memoryAgent === "string" && (sourceKey(item.metadata?.source) !== sourceKey(memoryAgent) ||
        item.status !== "activated")) throw failure("该记忆不在所选 Agent 的范围内。");
      return {
        environmentNote, memoryId: item.id, layer: item.memoryLayer, title: shorten(item.title, 300),
        summary: shorten(item.summary, 1500), body: shorten(item.body ?? item.content ?? item.sourceText, 12_000),
      };
    },
  };
}

export function createMyAiAccess({ makeContext, agents, sources, memory, store, scope, owner, box, spaceLinks }) {
  let records = {};
  const loaded = store.load().then(value => { records = object(value) ? value : {}; });
  void loaded.catch(() => {});
  let changes = Promise.resolve();
  let closed = false;
  let lastRestoreScope;
  const binding = () => hash(JSON.stringify([hash(owner()), hash(box())]));
  const matching = agent => records[agent]?.owner === hash(owner()) && records[agent]?.box === hash(box());
  const savedConnection = agent => {
    const record = records[agent];
    return record?.owner && record.box && record.connected !== false ? record : null;
  };
  const localConnection = agent => {
    const record = savedConnection(agent);
    const ownerKey = hash(owner()), boxKey = hash(box());
    return ownerKey && record?.owner === ownerKey && (!boxKey || record.box === boxKey) ? record : null;
  };
  const chosen = agent => {
    const selection = matching(agent) ? records[agent].selection : records.$selections?.[agent]?.[binding()];
    return {
      ...(typeof selection?.folderId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(selection.folderId) && { folderId: selection.folderId }),
      ...(typeof selection?.warehouseId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(selection.warehouseId) && { warehouseId: selection.warehouseId }),
      memoryEnabled: selection?.memoryEnabled === true,
      ...(selection?.memoryEnabled === true && selection.memoryAgent !== undefined && validMemoryAgent(selection.memoryAgent) &&
        { memoryAgent: selection.memoryAgent }),
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
    if (!object(selection) || Object.keys(selection).some(key => !["folderId", "warehouseId", "memoryEnabled", "memoryAgent"].includes(key)) ||
        (selection.memoryEnabled !== undefined && typeof selection.memoryEnabled !== "boolean") ||
        !validMemoryAgent(selection.memoryAgent) || (selection.memoryAgent !== undefined && selection.memoryEnabled !== true) ||
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
      return !closed && scope() && matching(agent) ? savedConnection(agent) : null;
    };
    return [agent, makeContext(agent, {
      current,
      toolAccess: () => savedConnection(agent),
      grant: async () => { await loaded; return current(); },
      async write(name, args, check) {
        const record = current();
        if (!spaceLinks?.output || !record?.allPersonalReadOnly || !record.outputFolder)
          throw failure("请先在「我的 AI」为 Codex 设置成果回写文件夹。");
        check();
        const output = record.outputFolder;
        const result = await spaceLinks.output(output, name, { ...args, target: args.target || output.id });
        check();
        return result;
      },
      async call(name, args, check, taskSelection) {
        const allPersonalReadOnly = current()?.allPersonalReadOnly === true;
        if (allPersonalReadOnly && name === "memory_save") throw failure("此连接仅允许读取个人资料。");
        if (allPersonalReadOnly && taskSelection === undefined) {
          return name.startsWith("memory_")
            ? memory.call(name, args, check, agent, binding(), null)
            : sources.direct(name, args, check);
        }
        const selected = taskSelection ?? chosen(agent);
        if (name.startsWith("memory_")) {
          if (name !== "memory_save" && !selected.memoryEnabled) throw failure("请先在「我的 AI」开启历史记忆读取。");
          return memory.call(name, args, check, agent, binding(), selected.memoryAgent);
        }
        const requested = name.startsWith("space_") ? { folderId: selected.folderId } : { warehouseId: selected.warehouseId };
        const { resolved } = await resolveSelection(requested, check);
        if (name.startsWith("space_") && !resolved.folderId) throw failure("请先选择允许检索的空间文件夹。");
        if ((name.startsWith("starlink_") || name.startsWith("xingtu_")) && !resolved.warehouseId) throw failure("请先选择允许检索的星图仓库。");
        if (name === "space_list") {
          if (args.folderId !== undefined && args.folderId !== resolved.folderId)
            throw failure("此入口仅列出所选目录；请使用 space_search 检索其文件和子目录。");
          return { items: [{ id: resolved.folderId, name: resolved.folderName, kind: "folder" }], selectedRoot: true };
        }
        if (name === "starlink_warehouses") return { warehouses: [{ id: resolved.warehouseId, name: resolved.warehouseName }] };
        if (name === "space_search" && args.folderId !== undefined && args.folderId !== resolved.folderId)
          throw failure("目标不在所选空间文件夹内。");
        if (args.warehouseId !== undefined && args.warehouseId !== resolved.warehouseId)
          throw failure("目标不在所选星图仓库内。");
        return sources.call(resolved, name, args, check);
      },
    })];
  }));

  const publicState = (agent, running) => {
    const boxReady = Boolean(scope());
    const local = localConnection(agent);
    const authorized = boxReady && Boolean(local) && matching(agent);
    const selection = chosen(agent);
    const allPersonalReadOnly = authorized && records[agent].allPersonalReadOnly === true;
    const revokedAccess = matching(agent) && records[agent].connected === false ? records[agent].revokedAccess : undefined;
    const required = verificationScopes({ ...selection, allPersonalReadOnly });
    const retrievalVerified = Boolean(authorized && required.length && required.every(([source, id]) => running?.verifiedScopes?.[source] === id));
    return {
      authorized, connected: Boolean(local && running?.configured), configured: Boolean(local && running?.configured),
      serviceReady: Boolean(local && running?.serviceReady), loaded: Boolean(local && running?.loaded),
      connectionTested: Boolean(local && running?.connectionTested),
      retrievalVerified, memorySaved: authorized ? running?.memorySaved ?? null : null,
      available: Boolean(authorized && running?.serviceReady && retrievalVerified), boxReady,
      guided: running?.guided === true, selection, allPersonalReadOnly,
      ...(revokedAccess && { revokedAccess }),
      ...(allPersonalReadOnly && records[agent].outputFolder && { outputFolder: {
        id: records[agent].outputFolder.id, name: records[agent].outputFolder.name,
      } }),
      taskIdRequired: authorized && running?.taskIdRequired === true,
    };
  };

  function action(agent, method, assertScope, options) {
    agent = accessAgentId(agent);
    const context = access.get(agent);
    if (!context) throw failure("此 Agent 暂无可自动配置的资料接口。");
    return serialize(async () => {
      assertScope();
      if (closed) throw failure("客户端正在关闭。");
      if (method === "disconnect") {
        if (matching(agent)) {
          const { outputFolder, ...record } = records[agent];
          if (outputFolder) await spaceLinks.manage("mcp-revoke", { id: outputFolder.connectionId });
          const revokedAccess = record.connected === false ? record.revokedAccess
            : record.allPersonalReadOnly === true ? "all-personal-read-only" : "connection";
          const updated = { ...records, [agent]: { ...record, connected: false, allPersonalReadOnly: false, revokedAccess } };
          const previous = records;
          records = updated; // Deny new and in-flight calls while the revocation is saved.
          try { await store.save(updated); } catch (error) { records = previous; throw error; }
          await context.manage("disconnect", {}, () => {});
        }
        return publicState(agent, await context.manage("status", {}, assertScope));
      }
      if (method === "test") {
        const record = localConnection(agent);
        if (!record) throw failure("请先在记忆盒子客户端配置智能体的本机连接。");
        const check = () => {
          assertScope();
          if (closed || localConnection(agent) !== record) throw failure("智能体的本机连接已变更，请重新测试。");
        };
        return publicState(agent, await context.manage("test", {}, check));
      }
      const ownerKey = hash(owner());
      const boxKey = hash(box());
      const check = guard(assertScope);
      if (options?.allPersonalReadOnly !== undefined && (options.allPersonalReadOnly !== true || agent !== "codex"))
        throw failure("仅支持为 Codex 确认全部个人资料的只读授权。");
      const allPersonalReadOnly = options?.allPersonalReadOnly === true ||
        (matching(agent) && records[agent].connected !== false && records[agent].allPersonalReadOnly === true);
      if (allPersonalReadOnly) await sources.catalog("", check, "space");
      else await resolveSelection(chosen(agent), check);
      check();
      let connection;
      try {
        connection = await context.manage("connect", {}, check);
      } catch (error) {
        check();
        const code = error.code ?? error.message;
        if (agent === "claude_code" && ["MCP_CONFIG_NAME_CONFLICT", "MCP_CONFIG_PERMISSION"].includes(code)) {
          const message = code === "MCP_CONFIG_NAME_CONFLICT"
            ? "Claude Code 已有一个 wanx-memobox 连接。确认它属于旧版记忆盒子后，在终端移除旧连接，再点击「修复连接」。"
            : "无法写入 Claude Code 配置。请检查配置权限。若需移除已确认的旧版连接，可复制命令在终端执行。";
          throw Object.assign(failure(message), { code: "CLAUDE_MCP_MANUAL_REPAIR" });
        }
        if (error.code === "EACCES" || error.code === "EPERM") throw failure("无法写入 Agent 配置，请检查本机配置权限。");
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
          MY_AI_MCP_START_FAILED: "本机资料服务未能启动，请重新打开记忆盒子客户端后再试。",
        };
        if (messages[code]) throw failure(messages[code]);
        throw failure("无法自动写入 Agent 的 MCP 配置，请检查安装和配置文件后重试。");
      }
      check();
      const previous = records;
      const updated = { ...previous, [agent]: { owner: ownerKey, box: boxKey, connected: true, selection: chosen(agent), allPersonalReadOnly,
        ...(allPersonalReadOnly && matching(agent) && previous[agent].outputFolder && { outputFolder: previous[agent].outputFolder }) } };
      await store.save(updated);
      try { check(); } catch (error) { await store.save(previous); throw error; }
      records = updated;
      return { ...publicState(agent, await context.manage("status", {}, assertScope)),
        ...(connection.configurationChanged && { configurationChanged: true }) };
    });
  }

  return {
    codex: access.get("codex"),
    context: (agent, mode) => access.get(accessAgentId(agent, mode)),
    supports: (agent, mode) => access.has(accessAgentId(agent, mode)),
    connect: (agent, check, options) => action(agent, "connect", check, options),
    test: (agent, check) => action(agent, "test", check),
    disconnect: (agent, check) => access.has(accessAgentId(agent)) && action(agent, "disconnect", check),
    outputFolder(agent, folderId, assertScope) {
      if (accessAgentId(agent) !== "codex" || !spaceLinks?.output ||
          (folderId !== null && (typeof folderId !== "string" || !/^[a-f0-9]{32}$/.test(folderId))))
        throw failure("请选择个人空间中的一个成果文件夹。");
      return serialize(async () => {
        const check = guard(assertScope);
        check();
        const record = matching("codex") && records.codex;
        if (!record?.allPersonalReadOnly || record.connected === false) throw failure("请先连接 Codex 的个人资料只读授权。");
        if (record.outputFolder?.id === folderId || (!record.outputFolder && folderId === null))
          return publicState("codex", await access.get("codex").manage("status", {}, check));
        let outputFolder;
        if (folderId !== null) {
          const { folder } = await sources.catalog(folderId, check, "space");
          if (folder?.id !== folderId) throw failure("找不到所选的个人文件夹。");
          const connection = await spaceLinks.manage("mcp-issue", { name: "Codex · 我的 AI 成果回写", internal: true });
          try {
            check();
            const grant = await spaceLinks.manage("mcp-grant", { id: connection.id, root: folderId, domain: "personal", purpose: "output" });
            check();
            outputFolder = { id: folderId, name: folder.name, connectionId: connection.id, grantId: grant.id };
          } catch (error) {
            await spaceLinks.manage("mcp-revoke", { id: connection.id }).catch(() => {});
            throw error;
          }
        }
        try {
          if (record.outputFolder) await spaceLinks.manage("mcp-revoke", { id: record.outputFolder.connectionId });
          check();
          const updated = { ...records, codex: { ...record, outputFolder } };
          await store.save(updated);
          records = updated;
          check();
        } catch (error) {
          if (outputFolder) await spaceLinks.manage("mcp-revoke", { id: outputFolder.connectionId }).catch(() => {});
          throw error;
        }
        return publicState("codex", await access.get("codex").manage("status", {}, check));
      });
    },
    async memoryCatalog(assertScope) {
      return { agents: await memory.sourceCatalog(guard(assertScope)) };
    },
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
        if (matching(agent) && ["folderId", "warehouseId", "memoryEnabled", "memoryAgent"].every(key => previousChoice[key] === selection[key]))
          return { selection, resources };
        const preferences = { ...records.$selections, [agent]: { ...records.$selections?.[agent], [binding()]: selection } };
        const previous = records;
        const updated = { ...previous, $selections: preferences, [agent]: {
          owner: hash(owner()), box: hash(box()), connected: matching(agent) && records[agent].connected !== false, selection,
          allPersonalReadOnly: matching(agent) && records[agent].connected !== false && records[agent].allPersonalReadOnly === true,
          ...(matching(agent) && records[agent].revokedAccess && { revokedAccess: records[agent].revokedAccess }),
          ...(matching(agent) && records[agent].outputFolder && { outputFolder: records[agent].outputFolder }),
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
      return Object.fromEntries(await Promise.all([...access].map(async ([agent, context]) => [
        agent, publicState(agent, await context.manage("status", {}, check)),
      ])));
    },
    async restore(reportError) {
      const bound = scope();
      if (closed || bound === lastRestoreScope) return;
      lastRestoreScope = bound;
      await serialize(async () => {
        if (closed || scope() !== bound) return;
        if (!bound) {
          // Let local MCP clients initialize while the box is connecting. The
          // saved connection permits only the transport until its scope is live.
          await Promise.all([...access].filter(([agent]) => savedConnection(agent))
            .map(([, context]) => context.restore(undefined, { beforeBox: true }).catch(reportError)));
          return;
        }
        const check = guard(() => {});
        await Promise.all([...access].filter(([agent]) => matching(agent) && records[agent].connected !== false)
          .map(([, context]) => context.restore(check).catch(reportError)));
      });
    },
    sync() { for (const context of access.values()) context.sync(); },
    async close() {
      closed = true;
      await changes;
      await Promise.all([...access.values()].map(context => context.close()));
    },
  };
}
