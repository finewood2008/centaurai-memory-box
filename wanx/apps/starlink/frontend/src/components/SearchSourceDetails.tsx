import { useEffect, useRef, useState } from 'react';
import { requestJson } from '../request';
import { WorkbenchDrawer } from './WorkbenchUI';

export type IndexSource = {
  id: string; document_id: string; original_name: string; version_id: string;
  version_number: number; current_version: boolean; text: string; truncated: boolean;
  locator: Record<string, unknown>; ordinal: number; segment_offset?: number; source_count?: number;
};
type Page = {items: IndexSource[]; total: number; index_id: string | null; index_version: number | null};
type Props = {
  workspace: string; mode: 'segments' | 'chunks'; indexId?: string;
  documents: {id: string; original_name: string; status: string}[];
  close: () => void; onOpen: (source: IndexSource, signal: AbortSignal) => Promise<void>;
  sourceLabel: (locator: Record<string, unknown>) => string;
};

function SourcePage({workspace, mode, indexId, documentId, itemId, onOpen, sourceLabel}: {
  workspace: string; mode: 'segments' | 'chunks'; indexId?: string; documentId: string; itemId?: string;
  onOpen: Props['onOpen']; sourceLabel: Props['sourceLabel'];
}) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const openRequest = useRef<AbortController | null>(null);
  useEffect(() => () => openRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(''); setExpanded(null);
    const query = new URLSearchParams({workspace_id: workspace, kind: mode, offset: String(offset), limit: '20'});
    if (documentId) query.set('document_id', documentId);
    if (indexId) query.set('index_id', indexId);
    if (itemId) query.set('item_id', itemId);
    requestJson<Page>(`/api/search/source-details?${query}`, {signal: controller.signal, cache: 'no-store'}, 15000)
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '明细读取失败'); });
    return () => controller.abort();
  }, [workspace, mode, indexId, documentId, itemId, offset, retry]);
  const groups = new Map<string, IndexSource[]>();
  for (const item of data?.items ?? []) {
    const key = `${item.document_id}:${item.version_id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  async function open(source: IndexSource) {
    if (openRequest.current) return;
    const controller = new AbortController();
    openRequest.current = controller;
    setOpening(true); setOpenError('');
    try { await onOpen(source, controller.signal); } catch (reason) { if (!controller.signal.aborted) setOpenError(reason instanceof Error ? reason.message : '原文打开失败'); }
    finally { openRequest.current = null; if (!controller.signal.aborted) setOpening(false); }
  }
  return <div className="index-source-page">
    {error ? <div role="alert" className="notice error">{error} <button type="button" onClick={() => setRetry(n => n + 1)}>重试</button></div>
      : !data ? <p role="status">正在读取明细…</p> : <>
      <p className="muted">共 {data.total} 个{mode === 'chunks' ? '语义工作块' : '来源片段'}{mode === 'chunks' && ` · 检索索引 v${data.index_version}`}</p>
      {!data.total && <p className="empty">当前范围没有可查看的内容。</p>}
      {[...groups.entries()].map(([key, items]) => <section className="index-source-group" key={key}>
        <h3>{items[0].original_name} <small>正文 v{items[0].version_number}{!items[0].current_version && ' · 历史正文'}</small></h3>
        {!items[0].current_version && <p className="review-warning">材料正文已修订。这些内容来自索引中的旧版本，更新索引后才能定位当前原文。</p>}
        {items.map(item => <article className="index-source-item" key={item.id}>
          <div className="index-source-item-heading"><strong>{mode === 'chunks' ? `工作块 ${item.ordinal + 1}` : '来源片段'}</strong><span>{sourceLabel(item.locator)}</span></div>
          <p className="index-source-text">{item.text}{item.truncated && '…'}</p>
          {mode === 'chunks' ? <>
            <button type="button" aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>{expanded === item.id ? '收起来源' : `查看对应来源（${item.source_count} 个片段）`}</button>
            {expanded === item.id && <SourcePage workspace={workspace} mode="segments" indexId={data.index_id ?? undefined} documentId={item.document_id} itemId={item.id} onOpen={onOpen} sourceLabel={sourceLabel} />}
          </> : <button type="button" disabled={!item.current_version || opening} onClick={() => void open(item)}>{opening ? '正在定位…' : '查看原文'}</button>}
        </article>)}
      </section>)}
      <div className="index-source-pagination">
        <button type="button" disabled={!offset} onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页</button>
        <span>{data.total ? `${offset + 1}–${Math.min(offset + 20, data.total)} / ${data.total}` : '0 / 0'}</span>
        <button type="button" disabled={offset + 20 >= data.total} onClick={() => setOffset(n => n + 20)}>下一页</button>
      </div>
    </>}
    {openError && <p role="alert" className="notice error">{openError}</p>}
  </div>;
}

export default function SearchSourceDetails(props: Props) {
  const [mode, setMode] = useState(props.mode);
  const [documentId, setDocumentId] = useState('');
  return <WorkbenchDrawer title="检索来源明细" close={props.close}>
    <p className="muted">默认展示整个知识库，与检索问题旁的筛选条件独立。按材料分组分页展示；内容为预览，可定位原文核对。</p>
    <div className="review-tabs index-source-tabs" role="group" aria-label="检索明细范围">
      <button type="button" aria-pressed={mode === 'segments'} onClick={() => setMode('segments')}>可索引来源片段</button>
      <button type="button" aria-pressed={mode === 'chunks'} disabled={!props.indexId} onClick={() => setMode('chunks')}>已索引工作块</button>
    </div>
    <label>限定材料<select value={documentId} onChange={event => setDocumentId(event.target.value)}><option value="">全部材料</option>{props.documents.filter(d => d.status === 'ready').map(d => <option key={d.id} value={d.id}>{d.original_name}</option>)}</select></label>
    <SourcePage key={`${mode}:${documentId}`} workspace={props.workspace} mode={mode} indexId={mode === 'chunks' ? props.indexId : undefined} documentId={documentId} onOpen={props.onOpen} sourceLabel={props.sourceLabel} />
  </WorkbenchDrawer>;
}
