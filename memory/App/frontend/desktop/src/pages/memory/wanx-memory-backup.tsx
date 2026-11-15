import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud, LoaderCircle, RefreshCw } from "lucide-react";

interface BackupStatus {
  connected: boolean;
  context: string | null;
  enabled: boolean;
  intervalMinutes?: number;
  lastBackup?: number;
  phase?: string;
  progress?: { bytes: number; total: number };
  availableBackup?: { id: string; modified: number };
}

export function MemorySyncSummary({ sessionToken, count, automatic, children }: {
  sessionToken: string; count: number; automatic: boolean; children: ReactNode;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const refreshing = useRef(false);
  const epoch = useRef(0);
  const ticket = useRef<string | null>(null);

  async function request(signal: AbortSignal, data?: object): Promise<BackupStatus> {
    const response = await fetch("wanx-memory://local/api/wanx-memory/backup", {
      method: data ? "POST" : "GET", signal,
      headers: { "x-memmy-local-token": sessionToken, ...(data ? { "content-type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "暂时无法读取空间备份状态。");
    return result;
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setStatus(null);
    ticket.current = null;
    setConfirming(false);
    setError("");
    setBusy(false);
    mutation.current = refreshing.current = false;
    async function refresh() {
      if (refreshing.current || mutation.current) return;
      const version = epoch.current;
      refreshing.current = true;
      try {
        const next = await request(controller.signal);
        if (!controller.signal.aborted && version === epoch.current) {
          if (ticket.current !== next.context) setConfirming(false);
          ticket.current = next.context;
          setStatus(next);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted && version === epoch.current) setError(cause instanceof Error ? cause.message : "暂时无法读取空间备份状态。");
      } finally { if (!controller.signal.aborted) refreshing.current = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => { controller.abort(); window.clearInterval(timer); epoch.current++; };
  }, [sessionToken]);

  async function update(action: "enable" | "disable" | "restore" | "configure", intervalMinutes?: number) {
    const signal = lifecycle.current?.signal;
    if (mutation.current || !status?.context || !signal || signal.aborted) return;
    mutation.current = true;
    epoch.current++;
    setBusy(true);
    setError("");
    try {
      await request(signal, { action, context: status.context, ...(action === "configure" ? { intervalMinutes } : {}), ...(action === "restore" ? { id: status.availableBackup?.id } : {}) });
      const next = await request(signal);
      if (!signal.aborted) { setStatus(next); setConfirming(false); }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "备份设置未更新，请重试。");
    } finally {
      if (!signal.aborted) { mutation.current = false; setBusy(false); }
    }
  }

  const intervalMinutes = status?.intervalMinutes ?? 5;
  const intervalLabel = intervalMinutes >= 60 && intervalMinutes % 60 === 0 ? (intervalMinutes / 60) + " 小时" : intervalMinutes + " 分钟";
  const working = status?.phase === "backing-up" || status?.phase === "restoring";
  const progress = status?.progress;
  const percent = progress?.total ? " " + Math.floor(progress.bytes / progress.total * 100) + "%" : "";
  const hint = !status ? "正在读取备份状态…" : !status.enabled ? "已关闭，记忆继续保存在本机" :
    !status.connected ? "连接盒子后自动备份" : status.phase === "restoring" ? "正在恢复记忆…" :
    status.phase === "backing-up" ? "正在备份" + percent : status.availableBackup ? "发现已有备份，恢复前暂停上传" :
    status.phase === "error" ? "备份暂未完成，稍后自动重试" : status.lastBackup ?
    "最近备份 " + new Date(status.lastBackup * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "已开启，等待首次备份";

  return <section className="my-ai-sync-overview" aria-label="记忆同步">
    <div className="my-ai-sync-summary">
      <div className="my-ai-sync-title"><RefreshCw size={17} aria-hidden="true" /><h2>记忆同步</h2><span>{count} 个来源 · {automatic ? "自动收集" : "手动同步"}</span></div>
      <div className="my-ai-backup-control">
        <span id="space-backup-label"><Cloud size={16} aria-hidden="true" />空间自动备份</span>
        <button type="button" role="switch" className="my-ai-backup-switch" aria-labelledby="space-backup-label"
          aria-describedby="space-backup-status" aria-checked={status?.enabled ?? true} disabled={busy || !status?.context}
          onClick={() => void update(status?.enabled ? "disable" : "enable")}><span /></button>
      </div>
    </div>
    <div className="my-ai-sync-status"><span id="space-backup-status" role="status">{working && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}{hint}</span>
      <span>每 {intervalLabel}自动备份 · 换电脑可恢复</span>
      {status?.availableBackup && status.connected && <button type="button" className="my-ai-button" disabled={busy || working}
        onClick={() => setConfirming(value => !value)}>从空间恢复</button>}
    </div>
    {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
    {confirming && status?.availableBackup && <div className="my-ai-restore-confirm">
      <p>恢复盒子上的记忆备份。当前本机库会保留，恢复成功后按当前开关设置备份。</p>
      <button type="button" className="my-ai-button primary" disabled={busy} onClick={() => void update("restore")}>{busy ? "正在恢复…" : "确认恢复"}</button>
      <button type="button" className="my-ai-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
    </div>}
    <details className="my-ai-sync-details"><summary>自动同步设置</summary>
      <div className="my-ai-backup-schedule">
        <div><label htmlFor="space-backup-interval">空间备份间隔</label><p>连接盒子且客户端运行时生效，修改后自动保存。</p></div>
        <select id="space-backup-interval" value={intervalMinutes} disabled={busy || !status?.context}
          onChange={event => void update("configure", Number(event.target.value))}>
          {[5, 15, 30, 60, 180, 360, 1440].map(minutes => <option key={minutes} value={minutes}>{minutes < 60 ? minutes + " 分钟" : minutes / 60 + " 小时"}</option>)}
          {![5, 15, 30, 60, 180, 360, 1440].includes(intervalMinutes) && <option value={intervalMinutes}>{intervalLabel}</option>}
        </select>
      </div>
      {children}
    </details>
  </section>;
}
