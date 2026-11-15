import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud, LoaderCircle, RefreshCw } from "lucide-react";

interface BackupStatus {
  library?: { id: string; name: string };
  libraries?: { id: string; name: string }[];
  connected: boolean;
  context: string | null;
  enabled: boolean;
  intervalMinutes?: number;
  lastBackup?: number;
  busy?: boolean;
  phase?: string;
  lastError?: string;
  progress?: { bytes: number; total: number };
}

interface BackupSnapshot {
  id: string;
  digest: string;
  modified: number;
}

interface BackupCatalog {
  sources: { id: string; name: string; current: boolean; snapshots: BackupSnapshot[] }[];
  rollbackAvailable: boolean;
  sourcesError?: string;
}

type Action = "enable" | "disable" | "backup" | "catalog" | "restore" | "rollback" | "configure" | "select-library";
type RestoreAction = "restore" | "rollback";

const snapshotDate = (modified: number) => new Date(modified * 1000).toLocaleString();
const snapshotLabel = (snapshot: BackupSnapshot) => snapshotDate(snapshot.modified) + " · " + snapshot.id.slice(0, 8);

export function MemorySyncSummary({ sessionToken, count, automatic, children }: {
  sessionToken: string; count: number; automatic: boolean;
  children: ReactNode | ((collectionProfile: { id: string; name: string } | null) => ReactNode);
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Action | null>(null);
  const [catalog, setCatalog] = useState<BackupCatalog | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [confirming, setConfirming] = useState<RestoreAction | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const refreshing = useRef(false);
  const epoch = useRef(0);
  const ticket = useRef<string | null>(null);

  function closePicker() {
    setCatalog(null);
    setSourceId("");
    setSnapshotId("");
    setConfirming(null);
  }

  async function request<T>(signal: AbortSignal, data?: object): Promise<T> {
    const response = await fetch("wanx-memory://local/api/wanx-memory/backup", {
      method: data ? "POST" : "GET", signal,
      headers: { "x-memmy-local-token": sessionToken, ...(data ? { "content-type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "暂时无法读取空间备份状态。");
    return result;
  }

  function receive(next: BackupStatus) {
    if (ticket.current !== next.context) {
      closePicker();
      setError("");
    }
    ticket.current = next.context;
    setStatus(next);
    setProfileReady(true);
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setStatus(null);
    setProfileReady(false);
    ticket.current = null;
    closePicker();
    setError("");
    setPending(null);
    mutation.current = refreshing.current = false;
    async function refresh() {
      if (refreshing.current) return;
      const version = epoch.current;
      refreshing.current = true;
      try {
        const next = await request<BackupStatus>(controller.signal);
        if (!controller.signal.aborted && version === epoch.current) receive(next);
      } catch (cause) {
        if (!controller.signal.aborted && version === epoch.current && !mutation.current) {
          setProfileReady(false);
          setError(cause instanceof Error ? cause.message : "暂时无法读取备份状态。");
        }
      } finally { if (!controller.signal.aborted) refreshing.current = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => { controller.abort(); window.clearInterval(timer); epoch.current++; };
  }, [sessionToken]);

  const selectedSource = catalog?.sources.find(source => source.id === sourceId);
  const selectedSnapshot = selectedSource?.snapshots.find(snapshot => snapshot.id === snapshotId);

  async function update(action: Action, value?: number | string) {
    const signal = lifecycle.current?.signal;
    const context = status?.context;
    if (mutation.current || !context || !signal || signal.aborted || (action === "restore" && !selectedSnapshot)) return;
    mutation.current = true;
    epoch.current++;
    setPending(action);
    if (action === "select-library") setProfileReady(false);
    setError("");
    try {
      const result = await request<BackupCatalog>(signal, { action, context,
        ...(action === "configure" ? { intervalMinutes: value } : {}),
        ...(action === "select-library" ? { libraryId: value } : {}),
        ...(action === "restore" && selectedSnapshot ? { sourceId, id: selectedSnapshot.id, digest: selectedSnapshot.digest } : {}),
      });
      epoch.current++;
      const next = await request<BackupStatus>(signal);
      if (signal.aborted) return;
      receive(next);
      if (action === "restore" || action === "rollback") closePicker();
      if (action === "catalog" && next.context === context) {
        closePicker();
        setCatalog(result);
      }
    } catch (cause) {
      if (!signal.aborted && ticket.current === context) {
        setProfileReady(false);
        setError(cause instanceof Error ? cause.message : "记忆备份操作未完成，请重试。");
      }
    } finally {
      if (!signal.aborted) { mutation.current = false; setPending(null); }
    }
  }

  const intervalMinutes = status?.intervalMinutes ?? 5;
  const intervalLabel = intervalMinutes >= 60 && intervalMinutes % 60 === 0 ? (intervalMinutes / 60) + " 小时" : intervalMinutes + " 分钟";
  const collectionProfile = profileReady ? status?.library ?? null : null;
  const isolatedCollection = collectionProfile !== null && collectionProfile.id !== "legacy";
  const collectionScope = collectionProfile === null ? "来源待确认" : isolatedCollection ? collectionProfile.name : count + " 个来源";
  const collectionMode = collectionProfile === null ? "正在读取采集方式" : isolatedCollection
    ? automatic ? "自动本机扫描" : "手动本机扫描" : automatic ? "自动采集" : "手动采集";
  const backingUp = (status?.busy && status.phase === "backing-up") || pending === "backup";
  const restoring = (status?.busy && status.phase === "restoring") || pending === "restore" || pending === "rollback";
  const blocked = Boolean(pending || status?.busy);
  const progress = status?.progress;
  const percent = progress?.total ? " " + Math.floor(progress.bytes / progress.total * 100) + "%" : "";
  const hint = pending === "select-library" ? "正在切换库并重新打开客户端…" : !status ? "正在读取备份状态…" : restoring ? "正在恢复记忆" + percent :
    backingUp ? "正在备份本机记忆" + percent : status.phase === "restored" ? "记忆库已恢复" :
    status.lastError === "SPACE_DISK_FULL" ? "盒子空间不足，请腾出空间后重试" :
    status.lastError === "MEMORY_BACKUP_SOURCE_UNAVAILABLE" ? "无法识别本机备份来源，请检查设备标识" :
    status.phase === "error" ? "上次操作未完成" : !status.enabled ? "自动备份已关闭" :
    !status.connected ? "连接盒子后自动备份" : status.lastBackup ?
    "本机最近备份 " + snapshotDate(status.lastBackup) : "已开启，等待本机首次备份";

  return <section className="my-ai-sync-overview" aria-label="本机记忆与备份">
    <div className="my-ai-sync-summary">
      <div className="my-ai-sync-title"><RefreshCw size={17} aria-hidden="true" /><h2>本机来源采集</h2><span>{collectionScope} · {collectionMode}</span></div>
      <div className="my-ai-backup-control">
        <span id="space-backup-label"><Cloud size={16} aria-hidden="true" />空间自动备份</span>
        <button type="button" role="switch" className="my-ai-backup-switch" aria-labelledby="space-backup-label"
          aria-describedby="space-backup-status" aria-checked={status?.enabled ?? true} disabled={blocked || !status?.context}
          onClick={() => void update(status?.enabled ? "disable" : "enable")}><span /></button>
      </div>
    </div>
    <div className="my-ai-sync-status">
      {status?.library && <label>当前记忆库 <select value={status.library.id} disabled={blocked || !status.context}
        onChange={event => void update("select-library", event.target.value)}>
        {status.libraries?.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
      </select></label>}
      <span id="space-backup-status" role="status">{(backingUp || restoring) && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}{hint}</span>
      {status?.enabled && <span>每 {intervalLabel}备份本机记忆库</span>}
      {status?.connected && <button type="button" className="my-ai-button" disabled={blocked} onClick={() => void update("backup")}>立即备份</button>}
      <button type="button" className="my-ai-button" disabled={blocked || !status?.context}
        onClick={() => void update("catalog")}>{pending === "catalog" ? "正在读取备份…" : "从备份恢复"}</button>
    </div>
    {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
    {catalog && <div className="my-ai-restore-confirm" role="group" aria-label="选择恢复来源">
      {status?.library && <p>显示「{status.library.name}」的备份。可切换记忆库查看其他来源。</p>}
      {catalog.sourcesError && <p>{catalog.sourcesError}</p>}
      {!status?.connected && <p>连接盒子后可查看空间快照。</p>}
      {status?.connected && !catalog.sourcesError && !catalog.sources.length && <p>盒子上暂无记忆备份。</p>}
      {catalog.sources.length > 0 && <>
        <label>来源设备或安装
          <select value={sourceId} disabled={blocked} onChange={event => {
            setSourceId(event.target.value); setSnapshotId(""); setConfirming(null);
          }}>
            <option value="">请选择来源</option>
            {catalog.sources.map(source => <option key={source.id} value={source.id}>{source.name}{source.current ? "（本机）" : ""}</option>)}
          </select>
        </label>
        <label>快照版本
          <select value={snapshotId} disabled={blocked || !selectedSource} onChange={event => {
            setSnapshotId(event.target.value); setConfirming(null);
          }}>
            <option value="">请选择快照</option>
            {selectedSource?.snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshotLabel(snapshot)}</option>)}
          </select>
        </label>
        <button type="button" className="my-ai-button" disabled={blocked || !selectedSnapshot}
          onClick={() => setConfirming("restore")}>查看恢复确认</button>
      </>}
      {catalog.rollbackAvailable && <button type="button" className="my-ai-button" disabled={blocked}
        onClick={() => setConfirming("rollback")}>恢复上次切换前的本机副本</button>}
      {confirming && <div>
        <p>{confirming === "restore" && selectedSnapshot
          ? "将切换到 " + selectedSource?.name + " 的快照（" + snapshotLabel(selectedSnapshot) + "）。" : "将切换到上次切换前的本机副本。"}
          系统会先保留当前记忆库的本机副本。恢复的文件路径和环境信息仅供参考，请在本机核实。</p>
        <button type="button" className="my-ai-button primary" disabled={blocked}
          onClick={() => void update(confirming)}>确认恢复</button>
        <button type="button" className="my-ai-button" disabled={blocked} onClick={() => setConfirming(null)}>取消确认</button>
      </div>}
      <button type="button" className="my-ai-button" disabled={Boolean(pending)} onClick={closePicker}>关闭恢复列表</button>
    </div>}
    <details className="my-ai-sync-details"><summary>采集与备份设置</summary>
      <div className="my-ai-backup-schedule">
        <div><label htmlFor="space-backup-interval">空间备份间隔</label><p>连接盒子且客户端运行时生效，修改后自动保存。</p></div>
        <select id="space-backup-interval" value={intervalMinutes} disabled={blocked || !status?.context}
          onChange={event => void update("configure", Number(event.target.value))}>
          {[5, 15, 30, 60, 180, 360, 1440].map(minutes => <option key={minutes} value={minutes}>{minutes < 60 ? minutes + " 分钟" : minutes % 60 === 0 ? (minutes / 60) + " 小时" : minutes + " 分钟"}</option>)}
          {![5, 15, 30, 60, 180, 360, 1440].includes(intervalMinutes) && <option value={intervalMinutes}>{intervalLabel}</option>}
        </select>
      </div>
      {typeof children === "function" ? children(collectionProfile) : children}
    </details>
  </section>;
}
