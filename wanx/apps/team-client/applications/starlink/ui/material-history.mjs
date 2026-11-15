import {factsHTML} from './conversation-view.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=()=>{throw Object.assign(Error('MODELING_SNAPSHOT_CHANGED'),{code:'MODELING_SNAPSHOT_CHANGED'});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const label=v=>({editing:'未发布草稿',discarded:'已转为历史',submitted:'已提交',published:'已发布',superseded:'已被替换',failed:'失败',cancelled:'已取消',awaiting_review:'待核对',succeeded:'已完成'}[v]||v||'状态未知');
const time=v=>{if(!v)return '';const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN'):'';};
const button=(action,text,off=false,value='')=>`<button class="btn btn-secondary" data-cv="${action}" data-id="${esc(value)}" ${off?'disabled':''}>${text}</button>`;

export class MaterialHistory{
  constructor(flow){this.f=flow;this.editor=null;}
  get view(){const v=this.f.state.materialHistory;return v?.documentId===this.f.agent.documentId?v:null;}
  clear(){this.f.state.materialHistory=null;this.editor=null;}
  current(v){this.f.check();if(this.view!==v)fail();}
  read(v,suffix,query={}){
    this.current(v);
    return this.f.read('workbench-request',{method:'GET',url:`/api/documents/${v.documentId}/corrections${suffix}?${new URLSearchParams(query)}`,editor:this.editor});
  }
  open(){return this.f.run(async()=>{
    const documentId=this.f.agent.documentId;if(!id(documentId)||!this.f.state.loaded)return;
    this.clear();const v=this.f.state.materialHistory={documentId,events:[],runs:[],runLimit:20,ready:false,moreEvents:false,detail:null};
    this.f.emit();
    const owner=this.f.changes.owner;
    if(owner?.documentId===documentId)this.editor={...owner.editor};
    else{const value=await this.f.read('conversation-editor-session',{documentId,operationId:this.f.uuid()});this.current(v);this.editor={session:value.editor_session,generation:'0'};}
    const runs=await this.f.read('workbench-request',{method:'GET',url:`/api/knowledge/runs?document_id=${documentId}`});
    this.current(v);if(!Array.isArray(runs.items)||runs.items.some(r=>!id(r.id)||r.document_id!==documentId))fail();
    v.runs=runs.items;await this.events(v);v.ready=true;
  });}
  async events(v){
    const after=v.events.at(-1)?.id||0,result=await this.read(v,'/events',{after_id:String(after),limit:'20'});this.current(v);
    if(!Array.isArray(result.items)||result.items.length>20||result.items.some((e,n)=>!Number.isSafeInteger(e.id)||e.id<=(n?result.items[n-1].id:after)||!id(e.draft_id)))fail();
    v.events.push(...result.items);v.moreEvents=result.items.length===20;
  }
  more(){const v=this.view;if(!v?.moreEvents)return;return this.f.run(()=>this.events(v));}
  draft(draftId,offset=0,kind='entity'){return this.f.run(async()=>{
    const v=this.view;if(!v?.events.some(e=>e.draft_id===draftId)||!Number.isSafeInteger(offset)||offset<0||!['entity','relation'].includes(kind))return;
    v.detail=null;
    const summary=await this.read(v,`/${draftId}`);this.current(v);if(summary.id!==draftId||summary.document_id!==v.documentId||!Number.isSafeInteger(summary.revision)||summary.revision<1)fail();
    const page=await this.read(v,`/${draftId}/items`,{revision:String(summary.revision),offset:String(offset),limit:'20',kind});this.current(v);
    if(page.revision!==summary.revision||page.offset!==offset||!Array.isArray(page.items)||page.items.length>20||!Number.isSafeInteger(page.total)||page.total<0)fail();
    v.detail={type:'draft',id:draftId,summary,items:page.items,offset,total:page.total,kind};
  });}
  run(runId){return this.f.run(async()=>{
    const v=this.view;if(!v?.runs.some(r=>r.id===runId))return;v.detail=null;
    const value=await this.f.read('conversation-published-run',{runId});this.current(v);
    if(value.run?.id!==runId||value.run.document_id!==v.documentId||!Array.isArray(value.candidates))fail();
    v.detail={type:'run',id:runId,summary:value.run,items:value.candidates,offset:0,total:value.candidates.length};
  });}
  page(delta){const v=this.view,d=v?.detail;if(!d||this.f.state.busy)return;const offset=Math.max(0,d.offset+delta*20);if(offset>=d.total&&offset!==0)return;
    if(d.type==='draft')return this.draft(d.id,offset,d.kind);d.offset=offset;this.f.emit();
  }
}

export function materialHistoryButton(f){return f?.agent?.documentId?button('material-history',f.history?.view&&!f.history.view.ready&&f.state.busy?'正在读取历史…':'材料历史',f.state.busy||!f.state.loaded)+button('round-history','历史对话',f.state.busy||!f.state.loaded):'';}
export function materialHistoryHTML(f){
  const v=f?.history?.view;if(!v)return '';const off=f.state.busy,d=v.detail;
  if(!v.ready)return `<section class="mw-material-history" aria-label="材料历史"><header><h3>材料历史</h3>${button('history-close','收起历史',off)}</header>${off?'<p role="status">正在读取材料历史…</p><progress aria-label="材料历史读取进度"></progress>':`<p role="alert">历史读取未完成。${esc(f.state.error||'请重新读取。')}</p>${button('material-history','重新读取历史')}`}</section>`;
  const context=d?[...d.items,...d.items.flatMap(i=>Object.values(i.endpoints||{}).map(e=>({kind:'entity',candidate_key:e.id,payload:{name:e.name}})))]:[];
  const details=d?`<section class="mw-history-detail"><h4>${d.type==='draft'?'草稿保存内容':'抽取结果快照'} · ${esc(label(d.summary.status))}${d.type==='draft'?` · 修订 ${d.summary.revision}`:''}</h4><p>仅供查看，不会作为当前材料结果，也不会恢复编辑或发布。</p>${d.type==='draft'?button('history-entities','实体',off,d.id)+button('history-relations','关系',off,d.id):''}${factsHTML(d.type==='run'?d.items.slice(d.offset,d.offset+20):d.items,context,d.summary.ontology||f.state.ontology?.schema)||'<p>没有条目。</p>'}${button('history-prev','上一页',off||d.offset===0)}<span> ${d.total?d.offset+1:0}–${Math.min(d.offset+20,d.total)} / ${d.total} </span>${button('history-next','下一页',off||d.offset+20>=d.total)}</section>`:'';
  return `<section class="mw-material-history" aria-label="材料历史"><header><h3>材料历史</h3>${button('history-close','收起历史',off)}</header><p>只读查看当前账号有权访问的草稿、抽取结果和操作记录。不会接管编辑权或恢复旧内容。草稿展示最近保存的内容，不是每条操作发生时的快照。</p>${!v.ready?'<p role="status">历史尚未读取完成。</p>'+button('material-history','重新读取历史',off):''}<details open><summary>草稿操作记录 · 已读取 ${v.events.length} 条</summary>${v.events.map(e=>`<article><strong>${esc({create:'创建草稿',save:'保存修改',reset:'重置条目',discard:'草稿转为历史'}[e.action]||e.action)}</strong><small> · ${esc(time(e.created_at))} · 修订 ${esc(e.revision)}</small><p>${esc(e.note||'')}</p>${button('history-draft','查看草稿保存内容',off,e.draft_id)}</article>`).join('')||'<p>暂无可读取的草稿记录；正在由其他编辑会话持有的私有内容不会在这里自动接管。</p>'}${v.moreEvents?button('history-more','继续读取记录',off):''}</details><details open><summary>抽取与发布记录 · ${v.runs.length} 组</summary><p>最多列出最近 200 组结果；历史状态不代表当前生效状态。</p>${v.runs.slice(0,v.runLimit).map(r=>`<article><span>${esc(time(r.created_at))} · ${esc(label(r.status))}</span> ${button('history-run','查看实体、关系与证据',off,r.id)}</article>`).join('')||'<p>暂无抽取记录。</p>'}${v.runs.length>v.runLimit?button('history-runs-more','显示更多结果',off):''}</details>${details}</section>`;
}
