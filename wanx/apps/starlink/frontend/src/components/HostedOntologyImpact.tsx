import {useCallback,useEffect,useRef,useState} from 'react';
import {requestJson,RequestError} from '../request';
import {startVisiblePolling} from '../polling';
import {newOntologyOperationId} from '../ontologySuggestions';
import type {Impact} from './OntologyUpdates';

type Choice = {document_id:string;preview_token:string;name:string;protected:boolean};
type Batch = {operationId:string;materials:Choice[]};

export default function HostedOntologyImpact({workspace,ontologyId,onProcessMaterials,onBusy}:{
  workspace:string;ontologyId:string;onProcessMaterials?:(documentId?:string)=>void;onBusy:(busy:boolean)=>void;
}) {
  const [data,setData]=useState<Impact>(),[offset,setOffset]=useState(0),[error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [selected,setSelected]=useState<Record<string,Choice>>({});
  const [batch,setBatch]=useState<Batch>();
  const [submitting,setSubmitting]=useState(false),[uncertain,setUncertain]=useState(false);
  const [feedback,setFeedback]=useState<{text:string;error?:boolean}>();
  const sequence=useRef(0),alive=useRef(false),inFlight=useRef(false);
  const root=`/api/ontology-updates/${encodeURIComponent(ontologyId)}`;
  const refresh=useCallback(async()=>{
    const run=++sequence.current;
    setLoading(true);
    try {
      const query=new URLSearchParams({workspace_id:workspace,scope:'selectable',offset:String(offset)});
      const result=await requestJson<Impact>(`${root}?${query}`,undefined,15000);
      if(!alive.current||run!==sequence.current)return;
      if(offset>0&&offset>=result.total){setOffset(Math.max(0,Math.ceil(result.total/20)-1)*20);return;}
      setData(result);setError('');
      setSelected(previous=>{
        const obsolete=result.items.filter(row=>previous[row.document_id] &&
          (!row.selectable||previous[row.document_id].preview_token!==row.preview_token));
        if(!obsolete.length)return previous;
        const next={...previous};
        for(const row of obsolete)delete next[row.document_id];
        return next;
      });
    } catch(reason) {
      if(alive.current&&run===sequence.current)setError(reason instanceof Error?reason.message:'读取失败，请重试');
    } finally {if(alive.current&&run===sequence.current)setLoading(false);}
  },[root,workspace,offset]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>{if(!batch)return startVisiblePolling({refresh,delay:()=>15000,onError:()=>{}});},[refresh,batch]);
  useEffect(()=>{if(submitting){onBusy(true);return ()=>onBusy(false);}},[submitting,onBusy]);
  const selection=Object.values(selected);
  const canBatch=data?.batch_update_available===true && !data.read_only;

  function page(next:number){sequence.current++;setData(undefined);setLoading(true);setOffset(next);}

  async function submit(){
    if(!batch||inFlight.current)return;
    inFlight.current=true;setSubmitting(true);setFeedback(undefined);
    try {
      const result=await requestJson<{items:unknown[]}>(`${root}/start`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({operation_id:batch.operationId,confirmed:true,
          selections:batch.materials.map(({document_id,preview_token})=>({document_id,preview_token}))}),
      },30000);
      if(!alive.current)return;
      if(!Array.isArray(result?.items)||result.items.length!==batch.materials.length) {
        throw new Error('批量处理回执不完整');
      }
      setSelected({});setBatch(undefined);setUncertain(false);
      setFeedback({text:`已提交 ${result.items.length} 份资料，可在处理任务中查看进度。`});
      await refresh();
    } catch(reason) {
      if(!alive.current)return;
      const failure=reason instanceof RequestError?reason:undefined;
      const retryable=!failure?.status||failure.status>=500||[408,429].includes(failure.status);
      setUncertain(retryable);
      setFeedback({text:retryable?'提交结果待确认。可以继续查询这次提交，系统会沿用同一操作。'
        :failure.message||'提交失败，请刷新后重新核对资料。',error:true});
      if(!retryable){setBatch(undefined);setSelected({});await refresh();}
    } finally {
      inFlight.current=false;
      if(alive.current)setSubmitting(false);
    }
  }

  return <section className="ontology-updates rules-material-impact" aria-label="本体发布影响与材料更新">
    <div className="ontology-table-actions rules-material-toolbar">
      <strong>待重新抽取的资料</strong>
      <button disabled={loading||!!batch} onClick={()=>void refresh()}>刷新状态</button>
      {onProcessMaterials&&<button disabled={submitting} onClick={()=>onProcessMaterials()}>打开资料库</button>}
    </div>
    <div className="rules-update-intro">
      <p>使用规则 {data?`v${data.target.version_number} · ${data.target.name}`:error?'暂未读取成功':'正在读取…'}</p>
      <p className="muted">规则已发布。现有知识保留到新结果发布，已有人工修订的资料需要核对差异。</p>
      {data&&!canBatch&&<p className="muted">当前盒端可查看影响。请打开资料逐份确认处理计划。</p>}
    </div>
    {error&&<p role="alert">{error}</p>}
    {feedback&&<p role={feedback.error?'alert':'status'}>{feedback.text}</p>}
    {loading&&!data&&<p role="status">正在读取资料影响…</p>}
    {data&&<>
      <details className="rules-definition-source"><summary>规则变化（{data.changes.length} 项）</summary>
        {!data.changes.length&&<p>规则定义没有变化。</p>}
        {data.changes.map(c=><p key={c.kind+c.name}>{c.kind==='entity_types'?'实体类型':'关系类型'} · {c.name} · {{added:'新增',removed:'删除',modified:'修改'}[c.change]||c.change}</p>)}
      </details>
      {canBatch&&<div className="rules-material-selection">
        <strong>已选 {selection.length} / 20 份</strong>
        <button disabled={!selection.length||!!batch} onClick={()=>setSelected({})}>清空</button>
        <button className="primary" disabled={!selection.length||loading||!!error||!!batch} onClick={()=>{
          sequence.current++;setFeedback(undefined);
          setBatch({operationId:newOntologyOperationId(),materials:selection});
        }}>核对所选资料</button>
      </div>}
      {batch&&<div className="rules-batch-confirm" aria-label="核对重新抽取范围">
        <h3>按 v{data.target.version_number} 重新抽取 {batch.materials.length} 份资料</h3>
        <ul>{batch.materials.map(row=><li key={row.document_id}>{row.name}{row.protected&&' · 有人工修订'}</li>)}</ul>
        <div className="ontology-table-actions">
          <button disabled={submitting} onClick={()=>{setBatch(undefined);setUncertain(false);}}>返回清单</button>
          <button type="button" className="primary" disabled={submitting} onClick={()=>void submit()}>
            {submitting?'正在提交…':uncertain?'核对提交结果':'确认重新抽取'}</button>
        </div>
      </div>}
      {!data.total&&<p role="status">当前没有待重新抽取的资料。</p>}
      {data.items.map(row=><article className="ontology-row rules-material-row" key={row.document_id}>
        <div>
          {canBatch&&row.selectable?<label><input type="checkbox" checked={!!selected[row.document_id]}
            disabled={!!batch||!!error||!selected[row.document_id]&&selection.length>=20}
            onChange={event=>{const checked=event.target.checked;setSelected(previous=>{
              const next={...previous};
              if(checked)next[row.document_id]={document_id:row.document_id,name:row.name,preview_token:row.preview_token,protected:row.protected};
              else delete next[row.document_id];
              return next;
            });}}/><strong>{row.name}</strong></label>:<strong>{row.name}</strong>}
          <p>当前知识使用的规则 {row.effective_ontology_version!=null?`v${row.effective_ontology_version}`:'尚无发布结果'}</p>
          {row.reasons.map(reason=><p key={reason}>{reason}</p>)}
          {canBatch&&!row.selectable&&row.selection_reason&&<p>{row.selection_reason}</p>}
          {row.error&&<p role="alert">{row.error}</p>}
        </div>
        {onProcessMaterials&&<button disabled={!!error||!!batch} onClick={()=>onProcessMaterials(row.document_id)}>打开这份资料</button>}
      </article>)}
      <nav className="ontology-table-actions rules-material-pages" aria-label="资料影响分页">
        <button disabled={loading||!!batch||offset===0} onClick={()=>page(Math.max(0,offset-20))}>上一页</button>
        <span>{offset/20+1}/{Math.max(1,Math.ceil(data.total/20))} 页 · {data.total} 份</span>
        <button disabled={loading||!!batch||!!error||offset+20>=data.total} onClick={()=>page(offset+20)}>下一页</button>
      </nav>
    </>}
  </section>;
}
