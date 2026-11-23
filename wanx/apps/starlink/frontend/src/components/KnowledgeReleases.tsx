import { useEffect, useState } from 'react';
import { endpoint, useRead, Pager, ErrorNotice, origin } from './releaseUi';
import KnowledgeReleaseCompare from './KnowledgeReleaseCompare';
import KnowledgeReleaseRestore from './KnowledgeReleaseRestore';
import { requestJson } from '../request';
import '../releases.css';
import { DesignIcon } from './WorkbenchUI';
import ReleaseGraph from './ReleaseGraph';

export type Page<T> = { items: T[]; total: number; offset: number; limit: number };
export type Release = { id: string; version_number: number; origin: string; created_at: string; document_count: number; digest: string };
export type Material = { ordinal: number; unavailable: boolean; document_id?: string; document_name?: string;
  restored_from?: { version_number: number };
  document_version_id?: string; body_is_current?: boolean; body?: { version_number: number; version_kind: string; parser_version: string };
  knowledge?: { run_id: string; origin: string; correction_revision: number | null; ontology_name: string;
    ontology_version_number: number; ontology_schema: unknown }; publication_note?: string; entity_count?: number; relation_count?: number };
export type Detail = Release & { items: Material[]; offset: number; limit: number };
export type Item = { id: string; kind: string; payload: { name?: string; type: string; source_candidate_key?: string; target_candidate_key?: string; properties?: unknown }; source_count: number; endpoints?: Record<string, string> };
type Evidence = { segment_id: string; excerpt: string; locator: unknown };
function Sources({ url }: { url: string }) {
  const [offset, setOffset] = useState(0);
  const result = useRead<Page<Evidence>>(url + `&offset=${offset}`);
  return <section><h4>此版本的来源依据</h4><ErrorNotice message={result.error} retry={result.reload} />
    {result.value?.items.map((e, i) => <blockquote key={i}>{e.excerpt}<small>来源位置：{JSON.stringify(e.locator)}</small></blockquote>)}
    {result.value && <Pager offset={offset} total={result.value.total} move={setOffset} />}</section>;
}
function DocumentVersion({ workspace, release, material }: { workspace: string; release: string; material: Material }) {
  const [kind, setKind] = useState<'entity' | 'relation'>('entity'), [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null), [textOffset, setTextOffset] = useState(0);
  const path = `/${encodeURIComponent(release)}/documents/${encodeURIComponent(material.document_id!)}`;
  const items = useRead<Page<Item>>(endpoint(workspace, path + '/items', { kind, offset }));
  const body = useRead<{ text: string; total: number }>(endpoint(workspace, path + '/text', { offset: textOffset }));
  return <section className="release-document"><h3>{material.document_name}</h3>
    <p>正文 {material.body ? `v${material.body.version_number}` : '未就绪'} · {material.body_is_current ? '与当前正文一致' : '历史正文'}
      {material.knowledge ? ` · ${origin[material.knowledge.origin]}${material.knowledge.correction_revision ? ` · 草稿修订 ${material.knowledge.correction_revision}` : ''}` : ' · 此时知识结果尚未发布'}</p>
    {material.publication_note && <p>发布说明：{material.publication_note}</p>}
    {material.restored_from && <p>此知识修订由发布版本 v{material.restored_from.version_number} 恢复后核对发布。</p>}
    {material.knowledge && <KnowledgeReleaseRestore workspace={workspace} release={release} document={material.document_id!} name={material.document_name || '材料'} />}
    <details><summary>查看此版本正文</summary><ErrorNotice message={body.error} retry={body.reload} />
      <pre className="release-text">{body.value?.text}</pre>{body.value && <Pager offset={textOffset} total={body.value.total} size={2000} move={setTextOffset} />}</details>
    {material.knowledge && <details><summary>本体：{material.knowledge.ontology_name} · v{material.knowledge.ontology_version_number}</summary>
      <pre className="release-text">{JSON.stringify(material.knowledge.ontology_schema, null, 2)}</pre></details>}
    <div className="release-toolbar"><button aria-pressed={kind === 'entity'} onClick={() => { setKind('entity'); setOffset(0); setSelected(null); }}>实体</button>
      <button aria-pressed={kind === 'relation'} onClick={() => { setKind('relation'); setOffset(0); setSelected(null); }}>关系</button></div>
    <ErrorNotice message={items.error} retry={items.reload} />
    {items.value ? <><div className="release-items">{items.value.items.map(item => <article key={item.id}>
      <strong>{item.payload.name || item.payload.type}</strong><small>{item.payload.type} · {item.source_count} 条来源</small>
      {item.kind === 'relation' && <p>{item.endpoints?.source_candidate_key} → {item.payload.type} → {item.endpoints?.target_candidate_key}</p>}
      {Object.keys(item.payload.properties || {}).length > 0 && <pre className="release-text">{JSON.stringify(item.payload.properties, null, 2)}</pre>}
      <button onClick={() => setSelected(item.id)}>查看来源</button></article>)}</div>
      {!items.value.total && <p>此版本没有{kind === 'entity' ? '实体' : '关系'}记录。</p>}
      <Pager offset={offset} total={items.value.total} move={value => { setOffset(value); setSelected(null); }} /></> : !items.error && <p>正在加载条目…</p>}
    {selected && <Sources key={selected} url={endpoint(workspace, path + `/items/${encodeURIComponent(selected)}/sources`)} />}
  </section>;
}
function ReleaseDetail({ workspace, release }: { workspace: string; release: string }) {
  const [view,setView]=useState<'materials'|'graph'>('materials');
  const [offset, setOffset] = useState(0), [material, setMaterial] = useState<Material | null>(null);
  const detail = useRead<Detail>(endpoint(workspace, '/' + encodeURIComponent(release), { offset }));
  return <section className="knowledge-card release-detail"><ErrorNotice message={detail.error} retry={detail.reload} />
    {detail.value ? <><h2>v{detail.value.version_number} · {origin[detail.value.origin]}</h2>
      <p>记录时间：{new Date(detail.value.created_at).toLocaleString()} · {detail.value.document_count} 份材料</p>
      {detail.value.origin === 'observed_baseline' && <p>这是建立基线时观察到的内容，不代表此前的发布历史。</p>}
      <p className="release-help">记录操作来源，不代表已识别具体修改人。</p>
      <div className="review-tabs" role="tablist" aria-label="版本内容"><button role="tab" aria-selected={view==='materials'} onClick={()=>setView('materials')}>材料列表</button><button role="tab" aria-selected={view==='graph'} onClick={()=>setView('graph')}>图谱视图</button></div>
      {view==='graph'?<ReleaseGraph workspace={workspace} release={release}/>:<>
      <div className="release-materials">{detail.value.items.map(item => item.unavailable
        ? <p key={item.ordinal}>材料已删除或内容不可用，历史内容不再提供。</p>
        : <button key={item.ordinal} aria-pressed={material?.document_id === item.document_id} onClick={() => setMaterial(item)}>
          <strong>{item.document_name}</strong><small>正文 {item.body ? `v${item.body.version_number}` : '未就绪'} · {item.entity_count} 个实体 · {item.relation_count} 条关系</small></button>)}</div>
      {!detail.value.document_count && <p>此版本没有材料。</p>}
      <Pager offset={offset} total={detail.value.document_count} move={value => { setOffset(value); setMaterial(null); }} />
      {material && <DocumentVersion key={material.document_id} workspace={workspace} release={release} material={material} />}</>}</>
      : !detail.error && <p>正在加载版本…</p>}</section>;
}
export default function KnowledgeReleases({ workspace }: { workspace: string }) {
  const [mode, setMode] = useState<'history' | 'compare'>('history');
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const list = useRead<Page<Release>>(endpoint(workspace, '', { offset }));
  useEffect(() => {
    const latest = list.value?.items[0];
    if (offset === 0 && latest) setSelected(current => current ?? latest.id);
  }, [list.value, offset]);
  async function baseline() {
    if (!window.confirm('记录当前内容作为版本追溯的起点？这不会重新抽取或改变搜索结果。')) return;
    setBusy(true); setError('');
    try { const result = await requestJson<Release>(endpoint(workspace, '/baseline'), { method: 'POST', cache: 'no-store', redirect: 'error' });
      list.reload(); setSelected(result.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '建立基线失败'); }
    finally { setBusy(false); }
  }
  return <section className="release-workbench">
    <p>每次知识发布成功后记录版本。查看历史和对比差异不会切换当前搜索或图谱。</p>
    <div className="release-toolbar"><button aria-pressed={mode === 'history'} onClick={() => setMode('history')}>版本历史</button>
      <button aria-pressed={mode === 'compare'} onClick={() => setMode('compare')}><DesignIcon name="compare" />版本对比</button>
      <button onClick={list.reload}>刷新版本列表</button></div>
    {mode === 'compare' ? <KnowledgeReleaseCompare key={workspace} workspace={workspace} /> : <>
    <ErrorNotice message={list.error} retry={list.reload} />{error && <p role="alert" className="notice error">{error}</p>}
    <div className="release-layout"><aside className="knowledge-card release-list"><div className="section-title"><h3>知识版本</h3><small>按发布时间倒序</small></div>
      {!list.value && !list.error && <p>正在加载版本…</p>}
      {list.value?.items.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
        <strong>v{item.version_number}</strong><span>{new Date(item.created_at).toLocaleString()} · {item.document_count} 份材料</span><small>{origin[item.origin]}</small></button>)}
      {list.value && !list.value.total && <><p>尚无发布记录。后续发布成功时会自动记录，也可以先建立当前基线。</p><button disabled={busy} onClick={() => void baseline()}>{busy ? '正在记录…' : '建立当前基线'}</button></>}
      {list.value && <Pager offset={offset} total={list.value.total} move={setOffset} />}</aside>
      {selected ? <ReleaseDetail key={selected} workspace={workspace} release={selected} /> : <div className="knowledge-card release-detail"><p className="empty">选择一个版本查看材料和知识记录。</p></div>}</div></>}
  </section>;
}
