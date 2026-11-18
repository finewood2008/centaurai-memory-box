import {latestChange} from './conversation-next.mjs';
import {relatedSelection} from './material-related-selection.mjs';
import {hasChangeConflicts,changeConflictNotice} from './material-change-conflicts.mjs';
const fail=code=>Object.assign(Error(code),{code});
const terminal=new Set(['completed','abandoned','handoff']);
// Uses ConversationChanges' durable request envelope, lease and recovery guards.
// A plan preview is kept separate from legacy proposals, so its child proposal
// cannot accidentally be applied a second time through the old apply endpoint.
export class MaterialInstructions{
  constructor(flow){this.f=flow;}
  get c(){return this.f.changes;}
  get plan(){return this.c.state.instructionPlan;}
  get open(){return !!this.c.record.instructionPlanOpen;}
  get step(){return this.plan?.steps?.find(s=>s.id===this.plan.next_step_id)||this.plan?.steps?.find(s=>!['completed','abandoned'].includes(s.status));}
  ids(){return {conversationId:this.f.saved.conversationId};}
  privateOptions(){return this.plan?.context?.draft_id?{editor:this.c.editor()}:{};}
  async call(kind,input={}){return this.f.read('conversation-instruction-'+kind,{...this.ids(),...input,operationId:this.f.uuid()});}
  async read(){
    const id=this.c.record.instructionPlanId;if(!id)return;
    const scope=this.c.scopeKey;
    const options=this.c.record.instructionPrivate?{editor:this.c.editor()}:{};
    const plan=await this.call('read',{planId:id,...options});
    if(scope!==this.c.scopeKey||id!==this.c.record.instructionPlanId)throw fail('MODELING_SNAPSHOT_CHANGED');
    this.receive(plan);
  }
  receive(plan){
    if(!plan?.resource_id||!Number.isSafeInteger(plan.revision)||!Array.isArray(plan.steps)||plan.conversation_id!==this.f.saved.conversationId)throw fail('SEMANTICA_INVALID_RESPONSE');
    const previous=this.plan;
    if(previous?.resource_id!==plan.resource_id||previous?.revision!==plan.revision||JSON.stringify(previous?.steps?.map(s=>s.step_digest))!==JSON.stringify(plan.steps.map(s=>s.step_digest)))this.c.state.instructionAcknowledged=false;
    this.c.state.instructionPlan=plan;this.c.record.instructionPlanId=plan.resource_id;
    this.c.record.instructionPlanOpen=!terminal.has(plan.status)&&!plan.read_only;
    this.c.record.instructionPrivate=!!plan.context?.draft_id;
    if(!previous&&this.c.record.instructionPlanOpen&&plan.context?.draft_id===this.c.state.summary?.id&&(!plan.context.draft_revision||plan.context.draft_revision===this.c.state.summary.revision)){
      this.c.state.selected=[...(plan.context.selected_item_ids||[])];
      for(const item of plan.context.selected_items||[])if(item?.id)this.c.state.knownItems={...this.c.state.knownItems,[item.id]:item};
    }
    const children=plan.steps.map(s=>s.kind==='change'?s.preview?.id:null).filter(Boolean);
    this.c.record.instructionProposalIds=[...new Set([...(this.c.record.instructionProposalIds||[]),...children])];
    this.c.state.proposals=this.c.state.proposals.filter(p=>!this.c.record.instructionProposalIds.includes(p.id));
    this.c.persist();
  }
  refresh(){return this.f.run(async()=>{await this.read();});}
  submit(hint=null){return this.f.run(async()=>{
    const f=this.f,c=this.c,content=f.state.input;if(!content.trim())return;
    const scope=c.scopeKey,version=f.state.detail?.document_version_id;
    await f.ready();c.bind();
    if(scope!==c.scopeKey||version!==f.state.detail?.document_version_id)throw fail('MODELING_SNAPSHOT_CHANGED');
    const oldProposal=latestChange(f);
    if(oldProposal&&oldProposal.id!==c.record.deferredProposal&&['prepared','needs_clarification','generating'].includes(oldProposal.status))throw fail('MODELING_CHANGE_REVIEW_REQUIRED');
    if(c.state.exclusion)throw fail('MODELING_CHANGE_REVIEW_REQUIRED');
    if(this.open&&!this.plan)await this.read();
    const previous=this.open?this.plan:null;let selected=[...c.state.selected];
    // Scope suggestions choose only the authorized context. The service still
    // interprets the instruction and must reject unsupported scope mixtures.
    const independent=['goal','rules'].includes(hint);
    if(!independent&&selected.length){
      const related=await relatedSelection(c,content);
      if(related){selected=related.ids;c.state.selected=[...selected];}
    }
    const options={intentId:f.state.selectedIntent,allowedScopes:independent?['question',hint,'extract','publish']:selected.length?['question','facts']:['question','goal','rules','facts','source','extract','publish'],selectedItemIds:independent?[]:selected};
    if(!independent&&selected.length){
      const shown=c.state.summary;
      if(!shown||shown.status!=='editing'||shown.stale_reason)throw fail('CORRECTION_SESSION_REQUIRED');
      await c.loadDraft();
      if(c.state.summary.id!==shown.id||c.state.summary.revision!==shown.revision||c.state.summary.status!=='editing'||c.state.summary.stale_reason||selected.some(id=>!c.state.selected.includes(id)))throw fail('CORRECTION_REVISION_CONFLICT');
      Object.assign(options,{draftId:shown.id,editor:c.editor()});
    }
    const context=await this.call('context',options);
    if(!/^[a-f0-9]{64}$/.test(context.context_digest||'')||context.business_mutation_performed!==false)throw fail('SEMANTICA_INVALID_RESPONSE');
    const quoted=independent?content:await f.evidence.instruction(content);
    let instruction=quoted,clarificationPlanId;
    if(previous?.status==='needs_clarification'&&previous.context_digest===context.context_digest)clarificationPlanId=previous.resource_id;
    else if(previous){
      // Refinement preserves the original request only in the exact context in
      // which its preview was displayed. Completed work is never replayed.
      if(previous.context_digest!==context.context_digest)throw fail('INSTRUCTION_PLAN_STALE');
      const pending=this.step;
      instruction=`此前尚未确认的要求：${pending?.instruction||previous.instruction}\n此前建议与问题：${JSON.stringify(pending?.preview?.result||previous.interpretation||{})}\n用户本次补充：${quoted}\n请合并补充生成完整待确认建议；不要重复已经完成的操作。`;
      if([...instruction].length>4000)throw fail('MODELING_CHANGE_CONTEXT_TOO_LARGE');
      await c.request('instruction-abandon',{...this.ids(),planId:previous.resource_id,revision:previous.revision,...this.privateOptions()});
    }
    c.state.preview=null;c.state.publishConfirmed=false;f.state.inspectCard=null;
    await c.request('instruction-interpret',{...this.ids(),...options,contextDigest:context.context_digest,instruction,...(clarificationPlanId?{clarificationPlanId}:{})},{composerInput:content});
    f.state.composerContext=null;f.state.inputRouting=null;f.state.messageMode='auto';
    if(this.plan.status==='handoff'){
      // Explicit read-only handoff. Preserve the original utterance for QA;
      // never turn a model's answer into an applied mutation receipt.
      f.state.input=content;
      await f.write('conversation-send',{conversationId:f.saved.conversationId,revision:f.state.overview.revision,content});await f.snapshot();
    }else if(this.plan.status==='ready')await this.prepareNow();
    f.saveMaterialComposer?.();
  });}
  async prepareNow(){
    const p=this.plan,s=this.step;if(!p||p.status!=='ready'||!s||s.status!=='pending')return;
    await this.c.request('instruction-prepare',{...this.ids(),planId:p.resource_id,revision:p.revision,...this.privateOptions()});
  }
  prepare(){return this.f.run(async()=>{await this.read();await this.prepareNow();});}
  confirm(){return this.f.run(async()=>{
    const shown=this.plan,step=this.step;
    if(!shown||shown.read_only||shown.status!=='ready'||step?.status!=='prepared'||!step.step_digest)throw fail('MODELING_CONFIRMATION_REQUIRED');
    if(step.kind==='change'&&(step.preview?.status!=='prepared'||step.preview.can_apply!==true||hasChangeConflicts(step.preview.result)))throw fail('MODELING_CONFIRMATION_REQUIRED');
    if(step.kind==='change'&&step.scope==='facts'&&JSON.stringify([...(shown.context?.selected_item_ids||[])].sort())!==JSON.stringify([...this.c.state.selected].sort()))throw fail('INSTRUCTION_PLAN_STALE');
    await this.read();const p=this.plan,s=this.step;
    if(p.resource_id!==shown.resource_id||p.revision!==shown.revision||p.status!=='ready'||s?.id!==step.id||s.status!=='prepared'||s.step_digest!==step.step_digest)throw fail('INSTRUCTION_PLAN_STALE');
    if(s.kind==='change'&&(s.preview?.status!=='prepared'||s.preview.can_apply!==true||hasChangeConflicts(s.preview.result)))throw fail('MODELING_CONFIRMATION_REQUIRED');
    const replacement=s.preview?.replacement;
    if(replacement?.requires_acknowledgement&&(!this.c.state.instructionAcknowledged||!/^[a-f0-9]{64}$/.test(replacement.acknowledgement_digest||'')))throw fail('MATERIAL_PROCESSING_ACK_REQUIRED');
    const result=await this.c.request('instruction-confirm',{...this.ids(),planId:p.resource_id,revision:p.revision,stepDigest:s.step_digest,confirmed:true,...this.privateOptions(),...(replacement?.requires_acknowledgement?{replacementAcknowledgement:replacement.acknowledgement_digest}:{})},{instructionStep:{id:s.id,kind:s.kind,scope:s.scope,draftId:p.context?.draft_id,final:p.steps.every(v=>v.id===s.id||v.status==='completed')}});
    if(s.kind==='extract'&&result.receipt.receipt?.target_mode==='automatic'){
      const id=this.f.state.detail.document_id;
      if(result.receipt.receipt.replacement)this.c.retireForAutomatic(id);
      this.f.rounds?.retire(id);await this.f.snapshot();return;
    }
    await this.f.snapshot();this.c.bind();if(this.c.owner?.draftId)await this.c.loadDraft();
    await this.read();
    if(!this.open)await this.c.context();
  });}
  abandon(){return this.f.run(async()=>{
    await this.read();const p=this.plan;if(!p||terminal.has(p.status))return;
    await this.c.request('instruction-abandon',{...this.ids(),planId:p.resource_id,revision:p.revision,...this.privateOptions()});
    this.f.state.inputNotice='已取消尚未确认的建议。已保存草稿和已提交任务保留。';
  });}
  async accept(p,result){
    const kind=p.action.slice('conversation-instruction-'.length),c=this.c,f=this.f;
    if(['interpret','prepare'].includes(kind)){
      this.receive(result);
      if(kind==='interpret')c.record.instructionUserText=p.composerInput??p.input.instruction;
      if(kind==='interpret'&&f.state.input===p.composerInput){f.state.input='';c.state.evidenceReference=null;}
      else if(kind==='interpret')f.evidence?.syncInput();
      if(kind==='interpret'){
        const composer=f.saved.materialComposers?.[p.input.conversationId+':'+p.input.intentId];
        if(composer?.input===p.composerInput){composer.input='';delete composer.sourceFragment;}
      }
      f.state.inputNotice=result.status==='ready'?'已识别本轮要求。请核对建议，确认后才写入草稿；发布需另行确认。':result.interpretation?.summary||result.reason||'请核对本轮识别结果并补充说明。';
      if(result.steps.some(s=>hasChangeConflicts(s.preview?.result)))f.state.inputNotice=changeConflictNotice;
    }else{
      if(result.resource_id!==p.input.planId||result.revision!==p.input.revision+1)throw fail('SEMANTICA_INVALID_RESPONSE');
      if(kind==='confirm'){
        const step=p.instructionStep,r=result.receipt;
        if(!step||result.step_id!==step.id||!r)throw fail('SEMANTICA_INVALID_RESPONSE');
        const childIds=c.record.instructionProposalIds;
        if(step.kind==='change'){
          if(r.status!=='applied'||r.publication_performed!==false||r.extraction_started!==false)throw fail('SEMANTICA_INVALID_RESPONSE');
          if(step.scope==='facts'&&(r.draft_id!==step.draftId||!Number.isSafeInteger(r.draft_revision)||r.draft_revision<1))throw fail('SEMANTICA_INVALID_RESPONSE');
          c.record.changeTarget=step.scope;c.applied(r,f.state.selectedIntent);
          f.state.inputNotice='修改已保存到草稿，尚未发布。可继续调整，或核对并发布。';
        }else if(step.kind==='publish_rules'){
          if(r.publication_performed!==true||!r.ontology_id)throw fail('SEMANTICA_INVALID_RESPONSE');
          delete c.record.ontologyDraftId;c.state.ruleConfirmed=false;
          f.state.inputNotice='本体发布请求已完成。请读取最新状态，核对后再继续抽取。';
        }else if(step.kind==='extract'){
          if(!r.receipt?.transition_id||r.receipt.document_id!==f.state.detail.document_id)throw fail('SEMANTICA_INVALID_RESPONSE');
          // Preserve the accepted task locator; normal material polling verifies
          // its current state. Do not mark dispatch as extraction/publication done.
          f.saved.materialOperations??={};f.saved.materialOperations[f.state.detail.document_id]={transitionId:r.receipt.transition_id};f.persist();
          f.state.materialOperation={documentId:f.state.detail.document_id,...r,current:r.current||{is_current:true,stage:'queued'}};
          f.state.inputNotice='抽取任务已提交，尚未完成。进度和发布结果以服务端回执为准。';
        }
        c.record.instructionPlanId=p.input.planId;c.record.instructionPlanOpen=!step.final;c.record.instructionPrivate=!!p.input.editor;
        c.record.instructionProposalIds=[...new Set([...(c.record.instructionProposalIds||[]),...(childIds||[])])];
      }else c.record.instructionPlanOpen=false;
      c.state.instructionPlan=null;c.state.instructionAcknowledged=false;
    }
  }
}
