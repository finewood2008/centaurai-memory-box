import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMemoryModelBridge, SELECTABLE_MODEL_ROLES } from "./memory-model-bridge.mjs";
import { createLocalMemorySpace } from "./space-local-memory.mjs";
import { createMemoryBackup } from "./memory-backup.mjs";
import { readMemoryConnection } from "./local-memory-runtime.mjs";
import { catalogAgent, contextAgent } from "./my-ai-catalog.mjs";

export const MEMORY_SCHEME = "wanx-memory";
export const MEMORY_ORIGIN = `${MEMORY_SCHEME}://local`;
const ENTRY = "wanx-memory.html";
const ID = "[A-Za-z0-9_.:%~-]+";
const isAgentPreferenceId = value => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(value);
const routes = {
  GET: [
    /^\/api\/app\/(?:bootstrap|token-usage|scan-preferences|model-config|byok-token-usage\/memory-budget)$/,
    /^\/api\/v1\/(?:health|memory\/logs|panel\/(?:analysis|items|overview|overview-stats|stats|tasks|task-summaries))$/,
    new RegExp(`^/api/v1/(?:memory/(?:recalls/)?${ID}|panel/(?:logs|memory)/${ID}|panel/task-details/${ID}(?:/check|/turns/${ID}/field)?)$`),
    /^\/api\/(?:local-data|agent-sources(?:\/scan\/status|\/memory-plugin-conflicts)?)$/,
    new RegExp(`^/api/agent-sources/scan/jobs/${ID}/results$`),
  ],
  POST: [
    /^\/api\/app\/model-config\/test$/,
    /^\/api\/v1\/(?:panel\/(?:browse|logs)|memory\/(?:add|search|processing\/status))$/,
    new RegExp(`^/api/v1/(?:memory/${ID}/processing/retry|evidence/skills/${ID}/approve)$`),
    /^\/api\/(?:local-data\/(?:reveal|export)|agent-sources\/(?:manual|scan(?:\/stop|\/cancel)?))$/,
    new RegExp(`^/api/agent-sources/${ID}/(?:managed/sync|plugin|skill)$`),
  ],
  PATCH: [
    /^\/api\/app\/(?:settings|scan-preferences|onboarding)$/,
    new RegExp(`^/api/v1/evidence/skills/${ID}$`),
    new RegExp(`^/api/agent-sources/${ID}/plugin$`),
  ],
  PUT: [/^\/api\/app\/model-config$/],
  DELETE: [
    /^\/api\/local-data$/,
    new RegExp(`^/api/v1/(?:memory|panel/tasks)/${ID}$`),
    new RegExp(`^/api/agent-sources/${ID}(?:/(?:plugin|skill))?$`),
  ],
};

function accountScope(state) {
  const identity = state.dataIdentity;
  if (identity?.profileId) return identity.phase === "unlocked" ? `local:${identity.profileId}:${identity.generation}` : null;
  const account = state.account;
  return account?.phase === "authenticated" && account.accountId ? `account:${account.accountId}:${account.clientId}` : null;
}

function status(code, message) {
  const errorCode = code === "invalid_request" ? "invalid_argument" : code === "unavailable" ? "memory_layer_unavailable" : code;
  return Response.json({ error: { code: errorCode, message, requestId: randomUUID() } }, {
    status: code === "forbidden" ? 403 : code === "invalid_request" ? 400 : 503,
  });
}

export function resolveMemoryRuntimeFile(env = process.env, home = homedir(), managed = false) {
  const override = env.MEMMY_RUNTIME_CONFIG_PATH?.trim();
  if (override) return override;
  const runtimeDirectory = env.MEMMY_HOME?.trim() || path.join(home, ".memmy");
  const dedicated = path.join(runtimeDirectory, "wanx-memobox-runtime.json");
  return managed || existsSync(dedicated) ? dedicated : path.join(runtimeDirectory, "runtime.json");
}

export function createMemoryWorkspace({
  assets, getState, fetchAsset, request = fetch, client, serviceURL, preferenceFile, protectFile,
  localStorage, backup, myAiTask, memoryTransfer, runtime, agentVisibilityStore, agentAccess, manageAgentSync = Boolean(runtime),
  onPipelineBlockers,
  runtimeFile = resolveMemoryRuntimeFile(),
}) {
  const models = client && createMemoryModelBridge({ client, serviceURL, runtimeFile, preferenceFile, protectFile });
  let session;
  let activatedScope;
  let visibility = {};
  let visibilityWrites = Promise.resolve();
  let pipelineCheck = null;
  let previousPipelineSample = null;

  function visibilityKey() {
    const state = getState();
    const identity = state.dataIdentity?.profileId
      ? ["local", state.dataIdentity.profileId]
      : ["account", state.account.accountId];
    const key = manageAgentSync ? ["sync-access", ...identity] : identity;
    return createHash("sha256").update(JSON.stringify(key)).digest("hex");
  }

  async function readVisibility() {
    return agentVisibilityStore ? (await agentVisibilityStore.load()) || {} : visibility;
  }

  async function syncAccess(agent, enabled, assertScope) {
    await runtime?.waitForStartup();
    assertScope();
    const { base, token } = await localService();
    assertScope();
    const route = agent ? "/api/agent-sources/" + encodeURIComponent(agent) + "/sync-access" : "/api/agent-sources/sync-access";
    const reply = await request(new URL(route, base), {
      method: agent ? "PUT" : "GET", headers: { "x-memmy-local-token": token, "content-type": "application/json" },
      body: agent ? JSON.stringify({ enabled }) : undefined,
      redirect: "error", signal: AbortSignal.timeout(agent ? 45_000 : 3_000),
    });
    assertScope();
    if (!reply.ok)
      throw new Error(reply.status === 404 ? "AGENT_SYNC_ACCESS_NOT_AVAILABLE" : "AGENT_SYNC_ACCESS_FAILED");
    return reply.json();
  }

  function updateVisibility(key, agent, hide, assertScope, mode) {
    const update = visibilityWrites.then(async () => {
      assertScope();
      const preferences = await readVisibility();
      const hidden = new Set(preferences[key] ?? []);
      if (hide && !hidden.has(agent) && hidden.size >= 100)
        throw Object.assign(new Error("已达到隐藏应用数量上限，请先恢复一项。"), { status: 400 });
      const source = agent === "claude_desktop" && mode === "code" ? "claude_code" : catalogAgent(agent)?.sourceId ?? agent;
      if (manageAgentSync && source !== "claude_desktop") {
        const result = await syncAccess(source, !hide, assertScope);
        assertScope();
        if (result?.sourceId !== source || result.syncDisabled !== hide) throw new Error("AGENT_SYNC_ACCESS_FAILED");
      }
      if (hide) hidden.add(agent);
      else hidden.delete(agent);
      const hiddenAgents = [...hidden];
      if (hiddenAgents.length) preferences[key] = hiddenAgents;
      else delete preferences[key];
      assertScope();
      if (agentVisibilityStore) await agentVisibilityStore.save(preferences);
      else visibility = preferences;
      return { hiddenAgents };
    });
    visibilityWrites = update.catch(() => {});
    return update;
  }
  function currentScope() {
    const scope = accountScope(getState());
    if (session && session.scope !== scope) session = undefined;
    models?.sync(scope);
    return scope;
  }

  const localService = () => readMemoryConnection(runtimeFile);

  function checkPipeline() {
    const state = getState();
    const scope = accountScope(state);
    const accountId = state.account?.phase === "authenticated" ? state.account.accountId : null;
    if (!onPipelineBlockers || !scope || !accountId || pipelineCheck) return;
    const controller = new AbortController();
    pipelineCheck = controller;
    void (async () => {
      const { base, token } = await localService();
      const response = await request(new URL("/api/v1/health", base), {
        headers: { "x-memmy-local-token": token }, redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) return;
      const health = await response.json();
      const latest = getState();
      if (controller.signal.aborted || accountScope(latest) !== scope ||
          latest.account?.accountId !== accountId || health.storage?.ready !== true ||
          !Array.isArray(health.pipelineBlockers)) return;
      const blockers = [...new Set(health.pipelineBlockers)].sort();
      const sample = JSON.stringify([scope, accountId, blockers]);
      if (previousPipelineSample === sample) onPipelineBlockers({ accountId, blockers });
      previousPipelineSample = sample;
    })().catch(() => {}).finally(() => { pipelineCheck = null; });
  }

  const pipelineTimer = onPipelineBlockers ? setInterval(checkPipeline, 30_000) : null;
  pipelineTimer?.unref?.();

  async function localStorageRequest(api, body, { signal, timeout = 7_000 } = {}) {
    await runtime?.waitForStartup();
    signal?.throwIfAborted();
    const { base, token } = await localService().catch(() => {
      throw new Error("请确认本机记忆服务正在运行。");
    });
    const deadline = AbortSignal.timeout(timeout);
    const response = await request(new URL(api, base), {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-memmy-local-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    }).catch(() => {
      signal?.throwIfAborted();
      throw new Error("暂时无法连接本机记忆服务。");
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      if (response.status === 400 || response.status === 409) {
        throw new Error(result?.error?.message || "当前无法保存所选目录。");
      }
      throw new Error(response.status === 404 ? "请更新并重启本机记忆服务。" : "本机记忆服务暂时无法读取存储位置。");
    }
    return response.json();
  }
  const localMemorySpace = localStorage && createLocalMemorySpace({
    ...localStorage, scope: currentScope, request: localStorageRequest,
  });
  const memoryBackup = backup && createMemoryBackup({ ...backup, client, accountScope: currentScope, localRequest: localStorageRequest });

  async function open() {
    const scope = currentScope();
    if (!scope) return { available: false };
    const entry = await lstat(path.join(assets, ENTRY)).catch(() => null);
    if (!entry?.isFile() || currentScope() !== scope) return { available: false };
    await models?.activate(scope, currentScope).catch(() => {});
    if (currentScope() !== scope) return { available: false };
    session ??= { scope, token: randomBytes(32).toString("hex") };
    return { available: true, token: session.token };
  }

  function sync() {
    const scope = currentScope();
    localMemorySpace?.initialize();
    if (!models || scope === activatedScope) return;
    activatedScope = scope;
    if (scope) void (async () => {
      const entry = await lstat(path.join(assets, ENTRY));
      if (entry.isFile()) await models.activate(scope, currentScope);
    })().catch(() => {
      if (activatedScope === scope) activatedScope = undefined;
    });
  }

  async function proxy(input, url) {
    const { method } = input;
    const modelSettings = models && url.pathname === "/api/wanx-memory/model-settings" &&
      ["GET", "PUT"].includes(method);
    const backupRoute = memoryBackup && url.pathname === "/api/wanx-memory/backup" && ["GET", "POST"].includes(method);
    const reconnect = runtime && url.pathname === "/api/wanx-memory/reconnect" && method === "POST";
    const taskAction = (myAiTask || memoryTransfer) && (/^\/api\/wanx-memory\/my-ai\/(status|warehouses|optimize|handoff|copy|launch|download|install|uninstall|hide-agent|show-agent|agent-access\/(?:status|connect|disconnect)|agent-context\/(?:status|catalog|selection|configuration)|memory-transfer\/(?:status|export|preview|import|rollback)|codex-context\/(?:status|catalog|connect|disconnect))$/.exec(url.pathname)?.[1]);
    const taskRoute = taskAction && method === (["status", "warehouses", "agent-access/status", "codex-context/status"].includes(taskAction) ? "GET" : "POST");
    if ((!backupRoute && !reconnect && !taskRoute && !modelSettings && !routes[method]?.some(rule => rule.test(url.pathname))) ||
        /%(?:2f|5c|00)/i.test(url.pathname)) return status("forbidden", "此记忆服务操作不可用。");
    const header = input.headers.get("x-memmy-local-token") || "";
    const selected = session;
    if (!selected || !currentScope() || session !== selected || !/^[a-f0-9]{64}$/.test(header) ||
        !timingSafeEqual(Buffer.from(header, "hex"), Buffer.from(selected.token, "hex"))) return status("forbidden", "记忆会话已结束，请重新打开。");
    if (backup?.library && backup.library.id !== "legacy" && method !== "GET" &&
        /^\/api\/agent-sources\/(?:manual$|[^/]+\/(?:managed\/sync|plugin|skill)$)/.test(url.pathname)) {
      return status("forbidden", `「${backup.library.name}」独立记忆库通过本机扫描采集，不支持在此安装或移除 Hook、Skill、Plugin。如需配置接入组件，请先切换到旧版混合库。`);
    }
    if (backupRoute) {
      try {
        const raw = method === "POST" ? await input.text() : "";
        if (Buffer.byteLength(raw) > 4096) return status("invalid_request", "备份请求过长。");
        const data = raw ? JSON.parse(raw) : {};
        if (!data || typeof data !== "object" || Array.isArray(data) ||
          (method === "POST" && !["enable", "disable", "backup", "catalog", "restore", "rollback", "configure"].includes(data.action)))
          return status("invalid_request", "备份请求无效。");
        if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束。");
        const result = await memoryBackup.action(method === "GET" ? "status" : data.action, data);
        if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束。");
        return Response.json(result ?? {}, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (error.code === "SPACE_DISK_FULL") return status("invalid_request", "盒子空间不足，请腾出空间后重试。");
        if (error.code === "SPACE_CHUNK_INVALID") return status("invalid_request", "备份完整性校验失败，请重新选择。");
        return status("invalid_request", error instanceof SyntaxError ? "备份请求格式无效。" : error.message);
      }
    }
    if (reconnect) {
      if (input.body || url.search) return status("invalid_request", "记忆服务重连请求无效。");
      try {
        await runtime.ensure();
        if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束，请重新打开。");
        localMemorySpace?.initialize();
        return Response.json({ ready: true }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return status("unavailable", error.message === "MEMORY_RUNTIME_NOT_INSTALLED"
          ? "本机缺少可启动的记忆服务组件。"
          : "本机记忆服务未能启动，请稍后重试。");
      }
    }
    if (taskRoute) {
      const assertScope = () => {
        if (input.signal.aborted || currentScope() !== selected.scope || session !== selected) {
          throw Object.assign(new Error("记忆会话已结束，请重新打开。"), { status: 403 });
        }
      };
      try {
        const payload = method === "POST" ? await input.text() : "";
        if (Buffer.byteLength(payload) > 64 * 1024) return status("invalid_request", "任务草稿过长。");
        let data;
        try { data = payload ? JSON.parse(payload) : {}; } catch {
          return status("invalid_request", "任务请求格式无效。");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return status("invalid_request", "任务请求格式无效。");
        let result;
        if (taskAction.startsWith("memory-transfer/")) {
          if (!memoryTransfer) return status("unavailable", "本机记忆传输尚不可用。");
          result = await memoryTransfer.action(taskAction.slice("memory-transfer/".length), data, assertScope);
        } else if (taskAction === "hide-agent" || taskAction === "show-agent") {
          if (!isAgentPreferenceId(data.agent)) return status("invalid_request", "智能体标识无效。");
          const integration = contextAgent(data.agent, data.mode);
          if (taskAction === "hide-agent" && integration) await agentAccess?.disconnect(integration, assertScope);
          result = await updateVisibility(visibilityKey(), data.agent, taskAction === "hide-agent", assertScope, data.mode);
        } else if (agentAccess && taskAction === "agent-access/disconnect") {
          const integration = contextAgent(data.agent, data.mode);
          if (!integration || !agentAccess.supports(integration)) return status("invalid_request", "智能体标识无效。");
          result = await agentAccess.disconnect(integration, assertScope);
        } else {
          if (agentAccess && taskAction === "agent-access/connect") {
            await visibilityWrites;
            const hidden = (await readVisibility())[visibilityKey()] ?? [];
            if (hidden.includes(data.agent)) return status("invalid_request", "请先在「添加应用」中重新接入该智能体。");
          }
          result = await myAiTask(taskAction, data, assertScope, input.signal);
          if (taskAction === "status") {
            assertScope();
            const key = visibilityKey();
            await visibilityWrites;
            const preferences = (await readVisibility())[key] ?? [];
            const disabled = manageAgentSync ? await syncAccess(null, undefined, assertScope).catch(() => null) : null;
            const ids = Array.isArray(disabled?.disabledSourceIds) ? disabled.disabledSourceIds.filter(isAgentPreferenceId) : preferences;
            result = { ...result, hiddenAgents: [...new Set([...preferences, ...ids])] };
          }
        }
        assertScope();
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (error.status === 403) return status("forbidden", error.message);
        if (error.status === 400) return status("invalid_request", error.message);
        if (["BOX_CONNECTION_REQUIRED", "DIALOGUE_CONTEXT_CHANGED", "HOST_SESSION_EXPIRED"].includes(error.code))
          return status("unavailable", "请确认盒子已连接后重试。");
        if (error.code === "APPLICATION_MODEL_UNAVAILABLE") return status("unavailable", "盒子默认模型暂不可用，请检查模型配置后重试。");
        const message = {
          warehouses: "暂时无法读取星图仓库，请检查盒子连接。",
          launch: "暂时无法打开应用，请重新检测。",
          download: "暂时无法打开官方下载页，请重试。",
          uninstall: "暂时无法打开系统应用管理。",
          "hide-agent": "暂时无法解除接入，请检查本机记忆服务后重试。",
          "show-agent": "暂时无法重新接入，请检查本机记忆服务后重试。",
          "codex-context/status": "暂时无法读取 Codex 接入状态。",
          "codex-context/catalog": "暂时无法读取空间或星图，请检查盒子连接。",
          "codex-context/connect": "暂时无法连接 Codex 的资料工具，请检查 Codex 安装后重试。",
          "codex-context/disconnect": "暂时无法清除 Codex 连接，请重试。",
        }[taskAction] || "任务操作未完成，请检查盒子连接或稍后重试。";
        return status("unavailable", message);
      }
    }
    if (modelSettings) {
      try {
        const payload = method === "PUT" ? await input.text() : null;
        const changes = payload && payload.length < 1024 ? JSON.parse(payload) : null;
        if (method === "PUT") {
          const source = changes && ["wanx", "custom"].includes(changes.mode) && Object.keys(changes).length === 1;
          const assignment = changes && SELECTABLE_MODEL_ROLES.includes(changes.role) &&
            Object.keys(changes).length === 2 && (changes.modelRef === null ||
              (typeof changes.modelRef === "string" && changes.modelRef.length > 0 && changes.modelRef.length <= 512));
          if (!source && !assignment) return status("invalid_request", "记忆模型设置无效。");
        }
        if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束，请重新打开。");
        const result = await models.settings(selected.scope, changes, currentScope);
        if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束，请重新打开。");
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch {
        return status("unavailable", "无法读取或保存记忆模型设置。");
      }
    }
    try {
      if (method === "GET" && ["/api/app/bootstrap", "/api/v1/health"].includes(url.pathname))
        await runtime?.waitForStartup();
      const { base, token } = await localService();
      const headers = { "x-memmy-local-token": token };
      const timeZone = input.headers.get("x-memmy-time-zone");
      if (timeZone) headers["x-memmy-time-zone"] = timeZone;
      let body;
      if (input.body) {
        const payload = await input.text();
        if (Buffer.byteLength(payload) > 2 * 1024 * 1024) return status("invalid_request", "记忆请求过大。");
        let data;
        try { data = JSON.parse(payload); } catch { return status("invalid_request", "记忆请求格式无效。"); }
        if (!data || typeof data !== "object" || Array.isArray(data)) return status("invalid_request", "记忆请求格式无效。");
        if (url.pathname === "/api/app/settings") {
          const allowed = ["memoryByokDailyLimitM", "memoryByokTotalLimitM", "stopMemoryServiceOnExit"];
          if (!Object.keys(data).every(key => allowed.includes(key))) return status("forbidden", "此记忆设置不可用。");
        }
        if (url.pathname === "/api/app/onboarding" && (data.scanPermission !== "scan_only" || Object.keys(data).length !== 1))
          return status("forbidden", "此扫描设置不可用。");
        if (url.pathname === "/api/local-data/export") data = {};
        headers["content-type"] = "application/json";
        body = JSON.stringify(data);
      }
      if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束，请重新打开。");
      const reply = await request(new URL(url.pathname + url.search, base), {
        method, headers, body, redirect: "error", signal: AbortSignal.timeout(45_000),
      });
      if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束，请重新打开。");
      if (reply.status === 204) return new Response(null, { status: 204 });
      const response = await reply.text();
      if (currentScope() !== selected.scope || session !== selected) return status("forbidden", "记忆会话已结束，请重新打开。");
      return new Response(response, { status: reply.status, headers: {
        "content-type": "application/json", "cache-control": "no-store",
      } });
    } catch {
      return status("unavailable", "请确认本机记忆服务正在运行。");
    }
  }

  async function handle(input) {
    const url = new URL(input.url);
    if (url.protocol !== `${MEMORY_SCHEME}:` || url.host !== "local" || url.username || url.password || !currentScope())
      return status("forbidden", "请先登录记忆盒子。");
    if (url.pathname.startsWith("/api/")) return proxy(input, url);
    if (input.method !== "GET") return new Response(null, { status: 405 });
    try {
      const pathname = decodeURIComponent(url.pathname).slice(1);
      if (pathname !== ENTRY && !/^(?:assets|pdfjs)\/[\w./-]+$/.test(pathname)) throw new Error("invalid_asset");
      const root = await realpath(assets);
      const file = await realpath(path.join(root, pathname));
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !(await lstat(file)).isFile())
        throw new Error("invalid_asset");
      const asset = await fetchAsset(pathToFileURL(file).href);
      if (pathname !== ENTRY) return asset;
      const headers = new Headers(asset.headers);
      headers.set("content-security-policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:");
      return new Response(asset.body, { status: asset.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return {
    handle, open, sync,
    storage: (action, input) => localMemorySpace?.run(action, input),
    backup: (action, input) => memoryBackup?.action(action, input),
    async close() {
      clearInterval(pipelineTimer);
      pipelineCheck?.abort();
      await Promise.all([models?.close(), localMemorySpace?.close(), memoryBackup?.close(), visibilityWrites]);
    },
  };
}
