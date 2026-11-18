import {pendingMaterialDraft,publishedMaterial,currentMaterialWorkflow} from './material-state.mjs';
import {publicationCurrent,knowledgeCurrent,materialSourceUsable} from './conversation-progress.mjs';
import {materialProcessingActive} from './material-agent.mjs';
const fail=code=>Object.assign(Error(code),{code});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(action,label,off=false,id='')=>`<button class="btn btn-secondary" data-cv="${action}" data-id="${esc(id)}" ${off?'disabled':''}>${label}</button>`;
const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN'):'';
const active=w=>w.tasks?.some(t=>['queued','running','publishing'].includes(t.status));
export function roundLinks(w){
  const seen=new Set();return (w.conversations||[]).filter(l=>{if(seen.has(l.conversation_id))return false;seen.add(l.conversation_id);return true;});
}
export function unfinishedRound(f,w){
  // Filter intents before deduplicating conversations: an obsolete intent can
  // sort ahead of the current intent after a goal continuation or source edit.
  const eligible=(w.conversations||[]).filter(l=>l.round_read_only!==true&&l.conversation_status==='active'&&!f.saved.resumedIntents?.[l.intent_id]&&!['history','completed'].includes(f.saved.dialogueRounds?.[l.conversation_id]?.status)&&l.status!=='stale'&&(l.status!=='cancelled'||l.execution_status==='awaiting_review')&&(!l.document_version_id||l.document_version_id===w.document_version_id));
  // A remembered selection can be an empty intent in the same conversation.
  // Check every eligible execution before collapsing that conversation.
  const reviewing=eligible.find(l=>l.execution_status==='awaiting_review');
  if(reviewing)return reviewing;
  const links=roundLinks({conversations:eligible}).map(l=>eligible.find(v=>v.conversation_id===l.conversation_id&&v.intent_id===(f.saved.dialogueRounds?.[l.conversation_id]?.intentId||f.saved.selection?.[l.conversation_id]))||l);
  const local=links.find(l=>f.saved.dialogueRounds?.[l.conversation_id]?.status==='open');
  if(local)return local;
  // Material-wide review (especially automatic extraction) is not evidence
  // that any linked chat still has work. Legacy drafts retain their flow.
  if(w.processing_mode==='automatic')return null;
  if(pendingMaterialDraft(w))return links[0]||null;
  // A material's published baseline does not close a newly started local round.
  // Older servers have no round lifecycle: completed legacy chats are history.
  return !publishedMaterial(w)?links.find(l=>!['cancelled','stale','completed','published'].includes(l.status))||null:null;
}
export class MaterialRounds{
  constructor(flow){this.f=flow;this.choice=null;this.history=null;}
  clear(){this.choice=null;this.history=null;}
  reconcile(w){
    const c=this.choice;if(!c||c.documentId!==w.document_id)return;
    const previous=c.previous&&unfinishedRound(this.f,w);
    if(c.versionId!==w.document_version_id||c.previous&&(previous?.conversation_id!==c.previous.conversation_id||previous?.intent_id!==c.previous.intent_id)||c.draft&&!pendingMaterialDraft(w))this.choice=null;
  }
  async validate(item,{creating=true}={}){
    const w=await this.f.read('conversation-material-workflow',{documentId:item.documentId});
    if(w.document_id!==item.documentId||w.document?.id!==item.documentId||w.document_version_id!==item.versionId)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(!Array.isArray(w.tasks)||!Array.isArray(w.conversations))throw fail('SEMANTICA_INVALID_RESPONSE');
    if(active(w)||materialProcessingActive(this.f,w))throw fail('MODELING_MATERIAL_BUSY');
    // prepare_dialogue authorizes association with the current source. Legacy
    // start_dialogue instead describes whether there is a session to resume.
    if(creating){
      const capability=w.actions?.start_new_dialogue??w.actions?.prepare_dialogue;
      if(capability?.allowed===false)throw fail('MODELING_MATERIAL_UNAVAILABLE');
      if(capability&&capability.allowed!==true)throw fail('SEMANTICA_INVALID_RESPONSE');
      if(!capability&&w.actions?.start_dialogue?.allowed!==true)throw fail('MODELING_ROUND_UPGRADE_REQUIRED');
    }
    if(!item.versionId||w.document.status!=='ready')throw fail('MODELING_SOURCE_NOT_READY');
    return w;
  }
  bound(item){
    const f=this.f,d=f.state.detail;
    if(f.saved.conversationId!==item.conversationId||f.state.selectedIntent!==item.intentId||d?.id!==item.intentId||d.document_id!==item.documentId||d.document_version_id!==item.versionId||!materialSourceUsable(d)||f.state.overview?.status!=='active')throw fail('MODELING_SNAPSHOT_CHANGED');
  }
  async enter(){
    const f=this.f;if(!await f.importer.refreshReady(true))return;
    const w=f.importer.view.workflow;
    if(active(w)||materialProcessingActive(f,w))return f.run(async()=>{throw fail('MODELING_MATERIAL_BUSY');});
    const previous=unfinishedRound(f,w);
    this.offer(w,previous);
    if(previous||this.choice.draft)return;
    return this.start();
  }
  offer(w,previous){
    this.choice={documentId:w.document_id,versionId:w.document_version_id,previous,draft:pendingMaterialDraft(w)};
    this.f.emit();
  }
  async start(){
    const f=this.f,c=this.choice;if(!c||f.state.busy||f.importer.blocked)return;
    let w;
    await f.run(async()=>{await f.ready();w=await this.validate(c);f.state.documents=[w.document];});
    if(!w||f.state.error)return;
    await f.intake.stageDocument(c.documentId);
    if(f.intake.staged?.documentId!==c.documentId)return;
    await f.intake.submit({newRound:{documentId:c.documentId,versionId:c.versionId,baselineRunId:w.publication?.id||null,createdAt:new Date().toISOString()},note:''});
  }
  register(intentId,item){
    const f=this.f,r=item.newRound;if(!r)return;
    this.clear();
    f.saved.dialogueRounds??={};
    for(const old of Object.values(f.saved.dialogueRounds))if(old.documentId===r.documentId&&old.status==='open')old.status='history';
    f.saved.dialogueRounds[item.conversationId]={...r,conversationId:item.conversationId,intentId,status:'open',completedReceipts:r.baselineRunId?[`run:${r.baselineRunId}`]:[]};
    f.saved.roundOpening={conversationId:item.conversationId,intentId,documentId:r.documentId,versionId:r.versionId};
    f.saved.autoRead[intentId]=false;
  }
  async finish(){
    const f=this.f,r=f.saved.roundOpening;if(!r||f.state.busy||f.saved.pending)return;
    await f.run(async()=>{
      // This association has already committed. Creating another round may now
      // be forbidden; completing navigation only requires the existing binding.
      const w=await this.validate(r,{creating:false});
      if(!w.conversations.some(l=>l.conversation_id===r.conversationId&&l.intent_id===r.intentId&&l.conversation_status==='active'&&l.round_read_only!==true))throw fail('MODELING_SNAPSHOT_CHANGED');
      await f.snapshot();this.bound(r);
      f.state.librarySelection=null;f.state.importDocumentId=null;
      f.agent.clearAutomaticContext();f.state.dialogueExitNotice=null;
      await f.agent.syncDialogue();this.bound(r);
      if(f.state.dialogueWorkflow?.document_version_id!==r.versionId||!f.state.dialogueWorkflow.conversations?.some(l=>l.conversation_id===r.conversationId&&l.intent_id===r.intentId&&l.conversation_status==='active'&&l.round_read_only!==true))throw fail('MODELING_SNAPSHOT_CHANGED');
      const intake=f.intake.record;
      if(intake){intake.versionId=r.versionId;intake.stage='goal';intake.confirmed=true;await f.intake.sync();}
      f.state.inputNotice=pendingMaterialDraft(w)?'已开始新一轮对话。材料草稿保留；继续编辑前需确认接管，旧对话及确认不会带入本轮。':'已开始新一轮对话。请说明本轮要求；历史对话、目标和确认不会自动带入。';
      delete f.saved.roundOpening;
      try{f.persist();}catch(e){f.saved.roundOpening=r;throw e;}
      f.state.loaded=true;f.state.materialPage='dialogue';this.choice=null;
    });
    if(!f.state.error&&pendingMaterialDraft(f.state.dialogueWorkflow))await f.changes.openDraft();
  }
  async resume(){
    const f=this.f,c=this.choice,l=c?.previous;if(!l||f.state.busy||f.importer.blocked)return;
    let verified=false;
    await f.run(async()=>{
      const w=await this.validate(c,{creating:false}),latest=unfinishedRound(f,w);
      if(latest?.conversation_id!==l.conversation_id||latest.intent_id!==l.intent_id)throw fail('MODELING_SNAPSHOT_CHANGED');
      verified=true;
    });
    if(!verified||f.state.error)return;
    await f.selectMaterial(l.conversation_id,l.intent_id);if(f.state.error)return;
    await f.run(async()=>{
      await f.snapshot();this.bound({...c,conversationId:l.conversation_id,intentId:l.intent_id});
      const w=await this.validate(c,{creating:false});
      if(unfinishedRound(f,w)?.intent_id!==l.intent_id)throw fail('MODELING_SNAPSHOT_CHANGED');
      await f.agent.syncDialogue();
      if(f.state.dialogueWorkflow?.document_version_id!==c.versionId||unfinishedRound(f,f.state.dialogueWorkflow)?.intent_id!==l.intent_id)throw fail('MODELING_SNAPSHOT_CHANGED');
      f.agent.clearAutomaticContext();f.state.dialogueExitNotice=null;f.state.librarySelection=null;f.state.importDocumentId=null;
      await f.changes.context();f.state.materialPage='dialogue';this.choice=null;
    });
    if(!f.state.error&&!f.changes.independent&&pendingMaterialDraft(f.state.dialogueWorkflow))await f.changes.openDraft();
    if(!f.state.error)f.state.inputNotice='已继续上轮对话，保留该轮的要求、消息和未完成工作。';f.emit();
  }
  sync(){
    const f=this.f,r=f.saved.dialogueRounds?.[f.saved.conversationId];if(!r||r.status!=='open')return;
    r.intentId=f.state.selectedIntent;
    const summary=f.changes.state.summary;
    const receipts=this.publicationReceipts(),seen=new Set([...(r.completedReceipts||[]),r.completedReceipt,r.baselineRunId&&`run:${r.baselineRunId}`].filter(Boolean));
    const unresolved=summary?.status==='editing'||f.changes.state.proposals.some(p=>p.id!==f.changes.record.deferredProposal&&['generating','prepared','needs_clarification','failed','stale'].includes(p.status));
    if(receipts.some(receipt=>!seen.has(receipt))&&!unresolved){r.status='completed';r.completedReceipts=[...new Set([...seen,...receipts])];}
  }
  publicationReceipts(){
    const f=this.f,d=f.state.detail;
    // One canonical run receipt prevents the draft receipt and intent receipt
    // for a previous publication from looking like two distinct completions.
    return publicationCurrent(d)||knowledgeCurrent(d,f.state.knowledge)?[`run:${d.outcome.current_run_id}`]:[];
  }
  touch(action){
    const r=this.f.saved.dialogueRounds?.[this.f.saved.conversationId];
    if(r&&['conversation-send','conversation-goal','conversation-analyze','conversation-change-generate','conversation-change-apply','conversation-change-draft-create'].includes(action)){
      r.completedReceipts=[...new Set([...(r.completedReceipts||[]),r.completedReceipt,...this.publicationReceipts()].filter(Boolean))];r.status='open';this.f.persist();
    }
  }
  retire(documentId){
    const f=this.f,w=currentMaterialWorkflow(f);f.saved.dialogueRounds??={};
    if(w?.document_id===documentId)for(const l of roundLinks(w))f.saved.dialogueRounds[l.conversation_id]??={documentId,conversationId:l.conversation_id,intentId:l.intent_id,status:'history'};
    for(const r of Object.values(f.saved.dialogueRounds))if(r.documentId===documentId&&r.status==='open')r.status='history';
    this.choice=null;
  }
  async abandonOpening(){
    const f=this.f;if(f.state.busy)return;let documentId=null;
    await f.run(async()=>{
      if(f.saved.pending||f.saved.upload||f.reviewPending||f.claimPending||f.releasePending||f.changes.pending||f.changes.record.pending||f.changes.claimRequest)throw fail('MODELING_REQUEST_PENDING');
      const submission=f.saved.intakeSubmission,opening=f.saved.roundOpening,item=submission?.newRound||opening;if(!item)return;
      delete f.saved.intakeSubmission;delete f.saved.roundOpening;
      try{f.persist();}catch(e){f.saved.intakeSubmission=submission;f.saved.roundOpening=opening;throw e;}
      documentId=item.documentId;
    });
    if(documentId&&!f.state.error)await f.importer.select(documentId);
  }
  openHistory(){return this.f.run(async()=>{
    const f=this.f,documentId=f.agent.documentId;if(!documentId)return;
    this.history=null;
    const w=await f.read('conversation-material-workflow',{documentId});
    if(w.document_id!==documentId)throw fail('MODELING_SNAPSHOT_CHANGED');
    this.history={documentId,links:roundLinks(w),messages:null,selected:null};
  });}
  viewHistory(conversationId){return this.f.run(async()=>{
    const h=this.history,f=this.f;if(!h?.links.some(l=>l.conversation_id===conversationId))return;
    h.messages=null;h.selected=null;
    const intents=await f.all('conversation-intents',{conversationId});
    if(!intents.some(i=>i.document_id===h.documentId))throw fail('MODELING_RESOURCE_NOT_FOUND');
    const messages=await f.all('conversation-messages',{conversationId},true);
    if(this.history!==h||h.documentId!==f.agent.documentId)throw fail('MODELING_SNAPSHOT_CHANGED');
    h.selected=conversationId;h.messages=messages;
  });}
}
export function materialRoundsHTML(f){
  const r=f?.rounds;if(!r)return '';const off=f.state.busy||f.importer.blocked,c=r.choice,h=r.history;
  const choice=c&&c.documentId===f.agent.documentId?`<section class="mw-round-choice cv-notice"><h3>继续上轮，还是开始新一轮？</h3><p>${c.draft?'当前材料有未发布草稿，开始新一轮仍保留草稿内容；编辑前需要确认接管。':'上轮尚有未完成工作。继续上轮会恢复该轮对话；新一轮会隔离旧消息和旧意图。'}开始新一轮不会自动发布、抽取或丢弃草稿。</p>${c.previous?button('round-resume','继续上轮对话',off):''}${button('round-start',c.draft?'保留草稿，开始新一轮':'开始新一轮对话',off)}${button('round-cancel','暂不进入',off)}</section>`:'';
  const history=h&&h.documentId===f.agent.documentId?`<section class="mw-round-history"><header><h3>历史对话 · 只读</h3>${button('round-history-close','收起历史',f.state.busy)}</header><p>这里只读展示聊天消息，不会切换当前会话或作为本轮指令。旧会话可能包含多份材料；已保存草稿与发布结果可在材料历史中查看。</p>${h.links.map((l,i)=>button('round-history-view',`${i+1}. ${esc(time(f.saved.dialogueRounds?.[l.conversation_id]?.createdAt)||'材料对话')} · ${l.conversation_id===f.saved.conversationId?'当前轮':'历史轮'}`,f.state.busy,l.conversation_id)).join('')||'<p>暂无历史对话。</p>'}${h.messages?`<div class="mw-round-transcript">${h.messages.map(m=>`<article><strong>${m.role==='user'?'你':'整理助手'}</strong><small> ${esc(time(m.created_at))}</small><p>${esc(historyText(m))}</p></article>`).join('')||'<p>该会话尚无消息记录。</p>'}</div>`:''}</section>`:'';
  const opening=f.saved.roundOpening||f.saved.intakeSubmission?.newRound;
  const recovery=opening&&!f.saved.pending?`<p class="cv-notice">新一轮对话尚未进入。${button('round-finish','继续进入',f.state.busy)}${button('round-abandon','返回材料处理',f.state.busy)}</p>`:'';
  return recovery+choice+history;
}
function historyText(message){
  const content=message.content;
  if(message.role==='user')return typeof content==='string'?content:'';
  let reply=message.reply;
  if(!reply&&typeof content==='string'){try{reply=JSON.parse(content);}catch{return content;}}
  if(reply&&typeof reply==='object')return [reply.answer,...(Array.isArray(reply.questions)?reply.questions:[])].filter(v=>typeof v==='string').join('\n');
  return typeof content==='string'?content:'该历史答复内容不可用。';
}
