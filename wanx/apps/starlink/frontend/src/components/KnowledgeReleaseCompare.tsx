import { useEffect, useState } from 'react';
import type { Page, Release } from './KnowledgeReleases';
import { endpoint, useRead, Pager, ErrorNotice, origin } from './releaseUi';

type Pair = { workspace: string; before: Release; after: Release };
type Status = 'added' | 'removed' | 'modified' | 'changed' | 'unchanged';
type Summary = { body?: { version_number: number }; publication_note: string; knowledge?: { correction_revision?: number; ontology_name: string; ontology_version_number: number } };
type Material = { document_id: string; document_name: string; status: Status; before: Summary | null; after: Summary | null };
type Overview = Page<Material> & { summary: Record<Status, number>; unavailable: { before: number; after: number } };
type Item = { id: string; kind: string; payload: { name?: string; type: string; aliases?: string[]; properties?: Record<string, unknown> }; source_count: number; endpoints?: Record<string, string> };
type Change = { status: Status; fields: string[]; sources_changed: boolean; before: Item | null; after: Item | null };
const labels: Record<string, string> = { added: '新增', removed: '移除', modified: '修改', changed: '记录变化', unchanged: '未变化', name: '名称', type: '类型', aliases: '别名', properties: '属性', source_candidate_key: '起点', target_candidate_key: '终点', entity_types: '实体类型', relation_types: '关系类型', description: '说明', source_types: '起点类型', target_types: '终点类型', required: '必填', label: '显示名称' };
const display = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
function url(pair: Pair, suffix = '', values: Record<string, string | number> = {}) {
  return endpoint(pair.workspace, '/compare' + suffix, { before_id: pair.before.id, after_id: pair.after.id, ...values });
}
function VersionPicker({ workspace, label, selected, choose }: { workspace: string; label: string; selected: Release | null; choose: (v: Release) => void }) {
  const [offset, setOffset] = useState(0);
  const result = useRead<Page<Release>>(endpoint(workspace, '', { offset }));
  const options = result.value?.items || [];
  const name = (v: Release) => `v${v.version_number} · ${origin[v.origin]} · ${new Date(v.created_at).toLocaleString()}`;
  return <section className="release-version-picker"><label>{label}<select aria-label={label} value={selected?.id || ''} disabled={!result.value}
    onChange={event => { const value = options.find(v => v.id === event.target.value); if (value) choose(value); }}>
    <option value="" disabled>选择发布版本</option>
    {selected && !options.some(v => v.id === selected.id) && <option value={selected.id}>{name(selected)}</option>}
    {options.map(v => <option key={v.id} value={v.id}>{name(v)}</option>)}</select></label>
    <ErrorNotice message={result.error} retry={result.reload} />
    {result.value && <Pager offset={offset} total={result.value.total} move={setOffset} />}</section>;
}
function Counts({ values }: { values: Record<string, number> }) {
  return <p className="release-diff-counts">{Object.entries(values).map(([key, count]) => <span key={key}>{labels[key] || key} {count}</span>)}</p>;
}
function ItemValue({ item }: { item: Item | null }) {
  if (!item) return <p>此侧无条目</p>;
  return <div><strong>{item.payload.name || `${item.endpoints?.source_candidate_key} → ${item.payload.type} → ${item.endpoints?.target_candidate_key}`}</strong>
    <p>类型：{item.payload.type}</p>{!!item.payload.aliases?.length && <p>别名：{item.payload.aliases.join('、')}</p>}
    {Object.entries(item.payload.properties || {}).map(([key, value]) => <p key={key}>{key}：{display(value)}</p>)}
    <small>{item.source_count} 条来源依据</small></div>;
}
function SourceChanges({ pair, document, change }: { pair: Pair; document: string; change: Change }) {
  const [offset, setOffset] = useState(0);
  const result = useRead<Page<{ status: Status; evidence: { excerpt: string; locator: unknown; start: number; end: number } }> & { unchanged: number }>(
    url(pair, `/documents/${encodeURIComponent(document)}/sources`, { offset, ...(change.before ? { before_item: change.before.id } : {}), ...(change.after ? { after_item: change.after.id } : {}) }));
  return <section className="release-source-diff"><h4>来源变化</h4><ErrorNotice message={result.error} retry={result.reload} />
    {!result.value && !result.error && <p>正在加载来源…</p>}
    {result.value && <><p>未变化来源 {result.value.unchanged} 条；新增和移除如下。</p>
      {result.value.items.map((item, index) => <blockquote key={index}><strong>{labels[item.status]}</strong><p>{item.evidence.excerpt}</p>
        <small>片段内字符 {item.evidence.start}–{item.evidence.end} · 位置 {display(item.evidence.locator)}</small></blockquote>)}
      {!result.value.total && <p>来源依据未变化。</p>}<Pager offset={offset} total={result.value.total} move={setOffset} /></>}</section>;
}
function ItemChanges({ pair, document, kind }: { pair: Pair; document: string; kind: 'entity' | 'relation' }) {
  const [offset, setOffset] = useState(0), [only, setOnly] = useState(true), [selected, setSelected] = useState<Change | null>(null);
  const result = useRead<Page<Change> & { summary: Record<string, number> }>(url(pair, `/documents/${encodeURIComponent(document)}/items`, { kind, offset, changes_only: String(only) }));
  return <section><label><input type="checkbox" checked={only} onChange={e => { setOnly(e.target.checked); setOffset(0); setSelected(null); }} />仅显示变化条目</label>
    <ErrorNotice message={result.error} retry={result.reload} />
    {!result.value && !result.error && <p>正在计算条目差异…</p>}
    {result.value && <><Counts values={result.value.summary} /><div className="release-item-diffs">{result.value.items.map((change, index) => <article key={index}>
      <h4>{labels[change.status]}{change.fields.length > 0 && ` · ${change.fields.map(k => labels[k] || k).join('、')}`}{change.sources_changed && ' · 来源变化'}</h4>
      <div className="release-diff-columns"><section><small>对比前</small><ItemValue item={change.before} /></section><section><small>对比后</small><ItemValue item={change.after} /></section></div>
      <button onClick={() => setSelected(change)}>查看来源差异</button></article>)}</div>
      {!result.value.total && <p>没有符合条件的{kind === 'entity' ? '实体' : '关系'}差异。</p>}
      <Pager offset={offset} total={result.value.total} move={v => { setOffset(v); setSelected(null); }} /></>}
    {selected && <SourceChanges key={`${selected.before?.id}:${selected.after?.id}`} pair={pair} document={document} change={selected} />}
  </section>;
}
function BodySide({ pair, document, release, present }: { pair: Pair; document: string; release: Release; present: boolean }) {
  const [offset, setOffset] = useState(0);
  const result = useRead<{ text: string; total: number }>(present ? endpoint(pair.workspace, `/${release.id}/documents/${encodeURIComponent(document)}/text`, { offset }) : null);
  return <section><h4>v{release.version_number} 正文</h4><ErrorNotice message={result.error} retry={result.reload} />
    {!present ? <p>此版本未包含材料。</p> : result.value ? <><pre className="release-text">{result.value.text}</pre><Pager offset={offset} total={result.value.total} size={2000} move={setOffset} /></> : !result.error && <p>正在加载正文…</p>}</section>;
}
function BodyChanges({ pair, document }: { pair: Pair; document: string }) {
  const [offset, setOffset] = useState(0);
  const result = useRead<Page<{ status: Status; before: string | null; after: string | null }> & { changed: boolean; mode: string; present: boolean[] }>(url(pair, `/documents/${encodeURIComponent(document)}/body`, { offset }));
  return <section><ErrorNotice message={result.error} retry={result.reload} />{!result.value && !result.error && <p>正在计算正文差异…</p>}
    {result.value && <>{!result.value.changed ? <p>正文内容未变化。</p> : result.value.mode === 'side_by_side' ? <>
      <p>正文较长，改用两侧分页阅读，不生成逐段差异。</p><div className="release-diff-columns"><BodySide pair={pair} document={document} release={pair.before} present={result.value.present[0]} />
        <BodySide pair={pair} document={document} release={pair.after} present={result.value.present[1]} /></div></> : <>
      <p>仅展示变化的文本段；长段落分段展示。</p>{result.value.items.map((item, index) => <article key={index}><strong>{labels[item.status]}</strong><div className="release-diff-columns">
        <section><small>对比前</small><pre className="release-text">{item.before ?? '此侧无内容'}</pre></section><section><small>对比后</small><pre className="release-text">{item.after ?? '此侧无内容'}</pre></section></div></article>)}
      {!result.value.total && <p>正文状态已变化，未发现可展示的文字差异。</p>}<Pager offset={offset} total={result.value.total} move={setOffset} /></>}</>}
  </section>;
}
function OntologyChanges({ pair, document }: { pair: Pair; document: string }) {
  const [offset, setOffset] = useState(0);
  type Ontology = { ontology_name: string | null; ontology_version_number: number | null };
  const result = useRead<Page<{ path: string[]; before: unknown; after: unknown; status: Status }> & { version_changed: boolean; before: Ontology; after: Ontology }>(url(pair, `/documents/${encodeURIComponent(document)}/ontology`, { offset }));
  const name = (value: Ontology) => value.ontology_name ? `${value.ontology_name} · v${value.ontology_version_number}` : '无已发布本体记录';
  return <section><ErrorNotice message={result.error} retry={result.reload} />{!result.value && !result.error && <p>正在计算本体差异…</p>}
    {result.value && <><p>对比前：{name(result.value.before)} → 对比后：{name(result.value.after)}</p>
      <p>{result.value.version_changed ? '本体版本发生变化。' : '本体版本未变化。'}</p>
      {result.value.items.map((item, index) => <article key={index}><h4>{labels[item.status]} · {item.path.map(k => labels[k] || k).join(' / ') || '定义'}</h4>
        <div className="release-diff-columns"><p>对比前：{display(item.before)}</p><p>对比后：{display(item.after)}</p></div></article>)}
      {!result.value.total && <p>本体定义未变化。</p>}<Pager offset={offset} total={result.value.total} move={setOffset} /></>}
  </section>;
}
function MaterialChanges({ pair, material }: { pair: Pair; material: Material }) {
  const [tab, setTab] = useState('entity');
  return <section className="release-document release-material-diff"><h3>{material.document_name}</h3>
    <div className="release-diff-columns">{[material.before, material.after].map((value, index) => <section key={index}><h4>{index ? '对比后' : '对比前'}</h4>
      {value ? <><p>正文 {value.body ? `v${value.body.version_number}` : '未就绪'} · {value.knowledge ? `本体 ${value.knowledge.ontology_name} v${value.knowledge.ontology_version_number}` : '知识未发布'}</p>
        <p>发布说明：{value.publication_note || '未填写'}</p></> : <p>此版本未包含材料。</p>}</section>)}</div>
    <div className="release-toolbar">{[['entity', '实体差异'], ['relation', '关系差异'], ['body', '正文差异'], ['ontology', '本体差异']].map(([key, text]) =>
      <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{text}</button>)}</div>
    {(tab === 'entity' || tab === 'relation') && <ItemChanges key={tab} pair={pair} document={material.document_id} kind={tab} />}
    {tab === 'body' && <BodyChanges pair={pair} document={material.document_id} />}
    {tab === 'ontology' && <OntologyChanges pair={pair} document={material.document_id} />}
  </section>;
}
function ComparisonResult({ pair }: { pair: Pair }) {
  const [offset, setOffset] = useState(0), [only, setOnly] = useState(true), [selected, setSelected] = useState<Material | null>(null);
  const result = useRead<Overview>(url(pair, '', { offset, changes_only: String(only) }));
  return <section className="release-comparison-result"><h3>v{pair.before.version_number} → v{pair.after.version_number}</h3>
    {pair.before.id === pair.after.id && <p>所选为同一版本。</p>}
    <label><input type="checkbox" checked={only} onChange={e => { setOnly(e.target.checked); setOffset(0); setSelected(null); }} />仅显示材料记录变化</label>
    <ErrorNotice message={result.error} retry={result.reload} />{!result.value && !result.error && <p>正在比较材料清单…</p>}
    {result.value && <><Counts values={result.value.summary} />
      {(result.value.unavailable.before > 0 || result.value.unavailable.after > 0) && <p role="status">部分材料已删除或不可访问：对比前 {result.value.unavailable.before} 份，对比后 {result.value.unavailable.after} 份；不展示其历史内容，也不推断对应关系。</p>}
      <p className="release-help">材料记录变化也可能仅涉及发布说明或重新发布；具体内容变化见下方。知识条目仅在有明确连续修改依据时对应，无法确认的按增删展示。</p>
      <div className="release-materials">{result.value.items.map(item => <button key={item.document_id} aria-pressed={selected?.document_id === item.document_id} onClick={() => setSelected(item)}>
        <strong>{labels[item.status]} · {item.document_name}</strong></button>)}</div>
      {!result.value.total && <p>没有符合条件的可访问材料变化。</p>}<Pager offset={offset} total={result.value.total} move={v => { setOffset(v); setSelected(null); }} />
      {selected && <MaterialChanges key={selected.document_id} pair={pair} material={selected} />}</>}
  </section>;
}
export default function KnowledgeReleaseCompare({ workspace }: { workspace: string }) {
  const [before, setBefore] = useState<Release | null>(null), [after, setAfter] = useState<Release | null>(null);
  const initial = useRead<Page<Release>>(endpoint(workspace));
  useEffect(() => { if (initial.value && !before && !after) {
    setAfter(initial.value.items[0] || null); setBefore(initial.value.items[1] || initial.value.items[0] || null);
  } }, [initial.value, before, after]);
  return <section className="release-compare"><h2>版本差异对比</h2><p>按“对比前 → 对比后”查看变化。对比只读取已冻结记录，不修改当前知识或搜索结果。</p>
    <ErrorNotice message={initial.error} retry={initial.reload} />
    {initial.value?.total === 0 ? <p>尚无发布记录，请先建立当前基线或完成知识发布。</p> : <>
      <div className="release-diff-columns"><VersionPicker workspace={workspace} label="对比前版本" selected={before} choose={setBefore} />
        <VersionPicker workspace={workspace} label="对比后版本" selected={after} choose={setAfter} /></div>
      <button disabled={!before || !after} onClick={() => { setBefore(after); setAfter(before); }}>交换对比方向</button>
      {before && after && <ComparisonResult key={`${before.id}:${after.id}`} pair={{ workspace, before, after }} />}</>}
  </section>;
}
