import { useEffect, useId, useRef, useState } from 'react';
import { ontologyIssues, renameEntity, sameOntologyType, type OntologyDefinition, type OntologyProperty, type RelationDefinition } from '../ontology';
import '../ontology.css';
import StarxiaotuTerm from './StarxiaotuTerm';
import type { OntologyTypeChange } from '../ontologySuggestions';

type Selection = { kind: 'entity' | 'relation'; index: number | null };
export type OntologyEditRequest = {kind: Selection['kind']; name?: string; sequence: number};

function Properties({ value, onChange }: { value: OntologyProperty[]; onChange: (value: OntologyProperty[]) => void }) {
  return <section className="ontology-properties" aria-label="属性配置">
    <div className="ontology-list-heading"><h3>属性配置<StarxiaotuTerm name="property" /> <small>{value.length}/50</small></h3>
      <button type="button" disabled={value.length >= 50} onClick={() => onChange([...value, { name: '', label: '', required: false }])}>添加属性</button></div>
    <p className="ontology-hint">属性默认选填。勾选必填后，缺少该属性的抽取结果将无法通过校验。<StarxiaotuTerm name="required-property" /></p>
    {!value.length && <p className="ontology-empty">尚未配置属性，可按业务需要添加。</p>}
    {value.map((property, index) => <div className="ontology-property" key={index}>
      <label>属性标识<input maxLength={64} placeholder="例如 job_title" value={property.name}
        onChange={event => onChange(value.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /></label>
      <label>显示名称<input maxLength={80} placeholder="例如 职位" value={property.label}
        onChange={event => onChange(value.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} /></label>
      <label className="ontology-check"><input type="checkbox" checked={property.required}
        onChange={event => onChange(value.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} />必填</label>
      <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))}>删除属性</button>
    </div>)}
  </section>;
}

export function ConfigurationDrawer({ value, selection, onApply, onClose, onDirtyChange, disabled=false, feedback, inline=false, applyLabel='应用到列表', hint='应用后将定位到列表中的记录。请在列表核对并保存修改，再确认发布。' }: {
  value: OntologyDefinition; selection: Selection;
  onApply: (value: OntologyDefinition, change?: OntologyTypeChange) => void; onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  disabled?: boolean;
  inline?: boolean;
  feedback?:string;applyLabel?:string;hint?:string;
}) {
  const entity = selection.kind === 'entity';
  const source = selection.index === null ? null : (entity ? value.entity_types : value.relation_types)[selection.index];
  const [draft, setDraft] = useState<RelationDefinition>(() => structuredClone({
    source_types: [], target_types: [], ...source,
    name: source?.name ?? '', label: source?.label ?? '', properties: source?.properties ?? [],
  }));
  const original = useRef(JSON.stringify(draft));
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [errors, setErrors] = useState<string[]>([]);
  const errorSummary = useRef<HTMLUListElement>(null);
  const dirty = JSON.stringify(draft) !== original.current;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (errors.length) errorSummary.current?.focus();
  }, [errors]);
  useEffect(()=>{setErrors([]);},[draft]);
  useEffect(() => {
    if (inline) return;
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [inline]);
  function close() {
    if(disabled)return;
    if (dirty && !window.confirm('放弃尚未应用的修改？')) return;
    onClose();
  }
  function proposedDefinition() {
    let next = value;
    if (entity) {
      const item = { ...source, name: draft.name, label: draft.label, properties: draft.properties };
      if (selection.index === null) next = { ...value, entity_types: [...value.entity_types, item] };
      else {
        next = renameEntity(value, selection.index, draft.name);
        next = { ...next, entity_types: next.entity_types.map((current, index) => index === selection.index ? item : current) };
      }
    } else {
      next = { ...value, relation_types: selection.index === null ? [...value.relation_types, draft]
        : value.relation_types.map((current, index) => index === selection.index ? draft : current) };
    }
    return next;
  }
  const liveIssues = ontologyIssues(proposedDefinition());
  function apply() {
    if(disabled)return;
    if (selection.index !== null && !dirty) { onClose(); return; }
    const next = proposedDefinition();
    const issues = ontologyIssues(next);
    if (issues.length) { setErrors(issues); return; }
    onApply(next, source && source.name !== draft.name ? { kind: selection.kind, previous: source.name, next: draft.name } : undefined);
    onClose();
  }
  const content = <>
    <header className="ontology-drawer-header"><div><h2 id={title}>{inline ? (entity ? '实体定义' : '关系定义') : `${selection.index === null ? '新增' : '配置'}${entity ? '实体类型' : '关系类型'}`}</h2>
      <p className="ontology-hint">{entity ? '设置类型名称与属性' : '设置关系方向、端点类型与属性'}</p></div>
      {!inline && <button type="button" disabled={disabled} onClick={close} aria-label="关闭配置抽屉">关闭</button>}</header>
    <div className="ontology-drawer-body">
      {feedback&&<p role="alert" className="correction-error">{feedback}</p>}
      <fieldset disabled={disabled} className={inline ? 'ontology-type-fields' : undefined} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <div className="ontology-type-form">
      <div className="ontology-fields">
        <div className="ontology-field">
          <div><label htmlFor={title+'-type-id'}>{entity ? '实体标识' : '关系标识'}</label><StarxiaotuTerm name="type-id" /></div>
          <input id={title+'-type-id'} autoFocus={!inline} maxLength={64} value={draft.name}
            placeholder={entity ? '例如 PERSON' : '例如 WORKS_AT'} onChange={event => setDraft({ ...draft, name: event.target.value.toUpperCase().trim() })} />
        </div>
        <div className="ontology-field">
          <div><label htmlFor={title+'-type-label'}>显示名称</label><StarxiaotuTerm name="display-name" /></div>
          <input id={title+'-type-label'} maxLength={80} value={draft.label} placeholder={entity ? '例如 人物' : '例如 任职于'}
            onChange={event => setDraft({ ...draft, label: event.target.value })} />
        </div>
      </div>
      <p className="ontology-hint">标识以英文字母开头，可包含数字和下划线。{entity && '修改实体标识后，当前配置的关系引用会同步更新。'}</p>
      {!entity && <section className="ontology-endpoint-section"><h3>关系方向<StarxiaotuTerm name="relation-direction" /></h3><p className="ontology-hint">起点 → 关系 → 终点；每端至少选择一个实体类型。</p>
        {(['source_types', 'target_types'] as const).map(endpoint => <fieldset className="ontology-endpoints" key={endpoint}>
          <legend>{endpoint === 'source_types' ? '起点类型' : '终点类型'}</legend>
          {value.entity_types.map(item => <label className="ontology-check" key={item.name}>
            <input type="checkbox" checked={draft[endpoint].includes(item.name)} onChange={event => setDraft({ ...draft,
              [endpoint]: event.target.checked ? [...draft[endpoint], item.name] : draft[endpoint].filter(name => name !== item.name) })} />
            {item.label || item.name}（{item.name}）</label>)}
        </fieldset>)}</section>}
      <Properties value={draft.properties} onChange={properties => setDraft({ ...draft, properties })} />
      </div>
      <section className="ontology-live-review" aria-label="当前条目校验与预览">
        <h3>核对预览</h3>
        <p>{source?`原定义：${source.label||source.name}（${source.name}） · ${source.properties.length} 项属性`:'本次将新增一个类型。'}</p>
        <p>修改后：{draft.label||draft.name||'尚未填写名称'}（{draft.name||'尚未填写标识'}） · {draft.properties.length} 项属性</p>
        {!entity&&<p>允许方向：{draft.source_types.map(name=>value.entity_types.find(t=>t.name===name)?.label||name).join('、')||'请选择起点'} → {draft.label||draft.name||'关系'} → {draft.target_types.map(name=>value.entity_types.find(t=>t.name===name)?.label||name).join('、')||'请选择终点'}</p>}
      {inline && !dirty ? <p className="ontology-hint">填写定义后，这里会显示校验结果。</p>
        : liveIssues.length?<ul className="ontology-issues" aria-live="polite">{liveIssues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>:<p role="status">结构校验通过：标识、属性与关系引用有效。业务含义及方向仍需人工核对。</p>}
      </section>
      {errors.length > 0 && <ul className="ontology-issues" role="alert" tabIndex={-1} ref={errorSummary}>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
      </fieldset>
    </div>
    <footer className="ontology-drawer-footer"><p className="ontology-hint">{hint}</p>
      <div><button type="button" disabled={disabled} onClick={close}>取消</button><button type="button" disabled={disabled} className={inline ? "primary" : "ontology-apply"} onClick={apply}>{disabled?'正在保存…':applyLabel}</button></div></footer>
  </>;
  if (inline) return <section className="knowledge-card ontology-type-page" aria-labelledby={title}>{content}</section>;
  return <dialog ref={dialog} className="ontology-drawer" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === dialog.current) {
      const rect = dialog.current!.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    } }}>{content}</dialog>;
}

export default function OntologyEditor({ value, onChange, disabled, editRequest, onDraftChange, creationPlacement='section', onAddType, activeKind, onKindChange, published, saved=false, onPublish }: {
  value: OntologyDefinition; onChange: (value: OntologyDefinition, change?: OntologyTypeChange) => void; disabled: boolean;
  editRequest?: OntologyEditRequest;
  onDraftChange?: (dirty: boolean) => void;
  creationPlacement?: 'section' | 'page';
  onAddType?: (kind: Selection['kind']) => void;
  activeKind?: Selection['kind'];
  onKindChange?: (kind: Selection['kind']) => void;
  published?: OntologyDefinition; saved?: boolean;
  onPublish?: (kind:'entity'|'relation',name:string)=>void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const canAddType = onAddType || creationPlacement === 'section';
  function addType(kind: Selection['kind']) {
    if (onAddType) onAddType(kind);
    else setSelection({ kind, index: null });
  }
  const [lastApplied,setLastApplied]=useState<{kind:Selection['kind'];name:string}>();
  const tableArea=useRef<HTMLFieldSetElement>(null);
  useEffect(()=>{
    if(selection||!lastApplied)return;
    const frame=requestAnimationFrame(()=>{
      const row=[...tableArea.current?.querySelectorAll<HTMLElement>('[data-type-name]')??[]].find(row=>row.dataset.typeName===lastApplied.name&&row.dataset.typeKind===lastApplied.kind);
      row?.scrollIntoView({block:'center'});row?.focus({preventScroll:true});
    });
    return()=>cancelAnimationFrame(frame);
  },[selection,lastApplied]);
  function changed(kind:Selection['kind'],item:OntologyDefinition['entity_types'][number]) {
    const previous=(kind==='entity'?published?.entity_types:published?.relation_types)?.find(type=>type.name===item.name);
    return !sameOntologyType(previous,item)?previous?'修改':'新增':null;
  }
  function status(kind:Selection['kind'],item:OntologyDefinition['entity_types'][number]) {
    if(!onPublish)return null;
    const change=changed(kind,item);
    if (!change && activeKind) return null;
    return <span className={`badge ${change?'ontology-pending-badge':'published'}`}>{change?`${change} · ${saved?'待发布':'未保存'}`:'已生效'}</span>;
  }
  const consumedRequest = useRef<OntologyEditRequest | undefined>(undefined);
  useEffect(()=>{
    if(!editRequest||disabled||consumedRequest.current===editRequest)return;
    consumedRequest.current=editRequest;
    const index=editRequest.name?(editRequest.kind==='entity'?value.entity_types:value.relation_types).findIndex(item=>item.name===editRequest.name):null;
    if(index!==-1)setSelection({kind:editRequest.kind,index});
  },[editRequest,disabled,value]);
  function remove(kind: Selection['kind'], index: number) {
    if (!window.confirm('从当前配置中删除此类型？保存并发布前不会影响已有版本。')) return;
    onChange(kind === 'entity' ? { ...value, entity_types: value.entity_types.filter((_, i) => i !== index) }
      : { ...value, relation_types: value.relation_types.filter((_, i) => i !== index) },
      { kind, previous: (kind === 'entity' ? value.entity_types : value.relation_types)[index].name, next: null });
  }
  const typeLabel = (name: string) => value.entity_types.find(item => item.name === name)?.label || name;
  return <>
    <fieldset ref={tableArea} className="ontology-config" disabled={disabled}>
      {activeKind ? <div className="rules-draft-tabs" role="group" aria-label="选择待编辑类型">
        <button type="button" aria-pressed={activeKind === 'entity'} onClick={() => onKindChange?.('entity')}>实体类型 {value.entity_types.length}</button>
        <button type="button" aria-pressed={activeKind === 'relation'} onClick={() => onKindChange?.('relation')}>关系类型 {value.relation_types.length}</button>
      </div> : <legend>抽取规则配置</legend>}
      {activeKind !== 'relation' && <>
      <div className="ontology-list-heading"><h3>实体类型 <small>{value.entity_types.length}/100</small></h3>
        {canAddType&&<button type="button" disabled={value.entity_types.length >= 100} onClick={() => addType('entity')}>添加实体类型</button>}</div>
      <div className="ontology-table-wrap"><table className="ontology-table" aria-label="实体类型列表">
        <thead><tr><th>名称 / 标识</th><th>属性</th><th>操作</th></tr></thead>
        <tbody>{selection?.kind==='entity'&&selection.index===null&&<tr className="ontology-pending-row"><td colSpan={3}>新增实体类型 · 待填写。完成配置后显示在本列表，取消则不保留空记录。</td></tr>}{value.entity_types.map((item, index) => {
          const used = value.relation_types.some(relation => relation.source_types.includes(item.name) || relation.target_types.includes(item.name));
          return <tr key={index} tabIndex={-1} data-type-kind="entity" data-type-name={item.name} className={lastApplied?.kind==='entity'&&lastApplied.name===item.name?'ontology-pending-row':undefined}><td><button className="ontology-name" type="button" onClick={() => setSelection({ kind: 'entity', index })}>{item.label || item.name}</button><small>{item.name}</small>{status('entity',item)}</td>
            <td>{item.properties.length} 项{item.properties.some(property => property.required) && <small>{item.properties.filter(property => property.required).length} 项必填</small>}</td>
            <td><div className="ontology-table-actions"><button type="button" onClick={() => setSelection({ kind: 'entity', index })}>配置属性</button>
              {onPublish&&changed('entity',item)&&<button type="button" onClick={()=>onPublish('entity',item.name)}>核对并发布</button>}
              <button type="button" disabled={used || value.entity_types.length === 1} onClick={() => remove('entity', index)}>删除</button></div>
              {used && <small>已被关系引用，需先调整关系</small>}{value.entity_types.length === 1 && <small>至少保留一个实体类型</small>}</td></tr>;
        })}</tbody></table></div></>}
      {activeKind !== 'entity' && <>
      <div className="ontology-list-heading"><h3>关系类型 <small>{value.relation_types.length}/200</small></h3>
        {canAddType&&<button type="button" disabled={value.relation_types.length >= 200} onClick={() => addType('relation')}>添加关系类型</button>}</div>
      <div className="ontology-table-wrap"><table className="ontology-table" aria-label="关系类型列表">
        <thead><tr><th>名称 / 标识</th><th>方向 / 属性</th><th>操作</th></tr></thead>
        <tbody>{selection?.kind==='relation'&&selection.index===null&&<tr className="ontology-pending-row"><td colSpan={3}>新增关系类型 · 待填写。完成配置后显示在本列表，取消则不保留空记录。</td></tr>}{value.relation_types.map((item, index) => <tr key={index} tabIndex={-1} data-type-kind="relation" data-type-name={item.name} className={lastApplied?.kind==='relation'&&lastApplied.name===item.name?'ontology-pending-row':undefined}>
          <td><button className="ontology-name" type="button" onClick={() => setSelection({ kind: 'relation', index })}>{item.label || item.name}</button><small>{item.name}</small>{status('relation',item)}</td>
          <td><span>{item.source_types.map(typeLabel).join('、')} → {item.target_types.map(typeLabel).join('、')}</span><small>{item.properties.length} 项属性 · {item.properties.filter(property => property.required).length} 项必填</small></td>
          <td><div className="ontology-table-actions"><button type="button" onClick={() => setSelection({ kind: 'relation', index })}>配置关系</button>{onPublish&&changed('relation',item)&&<button type="button" onClick={()=>onPublish('relation',item.name)}>核对并发布</button>}<button type="button" onClick={() => remove('relation', index)}>删除</button></div></td>
        </tr>)}</tbody></table>{!value.relation_types.length && <p className="ontology-empty">尚未配置关系，可以只抽取实体。</p>}</div></>}
      <details className="ontology-preview"><summary>查看生成的 JSON（只读）</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
    </fieldset>
    {selection && !disabled && <ConfigurationDrawer value={value} selection={selection} onDirtyChange={onDraftChange} onApply={(next,change)=>{
      const list=selection.kind==='entity'?next.entity_types:next.relation_types;
      setLastApplied({kind:selection.kind,name:list[selection.index??list.length-1].name});onChange(next,change);
    }} onClose={() => setSelection(null)} />}
  </>;
}
