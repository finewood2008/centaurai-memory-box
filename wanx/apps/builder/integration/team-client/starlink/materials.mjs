import {assertWorkflow,materialErrorText} from './material-contract.mjs';
import {createMaterialAutomatic} from './material-automatic.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createMaterialBrowser({call,changed,getContext,personal=false}){
 let key=null,tabs=[],active=null,query='',collapsed=new Set(),sequence=0;
 const cache=new Map();let drafts=new Map();const archives=new Map();
 const automatic=createMaterialAutomatic({call,changed,getContext,getStorage:()=>globalThis.window?.localStorage||globalThis.localStorage,onDenied(id,e){drafts.delete(id);cache.set(id,{loading:false,text:'',workflowError:'材料处理状态读取失败：'+materialErrorText(e)});}});
 const contextKey=()=>JSON.stringify(getContext());
 function reset(){automatic.reset();if(key&&drafts.size)archives.set(key,new Map(drafts));drafts=new Map();key=null;tabs=[];active=null;query='';collapsed.clear();cache.clear();sequence++}
 function context(){const next=contextKey();if(next!==key){reset();key=next;drafts=archives.get(next)||new Map();archives.delete(next)}return next}
 async function open(id,append=false){
  const captured=context(),warehouseId=getContext().warehouseId,seq=++sequence;
  if(!warehouseId)return;
  if(!tabs.includes(id))tabs.push(id);active=id;
  const previous=cache.get(id);cache.set(id,{...previous,workflow:null,loading:true,error:''});changed();
  const current=()=>contextKey()===captured&&seq===sequence&&active===id;
  try{
   let value=append?previous:null;
   if(!value){const source=await call('document',{warehouseId,id});if(!current())return;
    value={title:source.document?.original_name||'资料',versionId:source.version?.id||source.document?.active_version_id,text:'',end:0,total:0};
   }
   if(personal){
    try{value.workflow=await call('material-workflow',{warehouseId,documentId:id});if(!current())return;
      assertWorkflow(value.workflow,id,value.versionId);value.workflowError='';
      if(!append&&!await automatic.restore(id,value.workflow))return;if(!current())return;
    }catch(e){if(!current())return;automatic.reset();value.workflow=null;value.workflowError='材料处理状态读取失败：'+materialErrorText(e)+'。请重新打开材料重试。';
      if(e.httpStatus===401||e.httpStatus===403||e.httpStatus===404||/FORBIDDEN|OWNER_REQUIRED|SESSION|RESOURCE_NOT_FOUND/.test(e.code||'')){
        drafts.delete(id);cache.set(id,{workflowError:value.workflowError,loading:false,text:''});return;
      }}
   }
   if(!value.versionId){cache.set(id,{...value,loading:false,error:'正文尚未就绪，请在处理完成后重新读取。'});return}
   const part=await call('document-text',{warehouseId,id,versionId:value.versionId,start:append?value.end:0});if(!current())return;
   if(part.version_id!==value.versionId)throw Error('VERSION_CHANGED');
   if(append&&part.start!==value.end)throw Error('RANGE_CHANGED');
   cache.set(id,{...value,text:append?value.text+(part.text||''):part.text||'',end:part.end??(part.text||'').length,total:part.total_chars??(part.text||'').length,loading:false,error:''});
  }catch(e){if(current()){
    const denied=e.httpStatus===401||e.httpStatus===403||e.httpStatus===404||/FORBIDDEN|OWNER_REQUIRED|SESSION|RESOURCE_NOT_FOUND/.test(e.code||'');
    if(denied){drafts.delete(id);automatic.reset();}
    cache.set(id,{...(denied?{text:''}:cache.get(id)),workflow:null,loading:false,error:/VERSION|RANGE/.test(String(e.code||e.message))?'来源版本已变化，请重新读取，未拼接不同版本。':'正文读取失败：'+materialErrorText(e)});
  }}
  finally{if(current())changed()}
 }
 async function edit(){
  context();const id=active,captured=key,seq=++sequence,warehouseId=getContext().warehouseId;let all=[],base=null;
  const current=()=>contextKey()===captured&&active===id&&seq===sequence;
  cache.set(id,{...cache.get(id),loading:true,error:''});changed();
  try{
   if(personal){
     const w=assertWorkflow(await call('material-workflow',{warehouseId,documentId:id}),id,cache.get(id)?.versionId);
     if(!current())return;
     cache.set(id,{...cache.get(id),workflow:w,workflowError:''});
     if(!w.actions.edit_source.allowed){cache.set(id,{...cache.get(id),error:w.actions.edit_source.reason||'当前材料不允许编辑正文。'});return;}
   }
   let offset=0,total;
   do{const page=await call('document',{warehouseId,id,offset});if(!current())return;
    const version=page.version?.id||page.document?.active_version_id;if(!version||base&&base!==version)throw Error('来源版本已变化，请重新读取。');base=version;
    total=page.document?.segment_count??page.segments?.length??0;
    if(!Array.isArray(page.segments)||!page.segments.length||page.segments.some(v=>v.text_truncated))throw Error('正文未完整提供，暂不能安全编辑。');
    all.push(...page.segments);offset+=page.segments.length;
    if(all.length>2000||new TextEncoder().encode(all.map(v=>v.text).join('')).length>768*1024)throw Error('正文过大，请在完整版分段校对。');
   }while(all.length<total);
   if(new Set(all.map(v=>v.id)).size!==all.length)throw Error('来源片段不完整，请重新读取。');
   drafts.set(id,{versionId:base,segments:all.map(v=>({id:v.id,text:v.text,original:v.text})),operationId:crypto.randomUUID(),saving:false,error:''});
  }catch(e){if(current()){
    const denied=e.httpStatus===401||e.httpStatus===403||e.httpStatus===404||/FORBIDDEN|OWNER_REQUIRED|SESSION|RESOURCE_NOT_FOUND/.test(e.code||'');
    const localErrors=new Set(['来源版本已变化，请重新读取。','正文未完整提供，暂不能安全编辑。','正文过大，请在完整版分段校对。','来源片段不完整，请重新读取。']);
    cache.set(id,{...(denied?{text:''}:cache.get(id)),...(personal&&!localErrors.has(e.message)?{workflow:null,workflowError:'材料处理状态读取失败：'+materialErrorText(e)}:{}),error:localErrors.has(e.message)?e.message:'未进入正文编辑，请重新读取材料状态。'});
  }}
  finally{if(current()){cache.set(id,{...cache.get(id),loading:false});changed()}}
 }
 async function save(){
  context();const id=active,d=drafts.get(id),captured=key;if(!d||d.saving)return;
  const hasChanges=d.segments.some(s=>s.text!==s.original),segments=d.segments.map(s=>({id:s.id,text:s.text}));
  if(!hasChanges&&!d.request){drafts.delete(id);changed();return}
  if(new TextEncoder().encode(segments.map(s=>s.text).join('')).length>768*1024){d.error='修改内容过大，请分段校对。';changed();return}
  d.request??={warehouseId:getContext().warehouseId,id,versionId:d.versionId,operationId:d.operationId,segments};d.saving=true;d.error='';changed();
  try{await call('correct',d.request);if(contextKey()!==captured)return;drafts.delete(id);if(active===id)await open(id);else cache.delete(id)}
  catch{if(contextKey()===captured)d.error='保存未确认或基础版本已变化。草稿保留，可重试原保存；请勿覆盖他人的新版本。'}
  finally{d.saving=false;if(contextKey()===captured)changed()}
 }
 function input(name,value){if(!name.startsWith('materialSegment_'))return false;const d=drafts.get(active),id=name.slice(16),s=d?.segments.find(s=>s.id===id);if(s&&!d.request&&!d.saving)s.text=String(value);return true}
 function editor(d){return `<form class="data-material-edit" data-data-form="material-save"><p>编辑解析正文 · 保存生成新版本，原始文件保留；后续按本仓已确认的模型配置处理；若使用在线模型，修改后的正文也会发送到对应服务。</p>${d.error?`<p role="alert">${esc(d.error)}</p>`:''}${d.segments.map((s,i)=>`<label>片段 ${i+1}<textarea name="materialSegment_${esc(s.id)}" data-studio-edit-key="materialSegment_${esc(s.id)}" ${d.saving||d.request?'readonly':''}>${esc(s.text)}</textarea></label>`).join('')}<div><button class="button primary" ${d.saving?'disabled':''}>${d.saving?'保存中…':d.request?'重试原保存':'保存新版本'}</button><button type="button" class="button" data-data-action="material-cancel" ${d.saving?'disabled':''}>取消编辑</button></div></form>`}
 function render({documents,total,offset,pagination,isLoading}){
  context();const shown=documents.filter(d=>(d.original_name||'').toLocaleLowerCase().includes(query.toLocaleLowerCase())),groups=new Map();
  for(const d of shown){const type=(d.document_format||d.original_name?.split('.').pop()||'其他').toUpperCase();if(!groups.has(type))groups.set(type,[]);groups.get(type).push(d)}
  const n=cache.get(active),draft=drafts.get(active),name=id=>cache.get(id)?.title||documents.find(d=>d.id===id)?.original_name||'资料';
  // Detail permissions are version-bound. A background list must not revive failed or stale detail actions.
  return `<section class="data-file-workspace" aria-label="资料浏览与预览"><aside class="data-file-tree"><header><strong>仓里的资料</strong><small>按文件类型浏览 · ${total} 份资料</small></header><form data-data-form="material-filter"><input name="materialFilter" data-studio-edit-key="material-filter" value="${esc(query)}" placeholder="查找当前列表" aria-label="查找当前资料列表"><button class="button">查找</button></form><div class="data-file-list">${[...groups].map(([type,items])=>`<button class="data-file-folder" data-data-action="material-folder" data-type="${esc(type)}" aria-expanded="${!collapsed.has(type)}">${collapsed.has(type)?'▸':'▾'} ${esc(type)} <small>${items.length}</small></button>${collapsed.has(type)?'':items.map(d=>`<button class="data-file-row ${active===d.id?'active':''}" data-data-action="material-open" data-id="${esc(d.id)}" title="${esc(d.original_name)}" ${active===d.id?'aria-current="page"':''}><span aria-hidden="true">▤</span><span>${esc(d.original_name)}</span><small>${esc(d.workflow?.label||(d.job_status==='failed'?'处理失败':d.status==='ready'?'已解析':'处理中'))}</small></button><button class="text-button" data-data-action="delete-material" data-id="${esc(d.id)}" aria-label="删除 ${esc(d.original_name)}">删除</button>`).join('')}`).join('')||`<p>${isLoading?'正在读取资料…':query?'当前列表未找到资料。':'导入一份资料，从这里开始阅读。'}</p>`}</div>${pagination||''}<footer>${total?offset+1:0}–${Math.min(offset+documents.length,total)} / ${total}</footer></aside><main class="data-file-main"><nav class="data-file-tabs" aria-label="已打开资料">${tabs.map(id=>`<div class="${active===id?'active':''}"><button data-data-action="material-open" data-id="${esc(id)}" title="${esc(name(id))}">${esc(name(id))}</button><button data-data-action="material-close" data-id="${esc(id)}" aria-label="关闭 ${esc(name(id))}">×</button></div>`).join('')}</nav>${active?`<header class="data-file-preview-bar"><div><strong>${esc(name(active))}</strong><small>${draft?'编辑正文':'正文预览'}${n?.versionId?' · 固定版本 '+esc((draft?.versionId||n.versionId).slice(0,8)):''}</small></div>${draft?`<div><button class="button primary" data-data-action="material-save" ${draft.saving?'disabled':''}>${draft.saving?'保存中…':draft.request?'重试原保存':'保存新版本'}</button><button class="button" data-data-action="material-cancel" ${draft.saving?'disabled':''}>取消</button></div>`:`<button class="button" data-data-action="material-edit" ${n?.loading||!n?.versionId||personal&&n?.workflow?.actions?.edit_source?.allowed!==true?'disabled':''}>编辑正文</button><button class="button" data-data-action="reextract-document" data-id="${esc(active)}" data-version-id="${esc(n?.versionId)}" ${n?.loading||!n?.versionId||personal&&n?.workflow?.actions?.prepare_automatic?.allowed!==true?'disabled':''}>重新抽取</button>`}</header><div class="data-file-reading" aria-busy="${Boolean(n?.loading)}">${workflowHTML(n)}${automatic.render(active)}${n?.loading?'<p role="status">正在读取正文…</p>':''}${n?.error?`<p role="alert">${esc(n.error)}</p>`:''}${draft?editor(draft):`<pre>${esc(n?.text||'')}</pre>`}${n&&!n.loading&&!n.error&&!n.text?'<p>此资料暂无可预览正文。</p>':''}${!draft&&n?.end<n?.total?`<button class="button" data-data-action="material-more" ${n.loading?'disabled':''}>继续读取正文（${n.end} / ${n.total}）</button>`:''}</div><footer class="data-file-preview-note">PDF、图片、表格和音频展示解析／识别后的正文；原件和历史记录保持不变。</footer>`:'<div class="data-file-empty"><span>▤</span><h3>从左侧打开一份资料</h3><p>在标签页之间切换阅读，可预览正文，也可编辑并保存新版本。</p></div>'}</main></section>`;
 }
 function workflowHTML(n){
  if(!personal||!n)return '';
  const w=n.workflow;
  if(!w)return `<p role="status">${esc(n.workflowError||'正在读取材料处理状态…')}</p>`;
  const links=(w.conversations||[]).filter(l=>l.conversation_status==='active');
  return `<section aria-label="材料处理状态"><strong>${esc(w.label)}</strong><p>${w.processing_mode==='dialogue'?'对话核对 · 确认后发布':'自动处理'}${w.publication?' · 已有发布结果':''}</p>
    ${(w.tasks||[]).map(t=>`<p>${esc(t.stage)} · ${esc(t.completed_units)} / ${esc(t.total_units??'待确定')}</p>`).join('')}
    <p>${esc(w.actions.edit_source.allowed?'':w.actions.edit_source.reason||'当前材料不允许编辑正文。')}</p>
    <p>${esc(w.actions.prepare_automatic.allowed?'':w.actions.prepare_automatic.reason||'当前材料不允许自动处理。')}</p>
    ${links.map(l=>`<button class="button primary" data-data-action="material-dialogue" data-conversation="${esc(l.conversation_id)}" data-intent="${esc(l.intent_id)}">在星图继续对话</button>`).join('')}
    ${links.length?'<p>跳转只打开材料；抽取、修改和发布仍需在星图中确认。</p>':''}</section>`;
 }
 async function dialogue(data){
  const captured=context(),id=active,warehouseId=getContext().warehouseId;
  if(!personal||!id)return;
  const w=await call('material-workflow',{warehouseId,documentId:id});
  if(contextKey()!==captured||active!==id)return;
  if(w.document_id!==id)throw Error('TEAM_DATA_RESPONSE_INVALID');
  const link=data.conversation?w.conversations.find(l=>l.conversation_id===data.conversation&&l.intent_id===data.intent&&l.conversation_status==='active'):null;
  if(data.conversation&&!link)throw Error('MODELING_SOURCE_CHANGED');
  await call('open-starlink',{warehouseId,view:'conversation',documentId:id,...(link?{conversationId:link.conversation_id,intentId:link.intent_id}:{})});
 }
 async function action(name,data){
  if(name==='reextract-document'&&personal){context();if(active!==data.id)await open(data.id);const n=cache.get(data.id);if(n?.workflow&&!n.loading&&n.workflow.actions.prepare_automatic.allowed)await automatic.prepare(data.id);return true;}
  if(!name.startsWith('material-'))return false;context();if(await automatic.action(name))return true;if(name==='material-dialogue'){await dialogue(data);return true}if(name==='material-edit'){if(!personal||cache.get(active)?.workflow?.actions?.edit_source?.allowed)await edit();return true}if(name==='material-save'){await save();return true}if(name==='material-cancel'){const d=drafts.get(active);if(d?.saving)return true;if(globalThis.confirm?.('放弃此草稿并重新读取服务端版本？原文件不会被删除。')===false)return true;drafts.delete(active);await open(active);return true}if(name==='material-open')await open(data.id);else if(name==='material-more'&&active)await open(active,true);else if(name==='material-folder'){collapsed.has(data.type)?collapsed.delete(data.type):collapsed.add(data.type);changed()}else if(name==='material-close'){if(drafts.has(data.id)){if(drafts.get(data.id).saving)return true;if(globalThis.confirm?.('关闭后保留本次会话的编辑草稿，重新打开可继续。')===false)return true}if(active===data.id){sequence++;automatic.reset();}cache.delete(data.id);tabs=tabs.filter(id=>id!==data.id);if(active===data.id){active=tabs.at(-1)||null;if(active)await open(active)}changed()}return true}
 globalThis.window?.addEventListener?.('beforeunload',event=>{if(drafts.size||[...archives.values()].some(m=>m.size)){event.preventDefault();event.returnValue='';}});
 return {render,action,reset,input,remove(id){automatic.reset();sequence++;cache.delete(id);drafts.delete(id);for(const saved of archives.values())saved.delete(id);tabs=tabs.filter(value=>value!==id);if(active===id)active=null;changed()},hasDrafts:()=>drafts.size>0,filter(value){query=String(value);changed()}};
}
