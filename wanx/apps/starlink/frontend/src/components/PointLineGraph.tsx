import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MultiGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
export type NetworkNode={id:string;label:string;type:string};
export type NetworkLink={source:string;target:string;relations:Array<{id:string;label:string}>;reverseRelations?:Array<{id:string;label:string}>};
const colors=['#4c5ac4','#2980b9','#27ae60','#8e44ad','#d35400','#16a085','#b45367'];
const short=(text:string)=>Array.from(text).length>16?Array.from(text).slice(0,15).join('')+'…':text;

export default function PointLineGraph({nodes,links,selectedNode,selectedRelation,onNode,onRelation,focusNode,labelMode='adaptive'}:{
  nodes:NetworkNode[];links:NetworkLink[];selectedNode?:string;selectedRelation?:string;onNode:(id:string)=>void;onRelation:(id:string)=>void;
  focusNode?:string;labelMode?:'adaptive'|'interaction';
}) {
  const marker=useId().replace(/:/g,'');
  const [zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,y:0}),[pair,setPair]=useState<string>();
  const drag=useRef<{x:number;y:number;px:number;py:number}|null>(null);
  const canvas=useRef<SVGSVGElement>(null);
  useEffect(()=>{setZoom(1);setPan({x:0,y:0});setPair(undefined);drag.current=null;},[nodes,links]);
  useEffect(()=>{
    const element=canvas.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{event.preventDefault();setZoom(n=>Math.max(.5,Math.min(3,n*(event.deltaY>0?.9:1.1))));};
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[nodes.length]);
  const positions=useMemo(()=>{
    if(focusNode&&nodes.some(node=>node.id===focusNode)){
      const neighbors=nodes.filter(node=>node.id!==focusNode);
      return new Map(nodes.map(node=>{
        const ordinal=neighbors.findIndex(item=>item.id===node.id);
        const angle=ordinal/Math.max(1,neighbors.length)*Math.PI*2-Math.PI/2;
        return [node.id,node.id===focusNode?{x:460,y:280}:{x:460+330*Math.cos(angle),y:280+185*Math.sin(angle)}];
      }));
    }
    const graph=new MultiGraph();
    nodes.forEach((node,i)=>graph.addNode(node.id,{x:Math.cos(i/nodes.length*Math.PI*2)*100,y:Math.sin(i/nodes.length*Math.PI*2)*100}));
    links.forEach(link=>{if(link.source!==link.target&&graph.hasNode(link.source)&&graph.hasNode(link.target))graph.addEdge(link.source,link.target);});
    if(nodes.length>1&&nodes.length<=250&&graph.size)forceAtlas2.assign(graph,{iterations:100,settings:{...forceAtlas2.inferSettings(graph),gravity:.8,scalingRatio:180,slowDown:15}});
    const values=nodes.map(node=>({id:node.id,x:Number(graph.getNodeAttribute(node.id,'x')),y:Number(graph.getNodeAttribute(node.id,'y'))}));
    const xs=values.map(p=>p.x),ys=values.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    return new Map(values.map(p=>[p.id,{x:maxX-minX<.00001?460:90+(p.x-minX)/(maxX-minX)*740,y:maxY-minY<.00001?280:90+(p.y-minY)/(maxY-minY)*360}]));
  },[nodes,links,focusNode]);
  const types=[...new Set(nodes.map(node=>node.type))];
  const activePair=links.find(link=>JSON.stringify([link.source,link.target])===pair);
  const nodeName=(id:string)=>nodes.find(node=>node.id===id)?.label||id;
  const point=(svg:SVGSVGElement,x:number,y:number)=>new DOMPoint(x,y).matrixTransform(svg.getScreenCTM()!.inverse());
  return <div className={`point-line-graph${labelMode==='interaction'?' network-labels-interaction':''}`}>
    <div className="network-tools"><small>拖动画布 · 点击节点或连线查看详情 · 箭头表示方向</small><div>
      <button type="button" aria-label="缩小图谱" onClick={()=>setZoom(n=>Math.max(.5,n-.2))}>−</button>
      <button type="button" aria-label="放大图谱" onClick={()=>setZoom(n=>Math.min(3,n+.2))}>＋</button>
      <button type="button" onClick={()=>{setZoom(1);setPan({x:0,y:0});}}>重置视图</button></div></div>
    {!nodes.length?<p className="empty">当前范围没有可显示的实体。</p>:<svg ref={canvas} className="network-canvas" viewBox="0 0 920 560" role="group" aria-label="实体与关系点线图" onPointerDown={event=>{
      if(event.button!==0||(event.target as Element).closest('[role=button]'))return;
      const p=point(event.currentTarget,event.clientX,event.clientY);drag.current={x:p.x,y:p.y,px:pan.x,py:pan.y};event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event=>{if(drag.current){const p=point(event.currentTarget,event.clientX,event.clientY);setPan({x:drag.current.px+p.x-drag.current.x,y:drag.current.py+p.y-drag.current.y});}}}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8392a7"/></marker></defs>
      <g transform={`translate(${460+pan.x} ${280+pan.y}) scale(${zoom}) translate(-460 -280)`}>
        {links.map(link=>{
          const a=positions.get(link.source),b=positions.get(link.target);if(!a||!b)return null;
          const id=JSON.stringify([link.source,link.target]),self=link.source===link.target;
          const reverse=link.reverseRelations??[];
          const bidirectional=!self&&reverse.length>0;
          const forwardLabel=link.relations.map(r=>r.label).join('、');
          const reverseLabel=reverse.map(r=>r.label).join('、');
          const description=`${nodeName(link.source)} → ${forwardLabel} → ${nodeName(link.target)}${bidirectional?` \\ ${nodeName(link.target)} → ${reverseLabel} → ${nodeName(link.source)}`:''}`;
          const distance=Math.hypot(b.x-a.x,b.y-a.y)||1,ux=(b.x-a.x)/distance,uy=(b.y-a.y)/distance;
          const start={x:a.x+ux*(bidirectional?24:19),y:a.y+uy*(bidirectional?24:19)},end={x:b.x-ux*24,y:b.y-uy*24};
          const control={x:(a.x+b.x)/2-uy*(bidirectional?0:28),y:(a.y+b.y)/2+ux*(bidirectional?0:28)};
          const path=self?`M ${a.x-13} ${a.y-14} C ${a.x-68} ${a.y-90}, ${a.x+68} ${a.y-90}, ${a.x+14} ${a.y-17}`:`M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
          const active=labelMode==='interaction'?pair===id:[...link.relations,...reverse].some(r=>r.id===selectedRelation)||selectedNode===link.source||selectedNode===link.target;
          const choose=()=>{setPair(id);onRelation(link.relations[0].id);};
          const related=labelMode==='interaction'&&selectedNode&&(link.source===selectedNode||link.target===selectedNode);
          return <g key={id} className={`network-link${active?' selected':''}${related?' related':''}${labelMode==='interaction'&&selectedNode&&!related?' muted':''}`} role="button" tabIndex={0} aria-label={description}
            onClick={choose} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}}}>
            <title>{description}</title><path className="network-edge-hit" d={path}/><path className="network-edge-line" d={path} markerStart={bidirectional?`url(#${marker})`:undefined} markerEnd={`url(#${marker})`}/>
            {(labelMode==='interaction'||active||links.length<=12)&&<text x={self?a.x:(a.x+2*control.x+b.x)/4} y={self?a.y-65:(a.y+2*control.y+b.y)/4-5} textAnchor="middle">{bidirectional?`${short(forwardLabel)} \\ ${short(reverseLabel)}`:short(link.relations.length===1?link.relations[0].label:`${link.relations[0].label} 等 ${link.relations.length} 种关系`)}</text>}
          </g>;
        })}
        {nodes.map(node=>{const p=positions.get(node.id)!;return <g key={node.id} className={`network-node${node.id===selectedNode?' selected':''}`} role="button" tabIndex={0} aria-label={`实体：${node.label}（${node.type}）`}
          onClick={()=>{setPair(undefined);onNode(node.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setPair(undefined);onNode(node.id);}}}>
          <title>{node.label}（{node.type}）</title><circle cx={p.x} cy={p.y} r={labelMode === 'interaction' ? 9 : 18} fill={colors[types.indexOf(node.type)%colors.length]}/><text x={p.x} y={p.y+(labelMode === 'interaction' ? 28 : 36)} textAnchor="middle">{short(node.label)}</text>
        </g>;})}
      </g>
    </svg>}
    {activePair&&<div className="network-relations"><strong>{nodeName(activePair.source)} → {nodeName(activePair.target)}</strong>{activePair.relations.map(relation=><button type="button" key={relation.id} aria-pressed={relation.id===selectedRelation} onClick={()=>onRelation(relation.id)}>{relation.label}</button>)}
      {!!activePair.reverseRelations?.length&&<><strong>\ {nodeName(activePair.target)} → {nodeName(activePair.source)}</strong>{activePair.reverseRelations.map(relation=><button type="button" key={`reverse:${relation.id}`} aria-pressed={relation.id===selectedRelation} onClick={()=>onRelation(relation.id)}>{relation.label}</button>)}</>}
    </div>}
  </div>;
}
