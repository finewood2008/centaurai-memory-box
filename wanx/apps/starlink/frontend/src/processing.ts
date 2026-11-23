export type KnowledgeSummary = {
  run_id: string;
  run_status: string;
  candidate_entities: number;
  candidate_relations: number;
  accepted_entities: number;
  accepted_relations: number;
  published_entities: number;
  published_relations: number;
  rejected_entities: number;
  rejected_relations: number;
  reasons: { message: string; count: number }[];
};

const mergedScanReasons = new Set(["SCAN_SCOPE_CHANGED", "INDEX_CHANGED", "DETECTOR_CHANGED", "SCAN_SUPERSEDED"]);

export function isMergedScan(job: {
  kind: string;
  status: string;
  error_code?: string | null;
  metrics?: { replacement_job_id?: string };
}): boolean {
  return job.kind === "sensitive_scan" && job.status === "cancelled"
    && mergedScanReasons.has(job.error_code ?? "")
    && typeof job.metrics?.replacement_job_id === "string"
    && job.metrics.replacement_job_id.length > 0;
}

export function jobExecutionLabel(job: { attempt: number; status: string }, merged = false): string {
  if (merged && job.attempt === 0) return "无需执行";
  if (job.attempt === 0 && job.status === "queued") return "尚未执行";
  if (job.attempt === 0 && ["cancelled", "failed"].includes(job.status)) return "未执行";
  return `第 ${job.attempt} 次执行`;
}

export function knowledgeStage(kind: string, status: string, summary?: KnowledgeSummary | null): string | null {
  if (status !== "succeeded" || !summary) return null;
  if (kind === "knowledge_publish") {
    return summary.published_relations === 0 ? "处理完成，未形成有效关系" : "已入图";
  }
  if (kind === "knowledge_extract" && summary.accepted_relations === 0) {
    return "抽取完成，无有效关系";
  }
  return null;
}

export type IndexJob = {
  id: string;
  status: string;
  cancel_requested?: boolean;
  error_message?: string | null;
  metrics?: { replacement_job_id?: string };
};
export type DeleteResult = {
  status?: string;
  cleanup_job?: IndexJob | null;
  index_status: string;
  index_job?: IndexJob | null;
};
export type IndexNotice = { text: string; failed?: boolean; jobId?: string };
export type IndexStatus = {
  fresh: boolean;
  publishable_segments: number;
  items: { build_job_id: string; status: string; job_status?: string }[];
};
export type ReadJson = <T>(url: string) => Promise<T>;

export function initialIndexNotice(result: DeleteResult): IndexNotice {
  if (result.index_status === "empty") return { text: "当前已无可索引正文，旧索引已停用。" };
  if (result.index_status === "current") return { text: "检索索引已同步。" };
  if (result.index_status === "unavailable") return { text: "索引更新暂不可用，请检查配置。", failed: true };
  return result.index_job
    ? { text: "检索索引正在后台自动更新。", jobId: result.index_job.id }
    : { text: "未获取到索引更新任务，请在任务中心查看。", failed: true };
}

export async function readIndexNotice(jobId: string, workspace: string, read: ReadJson): Promise<IndexNotice> {
  const job = await read<IndexJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (job.status === "queued" || job.status === "running") {
    return { text: job.cancel_requested ? "索引更新正在取消。" : "检索索引正在后台自动更新。", jobId };
  }
  // Resolve the current workspace build when this job was superseded, including
  // across task pagination. Read corpus status only when a tracked job finishes.
  const current = await read<IndexStatus>(`/api/search/indexes?workspace_id=${encodeURIComponent(workspace)}`);
  if (current.publishable_segments === 0) return { text: "当前已无可索引正文，旧索引已停用。" };
  if (current.fresh) return { text: "检索索引已同步。" };
  const next = current.items.find((item) => item.build_job_id !== jobId && item.status === "building"
    && (item.job_status === "queued" || item.job_status === "running"));
  if (next) return { text: "材料有新的变动，正在等待最新索引更新。", jobId: next.build_job_id };
  if (job.status === "failed") return { text: job.error_message || "索引更新失败，请在任务中心重试。", failed: true };
  if (job.status === "cancelled") return { text: job.error_message || "索引更新已取消，可在任务中心重试。", failed: true };
  return { text: "当前材料或模型配置已变化，检索索引尚未同步，请在检索页面更新索引。", failed: true };
}
