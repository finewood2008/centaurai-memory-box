import {retainedMaterialResults} from './conversation-progress.mjs';
const fail=code=>Object.assign(Error(code),{code});
export function canContinueMaterial(f){const d=f?.state.detail;
  return !!d?.document_id&&!!d.document_version_id&&d.status==='cancelled'&&d.source_status==='available'&&!f.saved.deletedDocuments?.[d.document_id];
}
export function stoppedMaterialCard(f){
  const d=f.state.detail;
  if(d?.document_id&&(d.status==='stale'||d.source_status==='changed')&&!f.saved.deletedDocuments?.[d.document_id]){
    const off=f.state.busy||!f.state.loaded||!!f.saved.pending||!!f.saved.materialDeletion;
    return `<section class="cv-material-continuation"><h3>上次处理依据已变化</h3><p>旧会话的目标、计划或正文版本已失效，不代表材料已删除。请读取当前材料状态，再选择继续修改已有结果或重新抽取。</p><button class="btn btn-primary" data-cv="material-current" ${off?'disabled':''}>读取当前材料，继续处理</button><p>不会自动采用旧目标，也不会直接抽取或发布。</p></section>`;
  }
  if(!canContinueMaterial(f)||retainedMaterialResults(f.state.detail))return '';
  const off=f.state.busy||!f.state.loaded||!!f.saved.pending||!!f.saved.materialDeletion||!!f.saved.upload||!!f.saved.intakeSubmission||!!f.intake.staged;
  const draft=f.state.detail.review?.draft_id||f.changes.record.draftId;
  return `<div class="cv-conversation-actions cv-material-continuation"><article class="cv-message cv-assistant cv-action-message"><header><strong>资料整理</strong><span>继续处理当前材料</span></header><div class="cv-action-body"><h3>本次处理已停止，材料仍然保留</h3><p>${draft?'已有核对草稿，可以继续修改、核对差异并确认发布。':'可以沿用这份材料和原整理目标，在当前页面重新核对处理计划。'}</p><p>无需重新上传或选择材料，历史对话和已有结果保留。</p>${draft?`<button class="btn btn-primary" data-cv="material-resume-draft" ${off?'disabled':''}>继续核对已有草稿</button>`:''}<button class="btn btn-secondary" data-cv="material-restart" ${off?'disabled':''}>重新开始处理</button><p>重新开始后先确认目标和计划，不会立即抽取或发布。</p></div></article></div>`;
}
export async function continueMaterial(f,mode){
  const original=f.state.selectedIntent;
  let continued=false;
  await f.run(async()=>{
    await f.ready();
    if(f.state.selectedIntent!==original||!canContinueMaterial(f)||!['draft','restart'].includes(mode))throw fail('MODELING_MATERIAL_UNAVAILABLE');
    if(f.saved.upload||f.saved.intakeSubmission||f.intake.staged)throw fail('MODELING_REQUEST_PENDING');
    const d=f.state.detail,draftId=d.review?.draft_id||f.changes.record.draftId;
    if(mode==='draft'&&!draftId)throw fail('MODELING_SOURCE_NOT_READY');
    const remembered=f.saved.confirmedGoals?.[d.id];
    f.saved.materialContinuationRequest={mode,fromIntent:d.id,conversationId:f.saved.conversationId,documentId:d.document_id,
      versionId:d.document_version_id,draftId:mode==='draft'?draftId:null,
      goal:f.state.goalDirty?f.state.goal:d.goal?.goal||remembered?.goal||f.state.goal||'',
      instructions:f.state.goalDirty?f.state.instructions:d.goal?.instructions??remembered?.instructions??f.state.instructions??''};
    await f.write('conversation-intent-create',{conversationId:f.saved.conversationId,revision:f.state.overview.revision,documentId:d.document_id},'material-continue');
    await f.snapshot();
    continued=true;
  });
  if(continued&&!f.state.error&&!f.saved.pending&&f.saved.materialContinuations?.[f.state.selectedIntent]?.mode==='draft')await f.changes.openDraft();
}
export function applyMaterialContinuation(f,p,result){
  const context=f.saved.materialContinuationRequest;
  if(!context||context.documentId!==p.input.documentId||context.conversationId!==p.input.conversationId||!result.resource_id||result.resource_id===context.fromIntent)throw fail('SEMANTICA_INVALID_RESPONSE');
  const id=result.resource_id;
  const reviewed=f.saved.intakeReviews?.[context.fromIntent];
  if(context.mode==='restart'&&reviewed){
    f.saved.intakeReviews={...f.saved.intakeReviews,[id]:{...structuredClone(reviewed),
      goalDraft:{goal:context.goal,instructions:context.instructions},goalNeedsConfirmation:true}};
  }
  f.saved.materialContinuations={...f.saved.materialContinuations,[id]:context};
  f.saved.resumedIntents={...f.saved.resumedIntents,[context.fromIntent]:id};
  f.saved.selection={...f.saved.selection,[context.conversationId]:id};
  f.saved.autoRead[id]=false;
  f.state.selectedIntent=id;f.state.detail=null;f.state.goalDirty=false;f.invalidateContext(true);
  if(context.ruleContinuation){
    f.saved.intakeReviews??={};
    const review=f.saved.intakeReviews[id]??={conversationId:context.conversationId,name:'当前材料',note:'',
      versionId:context.versionId,stage:context.sourceReviewed?'goal':'source',confirmed:!!context.sourceReviewed,
      goalDraft:{goal:context.goal,instructions:context.instructions},goalNeedsConfirmation:true};
    review.goalReplyPending=false;delete review.goalTurnId;
    f.changes.bind();f.changes.record.previousIntent=context.fromIntent;f.changes.record.changeTarget='goal';f.changes.persist();
    f.state.inspectCard='goal';f.state.composerContext='goal';
  }
  if(context.agentHandoff){
    f.saved.intakeReviews??={};
    const review=f.saved.intakeReviews[id]??={name:context.name,note:'',conversationId:context.conversationId};
    review.stage=context.editExisting?'goal':'source';review.confirmed=!!context.editExisting;review.versionId=context.versionId;delete review.goalTurnId;
    // New processing does not inherit the old model's goal or constraints.
    review.goalDraft={goal:'',instructions:''};review.note='';review.goalNeedsConfirmation=!context.editExisting;
    if(context.editExisting)f.state.openMaterialEditor=id;
    f.saved.autoRead[id]=!context.editExisting;
    delete f.saved.materialOperations?.[context.documentId];
    f.state.materialOperation=null;f.state.reviewingSource=false;
  }
  delete f.saved.materialContinuationRequest;
}
export function restoreMaterialContinuation(f){
  const d=f.state.detail,c=f.saved.materialContinuations?.[d?.id];
  if(!c||c.documentId!==d.document_id||d.source_status!=='available'||['cancelled','stale'].includes(d.status))return;
  if(c.versionId!==d.document_version_id&&c.mode==='draft'){
    if(f.changes.record.draftId===c.draftId){delete f.changes.record.draftId;f.changes.persist();}
    f.changes.resetView();f.changes.owner=null;
    c.mode='restart';c.draftId=null;
    f.saved.intakeReviews={...f.saved.intakeReviews,[d.id]:{name:d.original_name||'当前材料',note:c.instructions,conversationId:c.conversationId}};
  }
  if(c.mode==='draft'&&c.versionId===d.document_version_id){
    if(!f.changes.record.draftId){f.changes.record.draftId=c.draftId;f.changes.persist();}
  }
  if(d.status==='awaiting_goal'&&!d.goal?.goal&&!f.state.goalDirty){
    if(c.ruleContinuation){f.state.composerContext='goal';f.state.inspectCard='goal';}
    f.state.goal=c.goal;f.state.instructions=c.instructions;f.state.goalDirty=!!(c.goal||c.instructions);
    f.state.goalReviewNotice='已带回原整理目标，请核对后确认。本次尚未开始抽取。';
  }
}
export function visibleMaterialIntents(f,items){
  const ids=new Set(items.map(i=>i.id));
  return items.filter(i=>!ids.has(f.saved.resumedIntents?.[i.id]));
}
