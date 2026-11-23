import {useEffect,useState} from 'react';
import {requestJson} from '../request';
import {bridgeHosted,embeddedHost} from '../nativeHost';
import {graphUrl,readGraphSources,type GraphResult,type GraphSources} from '../graphTransport';
import {instancePage} from '../graphExploration';
import {nodeId,edgeId,sourceLabel,detectionNotice,type GraphEdge} from '../graph';
import StarxiaotuTerm from './StarxiaotuTerm';
import {InstanceProperties} from './KnowledgeInstanceView';

function InstanceSources({edge,active}:{edge:GraphEdge;active:boolean}) {
  const [sources,setSources]=useState<GraphSources>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const host=embeddedHost();
  const owner=bridgeHosted();
  const id=edgeId(edge);
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    setSources(undefined);setError('');setBusy(true);
    readGraphSources(requestJson,'default',owner,edge,0,controller.signal).then(result=>{
      if(!controller.signal.aborted)setSources(result);
    }).catch(reason=>{
      if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取关系来源失败');
    }).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[edge,id,active,owner]);
  if(!active)return null;
  return <div className="rules-instance-sources">
    {busy&&<p role="status">正在核对来源…</p>}
    {error&&<p role="alert">{error}</p>}
    {detectionNotice(sources?.detection)&&<p role="status">{detectionNotice(sources?.detection)}</p>}
    {sources&&!sources.items.length&&<p className="muted">当前没有可查看的来源片段。</p>}
    {sources?.items.map(source=>{
      const version=source.document_version_id||source.version_id;
      let location='来源片段';
      try { location=sourceLabel(JSON.parse(source.locator_json)); } catch { /* older locators may be absent */ }
      return <article key={source.id}>
        <div><small>{location}</small>
          {host&&version&&source.segment_id
            ? <button type="button" onClick={()=>host.openSource(window,source.document_id,version,source.segment_id)}>定位原文</button>
            : !owner ? <a href={`/api/documents/${encodeURIComponent(source.document_id)}/original`} target="_blank" rel="noreferrer">打开原文</a> : null}</div>
        <p>{source.excerpt||'暂无可展示的摘录。'}</p>
      </article>;
    })}
  </div>;
}

export default function OntologyInstances({type,label,kind='entity',active,relationLabels}:{
  type:string;label:string;kind?:'entity'|'relation';active:boolean;relationLabels:Record<string,string>
}){
  const [result,setResult]=useState<GraphResult|null>(null),[error,setError]=useState(''),[page,setPage]=useState(0),[epoch,setEpoch]=useState(0);
  const [expanded,setExpanded]=useState('');
  const owner=bridgeHosted();
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();setResult(null);setError('');setPage(0);setExpanded('');
    requestJson<GraphResult>(graphUrl('default',owner,undefined,500,true),{signal:controller.signal},20000).then(value=>{if(!controller.signal.aborted)setResult(value);})
      .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取实例失败');});
    return()=>controller.abort();
  },[owner,epoch,active]);
  useEffect(()=>{setPage(0);setExpanded('');},[type,kind]);
  useEffect(()=>{
    const refresh=()=>{setResult(null);setEpoch(value=>value+1);};
    window.addEventListener('starlink:graph-changed',refresh);
    return()=>window.removeEventListener('starlink:graph-changed',refresh);
  },[]);
  if(!active)return null;
  const current=instancePage(result?.nodes||[],type,page);
  const relations=(result?.edges||[]).filter(edge=>edge.relation_type===type);
  const count=kind==='entity'?current.total:relations.length;
  const pages=kind==='entity'?current.pages:Math.max(1,Math.ceil(relations.length/5));
  const activePage=Math.min(page,pages-1);
  const name=(id:string)=>result?.nodes.find(node=>nodeId(node)===id)?.canonical_name||'关联实体';
  const fact=(edge:GraphEdge)=>`${name(edge.subject_entity_id)} → ${relationLabels[edge.relation_type]||edge.relation_type} → ${name(edge.object_entity_id)}`;
  function relation(edge:GraphEdge){
    const id=edgeId(edge);
    return <div className="rules-instance-row" key={id}>
      <button type="button" aria-expanded={expanded===id} onClick={()=>setExpanded(expanded===id?'':id)}><span>{fact(edge)}</span><small>查看来源</small></button>
      {expanded===id&&<InstanceSources edge={edge} active />}
    </div>;
  }
  return <section className="instance-detail-bottom rules-instances" aria-label="类型实例列表">
    <div className="section-title"><h3>{kind==='entity'?'资料中的实例':'资料中的关系'}<StarxiaotuTerm name={kind==='entity'?'instance':'relation'} /></h3><button onClick={()=>setEpoch(value=>value+1)}>刷新实例</button></div>
    {error?<p role="alert">{error}</p>:!result?<p role="status">正在读取实例…</p>:<>
      <p className="muted">{label} · 当前图谱范围 {count} 条。<span> 仅显示已发布知识。</span></p>
      {kind==='entity'?current.items.map(node=>{
        const id=nodeId(node);
        const links=result.edges.filter(edge=>edge.subject_entity_id===id||edge.object_entity_id===id).slice(0,3);
        return <details className="ontology-instance rules-instance-row" key={id}><summary>{node.canonical_name}</summary>
          <InstanceProperties node={node}/>
          {links.length>0&&<><p className="muted">关联及出处</p>{links.map(relation)}</>}
        </details>;
      }):relations.slice(activePage*5,activePage*5+5).map(relation)}
      {!count&&<p className="empty">当前读取范围内没有此类型的已发布实例。</p>}
      {pages>1&&<nav className="instance-pagination" aria-label="实例分页"><button disabled={!activePage} onClick={()=>{setExpanded('');setPage(activePage-1);}}>上一页</button><span>{activePage+1} / {pages} 页</span><button disabled={activePage+1>=pages} onClick={()=>{setExpanded('');setPage(activePage+1);}}>下一页</button></nav>}
    </>}
  </section>;
}
