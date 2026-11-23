import { useEffect, useState } from "react";
import { initialIndexNotice, readIndexNotice, type DeleteResult, type IndexJob, type IndexNotice, type KnowledgeSummary, type ReadJson } from "../processing";

export function KnowledgeOutcome({ summary }: { summary: KnowledgeSummary }) {
  return <div className="knowledge-outcome">
    <small>抽取 {summary.candidate_entities} 个实体、{summary.candidate_relations} 条关系
      {summary.run_status === "published" || summary.run_status === "stale"
        ? ` · ${summary.run_status === "stale" ? "曾" : "实际"}入图 ${summary.published_entities} 个实体、${summary.published_relations} 条关系`
        : ` · 通过校验 ${summary.accepted_entities} 个实体、${summary.accepted_relations} 条关系`}
    </small>
    {summary.run_status === "published" && summary.published_relations === 0 &&
      <small>未形成有效关系，正文仍可用于检索。</small>}
    {summary.run_status === "stale" && <small>该批次已失效，以上为历史处理结果。</small>}
    {!!summary.reasons.length && <details>
      <summary>未入图原因（{summary.rejected_entities} 个实体、{summary.rejected_relations} 条关系）</summary>
      <ul>{summary.reasons.map((reason) => <li key={reason.message}>{reason.message}：{reason.count} 项</li>)}</ul>
    </details>}
    {!summary.candidate_entities && !summary.candidate_relations && summary.run_status === "published" &&
      <small>本次抽取没有返回实体或关系候选。</small>}
  </div>;
}

export function DeleteIndexNotice({ result, workspace, read }: { result: DeleteResult; workspace: string; read: ReadJson }) {
  const [notice, setNotice] = useState<IndexNotice>(() => initialIndexNotice(result));
  const [cleanup, setCleanup] = useState<IndexJob | null>(result.cleanup_job ?? null);
  useEffect(() => {
    let disposed = false;
    let indexTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const initial = initialIndexNotice(result);
    setNotice(initial);
    setCleanup(result.cleanup_job ?? null);
    async function pollCleanup(jobId: string) {
      try {
        const job = await read<IndexJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (disposed) return;
        setCleanup(job);
        if (job.status === "queued" || job.status === "running") {
          cleanupTimer = setTimeout(() => void pollCleanup(jobId), 1800);
        }
      } catch {
        if (!disposed) cleanupTimer = setTimeout(() => void pollCleanup(jobId), 1800);
      }
    }
    async function poll(jobId: string) {
      let next: IndexNotice;
      try {
        next = await readIndexNotice(jobId, workspace, read);
      } catch {
        next = { text: "暂时无法获取索引进度，正在自动重试。", failed: true, jobId };
      }
      if (disposed) return;
      setNotice(next);
      if (next.jobId) indexTimer = setTimeout(() => void poll(next.jobId!), 1800);
    }
    if (result.cleanup_job) void pollCleanup(result.cleanup_job.id);
    if (initial.jobId) void poll(initial.jobId);
    return () => { disposed = true; if (indexTimer) clearTimeout(indexTimer); if (cleanupTimer) clearTimeout(cleanupTimer); };
  }, [result, workspace, read]);
  const cleanupPending = cleanup && (cleanup.status === "queued" || cleanup.status === "running");
  const cleanupFailed = cleanup && (cleanup.status === "failed" || cleanup.status === "cancelled");
  return <div className={`notice ${notice.failed || cleanupFailed ? "error" : "success"}`} role="status">
    {cleanupPending ? "文档已停止对外显示，正在彻底清理。" : cleanupFailed
      ? `彻底清理未完成：${cleanup.error_message || "请在任务中心重试。"}`
      : "文档及其派生数据已彻底清理。"}{notice.text}
  </div>;
}

type ReplacementJob = { id: string; status: string; stage: string; error_message?: string | null;
  metrics?: { replacement_job_id?: string } };
const replacementStatus: Record<string, string> = {
  queued: "等待执行", running: "正在扫描", succeeded: "扫描完成", failed: "扫描失败", cancelled: "已取消",
};

export function MergedScanInfo({ replacementId, attempt, read }: {
  replacementId: string; attempt: number; read: ReadJson;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState(replacementId);
  const [replacement, setReplacement] = useState<ReplacementJob | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const job = await read<ReplacementJob>(`/api/jobs/${encodeURIComponent(targetId)}`);
        if (disposed) return;
        const successor = job.status === "cancelled" ? job.metrics?.replacement_job_id : undefined;
        if (successor && successor !== targetId) {
          setTargetId(successor);
          return;
        }
        setReplacement(job);
        setError(false);
        if (job.status === "queued" || job.status === "running") timer = setTimeout(() => void poll(), 2000);
      } catch {
        if (disposed) return;
        setError(true);
        timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [open, targetId, read]);
  return <div className="merged-scan-info">
    <small>{attempt === 0 ? "材料或图谱更新后，旧扫描已并入新任务，无需再执行。" : "旧扫描已被新扫描接替，以新任务的结果为准。"}</small>
    <button className="merged-scan-link" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? "收起接替任务" : "查看接替任务状态"}
    </button>
    {open && <div className="merged-scan-result" role="status">
      {error ? "暂时无法读取接替任务，正在重试。"
        : replacement?.id === targetId
          ? <>接替任务 {replacement.id.slice(0, 8)}：{replacementStatus[replacement.status] ?? replacement.status}
            {replacement.error_message && <span> · {replacement.error_message}</span>}</>
          : "正在读取接替任务状态…"}
    </div>}
  </div>;
}
