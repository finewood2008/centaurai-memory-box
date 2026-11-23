const fail=code=>Object.assign(Error(code),{code});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selectedDocument=f=>f.state.librarySelection?.document.id||f.state.detail?.document_id;

export function canDeleteMaterial(f){
  return !!f?.state.loaded&&!f.state.busy&&!!selectedDocument(f)&&
    !f.saved.pending&&!f.saved.upload&&!f.saved.intakeSubmission&&!f.saved.roundOpening&&!f.intake.staged&&
    !f.reviewPending&&!f.claimPending&&!f.releasePending&&!f.changes.pending&&!f.changes.record.pending&&!f.changes.claimRequest;
}

// Keep receipts outside the conversation write queue: this is a warehouse-scoped
// document deletion, not cancellation of one conversation's processing intent.
export function deleteMaterial(f,target){return f.run(async()=>{
  let pending=f.saved.materialDeletion;
  if(!pending){
    if(!f.state.loaded||target.documentId!==selectedDocument(f)||
      f.saved.pending||f.saved.upload||f.saved.intakeSubmission||f.saved.roundOpening||f.intake.staged||
      f.reviewPending||f.claimPending||f.releasePending||f.changes.pending||f.changes.record.pending||f.changes.claimRequest)throw fail('MODELING_REQUEST_PENDING');
    const references=Object.entries({...f.state.materialIndex,[f.saved.conversationId]:f.state.intents})
      .flatMap(([session,items])=>(items||[]).filter(i=>i.document_id===target.documentId).map(i=>({session,intentId:i.id})));
    pending={documentId:target.documentId,name:target.name,operationId:f.uuid(),references};
    f.saved.materialDeletion=pending;
  }
  // Persist before transport, including retries after response loss or reload.
  f.persist();
  let result;
  try{result=await f.read('workbench-request',{url:`/api/documents/${encodeURIComponent(pending.documentId)}?confirm=true`,method:'DELETE',body:JSON.stringify({operation_id:pending.operationId})});}
  catch(e){
    if([400,401,403,409,422].includes(e.status)){delete f.saved.materialDeletion;f.persist();}
    throw e;
  }
  if(!result||result.status!=='committed'||result.document?.id!==pending.documentId)throw fail('SEMANTICA_INVALID_RESPONSE');
  const groups={...f.state.materialIndex,[f.saved.conversationId]:f.state.intents};
  const removed=new Set(),sessions=new Set(),composerKeys=new Set();
  for(const ref of pending.references||[]){removed.add(ref.intentId);sessions.add(ref.session);composerKeys.add(ref.session+':'+ref.intentId);}
  for(const [session,items] of Object.entries(groups))for(const item of items||[]){
    if(item.document_id===pending.documentId){removed.add(item.id);sessions.add(session);composerKeys.add(session+':'+item.id);}
  }
  f.saved.deletedDocuments={...f.saved.deletedDocuments,[pending.documentId]:true};
  if(f.importer?.view?.documentId===pending.documentId)f.importer.view=null;
  if(f.state.importDocumentId===pending.documentId)f.state.importDocumentId=null;
  delete f.saved.importReviews?.[pending.documentId];
  delete f.saved.materialOperations?.[pending.documentId];f.state.materialOperation=null;f.state.reviewingSource=false;
  for(const [id,context] of Object.entries(f.saved.materialContinuations||{}))if(context.documentId===pending.documentId){
    removed.add(id);removed.add(context.fromIntent);sessions.add(context.conversationId);
    composerKeys.add(context.conversationId+':'+id);composerKeys.add(context.conversationId+':'+context.fromIntent);
    delete f.saved.materialContinuations[id];
  }
  for(const [id,next] of Object.entries(f.saved.resumedIntents||{}))if(removed.has(id)||removed.has(next))delete f.saved.resumedIntents[id];
  if(f.saved.materialContinuationRequest?.documentId===pending.documentId)delete f.saved.materialContinuationRequest;
  for(const key of ['intakeReviews','confirmedGoals','autoRead'])for(const id of removed)if(f.saved[key])delete f.saved[key][id];
  for(const key of Object.keys(f.saved.analyzed||{}))if([...removed].some(id=>key===id||key.startsWith(id+':')))delete f.saved.analyzed[key];
  for(const key of composerKeys)if(f.saved.materialComposers)delete f.saved.materialComposers[key];
  for(const key of Object.keys(f.changes.saved.scopes)){
    try{const [,id]=JSON.parse(key);if(removed.has(id))delete f.changes.saved.scopes[key];}catch{}
  }
  for(const session of sessions)if(removed.has(f.saved.selection?.[session]))delete f.saved.selection[session];
  // Detach the workspace from the deleted material's server conversation.
  // Clearing bubbles alone is insufficient: snapshot() would immediately
  // reload accepted user messages, which also remain in model context.
  f.saved.deletedMaterialConversations??={};
  for(const session of sessions){
    const items=groups[session];
    if(items?.length&&items.every(i=>removed.has(i.id)))f.saved.deletedMaterialConversations[session]=true;
  }
  f.saved.conversationId=null;f.saved.emptyMaterialWorkspace=true;
  if(f.saved.libraryDocumentId===pending.documentId)delete f.saved.libraryDocumentId;
  f.state.conversations=f.state.conversations.filter(c=>!f.saved.deletedMaterialConversations[c.id]);
  // Clear all displayed source and goals before any refresh can fail.
  f.clearView();
  for(const [session,items] of Object.entries(groups))f.state.materialIndex[session]=(items||[]).filter(i=>i.document_id!==pending.documentId);
  f.state.documents=f.state.documents.filter(d=>d.id!==pending.documentId);
  f.state.deletionNotice=`“${pending.name}”删除已受理。材料相关的知识图谱与索引由后台清理，进度及失败重试请查看任务中心。`;
  delete f.saved.materialDeletion;
  try{f.changes.persist();f.persist();}
  catch(e){f.saved.materialDeletion=pending;throw e;}
  f.emit();
  try{await f.snapshot();await f.readMaterialIndex();}
  catch{f.check();f.state.error='删除已受理，但最新状态读取失败，请重新读取进度。';}
},{allowDeletion:true});}

export function openMaterialDelete(f,onAccepted=()=>{}){
  if(document.getElementById('mw-delete-dialog')||(!f.saved.materialDeletion&&!canDeleteMaterial(f)))return;
  const target=f.saved.materialDeletion||{documentId:selectedDocument(f),name:f.state.librarySelection?.document.original_name||f.state.intents.find(i=>i.id===f.state.selectedIntent)?.original_name||'当前材料'};
  const dialog=document.createElement('dialog');dialog.id='mw-delete-dialog';dialog.className='mw-upload-dialog';dialog.setAttribute('aria-labelledby','mw-delete-title');
  let working=false;
  const close=()=>{dialog.close();dialog.remove();};
  const render=()=>{dialog.innerHTML=`<header><h2 id="mw-delete-title">确认删除材料</h2></header><div class="mw-upload-body"><strong>${esc(target.name)}</strong><p>删除后将移除材料原件、解析正文、校对草稿，以及该材料在知识图谱中的事实和原文依据；其他材料仍有依据的共享知识保留。本体类型定义不受影响。</p><p>材料正在执行的处理会终止；关联此材料的其他会话也将无法继续使用其内容。未保存的本机修改会丢弃，此操作不可撤销。</p>${f.saved.materialDeletion?'<p role="status">上次删除结果尚未确认，将使用原操作号恢复，不会创建重复删除任务。</p>':''}${f.state.error?`<p role="alert">${esc(f.state.error)}</p>`:''}</div><footer><button class="btn btn-secondary" data-delete="cancel" ${working?'disabled':''}>取消</button><button class="btn btn-primary" data-delete="confirm" ${working?'disabled':''}>${working?'正在提交…':f.saved.materialDeletion?'恢复删除请求':'确认删除材料'}</button></footer>`;};
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(!working)close();});
  dialog.addEventListener('click',async e=>{
    const button=e.target.closest('[data-delete]');if(!button||working||button.disabled)return;
    if(button.dataset.delete==='cancel'){close();return;}
    working=true;render();await deleteMaterial(f,target);working=false;
    if(!dialog.isConnected||!f.live||!f.isCurrent())return;
    if(!f.saved.materialDeletion&&f.saved.deletedDocuments?.[target.documentId]){close();onAccepted();}else render();
  });
  document.body.append(dialog);render();dialog.showModal();dialog.querySelector('[data-delete="cancel"]').focus();
}
