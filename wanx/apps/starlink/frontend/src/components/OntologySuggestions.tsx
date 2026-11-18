import { useEffect, useRef, useState } from 'react';
import { RequestError, requestJson } from '../request';
import { embeddedHost } from '../nativeHost';
import type { OntologyDefinition } from '../ontology';
import { adoptSuggestion, updateTypeMappings, updateReuseTarget, currentDirection, type OntologyTypeChange, type OntologySuggestion, type SuggestionPreview, type TypeMappings } from '../ontologySuggestions';

type Material = { id: string; original_name: string; status: string };
type Props = {
  schema: OntologyDefinition; baseOntologyId?: string; disabled: boolean; previewIds: string[];
  typeChanges: OntologyTypeChange[];
  initialPreview?: SuggestionPreview;
  focusRequest?: number;
  embedded?: boolean;
  onReviewState: (previewId: string, complete: boolean) => void;
  onBusy: (busy: boolean) => void; onAdopt: (schema: OntologyDefinition, previewId: string) => void;
};
const workspace = 'default';

function SuggestionEvidence({ evidence, additional = false }: { evidence: OntologySuggestion['evidence']; additional?: boolean }) {
  const host = embeddedHost();
  return <blockquote>{evidence.quote}
    <small>{additional ? '另一来源' : '来源'}：{evidence.document_name} · 正文版本 {evidence.version_id.slice(0, 8)}</small>
    {host?.openSource && <button type="button" aria-label={`打开引用版本 ${evidence.document_name}`}
      onClick={() => host.openSource(window, evidence.document_id, evidence.version_id)}>打开引用版本</button>}
  </blockquote>;
}

function SuggestionCard({ item, schema, done, busy, typeChanges, mappings, onAdopt, onIgnore, onReopen }: {
  item: OntologySuggestion; schema: OntologyDefinition; done?: string; busy: boolean;
  onAdopt: (name: string, label: string, definition: string, target?: string) => void; onIgnore: () => void;
  onReopen: () => void;
  typeChanges: OntologyTypeChange[]; mappings: TypeMappings;
}) {
  const [name, setName] = useState(item.name), [label, setLabel] = useState(item.label);
  const [definition, setDefinition] = useState(item.definition ?? '');
  const [target, setTarget] = useState(item.reuse_target || '');
  const appliedChanges = useRef(typeChanges.length);
  useEffect(() => {
    const changes = typeChanges.slice(appliedChanges.current);
    appliedChanges.current = typeChanges.length;
    if (changes.length) setTarget(previous => updateReuseTarget(previous, item.kind, changes));
  }, [typeChanges, item.kind]);
  const canAdd = item.allow_new_type !== false;
  const definitions = item.kind === 'entity' ? schema.entity_types : schema.relation_types;
  const existing = definitions.find(entry => entry.name === target);
  const existingRelation = item.kind === 'relation' ? schema.relation_types.find(entry => entry.name === target) : undefined;
  const targetMissing = !!target && !existing;
  const directionLabels = { same: '端点方向相同', compatible: '端点范围兼容', reversed: '端点方向相反', different: '端点范围不同', missing: '端点类型待确认或已删除' };
  const direction = existingRelation ? directionLabels[currentDirection(item, existingRelation, schema, mappings)] : '';
  return <article className="ontology-suggestion" aria-label={`建议 ${item.name}`}>
    <div className="ontology-list-heading"><strong>{{ entity: '实体类型', relation: '关系类型', property: '属性' }[item.kind]} · {item.label}</strong>
      <span>{done || (item.reuse_target ? '优先复用' : item.comparison === 'existing' ? '标识已存在' : item.similar_to.length ? '先核对已有类型' : '新增候选')}</span></div>
    {item.policy_note && <p className="ontology-notice">{item.policy_note}</p>}
    <p>建议说明：{item.reason}</p>
    {item.kind === 'relation' && <p>建议方向：{item.source_types?.join(' / ')} → {item.name} → {item.target_types?.join(' / ')}</p>}
    {item.kind === 'property' && <p>所属类型：{item.owner_name} · 默认选填，不补造缺失值</p>}
    <SuggestionEvidence evidence={item.evidence} />
    {item.additional_evidence?.map(evidence =>
      <SuggestionEvidence key={`${evidence.document_id}:${evidence.version_id}:${evidence.segment_id}`} evidence={evidence} additional />)}
    {item.similar_to.length > 0 && <p className="ontology-hint">生成时的候选：{item.similar_to.map(entry => `${entry.label}（${entry.name}）`).join('、')}。请以下方当前配置和方向比较为准；模型说明、近似名称和相同端点均不能代替语义核对。</p>}
    {!done ? <>
      <div className="ontology-fields"><label>建议标识<input disabled={busy || !!target} value={name} maxLength={64} onChange={event => setName(event.target.value)} /></label>
        <label>显示名称<input disabled={busy || !!target} value={label} maxLength={80} onChange={event => setLabel(event.target.value)} /></label></div>
      {!target && <label>定义<textarea disabled={busy} value={definition} rows={2} maxLength={500}
        placeholder="写明适用范围，以及容易混淆的情况" onChange={event => setDefinition(event.target.value)} /></label>}
      {item.kind !== 'property' && <label>复用／合并到已有类型（保留已有定义）
        <select disabled={busy} value={target} onChange={event => setTarget(event.target.value)}><option value="" disabled={!canAdd}>{canAdd ? '作为新增类型（需核对必要性）' : '请选择已有类型'}</option>
          {targetMissing && <option value={target} disabled>原复用目标已删除，请重新选择</option>}
          {definitions.map(entry => <option key={entry.name} value={entry.name}>{entry.label}（{entry.name}）</option>)}</select></label>}
      {existing && <p className="ontology-hint">已有定义：{existing.label}（{existing.name}），{existing.properties.length} 项属性。{existing.definition && <> {existing.definition}</>}
        {existingRelation && <>方向：{existingRelation.source_types.join(' / ')} → {existingRelation.target_types.join(' / ')}。与建议比较：{direction}（按当前配置计算）。</>}</p>}
      {targetMissing && <p role="alert" className="ontology-issues">原复用目标已删除，必须重新选择；新增同名类型不会自动恢复选择。</p>}
      {item.kind !== 'property' && !target && canAdd && <div className="ontology-notice">
        <p>现有规则不足（模型建议，需人工核对）：{item.existing_gap || '未提供'}</p><p>具体业务用途：{item.business_need || '未提供'}</p>
        <p>仅当上述理由成立时新增；也可在上方选择已有类型复用。</p></div>}
      <div className="ontology-table-actions"><button type="button" disabled={busy || targetMissing || item.kind !== 'property' && !target && !canAdd} onClick={() => onAdopt(name, label, definition, target || undefined)}>{target ? '确认复用／合并' : '采纳到配置'}</button>
        <button type="button" disabled={busy} onClick={onIgnore}>忽略</button></div>
    </> : <><p className="ontology-hint">{done === '已采纳' ? '可在下方列表抽屉继续调整；创建草稿后保存。' : '本条未加入配置。'}</p>
      <button type="button" disabled={busy} onClick={onReopen}>重新处理</button></>}
  </article>;
}

export default function OntologySuggestions({ schema, baseOntologyId, disabled, previewIds, typeChanges, initialPreview, focusRequest = 0, onBusy, onAdopt, onReviewState, embedded=false }: Props) {
  const [open, setOpen] = useState(!!initialPreview), [page, setPage] = useState(0);
  const summary = useRef<HTMLElement>(null);
  const lastFocus = useRef(0);
  const [materials, setMaterials] = useState<Material[]>([]), [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<SuggestionPreview | null>(initialPreview ?? null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [mappings, setMappings] = useState<TypeMappings>({ entity: {}, relation: {} });
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [working, setWorking] = useState(false);
  const [generationFailed, setGenerationFailed] = useState(false);
  const pending = useRef(false), alive = useRef(true);
  const mappedChanges = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest === lastFocus.current) return;
    lastFocus.current = focusRequest;
    setOpen(true);
    const frame = requestAnimationFrame(() => {
      summary.current?.focus({ preventScroll: true });
      summary.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  useEffect(() => {
    if (preview) onReviewState(preview.id, preview.suggestions.every(item => !!decisions[item.id]));
  }, [preview, decisions, onReviewState]);
  useEffect(() => {
    const changes = typeChanges.slice(mappedChanges.current);
    mappedChanges.current = typeChanges.length;
    if (changes.length) setMappings(previous => updateTypeMappings(previous, changes));
  }, [typeChanges]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open || embedded) return;
    const controller = new AbortController();
    setLoading(true);
    requestJson<{ items: Material[]; total: number }>(`/api/documents?workspace_id=${workspace}&limit=20&offset=${page * 20}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setMaterials(result.items); setTotal(result.total); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, page, embedded]);

  async function generate() {
    if (pending.current || disabled || !baseOntologyId || !Object.keys(selected).length) return;
    if (preview && !window.confirm('重新生成会替换当前建议列表；已经应用到配置的内容保留。是否继续？')) return;
    pending.current = true; setWorking(true); onBusy(true); setError(''); setGenerationFailed(false);
    try {
      const result = await requestJson<SuggestionPreview>('/api/ontology-suggestions/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace, document_ids: Object.keys(selected), base_ontology_id: baseOntologyId, schema }) });
      if (!alive.current) return;
      setPreview(result); setDecisions({}); setMappings({ entity: {}, relation: {} });
      mappedChanges.current = typeChanges.length;
    } catch (reason) {
      if (alive.current) {
        setGenerationFailed(true);
        setError(reason instanceof RequestError && reason.code === 'ONTOLOGY_MODEL_TIMEOUT'
          ? '生成建议超时。已保留选中的资料，可以直接重试。'
          : reason instanceof Error ? reason.message : '生成失败');
      }
    }
    finally { pending.current = false; if (alive.current) { setWorking(false); onBusy(false); } }
  }

  async function adopt(item: OntologySuggestion, name: string, label: string, target?: string) {
    if (!preview || pending.current || disabled) return;
    if (!previewIds.includes(preview.id) && previewIds.length >= 8) { setError('已采纳 8 批建议，请先创建草稿保存。'); return; }
    pending.current = true; setWorking(true); onBusy(true); setError('');
    try {
      const next = adoptSuggestion(schema, item, mappings, name, label, target);
      await requestJson(`/api/ontology-suggestions/${preview.id}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: workspace }) });
      if (!alive.current) return;
      setMappings(next.mappings);
      if (JSON.stringify(next.schema) !== JSON.stringify(schema)) onAdopt(next.schema, preview.id);
      setDecisions(previous => ({ ...previous, [item.id]: '已采纳' }));
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '采纳失败'); }
    finally { pending.current = false; if (alive.current) { setWorking(false); onBusy(false); } }
  }

  return <details className="ontology-suggestions" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary ref={summary}>{embedded?'当前材料的类型与属性建议':'从材料生成本体建议'}</summary>
    <p className="ontology-hint">优先复用已有类型，岗位和角色优先作为属性。出现新词不等于需要新类型；没有必要扩展时可以不产生建议。</p>
    <p className="ontology-hint">{embedded?'系统已根据材料原文生成建议。采纳后保存待发布规则，最后与本篇知识一起确认应用。':'选择 1–5 份已就绪的代表性资料。系统会使用当前处理模型抽取样本片段，并列出建议和原文依据。临时建议有效 30 分钟，采纳后可保存为草稿。'}</p>
    {!embedded && !baseOntologyId && <p className="ontology-notice">发布首个规则版本后，可以从资料生成补充建议。</p>}
    {!embedded&&previewIds.length > 0 && <p className="ontology-hint">当前配置包含已采纳建议。若来源变化或建议过期，请使用下方“撤销未保存配置并清除建议”后重新生成；只重新生成不会解除旧批次的保存校验。</p>}
    {!embedded&&<fieldset disabled={disabled || working} className="ontology-source-picker">
      <legend>选择材料（已选 {Object.keys(selected).length}/5）</legend>
      {loading ? <p>正在读取材料…</p> : materials.length === 0 ? <p>暂无材料，请先导入并等待正文处理完成。</p> : materials.map(material => <label key={material.id} className="ontology-check">
        <input type="checkbox" checked={material.id in selected} disabled={material.status !== 'ready' || !(material.id in selected) && Object.keys(selected).length >= 5}
          onChange={event => setSelected(previous => { const next = { ...previous }; if (event.target.checked) next[material.id] = material.original_name; else delete next[material.id]; return next; })} />
        {material.original_name}{material.status !== 'ready' && '（正文未就绪）'}</label>)}
      <div className="ontology-table-actions"><button type="button" disabled={!page || loading} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page + 1}/{Math.max(1, Math.ceil(total / 20))} 页</span><button type="button" disabled={(page + 1) * 20 >= total || loading} onClick={() => setPage(page + 1)}>下一页</button></div>
      {Object.keys(selected).length > 0 && <p>已选：{Object.values(selected).join('、')} <button type="button" onClick={() => setSelected({})}>清空选择</button></p>}
      <button type="button" disabled={!Object.keys(selected).length || !baseOntologyId} onClick={() => void generate()}>{generationFailed ? '重试生成建议' : preview ? '重新生成建议' : '生成建议'}</button>
    </fieldset>}
    {working && <p role="status">正在处理，请等待模型或版本校验完成…</p>}
    {error && <p role="alert" className="ontology-issues">{error}</p>}
    {preview && <div className="ontology-suggestion-results">
      <p>本批 {preview.suggestions.length} 条建议；已排除 {preview.rejected_count} 条缺少有效依据、结构不完整或新增必要性不足的输出。{preview.suggestions.length === 0 && '当前未发现有充分依据的必要扩展；已有本体仍可继续使用。'}</p>
      {preview.documents.map(document => <p className="ontology-hint" key={document.id}>{document.name}：读取 {document.sampled_segments}/{document.total_segments} 个片段{document.truncated ? '，仅部分覆盖' : ''}。</p>)}
      {!embedded&&<><p className="ontology-hint">先采纳或合并实体，再处理关系和属性。采纳只更新下方配置，仍需创建草稿、人工核对并确认发布。</p>
      <p className="ontology-hint">整批建议都采纳、复用或忽略后，创建草稿才会将对应材料标为已核对；只处理部分建议会继续保留待确认提示。全部无需改动时，可回到材料详情标记已核对。</p></>}
      {[...preview.suggestions].sort((a, b) => ['entity', 'relation', 'property'].indexOf(a.kind) - ['entity', 'relation', 'property'].indexOf(b.kind)).map(item =>
        <SuggestionCard key={item.id} item={item} schema={schema} done={decisions[item.id]} busy={disabled || working} typeChanges={typeChanges} mappings={mappings}
          onAdopt={(name, label, definition, target) => void adopt({ ...item, definition }, name, label, target)} onIgnore={() => setDecisions(previous => ({ ...previous, [item.id]: '已忽略' }))}
          onReopen={() => setDecisions(previous => { const next = { ...previous }; delete next[item.id]; return next; })} />)}
    </div>}
  </details>;
}
