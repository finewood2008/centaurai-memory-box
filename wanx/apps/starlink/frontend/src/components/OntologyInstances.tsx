import {useEffect,useState} from 'react';
import {requestJson} from '../request';
import {bridgeHosted} from '../nativeHost';
import {graphUrl,type GraphResult} from '../graphTransport';
import {instancePage} from '../graphExploration';
import {nodeId,edgeId} from '../graph';
import type {DialogueTarget} from '../ontologyDialogue';
import {InstanceProperties} from './KnowledgeInstanceView';

export default function OntologyInstances({type,label,kind='entity',onDiscuss,disabled=false}:{type:string;label:string;kind?:'entity'|'relation';onDiscuss?:(target:DialogueTarget)=>void;disabled?:boolean}){
  const [result,setResult]=useState<GraphResult|null>(null),[error,setError]=useState(''),[page,setPage]=useState(0),[epoch,setEpoch]=useState(0);
  const owner=bridgeHosted();
  useEffect(()=>{
    const controller=new AbortController();setResult(null);setError('');setPage(0);
    requestJson<GraphResult>(graphUrl('default',owner,undefined,500,true),{signal:controller.signal},20000).then(value=>{if(!controller.signal.aborted)setResult(value);})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取实例失败');});
    return()=>controller.abort();
  },[owner,epoch]);
  useEffect(()=>{setPage(0);},[type,kind]);
  useEffect(()=>{const refresh=()=>{setResult(null);setEpoch(value=>value+1);};window.addEventListener('starlink:graph-changed',refresh);return()=>window.removeEventListener('starlink:graph-changed',refresh);},[]);
  const current=instancePage(result?.nodes||[],type,page);
  const relations=(result?.edges||[]).filter(edge=>edge.relation_type===type);
  const pages=kind==='entity'?current.pages:Math.max(1,Math.ceil(relations.length/5));
  const activePage=Math.min(page,pages-1);
  const name=(id:string)=>result?.nodes.find(node=>nodeId(node)===id)?.canonical_name||id;
  return <section className="instance-detail-bottom" aria-label="类型实例列表"><div className="section-title"><h2>{label}的实例</h2><button onClick={()=>setEpoch(value=>value+1)}>刷新实例</button></div>
    <p className="muted">仅显示当前图谱读取范围内的已发布实例，每页 5 条；数量不代表全仓实例总数。</p>
    {error?<p role="alert">{error}</p>:!result?<p role="status">正在读取实例…</p>:<><p>当前范围匹配 {kind==='entity'?current.total:relations.length} 个实例</p>
      {kind==='entity'?current.items.map(node=><details className="ontology-instance" key={nodeId(node)}><summary>{node.canonical_name}</summary><InstanceProperties node={node}/>{onDiscuss&&<button disabled={disabled} onClick={()=>onDiscuss({scope:'facts',kind:'entity',id:nodeId(node),label:node.canonical_name})}>查看此知识的对话调整能力</button>}</details>):relations.slice(activePage*5,activePage*5+5).map(edge=><details className="ontology-instance" key={edgeId(edge)}><summary>{name(edge.subject_entity_id)} → {label} → {name(edge.object_entity_id)}</summary><p>当前已读取 {edge.evidence.length} 条来源证据；不代表完整来源。</p>{onDiscuss&&<button disabled={disabled} onClick={()=>onDiscuss({scope:'facts',kind:'relation',id:edgeId(edge),label:`${name(edge.subject_entity_id)} → ${label} → ${name(edge.object_entity_id)}`})}>查看此关系的对话调整能力</button>}</details>)}
      {!(kind==='entity'?current.total:relations.length)&&<p className="empty">当前读取范围内没有此类型的已发布实例。</p>}
      <nav className="instance-pagination" aria-label="实例分页"><button disabled={!activePage} onClick={()=>setPage(activePage-1)}>上一页</button><span>{activePage+1} / {pages} 页</span><button disabled={activePage+1>=pages} onClick={()=>setPage(activePage+1)}>下一页</button></nav>
    </>}
  </section>;
}
