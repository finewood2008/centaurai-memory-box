import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Folder, Orbit, X } from "lucide-react";
import { Modal } from "../../components/modal.js";
import type { AgentAccessStatus, MyAiRequest, TaskSelection, TaskSource, TaskSources } from "./wanx-my-ai-model.js";

interface SourceCatalog { folders?: TaskSource[]; warehouses?: TaskSource[] }
interface SelectionResponse {
  selection?: TaskSelection;
  resources?: TaskSources;
  folderId?: string;
  warehouseId?: string;
  memoryEnabled?: boolean;
}

export function AgentSources({ request, agent, mode, name, refresh, sources, onSourcesChange, onReady, disabled }: {
  request: MyAiRequest; agent: string; mode?: string; name: string; refresh: number;
  sources: TaskSources; onSourcesChange: (sources: TaskSources) => void; onReady: (ready: boolean) => void; disabled: boolean;
}) {
  const [status, setStatus] = useState<AgentAccessStatus | null>(null);
  const [picker, setPicker] = useState<"space" | "starlink" | null>(null);
  const [trail, setTrail] = useState<TaskSource[]>([]);
  const [catalog, setCatalog] = useState<SourceCatalog | null>(null);
  const [error, setError] = useState("");
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
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const warehouseTrigger = useRef<HTMLButtonElement>(null);
  const currentFolder = trail.at(-1);
  const parent = currentFolder?.id;
  const choosingSpace = picker === "space";
  const unavailable = status?.boxReady === false;
  const pickerDisabled = disabled || saving || !ready || unavailable;

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setReady(false);
    readiness.current(false);
    setStatus(null);
    setError("");
    setPicker(null);
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
      });
      setReady(true);
      readiness.current(true);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取已保存的资料范围。");
    });
    return () => controller.abort();
  }, [agent, mode, refresh, request, loadAttempt]);

  useEffect(() => {
    if (!picker || !ready || unavailable) return;
    const controller = new AbortController();
    setCatalog(null);
    setError("");
    void request<SourceCatalog>("agent-context/catalog", controller.signal, { agent, mode, kind: picker, ...(picker === "space" && parent ? { parent } : {}) })
      .then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法读取资料。"); });
    return () => controller.abort();
  }, [agent, mode, picker, parent, attempt, ready, unavailable, request]);

  function closePicker() {
    setPicker(null);
    (choosingSpace ? folderTrigger : warehouseTrigger).current?.focus();
  }

  async function save(next: TaskSources, close = false) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || change.current || pickerDisabled) return;
    change.current = true;
    setSaving(true);
    setError("");
    try {
      await request("agent-context/selection", signal, { agent, mode, selection: {
        folderId: next.folder?.id, warehouseId: next.warehouse?.id, memoryEnabled: next.memoryEnabled === true,
      } });
      if (signal.aborted) return;
      onChange.current(next);
      if (close) closePicker();
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "资料范围未保存，请重试。");
    } finally {
      change.current = false;
      if (!signal.aborted) setSaving(false);
    }
  }

  function openPicker(kind: "space" | "starlink") {
    if (pickerDisabled) return;
    setTrail([]);
    setCatalog(null);
    setError("");
    setPicker(kind);
  }

  return <div className="my-ai-codex-sources">
    <div className="my-ai-source-actions" role="group" aria-label="本次任务的检索范围">
      <div className="my-ai-source-choice">
        <button ref={warehouseTrigger} type="button" className="my-ai-button my-ai-source-trigger" disabled={pickerDisabled}
          aria-haspopup="dialog" title={sources.warehouse?.name} onClick={() => openPicker("starlink")}>
          <Orbit size={16} aria-hidden="true" /><span>参考星图{sources.warehouse && <small>{sources.warehouse.name}</small>}</span>
        </button>
        {sources.warehouse && <button type="button" className="my-ai-icon-button" disabled={pickerDisabled} aria-label="移除星图仓库"
          onClick={() => void save({ ...sources, warehouse: undefined })}><X size={15} aria-hidden="true" /></button>}
      </div>
      <div className="my-ai-source-choice">
        <button ref={folderTrigger} type="button" className="my-ai-button my-ai-source-trigger" disabled={pickerDisabled}
          aria-haspopup="dialog" title={sources.folder?.name} onClick={() => openPicker("space")}>
          <Folder size={16} aria-hidden="true" /><span>空间文件{sources.folder && <small>{sources.folder.name}</small>}</span>
        </button>
        {sources.folder && <button type="button" className="my-ai-icon-button" disabled={pickerDisabled} aria-label="移除空间文件夹"
          onClick={() => void save({ ...sources, folder: undefined })}><X size={15} aria-hidden="true" /></button>}
      </div>
      <label className="my-ai-help"><input type="checkbox" checked={sources.memoryEnabled === true} disabled={pickerDisabled}
        onChange={event => void save({ ...sources, memoryEnabled: event.target.checked })} />允许检索历史记忆</label>
    </div>
    <p className="my-ai-help">{saving ? "正在保存范围…" : unavailable ? "连接当前盒子后，可选择资料范围。" : "所选范围会为此产品保存；启动任务时重新校验权限。"}</p>
    {!picker && error && <div><p className="my-ai-feedback error" role="alert">{error}</p>
      {!ready && <button type="button" className="my-ai-button" disabled={disabled} onClick={() => setLoadAttempt(value => value + 1)}>重新读取范围</button>}</div>}
    <Modal open={picker !== null} title={choosingSpace ? "空间文件" : "参考星图"}
      subtitle={choosingSpace ? `选择一个文件夹，${name} 可以检索其中的文件和子文件夹。` : `选择一个仓库，${name} 可以检索其中的资料。`}
      className="my-ai-app-chooser my-ai-codex-picker" closeLabel={choosingSpace ? "关闭空间文件选择" : "关闭星图选择"}
      onClose={closePicker} headerIcon={choosingSpace ? <Folder size={18} /> : <Orbit size={18} />} closeContent={<X size={18} />}
      footer={choosingSpace && <button type="button" className="my-ai-button primary" disabled={pickerDisabled || !currentFolder || !catalog}
        onClick={() => { if (currentFolder) void save({ ...sources, folder: currentFolder }, true); }}>选择当前文件夹</button>}>
      {choosingSpace && <nav className="my-ai-codex-trail" aria-label="文件夹路径">
        <button type="button" disabled={!trail.length || pickerDisabled} onClick={() => { setCatalog(null); setTrail([]); }}>空间</button>
        {trail.map((item, index) => <span key={item.id}><ChevronRight size={13} aria-hidden="true" />
          <button type="button" disabled={pickerDisabled || index === trail.length - 1} aria-current={index === trail.length - 1 ? "location" : undefined}
            onClick={() => { setCatalog(null); setTrail(trail.slice(0, index + 1)); }}>{item.name}</button></span>)}
      </nav>}
      {error ? <div><p className="my-ai-feedback error" role="alert">{error}</p>
        <button type="button" className="my-ai-button" disabled={pickerDisabled} onClick={() => setAttempt(value => value + 1)}>重试</button></div>
        : !catalog ? <p className="my-ai-help" role="status">正在读取资料…</p>
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
