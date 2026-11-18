import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import OntologyEditor from './OntologyEditor';
import OntologySuggestions from './OntologySuggestions';
import {requestJson} from '../request';
import {ontologyIssues,sameOntologyType,type OntologyDefinition} from '../ontology';
import {newOntologyOperationId,type SuggestionPreview,type OntologyTypeChange} from '../ontologySuggestions';
import type {Summary} from '../corrections';
import type {MaterialOntologyStatus} from './MaterialOntologyNotice';

export default function MaterialRuleEditor({workspace,documentId,summary,status,disabled,onState,save}:{
  workspace:string;documentId:string;summary:Summary;status?:MaterialOntologyStatus;disabled:boolean;
  onState:(value:{dirty:boolean;busy:boolean})=>void;save:(body:unknown)=>void;
}) {
  const [schema,setSchema]=useState(summary.ontology as OntologyDefinition),[base,setBase]=useState('');
  const [currentRules,setCurrentRules]=useState<OntologyDefinition>();
  const [reload,setReload]=useState(0);
  const [preview,setPreview]=useState<SuggestionPreview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [ids,setIds]=useState<string[]>([]),[changes,setChanges]=useState<OntologyTypeChange[]>([]);
  const reviews=useRef<Record<string,boolean>>({}),loadedTask=useRef('');
  const saved=JSON.stringify(summary.ontology),dirty=JSON.stringify(schema)!==saved;
  const operation=useRef<{fingerprint:string;id:string}|undefined>(undefined);
  const reviewState=useCallback((id:string,complete:boolean)=>{reviews.current[id]=complete;},[]);
  useLayoutEffect(()=>{onState({dirty,busy});return()=>onState({dirty:false,busy:false});},[dirty,busy,onState]);
  useEffect(()=>{
    const controller=new AbortController();
    requestJson<{items:Array<{id:string;status:string;schema:OntologyDefinition}>}>(`/api/ontologies?workspace_id=${encodeURIComponent(workspace)}`,{signal:controller.signal},15000)
      .then(value=>{if(!controller.signal.aborted){const current=value.items.find(v=>v.status==='published');setBase(current?.id??'');setCurrentRules(current?.schema);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason.message);});
    return()=>controller.abort();
  },[workspace,reload,summary.stale_reason]);
  useEffect(()=>{
    if(disabled||status?.status!=='completed'||!status.task_id||loadedTask.current===status.task_id)return;
    const controller=new AbortController();setError('');
    requestJson<SuggestionPreview>(`/api/ontology-suggestions/materials/${encodeURIComponent(documentId)}/review`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspace}),signal:controller.signal},15000)
      .then(value=>{if(!controller.signal.aborted){loadedTask.current=status.task_id!;setPreview(value);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason.message);});
    return()=>controller.abort();
  },[status?.task_id,status?.status,documentId,workspace,disabled,reload]);
  const issues=ontologyIssues(schema);
  const differences=currentRules?(['entity_types','relation_types'] as const).flatMap(kind=>{
    const before=new Map(currentRules[kind].map(value=>[value.name,value]));
    const after=new Map(schema[kind].map(value=>[value.name,value]));
    return [...new Set([...before.keys(),...after.keys()])].filter(name=>!sameOntologyType(before.get(name),after.get(name)))
      .map(name=>`${before.has(name)?after.has(name)?'修改':'移除':'新增'}${kind==='entity_types'?'实体类型':'关系类型'}：${name}`);
  }):[];
  return <section className="material-rule-editor" aria-label="材料规则核对">
    <h3>类型与规则</h3>
    <p>{summary.ontology_status==='draft'?'规则已暂存，尚未发布。可按新类型编辑下方实体，最后统一确认应用。':'已有类型直接复用；必要的新类型可在此确认和调整。规则影响知识库后续抽取，知识修改仅作用于本篇材料。'}</p>
    {error&&<p role="alert">{error} <button disabled={disabled||busy} onClick={()=>{setError('');setReload(v=>v+1);}}>重新读取建议与规则</button></p>}
    {status?.status==='completed'&&<button disabled={disabled||busy} onClick={()=>{
      if(dirty&&!window.confirm('重新读取会撤销尚未保存的规则调整。已保存规则和实体草稿保留，是否继续？'))return;
      setSchema(summary.ontology as OntologyDefinition);setIds([]);setChanges([]);setPreview(undefined);
      reviews.current={};loadedTask.current='';setError('');setReload(v=>v+1);
    }}>重新读取本篇建议</button>}
    {summary.stale_reason==='ONTOLOGY_TARGET_CHANGED'&&<p role="alert">知识库本体已变化。请核对下方与当前发布规则的差异，再保存待发布规则；人工内容保留。</p>}
    {differences.length>0&&<details><summary>与当前发布规则的差异（{differences.length} 项）</summary>{differences.map(value=><p key={value}>{value}</p>)}</details>}
    {preview&&<OntologySuggestions key={preview.id} embedded schema={schema} initialPreview={preview} baseOntologyId={base} disabled={disabled} previewIds={ids} typeChanges={changes}
      onReviewState={reviewState} onBusy={setBusy} onAdopt={(value,id)=>{setSchema(value);setIds(previous=>[...new Set([...previous,id])]);}} />}
    <details><summary>配置实体类型、属性和关系规则</summary>
      <OntologyEditor value={schema} disabled={disabled||busy} onChange={(value,change)=>{setSchema(value);if(change)setChanges(previous=>[...previous,change]);}} />
    </details>
    {issues.length>0&&<p role="alert">{issues.join('；')}</p>}
    {dirty&&<p>规则有未保存调整；先保存待发布规则或撤销调整，再刷新草稿、按新类型编辑实体。建议过期时可重新读取本篇建议。</p>}
    <button disabled={disabled||busy||!dirty&&summary.stale_reason!=='ONTOLOGY_TARGET_CHANGED'||!base||!!issues.length} onClick={()=>{
      const body={expected_revision:summary.revision,base_ontology_id:base,schema,preview_ids:ids,
        reviewed_preview_ids:ids.filter(id=>reviews.current[id])};
      const fingerprint=JSON.stringify(body);
      if(operation.current?.fingerprint!==fingerprint)operation.current={fingerprint,id:newOntologyOperationId()};
      save({...body,operation_id:operation.current.id});
    }}>保存待发布规则</button>
    {dirty&&<button disabled={disabled||busy} onClick={()=>{if(window.confirm('撤销本页尚未保存的规则调整？')){setSchema(summary.ontology as OntologyDefinition);setIds([]);setPreview(undefined);loadedTask.current='';setChanges([]);}}}>撤销规则调整</button>}
  </section>;
}
