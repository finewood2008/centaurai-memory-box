import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, X } from "lucide-react";
import { Modal } from "../../components/modal.js";
import type { AgentAccessStatus, MyAiRequest, TaskSource } from "./wanx-my-ai-model.js";

export function MyAiOutput({ agent, request, output, disabled, onUpdate }: {
  agent: string; request: MyAiRequest; output?: TaskSource; disabled: boolean; onUpdate: (access: AgentAccessStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<TaskSource[]>([]);
  const [folders, setFolders] = useState<TaskSource[] | null>(null);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lifecycle = useRef<AbortController | null>(null);
  const parent = trail.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, [agent, request]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFolders(null);
    setError("");
    void request<{ folders: TaskSource[] }>("agent-context/catalog", controller.signal,
      { agent, kind: "space", ...(parent && { parent: parent.id }) }).then(result => {
      if (!controller.signal.aborted) setFolders(result.folders ?? []);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法打开文件夹。");
    });
    return () => controller.abort();
  }, [agent, open, parent, request, retry]);

  async function save(folderId: string | null) {
    const signal = lifecycle.current?.signal;
    if (disabled || saving || !signal || signal.aborted) return;
    setSaving(true);
    setError("");
    try {
      const next = await request<AgentAccessStatus>("agent-access/output", signal, { agent, folderId });
      if (!signal.aborted) { onUpdate(next); setOpen(false); }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "回写设置未保存，请重试。");
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  }

  return <section aria-label="成果回写" className="my-ai-connection-details">
    <div className="my-ai-actions">
      <strong>成果回写</strong>
      <span className="my-ai-help">{output ? `可写文件夹 · ${output.name}` : "未开放写入"}</span>
      <button type="button" className="my-ai-button" disabled={disabled || saving}
        onClick={() => { setTrail([]); setOpen(true); }}>{output ? "更换回写文件夹" : "选择回写文件夹"}</button>
      {output && <button type="button" className="my-ai-button" disabled={disabled || saving}
        onClick={() => void save(null)}>撤销回写</button>}
    </div>
    {!open && error && <p role="alert" className="my-ai-feedback error">{error}</p>}
    <Modal open={open} title="选择成果回写文件夹"
      subtitle="Codex 可以在所选文件夹及子文件夹内新建文件、按版本更新已有文件。其他个人资料保持只读。"
      className="my-ai-app-chooser my-ai-codex-picker" closeLabel="取消回写授权"
      onClose={() => { if (!saving) setOpen(false); }} headerIcon={<Folder size={18} />} closeContent={<X size={18} />}
      footer={<button type="button" className="my-ai-button primary" disabled={disabled || saving || !parent || !folders}
        onClick={() => { if (parent) void save(parent.id); }}>{saving ? "正在授权…" : "确认授权回写"}</button>}>
      <nav className="my-ai-codex-trail" aria-label="回写文件夹路径">
        <button type="button" disabled={!trail.length || saving} onClick={() => { setFolders(null); setTrail([]); }}>个人空间</button>
        {trail.map((item, index) => <span key={item.id}><ChevronRight size={13} aria-hidden="true" />
          <button type="button" disabled={saving || index === trail.length - 1}
            onClick={() => { setFolders(null); setTrail(trail.slice(0, index + 1)); }}>{item.name}</button></span>)}
      </nav>
      {error && <div className="my-ai-source-feedback"><p role="alert" className="my-ai-feedback error">{error}</p>
        {!folders && <button type="button" className="my-ai-button" onClick={() => setRetry(value => value + 1)}>重试</button>}</div>}
      {!folders && !error && <p className="my-ai-help" role="status">正在读取文件夹…</p>}
      {folders && <div className="my-ai-warehouse-list">
        {folders.map(item => <button key={item.id} type="button" className="my-ai-warehouse" disabled={saving}
          aria-label={`打开回写文件夹 ${item.name}`} onClick={() => { setFolders(null); setTrail([...trail, item]); }}>
          <Folder size={15} aria-hidden="true" /><span>{item.name}</span><ChevronRight size={14} aria-hidden="true" /></button>)}
        {!folders.length && <p className="my-ai-help">{parent ? "可以授权当前文件夹。" : "没有可选的文件夹。"}</p>}
      </div>}
    </Modal>
  </section>;
}
