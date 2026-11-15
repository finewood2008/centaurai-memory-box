import {layoutGraph,edgeGeometry} from './graph.js';
import {candidatesReady} from './conversation-progress.mjs';
import {createGraphPresentation} from './graph-presentation.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cache=new WeakMap();
export const candidateGraphKey=(flow)=>JSON.stringify([flow.saved.conversationId,flow.state.detail?.id,flow.state.detail?.revision,flow.state.detail?.document_version_id,flow.state.detail?.execution?.id]);
export function currentCandidateGraph(flow){const g=flow.state.candidateGraph;return candidatesReady(flow.state.detail)&&g?.key===candidateGraphKey(flow)?g:null;}

// Resolve links by candidate identity, never by a shared entity label or type.
export function candidateNetwork(items){
  const nodes=[],edges=[],byKey=new Map(),ambiguous=new Set();let unresolved=0;
  items.forEach((fact,index)=>{if(fact.kind!=='entity')return;const key=fact.candidate_key;
    const node={id:String(index),name:fact.payload?.name||'未命名实体',type:fact.payload?.type||'未分类',index};nodes.push(node);
    if(key){if(byKey.has(key))ambiguous.add(key);else byKey.set(key,node);}
  });
  items.forEach((fact,index)=>{if(fact.kind!=='relation')return;const p=fact.payload||{},a=byKey.get(p.source_candidate_key),b=byKey.get(p.target_candidate_key);
    if(!a||!b||ambiguous.has(p.source_candidate_key)||ambiguous.has(p.target_candidate_key)){unresolved++;return;}
    edges.push({id:String(index),s:a.id,t:b.id,name:p.type||'未命名关系',index});
  });
  return {nodes,edges,unresolved};
}

export async function readCandidateNetwork(flow){
  const key=candidateGraphKey(flow),d=flow.state.detail,conversationId=flow.saved.conversationId;
  const fail=()=>Object.assign(Error('MODELING_SNAPSHOT_CHANGED'),{code:'MODELING_SNAPSHOT_CHANGED'});
  if(!candidatesReady(d))throw fail();
  let items=[],total=null;
  // Bound the preview without presenting a partial graph as a complete result.
  while(items.length<1000){
    const page=await flow.read('conversation-candidates',{conversationId,intentId:d.id,offset:items.length,limit:50});
    if(page.execution_id!==d.execution?.id||!Array.isArray(page.items)||!Number.isSafeInteger(page.total)||page.total<0||
      page.offset!==items.length||(total!==null&&page.total!==total)||page.items.length>50||items.length+page.items.length>page.total)throw fail();
    total=page.total;items.push(...page.items);
    if(items.length===total)break;
    if(!page.items.length)throw fail();
  }
  const latest=await flow.read('conversation-intent',{conversationId,intentId:d.id});
  if(candidateGraphKey(flow)!==key||!candidatesReady(latest)||latest.revision!==d.revision||latest.document_version_id!==d.document_version_id||latest.execution?.id!==d.execution?.id)throw fail();
  return {key,items,total,selected:null,focus:'',zoom:1};
}

function scene(data){
  let memo=cache.get(data);if(!memo){memo={network:candidateNetwork(data.items)};cache.set(data,memo);}
  if(memo.focus===data.focus&&memo.scene)return memo.scene;
  const all=memo.network,degree=new Map(all.nodes.map(n=>[n.id,0]));
  all.edges.forEach(e=>{degree.set(e.s,degree.get(e.s)+1);degree.set(e.t,degree.get(e.t)+1);});
  const neighbors=new Set([data.focus]);
  if(data.focus)all.edges.forEach(e=>{if(e.s===data.focus)neighbors.add(e.t);if(e.t===data.focus)neighbors.add(e.s);});
  const sorted=[...all.nodes].sort((a,b)=>(b.id===data.focus)-(a.id===data.focus)||degree.get(b.id)-degree.get(a.id)||a.index-b.index);
  const nodes=sorted.filter(n=>!data.focus||neighbors.has(n.id)).slice(0,40),ids=new Set(nodes.map(n=>n.id));
  const edges=all.edges.filter(e=>ids.has(e.s)&&ids.has(e.t)&&(!data.focus||e.s===data.focus||e.t===data.focus)).slice(0,80);
  const graph=layoutGraph({nodes,edges}),points=new Map(graph.nodes.map(n=>[n.id,n])),groups=new Map();
  graph.edges.forEach(e=>{const key=JSON.stringify([e.s,e.t].sort());if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);});
  const paths=graph.edges.map(e=>{const peers=groups.get(JSON.stringify([e.s,e.t].sort()));return {...e,g:edgeGeometry(points.get(e.s),points.get(e.t),peers.indexOf(e),peers.length)};});
  const xs=graph.nodes.map(n=>n.x),ys=graph.nodes.map(n=>n.y);
  paths.forEach(e=>{xs.push(e.g.x);ys.push(e.g.y);});
  const x=(xs.length?Math.min(...xs):0)-110,y=(ys.length?Math.min(...ys):0)-100,w=Math.max(500,(xs.length?Math.max(...xs):0)+110-x),h=Math.max(360,(ys.length?Math.max(...ys):0)+110-y);
  memo.focus=data.focus;return memo.scene={all,graph,paths,viewBox:`${x} ${y} ${w} ${h}`};
}

export function candidateNetworkHTML(data,schema){
  const {all,graph,paths,viewBox}=scene(data),types=[...new Set(all.nodes.map(n=>n.type))];
  const presentation=createGraphPresentation(schema),color=type=>presentation.entity(type).color;
  const selected=id=>data.selected===id?' selected':'';
  const edges=paths.map(e=>`<g class="cv-network-edge${selected(e.id)}" role="button" tabindex="0" data-cv="candidate-inspect" data-id="${e.id}" aria-label="查看关系 ${esc(presentation.relation(e.name))}"><title>${esc(presentation.relation(e.name))}</title><path class="cv-network-hit" d="${e.g.d}"/><path class="cv-network-link" d="${e.g.d}" marker-end="url(#cv-candidate-arrow)"/><text x="${e.g.x}" y="${e.g.y-6}" text-anchor="middle">${esc(presentation.relation(e.name))}</text></g>`).join('');
  const nodes=graph.nodes.map(n=>`<g class="cv-network-node${selected(n.id)}" role="button" tabindex="0" data-cv="candidate-inspect" data-id="${n.id}" aria-label="查看实体 ${esc(n.name)}"><title>${esc(n.name)} · ${esc(presentation.entity(n.type).label)}</title><circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${color(n.type)}"/>${n.lines.map((line,i)=>`<text x="${n.x}" y="${n.y+n.r+18+i*16}" text-anchor="middle">${esc(line)}</text>`).join('')}</g>`).join('');
  return `<div class="cv-candidate-network"><div class="cv-network-summary"><strong>候选实体关系图</strong><span>未发布</span></div>
    <p>已加载 ${data.items.length} / ${data.total} 项候选 · ${all.nodes.length} 个实体 · ${all.edges.length+all.unresolved} 条关系</p>
    ${data.items.length<data.total?'<p role="status">图谱预览最多加载 1000 项；其余候选请在列表中翻页核对。</p>':''}
    ${all.nodes.length?`<label>探索实体 <select id="cv-candidate-focus"><option value="">概览（优先展示关联较多的实体）</option>${all.nodes.map(n=>`<option value="${n.id}" ${n.id===data.focus?'selected':''}>${esc(n.name)} · ${esc(presentation.entity(n.type).label)}</option>`).join('')}</select></label>
    <div class="cv-network-legend">${types.map(type=>`<span><i style="background:${color(type)}"></i>${esc(presentation.entity(type).label)}</span>`).join('')}</div>
    <div class="cv-network-toolbar"><span>当前展示 ${graph.nodes.length} 个实体、${graph.edges.length} 条关系</span><button type="button" class="btn btn-secondary" data-cv="candidate-zoom-out" aria-label="缩小图谱">−</button><button type="button" class="btn btn-secondary" data-cv="candidate-zoom-reset">${Math.round(data.zoom*100)}%</button><button type="button" class="btn btn-secondary" data-cv="candidate-zoom-in" aria-label="放大图谱">＋</button></div>
    <div class="cv-network-canvas" tabindex="0" aria-label="候选图谱，可滚动查看"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" style="width:${data.zoom*100}%;height:${data.zoom*380}px" role="group" aria-label="未发布的材料候选实体与关系"><defs><marker id="cv-candidate-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ab9079"/></marker></defs>${edges}${nodes}</svg></div>
    <p class="muted">点击实体或关系查看下方属性与原文依据；箭头表示关系方向。概览最多展示 40 个实体、80 条关系，可选择实体查看直接关联。</p>`:'<p>当前候选中没有可展示的实体，请切换列表核对。</p>'}
    ${all.nodes.length&&!all.edges.length?'<p>尚无端点可匹配的关系，暂时仅展示实体。</p>':''}
    ${all.unresolved?`<p role="status">${all.unresolved} 条关系的端点未加载或无法唯一匹配，未绘制连线；请在列表中核对。</p>`:''}</div>`;
}
