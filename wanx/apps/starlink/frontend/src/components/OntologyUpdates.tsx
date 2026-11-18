import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '../request';
import { startVisiblePolling } from '../polling';
import DocumentKnowledgeCorrections from './DocumentKnowledgeCorrections';
import {KnowledgeOutcome} from './ProcessingStatus';
import type {KnowledgeSummary} from '../processing';
import { embeddedHost } from '../nativeHost';
import HostedOntologyImpact from './HostedOntologyImpact';

type Row={document_id:string;name:string;preview_token:string;reasons:string[];protected:boolean;selectable:boolean;selection_reason?:string;effective_ontology_version:number|null;
  extraction_status:string;publication_status:string;graph_ready:boolean;text_index_ready:boolean;retrieval_ready:boolean;retry_job_id:string|null;error:string|null;outcome:KnowledgeSummary|null};
export type Impact={target:{id:string;name:string;version_number:number};previous_version:number|null;total:number;offset:number;limit:number;items:Row[];
  read_only?:boolean;
  batch_update_available?:boolean;
  changes:Array<{kind:string;name:string;change:string;before:unknown;after:unknown}>};
const labels:Record<string,string>={not_started:'尚未开始',queued:'排队中',running:'处理中',succeeded:'完成',failed:'失败',cancelled:'已取消',review:'待人工核对',published:'已发布'};

type Props={workspace:string;ontologyId:string;onBusy:(busy:boolean)=>void;onProcessMaterials?:(documentId?:string)=>void};
export default function OntologyUpdates(props:Props) {
  // Hosted clients use the registered read-only impact contract. The standalone
  // Web endpoints below are not authorized by the Bridge workbench contract.
  const host=embeddedHost();
  return host || new URLSearchParams(location.search).get('native')==='1'
    ? <HostedOntologyImpact workspace={props.workspace} ontologyId={props.ontologyId} onBusy={props.onBusy} onProcessMaterials={props.onProcessMaterials||(host?documentId=>host.importMaterials(window,documentId):undefined)} />
    : <StandaloneOntologyUpdates {...props} />;
}

function StandaloneOntologyUpdates({workspace,ontologyId,onBusy}:Props) {
  const [data,setData]=useState<Impact>(),[offset,setOffset]=useState(0),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [reviewOpen,setReviewOpen]=useState(false);
  const [scope,setScope]=useState<'selectable'|'all'>('selectable');
  const [selected,setSelected]=useState<Record<string,{document_id:string;preview_token:string;name:string}>>({});
  const alive=useRef(true),pending=useRef(false),sequence=useRef(0),reviewing=useRef(false);
  const sessionChange=useCallback((open:boolean)=>{reviewing.current=open;sequence.current++;setReviewOpen(open);},[]);
  const locked=busy||reviewOpen;
  const root=`/api/ontology-updates/${encodeURIComponent(ontologyId)}`;
  const refresh=useCallback(async()=>{
    if(reviewing.current)return;
    const run=++sequence.current;
    try {
      const result=await requestJson<Impact>(`${root}?workspace_id=${encodeURIComponent(workspace)}&offset=${offset}&scope=${scope}`,undefined,15000);
      if(alive.current&&!reviewing.current&&run===sequence.current){
        if(offset>0&&offset>=result.total){setOffset(Math.max(0,Math.ceil(result.total/20)-1)*20);return;}
        setData(result);setLoadError('');
      }
    }catch(reason){if(alive.current&&!reviewing.current&&run===sequence.current)setLoadError(reason instanceof Error?reason.message:'读取失败');}
  },[root,workspace,offset,scope]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>{if(!reviewOpen)return startVisiblePolling({refresh,delay:()=>5000,onError:()=>{}});},[refresh,reviewOpen]);
  useEffect(()=>{if(locked){onBusy(true);return ()=>onBusy(false);}},[locked,onBusy]);
  async function action(suffix:string,body:unknown) {
    if(pending.current||reviewing.current)return;
    pending.current=true;setBusy(true);setError('');setMessage('');
    try {
      await requestJson(`${root}/${suffix}?workspace_id=${encodeURIComponent(workspace)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},30000);
      if(!alive.current)return;
      setSelected({});setMessage('已提交所选材料，可在“全部材料与进度”查看处理进度。人工纠错材料仍需核对并确认发布。');await refresh();
    } catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'提交失败，请刷新核对');}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  const selection=Object.values(selected);
  function changeScope(next:'selectable'|'all'){
    if(locked||next===scope)return;
    sequence.current++;setScope(next);setOffset(0);setData(undefined);setSelected({});setLoadError('');
  }
  function confirmExtraction(){
    if(locked||!data||!!loadError||!selection.length)return;
    if(window.confirm(`按当前发布本体重新处理以下 ${selection.length} 份材料？\n${selection.map(s=>s.name).join('\n')}\n已有人工纠错仅生成待核对建议，发布仍需确认。`))void action('start',{confirmed:true,selections:selection.map(({document_id,preview_token})=>({document_id,preview_token}))});
  }
  return <section className="ontology-updates" aria-label="本体发布影响与材料更新">
    <div className="form-body">
      <div className="ontology-update-actions">
        <div className="ontology-table-actions" role="group" aria-label="重新抽取材料范围">
          <button disabled={locked} aria-pressed={scope==='selectable'} onClick={()=>changeScope('selectable')}>待重新抽取</button>
          <button disabled={locked} aria-pressed={scope==='all'} onClick={()=>changeScope('all')}>全部材料与进度</button>
          <button disabled={locked} onClick={()=>void refresh()}>刷新状态</button>
        </div>
        <div className="ontology-table-actions">
          <span>已选 {selection.length} / 20 份</span>
          <button className="primary" disabled={locked||!data||!selection.length||!!loadError} onClick={confirmExtraction}>{busy?'正在提交…':'重新抽取所选材料'}</button>
          <button disabled={locked||!selection.length} onClick={()=>setSelected({})}>清空选择</button>
        </div>
      </div>
      <p>使用规则：{data?`v${data.target.version_number} · ${data.target.name}`:'加载中…'}。勾选材料后点击上方“重新抽取所选材料”，无需重新上传。已有结果保留至新结果发布，人工修改先核对差异。</p>
      {loadError&&<p role="alert">{loadError}</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
      {data&&<>
        <details><summary>相对{data.previous_version?`上一发布版本 v${data.previous_version}`:'空规则'}的规则变化（{data.changes.length} 项）</summary>
          {!data.changes.length&&<p>规则定义没有变化。</p>}
          {data.changes.map(c=><div key={c.kind+c.name}><strong>{c.kind==='entity_types'?'实体':'关系'} {c.name} · {{added:'新增',removed:'删除',modified:'修改'}[c.change]}</strong>
            <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({原定义:c.before,新定义:c.after},null,2)}</pre></div>)}
        </details>
        <p>影响依据是建议来源和已有知识使用的类型；新增类型是否适用于旧正文仍需人工判断。正文不变时复用文本索引，新图谱在发布后参与检索。</p>
        {!data.total&&<p role="status">{scope==='selectable'?'没有待重新抽取的材料。已完成、处理中或待核对的材料，请切换“全部材料与进度”查看。':'当前知识库没有材料。'}</p>}
        {data.items.map(row=><article className="ontology-row" key={row.document_id}>
          <div style={{minWidth:0}}>{row.selectable?<label><input type="checkbox" checked={!!selected[row.document_id]} disabled={locked||!selected[row.document_id]&&selection.length>=20}
            onChange={e=>setSelected(previous=>{const next={...previous};if(e.target.checked)next[row.document_id]={document_id:row.document_id,preview_token:row.preview_token,name:row.name};else delete next[row.document_id];return next;})} /> {row.name}</label>:<><strong>{row.name}</strong><p className="ontology-selection-reason">{row.selection_reason||'暂不可重新抽取，请查看下方处理状态。'}</p></>}
            {row.reasons.map(reason=><p key={reason}>{reason}</p>)}
            <p>当前已发布知识使用的本体：{row.effective_ontology_version?`v${row.effective_ontology_version}`:'尚无发布结果'}。</p>
            <p>抽取：{labels[row.extraction_status]??row.extraction_status} · 图谱：{labels[row.publication_status]??row.publication_status} · 文本索引：{row.text_index_ready?'可复用':'未就绪或已失效'} · 新规则检索：{row.retrieval_ready?'已就绪':'尚未完成'}</p>
            {row.error&&<p role="alert">{row.error}</p>}
            {row.outcome&&<KnowledgeOutcome summary={row.outcome} />}
            {!row.text_index_ready&&<p>请在任务中心检查或重试文本索引任务；新规则检索就绪需要图谱和文本索引都可用。</p>}
            <div className="ontology-table-actions">
              {row.retry_job_id&&<button disabled={locked} onClick={()=>{if(window.confirm(`重试「${row.name}」的失败处理任务？`))void action('retry',{document_id:row.document_id,job_id:row.retry_job_id});}}>重试处理</button>}
              {row.protected&&<DocumentKnowledgeCorrections workspace={workspace} documentId={row.document_id} documentName={row.name} textEditing={locked} targetOntologyId={ontologyId} onSessionChange={sessionChange} />}
            </div>
          </div>
        </article>)}
        <div className="ontology-table-actions"><button disabled={locked||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</button><span>{offset/20+1}/{Math.max(1,Math.ceil(data.total/20))} 页 · {data.total} 份材料</span><button disabled={locked||offset+20>=data.total} onClick={()=>setOffset(offset+20)}>下一页</button></div>
      </>}
    </div>
  </section>;
}
