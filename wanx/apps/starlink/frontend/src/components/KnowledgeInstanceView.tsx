import {useEffect,useMemo,useState} from 'react';
import PointLineGraph from './PointLineGraph';
import {requestJson} from '../request';
import {bridgeHosted} from '../nativeHost';
import {graphUrl,type GraphResult} from '../graphTransport';
import {readNeighborhood,instanceLinks,type Neighborhood} from '../graphExploration';
import {nodeId,edgeId,graphProperties,type GraphNode} from '../graph';
import type {OntologyDefinition} from '../ontology';

export function InstanceProperties({node}:{node:GraphNode}){
  const properties=graphProperties(node.properties_json);
  return <dl className="instance-properties"><div><dt>名称</dt><dd>{node.canonical_name}</dd></div><div><dt>类型</dt><dd>{node.entity_type}</dd></div>
    {properties.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}

export default function KnowledgeInstanceView({schema}:{schema:OntologyDefinition}){
  const [graph,setGraph]=useState<GraphResult|null>(null),[error,setError]=useState(''),[epoch,setEpoch]=useState(0);
  const [root,setRoot]=useState<string|null>(null),[hops,setHops]=useState(1),[selectedEdge,setSelectedEdge]=useState<string>();
  const [neighborhood,setNeighborhood]=useState<(Neighborhood&{root:string;hops:number;epoch:number})|null>(null),[neighborError,setNeighborError]=useState('');
  const owner=bridgeHosted();
  useEffect(()=>{
    const controller=new AbortController();setGraph(null);setError('');setRoot(null);setSelectedEdge(undefined);
    requestJson<GraphResult>(graphUrl('default',owner,undefined,120,true),{signal:controller.signal},20000).then(result=>{
      if(!controller.signal.aborted)setGraph(result);
    }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'读取实例失败');});
    return()=>controller.abort();
  },[owner,epoch]);
  useEffect(()=>{const refresh=()=>{setNeighborhood(null);setEpoch(value=>value+1);};window.addEventListener('starlink:graph-changed',refresh);return()=>window.removeEventListener('starlink:graph-changed',refresh);},[]);
  useEffect(()=>{
    const controller=new AbortController();setNeighborhood(null);setNeighborError('');
    if(root)readNeighborhood(requestJson,'default',owner,root,hops,controller.signal).then(result=>{
      if(!controller.signal.aborted)setNeighborhood({...result,root,hops,epoch});
    }).catch(reason=>{if(!controller.signal.aborted)setNeighborError(reason instanceof Error?reason.message:'读取关联失败');});
    return()=>controller.abort();
  },[owner,root,hops,epoch]);
  const labels=useMemo(()=>Object.fromEntries(schema.relation_types.map(r=>[r.name,r.label])),[schema]);
  const nodes=useMemo(()=>graph?.nodes.map(n=>({id:nodeId(n),label:n.canonical_name,type:n.entity_type}))||[],[graph]);
  const links=useMemo(()=>instanceLinks(graph?.edges||[],labels),[graph,labels]);
  const current=neighborhood?.root===root&&neighborhood.hops===hops&&neighborhood.epoch===epoch?neighborhood:null;
  const relatedNodes=useMemo(()=>current?.nodes.map(n=>({id:nodeId(n),label:n.canonical_name,type:n.entity_type}))||[],[current]);
  const relatedLinks=useMemo(()=>instanceLinks(current?.edges||[],labels),[current,labels]);
  const selected=current?.nodes.find(n=>nodeId(n)===root),edge=current?.edges.find(e=>edgeId(e)===selectedEdge);
  const choose=(id:string)=>{setRoot(id);setSelectedEdge(undefined);};
  const chooseEdge=(id:string)=>{const e=graph?.edges.find(e=>edgeId(e)===id);if(e){setRoot(e.subject_entity_id);setSelectedEdge(id);}};
  return <div className="graph-layout instance-explorer">
    <section className="knowledge-card graph-canvas"><div className="section-title"><h2>实例图谱</h2><div className="graph-toolbar"><span>{graph?`${graph.nodes.length} 个实例 · ${graph.edges.length} 条关系`:error?'读取失败':'正在读取…'}</span><button onClick={()=>setEpoch(value=>value+1)}>刷新</button></div></div>
      <p className="muted">展示已确认发布的知识实例。当前图谱为有限范围，点击实例可继续查看属性和 1–3 跳关联。</p>
      {error?<p role="alert">{error}</p>:!graph?<p role="status">正在读取实例图谱…</p>:!nodes.length?<div className="sigma-graph-empty">当前没有可显示的已发布实例。材料确认发布后会显示在这里。</div>:<PointLineGraph nodes={nodes} links={links} selectedNode={root||undefined} selectedRelation={selectedEdge} onNode={choose} onRelation={chooseEdge}/>}
    </section>
    <aside className="knowledge-card instance-detail-split">
      <section className="instance-detail-top" aria-label="实例属性"><h2>实例属性</h2>{selected?<><strong>{selected.canonical_name}</strong><InstanceProperties node={selected}/></>:<p className="empty">{root?neighborError||'正在读取当前实例属性…':'点击左侧实例查看属性。'}</p>}</section>
      <section className="instance-detail-bottom" aria-label="实例关联"><div className="section-title"><h2>实例关联</h2><label>关联层数 <select aria-label="关联层数" value={hops} onChange={e=>setHops(Number(e.target.value))}>{[1,2,3].map(n=><option key={n} value={n}>{n} 跳</option>)}</select></label></div>
        {!root?<p className="empty">选择实例后查看连接图谱。</p>:neighborError?<p role="alert">{neighborError}。请刷新重试。</p>:!current?<p role="status">正在逐层读取关联实例…</p>:<>
          <p className="muted">{current.nodes.length} 个实例 · {current.edges.length} 条关系 · {hops} 跳范围（按连接距离展开，箭头保留关系方向）</p>
          {current.limited&&<p role="status">已达到本次读取上限，当前展示部分关联。可点击关联实例继续查看其邻域。</p>}
          <div className="instance-mini-graph"><PointLineGraph nodes={relatedNodes} links={relatedLinks} selectedNode={root} selectedRelation={selectedEdge} onNode={choose} onRelation={setSelectedEdge}/></div>
          {!current.edges.length&&<p className="muted">当前读取范围内没有关联关系。</p>}
          {edge&&<details className="instance-edge-detail" open><summary>{labels[edge.relation_type]||edge.relation_type} · 属性与来源</summary><dl className="instance-properties">{graphProperties(edge.properties_json).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>{edge.evidence.map(e=><blockquote key={e.id}><p>{e.excerpt}</p><small>材料 {e.document_id} · 片段 {e.segment_id}</small></blockquote>)}{!edge.evidence.length&&<p>暂无来源摘录。</p>}</details>}
        </>}
      </section>
    </aside>
  </div>;
}
