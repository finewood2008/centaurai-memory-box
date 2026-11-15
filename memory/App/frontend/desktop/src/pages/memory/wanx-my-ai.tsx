import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Bot, Check, ChevronRight, CircleCheck, Clipboard, Download, Ellipsis, Folder, History, Link2, LoaderCircle, Monitor, Orbit, Plus, RefreshCw, Settings2, Sparkles, Unlink2, X } from "lucide-react";
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

interface Agent { id: string; name: string; prefill: boolean; installed: boolean; launchable?: boolean; uninstallable?: boolean }
interface AppCatalogEntry { id: string; name: string; installed: boolean; downloadLabel?: "官方下载" | "安装说明" }
type AppAction = "launch" | "download" | "uninstall" | "hide-agent" | "show-agent";
interface AppFeedback { section: "catalog" | "agent" | "list"; text: string; error?: boolean }
interface OptimizedPrompt { agentId: string; text: string }
interface TaskSource { id: string; name: string }
interface CodexSourceStatus { connected: boolean; available: boolean }
interface CodexSourceCatalog { folders?: TaskSource[]; warehouses?: TaskSource[] }
interface CodexTaskSources { folder?: TaskSource; warehouse?: TaskSource }
type CodexSourceKind = "space" | "starlink";
type MyAiRequest = <T>(action: string, signal: AbortSignal, data?: object) => Promise<T>;
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
  const [apps, setApps] = useState<AppCatalogEntry[]>([]);
  const [hiddenAgents, setHiddenAgents] = useState<string[]>([]);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [appActionsAgent, setAppActionsAgent] = useState<string | null>(null);
  const [appBusy, setAppBusy] = useState<string | null>(null);
  const [appFeedback, setAppFeedback] = useState<AppFeedback | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [optimizedPrompt, setOptimizedPrompt] = useState<OptimizedPrompt | null>(null);
  const [codexSources, setCodexSources] = useState<CodexTaskSources>({});
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
    const info = await request<{ agents: Agent[]; apps?: AppCatalogEntry[]; hiddenAgents?: string[] }>("status", signal);
    if (!signal.aborted) {
      setInstalled(info.agents);
      setApps(info.apps ?? []);
      setHiddenAgents(info.hiddenAgents ?? []);
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
      currentAction.current = false;
      if (!signal.aborted) setBusy(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
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

  const detected = new Map((installed ?? []).map(agent => [normalizeAgentSourceId(agent.id), agent]));
  const sources = new Map(visibleAgentSources(state.agentSources.items).map(source => [normalizeAgentSourceId(source.sourceId), source]));
  for (const [id, source] of sources) {
    if (source.builtin && !detected.has(id)) detected.set(id, { id: source.sourceId, name: source.displayName, prefill: false, installed: false });
  }
  const hidden = new Set(hiddenAgents.map(normalizeAgentSourceId));
  const catalog = new Map([...detected].filter(([id]) => !hidden.has(id)));
  const installedCount = (installed ?? []).filter(agent => !hidden.has(normalizeAgentSourceId(agent.id))).length;
  const chooserApps = new Map(apps.map(entry => [normalizeAgentSourceId(entry.id), entry]));
  for (const hiddenId of hiddenAgents) {
    const id = normalizeAgentSourceId(hiddenId);
    if (chooserApps.has(id)) continue;
    const agent = detected.get(id);
    chooserApps.set(id, { id: agent?.id ?? hiddenId, name: agent?.name ?? agentSourceDisplayName(id), installed: agent?.installed ?? false });
  }
  const active = (target && catalog.get(normalizeAgentSourceId(target))) || catalog.get("codex") || catalog.values().next().value;
  const result = optimizedPrompt?.agentId === active?.id ? optimizedPrompt?.text ?? null : null;
  const appActionsOpen = Boolean(active && appActionsAgent === active.id);
  const pending = Boolean(busy);
  const codexContext = active?.id === "codex" && (codexSources.folder || codexSources.warehouse) ? {
    folderId: codexSources.folder?.id,
    warehouseId: codexSources.warehouse?.id,
  } : undefined;
  const invalidateResult = () => { setOptimizedPrompt(null); setMessage(""); setError(""); };

  function openAppChooser() {
    setAppFeedback(null);
    setChooserOpen(true);
  }

  function closeAppChooser() {
    setChooserOpen(false);
    addAppButton.current?.focus();
  }

  async function runAppAction(action: AppAction, agent: Pick<Agent, "id" | "name">) {
    const signal = lifecycle.current?.signal;
    if (currentAppAction.current || !signal || signal.aborted) return;
    const visibilityAction = action === "hide-agent" || action === "show-agent";
    if (visibilityAction && currentAction.current) return;
    currentAppAction.current = true;
    const section = action === "download" || action === "show-agent" ? "catalog" : "agent";
    setAppBusy(agent.id);
    setAppFeedback(null);
    try {
      if (visibilityAction) {
        const reply = await request<{ hiddenAgents: string[] }>(action, signal, { agent: agent.id });
        if (signal.aborted) return;
        setHiddenAgents(reply.hiddenAgents);
        setSourceRefresh(value => value + 1);
        if (action === "hide-agent") {
          setTarget(null);
          setAppActionsAgent(null);
          invalidateResult();
          setAppFeedback({ section: "list", text: agent.name + " 已解除接入，后续记忆同步已停止。可在「添加应用」中重新接入。" });
          addAppButton.current?.focus();
        } else {
          setTarget(active?.id ?? agent.id);
          setAppFeedback({ section, text: agent.name + " 已重新接入。" });
        }
        return;
      }
      const reply = await request<{ opened: boolean }>(action, signal, { agent: agent.id });
      if (signal.aborted) return;
      if (!reply.opened) throw new Error("未能打开，请重新检测后再试。");
      const text = action === "launch" ? "已请求打开 " + agent.name + "。"
        : action === "uninstall" ? "已打开系统应用管理。请在系统中卸载 " + agent.name + "，完成后重新检测。"
        : "已在浏览器打开官方页面。完成安装后，请重新检测。";
      setAppFeedback({ section, text });
    } catch (cause) {
      if (!signal.aborted) setAppFeedback({ section, text: cause instanceof Error ? cause.message : "操作未完成，请重试。", error: true });
    } finally {
      currentAppAction.current = false;
      if (!signal.aborted) setAppBusy(null);
    }
  }

  function updateSources(sources: CodexTaskSources) {
    if (currentAction.current) return;
    if (sources.folder?.id === codexSources.folder?.id && sources.warehouse?.id === codexSources.warehouse?.id) return;
    setCodexSources(sources);
    invalidateResult();
  }

  function optimize() {
    if (!active) return;
    const agentId = active.id;
    return run("optimize", async signal => {
      const response = await request<{ text: string }>("optimize", signal, {
        agent: agentId, draft: draft.trim(), codexContext,
      });
      if (signal.aborted) return;
      setOptimizedPrompt({ agentId, text: response.text });
    });
  }

  function deliver() {
    if (!active || !result?.trim()) return;
    return run("handoff", async signal => {
      const response = await request<{ opened: boolean; reason?: string }>("handoff", signal, { agent: active.id, text: result, codexContext });
      if (signal.aborted) return;
      if (response.opened) {
        if (codexContext) {
          setCodexSources({});
          setOptimizedPrompt(null);
        }
        setMessage("请在 Codex 中核对并发送。");
      }
      else setError(response.reason === "too-long" ? "提示词较长，请复制后粘贴到 Codex。" : "无法打开 Codex，请复制提示词后手动打开。");
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
          const source = sources.get(normalizeAgentSourceId(agent.id));
          const connected = source?.status === "plugin_installed" || source?.status === "skill_installed";
          const logo = agentSourceLogoUrl(agent.id);
          const hint = connected ? "已接入记忆" : agent.installed ? "已检测到安装" : "发现本机会话";
          const Icon = connected ? CircleCheck : agent.installed ? Monitor : History;
          const isActive = active?.id === agent.id;
          return <div key={agent.id} className="my-ai-agent-row">
            <button type="button" className="my-ai-agent" disabled={pending || Boolean(appBusy)}
              aria-pressed={isActive} onClick={() => {
                if (isActive) return;
                setTarget(agent.id);
                setAppActionsAgent(null);
                setAppFeedback(null);
                invalidateResult();
              }}>
              <span className="my-ai-agent-logo">{logo ? <img src={logo} alt="" /> : <Bot size={20} aria-hidden="true" />}</span>
              <strong title={agent.name}>{agent.name}</strong>
              <span className={"my-ai-agent-state" + (connected ? " connected" : "")} title={hint} aria-label={hint}><Icon size={15} /></span>
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
              onClick={() => void runAppAction("uninstall", active)}><Settings2 size={15} aria-hidden="true" />管理卸载</button>}
            <button type="button" className="my-ai-button" disabled={pending || Boolean(appBusy)}
              onClick={() => void runAppAction("hide-agent", active)}><Unlink2 size={15} aria-hidden="true" />解除接入</button>
          </div>
          {!active.installed ? <p className="my-ai-help">只检测到本机会话。安装应用后，请重新检测。</p>
            : !active.launchable && !active.uninstallable ? <p className="my-ai-help">命令行版请在终端启动或按官方说明卸载。</p>
            : active.uninstallable && <p className="my-ai-help">卸载操作在系统中完成。</p>}
          {appFeedback?.section === "agent" && <p className={"my-ai-feedback" + (appFeedback.error ? " error" : "")}
            role={appFeedback.error ? "alert" : "status"}>{appFeedback.text}</p>}
        </section>}
        {appFeedback?.section === "list" && <p className="my-ai-feedback" role="status">{appFeedback.text}</p>}
      </aside>

      <section className="my-ai-task" aria-labelledby="my-ai-task-title">
        <div className="my-ai-section-heading my-ai-task-heading">
          <div><h2 id="my-ai-task-title">发起对话</h2><p>写下任务，补全目标、限制和验收要求。</p></div>
          {active && <span className="my-ai-target"><Bot size={14} aria-hidden="true" />{active.name}</span>}
        </div>
        <label className="my-ai-text-field">
          <span className="sr-only">任务草稿</span>
          <textarea value={draft} maxLength={12000} rows={5} disabled={pending}
            placeholder="例如：修复查询页的重复请求，只改客户端。补充修改范围和验收步骤。"
            onChange={event => {
              const text = event.target.value;
              setDraft(text);
              if (!text.trim()) setCodexSources({});
              invalidateResult();
            }} />
        </label>
        <div className="my-ai-actions my-ai-composer-actions">
          {active?.id === "codex" && <CodexSources request={request} refresh={sourceRefresh} sources={codexSources}
            onSourcesChange={updateSources} disabled={pending || Boolean(appBusy)} />}
          {active && active.id !== "codex" && <p className="my-ai-help">星图和空间检索目前支持 Codex。</p>}
          <button type="button" className="my-ai-button primary" disabled={pending || Boolean(appBusy) || !installed || !active || !draft.trim()} onClick={() => void optimize()}>
            {busy === "optimize" ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} aria-hidden="true" />}
            {busy === "optimize" ? "正在优化…" : "优化提示词"}
          </button>
        </div>
        {result !== null && <div className="my-ai-result">
          <label className="my-ai-text-field"><span>优化后的提示词</span>
            <textarea value={result} maxLength={16000} rows={7} disabled={pending} onChange={event => {
              if (active) setOptimizedPrompt({ agentId: active.id, text: event.target.value });
            }} />
          </label>
          <div className="my-ai-actions">
            <button type="button" className="my-ai-button" disabled={!result.trim() || pending || Boolean(appBusy)} onClick={() => void run("copy", async signal => {
              await request("copy", signal, { agent: active?.id, text: result, codexContext });
              if (!signal.aborted) setMessage("提示词已复制。");
            })}><Clipboard size={15} aria-hidden="true" />复制提示词</button>
            {active?.prefill && <button type="button" className="my-ai-button primary" disabled={!result.trim() || pending || Boolean(appBusy)}
              onClick={() => void deliver()}>带入 Codex 新会话<ArrowUpRight size={16} aria-hidden="true" /></button>}
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
    <MemorySyncSummary sessionToken={sessionToken} count={catalog.size} automatic={state.agentSources.scanPreferences.watchFileChanges}>
    {clients ? <MemorySourcesContent embedded surface="my-ai" sourceRefresh={sourceRefresh}
      localAgents={[...catalog.values()]} disconnectedLocalAgentIds={hidden} /> :
      <section className="my-ai-memory-panel" aria-label="记忆同步">
        <p className="my-ai-help" role="status">{memoryError ? "本机记忆服务暂不可用。" : "正在连接本机记忆服务…"}</p>
        {memoryError && <button type="button" className="my-ai-button" onClick={retryMemory}>重新连接记忆服务</button>}
      </section>}
    </MemorySyncSummary>
  </main>;
}

function CodexSources({ request, refresh, sources, onSourcesChange, disabled }: {
  request: MyAiRequest;
  refresh: number;
  sources: CodexTaskSources;
  onSourcesChange: (sources: CodexTaskSources) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<CodexSourceStatus | null>(null);
  const [picker, setPicker] = useState<CodexSourceKind | null>(null);
  const [trail, setTrail] = useState<TaskSource[]>([]);
  const [catalog, setCatalog] = useState<CodexSourceCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("");
  const statusRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const warehouseTrigger = useRef<HTMLButtonElement>(null);
  const currentFolder = trail.at(-1);
  const parent = currentFolder?.id;
  const configured = status?.connected === true;
  const pickerDisabled = disabled || saving || !configured || !status?.available;
  const choosingSpace = picker === "space";
  const PickerIcon = choosingSpace ? Folder : Orbit;

  const refreshStatus = useCallback(async () => {
    if (mutation.current || statusRequest.current) return;
    const controller = new AbortController();
    statusRequest.current = controller;
    try {
      const value = await request<CodexSourceStatus>("codex-context/status", controller.signal);
      if (!controller.signal.aborted) setStatus(value);
    } catch {
      if (!controller.signal.aborted) setStatus(current => ({ connected: current?.connected ?? false, available: false }));
    } finally {
      if (statusRequest.current === controller) statusRequest.current = null;
    }
  }, [request]);

  useEffect(() => () => {
    statusRequest.current?.abort();
    statusRequest.current = null;
    mutation.current?.abort();
  }, [request]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus, refresh]);

  useEffect(() => {
    if (status?.available !== false) return;
    const check = () => { if (!document.hidden) void refreshStatus(); };
    const timer = window.setInterval(check, 3000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refreshStatus, status?.available]);

  useEffect(() => {
    if (!picker || !status?.available) return;
    const controller = new AbortController();
    setCatalog(null);
    setCatalogError("");
    const filter = picker === "space" ? { kind: picker, parent } : { kind: picker };
    void request<CodexSourceCatalog>("codex-context/catalog", controller.signal, filter)
      .then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setCatalogError(cause instanceof Error ? cause.message : "暂时无法读取资料，请重试。");
          void refreshStatus();
        }
      });
    return () => controller.abort();
  }, [picker, parent, attempt, request, refreshStatus, status?.available]);

  function openPicker(kind: CodexSourceKind) {
    if (pickerDisabled) return;
    setCatalog(null);
    setCatalogError("");
    setTrail([]);
    setPicker(kind);
  }

  function closePicker() {
    setPicker(null);
    (choosingSpace ? folderTrigger : warehouseTrigger).current?.focus();
  }

  function browseFolder(next: TaskSource[]) {
    setCatalog(null);
    setTrail(next);
  }

  async function updateConnection(connect: boolean) {
    if (disabled || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    statusRequest.current?.abort();
    setSaving(true);
    setSaveError("");
    setConnectionMessage("");
    try {
      const value = await request<CodexSourceStatus>(connect ? "codex-context/connect" : "codex-context/disconnect", controller.signal, {});
      if (!controller.signal.aborted) {
        setStatus(value);
        if (connect && value.connected) {
          setConnectionMessage("Codex 已连接。若已打开 Codex，请重新启动它以加载资料工具。");
        } else if (!connect) {
          onSourcesChange({});
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setSaveError(cause instanceof Error ? cause.message : "资料连接操作未完成，请重试。");
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return <div className="my-ai-codex-sources">
    <div className="my-ai-source-actions" role="group" aria-label="本次任务的检索范围">
      <div className="my-ai-source-choice">
        <button ref={warehouseTrigger} type="button" className="my-ai-button my-ai-source-trigger" data-action="configure-codex-starlink"
          disabled={pickerDisabled} aria-haspopup="dialog" title={sources.warehouse?.name}
          onClick={() => openPicker("starlink")}>
          <Orbit size={16} aria-hidden="true" />
          <span>参考星图{sources.warehouse && <small>{sources.warehouse.name}</small>}</span>
        </button>
        {sources.warehouse && <button type="button" className="my-ai-icon-button" data-action="clear-codex-warehouse"
          disabled={disabled || saving} aria-label="移除星图仓库" title="移除星图仓库"
          onClick={() => onSourcesChange({ ...sources, warehouse: undefined })}><X size={15} aria-hidden="true" /></button>}
      </div>
      <div className="my-ai-source-choice">
        <button ref={folderTrigger} type="button" className="my-ai-button my-ai-source-trigger" data-action="configure-codex-space"
          disabled={pickerDisabled} aria-haspopup="dialog" title={sources.folder?.name}
          onClick={() => openPicker("space")}>
          <Folder size={16} aria-hidden="true" />
          <span>空间文件{sources.folder && <small>{sources.folder.name}</small>}</span>
        </button>
        {sources.folder && <button type="button" className="my-ai-icon-button" data-action="clear-codex-folder"
          disabled={disabled || saving} aria-label="移除空间文件夹" title="移除空间文件夹"
          onClick={() => onSourcesChange({ ...sources, folder: undefined })}><X size={15} aria-hidden="true" /></button>}
      </div>
    </div>
    <div className="my-ai-source-connection">
      <span aria-live="polite">{configured ? status?.available ? "Codex 资料工具已连接" : "Codex 已连接，等待万象盒子上线"
        : status ? "连接 Codex 后可以选择检索范围" : "正在检查 Codex 连接…"}</span>
      <button type="button" className="my-ai-button" data-action={configured ? "disconnect-codex" : "connect-codex"}
        disabled={disabled || saving || !status} onClick={() => void updateConnection(!configured)}>
        <Link2 size={14} aria-hidden="true" />{saving ? "正在更新…" : configured ? "断开连接" : "连接 Codex"}
      </button>
    </div>
    {saveError && <p className="my-ai-feedback error" role="alert">{saveError}</p>}
    {connectionMessage && <p className="my-ai-feedback" role="status">{connectionMessage}</p>}
    <Modal open={picker !== null} title={choosingSpace ? "空间文件" : "参考星图"}
      subtitle={choosingSpace ? "选择一个文件夹，Codex 可以检索其中的文件和子文件夹。" : "选择一个仓库，Codex 可以检索其中的资料。"}
      className="my-ai-app-chooser my-ai-codex-picker" closeLabel={choosingSpace ? "关闭空间文件选择" : "关闭星图选择"}
      onClose={closePicker} headerIcon={<PickerIcon size={18} aria-hidden="true" />} closeContent={<X size={18} aria-hidden="true" />}
      footer={choosingSpace && <button type="button" className="my-ai-button primary" data-action="select-codex-folder"
        disabled={pickerDisabled || !currentFolder || !catalog} onClick={() => {
          if (!currentFolder) return;
          onSourcesChange({ ...sources, folder: currentFolder });
          closePicker();
        }}>选择当前文件夹</button>}>
      {choosingSpace && <nav className="my-ai-codex-trail" aria-label="文件夹路径">
        <button type="button" disabled={!trail.length || pickerDisabled} onClick={() => browseFolder([])}>空间</button>
        {trail.map((item, index) => <span key={item.id}>
          <ChevronRight size={13} aria-hidden="true" />
          <button type="button" disabled={pickerDisabled || index === trail.length - 1}
            aria-current={index === trail.length - 1 ? "location" : undefined}
            onClick={() => browseFolder(trail.slice(0, index + 1))}>{item.name}</button>
        </span>)}
      </nav>}
      {catalogError ? <div>
        <p className="my-ai-feedback error" role="alert">{catalogError}</p>
        <button type="button" className="my-ai-button" disabled={pickerDisabled} onClick={() => setAttempt(value => value + 1)}>重试</button>
      </div> : !catalog ? <p className="my-ai-help" role="status">{choosingSpace ? "正在读取文件夹…" : "正在读取星图仓库…"}</p>
        : choosingSpace ? <div className="my-ai-warehouse-list">
          {catalog.folders?.map(item => <button key={item.id} type="button" className="my-ai-warehouse"
            data-action="browse-codex-folder" disabled={pickerDisabled} aria-label={`打开文件夹 ${item.name}`}
            onClick={() => browseFolder([...trail, item])}><Folder size={15} aria-hidden="true" /><span>{item.name}</span><ChevronRight size={14} aria-hidden="true" /></button>)}
          {!catalog.folders?.length && <p className="my-ai-help">{currentFolder ? "没有子文件夹。" : "没有可选的文件夹。"}</p>}
          {!currentFolder && Boolean(catalog.folders?.length) && <p className="my-ai-help">先打开要检索的文件夹，再确认选择。</p>}
        </div> : <div className="my-ai-warehouse-list">
          {catalog.warehouses?.map(item => <button key={item.id} type="button" className="my-ai-warehouse" disabled={pickerDisabled}
            data-action="select-codex-warehouse" aria-pressed={sources.warehouse?.id === item.id} onClick={() => {
              onSourcesChange({ ...sources, warehouse: item });
              closePicker();
            }}><Orbit size={15} aria-hidden="true" /><span>{item.name}</span>
            {sources.warehouse?.id === item.id && <Check size={15} aria-hidden="true" />}</button>)}
          {!catalog.warehouses?.length && <p className="my-ai-help">没有可选的星图仓库。</p>}
        </div>}
    </Modal>
  </div>;
}
