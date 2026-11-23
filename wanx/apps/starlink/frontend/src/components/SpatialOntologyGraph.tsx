import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {createGraphMotion} from '../../../ui/graph-motion.mjs';
import {ontologySpatialGraph} from '../ontologySpatialGraph';
import type {NetworkNode,NetworkLink} from './PointLineGraph';

const colors=['#a65d43','#587f71','#af873f','#627e92','#8b708c','#897961'];
const short=(text:string)=>Array.from(text).length>16?Array.from(text).slice(0,15).join('')+'…':text;
const color=(type:string)=>{let hash=0;for(const c of type)hash=(hash*31+c.codePointAt(0)!)>>>0;return colors[hash%colors.length];};
type Props={nodes:NetworkNode[];links:NetworkLink[];selectedNode?:string;selectedRelation?:string;focusNode?:string;labelMode?:'adaptive'|'interaction';onNode:(id:string)=>void;onRelation:(id:string)=>void};

/** Read-only ontology canvas. Selection callbacks remain owned by the existing catalog. */
export default function SpatialOntologyGraph({nodes,links,selectedNode,selectedRelation,focusNode,onNode,onRelation}:Props) {
  const canvas=useRef<SVGSVGElement>(null),scope=useId();
  const zoomOutput=useRef<HTMLOutputElement>(null);
  const marker=scope.replace(/[^a-zA-Z0-9_-]/g,'')+'-ontology-arrow';
  const motion=useMemo(()=>createGraphMotion({getSvg:()=>canvas.current,getZoomOutput:()=>zoomOutput.current}),[]);
  const [pair,setPair]=useState<string>();
  const graph=useMemo(()=>ontologySpatialGraph(nodes,links,focusNode),[nodes,links,focusNode]);
  const sizeBy=useMemo(()=>({counts:new Map(graph.nodes.map(n=>[n.id,{relations:n.degree}])),metric:'relations' as const,max:Math.max(1,...graph.nodes.map(n=>n.degree))}),[graph]);
  const activePair=links.find(link=>JSON.stringify([link.source,link.target])===pair);
  const nodeName=(id:string)=>nodes.find(node=>node.id===id)?.label||id;
  useEffect(()=>()=>motion.reset(),[motion]);
  useEffect(()=>setPair(undefined),[nodes,links]);
  useLayoutEffect(()=>{
    if(!nodes.length){motion.reset();return;}
    motion.schedule(graph,scope,sizeBy);
  },[motion,graph,scope,sizeBy,selectedNode,selectedRelation,pair,nodes.length]);
  const chooseNode=(id:string)=>{setPair(undefined);onNode(id);};
  return <div className="point-line-graph ontology-spatial-graph network-labels-interaction">
    <div className="network-tools"><small>立体视图 · 拖动空白旋转 · Shift 拖动平移 · 滚轮缩放</small><div>
      <button type="button" aria-label="向左旋转本体图谱" onClick={()=>motion.rotate(-.32)}>↶</button>
      <button type="button" aria-label="向右旋转本体图谱" onClick={()=>motion.rotate(.32)}>↷</button>
      <button type="button" aria-label="缩小图谱" onClick={()=>motion.zoom(1/1.2)}>−</button>
      <output ref={zoomOutput} data-graph-zoom="" aria-label="本体图谱缩放比例">100%</output>
      <button type="button" aria-label="放大图谱" onClick={()=>motion.zoom(1.2)}>＋</button>
      <button type="button" onClick={()=>motion.fit()}>重置视图</button>
    </div></div>
    {!nodes.length?<p className="empty">当前范围没有可显示的实体。</p>:<svg ref={canvas} className="network-canvas" viewBox="0 0 920 560" role="group" aria-label="本体类型与关系，立体视图">
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a58d77"/></marker></defs>
      <g className="graph-space-floor" aria-hidden="true"/>
      <g className="graph-space-links">{links.map(link=>{
        const id=JSON.stringify([link.source,link.target]),reverse=link.reverseRelations??[];
        const bidirectional=link.source!==link.target&&reverse.length>0;
        const forwardLabel=link.relations.map(r=>r.label).join('、'),reverseLabel=reverse.map(r=>r.label).join('、');
        const description=`${nodeName(link.source)} → ${forwardLabel} → ${nodeName(link.target)}${bidirectional?` \\ ${nodeName(link.target)} → ${reverseLabel} → ${nodeName(link.source)}`:''}`;
        const active=pair===id,related=selectedNode&&(link.source===selectedNode||link.target===selectedNode);
        const choose=()=>{setPair(id);onRelation(link.relations[0].id);};
        return <g key={id} className={`network-link${active?' selected chosen':''}${related?' related':''}${selectedNode&&!related?' muted':''}`} role="button" tabIndex={0} aria-label={description}
          onClick={choose} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}}}>
          <title>{description}</title><path className="network-edge-hit graph-edge-hit" data-edge={id}/>
          <path className="network-edge-line" markerStart={bidirectional?`url(#${marker})`:undefined} markerEnd={`url(#${marker})`}/>
          <text className="graph-edge-label" textAnchor="middle" y="-7">{bidirectional?`${short(forwardLabel)} \\ ${short(reverseLabel)}`:short(link.relations.length===1?link.relations[0].label:`${link.relations[0].label} 等 ${link.relations.length} 种关系`)}</text>
        </g>;
      })}</g>
      <g className="graph-space-nodes">{graph.nodes.map(node=><g key={node.id} className={`network-node graph-node${node.id===selectedNode?' selected':''}`} role="button" tabIndex={0} data-node={node.id}
        aria-label={`实体：${node.name}（${node.type}）`} style={{'--type-color':color(node.type!)} as CSSProperties}
        onClick={()=>chooseNode(node.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();chooseNode(node.id);}}}>
        <title>{node.name}（{node.type}）</title><circle className="node-star-hit" r="14"/><circle className="node-star-glow" r="18"/><circle className="node-star" r="9"/>
        <text className="node-name">{node.lines.map((line,i)=><tspan key={i} x="0" dy={i?15:0}>{line}</tspan>)}</text>
      </g>)}</g>
    </svg>}
    {activePair&&<div className="network-relations"><strong>{nodeName(activePair.source)} → {nodeName(activePair.target)}</strong>{activePair.relations.map(relation=><button type="button" key={relation.id} aria-pressed={relation.id===selectedRelation} onClick={()=>onRelation(relation.id)}>{relation.label}</button>)}
      {!!activePair.reverseRelations?.length&&<><strong>\ {nodeName(activePair.target)} → {nodeName(activePair.source)}</strong>{activePair.reverseRelations.map(relation=><button type="button" key={`reverse:${relation.id}`} aria-pressed={relation.id===selectedRelation} onClick={()=>onRelation(relation.id)}>{relation.label}</button>)}</>}
    </div>}
  </div>;
}
