import { useEffect, useRef, useState } from 'react';
import { requestJson } from '../request';
import { embeddedHost } from '../nativeHost';
import type { OntologyDefinition } from '../ontology';
import { materialCoverageText, adoptSuggestion, updateTypeMappings, updateReuseTarget, currentDirection, type OntologyTypeChange, type OntologySuggestion, type SuggestionPreview, type TypeMappings } from '../ontologySuggestions';

type Props = {
  schema: OntologyDefinition; disabled: boolean; previewIds: string[];
  typeChanges: OntologyTypeChange[];
  initialPreview: SuggestionPreview;
  focusRequest?: number;
  embedded?: boolean;
  onReviewState: (previewId: string, complete: boolean) => void;
  onBusy: (busy: boolean) => void; onAdopt: (schema: OntologyDefinition, previewId: string) => void;
};
const workspace = 'default';

function SuggestionEvidence({ evidence, additional = false }: { evidence: OntologySuggestion['evidence']; additional?: boolean }) {
  const host = embeddedHost();
  return <blockquote>{evidence.quote}
    {evidence.proposed_definition && <small>该处建议的定义：{evidence.proposed_definition}</small>}
    {evidence.existing_gap && <small>该处指出的缺口：{evidence.existing_gap}</small>}
    {evidence.business_need && <small>该处的业务用途：{evidence.business_need}</small>}
    {additional && evidence.scope_target && <small>对应仓目标：{evidence.scope_target}</small>}
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
    {item.scope_target && <p>对应仓目标：{item.scope_target}</p>}
    {item.existing_gap && <p>与现有规则的差异：{item.existing_gap}</p>}
    {item.business_need && <p>业务用途：{item.business_need}</p>}
    {item.policy_note && <p className="ontology-notice">{item.policy_note}</p>}
    <p>建议说明：{item.reason}</p>
    {item.kind === 'relation' && <p>建议方向：{item.source_types?.join(' / ')} → {item.name} → {item.target_types?.join(' / ')}</p>}
    {item.kind === 'property' && <p>所属类型：{item.owner_name} · 默认选填，不补造缺失值</p>}
    <SuggestionEvidence evidence={item.evidence} />
    {item.additional_evidence?.map((evidence,index) =>
      <SuggestionEvidence key={index} evidence={evidence} additional />)}
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
        <p>仅当上述理由成立时新增；也可在上方选择已有类型复用。</p></div>}
      <div className="ontology-table-actions"><button type="button" disabled={busy || targetMissing || item.kind !== 'property' && !target && !canAdd} onClick={() => onAdopt(name, label, definition, target || undefined)}>{target ? '确认复用／合并' : '采纳到配置'}</button>
        <button type="button" disabled={busy} onClick={onIgnore}>忽略</button></div>
    </> : <><p className="ontology-hint">{done === '已采纳' ? '可在下方列表抽屉继续调整；创建草稿后保存。' : '本条未加入配置。'}</p>
      <button type="button" disabled={busy} onClick={onReopen}>重新处理</button></>}
  </article>;
}

export default function OntologySuggestions({ schema, disabled, previewIds, typeChanges, initialPreview, focusRequest = 0, onBusy, onAdopt, onReviewState, embedded=false }: Props) {
  const [open, setOpen] = useState(true);
  const summary = useRef<HTMLElement>(null);
  const lastFocus = useRef(0);
  const preview = initialPreview;
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [mappings, setMappings] = useState<TypeMappings>({ entity: {}, relation: {} });
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
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
    <summary ref={summary}>{embedded?'当前材料的类型与属性建议':'本体建议待核对'}</summary>
    <p className="ontology-hint">结合星图目标与材料内容，比较复用、细化或新增类型、属性和关系。</p>
    <p className="ontology-hint">{embedded?'建议来自材料原文。可采纳后随本篇知识一起核对发布。':'建议来自材料原文。采纳的建议可以保存为草稿，再核对是否发布。'}</p>
    {!embedded&&previewIds.length > 0 && <p className="ontology-hint">若来源变化或建议过期，请撤销未保存配置，再从资料库打开最新建议。</p>}
    {working && <p role="status">正在校验建议与原文版本…</p>}
    {error && <p role="alert" className="ontology-issues">{error}</p>}
    {preview && <div className="ontology-suggestion-results">
      <p>本批 {preview.suggestions.length} 条建议；已排除 {preview.rejected_count} 条原文依据或结构校验未通过的输出。{preview.suggestions.length === 0 && '本次分析未提出扩展建议。'}</p>
      {preview.review_summary && <p className="ontology-hint">{preview.review_summary}</p>}
      {preview.documents.map(document => <p className="ontology-hint" key={document.id}>{document.name}：{materialCoverageText({
        mode: document.coverage_mode ?? preview.coverage_mode ?? 'sampled', segments: document.sampled_segments, total: document.total_segments,
        partial: document.truncated, empty_segments: document.empty_segments,
      })}</p>)}
      {!embedded&&<><p className="ontology-hint">先采纳或合并实体，再处理关系和属性。采纳只更新下方配置，仍需创建草稿、人工核对并确认发布。</p>
      <p className="ontology-hint">整批建议都采纳、复用或忽略后，创建草稿才会将对应材料标为已核对；只处理部分建议会继续保留待确认提示。全部无需改动时，可回到材料详情标记已核对。</p></>}
      {[...preview.suggestions].sort((a, b) => ['entity', 'relation', 'property'].indexOf(a.kind) - ['entity', 'relation', 'property'].indexOf(b.kind)).map(item =>
        <SuggestionCard key={item.id} item={item} schema={schema} done={decisions[item.id]} busy={disabled || working} typeChanges={typeChanges} mappings={mappings}
          onAdopt={(name, label, definition, target) => void adopt({ ...item, definition }, name, label, target)} onIgnore={() => setDecisions(previous => ({ ...previous, [item.id]: '已忽略' }))}
          onReopen={() => setDecisions(previous => { const next = { ...previous }; delete next[item.id]; return next; })} />)}
    </div>}
  </details>;
}
