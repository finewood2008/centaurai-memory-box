import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {requestJson} from '../request';
import {startVisiblePolling} from '../polling';
import {newOntologyOperationId} from '../ontologySuggestions';
import {WorkbenchDrawer} from './WorkbenchUI';
import {cachedCorrectionEditor, rememberCorrectionLease, type Receipt} from '../corrections';
const OntologyUpdates=lazy(()=>import('./OntologyUpdates'));

export type MaterialState={document_id:string;name?:string;state:string;label:string;reason:string;can_reload:boolean;draft_id?:string;revision?:number;ontology_id?:string};
const attention=new Set(['reload','review','publish','rules','failed','unavailable']);
export const needsMaterialAttention=(row?:MaterialState)=>!!row&&attention.has(row.state);
export function useMaterialMaintenance(workspace:string,documents:{id:string}[],enabled:boolean){
  const ids=JSON.stringify(documents.map(d=>d.id));
  const [items,setItems]=useState<Record<string,MaterialState>>({}),[error,setError]=useState('');
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    if(!enabled)return;
    const run=++generation.current;
    try{
      const all:MaterialState[]=[],keys=JSON.parse(ids) as string[];
      for(let offset=0;offset<keys.length;offset+=100){
        const batch=keys.slice(offset,offset+100);
        const result=await requestJson<{items:MaterialState[]}>(`/api/material-maintenance/status?workspace_id=${encodeURIComponent(workspace)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({document_ids:batch,editors:batch.flatMap(id=>{const editor=cachedCorrectionEditor(workspace,id);return editor?[editor]:[];})})},20000);
        all.push(...result.items);
      }
      if(run===generation.current){setItems(Object.fromEntries(all.map(row=>[row.document_id,row])));setError('');}
    }catch(reason){if(run===generation.current)setError(reason instanceof Error?reason.message:'材料状态读取失败');}
  },[enabled,ids,workspace]);
  useEffect(()=>{generation.current++;setItems({});if(!enabled)return;const stop=startVisiblePolling({refresh,delay:()=>15000,onError:()=>{}});return()=>{generation.current++;stop();};},[enabled,refresh]);
  return {items,error,refresh};
}



export default function MaterialMaintenance({workspace,rows,error,loading,refresh,close,onReview,onReloaded}:{workspace:string;rows:MaterialState[];error:string;loading:boolean;refresh:()=>Promise<void>;close:()=>void;onReview:(id:string)=>void;onReloaded:()=>void}){
  const [selected,setSelected]=useState<Record<string,MaterialState>>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failure,setFailure]=useState(''),[all,setAll]=useState(false),[ontology,setOntology]=useState<string>();
  const pending=useRef<{operation_id:string;confirmed:true;selections:{document_id:string;draft_id:string;revision:number;editor_session:string;lease_generation:number}[]}|undefined>(undefined);

  const selectedRows=Object.values(selected),visible=all?rows:rows.filter(needsMaterialAttention);
  const target=rows.find(row=>row.ontology_id)?.ontology_id;
  const initialModeChosen=useRef(false);
  useEffect(()=>{
    if(initialModeChosen.current||!rows.length||loading||error)return;
    initialModeChosen.current=true;
    if(target&&rows.some(row=>row.state==='rules'))setOntology(target);
  },[rows,loading,error,target]);
  async function reload(){
    if(busy)return;
    if(!pending.current){
      if(!selectedRows.length||!window.confirm(`将以下 ${selectedRows.length} 份校对草稿同步到最新已发布知识？\n${selectedRows.map(row=>row.name).join('\n')}\n使用最新已发布的实体与关系更新旧草稿，仅处理没有人工修改的草稿，并保留操作记录；不会重新上传、抽取或发布。`))return;
      const editors=selectedRows.map(row=>cachedCorrectionEditor(workspace,row.document_id,row.draft_id));
      if(editors.some(editor=>!editor)){setFailure('编辑会话已变化，请进入材料核对恢复编辑后刷新状态。');return;}
      pending.current={operation_id:newOntologyOperationId(),confirmed:true,selections:selectedRows.map((row,index)=>({...editors[index]!,document_id:row.document_id,draft_id:row.draft_id!,revision:row.revision!}))};
    }
    setBusy(true);setFailure('');setMessage('');
    try{
      const result=await requestJson<{items:{document_id:string;ok:boolean;message?:string;receipt?:Receipt}[]}>(`/api/material-maintenance/reload?workspace_id=${encodeURIComponent(workspace)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.current)},60000);
      for(const row of result.items)if(row.ok&&row.receipt)rememberCorrectionLease(workspace,row.document_id,row.receipt);
      pending.current=undefined;setSelected({});
      const done=result.items.filter(row=>row.ok).length;
      setMessage(`已同步 ${done} 份校对草稿到最新已发布知识。${result.items.length-done} 份未处理。`);
      setFailure(result.items.filter(row=>!row.ok).map(row=>`${rows.find(r=>r.document_id===row.document_id)?.name??row.document_id}：${row.message}`).join('；'));
      if(done)onReloaded();await refresh();
    }catch(reason){setFailure((reason instanceof Error?reason.message:'请求失败')+'。结果尚未确认，请重试原请求。');}
    finally{setBusy(false);}
  }
  return <WorkbenchDrawer title="材料更新与核对" className="ontology-updates-drawer" canClose={!busy} close={close}>
    <div className="correction-toolbar maintenance-modes" role="group" aria-label="材料更新操作">
      <button disabled={busy||!!pending.current||!!error||!target} aria-pressed={!!ontology} onClick={()=>setOntology(target)}>抽取更新</button>
      <button disabled={busy||!!pending.current} aria-pressed={!ontology} onClick={()=>setOntology(undefined)}>更新校对草稿</button>
    </div>
    {ontology?<Suspense fallback={<p>正在读取重新抽取范围…</p>}><OntologyUpdates key={`${workspace}:${ontology}`} workspace={workspace} ontologyId={ontology} onBusy={setBusy}/></Suspense>:<section className="material-maintenance">
      <p>将旧校对草稿同步到最新已发布的实体与关系。仅处理没有人工修改的旧草稿；同步后可进入材料核对继续编辑，不会重新上传、抽取或发布。需要应用新规则时，请切换上方“抽取更新”。</p>
      {error&&<p role="alert">状态读取失败：{error}，下列状态可能不是最新。</p>}
      {failure&&<p role="alert" className="correction-error">{failure}</p>}{message&&<p role="status">{message}</p>}
      <div className="correction-toolbar"><button disabled={busy} onClick={()=>void refresh()}>刷新状态</button><button disabled={busy} aria-pressed={all} onClick={()=>setAll(!all)}>{all?'仅看待处理':'查看全部材料'}</button></div>
      <div className="correction-toolbar"><button disabled={busy||!!pending.current||!!error} onClick={()=>setSelected(Object.fromEntries(visible.filter(row=>row.can_reload).slice(0,20).map(row=>[row.document_id,row])))}>选择可同步的草稿</button><button disabled={busy||!!pending.current} onClick={()=>setSelected({})}>清空选择</button><span>已选 {selectedRows.length} / 20</span></div>
      {loading&&<p role="status">正在检查材料状态…</p>}
      {!loading&&!error&&!visible.length&&<p>当前范围没有待处理材料。</p>}
      {visible.map(row=><article className="maintenance-row" key={row.document_id}><div className="maintenance-heading"><label><input type="checkbox" checked={!!selected[row.document_id]} disabled={busy||!!pending.current||!!error||!row.can_reload||!selected[row.document_id]&&selectedRows.length>=20} onChange={event=>setSelected(previous=>{const next={...previous};if(event.target.checked)next[row.document_id]=row;else delete next[row.document_id];return next;})}/><strong>{row.name??'材料不可用'}</strong></label><span className="badge">{row.label}</span></div><p>{row.reason||'无需同步校对草稿。'}</p><button disabled={busy||!!pending.current||row.state==='unavailable'} onClick={()=>onReview(row.document_id)}>进入材料核对</button></article>)}
      <button className="primary maintenance-submit" disabled={busy||!!error||!pending.current&&!selectedRows.length} onClick={()=>void reload()}>{busy?'正在同步草稿…':pending.current?'重试草稿同步':'同步所选草稿到最新知识'}</button>
    </section>}
  </WorkbenchDrawer>;
}
