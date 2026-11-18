import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '../request';
import { startVisiblePolling } from '../polling';
import type { Impact } from './OntologyUpdates';

/** Bridge exposes selectable impact reads; extraction goes through confirmed conversation plans. */
export default function HostedOntologyImpact({workspace,ontologyId,onProcessMaterials}:{
  workspace:string;ontologyId:string;onProcessMaterials?:(documentId?:string)=>void;
}) {
  const [data,setData]=useState<Impact>(),[offset,setOffset]=useState(0),[error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const sequence=useRef(0),alive=useRef(false);
  const refresh=useCallback(async()=>{
    const run=++sequence.current;
    setLoading(true);
    try {
      const query=new URLSearchParams({workspace_id:workspace,scope:'selectable',offset:String(offset)});
      const result=await requestJson<Impact>(`/api/ontology-updates/${encodeURIComponent(ontologyId)}?${query}`,undefined,15000);
      if(!alive.current||run!==sequence.current)return;
      if(offset>0&&offset>=result.total){setOffset(Math.max(0,Math.ceil(result.total/20)-1)*20);return;}
      setData(result);setError('');
    } catch(reason) {
      if(alive.current&&run===sequence.current)setError(reason instanceof Error?reason.message:'读取失败，请重试');
    } finally {if(alive.current&&run===sequence.current)setLoading(false);}
  },[workspace,ontologyId,offset]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>startVisiblePolling({refresh,delay:()=>15000,onError:()=>{}}),[refresh]);
  function page(next:number){sequence.current++;setData(undefined);setError('');setLoading(true);setOffset(next);}
  return <section className="ontology-updates" aria-label="本体发布影响与材料更新">
    <div className="form-body">
      <div className="ontology-table-actions">
        <strong>待重新抽取的材料</strong>
        <button disabled={loading} onClick={()=>void refresh()}>刷新状态</button>
        {onProcessMaterials&&<button onClick={()=>onProcessMaterials()}>打开资料库</button>}
      </div>
      <p>打开受影响的材料后，可以核对正文、适用规则和处理计划，再确认重新抽取。</p>
      <p>全部材料的处理进度可在对话中逐份查看。已有知识保留至新结果核对发布，规则发布不会自动重抽历史材料。</p>
      <p>使用规则：{data?`v${data.target.version_number} · ${data.target.name}`:error?'暂未读取成功':loading?'加载中…':'尚未读取'}{data&&error?'（上次读取结果，待刷新）':''}</p>
      {error&&<p role="alert">{error}</p>}
      {loading&&<p role="status">正在读取材料影响…</p>}
      {data&&<>
        <details><summary>规则变化（{data.changes.length} 项）</summary>
          {!data.changes.length&&<p>规则定义没有变化。</p>}
          {data.changes.map(c=><p key={`${c.kind}:${c.name}`}>{c.kind==='entity_types'?'实体类型':'关系类型'} · {c.name} · {{added:'新增',removed:'删除',modified:'修改'}[c.change]||c.change}</p>)}
        </details>
        {!data.total&&<p role="status">当前没有待重新抽取的材料。已处理、处理中或待核对的材料，请返回对话查看进度。</p>}
        {data.items.map(row=><article className="ontology-row" key={row.document_id}>
          <div><strong>{row.name}</strong>
            {row.reasons.map(reason=><p key={reason}>{reason}</p>)}
            <p>当前材料知识使用的本体：{row.effective_ontology_version!=null?`v${row.effective_ontology_version}`:'尚无发布结果'}。</p>
            {!data.read_only&&row.selection_reason&&<p>{row.selection_reason}</p>}
            {row.error&&<p role="alert">{row.error}</p>}
          </div>
          {onProcessMaterials&&<button disabled={!!error} onClick={()=>onProcessMaterials(row.document_id)}>打开这份资料</button>}
        </article>)}
      </>}
      <div className="ontology-table-actions">
        <button disabled={loading||offset===0} onClick={()=>page(Math.max(0,offset-20))}>上一页</button>
        {data&&<span>{offset/20+1}/{Math.max(1,Math.ceil(data.total/20))} 页 · {data.total} 份材料</span>}
        <button disabled={loading||!!error||!data||offset+20>=data.total} onClick={()=>page(offset+20)}>下一页</button>
      </div>
    </div>
  </section>;
}
