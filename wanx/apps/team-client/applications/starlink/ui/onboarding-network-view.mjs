import {layoutGraph,edgeGeometry} from './graph.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const palette=['#d95f02','#ef821a','#2985b5','#12a18a','#218766','#789d8e','#c4392b'];
const label=d=>d.label||d.name;
const short=v=>[...String(v)].length>14?[...String(v)].slice(0,13).join('')+'…':String(v);
export function ontologyGraphHTML(schema,changes=[],prefix='ob-draft',{label:graphLabel='待发布本体类型关系图'}={}){
  const entities=schema?.entity_types||[],relations=schema?.relation_types||[];
  if(!entities.length)return '<p class="ob-muted">当前没有实体类型，请在下方核对完整定义。</p>';
  const ids=new Set(entities.map(d=>d.name)),edges=[];let total=0,missing=0;
  relations.forEach((r,ri)=>{
    const sources=(r.source_types||[]).filter(n=>ids.has(n)),targets=(r.target_types||[]).filter(n=>ids.has(n));
    missing+=(r.source_types||[]).length*(r.target_types||[]).length-sources.length*targets.length;
    total+=sources.length*targets.length;
    for(const s of sources){for(const t of targets){if(edges.length>=240)break;edges.push({s,t,r,ri});}if(edges.length>=240)break;}
  });
  const graph=layoutGraph({nodes:entities.map((d,i)=>({id:d.name,name:label(d),d,i})),edges});
  graph.nodes.forEach(n=>{n.r=Math.min(23,10+Math.sqrt(n.degree)*3);});
  const points=new Map(graph.nodes.map(n=>[n.id,n])),groups=new Map();
  edges.forEach(e=>{const key=[e.s,e.t].sort().join('\0');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);});
  const state=(kind,name)=>{const c=changes.find(c=>c.kind===kind&&c.name===name);return c?.after?(c.before?'modified':'added'):'existing';};
  const geometries=edges.map(e=>{const peers=groups.get([e.s,e.t].sort().join('\0'));return {...e,g:edgeGeometry(points.get(e.s),points.get(e.t),peers.indexOf(e),peers.length)};});
  const minX=Math.min(...graph.nodes.map(n=>n.x),...geometries.map(e=>e.g.x))-110;
  const minY=Math.min(...graph.nodes.map(n=>n.y),...geometries.map(e=>e.g.y))-100;
  const width=Math.max(500,Math.max(...graph.nodes.map(n=>n.x+170),...geometries.map(e=>e.g.x+90))-minX);
  const height=Math.max(300,Math.max(...graph.nodes.map(n=>n.y+80),...geometries.map(e=>e.g.y+80))-minY);
  const viewX=(minX+Math.max(...graph.nodes.map(n=>n.x+170),...geometries.map(e=>e.g.x+90))-width)/2;
  const viewY=(minY+Math.max(...graph.nodes.map(n=>n.y+80),...geometries.map(e=>e.g.y+80))-height)/2;
  const lines=geometries.map(e=>`<g class="ob-ontology-edge ${state('relation_types',e.r.name)}" role="button" tabindex="0" data-ontology-focus="${prefix}-relation_types-${e.ri}" aria-label="查看关系：${esc(label(e.r))}"><title>${esc(label(e.r))}：${esc(points.get(e.s).name)} → ${esc(points.get(e.t).name)}</title><path class="ob-edge-hit" d="${e.g.d}"/><path d="${e.g.d}" marker-end="url(#${prefix}-arrow)"/><g class="ob-graph-link"><rect x="${e.g.x-64}" y="${e.g.y-14}" width="128" height="28" rx="5"/><text x="${e.g.x}" y="${e.g.y+4}">${esc(short(label(e.r)))}</text></g></g>`).join('');
  const nodes=graph.nodes.map(n=>`<g class="ob-ontology-node ${state('entity_types',n.id)}" role="button" tabindex="0" data-ontology-focus="${prefix}-entity_types-${n.i}" aria-label="查看实体类型：${esc(n.name)}"><title>${esc(n.name)} · ${esc(n.id)}</title><circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${palette[n.i%palette.length]}"/><text x="${n.x+n.r+6}" y="${n.y+4}">${esc(short(n.name))}</text></g>`).join('');
  return `<div class="ob-graph-heading"><h3>本体知识网络</h3><span>${entities.length} 个实体类型 · ${relations.length} 个关系类型</span></div>
    <div class="ob-network"><div class="ob-network-legend">${entities.map((d,i)=>`<span><i style="background:${palette[i%palette.length]}"></i>${esc(label(d))}</span>`).join('')}</div>
    <div class="ob-ontology-canvas" tabindex="0" aria-label="本体知识网络，可滚动查看"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewX} ${viewY} ${width} ${height}" style="min-width:700px" role="group" aria-label="${esc(graphLabel)}"><defs><marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a8c4b7"/></marker></defs>${lines}${nodes}</svg></div>
    <p class="ob-network-help">点击节点查看类型定义 · 悬停关系查看名称，点击查看详情 · 箭头表示关系方向</p></div>
    ${!relations.length?'<p class="ob-muted">本次尚未定义关系，图中类型暂不连线。</p>':''}${total>edges.length?`<p class="ob-muted">网络展示前 ${edges.length} 条端点连接；全部关系与属性请查看下方完整定义。</p>`:''}${missing?'<p class="ob-error">存在未匹配的关系端点，请在完整定义中核对。</p>':''}`;
}
