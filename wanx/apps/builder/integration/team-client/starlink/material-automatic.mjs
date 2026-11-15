import {assertWorkflow,assertPreview,invalid,materialErrorText,materialRequest} from './material-contract.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const terminal=new Set(['published','failed','cancelled','stale','awaiting_review']);
const stages={queued:'等待自动处理',running:'正在抽取和校验',publishing:'正在发布',published:'本轮结果已发布',failed:'自动处理失败，原发布结果保留',cancelled:'自动处理已取消，原发布结果保留',stale:'本轮处理已失效，请读取当前材料状态',awaiting_review:'这是旧策略任务，仍需按原流程核对'};

// A pending confirmation is saved before the first POST. Reconnection replays
// exactly that request, including its acknowledgement, even after preview expiry.
export function createMaterialAutomatic({call,changed,getContext,onDenied=()=>{},getStorage=()=>globalThis.localStorage,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let state=null,generation=0,timer;
  const contextKey=()=>JSON.stringify(getContext());
  const journalKey=documentId=>{
    const c=getContext();
    if(!c.recoveryScope)throw Object.assign(Error('MATERIAL_RECOVERY_UNAVAILABLE'),{code:'MATERIAL_RECOVERY_UNAVAILABLE'});
    return 'wanx.material-automatic:'+JSON.stringify([c.recoveryScope,c.warehouseId,documentId]);
  };
  function storage(){const s=getStorage();if(!s)throw Error('MATERIAL_RECOVERY_UNAVAILABLE');return s;}
  function read(documentId){try{
    const v=JSON.parse(storage().getItem(journalKey(documentId))||'null');
    if(v){materialRequest('material-transition',v.input);if(v.input.documentId!==documentId||v.input.warehouseId!==getContext().warehouseId)throw Error();}
    return v;
  }catch{throw Object.assign(Error('MATERIAL_RECOVERY_UNAVAILABLE'),{code:'MATERIAL_RECOVERY_UNAVAILABLE'});}}
  function write(value){try{storage().setItem(journalKey(state.documentId),JSON.stringify(value));}
    catch{throw Object.assign(Error('MATERIAL_RECOVERY_UNAVAILABLE'),{code:'MATERIAL_RECOVERY_UNAVAILABLE'});}}
  function clear(){storage().removeItem(journalKey(state.documentId));}
  function reset(){generation++;clearTimer(timer);timer=null;state=null;}
  function live(s,g,c){return state===s&&generation===g&&contextKey()===c;}
  async function run(fn){
    if(!state||state.busy)return;
    const s=state,g=generation,c=contextKey();s.busy=true;s.error='';changed();
    const current=()=>live(s,g,c);
    try{await fn(s,current);}catch(e){if(current()){
      s.error=materialErrorText(e);
      if(e.code==='MATERIAL_RECOVERY_UNAVAILABLE')s.error='无法保存或读取恢复记录，请检查本地存储；未发送新的确认请求。';
      if(/MATERIAL_PROCESSING_PREVIEW_(STALE|EXPIRED)$/.test(e.code||'')) {
        clear();s.pending=null;s.preview=null;s.needsPreview=true;
        s.error='材料、模型或处理配置已变化，或预览已过期。请重新预览并确认。';
      }
      if(e.httpStatus===401||e.httpStatus===403||e.httpStatus===404||/FORBIDDEN|SESSION|OWNER_REQUIRED|RESOURCE_NOT_FOUND/.test(e.code||'')){
        s.preview=null;s.receipt=null;s.progress=null;s.denied=true;
        onDenied(s.documentId,e);
      }
    }}finally{if(current()){s.busy=false;changed();}}
  }
  function validateReceipt(result,s){
    const r=result?.receipt;
    if(!r||r.document_id!==s.documentId||r.target_mode!=='automatic'||typeof r.transition_id!=='string'||!r.transition_id||
      (s.pending&&(r.operation_id!==s.pending.operationId||r.preview_id!==s.pending.previewId))||
      (s.receipt&&r.transition_id!==s.receipt.transition_id))invalid(result);
    return r;
  }
  async function poll(s,current){
    const value=await call('material-transition-status',{warehouseId:getContext().warehouseId,documentId:s.documentId,transitionId:s.receipt.transition_id});
    if(!current())return;
    const receipt=validateReceipt(value,s),p=value.current;
    if(!p||!Object.hasOwn(stages,p.stage)||typeof p.is_current!=='boolean'||typeof p.publication_performed!=='boolean'||
      (p.stage==='published'&&(!p.is_current||!p.publication_performed)))invalid(value);
    s.receipt=receipt;s.progress=p;s.denied=false;
    if(s.pending){clear();s.pending=null;}
    clearTimer(timer);
    if(!terminal.has(p.stage))timer=setTimer(()=>{if(current())void run(poll);},3000);
  }
  async function send(s,current){
    const value=await call('material-transition',s.pending);
    if(!current())return;
    s.receipt=validateReceipt(value,s);s.preview=null;
    // Keep the exact request until the independently authorized status read succeeds.
    await poll(s,current);
  }
  async function restore(documentId,w){
    reset();state={documentId,busy:false};
    await run(async(s,current)=>{
      const saved=read(documentId);
      if(saved){s.pending=saved.input;s.error='上次自动处理的提交结果待确认，请恢复原请求。';return;}
      if(w.latest_transition_id&&w.processing_mode!=='dialogue'){s.receipt={transition_id:w.latest_transition_id};await poll(s,current);}
    });
    return !state?.denied;
  }
  async function prepare(documentId){
    if(state?.busy)return;
    if(state?.documentId!==documentId){reset();state={documentId,busy:false};}
    await run(async(s,current)=>{
      const saved=read(documentId);
      if(saved){s.pending=saved.input;s.error='上次提交尚未确认，请先恢复原请求。';return;}
      if(s.receipt&&!terminal.has(s.progress?.stage)){await poll(s,current);return;}
      const warehouseId=getContext().warehouseId;
      const w=assertWorkflow(await call('material-workflow',{warehouseId,documentId}),documentId);
      if(!current())return;
      s.denied=false;s.preview=null;s.receipt=null;s.progress=null;
      if(!w.actions.prepare_automatic.allowed){s.error=w.actions.prepare_automatic.reason||'当前材料不允许进入自动处理预览。';return;}
      const operationId=crypto.randomUUID();
      const p=await call('material-preview',{warehouseId,documentId,operationId,versionId:w.document_version_id,workflowRevision:w.workflow_revision});
      if(!current())return;
      s.preview=assertPreview(p,w,operationId);s.needsPreview=false;
    });
  }
  async function confirm(){await run(async(s,current)=>{
    if(s.denied)return;
    if(s.pending){await send(s,current);return;}
    const p=s.preview;
    if(s.denied||!p?.can_confirm||p.blockers.length)return;
    const saved=read(s.documentId);
    if(saved){s.pending=saved.input;s.preview=null;s.error='已有尚未确认的提交，请先恢复原请求。';return;}
    if(Date.now()>=Date.parse(p.expires_at)){s.preview=null;s.needsPreview=true;s.error='预览已过期，请重新预览并确认。';return;}
    // This handler is reached only through the explicit button below the impact.
    const input={warehouseId:getContext().warehouseId,documentId:s.documentId,operationId:crypto.randomUUID(),previewId:p.preview_id,previewDigest:p.preview_digest,workflowRevision:p.workflow_revision,confirmed:true,
      ...(p.replacement.requires_acknowledgement?{replacementAcknowledgement:p.replacement.acknowledgement_digest}:{})};
    write({input});s.pending=input;await send(s,current);
  });}
  function render(documentId){
    const s=state;if(!s||s.documentId!==documentId)return '';
    const p=s.preview,r=p?.replacement;
    return `<section class="data-material-automatic" aria-label="自动处理预览与进度">
      ${s.error?`<p role="alert">${esc(s.error)}</p>`:''}
      ${p?`<h3>自动处理当前材料</h3><p>使用当前正文及仓内已发布本体，按本次模型配置抽取、校验后自动发布。使用在线模型时，正文片段将发送到该服务并产生用量。</p>
      ${r?`<p>旧草稿 ${esc(r.draft_count)} 份（人工修改 ${esc(r.modified_draft_count)} 份）；旧候选 ${esc(r.candidate_result_count)} 份（人工修改 ${esc(r.modified_candidate_result_count)} 份）。</p><p>${r.replaces_manual_publication?'本轮成功后将替换历史人工发布成果。':''}${r.preserves_history?'旧草稿和候选保留为历史。':''}失败或取消时保留原发布结果。</p><p>${esc(r.description)}</p>`:''}
      ${p.blockers.map(b=>`<p role="alert">${esc(b.detail)}（${esc(b.code)}）</p>`).join('')}
      <button class="button primary" data-data-action="material-auto-confirm" ${s.busy||!p.can_confirm||p.blockers.length?'disabled':''}>${r?.requires_acknowledgement?'确认替换影响并开始自动处理':'确认并开始自动处理'}</button>
      <button class="button" data-data-action="material-auto-dismiss" ${s.busy?'disabled':''}>取消</button>`:''}
      ${s.progress?`<p role="status">${esc(stages[s.progress.is_current?s.progress.stage:'stale'])}</p>${s.progress.error?`<p>${esc(s.progress.error.detail)}（${esc(s.progress.error.code)}）</p>`:''}`:''}
      ${s.pending&&!s.denied?`<button class="button" data-data-action="material-auto-confirm" ${s.busy?'disabled':''}>恢复原确认请求</button>`:''}
      ${s.receipt&&!s.denied?`<button class="button" data-data-action="material-auto-status" ${s.busy?'disabled':''}>刷新处理进度</button>`:''}
      ${s.needsPreview||p&&!p.can_confirm?`<button class="button" data-data-action="material-auto-preview" ${s.busy?'disabled':''}>重新预览</button>`:''}
      ${s.busy?'<p role="status">正在读取或提交处理状态…</p>':''}</section>`;
  }
  async function action(name){
    if(!name.startsWith('material-auto-'))return false;
    if(name==='material-auto-confirm')await confirm();
    else if(name==='material-auto-status')await run(poll);
    else if(name==='material-auto-preview'&&state)await prepare(state.documentId);
    else if(name==='material-auto-dismiss'&&state&&!state.busy&&!state.pending){state.preview=null;changed();}
    return true;
  }
  return {prepare,restore,reset,render,action};
}
