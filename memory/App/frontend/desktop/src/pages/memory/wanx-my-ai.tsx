import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Bot, Check, CircleCheck, ChevronDown, Clipboard, Download, Ellipsis, History, Link2, LoaderCircle, Monitor, Plus, RefreshCw, Settings2, Sparkles, Unlink2, X } from "lucide-react";
import { AgentSourceScanReconciler } from "../../app/agent-source-scan-reconciler.js";
import { useApiClients } from "../../app/providers.js";
import { useScanCompletions } from "../../app/use-scan-completions.js";
import { Modal } from "../../components/modal.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { appActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { agentSourceDisplayName, agentSourceLogoUrl, normalizeAgentSourceId } from "../agent-source-logos.js";
import { MemorySourcesContent, visibleAgentSources } from "../memory-sources-page.js";

import { MemorySyncSummary } from "./wanx-memory-backup.js";
import { AgentSources } from "./wanx-agent-sources.js";
import { accessStatusText, contextAgentId, managedAgentIds, modeCapabilities, type Agent, type AgentAccessStatus, type MyAiRequest, type TaskSources } from "./wanx-my-ai-model.js";

type AppAction = "launch" | "download" | "install" | "uninstall" | "hide-agent" | "show-agent";
interface AppFeedback { section: "catalog" | "agent" | "list"; text: string; error?: boolean }
interface OptimizedPrompt { agentId: string; text: string }
interface MyAiProps { sessionToken: string; memoryError: boolean; retryMemory: () => void }

export default function MyAi({ sessionToken, memoryError, retryMemory }: MyAiProps) {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { t } = useTranslation();
  const agentSources = clients?.agentSources ?? null;
  const scanState = useRef(state.agentSources);
  scanState.current = state.agentSources;
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const [installed, setInstalled] = useState<Agent[] | null>(null);
  const [apps, setApps] = useState<Agent[]>([]);
  const [hiddenAgents, setHiddenAgents] = useState<string[]>([]);
  const [agentAccess, setAgentAccess] = useState<Record<string, AgentAccessStatus>>({});
  const [integrationUnavailable, setIntegrationUnavailable] = useState("");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [appActionsAgent, setAppActionsAgent] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState<string | null>(null);
  const [appFeedback, setAppFeedback] = useState<AppFeedback | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState("chat");
  const [workspacePath, setWorkspacePath] = useState("");
  const [uninstallTarget, setUninstallTarget] = useState<Agent | null>(null);
  const [configuration, setConfiguration] = useState<string | null>(null);
  const [connectionDetails, setConnectionDetails] = useState(false);
  const [draft, setDraft] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState<OptimizedPrompt | null>(null);
  const [taskSources, setTaskSources] = useState<TaskSources>({ memoryEnabled: false });
  const [readySourceKey, setReadySourceKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lifecycle = useRef<AbortController | null>(null);
  const currentAction = useRef(false);
  const currentAppAction = useRef(false);
  const addAppButton = useRef<HTMLButtonElement>(null);
  useScanCompletions(agentSources, state.agentSources, dispatch, t);

  const request: MyAiRequest = useCallback(async function request<T>(action: string, signal: AbortSignal, data?: object): Promise<T> {
    const response = await fetch("wanx-memory://local/api/wanx-memory/my-ai/" + action, {
      method: data ? "POST" : "GET",
      headers: { "x-memmy-local-token": sessionToken, ...(data && { "content-type": "application/json" }) },
      body: data && JSON.stringify(data), signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "任务操作未完成，请重试。");
    return payload as T;
  }, [sessionToken]);

  async function loadAgents(signal: AbortSignal) {
    const info = await request<{ agents: Agent[]; apps?: Agent[]; hiddenAgents?: string[]; agentAccess?: Record<string, AgentAccessStatus>; integrationUnavailable?: string }>("status", signal);
    if (!signal.aborted) {
      setInstalled(info.agents.filter(agent => managedAgentIds.has(agent.id)));
      setApps((info.apps ?? []).filter(agent => managedAgentIds.has(agent.id)));
      setHiddenAgents(info.hiddenAgents ?? []);
      setAgentAccess(info.agentAccess ?? {});
      setIntegrationUnavailable(info.integrationUnavailable ?? "");
    }
  }

  async function run(action: string, perform: (signal: AbortSignal) => Promise<void>) {
    const signal = lifecycle.current?.signal;
    if (currentAction.current || !signal || signal.aborted) return;
    currentAction.current = true;
    setMessage("");
    setError("");
    setBusy(action);
    try { await perform(signal); }
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : "任务操作未完成。"); }
    finally {
      if (lifecycle.current?.signal === signal) {
        currentAction.current = false;
        if (!signal.aborted) setBusy(null);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    currentAction.current = false;
    currentAppAction.current = false;
    setInstalled(null);
    setAgentAccess({});
    setIntegrationUnavailable("");
    setApps([]);
    setHiddenAgents([]);
    setTarget(null);
    setMode("chat");
    setDraft("");
    setWorkspacePath("");
    setOptimizedPrompt(null);
    setTaskSources({ memoryEnabled: false });
    setReadySourceKey("");
    setBusy(null);
    setAppBusy(null);
    setConfiguration(null);
    setConnectionDetails(false);
    setUninstallTarget(null);
    setMessage("");
    setError("");
    void loadAgents(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setInstalled([]);
        setError("暂时无法检测本机智能体，请重试。");
      }
    });
    return () => controller.abort();
  }, [sessionToken]);

  useEffect(() => {
    if (!agentSources) return;
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || !agentSources || scanState.current.scanControl) return;
      pending = true;
      const generation = scanState.current.scanRequestGeneration ?? 0;
      try {
        const status = await agentSources.getScanStatus({ signal: controller.signal });
        if (controller.signal.aborted || generation !== (scanState.current.scanRequestGeneration ?? 0)) return;
        dispatch(appActions.agentSourceScanAvailability(status.unavailable ?? null));
        dispatch(appActions.agentSourceScanStatusReceived(status, generation));
      } catch {
        // Reconcile on the next poll.
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [agentSources, dispatch]);

  const detected = new Map<string, Agent>((installed ?? []).map(agent => [agent.id, agent]));
  const sources = new Map(visibleAgentSources(state.agentSources.items).map(source => [normalizeAgentSourceId(source.sourceId), source]));
  for (const [id, source] of sources) {
    if (source.builtin && managedAgentIds.has(id) && !detected.has(id)) detected.set(id, { id, name: source.displayName, prefill: false, installed: false });
  }
  const hidden = new Set(hiddenAgents.map(normalizeAgentSourceId));
  const catalog = new Map([...detected].filter(([id]) => !hidden.has(id)));
  const installedCount = (installed ?? []).filter(agent => !hidden.has(normalizeAgentSourceId(agent.id))).length;
  const chooserApps = new Map(apps.map(entry => [entry.id, entry]));
  for (const hiddenId of hiddenAgents) {
    const id = normalizeAgentSourceId(hiddenId);
    if (!managedAgentIds.has(id)) continue;
    if (chooserApps.has(id)) continue;
    const agent = detected.get(id);
    chooserApps.set(id, { id: agent?.id ?? hiddenId, name: agent?.name ?? agentSourceDisplayName(id), installed: agent?.installed ?? false });
  }
  const active = (target && catalog.get(normalizeAgentSourceId(target))) || catalog.get("codex") || catalog.values().next().value;
  const activeContextId = active && contextAgentId(active.id, mode);
  const taskMode = active?.id === "claude_desktop" ? mode : undefined;
  const activeAccess = activeContextId ? agentAccess[activeContextId] : undefined;
  const activeKey = active ? active.id + ":" + (active.id === "claude_desktop" ? mode : "default") : "";
  const connectionLabel = activeAccess?.retrievalVerified ? "检索已验证" : activeAccess?.loaded ? "工具已加载"
    : activeAccess?.configured || activeAccess?.connected ? "等待客户端加载" : "未接入资料";
  useEffect(() => setConnectionDetails(false), [activeKey]);
  const capabilities = modeCapabilities(active, mode);
  const delivery = capabilities?.delivery ?? (active?.prefill ? "draft" : "copy-open");
  const result = optimizedPrompt?.agentId === activeKey ? optimizedPrompt?.text ?? null : null;
  const appActionsOpen = Boolean(active && appActionsAgent === active.id);
  const pending = Boolean(busy);
  const agentContext = integrationUnavailable || (active?.id === "claude_desktop" && mode === "cowork") ? undefined
    : { folderId: taskSources.folder?.id, warehouseId: taskSources.warehouse?.id, memoryEnabled: taskSources.memoryEnabled === true };
  const invalidateResult = () => { setOptimizedPrompt(null); setMessage(""); setError(""); };

  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refreshAccess = async () => {
      if (reading || currentAppAction.current || document.hidden) return;
      reading = true;
      try {
        const connections = await request<Record<string, AgentAccessStatus>>("agent-access/status", controller.signal);
        if (!controller.signal.aborted && !currentAppAction.current) setAgentAccess(connections);
      } catch { /* Show the last known state until the client reconnects. */ }
      finally { reading = false; }
    };
    const timer = window.setInterval(() => void refreshAccess(), 5000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [request]);

  async function updateAgentAccess(agent: Agent, connect: boolean) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || currentAppAction.current || currentAction.current) return;
    const id = contextAgentId(agent.id, mode);
    if (!id || integrationUnavailable) return;
    currentAppAction.current = true;
    setAppBusy(agent.id);
    setError("");
    setMessage("");
    try {
      const access = await request<AgentAccessStatus>(connect ? "agent-access/connect" : "agent-access/disconnect", signal, { agent: agent.id, mode: agent.id === "claude_desktop" ? mode : undefined });
      if (signal.aborted) return;
      setAgentAccess(previous => ({ ...previous, [id]: access }));
      setSourceRefresh(value => value + 1);
      setMessage(connect ? "资料连接已保存。" : "资料连接已断开。");
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "资料连接操作未完成，请重试。");
    } finally {
      if (lifecycle.current?.signal === signal) {
        currentAppAction.current = false;
        if (!signal.aborted) setAppBusy(null);
      }
    }
  }

  function openAppChooser() {
    setAppFeedback(null);
    setChooserOpen(true);
  }

  function closeAppChooser() {
    setChooserOpen(false);
    addAppButton.current?.focus();
  }

  async function runAppAction(action: AppAction, agent: Agent) {
    const signal = lifecycle.current?.signal;
    if (currentAppAction.current || !signal || signal.aborted) return;
    const visibilityAction = action === "hide-agent" || action === "show-agent";
    if (visibilityAction && currentAction.current) return;
    currentAppAction.current = true;
    const section = action === "download" || action === "install" || action === "show-agent" ? "catalog" : "agent";
    setAppBusy(agent.id);
    setAppFeedback(null);
    try {
      if (visibilityAction) {
        const reply = await request<{ hiddenAgents: string[] }>(action, signal, { agent: agent.id });
        if (signal.aborted) return;
        setHiddenAgents(reply.hiddenAgents);
        setSourceRefresh(value => value + 1);
        if (action === "hide-agent") {
          setAgentAccess(previous => ({ ...previous, [normalizeAgentSourceId(agent.id)]: { connected: false, available: false } }));
          setTarget(null);
          setAppActionsAgent(null);
          invalidateResult();
          setAppFeedback({ section: "list", text: agent.name + " 已解除接入，后续本机采集已停止。可在「添加应用」中重新接入。" });
          addAppButton.current?.focus();
        } else {
          setTarget(active?.id ?? agent.id);
          setAppFeedback({ section, text: agent.name + " 已重新接入。" });
        }
        return;
      }
      const reply = await request<{ opened?: boolean; prepared?: boolean; installed?: boolean; uninstalled?: boolean; guided?: boolean; pending?: boolean; message?: string }>(action, signal, {
        agent: agent.id, mode: agent.id === "claude_desktop" ? mode : undefined, ...(workspacePath.trim() && { workspacePath: workspacePath.trim() }),
      });
      if (signal.aborted) return;
      if (!reply.opened && !reply.prepared && !reply.installed && !reply.uninstalled && !reply.guided && !reply.pending)
        throw new Error(reply.message || "操作未完成，请重新检测后再试。");
      const text = reply.message || (reply.installed ? agent.name + " 已完成安装并重新检测。" : reply.uninstalled ? agent.name + " 已完成卸载并重新检测。"
        : reply.prepared ? "终端启动已准备，请在终端核对后按回车开始。"
        : action === "launch" ? "已请求打开 " + agent.name + "。"
        : action === "uninstall" ? "已打开卸载入口，请在系统中完成后重新检测。"
        : reply.pending ? "安装任务已准备，请按提示完成后重新检测。"
        : "已打开官方安装入口，完成安装后请重新检测。");
      setAppFeedback({ section, text });
      if (reply.installed || reply.uninstalled) await loadAgents(signal);
    } catch (cause) {
      if (!signal.aborted) setAppFeedback({ section, text: cause instanceof Error ? cause.message : "操作未完成，请重试。", error: true });
    } finally {
      if (lifecycle.current?.signal === signal) {
        currentAppAction.current = false;
        if (!signal.aborted) setAppBusy(null);
      }
    }
  }

  function updateSources(sources: TaskSources) {
    if (currentAction.current) return;
    if (sources.folder?.id === taskSources.folder?.id && sources.warehouse?.id === taskSources.warehouse?.id && sources.memoryEnabled === taskSources.memoryEnabled) return;
    setTaskSources(sources);
    invalidateResult();
  }

  function optimize() {
    if (!active) return;
    const agentId = activeKey;
    return run("optimize", async signal => {
      const response = await request<{ text: string }>("optimize", signal, {
        agent: active.id, mode: taskMode, draft: draft.trim(), agentContext,
      });
      if (signal.aborted) return;
      setOptimizedPrompt({ agentId, text: response.text });
    });
  }

  function deliver() {
    if (!active || !result?.trim()) return;
    return run("handoff", async signal => {
      const response = await request<{ opened?: boolean; prepared?: boolean; copied?: boolean; delivery?: string; reason?: string }>("handoff", signal, {
        agent: active.id, mode: taskMode, text: result, agentContext, ...(workspacePath.trim() && { workspacePath: workspacePath.trim() }),
      });
      if (signal.aborted) return;
      if (response.prepared) setMessage("终端已准备任务。请核对提示词、工作目录和资料范围，按回车后才会开始执行。");
      else if (response.copied) setMessage(response.opened
        ? "提示词已复制，并已请求打开 " + active.name + "。请在应用中粘贴后发送。"
        : "提示词已复制；应用未能打开，请手动打开后粘贴发送。");
      else if (response.opened) setMessage("请在 " + active.name + " 中核对草稿并发送。");
      else setError(response.reason === "too-long" ? "提示词较长，请复制后粘贴到应用。" : "无法打开应用，请复制提示词后手动打开。");
    });
  }

  return <main className="wanx-memory-settings wanx-my-ai">
    <AgentSourceScanReconciler />
    <div className="my-ai-workbench">
      <aside className="my-ai-agents" aria-labelledby="my-ai-agent-title">
        <div className="my-ai-section-heading">
          <h2 id="my-ai-agent-title">本机智能体{installed && <span className="my-ai-count" title="列表内已安装">{installedCount}</span>}</h2>
          <div className="my-ai-agent-tools">
            <button ref={addAppButton} type="button" className="my-ai-icon-button" title="添加应用" aria-label="添加应用" aria-haspopup="dialog"
              onClick={openAppChooser}><Plus size={18} aria-hidden="true" /></button>
            <button type="button" className="my-ai-icon-button" disabled={pending || Boolean(appBusy)} title="重新检测" aria-label="重新检测"
              onClick={() => void run("refresh", async signal => {
                setSourceRefresh(value => value + 1);
                await loadAgents(signal);
              })}>{busy === "refresh" || !installed ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}</button>
          </div>
        </div>
        {installed && catalog.size ? <div className="my-ai-agent-list">{[...catalog.values()].map(agent => {
          const source = sources.get(normalizeAgentSourceId(agent.sourceId ?? contextAgentId(agent.id) ?? agent.id));
          const connected = source?.status === "plugin_installed" || source?.status === "skill_installed";
          const logo = agentSourceLogoUrl(agent.id);
          const status = agentAccess[contextAgentId(agent.id) ?? agent.id];
          const hasAccess = status?.retrievalVerified;
          const hint = status?.configured || status?.connected || status?.loaded || hasAccess ? accessStatusText(status)
            : connected ? "已接入本机采集" : agent.installed ? "已检测到安装" : "发现本机会话";
          const Icon = hasAccess || connected ? CircleCheck : agent.installed ? Monitor : History;
          const isActive = active?.id === agent.id;
          return <div key={agent.id} className="my-ai-agent-row">
            <button type="button" className="my-ai-agent" disabled={pending || Boolean(appBusy)}
              aria-pressed={isActive} onClick={() => {
                if (isActive) return;
                setTarget(agent.id);
                setMode("chat");
                setConfiguration(null);
                setAppActionsAgent(null);
                setAppFeedback(null);
                invalidateResult();
              }}>
              <span className="my-ai-agent-logo">{logo ? <img src={logo} alt="" /> : <Bot size={20} aria-hidden="true" />}</span>
              <strong title={agent.name}>{agent.name}</strong>
              <span className={"my-ai-agent-state" + (hasAccess || connected ? " connected" : "")} title={hint} aria-label={hint}><Icon size={15} /></span>
            </button>
            {isActive && <button type="button" className="my-ai-icon-button my-ai-agent-more" title="应用操作" aria-label="应用操作"
              aria-expanded={appActionsOpen} aria-controls={appActionsOpen ? "my-ai-agent-actions" : undefined}
              onClick={() => { setAppActionsAgent(appActionsOpen ? null : agent.id); setAppFeedback(null); }}>
              <Ellipsis size={17} aria-hidden="true" />
            </button>}
          </div>;
        })}</div> : <p className="my-ai-help">{!installed ? "正在检测…" : hidden.size ? "列表为空。可在「添加应用」中重新接入智能体。" : "未发现智能体。安装或启动后可重新检测。"}</p>}
        {active && appActionsOpen && <section className="my-ai-agent-actions" id="my-ai-agent-actions" aria-label={active.name + "应用操作"}>
          <div className="my-ai-actions">
            {active.launchable && <button type="button" className="my-ai-button" disabled={Boolean(appBusy)}
              onClick={() => void runAppAction("launch", active)}><ArrowUpRight size={15} aria-hidden="true" />打开应用</button>}
            {active.uninstallable && <button type="button" className="my-ai-button" disabled={Boolean(appBusy)}
              onClick={() => setUninstallTarget(active)}><Settings2 size={15} aria-hidden="true" />管理卸载</button>}
            <button type="button" className="my-ai-button" disabled={pending || Boolean(appBusy)}
              onClick={() => void runAppAction("hide-agent", active)}><Unlink2 size={15} aria-hidden="true" />解除接入</button>
          </div>
          {!active.installed ? <p className="my-ai-help">只检测到本机会话。安装应用后，请重新检测。</p>
            : !active.launchable && !active.uninstallable ? <p className="my-ai-help">按官方说明启动或管理此应用。</p>
            : <p className="my-ai-help">{active.version && "版本 " + active.version + " · "}{active.channel && "安装渠道：" + active.channel}</p>}
          {appFeedback?.section === "agent" && <p className={"my-ai-feedback" + (appFeedback.error ? " error" : "")}
            role={appFeedback.error ? "alert" : "status"}>{appFeedback.text}</p>}
        </section>}
        {appFeedback?.section === "list" && <p className="my-ai-feedback" role="status">{appFeedback.text}</p>}
      </aside>

      <section className="my-ai-task" aria-labelledby="my-ai-task-title">
        <div className="my-ai-section-heading my-ai-task-heading">
          <div><h2 id="my-ai-task-title">发起对话</h2><p>描述任务，选择参考资料。</p></div>
          {active && <span className="my-ai-target"><Bot size={14} aria-hidden="true" />{active.name}</span>}
        </div>
        {active?.id === "claude_desktop" && <label className="my-ai-target">Claude 运行模式
          <select aria-label="Claude 运行模式" value={mode} disabled={pending || Boolean(appBusy)} onChange={event => {
            setMode(event.target.value); setConfiguration(null); invalidateResult();
          }}><option value="chat">Chat</option><option value="code">Code</option><option value="cowork">Cowork</option></select>
        </label>}
        {active && <>
          <div className="my-ai-connection-bar" aria-label={active.name + "资料连接"}>
            {integrationUnavailable ? <span className="my-ai-help">{integrationUnavailable}</span>
              : <span className={"my-ai-connection-status" + (activeAccess?.retrievalVerified ? " verified" : "")}
                aria-live="polite" title={accessStatusText(activeAccess)}>
                <span className="my-ai-status-dot" aria-hidden="true" />{connectionLabel}
              </span>}
            {!integrationUnavailable && active.installed && capabilities?.configuration !== "unsupported"
              && !(active.id === "claude_desktop" && mode === "cowork") && !activeAccess?.configured && !activeAccess?.connected &&
              <button type="button" className="my-ai-button my-ai-connect-button" disabled={pending || Boolean(appBusy)}
                onClick={() => void updateAgentAccess(active, true)}><Link2 size={14} aria-hidden="true" />{appBusy === active.id ? "正在配置…" : capabilities?.configuration === "guided" ? "授权资料接入" : "配置资料工具"}</button>}
            <button type="button" className="my-ai-connection-toggle" aria-expanded={connectionDetails} aria-controls="my-ai-connection-details"
              onClick={() => setConnectionDetails(value => !value)}>连接详情<ChevronDown size={14} aria-hidden="true" /></button>
          </div>
          {connectionDetails && <div id="my-ai-connection-details" className="my-ai-connection-details" aria-label="当前入口能力">
            {!integrationUnavailable && <p>{accessStatusText(activeAccess)}{activeAccess?.memorySaved ? " · 记忆已保存" : ""}</p>}
            <p>{delivery === "draft" ? "任务将带入客户端，核对后发送。" : delivery === "terminal-confirm" ? "任务将在终端展示，按回车开始执行。" : "复制提示词后，在应用中粘贴发送。"}</p>
            <p>{capabilities?.autoMemory === "hook" ? "支持配置逐轮采集，启用后需在客户端验证。"
              : capabilities?.autoMemory === "scan" ? "支持本机会话采集，结果见下方。"
              : capabilities?.autoMemory === "explicit" ? "可通过显式保存写入记忆。" : "自动采集尚未验证。"}</p>
            {capabilities?.limitations?.map(note => <p key={note}>{note}</p>)}
            {active.id === "claude_desktop" && mode === "cowork" && <p>Cowork 暂支持草稿预填，资料工具与自动采集尚未验证。</p>}
            {!integrationUnavailable && active.installed && capabilities?.configuration !== "unsupported" && !(active.id === "claude_desktop" && mode === "cowork") &&
              <div className="my-ai-actions">
                {(activeAccess?.configured || activeAccess?.connected) && <button type="button" className="my-ai-button" disabled={pending || Boolean(appBusy)}
                  onClick={() => void updateAgentAccess(active, false)}><Unlink2 size={14} aria-hidden="true" />断开资料</button>}
                {capabilities?.configuration === "guided" && <button type="button" className="my-ai-button" disabled={pending || Boolean(appBusy)}
                  onClick={() => void run("configuration", async signal => {
                    const reply = await request<{ config?: object; configuration?: object }>("agent-context/configuration", signal, { agent: active.id, mode: taskMode });
                    if (!signal.aborted) setConfiguration(JSON.stringify(reply.configuration ?? reply.config ?? reply, null, 2));
                  })}>查看接入配置</button>}
              </div>}
          </div>}
        </>}
        {(delivery === "terminal-confirm" || (active?.id === "claude_desktop" && mode === "code")) && <label className="my-ai-text-field">
          <span>工作目录（绝对路径）</span><input aria-label="工作目录" value={workspacePath} disabled={pending || Boolean(appBusy)}
            placeholder="/Users/你的用户名/项目" onChange={event => { setWorkspacePath(event.target.value); invalidateResult(); }} />
        </label>}
        <label className="my-ai-text-field">
          <span className="sr-only">任务草稿</span>
          <textarea value={draft} maxLength={12000} rows={5} disabled={pending}
            placeholder="例如：整理项目资料，列出待办事项。"
            onChange={event => {
              const text = event.target.value;
              setDraft(text);
              invalidateResult();
            }} />
        </label>
        <div className="my-ai-actions my-ai-composer-actions">
          {active && !integrationUnavailable && !(active.id === "claude_desktop" && mode === "cowork") && <AgentSources key={activeKey} request={request} agent={active.id} mode={taskMode}
            name={active.name} refresh={sourceRefresh} sources={taskSources} onSourcesChange={updateSources}
            onReady={ready => setReadySourceKey(ready ? activeKey : "")} disabled={pending || Boolean(appBusy)} />}
          <button type="button" className="my-ai-button primary" disabled={pending || Boolean(appBusy) || !installed || !active || !draft.trim()
            || (!integrationUnavailable && !(active.id === "claude_desktop" && mode === "cowork") && readySourceKey !== activeKey)} onClick={() => void optimize()}>
            {busy === "optimize" ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} aria-hidden="true" />}
            {busy === "optimize" ? "正在优化…" : "优化提示词"}
          </button>
        </div>
        {result !== null && <div className="my-ai-result">
          <label className="my-ai-text-field"><span>优化后的提示词</span>
            <textarea value={result} maxLength={16000} rows={7} disabled={pending} onChange={event => {
              if (active) setOptimizedPrompt({ agentId: activeKey, text: event.target.value });
            }} />
          </label>
          <div className="my-ai-actions">
            <button type="button" className="my-ai-button" disabled={!result.trim() || pending || Boolean(appBusy)} onClick={() => void run("copy", async signal => {
              await request("copy", signal, { agent: active?.id, mode: taskMode, text: result, agentContext });
              if (!signal.aborted) setMessage("提示词已复制。");
            })}><Clipboard size={15} aria-hidden="true" />复制提示词</button>
            {active?.installed && <button type="button" className="my-ai-button primary" disabled={!result.trim() || pending || Boolean(appBusy)}
              onClick={() => void deliver()}>{delivery === "terminal-confirm" ? "在终端核对任务" : delivery === "draft" ? "带入 " + active.name + " 新会话" : "复制并打开 " + active.name}<ArrowUpRight size={16} aria-hidden="true" /></button>}
          </div>
        </div>}
        {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
        {message && <p className="my-ai-feedback" role="status">{message}</p>}
      </section>
    </div>
    <Modal open={chooserOpen} title="添加应用" subtitle="从官方渠道安装应用，或重新接入已断开的智能体。" className="my-ai-app-chooser"
      headerIcon={<Plus size={18} aria-hidden="true" />} closeLabel="关闭应用列表" closeContent={<X size={18} aria-hidden="true" />}
      onClose={closeAppChooser}>
      {!installed ? <p className="my-ai-help" role="status">正在读取应用列表…</p>
        : !chooserApps.size ? <p className="my-ai-help" role="status">暂未读取到应用列表。关闭后可以重新检测。</p>
        : <ul className="my-ai-app-catalog">{[...chooserApps.values()].map(entry => {
          const logo = agentSourceLogoUrl(entry.id);
          const Icon = entry.downloadLabel === "安装说明" ? BookOpen : Download;
          return <li key={entry.id}>
            <span className="my-ai-agent-logo">{logo ? <img src={logo} alt="" /> : <Bot size={18} aria-hidden="true" />}</span>
            <div className="my-ai-app-details">
              <strong>{entry.name}</strong>
              {entry.installed && <span className="my-ai-app-installed"><Check size={13} aria-hidden="true" />已安装</span>}
            </div>
            <div className="my-ai-app-entry-actions">
              {!entry.installed && entry.installable && <button type="button" className="my-ai-button" disabled={Boolean(appBusy)}
                aria-label={entry.name + " 安装"} onClick={() => void runAppAction("install", entry)}><Download size={15} aria-hidden="true" />安装</button>}
              {entry.downloadLabel && <button type="button" className="my-ai-button" disabled={Boolean(appBusy)}
                aria-label={entry.name + " " + entry.downloadLabel} onClick={() => void runAppAction("download", entry)}>
                <Icon size={15} aria-hidden="true" />{entry.downloadLabel}
              </button>}
              {hidden.has(normalizeAgentSourceId(entry.id)) && <button type="button" className="my-ai-button" disabled={pending || Boolean(appBusy)}
                aria-label={entry.name + " 重新接入"} onClick={() => void runAppAction("show-agent", entry)}>
                <Link2 size={15} aria-hidden="true" />重新接入
              </button>}
            </div>
          </li>;
        })}</ul>}
      {appFeedback?.section === "catalog" && <p className={"my-ai-feedback" + (appFeedback.error ? " error" : "")}
        role={appFeedback.error ? "alert" : "status"}>{appFeedback.text}</p>}
    </Modal>
    <Modal open={uninstallTarget !== null} title={"管理卸载 " + (uninstallTarget?.name ?? "")}
      subtitle="卸载程序与解除资料接入分别处理。MemoBox 已采集的历史记忆会保留。"
      closeLabel="取消卸载" onClose={() => setUninstallTarget(null)} closeContent={<X size={18} />}>
      <p className="my-ai-help">将按检测到的安装渠道处理；需要系统操作时会打开对应入口，完成后重新检测。不会请求清除认证和记忆数据。</p>
      <button type="button" className="my-ai-button" disabled={Boolean(appBusy)} onClick={() => {
        const agent = uninstallTarget; setUninstallTarget(null); if (agent) void runAppAction("uninstall", agent);
      }}>确认管理卸载</button>
    </Modal>
    <Modal open={configuration !== null} title="资料工具接入配置" subtitle="在目标应用的连接器设置中导入或粘贴配置，然后新建会话验证检索。"
      closeLabel="关闭接入配置" onClose={() => setConfiguration(null)} closeContent={<X size={18} />}>
      <label className="my-ai-text-field"><span>接入配置（点击全选）</span>
        <textarea aria-label="接入配置" readOnly rows={12} value={configuration ?? ""} onFocus={event => event.currentTarget.select()} />
      </label>
    </Modal>
    <MemorySyncSummary sessionToken={sessionToken} count={catalog.size} automatic={state.agentSources.scanPreferences.watchFileChanges}>
    {collectionProfile => clients ? <MemorySourcesContent embedded surface="my-ai" sourceRefresh={sourceRefresh} collectionProfile={collectionProfile}
      localAgents={[...catalog.values()]} disconnectedLocalAgentIds={new Set([
        ...hidden, ...state.agentSources.items.filter(source => source.builtin && !managedAgentIds.has(normalizeAgentSourceId(source.sourceId)))
          .map(source => normalizeAgentSourceId(source.sourceId)),
      ])} /> :
      <section className="my-ai-memory-panel" aria-label="本机来源采集">
        <p className="my-ai-help" role="status">{memoryError ? "本机记忆服务暂不可用。" : "正在连接本机记忆服务…"}</p>
        {memoryError && <button type="button" className="my-ai-button" onClick={retryMemory}>重新连接记忆服务</button>}
      </section>}
    </MemorySyncSummary>
  </main>;
}
