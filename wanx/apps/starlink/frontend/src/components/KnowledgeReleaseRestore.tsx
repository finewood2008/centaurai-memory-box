import { useEffect, useRef, useState } from 'react';
import DocumentKnowledgeCorrections from './DocumentKnowledgeCorrections';
import { endpoint, useRead, Pager, ErrorNotice } from './releaseUi';
import type { Receipt } from '../corrections';
import { correctionHeaders, rememberCorrectionLease } from '../corrections';
import { requestJson, RequestError } from '../request';

type HistoricalItem = { kind: string; payload: { name?: string; type: string; aliases?: string[]; properties?: Record<string, unknown> }; endpoints?: Record<string, string>; source_count: number };
type Preview = { preview_digest: string; can_create: boolean; existing_draft_id: string | null; publication_pending: boolean;
  restored_from: { version_number: number }; body_changed: boolean; ontology_changed: boolean; cleared_sources: number;
  summary: { added: number; removed: number; modified: number }; counts: { entity: number; relation: number };
  validation: { errors: number; warnings: number }; ontology: { name: string; version_number: number };
  items: { item_id: string; before: HistoricalItem | null; after: HistoricalItem | null }[]; total: number; offset: number; limit: number };
type RestoreBody = { operation_id: string; preview_digest: string; confirmed: true; note: string };
function Value({ item }: { item: HistoricalItem | null }) {
  if (!item) return <p>无此条目</p>;
  return <div><strong>{item.payload.name || `${item.endpoints?.source_candidate_key} → ${item.payload.type} → ${item.endpoints?.target_candidate_key}`}</strong>
    {item.payload.aliases && <p>别名：{item.payload.aliases.join('、') || '无'}</p>}
    <p>{item.payload.type} · {item.source_count} 条来源</p>{Object.entries(item.payload.properties || {}).map(([key, value]) => <p key={key}>{key}：{typeof value === 'string' ? value : JSON.stringify(value)}</p>)}</div>;
}
export default function KnowledgeReleaseRestore({ workspace, release, document, name }: { workspace: string; release: string; document: string; name: string }) {
  const [open, setOpen] = useState(false), [offset, setOffset] = useState(0), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pending, setPending] = useState<RestoreBody | null>(null);
  const active = useRef<AbortController | null>(null);
  const path = `/${encodeURIComponent(release)}/documents/${encodeURIComponent(document)}`;
  const preview = useRead<Preview>(open && !receipt ? endpoint(workspace, path + '/restore-preview', { offset }) : null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pending) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  async function restore(body: RestoreBody) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(''); setPending(body);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = await correctionHeaders(workspace, document, controller.signal);
      const value = await requestJson<Receipt>(endpoint(workspace, path + '/restore'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (active.current === controller && !controller.signal.aborted) { rememberCorrectionLease(workspace, document, value); setReceipt(value); setPending(null); }
    } catch (reason) {
      if (active.current === controller && reason instanceof RequestError && reason.status >= 400 && reason.status < 500) setPending(null);
      if (active.current === controller) setError(controller.signal.aborted ? '请求超时，结果尚未确认。请重试原请求核对。' : reason instanceof Error ? reason.message : '恢复草稿失败');
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  return <section className="release-restore">
    {!open ? <button onClick={() => setOpen(true)}>恢复此材料知识为新草稿</button> : <>
      <h4>恢复历史知识</h4><p>恢复本材料的实体、关系及可核实来源为新草稿。当前正文和本体保持原样；核对并确认发布后，才会替换本材料的知识结果。</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      {receipt ? <><p role="status">恢复草稿已生成。请打开草稿查看最新的核对与发布状态。</p><DocumentKnowledgeCorrections workspace={workspace} documentId={document} documentName={name} draftId={receipt.draft_id} />
        <button onClick={() => { setReceipt(null); setOffset(0); setError(''); }}>重新预览恢复</button></> : <>
        <ErrorNotice message={preview.error} retry={preview.reload} />
        {!preview.value && !preview.error && <p>正在预览恢复影响…</p>}
        {preview.value && <><p>来源版本 v{preview.value.restored_from.version_number} · 恢复后 {preview.value.counts.entity} 个实体、{preview.value.counts.relation} 条关系</p>
          <p>相对当前结果：新增 {preview.value.summary.added}、移除 {preview.value.summary.removed}、修改 {preview.value.summary.modified}。</p>
          <p>校验本体：{preview.value.ontology.name} v{preview.value.ontology.version_number}（当前材料知识绑定的本体）。{preview.value.ontology_changed && '与历史本体不同，请检查类型及属性。'}</p>
          {preview.value.body_changed && <p className="notice error">正文版本已变化，历史来源将全部清空，必须重新选择当前正文依据。</p>}
          {preview.value.cleared_sources > 0 && <p>将清除 {preview.value.cleared_sources} 条无法沿用的来源。</p>}
          {!preview.value.counts.entity && !preview.value.counts.relation && <p className="notice error">这是已发布的空知识结果。后续确认发布该草稿将清空本材料的实体与关系贡献。</p>}
          <p>校验发现 {preview.value.validation.errors} 个阻断问题、{preview.value.validation.warnings} 个复核提示。可以先生成草稿，发布前必须处理。</p>
          {preview.value.existing_draft_id && <><p role="alert">已有编辑草稿，恢复不会覆盖它。请先查看并处理该草稿，再重新预览。</p>
            <DocumentKnowledgeCorrections workspace={workspace} documentId={document} documentName={name} draftId={preview.value.existing_draft_id} /></>}
          {preview.value.publication_pending && <p role="alert">发布任务尚未结束，请稍后重新预览。</p>}
          {preview.value.items.map(item => <article key={item.item_id} className="release-diff-columns"><section><small>当前结果</small><Value item={item.before} /></section><section><small>恢复草稿</small><Value item={item.after} /></section></article>)}
          {!preview.value.total && <p>知识内容与当前结果相同，仍需核对后再决定是否发布。</p>}
          <Pager offset={offset} total={preview.value.total} move={v => { if (!busy && !pending) setOffset(v); }} />
          <label>恢复说明（可选）<textarea maxLength={1500} value={note} disabled={busy || !!pending} onChange={e => setNote(e.target.value)} /></label>
          <div className="release-toolbar"><button disabled={busy || !!pending || !preview.value.can_create} onClick={() => {
            const value = preview.value!;
            if (window.confirm(`确认从发布版本 v${value.restored_from.version_number} 恢复本材料知识为新草稿？${value.counts.entity + value.counts.relation === 0 ? '该草稿为空知识结果。' : ''} 这一步不会发布或修改当前搜索结果。`))
              void restore({ operation_id: crypto.randomUUID(), preview_digest: value.preview_digest, confirmed: true, note });
          }}>{busy ? '正在生成…' : '确认生成恢复草稿'}</button>
            <button disabled={busy || !!pending} onClick={() => { setError(''); preview.reload(); }}>重新预览</button></div>
        </>}
        {pending && !busy && <p>结果尚未确认。<button onClick={() => void restore(pending)}>重试原恢复请求</button></p>}
      </>}
      <button disabled={busy || !!pending} onClick={() => setOpen(false)}>收起恢复面板</button>
    </>}
  </section>;
}
