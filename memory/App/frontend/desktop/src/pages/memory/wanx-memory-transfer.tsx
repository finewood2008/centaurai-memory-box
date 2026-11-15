import { useEffect, useRef, useState } from "react";

interface Preview { previewId: string; name: string; rows: number; counts: Record<string, number> }
interface TransferResult { canceled?: boolean; path?: string; exported?: boolean; imported?: boolean;
  inserted?: Record<string, number>; skipped?: Record<string, number>; rollbackAvailable?: boolean;
  restoring?: boolean; restored?: boolean; error?: string }
const total = (counts?: Record<string, number>) => Object.values(counts ?? {}).reduce((sum, value) => sum + value, 0);

export function MemoryTransfer({ sessionToken }: { sessionToken: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<TransferResult>({});
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);

  async function request<T>(action: string, signal: AbortSignal, body = {}): Promise<T> {
    const response = await fetch("wanx-memory://local/api/wanx-memory/my-ai/memory-transfer/" + action, {
      method: "POST", headers: { "x-memmy-local-token": sessionToken, "content-type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || "记忆传输未完成。");
    return value;
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setPreview(null); setResult({}); setMessage(""); setError(""); setConfirmRollback(false);
    void request<TransferResult>("status", controller.signal).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(() => {});
    return () => controller.abort();
  }, [sessionToken]);

  async function run(action: string) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || busy.current) return;
    busy.current = true; setPending(true); setError(""); setMessage("");
    try {
      const value = await request<TransferResult & Preview>(action, signal,
        action === "import" ? { previewId: preview?.previewId } : action === "rollback" ? { confirm: true } : {});
      if (signal.aborted || value.canceled) return;
      if (action === "preview") { setPreview(value); return; }
      setResult(current => action === "status" ? value : ({ ...current, ...value, restoring: Boolean(value.restoring) }));
      if (value.error) setError(value.error);
      if (value.exported) setMessage("记忆包已导出：" + value.path);
      if (value.imported) {
        setPreview(null);
        setMessage(`导入完成：新增 ${total(value.inserted)} 条数据记录，跳过 ${total(value.skipped)} 条重复记录。已保留本机回滚副本。`);
      }
      if (value.restoring) { setConfirmRollback(false); setMessage("记忆服务正在恢复导入前的副本，请刷新状态确认结果。"); }
      if (value.restored) { setConfirmRollback(false); setMessage("已恢复导入前的本机记忆库。"); }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "记忆传输未完成。");
    } finally {
      busy.current = false;
      if (!signal.aborted) setPending(false);
    }
  }

  return <section className="my-ai-memory-panel" aria-label="记忆包导入导出">
    <details>
      <summary>记忆包导入导出</summary>
      <p className="my-ai-help">导入导出 MemoBox 统一记忆。导入默认跳过重复记录，保留各智能体原有数据。</p>
      <div className="my-ai-actions">
        <button type="button" className="my-ai-button" disabled={pending || result.restoring} onClick={() => void run("export")}>导出记忆包</button>
        <button type="button" className="my-ai-button" disabled={pending || result.restoring} onClick={() => void run("preview")}>选择记忆包</button>
        <button type="button" className="my-ai-button" disabled={pending} onClick={() => void run("status")}>刷新传输状态</button>
        {result.rollbackAvailable && <button type="button" className="my-ai-button" disabled={pending} onClick={() => setConfirmRollback(true)}>回滚上次导入</button>}
        {result.restoring && <button type="button" className="my-ai-button" disabled={pending} onClick={() => setConfirmRollback(true)}>重试回滚</button>}
      </div>
      {preview && <div aria-label="记忆包预览">
        <p>{preview.name} · {preview.rows} 条数据记录 · 重复记录将跳过</p>
        <p className="my-ai-help">确认后先保存当前记忆库副本，再导入所选记忆包。</p>
        <button type="button" className="my-ai-button" disabled={pending} onClick={() => void run("import")}>确认导入</button>
        <button type="button" className="my-ai-button" disabled={pending} onClick={() => setPreview(null)}>取消导入</button>
      </div>}
      {confirmRollback && <div aria-label="回滚确认">
        <p>恢复导入前的整个本机记忆库；导入后新增的本机记忆也会移出当前库。恢复服务会另外保留当前库的本机副本。</p>
        <button type="button" className="my-ai-button" disabled={pending} onClick={() => void run("rollback")}>确认回滚</button>
        <button type="button" className="my-ai-button" disabled={pending} onClick={() => setConfirmRollback(false)}>取消回滚</button>
      </div>}
      {message && <p className="my-ai-feedback" role="status">{message}</p>}
      {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
    </details>
  </section>;
}

export default MemoryTransfer;
