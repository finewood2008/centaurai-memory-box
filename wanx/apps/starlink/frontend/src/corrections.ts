import { requestJson, RequestError } from './request.ts';
import type {ReviewReference} from './extractionReview.ts';

export type Evidence = { segment_id: string; document_id?: string; document_version_id?: string;
  start?: number; end?: number; ranges?: number[][]; excerpt?: string; locator?: Record<string, unknown> };
export type Issue = { item_id: string; code: string; message: string; severity: "error" | "warning" | "info"; reviewed?: boolean; requires_review?: boolean; property_name?: string };
export type Item = { id: string; kind: "entity" | "relation"; payload: Record<string, unknown>;
  evidence: Evidence[]; review_note?: string; review_basis?: string; issues?: Issue[];
  endpoints?: Record<string, { id: string; name: string; type: string }> };
export type Definition = { name: string; label: string; properties: { name: string; label: string; required: boolean }[];
  source_types?: string[]; target_types?: string[] };
export type Summary = { id: string; revision: number; status: string; stale_reason: string | null;
  has_changes?:boolean;
  ontology_changed?:boolean;
  review_reference?: ReviewReference | null;
  requires_source_review?: boolean;
  ontology_version_id?: string; ontology_target?: {id:string;name:string;version_number:number}|null;
  ontology_status?: string;
  restored_from?: { version_number: number; body_version_number: number | null } | null;
  document_id: string; document_version_id: string; updated_at: string; counts: { entity: number; relation: number };
  ontology: { entity_types: Definition[]; relation_types: Definition[] }; change_count: number;
  validation: { errors: number; warnings: number; unreviewed: number } };
export type Page<T> = { items: T[]; total: number; offset: number; limit: number; revision: number };
export type Source = { segment_id: string; ordinal: number; text: string; start: number; end: number;
  total_chars: number; locator: Record<string, unknown> };
export type SelectedKnowledgeSource = { documentId: string; versionId: string; segmentId: string;
  start?: number; end?: number; label: string; text?: string };
export type Change = { item_id: string; before: Item | null; after: Item | null };
export type Preview = Page<Change> & { ready_for_confirmation: boolean; issue_count: number; issues: Issue[]; stale_reason: string | null };
export type Receipt = { draft_id: string; revision: number; status: string; lease_generation?: number; lease_expires_at?: string; review_reference?:ReviewReference };
export type RecoverableDraft = { draft_id: string; revision: number; updated_at: string; legacy_unowned: boolean; suspended: boolean; status: string };
export type Publication = { id: string; revision: number; job_id: string; status: string; stage: string;
  effective: boolean; created_at: string; published_at: string | null; error_message: string | null; note: string };
export type Suggestion = { candidate_id: string; proposal: Item; validation_errors: string[];
  already_added: boolean; comparison: Item[]; comparison_total: number };
export type Suggestions = Page<Suggestion> & { run_id: string | null };

export class CorrectionError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "", status = 0) { super(message); this.code = code; this.status = status; }
}
export function correctionUrl(workspace: string, document: string, suffix = "", query: Record<string, string | number> = {}) {
  return `/api/documents/${encodeURIComponent(document)}/corrections${suffix}?${new URLSearchParams({ workspace_id: workspace,
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })}`;
}
// Memory belongs to this page, never localStorage/sessionStorage (a duplicated
// tab must receive its own server-issued session and explicitly claim a draft).
const editorSessions = new Map<string, { operation: string; token?: string; currentDraft?: string; generations: Map<string, number> }>();
function editorState(workspace: string, document: string) {
  const key = JSON.stringify([workspace, document]);
  let state = editorSessions.get(key);
  if (!state) { state = { operation: crypto.randomUUID(), generations: new Map() }; editorSessions.set(key, state); }
  return state;
}
export async function correctionHeaders(workspace: string, document: string, signal: AbortSignal, draft = ""): Promise<Record<string, string>> {
  const state = editorState(workspace, document);
  if (!state.token) {
    const value = await requestJson<{editor_session: string}>(correctionUrl(workspace, document, '/sessions'), {
      method: 'POST', signal, cache: 'no-store', redirect: 'error', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({operation_id: state.operation}),
    });
    if (typeof value.editor_session !== 'string') throw new Error('编辑会话响应无效，请刷新页面');
    state.token = value.editor_session;
  }
  return {'X-Correction-Session': state.token, 'X-Correction-Generation': String(state.generations.get(draft) ?? 0)};
}
export function rememberCorrectionLease(workspace: string, document: string, receipt: Partial<Receipt>) {
  if (receipt.draft_id && typeof receipt.lease_generation === 'number') {
    const state = editorState(workspace, document);
    state.generations.set(receipt.draft_id, Math.max(receipt.lease_generation, state.generations.get(receipt.draft_id) ?? 0));
    if (receipt.status === 'editing') state.currentDraft = receipt.draft_id;
  }
}
export function cachedCorrectionEditor(workspace: string, document: string, draft?: string) {
  const state = editorSessions.get(JSON.stringify([workspace, document]));
  const generation = state?.generations.get(draft || state.currentDraft || '');
  return state?.token && generation ? { document_id: document, editor_session: state.token, lease_generation: generation } : null;
}
export async function correctionRequest<T>(url: string, signal: AbortSignal, body?: unknown): Promise<T> {
  if (!/^\/api\/documents\/[^/?]+\/corrections(?:\/[^?]*)?\?/.test(url) || /\\|(?:%2e)|\/\.\./i.test(url)) throw new Error("纠错地址无效");
  try {
    const parsed = new URL(url, 'http://local.invalid');
    const document = decodeURIComponent(parsed.pathname.split('/')[3]);
    const workspace = parsed.searchParams.get('workspace_id') || 'default';
    const resource = parsed.pathname.split('/')[5];
    const draft = resource === 'current-extraction' ? editorState(workspace,document).currentDraft || '' : resource;
    const headers = await correctionHeaders(workspace, document, signal, draft);
    const result = await requestJson<T>(url, { method: body === undefined ? "GET" : "POST", signal,
      cache: "no-store", redirect: "error", headers: body === undefined ? headers : {...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    rememberCorrectionLease(workspace, document, result as Partial<Receipt>);
    return result;
  } catch (reason) {
    if (reason instanceof RequestError) throw new CorrectionError(reason.message, reason.code, reason.status);
    throw reason;
  }
}
export function editable(item: Item): Item {
  return structuredClone({ id: item.id, kind: item.kind, payload: item.payload, evidence: item.evidence, review_note: item.review_note ?? "" });
}
export function itemLabel(item: Item): string {
  if (item.kind === "entity") return String(item.payload.name || "未命名实体");
  return `${item.endpoints?.source_candidate_key?.name ?? "待选起点"} → ${item.endpoints?.target_candidate_key?.name ?? "待选终点"}`;
}
export function sourceLabel(locator: Record<string, unknown>, ordinal?: number): string {
  if (locator.page_number != null) return `第 ${locator.page_number} 页`;
  if (locator.page != null) return `第 ${locator.page} 页`;
  if (locator.start_seconds != null) return `${locator.start_seconds} 秒处`;
  return ordinal === undefined ? "原文片段" : `片段 ${ordinal + 1}`;
}
export function changedFields(change: Change): string[] {
  if (!change.before) return ["新增"];
  if (!change.after) return ["移除"];
  const names: Record<string, string> = { name: "名称", type: "类型", aliases: "别名", properties: "属性",
    source_candidate_key: "起点", target_candidate_key: "终点" };
  const fields = Object.keys(names).filter(key => JSON.stringify(change.before?.payload[key]) !== JSON.stringify(change.after?.payload[key])).map(key => names[key]);
  if (JSON.stringify(change.before.evidence) !== JSON.stringify(change.after.evidence)) fields.push("来源依据");
  if ((change.before.review_note ?? "") !== (change.after.review_note ?? "") ||
      (change.before.review_basis ?? "") !== (change.after.review_basis ?? "")) fields.push("复核说明");
  return fields;
}
export function swapDirection(item: Item): Item {
  return { ...editable(item), review_note: "", payload: { ...item.payload,
    source_candidate_key: item.payload.target_candidate_key, target_candidate_key: item.payload.source_candidate_key } };
}
// The exact envelope survives a failed response; a later retry never invents a
// new operation id or silently changes the payload of an uncertain save.
export function operationEnvelope(revision: number, upserts: Item[], removeIds: string[], note: string, operationId: string) {
  const items = upserts.map(item => {
    const value = editable(item);
    value.evidence = value.evidence.map(source => {
      if (!Number.isInteger(source.start) || !Number.isInteger(source.end)) return source;
      const {segment_id, document_id, document_version_id, start, end, ranges} = source;
      return {segment_id, document_id, document_version_id, start, end, ...(ranges && {ranges})};
    });
    return value;
  });
  return { operation_id: operationId, expected_revision: revision, upserts: items, remove_ids: [...removeIds], note };
}
