import { useMemo, useState } from 'react';
import type { OntologyDefinition } from '../ontology';
import PointLineGraph, {type NetworkLink} from './PointLineGraph';
import SpatialOntologyGraph from './SpatialOntologyGraph';
type Selection={kind:'entity'|'relation';name:string};

export default function OntologyRelationGraph({schema,selected,select,statusLabel='已发布定义',compact=false}:{schema:OntologyDefinition;selected:Selection;select:(value:Selection)=>void;statusLabel?:string;compact?:boolean}) {
  const [filter,setFilter]=useState('');
  const [view,setView]=useState<'focus'|'all'>('all');
  const [highlight,setHighlight]=useState<string>();
  const [focus,setFocus]=useState(selected.kind==='entity'?selected.name:'');
  const activeFilter=!compact&&schema.relation_types.some(item=>item.name===filter)?filter:'';
  const {nodes,links}=useMemo(()=>{
    const relations=activeFilter?schema.relation_types.filter(item=>item.name===activeFilter):schema.relation_types;
    const types=new Set(schema.entity_types.map(item=>item.name)),used=new Set<string>(),connections=new Map<string,NetworkLink>();
    for(const relation of relations)for(const source of new Set(relation.source_types))for(const target of new Set(relation.target_types)){
      if(!types.has(source)||!types.has(target))continue;
      used.add(source);used.add(target);
      if(source===target&&!compact)continue;
      const id=JSON.stringify([source,target].sort());
      if(!connections.has(id))connections.set(id,{source,target,relations:[]});
      const connection=connections.get(id)!;
      const bucket=connection.source===source?connection.relations:(connection.reverseRelations??=[]);
      bucket.push({id:relation.name,label:relation.label||relation.name});
    }
    return {nodes:schema.entity_types.filter(item=>!activeFilter||used.has(item.name)).map(item=>({id:item.name,label:item.label||item.name,type:item.name})),links:[...connections.values()]};
  },[schema,activeFilter,compact]);
  const focusedNode=nodes.find(node=>node.id===focus)??nodes[0];
  const visibleLinks=useMemo(()=>view==='all'?links:links.filter(link=>link.source===focusedNode?.id||link.target===focusedNode?.id),[links,view,focusedNode?.id]);
  const visibleNodes=useMemo(()=>{
    if(view==='all')return nodes;
    const visible=new Set(visibleLinks.flatMap(link=>[link.source,link.target]));
    if(focusedNode)visible.add(focusedNode.id);
    return nodes.filter(node=>visible.has(node.id));
  },[nodes,visibleLinks,view,focusedNode]);
  function chooseNode(name:string){setFocus(name);setHighlight(name);select({kind:'entity',name});}
  const Canvas=compact?PointLineGraph:SpatialOntologyGraph;
  return <section className="ontology-relation-graph" aria-label={`${statusLabel}关联图谱`}>
    {!compact&&<><div className="ontology-graph-toolbar"><div className="ontology-graph-filters"><label>展示范围<select aria-label="展示范围" value={view} onChange={event=>{setView(event.target.value as 'focus'|'all');setHighlight(undefined);}}><option value="all">全部关系视图</option><option value="focus">选中类型的直接关联</option></select></label>
      {view==='focus'&&<label>中心类型<select aria-label="中心类型" value={focusedNode?.id??''} disabled={!nodes.length} onChange={event=>chooseNode(event.target.value)}>{!nodes.length&&<option value="">暂无类型</option>}{nodes.map(node=><option key={node.id} value={node.id}>{node.label}（{node.id}）</option>)}</select></label>}
      <label>关系范围<select aria-label="关系范围" value={activeFilter} onChange={event=>{setFilter(event.target.value);if(event.target.value)select({kind:'relation',name:event.target.value});}}>
      <option value="">全部关系（{schema.relation_types.length}）</option>{schema.relation_types.map(item=><option key={item.name} value={item.name}>{item.label||item.name}（{item.name}）</option>)}</select></label>
      </div><small>显示 {visibleNodes.length} / {nodes.length} 个实体类型 · {visibleLinks.length} / {links.length} 条类型连接 · {statusLabel}</small></div>
    </>}
    {!compact&&view==='all'&&highlight&&<button type="button" onClick={()=>setHighlight(undefined)}>清除关联高亮</button>}
    {!schema.relation_types.length&&<p role="status">当前版本未定义关系，下面展示已有实体类型。</p>}
    {!compact&&!!nodes.length&&!visibleLinks.length&&!!schema.relation_types.length&&<p role="status">当前范围没有跨类型连线。同类型关系已省略回环，可在关系列表查看定义。</p>}
    <Canvas nodes={visibleNodes} links={visibleLinks} focusNode={view==='focus'?focusedNode?.id:undefined} labelMode={compact?'adaptive':'interaction'} selectedNode={view==='focus'?focusedNode?.id:highlight} selectedRelation={selected.kind==='relation'?selected.name:undefined}
      onNode={chooseNode} onRelation={name=>{setHighlight(undefined);select({kind:'relation',name});}}/>
  </section>;
}
