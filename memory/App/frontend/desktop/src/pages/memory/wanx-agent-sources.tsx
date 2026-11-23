import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, History, Orbit, X } from "lucide-react";
import { Modal } from "../../components/modal.js";
import type { AgentAccessStatus, MyAiRequest, TaskSelection, TaskSource, TaskSources } from "./wanx-my-ai-model.js";

type SourceKind = "space" | "starlink" | "memory";

interface SourceCatalog { folders?: TaskSource[]; warehouses?: TaskSource[]; agents?: TaskSource[] }
interface SelectionResponse {
  selection?: TaskSelection;
  resources?: TaskSources;
  folderId?: string;
  warehouseId?: string;
  memoryEnabled?: boolean;
  memoryAgent?: string | null;
}

export function AgentSources({ request, agent, mode, name, refresh, sources, memoryNames = {}, onSourcesChange, onReady, onSavingChange, disabled }: {
  request: MyAiRequest; agent: string; mode?: string; name: string; refresh: number;
  sources: TaskSources; memoryNames?: Record<string, string>; onSourcesChange: (sources: TaskSources) => void; onReady: (ready: boolean) => void;
  onSavingChange?: (saving: boolean) => void; disabled: boolean;
}) {
  const [status, setStatus] = useState<AgentAccessStatus | null>(null);
  const [picker, setPicker] = useState<SourceKind | null>(null);
  const [trail, setTrail] = useState<TaskSource[]>([]);
  const [catalog, setCatalog] = useState<SourceCatalog | null>(null);
  const [memoryChoices, setMemoryChoices] = useState<TaskSource[]>([]);
  const [feedback, setFeedback] = useState<{ text: string; saveFailed?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const lifecycle = useRef<AbortController | null>(null);
  const change = useRef(false);
  const onChange = useRef(onSourcesChange);
  onChange.current = onSourcesChange;
  const readiness = useRef(onReady);
  readiness.current = onReady;
  const savingChanged = useRef(onSavingChange);
  savingChanged.current = onSavingChange;
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const warehouseTrigger = useRef<HTMLButtonElement>(null);
  const memoryTrigger = useRef<HTMLButtonElement>(null);
  const currentFolder = trail.at(-1);
  const parent = currentFolder?.id;
  const choosingSpace = picker === "space";
  const choosingMemory = picker === "memory";
  const memoryLabel = sources.memoryEnabled
    ? sources.memoryAgent === null ? "全部 Agent"
      : sources.memoryAgent
        ? memoryChoices.find(item => item.id === sources.memoryAgent)?.name ?? memoryNames[sources.memoryAgent] ?? sources.memoryAgent
        : "默认范围"
    : undefined;
  const unavailable = status?.boxReady === false;
  const pickerDisabled = disabled || saving || !ready || unavailable;

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    change.current = false;
    setSaving(false);
    savingChanged.current?.(false);
    setReady(false);
    readiness.current(false);
    setStatus(null);
    setFeedback(null);
    setPicker(null);
    setMemoryChoices([]);
    onChange.current({ memoryEnabled: false });
    void Promise.all([
      request<AgentAccessStatus>("agent-context/status", controller.signal, { agent, mode }),
      request<SelectionResponse>("agent-context/selection", controller.signal, { agent, mode }),
    ]).then(([state, saved]) => {
      if (controller.signal.aborted) return;
      setStatus(state);
      const selection = saved.selection ?? saved;
      onChange.current({
        folder: saved.resources?.folder ?? (selection.folderId ? { id: selection.folderId, name: "已保存的文件夹" } : undefined),
        warehouse: saved.resources?.warehouse ?? (selection.warehouseId ? { id: selection.warehouseId, name: "已保存的星图仓库" } : undefined),
        memoryEnabled: selection.memoryEnabled === true,
        memoryAgent: selection.memoryEnabled === true ? selection.memoryAgent : undefined,
      });
      setReady(true);
      readiness.current(true);
    }).catch(cause => {
      if (!controller.signal.aborted) setFeedback({ text: cause instanceof Error ? cause.message : "无法读取已保存的资料范围。" });
    });
    return () => {
      controller.abort();
      if (lifecycle.current === controller) {
        change.current = false;
        savingChanged.current?.(false);
      }
    };
  }, [agent, mode, refresh, request, loadAttempt]);

  useEffect(() => {
    if (!picker || !ready || unavailable) return;
    const controller = new AbortController();
    setCatalog(null);
    setFeedback(null);
    void request<SourceCatalog>("agent-context/catalog", controller.signal, { agent, mode, kind: picker, ...(picker === "space" && parent ? { parent } : {}) })
      .then(value => {
        if (controller.signal.aborted) return;
        setCatalog(value);
        if (picker === "memory") setMemoryChoices(value.agents ?? []);
      })
      .catch(cause => { if (!controller.signal.aborted) setFeedback({ text: cause instanceof Error ? cause.message : "暂时无法读取资料。" }); });
    return () => controller.abort();
  }, [agent, mode, picker, parent, attempt, ready, unavailable, request]);

  function closePicker() {
    setPicker(null);
    (choosingMemory ? memoryTrigger : choosingSpace ? folderTrigger : warehouseTrigger).current?.focus();
  }

  async function save(next: TaskSources, close = false) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || change.current || pickerDisabled) return;
    change.current = true;
    setSaving(true);
    savingChanged.current?.(true);
    setFeedback(null);
    try {
      await request("agent-context/selection", signal, { agent, mode, selection: {
        folderId: next.folder?.id, warehouseId: next.warehouse?.id, memoryEnabled: next.memoryEnabled === true,
        ...(next.memoryEnabled && next.memoryAgent !== undefined && { memoryAgent: next.memoryAgent }),
      } });
      if (signal.aborted) return;
      onChange.current(next);
      if (close) closePicker();
    } catch (cause) {
      if (!signal.aborted) setFeedback({ text: cause instanceof Error ? cause.message : "资料范围未保存，请重试。", saveFailed: true });
    } finally {
      if (lifecycle.current?.signal === signal) {
        change.current = false;
        if (!signal.aborted) { setSaving(false); savingChanged.current?.(false); }
      }
    }
  }

  function openPicker(kind: SourceKind) {
    if (pickerDisabled) return;
    setTrail([]);
    setCatalog(null);
    setFeedback(null);
    setPicker(kind);
  }

  const feedbackText = feedback && <p className={feedback.saveFailed ? "my-ai-feedback error" : "my-ai-help"}
    role={feedback.saveFailed ? "alert" : "status"}>{feedback.text}</p>;
  const pickerFeedback = feedback && <div className="my-ai-source-feedback">{feedbackText}
    <button type="button" className="my-ai-button" disabled={pickerDisabled} onClick={() => setAttempt(value => value + 1)}>重试</button></div>;

  return <div className="my-ai-codex-sources">
    <div className="my-ai-source-actions" role="group" aria-label="本次任务的检索范围">
      {([
        { kind: "starlink", label: "参考星图", placeholder: "选择仓库", icon: Orbit, scope: sources.warehouse?.name, trigger: warehouseTrigger },
        { kind: "space", label: "空间文件", placeholder: "选择文件夹", icon: Folder, scope: sources.folder?.name, trigger: folderTrigger },
        { kind: "memory", label: "智能体记忆", placeholder: "选择 Agent", icon: History, scope: memoryLabel, trigger: memoryTrigger },
      ] as const).map(({ kind, label, placeholder, icon: Icon, scope, trigger }) => (
        <button key={kind} ref={trigger} type="button" className="my-ai-button my-ai-source-trigger"
          data-selected={Boolean(scope)} disabled={pickerDisabled} aria-haspopup="dialog" aria-expanded={picker === kind}
          aria-label={label} aria-description={scope} title={scope} onClick={() => openPicker(kind)}>
          <span className="my-ai-source-icon"><Icon size={16} aria-hidden="true" /></span>
          <span className="my-ai-source-copy"><strong>{label}</strong><small>{scope || placeholder}</small></span>
          <ChevronDown className="my-ai-source-chevron" size={13} aria-hidden="true" />
        </button>
      ))}
    </div>
    {(saving || unavailable) && <p className="my-ai-help" role="status">{saving ? "正在保存范围…" : "连接盒子后可选择资料。"}</p>}
    {!picker && feedback && <div className="my-ai-source-feedback">{feedbackText}
      {!ready && <button type="button" className="my-ai-button" disabled={disabled} onClick={() => setLoadAttempt(value => value + 1)}>重新读取范围</button>}</div>}
    <Modal open={picker !== null} title={choosingMemory ? "智能体记忆范围" : choosingSpace ? "空间文件" : "参考星图"}
      subtitle={choosingMemory ? "选择要参考的 Agent 历史记忆。" : choosingSpace ? `选择一个文件夹，${name} 可以检索其中的文件和子文件夹。` : `选择一个仓库，${name} 可以检索其中的资料。`}
      className="my-ai-app-chooser my-ai-codex-picker" closeLabel={choosingMemory ? "关闭记忆范围选择" : choosingSpace ? "关闭空间文件选择" : "关闭星图选择"}
      onClose={closePicker} headerIcon={choosingMemory ? <History size={18} /> : choosingSpace ? <Folder size={18} /> : <Orbit size={18} />} closeContent={<X size={18} />}
      footer={choosingSpace ? <>
        {sources.folder && <button type="button" className="my-ai-button" disabled={pickerDisabled}
          onClick={() => void save({ ...sources, folder: undefined }, true)}>清除选择</button>}
        <button type="button" className="my-ai-button primary" disabled={pickerDisabled || !currentFolder || !catalog}
          onClick={() => { if (currentFolder) void save({ ...sources, folder: currentFolder }, true); }}>选择当前文件夹</button>
      </> : picker === "starlink" && sources.warehouse ? <button type="button" className="my-ai-button" disabled={pickerDisabled}
        onClick={() => void save({ ...sources, warehouse: undefined }, true)}>清除选择</button> : null}>
      {choosingSpace && <nav className="my-ai-codex-trail" aria-label="文件夹路径">
        <button type="button" disabled={!trail.length || pickerDisabled} onClick={() => { setCatalog(null); setTrail([]); }}>空间</button>
        {trail.map((item, index) => <span key={item.id}><ChevronRight size={13} aria-hidden="true" />
          <button type="button" disabled={pickerDisabled || index === trail.length - 1} aria-current={index === trail.length - 1 ? "location" : undefined}
            onClick={() => { setCatalog(null); setTrail(trail.slice(0, index + 1)); }}>{item.name}</button></span>)}
      </nav>}
      {feedback && !choosingMemory ? pickerFeedback
        : choosingMemory ? <div className="my-ai-warehouse-list">
          {[
            { id: undefined, name: "不检索记忆" },
            { id: null, name: "全部 Agent" },
            ...(catalog?.agents ?? []),
          ].map(item => {
            const selected = item.id === undefined ? !sources.memoryEnabled : sources.memoryEnabled && sources.memoryAgent === item.id;
            return <button key={item.id ?? item.name} type="button" className="my-ai-warehouse" disabled={pickerDisabled}
              aria-pressed={Boolean(selected)} onClick={() => void save({
                ...sources, memoryEnabled: item.id !== undefined, memoryAgent: item.id,
              }, true)}>
              <History size={15} aria-hidden="true" /><span>{item.name}</span>{selected && <Check size={15} aria-hidden="true" />}
            </button>;
          })}
          {pickerFeedback || (!catalog && <p className="my-ai-help" role="status">正在读取 Agent…</p>)}
          {catalog && !catalog.agents?.length && <p className="my-ai-help">暂无单独的 Agent 记忆来源。</p>}
        </div> : !catalog ? <p className="my-ai-help" role="status">正在读取资料…</p>
        : choosingSpace ? <div className="my-ai-warehouse-list">
          {catalog.folders?.map(item => <button key={item.id} type="button" className="my-ai-warehouse" disabled={pickerDisabled}
            aria-label={`打开文件夹 ${item.name}`} onClick={() => { setCatalog(null); setTrail([...trail, item]); }}>
            <Folder size={15} aria-hidden="true" /><span>{item.name}</span><ChevronRight size={14} aria-hidden="true" /></button>)}
          {!catalog.folders?.length && <p className="my-ai-help">{currentFolder ? "没有子文件夹。" : "没有可选的文件夹。"}</p>}
          {!currentFolder && Boolean(catalog.folders?.length) && <p className="my-ai-help">先打开要检索的文件夹，再确认选择。</p>}
        </div> : <div className="my-ai-warehouse-list">
          {catalog.warehouses?.map(item => <button key={item.id} type="button" className="my-ai-warehouse" disabled={pickerDisabled}
            aria-pressed={sources.warehouse?.id === item.id} onClick={() => void save({ ...sources, warehouse: item }, true)}>
            <Orbit size={15} aria-hidden="true" /><span>{item.name}</span>{sources.warehouse?.id === item.id && <Check size={15} aria-hidden="true" />}</button>)}
          {!catalog.warehouses?.length && <p className="my-ai-help">没有可选的星图仓库。</p>}
        </div>}
    </Modal>
  </div>;
}
