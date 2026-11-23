import {latestChange,nextConversationStep} from './conversation-next.mjs';
import {publicationCurrent} from './conversation-progress.mjs';
import {startWarehouseMaterialDialogue,refreshWarehouseMaterial} from './material-library.mjs';
import {createGraphPresentation} from './graph-presentation.mjs';
import {currentMaterialWorkflow,publishedMaterial,pendingMaterialDraft} from './material-state.mjs';
import {extractionFailuresHTML,extractionRepreviewRequired} from './extraction-diagnostics.mjs';
import {factCardHTML} from './material-fact-cards.mjs';
const fail=code=>Object.assign(Error(code),{code});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const active=v=>['queued','running','generating','publishing'].includes(v);
const retryProtection=job=>[job?.retry_blocked_code,job?.error_code].find(code=>['MATERIAL_REVIEW_REQUIRED','MATERIAL_PROCESSING_GENERATION_STALE',...['MODELING_PROMPT_CHANGED','MODELING_MODEL_CHANGED','LLM_PROMPT_CHANGED','LLM_MODEL_CHANGED']].includes(code));
export const materialJobRetryAllowed=job=>job?.kind==='knowledge_extract'&&job.status==='failed'&&!retryProtection(job);
export const materialAutomaticPublished=current=>current?.is_current===true&&current.publication_performed===true&&current.stage==='published';
export const materialMutationPending=f=>!!(f.saved.pending||f.saved.upload||f.saved.intakeSubmission||f.saved.roundOpening||f.intake?.staged||f.reviewPending||f.claimPending||f.releasePending||f.changes?.pending||f.changes?.record.pending||f.changes?.claimRequest);
export function materialProcessingActive(f,workflow=currentMaterialWorkflow(f)){
  const id=f.agent.documentId,c=f.agent.current;
  return !!(c?.current?.is_current===true&&active(c.current.stage)||workflow?.document_id===id&&workflow.tasks?.some(t=>active(t.status)));
}
export function materialReviewPending(f,workflow=f.state.librarySelection?.document.workflow||f.importer?.view?.workflow){
  const id=f.agent.documentId,c=f.agent.current;
  if(workflow?.document_id===id){
    const draft=workflow.draft,submitted=draft&&(draft.status==='submitted'||!!draft.submitted_at);
    return !!(draft&&!submitted&&(!draft.status||draft.status==='editing')||workflow.stage==='draft'&&!submitted||workflow.stage==='awaiting_review');
  }
  return c?.current?.is_current===true&&c.current.stage==='awaiting_review';
}
const factType=(f,v)=>{const p=createGraphPresentation(f.state.ontology?.schema),code=v.payload?.type||v.entity_type||v.relation_type;return v.kind==='relation'||v.relation_type?p.relation(code):p.entity(code).label;};
export function automaticPreviewProblem(f){
  const record=f.agent.record,p=record.preview;if(!p)return null;
  if(record.previewError)return record.previewError;
  if(p.expires_at&&Date.parse(p.expires_at)<=Date.now())return 'MATERIAL_PROCESSING_PREVIEW_EXPIRED';
  const w=f.state.librarySelection?.document.workflow||f.importer?.view?.workflow;
  if(w?.document_id&&w.document_id===p.document_id&&(w.document_version_id!==p.snapshot?.document_version_id||Number.isSafeInteger(w.workflow_revision)&&w.workflow_revision!==p.workflow_revision))return 'MATERIAL_PROCESSING_PREVIEW_STALE';
  return null;
}

function replacementDigest(p){
  if(p.replacement?.requires_acknowledgement!==true)return undefined;
  const digest=p.replacement.acknowledgement_digest;
  return p.contract_version==='1.1.0'&&p.publication_policy==='automatic'&&typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)?digest:null;
}
function replacementHTML(p){
  const r=p.replacement;if(!r||p.contract_version!=='1.1.0'||p.publication_policy!=='automatic')return '';
  const count=v=>Number.isSafeInteger(v)&&v>=0?v:'待确认';
  return `<section class="mw-replacement-impact" aria-label="本次自动处理影响"><h4>本次自动处理影响</h4><p>旧草稿 ${count(r.draft_count)} 份（人工修改 ${count(r.modified_draft_count)} 份）；旧候选结果 ${count(r.candidate_result_count)} 组（人工调整 ${count(r.modified_candidate_result_count)} 组）。</p>${r.description?`<p>${esc(r.description)}</p>`:''}${r.preserves_history===true?'<p>服务端接受本次处理后，旧草稿和候选立即转为历史，不再用于当前编辑或合入新任务。新任务失败或取消，也不会自动恢复旧草稿为可编辑状态。</p>':''}<p>${r.replaces_manual_publication===true?'本轮成功发布将更新该材料已有的人工发布结果。':''}失败或取消时保留该材料原有的已发布知识；没有原发布结果时，不会生成发布结果。</p><p>使用当前正文和仓库已发布本体，不沿用历史对话目标，不发布本体草稿。</p>${r.requires_acknowledgement===true?'<p><strong>点击下方确认按钮，即表示已了解上述影响并开始本轮自动处理。</strong></p>':''}</section>`;
}

export function materialRecoveryHTML(f,workflow=currentMaterialWorkflow(f)){
  const c=f.agent.current,s=c?.current;if(!s||!['failed','cancelled','stale'].includes(s.stage))return '';
  const stale=s.is_current!==true||s.stage==='stale',code=retryProtection(c.failureJob)||s.error?.code;
  const protectedResult=['MATERIAL_REVIEW_REQUIRED','MATERIAL_PROCESSING_GENERATION_STALE',...['MODELING_PROMPT_CHANGED','MODELING_MODEL_CHANGED','LLM_PROMPT_CHANGED','LLM_MODEL_CHANGED']].includes(code);
  const retry=!stale&&s.stage==='failed'&&!protectedResult&&materialJobRetryAllowed(c.failureJob);
  const review=materialReviewPending(f,workflow),importing=f.state.materialPage==='import';
  // Historical transitions describe their own outcome. The material page's
  // current workflow supplies its next actions, even when this receipt is old.
  if(importing&&stale)return '';
  const off=f.state.busy||materialMutationPending(f)||materialProcessingActive(f,workflow);
  const previewOff=off||stale||workflow?.actions?.prepare_automatic?.allowed!==true||importing&&!f.importer.complete;
  const reason=stale?'本次处理已被后续操作替代。请读取最新进度后，再选择当前材料的处理方式。':protectedResult?(code==='MATERIAL_REVIEW_REQUIRED'?'候选已被人工调整，不能直接重试原任务。重新预览后核对影响，再确认新的处理。':'处理依据已变化，不能直接重试原任务。重新预览后核对影响，再确认新的处理。'):s.stage==='cancelled'?'本次处理已停止。可以重新预览后开始新一轮处理。':retry?'可以按原配置重试失败任务；如果需要改变处理依据，请重新预览。':c.failureJob?.status==='succeeded'?'抽取已完成，后续处理未完成。请在任务记录中查看校验或发布问题；重新预览会开始新一轮抽取。':'失败任务尚未确认或不能直接重试，请读取最新进度并查看任务记录。';
  const btn=(action,text,disabled=off)=>`<button class="btn btn-secondary" data-cv="${action}" ${disabled?'disabled':''}>${text}</button>`;
  if(importing){
    const main=retry?btn('material-retry-job','重试原任务'):review?btn('import-review','继续核对'):
      !previewOff?btn('import-auto','重新预览'):btn('import-refresh','读取最新进度');
    return `<section class="mw-failure-recovery">
      <div class="mw-reader-next"><div><strong>${s.stage==='cancelled'?'处理已停止':'处理未完成'}</strong><p>${reason}</p></div>${main}</div>
      <details class="mw-reader-progress" data-cv-disclosure="reader-recovery">
        <summary>失败详情</summary>
        ${c.receipt?.replacement?'<p>旧草稿已转为历史，不会自动恢复编辑；本次失败或取消不撤回原已发布知识。</p>':''}
        ${s.error?.detail||s.error?.message?`<p>${esc(s.error.detail||s.error.message)}</p>`:''}
        ${extractionFailuresHTML(c.failureJob)}
        ${retry||review||previewOff?btn('import-auto','重新预览',previewOff):''}
      </details>
    </section>`;
  }
  return `<section class="mw-failure-recovery"><div class="mw-import-complete"><div><h3>${stale?'处理已被替代':s.stage==='cancelled'?'处理已停止':'处理未完成'}</h3><p>${reason}</p>${c.receipt?.replacement?'<p>旧草稿已转为历史，不会自动恢复编辑；本次失败或取消不撤回原已发布知识。</p>':''}</div><div class="mw-import-actions">${retry?btn('material-retry-job','重试原任务'):''}${!stale?btn(importing?'import-auto':'material-auto','重新预览',previewOff):''}${review?btn(importing?'import-review':'material-review','继续核对'):!stale&&!importing?btn('material-dialogue','对话调整',off):''}${stale||!retry&&c.diagnosticUnavailable?btn(importing?'import-refresh':'refresh','读取最新进度'):''}</div></div>${s.error?.detail||s.error?.message?`<p>${esc(s.error.detail||s.error.message)}</p>`:''}${extractionFailuresHTML(c.failureJob)}${c.diagnosticUnavailable?'<p>详细诊断暂未读取成功，请读取最新进度。</p>':''}</section>`;
}

// Only unambiguous operation requests execute. All other language is sent to
// the model, without silently converting it into a goal or a modification.
export function materialCommand(text){
  const s=String(text||'').trim().replace(/[。！!\s]+$/u,'').replace(/^(?:请帮我|请|帮我)/u,'');
  if(/^(?:确认继续修改|确认接管并继续修改|确认接管)$/.test(s))return 'claim-draft';
  if(s==='取消接管')return 'cancel-claim';
  if(/^(?:确认应用(?:到草稿|这些建议|本轮建议)?|确认按建议(?:修改|调整)|按建议(?:执行|应用到草稿))$/.test(s))return 'apply-change';
  if(/^(?:进入|继续|进行)?下一步$|^(?:开始|确认|继续)抽取$/.test(s))return 'next';
  if(/^(?:自动抽取|重新抽取|重新提取|重新抽取当前材料|重新抽取这份材料)$/.test(s))return 'reextract';
  const current='(?:(?:当前|这份|这个|该)?(?:材料|文件|文档))';
  if(new RegExp('^(?:(?:把|将)?'+current+')?(?:重新)?自动(?:抽取|提取)(?:'+current+')?$').test(s))return 'reextract';
  if(/^(?:核对|修改|编辑)正文$/.test(s))return 'source';
  if(/^(?:对话调整|通过对话调整|通过对话重新抽取)$/.test(s))return 'dialogue';
  return null;
}

export function currentDraftClaim(f){
  const c=f?.changes,p=c?.state.claimConfirmation,d=f?.state.detail;
  if(!p||f.state.materialPage==='import'||f.state.reviewingSource||f.agent?.record.preview)return null;
  return p&&p.scope===c.scopeKey&&p.documentId===d?.document_id&&p.versionId===d.document_version_id?p:null;
}

export class MaterialAgent{
  constructor(flow){this.f=flow;}
  async syncDialogue(){
    const f=this.f,d=f.state.detail;
    f.state.dialogueFailureJob=null;
    if(!d?.document_id){f.state.dialogueWorkflow=null;f.state.dialogueKnowledge=null;return;}
    const w=await f.read('conversation-material-workflow',{documentId:d.document_id});
    if(w.document_id!==d.document_id)throw fail('MODELING_SNAPSHOT_CHANGED');
    f.state.dialogueWorkflow=w;
    if(d.execution?.status==='failed'&&d.execution.job_id){
      try{const job=await f.read('conversation-job',{jobId:d.execution.job_id});
        if(job.id===d.execution.job_id&&job.document_id===d.document_id&&job.kind==='modeling_extract')f.state.dialogueFailureJob=job;
      }catch(e){if([401,403].includes(e.status))throw e;}
    }
    const row=f.state.warehouseMaterials?.find(v=>v.id===d.document_id);if(row)row.workflow=w;
    if(!publishedMaterial(w)){f.state.dialogueKnowledge=null;return;}
    const cached=f.state.dialogueKnowledge?.run;
    if(cached?.id===w.publication.id&&cached.document_id===w.document_id&&cached.document_version_id===w.document_version_id&&cached.status==='published')return;
    f.state.dialogueKnowledge=null;
    f.state.baselinePage=0;
    const knowledge=await f.read('conversation-published-run',{runId:w.publication.id});
    if(knowledge?.run?.id!==w.publication.id||knowledge.run.document_id!==w.document_id||knowledge.run.document_version_id!==w.document_version_id||knowledge.run.status!=='published')throw fail('MODELING_SNAPSHOT_CHANGED');
    const latest=await f.read('conversation-material-workflow',{documentId:w.document_id});
    if(latest.document_id!==w.document_id)throw fail('MODELING_SNAPSHOT_CHANGED');
    f.state.dialogueWorkflow=latest;if(row)row.workflow=latest;
    if(publishedMaterial(latest)&&latest.publication.id===knowledge.run.id&&latest.document_version_id===knowledge.run.document_version_id)f.state.dialogueKnowledge=knowledge;
  }
  get documentId(){return this.f.state.librarySelection?.document.id||this.f.state.detail?.document_id;}
  get record(){return this.f.saved.materialOperations?.[this.documentId]||{};}
  get current(){return this.f.state.materialOperation?.documentId===this.documentId?this.f.state.materialOperation:null;}
  get hasSourceEdits(){return this.f.intake.source?.document.id===this.documentId&&this.f.intake.hasEdits;}
  apply(p,value){
    if(p.action==='conversation-job-retry'){
      if(value?.id!==p.input.jobId||!value.document_id||!['queued','running'].includes(value.status))throw fail('SEMANTICA_INVALID_RESPONSE');
      if(this.documentId===value.document_id&&this.current){this.current.current={...this.current.current,is_current:true,stage:'queued'};this.current.failureJob=null;}
      return;
    }
    const id=p.input?.documentId;if(!id)return;
    if(p.action==='conversation-processing-preview'){
      if(value.document_id!==id||!value.preview_id)throw fail('SEMANTICA_INVALID_RESPONSE');
      this.f.saved.materialOperations={...this.f.saved.materialOperations,[id]:{...this.f.saved.materialOperations?.[id],preview:value,previewError:null}};
      if(id===this.documentId)this.f.state.reviewingSource=false;
    }
    if(['conversation-processing-confirm','conversation-processing-start'].includes(p.action)){
      if(value.receipt?.document_id!==id||!value.receipt.transition_id)throw fail('SEMANTICA_INVALID_RESPONSE');
      if(p.action==='conversation-processing-start'&&(value.receipt.document_version_id!==p.input.documentVersionId||
        value.receipt.operation_id!==p.input.operationId||value.receipt.waits_for_source_index!==true))throw fail('SEMANTICA_INVALID_RESPONSE');
      if(value.receipt.replacement)this.f.changes.retireForAutomatic(id);
      this.f.rounds?.retire(id);
      this.f.saved.materialOperations={...this.f.saved.materialOperations,[id]:{transitionId:value.receipt.transition_id}};
      // Keep controls locked after acceptance even if the following status read fails.
      if(id===this.documentId)this.f.state.materialOperation={documentId:id,...value,current:value.current||{is_current:true,stage:'queued'}};
    }
    if(p.action==='conversation-source-save'){
      if(!value.version?.id||value.document?.id!==id)throw fail('SEMANTICA_INVALID_RESPONSE');
      this.f.saved.materialOperations={...this.f.saved.materialOperations,[id]:{sourceSaved:true}};
      const r=this.f.intake.record;if(r){r.edits={};r.confirmed=true;r.versionId=value.version.id;}
      this.f.intake.source=value;
      this.f.state.reviewingSource=true;this.f.state.materialOperation=null;
    }
  }
  async readStatus(id,transitionId,workflow){
    const f=this.f,result=await f.read('conversation-processing-status',{documentId:id,transitionId});
    if(this.documentId!==id)return null;
    const receipt=result?.receipt,status=result?.current;
    if(receipt?.document_id!==id||receipt.transition_id&&receipt.transition_id!==transitionId||
      typeof status?.is_current!=='boolean'||!['queued','running','generating','publishing','awaiting_review','published','failed','cancelled','stale'].includes(status.stage))throw fail('SEMANTICA_INVALID_RESPONSE');
    // Acceptance consumes this exact preview even if its resulting task has
    // since retired. An unknown original write must still be recovered first.
    if(!f.saved.pending&&receipt.preview_id&&receipt.preview_id===this.record.preview?.preview_id){
      delete this.record.preview;delete this.record.previewError;f.persist();
    }
    if(f.state.materialPage==='import'&&(status.is_current===false||status.stage==='stale'||
      receipt.target_mode&&receipt.target_mode!=='automatic'||
      workflow?.document_version_id&&receipt.document_version_id&&workflow.document_version_id!==receipt.document_version_id)){
      f.state.materialOperation=null;return null;
    }
    return result;
  }
  async sync(){
    const f=this.f,id=this.documentId;if(!id)return;
    const problem=automaticPreviewProblem(f);
    if(problem&&this.record.previewError!==problem){this.record.previewError=problem;f.state.automaticPreviewProblem=problem;f.persist();}
    const w=f.state.librarySelection?.document.workflow;
    const latest=f.state.materialPage==='import'&&!f.saved.pending&&w?.document_id===id?w.latest_transition_id:null;
    const transitionId=latest||this.record.transitionId;if(!transitionId)return;
    const result=await this.readStatus(id,transitionId,w);if(!result)return;
    if(transitionId!==this.record.transitionId){
      if(result.current.is_current!==true||result.receipt.target_mode!=='automatic')return;
      f.saved.materialOperations={...f.saved.materialOperations,[id]:{...this.record,transitionId}};
      f.persist();
    }
    const previous=this.current;
    f.state.materialOperation={documentId:id,...result};
    if(result.current.is_current===true&&result.current.stage==='failed'&&result.receipt.job_id){
      try{
        const job=await f.read('conversation-job',{jobId:result.receipt.job_id});
        if(job.id!==result.receipt.job_id||job.document_id!==id)throw fail('MODELING_SNAPSHOT_CHANGED');
        if(this.record.blockedRetry?.jobId===job.id)job.retry_blocked_code=this.record.blockedRetry.code;
        f.state.materialOperation.failureJob=job;
      }catch(e){if([401,403].includes(e.status))throw e;f.state.materialOperation.diagnosticUnavailable=true;}
    }
    if(result.current.is_current&&active(result.current.stage)){
      const w=await f.read('conversation-material-workflow',{documentId:id});
      if(this.documentId===id)f.state.materialOperation.progress=w.tasks?.find(t=>t.id===result.receipt.job_id);
    }
    if(materialAutomaticPublished(result.current)&&result.current.published_run_id){
      const run=previous?.current?.published_run_id===result.current.published_run_id&&previous.knowledge||await f.read('conversation-published-run',{runId:result.current.published_run_id});
      if(run?.run?.id!==result.current.published_run_id||run.run.document_id!==id||run.run.status!=='published'||run.run.document_version_id!==result.receipt.document_version_id)throw fail('MODELING_SNAPSHOT_CHANGED');
      const latest=await this.readStatus(id,transitionId,w);if(!latest)return;
      if(!materialAutomaticPublished(latest.current)||latest.current.published_run_id!==result.current.published_run_id){f.state.materialOperation={documentId:id,...latest};return;}
      f.state.materialOperation.knowledge=run;
    }
  }
  prepareAutomatic(){return this.f.run(async()=>{
    const f=this.f,id=this.documentId;await f.ready();if(id!==this.documentId)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(this.hasSourceEdits)throw fail('MODELING_SOURCE_SAVE_REQUIRED');
    const w=await f.read('conversation-material-workflow',{documentId:id});
    if(w.document_id!==id)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(materialProcessingActive(f,w))throw fail('MODELING_MATERIAL_BUSY');
    if(!w.actions?.prepare_automatic?.allowed)throw fail(w.automatic_processing?.blockers?.[0]?.code||'MODELING_SOURCE_NOT_READY');
    await f.write('conversation-processing-preview',{documentId:id,documentVersionId:w.document_version_id,workflowRevision:w.workflow_revision});
    f.changes.state.claimConfirmation=null;
    f.state.reviewingSource=false;
    f.state.inputNotice='已准备抽取计划，请核对发布方式和服务端提示后确认。';
  });}
  retryAutomatic(){return this.f.run(async()=>{
    const shown=this.current?.failureJob,id=this.documentId;
    if(materialMutationPending(this.f))throw fail('MODELING_REQUEST_PENDING');
    if(materialProcessingActive(this.f))throw fail('MODELING_MATERIAL_BUSY');
    if(retryProtection(shown))throw fail(retryProtection(shown));
    if(!shown||shown.kind!=='knowledge_extract'||shown.status!=='failed'||this.f.saved.pending)throw fail('MODELING_CONFIRMATION_REQUIRED');
    await this.sync();
    const c=this.current,job=c?.failureJob;
    if(this.documentId!==id||!c?.current?.is_current||c.current.stage!=='failed'||job?.id!==shown.id||job.kind!=='knowledge_extract'||job.status!=='failed')throw fail('MODELING_SNAPSHOT_CHANGED');
    if(materialMutationPending(this.f))throw fail('MODELING_REQUEST_PENDING');
    if(materialProcessingActive(this.f))throw fail('MODELING_MATERIAL_BUSY');
    if(['MATERIAL_REVIEW_REQUIRED','MATERIAL_PROCESSING_GENERATION_STALE'].includes(c.current.error?.code))throw fail(c.current.error.code);
    if(retryProtection(job))throw fail(retryProtection(job));
    try{await this.f.write('conversation-job-retry',{jobId:job.id});}
    catch(e){
      if(['MATERIAL_REVIEW_REQUIRED','MATERIAL_PROCESSING_GENERATION_STALE'].includes(e.code)){
        job.retry_blocked_code=e.code;this.record.blockedRetry={jobId:job.id,code:e.code};this.f.persist();
      }
      throw e;
    }
    await this.sync();
  });}
  async automaticFromSource(){
    const id=this.documentId;
    if(!this.f.intake.complete||this.f.intake.editLocked)return;
    await this.f.intake.confirm(false);
    if(!this.f.state.error&&!this.f.saved.pending&&this.documentId===id)await this.prepareAutomatic();
  }
  confirmAutomatic(confirmation={}){return this.f.run(async()=>{
    if(materialMutationPending(this.f))throw fail('MODELING_REQUEST_PENDING');
    const f=this.f,p=this.record.preview;if(!p?.can_confirm||p.document_id!==this.documentId)throw fail('MODELING_CONFIRMATION_REQUIRED');
    if(confirmation.previewId!==undefined&&confirmation.previewId!==p.preview_id)throw fail('MATERIAL_PROCESSING_PREVIEW_STALE');
    const problem=automaticPreviewProblem(f);if(problem)throw fail(problem);
    if(materialProcessingActive(f))throw fail('MODELING_MATERIAL_BUSY');
    if(f.state.materialPage==='import'&&(!f.importer.complete||f.importer.view?.source.version?.id!==p.snapshot.document_version_id))throw fail('MODELING_SOURCE_CHANGED');
    if(this.hasSourceEdits)throw fail('MODELING_SOURCE_SAVE_REQUIRED');
    const acknowledgement=replacementDigest(p);
    if(acknowledgement===null||acknowledgement&&(confirmation.previewId!==p.preview_id||confirmation.replacementAcknowledgement!==acknowledgement))throw fail('MATERIAL_PROCESSING_ACK_REQUIRED');
    await f.write('conversation-processing-confirm',{documentId:p.document_id,previewId:p.preview_id,previewDigest:p.preview_digest,workflowRevision:p.workflow_revision,confirmed:true,...(acknowledgement?{replacementAcknowledgement:acknowledgement}:{})});
    if(f.readerOnly)await f.readOntology();else await f.snapshot();
    await this.sync();
  });}
  cancelPreview(){if(this.f.state.busy||this.f.saved.pending)return;delete this.record.preview;delete this.record.previewError;this.f.state.automaticPreviewProblem=null;this.f.state.inputNotice='';this.f.persist();this.f.emit();}
  clearAutomaticContext(){
    // Called only after a successful dialogue handoff. Server receipts remain
    // intact; an unsubmitted automatic preview must not own the dialogue UI.
    delete this.f.saved.materialOperations?.[this.documentId];
    this.f.state.materialOperation=null;this.f.state.inputNotice='';this.f.persist();
  }
  async ensureConversation(){
    const f=this.f,selected=f.state.librarySelection;if(!selected)return true;
    await f.run(()=>refreshWarehouseMaterial(f));
    if(f.state.error||f.state.librarySelection!==selected||!selected.document.workflow)return false;
    const w=selected.document.workflow;
    const links=(w.conversations||[]).filter(l=>l.conversation_status==='active'&&!f.saved.resumedIntents?.[l.intent_id]);
    const link=links.find(l=>l.conversation_id===f.saved.conversationId&&l.intent_id===f.state.selectedIntent)||links.find(l=>l.intent_id===f.saved.selection?.[l.conversation_id])||links[0];
    if(link)await f.selectMaterial(link.conversation_id,link.intent_id);else await startWarehouseMaterialDialogue(f);
    return !f.state.error&&!f.state.librarySelection;
  }
  async reviewSource(){if(!await this.ensureConversation())return;return this.f.run(async()=>{
    const f=this.f,id=this.documentId;await f.ready();if(id!==this.documentId)throw fail('MODELING_SNAPSHOT_CHANGED');
    const w=await f.read('conversation-material-workflow',{documentId:id});
    if(!w.actions.edit_source?.allowed)throw fail('MODELING_MATERIAL_BUSY');
    f.changes.state.claimConfirmation=null;
    f.saved.intakeReviews??={};f.saved.intakeReviews[f.state.selectedIntent]??={name:w.document.original_name,note:'',conversationId:f.saved.conversationId};
    f.state.reviewingSource=true;
    const value=await f.read('document',{id});if(!value.version?.id)throw fail('MODELING_SOURCE_NOT_READY');
    f.intake.source=value;f.intake.range=null;f.intake.page=0;
    const r=f.intake.record;if(r.versionId!==value.version.id){r.edits={};r.versionId=value.version.id;}
    f.persist();
  });}
  async dialogue(){
    const f=this.f;
    if(f.readerOnly)return;
    if(materialProcessingActive(f))return f.run(async()=>{throw fail('MODELING_MATERIAL_BUSY');});
    let editExisting=false,reviewCandidates=false,handedOff=false;
    if(!await this.ensureConversation())return;
    await f.run(async()=>{
      const id=this.documentId;await f.ready();if(id!==this.documentId)throw fail('MODELING_SNAPSHOT_CHANGED');
      if(f.intake.hasEdits)throw fail('MODELING_SOURCE_SAVE_REQUIRED');
      const workflow=await f.read('conversation-material-workflow',{documentId:id});
      if(workflow.document_id!==id)throw fail('MODELING_SNAPSHOT_CHANGED');
      f.state.dialogueWorkflow=workflow;
      if(workflow.tasks?.some(t=>active(t.status)))throw fail('MODELING_MATERIAL_BUSY');
      if(!workflow.document_version_id)throw fail('MODELING_SOURCE_NOT_READY');
      editExisting=!!(workflow.draft||workflow.publication||workflow.stage==='awaiting_review');
      // A stale intent cannot authorize editing its old result. Bind the latest
      // source first; the correction service selects and validates the baseline.
      const sourceCurrent=f.state.detail?.source_status==='available'&&!['stale','cancelled'].includes(f.state.detail?.status)&&f.state.detail?.document_version_id===workflow.document_version_id;
      if(sourceCurrent&&f.state.detail?.execution?.status==='awaiting_review'&&!f.state.detail?.review?.draft_id){reviewCandidates=true;editExisting=false;handedOff=true;return;}
      if(sourceCurrent&&(f.state.detail?.review?.draft_id||workflow.publication)&&!this.record.sourceSaved){editExisting=true;f.state.reviewingSource=false;handedOff=true;return;}
      const d=f.state.detail;
      f.saved.materialContinuationRequest={mode:'restart',agentHandoff:true,name:d.original_name||f.intake.record?.name||'当前材料',fromIntent:d.id,conversationId:f.saved.conversationId,documentId:id,
        versionId:workflow.document_version_id,goal:'',instructions:'',editExisting};
      await f.write('conversation-intent-create',{conversationId:f.saved.conversationId,revision:f.state.overview.revision,documentId:id},'material-continue');
      await f.snapshot();
      handedOff=true;
    });
    if(handedOff&&!f.state.error&&!f.saved.pending)this.clearAutomaticContext();
    if(!f.state.error&&reviewCandidates)await f.beginEdit();
    else if(!f.state.error&&editExisting){
      // Opening chat never creates a correction draft or claims another editor.
      if(pendingMaterialDraft(currentMaterialWorkflow(f)))await f.changes.openDraft();
      else{f.state.openMaterialEditor=false;f.state.inspectCard=null;}
      if(!f.state.error)await f.run(()=>this.syncDialogue());
    }
  }
  offerDraftClaim(){return this.f.run(async()=>{
    const f=this.f,c=f.changes;
    if(materialMutationPending(f))throw fail('MODELING_REQUEST_PENDING');
    if(materialProcessingActive(f))throw fail('MODELING_MATERIAL_BUSY');
    c.state.claimConfirmation=null;
    const documentId=f.state.detail?.document_id,scope=c.scopeKey;
    await c.ensureSession();
    const leases=await f.read('conversation-editor-leases',{documentId,operationId:f.uuid(),editor:c.editor()});
    if(documentId!==f.state.detail?.document_id||scope!==c.scopeKey||!Array.isArray(leases.items))throw fail('MODELING_SNAPSHOT_CHANGED');
    c.state.leases=leases.items;
    const eligible=c.state.leases.filter(l=>l.status==='editing'&&!l.legacy_unowned);
    const lease=eligible.find(l=>l.draft_id===c.record.draftId)||eligible.find(l=>l.draft_id===f.state.detail?.review?.draft_id)||(eligible.length===1?eligible[0]:null);
    if(!lease){f.state.inputNotice='请先在材料卡片中选择要继续修改的草稿；历史归属未确认的草稿需先核对归属。';return;}
    const name=f.state.detail?.original_name||f.state.intents.find(i=>i.id===f.state.selectedIntent)?.original_name||'当前材料';
    const notice=`是否继续修改“${name}”的已有草稿（修订 ${lease.revision}）？确认后由当前对话接管编辑，其他页面将停止编辑这份草稿，请先保存其他页面的修改。已有修改会保留，不会发布。回复“确认继续修改”即可继续，回复“取消接管”可取消。`;
    c.state.claimConfirmation={scope:c.scopeKey,documentId:f.state.detail.document_id,versionId:f.state.detail.document_version_id,draftId:lease.draft_id,revision:lease.revision,notice};
    f.state.inputNotice='请回复“确认继续修改”或“取消接管”。';
  });}
  async confirmDraftClaim(){
    const f=this.f,p=currentDraftClaim(f);
    if(!p)return f.run(async()=>{f.state.inputNotice='当前没有待确认的草稿接管。请先输入“下一步”，核对要继续修改的材料与草稿。';});
    if(materialProcessingActive(f))return f.run(async()=>{throw fail('MODELING_MATERIAL_BUSY');});
    const loaded=await f.changes.claim(p.draftId,p);
    if(loaded&&!f.state.error){f.state.inputNotice='已加载已有草稿，可以继续修改；输入“下一步”进入发布预览，不会直接发布。';f.emit();}
    return loaded;
  }
  cancelDraftClaim(){return this.f.run(async()=>{
    if(this.f.changes.claimRequest)throw fail('MODELING_REQUEST_PENDING');
    this.f.changes.state.claimConfirmation=null;this.f.state.inputNotice='已取消接管，已有草稿和发布知识保持保留。';
  });}
  async next(){
    const f=this.f,step=nextConversationStep(f);
    if(!f.state.reviewingSource&&(this.record.preview||this.current)){
      f.state.inputNotice=this.record.preview?'请核对重新抽取计划及发布方式，再点击“确认重新抽取”。':this.current.current?.is_current&&active(this.current.current.stage)?'当前自动处理尚未完成，请等待处理结果。':'请根据当前自动处理结果，选择核对正文、重新抽取或对话调整。';f.emit();return;
    }
    if(this.record.sourceSaved&&!f.state.reviewingSource)return this.reviewSource();
    if(f.state.reviewingSource||step==='source-review')return f.intake.confirm(true);
    if(step==='rules-ready')return f.changes.continueExtraction();
    if(step==='rules'){
      f.state.inspectCard=null;f.state.inputNotice='本体建议已保存。请核对完整本体，勾选后点击“确认发布本体规则”；发布后会显示抽取目标与计划入口。';f.emit();return;
    }
    if(step==='goal'){
      if(!f.state.goal.trim()||f.intake.record?.goalReplyPending){
        if(f.intake.goalStage){await f.intake.discuss();if(!f.state.error){f.state.inputNotice='正在根据已有对话整理目标，完成后请核对中间的摘要。';f.emit();}}
        else{f.state.inputNotice='请在右侧说明希望从材料中整理什么，助手会汇总目标。';f.emit();}return;
      }
      await f.goal();if(!f.state.error)await f.preview();return;
    }
    if(step==='plan'){if(!f.state.plan)return f.preview();return f.confirmPlan();}
    if(step==='candidates')return f.beginEdit();
    if(step==='draft'){
      if(!f.changes.state.summary){
        if(f.changes.state.leases.length)return this.offerDraftClaim();
        await f.changes.openDraft();
        if(!f.state.error&&f.changes.state.leases.length)return this.offerDraftClaim();
        return;
      }
      return f.changes.preview();
    }
    if(step==='proposal'){
      const p=latestChange(f);
      f.state.inspectCard=null;
      f.state.inputNotice=p?.status==='generating'?'正在生成修改预览，完成后将显示确认操作。':p?.status==='needs_clarification'?(f.changes.record.changeTarget==='rules'?'请直接回答本轮待确认问题，也可以点击“助手先建议名称与含义”。无需填写技术字段，建议生成后再确认应用。':'请直接回答本轮待确认问题，或点击“取消本轮建议，返回材料”。'):p?.status==='prepared'?'修改预览已准备好，可继续描述调整要求；核对后回复“确认应用到草稿”，或点击“确认应用，保存修改”。发布需另行确认。':'本轮建议未完成，请修改要求后重试，或取消本轮建议返回材料。';
      f.emit();return;
    }
    f.state.inputNotice=step==='publication'?'请核对发布预览并明确勾选确认发布。':'当前步骤尚未完成，请等待处理结果或核对中间提示。';f.emit();
  }
  async command(command){
    const f=this.f,text=f.state.input;
    if(f.state.busy&&!f.backgroundDone)return;
    f.state.inputRouting=null;f.state.inputNotice='';
    f.state.composerContext=null;f.state.messageMode='auto';
    if(!['next','claim-draft','cancel-claim'].includes(command)&&!f.changes.claimRequest)f.changes.state.claimConfirmation=null;
    const result=await ({next:()=>this.next(),'apply-change':async()=>{
      if(f.changes.state.exclusion)return f.changes.applyExclusion();
      const p=latestChange(f);
      if(!p||p.id===f.changes.record.deferredProposal||p.status!=='prepared'||p.can_apply!==true){f.state.inputNotice='当前没有可确认应用的修改建议。请先生成并核对本轮建议；这条消息不会保存或发布。';f.emit();return false;}
      return f.changes.apply(p.id);
    },'claim-draft':()=>this.confirmDraftClaim(),'cancel-claim':()=>this.cancelDraftClaim(),reextract:()=>this.prepareAutomatic(),source:()=>this.reviewSource(),dialogue:()=>this.dialogue()}[command]?.());
    if(result!==false&&!f.state.error&&f.state.input===text){f.state.input='';f.saveMaterialComposer();f.emit();}
  }
}

export function materialAgentTools(f){
  if(!f?.agent?.documentId)return '';
  const w=f.state.librarySelection?.document.workflow;
  const done=(f.state.librarySelection?w?.document_version_id&&(w.publication||w.draft||w.stage==='awaiting_review'||w.conversations?.some(l=>['stale','cancelled'].includes(l.status))):publicationCurrent(f.state.detail))||f.agent.current?.current?.is_current&&f.agent.current.current.stage==='published'||f.agent.record.sourceSaved;
  const off=f.state.busy||f.saved.pending?'disabled':'';
  return done?`<div class="conversation-toolbar mw-completed-actions"><button class="btn btn-secondary" data-cv="material-source" ${off}>核对正文</button><button class="btn btn-secondary" data-cv="material-auto" ${off}>重新抽取</button>${f.state.materialPage!=='import'?`<button class="btn btn-secondary" data-cv="material-dialogue" ${off}>对话调整</button>`:""}</div>`:'';
}
function publishedFactHTML(f,v){
  return factCardHTML(v,{schema:f.state.ontology?.schema,context:f.agent.current?.knowledge?.candidates||[],status:'已发布'});
}

export function materialAutomaticCard(f){
  if(!f?.agent)return '';const p=f.agent.record.preview,c=f.agent.current;
  if(p){
    const w=f.state.librarySelection?.document.workflow||f.importer?.view?.workflow;
    const d=f.state.detail?.document_id===p.document_id?f.state.detail:null;
    const repeat=!!(p.snapshot.baseline_run_id||w?.document_id===p.document_id&&(w.publication||w.stage==='awaiting_review'||w.conversations?.some(i=>['awaiting_review','succeeded','completed'].includes(i.execution_status)))||d?.execution||d?.review?.draft_id);
    const stale=f.state.materialPage==='import'&&f.importer?.view?.source.version?.id!==p.snapshot.document_version_id;
    const problem=automaticPreviewProblem(f),consumed=problem==='MATERIAL_PROCESSING_PREVIEW_CONSUMED';
    const processing=materialProcessingActive(f);
    const acknowledgement=replacementDigest(p);
    const blocked=!p.can_confirm||acknowledgement===null||processing||f.state.busy||materialMutationPending(f)||f.state.materialPage==='import'&&(!f.importer?.complete||stale);
    const notice=problem==='MATERIAL_PROCESSING_PREVIEW_EXPIRED'?'抽取预览已过期，请重新预览并核对后确认。材料无需重新上传。':consumed?'这份预览已经提交，请读取进度恢复原任务。':problem||stale?'材料或处理依据已变化，请重新预览后确认。':'';
    const recovery=consumed?(f.state.materialPage==='import'?'import-refresh':'refresh'):'material-auto';
    return `<section class="cv-plan"><h3>${repeat?'重新抽取当前材料':'抽取当前材料'}</h3><p>${repeat?'将根据当前正文重新抽取知识。':'将根据当前正文和本体规则抽取知识。'}${p.publication_policy==='automatic'?'抽取结果通过校验后自动发布；完整性未确认或触发人工保护时，需核对后发布。':'这份材料有人工核对保护，抽取结果需核对后发布。'}</p>${notice?`<p role="alert">${notice}</p>`:''}${replacementHTML(p)}${acknowledgement===null?'<p role="alert">替换确认摘要缺失或无效，请重新预览后确认。</p><button class="btn btn-secondary" data-cv="material-auto">重新预览抽取</button>':''}${(p.blockers||[]).map(b=>`<p role="alert">${esc(b.detail||b.message||b.code)}</p>`).join('')}<div class="mw-import-actions">${problem?`<button class="btn btn-primary" data-cv="${recovery}" ${f.state.busy||f.saved.pending||!consumed&&processing?'disabled':''}>${consumed?'读取原任务进度':'重新预览抽取'}</button>`:`<button class="btn btn-primary" data-cv="material-auto-confirm" data-preview-id="${esc(p.preview_id)}" ${acknowledgement?`data-replacement-acknowledgement="${esc(acknowledgement)}"`:""} ${blocked?'disabled':''}>${acknowledgement?'确认影响，开始抽取':repeat?'确认重新抽取':'确认开始'}${p.publication_policy==='automatic'?'并自动发布':''}</button>`}<button class="btn btn-secondary" data-cv="material-auto-cancel" ${f.state.busy||f.saved.pending?'disabled':''}>取消</button></div></section>`;
  }
  if(!c)return '';
  if(['failed','cancelled','stale'].includes(c.current.stage))return f.state.materialPage==='import'&&f.importer?.complete?'':materialRecoveryHTML(f);
  if(c.current.is_current===false)return `<section class="mw-automatic-result"><h3>这次处理已被后续操作替代</h3><p>旧结果不再作为当前材料结果展示，请读取最新状态。</p>${f.state.materialPage!=='import'?'<button class="btn btn-secondary" data-cv="material-dialogue">对话调整</button>':''}</section>`;
  const status=c.current.stage==='published'&&!materialAutomaticPublished(c.current)?'publication_unconfirmed':c.current.stage;
  const label={publication_unconfirmed:'发布状态待确认，请读取最新进度',queued:'等待抽取',running:'正在自动抽取',publishing:'正在自动发布',published:'本次抽取已发布',awaiting_review:'自动抽取结果待核对',failed:'自动处理失败',cancelled:'自动处理已停止',stale:'处理依据已变化'}[status]||status;
  const progress=c.progress,known=Number.isSafeInteger(progress?.total_units)&&progress.total_units>0,done=Number.isSafeInteger(progress?.completed_units)?progress.completed_units:0;
  const facts=(c.knowledge?.candidates||[]).filter(item=>item.status==='published');
  const page=Math.max(0,Math.min(f.state.automaticResultPage||0,Math.ceil(facts.length/20)-1));
  return `<section class="mw-automatic-result"><h3>${esc(label)}</h3>${active(status)?`<progress aria-label="自动处理进度" ${known?`max="${progress.total_units}" value="${Math.min(done,progress.total_units)}"`:''}></progress><p>已完成 ${done} / ${known?progress.total_units:'待确定'} 单元</p>`:''}<p>${esc(c.current.error?.message||c.current.error?.detail||'')}</p>${retryProtection(c.failureJob)?`<p role="alert">${retryProtection(c.failureJob)==='MATERIAL_REVIEW_REQUIRED'?'候选已被人工调整，请继续核对，或重新预览自动处理并确认替换影响。不能直接重试旧任务。':(extractionRepreviewRequired(c.failureJob)?'抽取版本或模型配置已变化，旧任务不能继续重试。请重新预览并确认新任务。':'本轮任务已被后续处理替代，请读取最新进度后重新预览。')}</p>`:''}${extractionFailuresHTML(c.failureJob)}${c.diagnosticUnavailable?'<p>详细诊断暂未读取成功，请读取最新进度。</p>':''}${status==='awaiting_review'?'<p>请核对本次自动抽取结果，再确认发布。确认发布前，原有已发布结果保持不变。</p><button class="btn btn-secondary" data-cv="material-review">继续核对抽取结果</button>':''}${status==='published'?`<h4>已发布知识 · ${facts.length} 项</h4>${facts.slice(page*20,(page+1)*20).map(v=>publishedFactHTML(f,v)).join('')||'<p>本次没有发布知识条目。</p>'}<button class="btn btn-secondary" data-cv="auto-results-prev" ${page===0?'disabled':''}>上一页</button><span> ${page+1} / ${Math.max(1,Math.ceil(facts.length/20))} </span><button class="btn btn-secondary" data-cv="auto-results-next" ${(page+1)*20>=facts.length?'disabled':''}>下一页</button>`:''}</section>`;
}
export function materialAgentFeedback(f){
  if(!f)return '';
  const selected=!f.state.librarySelection;
  const current=f.agent?.current?.current?.is_current===true?f.agent.current:null;
  const processing=f.state.busy&&!f.backgroundDone||active(current?.current?.stage)||selected&&(active(f.state.turn?.status)||active(f.state.detail?.execution?.status)||f.state.detail?.status==='parsing');
  // Once a new processing transition owns this material, old dialogue results
  // must not be presented as the new task's current output.
  const useDialogueResults=selected&&!f.agent?.current&&!f.agent?.record.preview;
  const run=(materialAutomaticPublished(current?.current)?current.knowledge:null)||(useDialogueResults?f.state.knowledge:null);
  const facts=run?(run.candidates||run.items||[]).filter(item=>item.status==='published'):(useDialogueResults?f.state.candidates?.items:null)||[];
  return `${processing?'<div class="mw-agent-progress" role="status"><progress aria-label="助手正在处理"></progress><p>正在处理当前材料操作，结果会同步到工作区…</p></div>':''}${selected&&f.intake?.source&&!f.intake.sourceReviewed?'<p class="mw-agent-guide">正文已解析。请在中间核对；也可以直接提问，或告诉我希望从材料中抽取什么。输入“下一步”可继续。</p>':''}${facts.length?`<details class="mw-agent-results"><summary>${run?'当前发布结果':'待核对候选'} · 已读取 ${facts.length} 项</summary>${facts.slice(0,30).map(v=>`<p>${esc(v.payload?.name||v.canonical_name||v.name||v.kind)} · ${esc(factType(f,v))}<br>${esc((v.evidence||[]).map(e=>e.excerpt||e.quote||e.text||'').join('；'))}</p>`).join('')}${facts.length>30?'<p>这里展示前 30 项，完整结果可在中间工作区核对。</p>':''}<p>可以通过“对话调整”提出修改；新增类型与关系仍需核对并确认采用。</p></details>`:''}`;
}
