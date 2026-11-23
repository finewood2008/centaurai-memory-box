import {changeRequest} from '../shared/conversation-change-contract.mjs';
import {instructionRequest} from '../shared/conversation-instruction-contract.mjs';
import {hasChangeConflicts} from './material-change-conflicts.mjs';
import {latestChange,nextConversationStep} from './conversation-next.mjs';
import {materialSourceUsable,retainedMaterialResults} from './conversation-progress.mjs';
import {relatedSelection} from './material-related-selection.mjs';
import {pendingExtractionReview,currentMaterialWorkflow,publishedMaterial} from './material-state.mjs';
import {proposalWithinTarget} from './material-intent.mjs';
import {ruleUserInstruction,ruleSuggestionInstruction} from './material-rule-guidance.mjs';
import {validationSelection,validationFacts,validationInstruction} from './material-validation-selection.mjs';
import {visibleFactItems,factSchema} from './material-fact-cards.mjs';
const clone=structuredClone;
const failure=code=>Object.assign(Error(code),{code,status:0});
const refused=e=>[400,401,403,404,409,422].includes(e.status);

export class ConversationChanges {
  constructor(flow){this.f=flow;this.key=flow.key+'.changes';this.saved={scopes:{}};this.scope='';this.owner=null;this.pending=null;this.resetView();
    try{const v=JSON.parse(flow.storage.getItem(this.key)||'null');if(v?.scopes&&typeof v.scopes==='object')this.saved=v;}catch{/* No credentials are restored. */}}
  resetView(){this.state={context:null,proposals:[],selected:[],summary:null,items:null,kind:'entity',preview:null,publication:null,source:null,leases:[],claimConfirmation:null,historyIntent:null,more:false,next:0};}
  suspend(){
    if(this.pending||this.record.pending||this.claimRequest)throw failure('MODELING_REQUEST_PENDING');
    // Saved draft/proposal locators survive. Credentials, previews and consent
    // belong to the current editing visit and must be reread on continuation.
    this.resetView();this.owner=null;this.lastHeartbeat=0;
  }
  retireForAutomatic(documentId){
    // An accepted replacement retires this round on the server. Drop only its
    // local editing handles; historical content and ontology drafts stay intact.
    if(this.f.state.detail?.document_id!==documentId||this.scope!==this.scopeKey)return;
    if(this.pending||this.record.pending||this.claimRequest)throw failure('MODELING_REQUEST_PENDING');
    this.record.deferredProposal=latestChange(this.f)?.id||this.record.lastProposal;
    delete this.record.draftId;delete this.record.savedDraftRevision;delete this.record.previousIntent;
    this.owner=null;this.resetView();this.lastHeartbeat=0;this.persist();
    Object.assign(this.f.state,{candidates:null,candidateGraph:null,merge:null,inspectCard:null,composerContext:null,openMaterialEditor:false,openDetailedEditor:false});
    const continuation=this.f.saved.materialContinuations?.[this.f.state.selectedIntent];
    if(continuation?.documentId===documentId&&continuation.mode==='draft'){
      continuation.mode='restart';continuation.draftId=null;continuation.goal='';continuation.instructions='';
    }
  }
  get scopeKey(){return JSON.stringify([this.f.saved.conversationId,this.f.state.selectedIntent]);}
  get record(){return this.saved.scopes[this.scope]??(this.saved.scopes[this.scope]={});}
  persist(){this.f.check();try{this.f.storage.setItem(this.key,JSON.stringify(this.saved));}catch{throw failure('MODELING_LOCAL_SAVE_FAILED');}}
  bind(){if(this.scope!==this.scopeKey){this.scope=this.scopeKey;this.resetView();this.owner=null;this.pending=null;this.claimRequest=null;}}
  ids(intentId=this.f.state.selectedIntent){if(!this.f.saved.conversationId||!intentId)throw failure('MODELING_SOURCE_NOT_READY');return {conversationId:this.f.saved.conversationId,intentId};}
  async call(name,input={}){return this.f.read('conversation-change-'+name,{...input,operationId:input.operationId||this.f.uuid()});}
  editor(){if(!this.owner?.editor)throw failure('CORRECTION_SESSION_REQUIRED');return clone(this.owner.editor);}
  get independent(){return ['rules','goal'].includes(this.record.changeTarget);}
  setTarget(target){
    this.bind();if(!['rules','goal','facts'].includes(target))return;
    if(this.f.saved.pending||this.f.reviewPending||this.f.claimPending||this.f.releasePending||this.pending||this.record.pending||this.claimRequest)throw failure('MODELING_REQUEST_PENDING');
    if(this.record.changeTarget===target)return;
    this.state.evidencePicker=null;this.state.evidenceReference=null;
    this.record.changeTarget=target;this.state.context=null;this.state.needsDraft=false;this.state.ruleConfirmed=false;this.state.claimConfirmation=null;this.persist();
  }
  proposalAllowed(proposal){
    const target=this.record.proposalTargets?.[proposal?.id];
    return !target||proposalWithinTarget(proposal,target);
  }
  options(){const draftId=this.state.summary?.id;
    const scope=this.record.changeTarget?{allowedScopes:[this.record.changeTarget]}:{};
    if(this.independent)return {...scope,...(this.record.ontologyDraftId?{ontologyDraftId:this.record.ontologyDraftId}:{}),selectedItemIds:[]};
    return {...scope,...(draftId?{draftId,editor:this.editor()}:this.record.ontologyDraftId?{ontologyDraftId:this.record.ontologyDraftId}:{}),selectedItemIds:[...this.state.selected]};}
  async context(offset=0){this.bind();const d=this.f.state.detail;
    if(!d?.document_version_id||!materialSourceUsable(d)||['queued','running'].includes(d.status)||d.status==='cancelled'&&(!this.state.summary||this.state.summary.id!==d.review?.draft_id)){
      this.state.context=null;this.state.ruleConfirmed=false;return;
    }
    if(!this.independent&&this.state.summary&&(this.state.summary.status!=='editing'||this.state.summary.stale_reason)){
      this.state.context=null;this.state.ruleConfirmed=false;return;
    }
    // A recovered fact draft must first be explicitly claimed by this page.
    if(!this.independent&&(d.review?.draft_id||this.record.draftId)&&!this.state.summary){this.state.needsDraft=true;return;}
    if(this.record.ontologyDraftId===this.f.state.ontology?.id&&this.f.state.ontology?.status==='published'){
      delete this.record.ontologyDraftId;this.state.ruleConfirmed=false;this.persist();
    }
    let context;
    try{context=await this.call('context',{...this.ids(),...this.options(),proposalOffset:offset});}
    catch(e){
      // A draft can become stale between its header read and the context read.
      // Show the authoritative draft reason instead of blaming an old proposal.
      if(!this.independent&&e.code==='MODELING_CHANGE_STALE'&&this.owner?.draftId){
        await this.loadDraft();if(this.state.summary?.stale_reason)return;
      }
      throw e;
    }
    if(!/^[a-f0-9]{64}$/.test(context.context_digest||'')||!Array.isArray(context.recent_proposals))throw failure('SEMANTICA_INVALID_RESPONSE');
    if(this.state.context?.context_digest!==context.context_digest)this.state.ruleConfirmed=false;
    this.state.context=context;this.state.more=context.proposal_has_more;this.state.next=context.proposal_next_offset;
    if(context.ontology_id===context.base_ontology_id&&this.record.ontologyDraftId){delete this.record.ontologyDraftId;this.persist();}
    const proposals=[];
    for(const p of context.recent_proposals){
      if(this.record.instructionProposalIds?.includes(p.id))continue;
      // Independent edits must not depend on permission to read an unrelated
      // private fact proposal. Current target associations survive restart.
      if(this.independent&&this.record.proposalTargets?.[p.id]!==this.record.changeTarget)continue;
      try{proposals.push(await this.call('read',{...this.ids(),proposalId:p.id,...(!this.independent&&this.owner?{editor:this.editor()}:{})}));}
      catch(e){
        // A retired proposal may reference a published rule draft or an expired
        // fact lease. Clear that proposal's content without breaking the current
        // authorized context. Authentication failures still stop the whole flow.
        if(![404,409].includes(e.status))throw e;
        proposals.push({id:p.id,status:'unavailable',can_apply:false,error_code:e.code});
      }
    }
    // Changing scope must not silently abandon an unapplied fact proposal.
    // Keep already-read proposals from the other scopes; only replace this
    // scope's page. Returning to facts still requires review or cancellation.
    const target=this.record.changeTarget||'facts';
    const retained=this.state.proposals.filter(p=>!proposals.some(n=>n.id===p.id)&&(offset||(this.record.proposalTargets?.[p.id]||'facts')!==target));
    this.state.proposals=[...proposals,...retained];
    this.state.needsDraft=false;
  }
  refresh(){return this.f.run(async()=>{await this.f.snapshot();this.bind();if(!this.independent&&this.state.summary)await this.loadDraft();await this.context();});}
  more(){return this.f.run(()=>this.context(this.state.next));}
  defer(id){
    const p=this.state.proposals.find(p=>p.id===id);
    if(this.f.state.busy||this.record.pending||!p||p.id!==latestChange(this.f)?.id||p.status==='generating')return;
    this.setTarget('facts');this.record.deferredProposal=id;this.persist();this.f.state.inspectCard=null;this.f.state.composerContext=null;this.f.emit();
  }
  get selectionLocked(){return this.f.state.busy||!this.f.state.loaded||this.f.saved.pending||this.f.reviewPending||this.f.claimPending||this.f.releasePending||this.pending||this.record.pending||this.claimRequest||this.state.summary?.status!=='editing'||!!this.state.summary?.stale_reason;}
  select(id,checked){if(this.selectionLocked)return;
    if(!this.state.items?.items.some(i=>i.id===id))return;
    this.state.evidenceReference=null;this.state.evidencePicker=null;
    this.state.selected=checked?[...new Set([...this.state.selected,id])].slice(0,20):this.state.selected.filter(v=>v!==id);
    this.state.context=null;this.f.emit();}
  selectPage(){
    if(this.selectionLocked||!this.state.items||this.state.items.revision!==this.state.summary?.revision)return;
    const ids=[...new Set(visibleFactItems(this.state,factSchema(this.f)).map(i=>i.id))];
    if(ids.length>20)return;
    this.state.evidenceReference=null;this.state.evidencePicker=null;
    // A batch is the displayed page, not an implicit expansion to other pages.
    this.state.selected=ids;this.state.context=null;this.f.emit();
  }
  filterFacts(keyword='',type=''){
    if(this.f.state.busy)return;
    this.state.factFilter={keyword:String(keyword).slice(0,200),type:String(type)};this.f.emit();
  }
  clearSelection(){if(this.selectionLocked)return;this.state.selected=[];this.state.context=null;this.state.evidenceReference=null;this.state.evidencePicker=null;this.f.emit();}
  selectIssue(id,checked){
    if(this.selectionLocked)return;
    const next=new Set(this.state.issueSelection||[]);checked?next.add(id):next.delete(id);
    const result=next.size?validationSelection(this.state.preview,[...next]):{ids:[]};
    if(result.error){this.f.state.inputNotice=result.error;this.f.emit();return;}
    this.state.issueSelection=result.ids;this.f.emit();
  }
  adjustIssues({exclude=false,suggest=false,all=false,count=null,input=null}={}){return this.f.run(async()=>{
    if(this.f.instructions?.open)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    const shown=this.state.preview,owner=this.owner,scope=this.scopeKey;
    const selection=validationSelection(shown,all?null:this.state.issueSelection||[],count);
    if(selection.error){this.f.state.inputNotice=selection.error;return;}
    if(suggest&&selection.ids.length>8)throw failure('MODELING_VALIDATION_SUGGESTION_TOO_LARGE');
    if(!owner?.draftId||this.state.summary?.status!=='editing'||shown.revision!==this.state.summary.revision)throw failure('CORRECTION_REVISION_CONFLICT');
    const proposal=latestChange(this.f);
    if(proposal&&proposal.id!==this.record.deferredProposal&&['generating','prepared','needs_clarification','failed','stale'].includes(proposal.status))throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    await this.f.ready();
    if(scope!==this.scopeKey||owner!==this.owner)throw failure('MODELING_SNAPSHOT_CHANGED');
    await this.loadDraft();
    if(this.state.summary?.revision!==shown.revision||this.state.summary.status!=='editing'||this.state.summary.stale_reason)throw failure('CORRECTION_REVISION_CONFLICT');
    const fresh=await this.call('preview',{documentId:owner.documentId,draftId:owner.draftId,revision:shown.revision,offset:0,limit:50,editor:this.editor()});
    if(fresh.revision!==shown.revision||fresh.stale_reason||JSON.stringify(fresh.issues)!==JSON.stringify(shown.issues)){
      this.state.preview=null;this.state.publishConfirmed=false;throw failure('MODELING_CHANGE_STALE');
    }
    this.setTarget('facts');this.state.selected=selection.ids;this.state.context=null;
    this.f.state.composerContext='facts';
    this.f.state.inputRouting=null;
    this.f.state.inputNotice=`${selection.issueCount} 项校验提示对应 ${selection.ids.length} 条事实，已按条目标识去重。${exclude?'正在生成移除预览，确认应用后才修改草稿。':'已选择这些事实，请在下方说明共同的修改要求；不会直接保存或发布。'}`;
    if(suggest){
      const facts=selection.ids.map(id=>({item_id:id,issues:shown.issues.filter(issue=>issue.item_id===id).slice(0,2).map(issue=>String(issue.message||issue.code||'').slice(0,120))}));
      const instruction='请核对以下已选事实的发布校验问题，依据当前本体、所选事实和原文生成待确认修正建议。不要补造属性或证据，不修改整理目标或本体。仅对 selected_item_ids 提出接口支持的名称、类型、属性修正或排除建议；每项说明依据和影响。不能确定、缺少原文、需要改变关系端点或仅需填写语义核对说明时，明确提问并解释限制，不声称警告已消除。最多8项操作，超出时先提问如何分批。问题数据：'+JSON.stringify(facts);
      await this.generateNow(validationInstruction(input||'请根据当前发布校验问题给出修正建议',instruction),{fixedSelection:true,...(input!==null?{composerInput:input}:{})});
      this.f.state.inputNotice='请核对助手建议与原文，可继续对话调整。回复“确认应用到草稿”或点击确认按钮后才保存；应用后仍需重新整份核对，发布需单独确认。';
      if(input!==null&&this.f.state.input===input)this.f.state.input='';
      this.f.saveMaterialComposer?.();
    }else if(exclude){
      const data=await validationFacts(this,shown),ids=new Set(selection.ids);
      if(selection.ids.some(id=>!data.items.some(item=>item.id===id)))throw failure('CORRECTION_ITEM_NOT_FOUND');
      const entities=new Set(data.items.filter(item=>ids.has(item.id)&&item.kind==='entity').map(item=>item.id));
      const related=data.items.filter(item=>item.kind==='relation'&&(entities.has(item.payload?.source_candidate_key)||entities.has(item.payload?.target_candidate_key)));
      for(const item of related)ids.add(item.id);
      if(ids.size>100)throw failure('MODELING_EXCLUSION_TOO_LARGE');
      this.state.exclusion={documentId:owner.documentId,draftId:owner.draftId,revision:shown.revision,ids:[...ids],
        items:data.items.filter(item=>ids.has(item.id)),relatedCount:ids.size-selection.ids.length,scope,composerInput:input};
      this.state.publishConfirmed=false;
      this.f.state.inputNotice='已生成移除预览，请核对条目及关联关系后确认应用；当前草稿尚未修改。';
      if(input!==null&&this.f.state.input===input)this.f.state.input='';
      this.f.saveMaterialComposer?.();
    }
  });}
  cancelExclusion(){if(this.f.state.busy||this.record.pending)return;this.state.exclusion=null;this.f.state.inputNotice='已取消移除预览，草稿未修改。';this.f.emit();}
  applyExclusion(){return this.f.run(async()=>{
    if(this.f.instructions?.open)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    const shown=this.state.exclusion;
    if(!shown||shown.scope!==this.scopeKey||this.owner?.draftId!==shown.draftId)throw failure('MODELING_CHANGE_STALE');
    await this.f.ready();await this.loadDraft();
    if(shown.scope!==this.scopeKey||this.owner?.draftId!==shown.draftId||this.owner.documentId!==shown.documentId)throw failure('MODELING_SNAPSHOT_CHANGED');
    if(this.state.summary.revision!==shown.revision||this.state.summary.status!=='editing'||this.state.summary.stale_reason)throw failure('CORRECTION_REVISION_CONFLICT');
    await this.request('save',{documentId:shown.documentId,draftId:shown.draftId,revision:shown.revision,removeIds:shown.ids,confirmed:true,editor:this.editor()});
    await this.loadDraft();this.f.state.inspectCard=null;
    this.f.state.inputNotice='已将确认的移除操作保存到草稿，尚未发布。请重新整份核对并确认发布。';
  });}
  async request(name,input,local={}){
    if(this.f.saved.roundOpening||this.f.saved.pending||this.f.reviewPending||this.f.claimPending||this.f.releasePending||this.claimRequest)throw failure('MODELING_REQUEST_PENDING');
    const action=(name.startsWith('instruction-')?'conversation-':'conversation-change-')+name;
    if(!this.pending){
      if(this.record.pending)throw failure('MODELING_CHANGE_RECOVERY_REQUIRED');
      const full={...input,warehouseId:this.f.warehouseId,operationId:this.f.uuid()};
      (name.startsWith('instruction-')?instructionRequest:changeRequest)(action,full);
      const composer=typeof local.composerInput==='string'?{composerInput:local.composerInput}:{};
      const step=local.instructionStep?{instructionStep:clone(local.instructionStep)}:{};
      this.pending={action,input:full,...composer,...step};const {editor,...safe}=full;
      this.record.pending={action,input:safe,hadEditor:!!editor,...composer,...step};
    }
    const p=this.pending;
    if(p.action!==action)throw failure('MODELING_REQUEST_PENDING');
    this.f.rounds?.touch(action);
    // A previous local save may have failed before transport. Never bypass the
    // durable original request on the next retry.
    this.persist();
    let result;
    try{result=await this.f.read(p.action,p.input);}catch(e){if(refused(e)){this.pending=null;delete this.record.pending;this.persist();}throw e;}
    await this.settle(p,result);return result;
  }
  async settle(p,result){
    const scope=this.scope,before=clone({saved:this.saved,state:this.state,owner:this.owner});
    const flowBefore=Object.fromEntries(['selectedIntent','input','goalDirty','plan','acceptedOntology','inspectCard'].map(k=>[k,this.f.state[k]]));
    try{
      await this.accept(p,result);
      // Applying a goal may select a new intent. Settle the request on the
      // original scope, where its durable recovery envelope was stored.
      delete this.saved.scopes[scope].pending;this.persist();
    }catch(e){
      this.saved=before.saved;this.state=before.state;this.owner=before.owner;this.scope=scope;
      Object.assign(this.f.state,flowBefore);throw e;
    }
    this.pending=null;
  }
  async accept(p,result){
    if(p.action.startsWith('conversation-instruction-'))return this.f.instructions.accept(p,result);
    if(p.action==='conversation-change-save'){
      if(result.draft_id!==p.input.draftId||result.status!=='editing'||result.revision!==p.input.revision+1)throw failure('SEMANTICA_INVALID_RESPONSE');
      this.state.exclusion=null;this.state.preview=null;this.state.publishConfirmed=false;this.state.issueSelection=[];this.state.selected=[];this.state.context=null;
      this.record.savedDraftRevision=result.revision;
    }else if(p.action==='conversation-change-discard'){
      if(result.draft_id!==p.input.draftId||result.status!=='discarded'||result.revision!==p.input.revision+1)throw failure('SEMANTICA_INVALID_RESPONSE');
      this.record.deferredProposal=latestChange(this.f)?.id;delete this.record.draftId;
      this.owner=null;this.resetView();this.f.state.autoSwitch=false;
    }else if(p.action.endsWith('-generate')){
      if(!result.id&&!result.resource_id)throw failure('SEMANTICA_INVALID_RESPONSE');
      result.id||=result.resource_id;this.record.lastProposal=result.id;
      if(this.record.changeTarget){this.record.proposalTargets??={};this.record.proposalTargets[result.id]=this.record.changeTarget;}
      this.state.proposals=[result,...this.state.proposals.filter(v=>v.id!==result.id)];
      const submitted=p.composerInput??p.input.instruction;
      if(this.f.state.input===submitted){this.f.state.input='';this.state.evidenceReference=null;}
      else this.f.evidence?.syncInput();
      const composer=this.f.saved.materialComposers?.[p.input.conversationId+':'+p.input.intentId];
      if(composer?.input===submitted){composer.input='';delete composer.sourceFragment;}
    }else if(p.action.endsWith('-draft-create')){
      if(!result.draft_id||result.status!=='editing'||!Number.isSafeInteger(result.lease_generation))throw failure('SEMANTICA_INVALID_RESPONSE');
      this.owner.draftId=result.draft_id;this.owner.editor.generation=String(result.lease_generation);this.record.draftId=result.draft_id;
    }else if(p.action.endsWith('-publish-retry')){
      if(result.status!=='submitted'||result.draft_id!==p.input.draftId)throw failure('SEMANTICA_INVALID_RESPONSE');
    }else if(p.action.endsWith('-apply')){
      if(result.status!=='applied'||result.publication_performed!==false||result.extraction_started!==false)throw failure('SEMANTICA_INVALID_RESPONSE');
      this.applied(result,p.input.intentId);
    }else if(p.action.endsWith('-publish')){
      if(p.action==='conversation-change-rule-publish'){
        // Verify the actual published version after a rule publication receipt.
        const rules=await this.f.read('conversation-ontologies');
        if(!rules.items.some(o=>o.id===p.input.ontologyId&&o.status==='published'))throw failure('MODELING_ONTOLOGY_CHANGED');
        delete this.record.ontologyDraftId;this.state.ruleConfirmed=false;
        this.record.rulesPublished={ontologyId:p.input.ontologyId,documentVersionId:this.f.state.detail?.document_version_id};
      }else{if(!result.draft_id||result.status!=='submitted')throw failure('SEMANTICA_INVALID_RESPONSE');this.state.preview=null;this.state.publishConfirmed=false;}
    }
  }
  applied(receipt,oldIntent){
    const selected=receipt.active_intent_id||oldIntent;
    this.record.application=receipt;this.record.ontologyDraftId=receipt.ontology_draft_id||null;
    if(receipt.draft_id)this.record.draftId=receipt.draft_id;
    if(selected!==oldIntent){
      const key=JSON.stringify([this.f.saved.conversationId,selected]);
      this.saved.scopes[key]={...this.saved.scopes[key],changeTarget:this.record.changeTarget,ontologyDraftId:receipt.ontology_draft_id||null,draftId:receipt.draft_id||null,previousIntent:oldIntent,application:receipt};
      this.f.state.selectedIntent=selected;
      // A changed goal creates a new intent, but the document's private editing
      // session still owns the same draft. Keep it in memory across that handoff.
      const owner=this.owner?.draftId===receipt.draft_id?this.owner:null;
      this.scope=key;this.resetView();this.owner=owner;
    }
    this.state.preview=null;this.state.publishConfirmed=false;this.state.ruleConfirmed=false;
    this.state.selected=[];this.f.state.goalDirty=false;this.f.state.plan=null;this.f.state.acceptedOntology=null;
    this.f.state.inspectCard=null;
  }
  generate(instruction=this.f.state.input,local={}){return this.f.run(()=>this.generateNow(instruction,
    {...(instruction===this.f.state.input?{composerInput:this.f.state.input}:{}),...local}));}
  suggestRules(id){return this.f.run(async()=>{
    const p=latestChange(this.f);
    if(this.record.changeTarget!=='rules'||!p||p.id!==id||p.id===this.record.deferredProposal||!['needs_clarification','prepared','no_changes'].includes(p.status))throw failure('MODELING_CHANGE_STALE');
    const input=this.f.state.input;
    await this.generateNow(`${ruleUserInstruction(p.instruction)}\n请根据上述要求和当前目标，先建议实体或关系的中文名称和定义供我确认，不要要求我填写技术字段。沿用已回答的限制。${input.trim()?'\n本轮补充：'+input:''}`,{composerInput:input,ruleFollowup:true});
    if(this.f.state.input===input)this.f.state.input='';
    this.f.saveMaterialComposer?.();
  });}
  async generateNow(instruction,local={}){
    if(this.f.instructions?.open)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    if(this.state.exclusion)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    const preceding=latestChange(this.f),precedingDigest=this.state.context?.context_digest;
    const ruleFollowup=this.record.changeTarget==='rules'&&preceding?.id!==this.record.deferredProposal&&
      (local.ruleFollowup||['needs_clarification','prepared'].includes(preceding?.status));
    const factFollowup=this.record.changeTarget==='facts'&&preceding&&preceding.id!==this.record.deferredProposal&&['needs_clarification','prepared'].includes(preceding.status);
    const originalScope=this.scopeKey,draft=this.state.summary&&{id:this.state.summary.id,revision:this.state.summary.revision};
    await this.f.ready();this.bind();if(this.record.pending||this.pending)throw failure('MODELING_REQUEST_PENDING');
    if(originalScope!==this.scopeKey)throw failure('MODELING_SNAPSHOT_CHANGED');
    if(currentMaterialWorkflow(this.f)?.tasks?.some(t=>['queued','running','publishing'].includes(t.status))||['queued','running','generating'].includes(this.f.state.turn?.status))throw failure('MODELING_MATERIAL_BUSY');
    if(!this.independent&&this.state.summary){await this.loadDraft();if(this.state.summary.status!=='editing')throw failure('MODELING_CONFIRMATION_REQUIRED');
      if(this.state.summary.stale_reason)throw failure('MODELING_DRAFT_STALE');
      if(draft&&(draft.id!==this.state.summary.id||draft.revision!==this.state.summary.revision))throw failure('MODELING_CHANGE_STALE');}
    const related=this.independent||local.fixedSelection?null:await relatedSelection(this,instruction);
    if(related){
      const previous=latestChange(this.f);
      // Adding relations changes the context digest, so explicitly retain the
      // clarification's original request in this proposal's instruction.
      if(previous?.status==='needs_clarification'&&previous.id!==this.record.deferredProposal){
        instruction=`原修改要求：${previous.instruction}\n本轮补充：${instruction}`;
        if([...instruction].length>4000)throw failure('MODELING_CHANGE_CONTEXT_TOO_LARGE');
      }
      this.state.selected=related.ids;
      this.f.state.inputNotice=`已读取当前材料草稿中的 ${related.entityCount} 个选中实体及 ${related.relatedCount} 条关联关系，正在生成修改预览；尚未修改或发布。`;
    }
    await this.context();
    if(!this.state.context||this.state.needsDraft)throw failure('CORRECTION_SESSION_REQUIRED');
    if(factFollowup){
      if(preceding.status==='prepared'&&(!precedingDigest||precedingDigest!==this.state.context.context_digest))throw failure('MODELING_CHANGE_STALE');
      const previous={summary:preceding.result?.summary,questions:preceding.result?.questions,changes:preceding.result?.changes};
      instruction=validationInstruction(local.composerInput||instruction,`此前修改要求：${preceding.instruction}\n此前待确认建议（尚未应用；序号按 changes 顺序）：${JSON.stringify(previous)}\n本轮补充：${instruction}\n请生成合并本轮补充后的完整待确认建议；无法明确定位“第几条”时先提问，不要猜测或执行。`);
      if([...instruction].length>4000)throw failure('MODELING_CHANGE_CONTEXT_TOO_LARGE');
    }
    if(this.record.changeTarget==='rules'){
      // A short clarification only makes sense in the context the user saw.
      // Never move it to a refreshed ontology/goal as a standalone instruction.
      if(ruleFollowup&&(!precedingDigest||precedingDigest!==this.state.context.context_digest))throw failure('MODELING_CHANGE_STALE');
      if(['needs_clarification','prepared'].includes(preceding?.status)&&preceding.id!==this.record.deferredProposal&&precedingDigest===this.state.context.context_digest&&!ruleUserInstruction(instruction).startsWith(ruleUserInstruction(preceding.instruction))){
        instruction=`此前已说明：${ruleUserInstruction(preceding.instruction)}\n本轮补充：${ruleUserInstruction(instruction)}`;
      }
      instruction=ruleSuggestionInstruction(instruction);
      if([...instruction].length>4000)throw failure('MODELING_CHANGE_CONTEXT_TOO_LARGE');
    }
    if(!this.independent&&this.f.evidence)instruction=await this.f.evidence.instruction(instruction);
    await this.request('generate',{...this.ids(),...this.options(),contextDigest:this.state.context.context_digest,instruction},local);
  }
  apply(id){return this.f.run(async()=>{
    if(this.f.instructions?.open||this.record.instructionProposalIds?.includes(id))throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    this.bind();if(this.record.pending)throw failure('MODELING_REQUEST_PENDING');
    if(!this.independent&&this.state.summary?.stale_reason)throw failure('MODELING_DRAFT_STALE');
    const shown=this.state.proposals.find(p=>p.id===id);if(!shown||shown.id!==latestChange(this.f)?.id||shown.id===this.record.deferredProposal||shown.status!=='prepared'||shown.can_apply!==true||!shown.result?.changes?.length)throw failure('MODELING_CHANGE_STALE');
    if(hasChangeConflicts(shown.result))throw failure('MODELING_CHANGE_STALE');
    if(!this.proposalAllowed(shown))throw failure('MODELING_CHANGE_SCOPE_MISMATCH');
    const current=await this.call('read',{...this.ids(),proposalId:id,...(!this.independent&&this.owner?{editor:this.editor()}:{})});
    if(!current.can_apply||current.proposal_digest!==shown.proposal_digest){this.state.proposals=this.state.proposals.map(p=>p.id===id?current:p);throw failure('MODELING_CHANGE_STALE');}
    if(hasChangeConflicts(current.result))throw failure('MODELING_CHANGE_STALE');
    if(!this.proposalAllowed(current))throw failure('MODELING_CHANGE_SCOPE_MISMATCH');
    await this.request('apply',{...this.ids(),proposalId:id,proposalDigest:shown.proposal_digest,confirmed:true,...(!this.independent&&this.owner?{editor:this.editor()}:{})});
    await this.f.snapshot();this.bind();if(!this.independent&&this.owner)await this.loadDraft();await this.context();
  });}
  async recover(){let discardedDocument=null;await this.f.run(async()=>{
    this.bind();const p=this.pending||this.record.pending;if(!p)return;
    if(p.action==='conversation-change-discard'&&!this.pending&&p.hadEditor){
      // A completed discard has no active lease to claim after restart. Read
      // its private terminal state with a fresh session; never replay the write
      // under a different session (server idempotency is session scoped).
      if(p.input.documentId!==this.f.state.detail?.document_id)throw failure('MODELING_SNAPSHOT_CHANGED');
      await this.ensureSession();
      const draft=await this.call('draft',{documentId:p.input.documentId,draftId:p.input.draftId,editor:this.editor()});
      if(draft.id===p.input.draftId&&draft.status==='discarded'&&draft.revision===p.input.revision+1){
        await this.settle(p,{draft_id:draft.id,status:draft.status,revision:draft.revision});
        discardedDocument=p.input.documentId;return;
      }
      if(draft.id!==p.input.draftId||draft.status!=='editing')throw failure('MODELING_CHANGE_RECOVERY_REQUIRED');
    }
    if(!this.pending&&p.hadEditor){
      if(p.action==='conversation-instruction-confirm'&&this.owner?.draftId){
        const plan=await this.f.instructions.call('read',{planId:p.input.planId,editor:this.editor()});
        const step=plan.steps?.find(s=>s.id===p.instructionStep?.id);
        if(step?.status==='completed'&&step.receipt&&plan.revision>=p.input.revision+1){
          await this.settle(p,{resource_id:p.input.planId,revision:p.input.revision+1,step_id:step.id,receipt:step.receipt});
          await this.f.snapshot();this.bind();if(this.owner?.draftId)await this.loadDraft();await this.f.instructions.read();return;
        }
      }
      // Private sessions are never persisted. First read any already-applied
      // receipt; an explicitly claimed lease may then reauthorize the exact
      // original business request (same operation ID, digest and selection).
      if(p.action.endsWith('-apply')&&p.input.proposalId&&this.owner){
        const result=await this.call('read',{conversationId:p.input.conversationId,intentId:p.input.intentId,proposalId:p.input.proposalId,editor:this.editor()});
        if(result.status==='applied'){await this.settle(p,result.application);await this.f.snapshot();this.bind();if(!this.independent&&this.owner)await this.loadDraft();await this.context();return;}
      }
      if(!this.owner?.draftId||p.input.draftId&&p.input.draftId!==this.owner.draftId)throw failure('MODELING_CHANGE_RECOVERY_REQUIRED');
      this.pending={...p,input:{...clone(p.input),editor:this.editor()}};
    }
    this.pending||={...p,input:clone(p.input)};
    await this.request(p.action.startsWith('conversation-instruction-')?p.action.slice('conversation-'.length):p.action.slice('conversation-change-'.length),p.input);
    if(p.action==='conversation-change-discard'){discardedDocument=p.input.documentId;return;}
    await this.f.snapshot();this.bind();if(!this.independent&&this.owner)await this.loadDraft();
    if(p.action.startsWith('conversation-instruction-'))await this.f.instructions.read();
    else if(p.action!=='conversation-change-save')await this.context();
  });if(discardedDocument&&!this.f.state.error)await this.returnToAutomatic(discardedDocument);}
  async returnToAutomatic(documentId){
    await this.f.importer.select(documentId);
    if(!this.f.state.error)await this.f.importer.automatic();
  }
  async ensureSession(){
    const documentId=this.f.state.detail?.document_id;if(!documentId)throw failure('MODELING_SOURCE_NOT_READY');
    if(this.owner?.documentId===documentId)return;
    const value=await this.f.read('conversation-editor-session',{documentId,operationId:this.f.uuid()});
    this.owner={documentId,editor:{session:value.editor_session,generation:'0'}};
  }
  adoptMergedDraft(receipt,context){
    if(!receipt.draft_id||!Number.isSafeInteger(receipt.lease_generation)||!Number.isSafeInteger(receipt.draft_revision))throw failure('SEMANTICA_INVALID_RESPONSE');
    this.bind();this.owner={documentId:context.documentId,draftId:receipt.draft_id,editor:{session:context.editor.session,generation:String(receipt.lease_generation)}};
    this.record.draftId=receipt.draft_id;this.record.savedDraftRevision=receipt.draft_revision;
    this.state.context=null;this.state.leases=[];this.state.needsDraft=false;this.persist();
  }
  openDraft(){return this.f.run(async()=>{
    await this.f.snapshot();this.bind();
    if(!this.record.pending&&!this.claimRequest)this.setTarget('facts');
    if(this.owner?.draftId&&this.owner.documentId===this.f.state.detail?.document_id){
      try{await this.loadDraft();await this.context();return;}
      catch(e){
        if(e.status!==409||!['CORRECTION_SESSION_REQUIRED','CORRECTION_SESSION_CONFLICT','CORRECTION_LEASE_EXPIRED','CORRECTION_LEASE_CHANGED'].includes(e.code))throw e;
        // Expired or transferred ownership requires an explicit claim. Keep any
        // durable request for recovery, but discard its stale private credential.
        this.owner=null;this.pending=null;this.resetView();
      }
    }
    await this.ensureSession();
    if(this.f.state.detail?.review?.status==='discarded'&&(!this.record.draftId||this.record.draftId===this.f.state.detail.review.draft_id)){
      this.owner.draftId=this.f.state.detail.review.draft_id;await this.loadDraft();return;
    }
    const leases=await this.f.read('conversation-editor-leases',{documentId:this.owner.documentId,operationId:this.f.uuid(),editor:this.editor()});
    this.state.leases=leases.items;
    const submitted=leases.items.find(d=>d.draft_id===(this.record.draftId||this.f.state.detail?.review?.draft_id)&&d.status==='submitted'&&!d.legacy_unowned);
    if(submitted){this.owner.draftId=submitted.draft_id;await this.loadDraft();}
  });}
  async claim(id,confirmation=null){let loaded=false;await this.f.run(async()=>{
    const recoveringPlan=!this.pending&&this.record.pending?.action?.startsWith('conversation-instruction-')&&this.record.pending.hadEditor;
    if(this.f.saved.pending||this.f.reviewPending||this.f.claimPending||this.f.releasePending||this.pending||this.record.pending&&!recoveringPlan)throw failure('MODELING_REQUEST_PENDING');
    const checkConfirmation=()=>{
      const d=this.f.state.detail,lease=this.state.leases.find(l=>l.draft_id===id),revision=this.claimRequest?.draftId===id?this.claimRequest.revision:lease?.revision;
      if(confirmation&&(this.state.claimConfirmation!==confirmation||confirmation.scope!==this.scopeKey||confirmation.documentId!==d?.document_id||confirmation.versionId!==d?.document_version_id||confirmation.draftId!==id||confirmation.revision!==revision)){
        this.state.claimConfirmation=null;throw failure('CORRECTION_LEASE_CHANGED');
      }
    };
    checkConfirmation();
    if(this.claimRequest&&(this.claimRequest.draftId!==id||this.claimRequest.documentId!==this.f.state.detail?.document_id))throw failure('MODELING_REQUEST_PENDING');
    const lease=this.state.leases.find(d=>d.draft_id===id);if(!this.claimRequest&&(!lease||lease.legacy_unowned||lease.status!=='editing'))throw failure('CORRECTION_LEASE_CHANGED');
    await this.ensureSession();
    checkConfirmation();
    this.claimRequest||={documentId:this.owner.documentId,draftId:id,revision:lease.revision,editor:this.editor(),operationId:this.f.uuid()};
    const request=this.claimRequest;
    let receipt;
    try{receipt=await this.f.read('conversation-editor-claim',this.claimRequest);}catch(e){if(refused(e)){this.claimRequest=null;this.state.claimConfirmation=null;}throw e;}
    if(receipt?.draft_id!==request.draftId||receipt.revision!==request.revision||!Number.isSafeInteger(receipt.lease_generation)||receipt.lease_generation<1)throw failure('SEMANTICA_INVALID_RESPONSE');
    this.claimRequest=null;this.state.claimConfirmation=null;
    this.owner={documentId:request.documentId,draftId:id,editor:{session:request.editor.session,generation:String(receipt.lease_generation)}};this.state.leases=[];
    this.record.draftId=id;this.persist();
    await this.loadDraft();await this.context();loaded=true;
  });return loaded;}
  async loadDraft(offset=0,kind=this.state.kind){
    const owner=this.owner;if(!owner?.draftId)return;
    const base={documentId:owner.documentId,draftId:owner.draftId,editor:this.editor()};
    const summary=await this.call('draft',base);
    // Revoke a stale confirmation as soon as a newer header is known. The
    // subsequent item read can fail and must not leave old publish controls live.
    if(this.state.summary?.id!==summary.id||this.state.summary?.revision!==summary.revision||this.state.summary?.status!==summary.status||this.state.summary?.stale_reason!==summary.stale_reason){
      this.state.evidencePicker=null;this.state.evidenceReference=null;
      this.state.preview=null;this.state.exclusion=null;this.state.publishConfirmed=false;this.state.selected=[];this.state.issueSelection=[];this.state.source=null;this.state.sourceFor=null;this.state.knownItems={};this.state.factFilter={};this.state.context=null;this.state.ruleConfirmed=false;this.state.items=null;
    }
    this.state.summary=summary;
    const page=await this.call('items',{...base,revision:summary.revision,kind,offset,limit:20});
    if(page.revision!==summary.revision)throw failure('CORRECTION_REVISION_CONFLICT');
    this.state.summary=summary;this.state.items=page;this.state.kind=kind;
    this.state.knownItems={...this.state.knownItems,...Object.fromEntries(page.items.map(i=>[i.id,i]))};
    if(summary.status==='submitted'){
      this.state.publication=await this.call('publication',base);
      await this.readPublishedDraft(base,summary);
    }
    this.state.needsDraft=false;
  }
  async readPublishedDraft(base,summary){
    const p=this.state.publication;
    // Later correction drafts need not be linked to the original extraction
    // intent's review receipt. Bind their publication to the material's current
    // run using authoritative reads on both sides of the knowledge read.
    if(p?.status!=='succeeded'||p.effective!==true||p.run_status!=='published')return;
    const d=await this.f.read('conversation-intent',this.ids());
    const id=d.outcome?.current_run_id;
    if(!id||!materialSourceUsable(d)||d.document_id!==base.documentId||d.document_version_id!==summary.document_version_id||p.document_version_id!==d.document_version_id)return;
    const known=this.f.state.knowledge;
    if(known?.run?.id===id&&known.verifiedCorrectionPublication?.id===p.id)return;
    const knowledge=await this.f.read('conversation-published-run',{runId:id});
    const publication=await this.call('publication',base);
    const latest=await this.f.read('conversation-intent',this.ids());
    if(publication?.id!==p.id||publication.status!=='succeeded'||publication.effective!==true||publication.run_status!=='published'||
      publication.document_version_id!==d.document_version_id||latest.outcome?.current_run_id!==id||latest.document_version_id!==d.document_version_id||
      latest.document_id!==base.documentId||!materialSourceUsable(latest)||
      knowledge?.run?.id!==id||knowledge.run.status!=='published'||knowledge.run.document_id!==base.documentId||
      knowledge.run.document_version_id!==d.document_version_id||!Array.isArray(knowledge.candidates))throw failure('MODELING_SNAPSHOT_CHANGED');
    this.f.state.detail=latest;
    this.f.state.knowledge={...knowledge,verifiedCorrectionPublication:{...publication,document_id:base.documentId,current_run_id:id}};
  }
  page(offset,kind=this.state.kind){return this.f.run(async()=>{this.state.factFilter={};await this.loadDraft(offset,kind);});}
  source(id,itemId=null){return this.f.run(async()=>{
    const s=this.state.summary,owner=this.owner;if(!s)return;
    this.state.source=null;this.state.sourceFor=null;this.f.emit?.();
    const source=await this.call('source',{documentId:owner.documentId,draftId:s.id,revision:s.revision,sourceId:id,start:0,editor:this.editor()});
    if(this.owner!==owner||this.state.summary?.id!==s.id||this.state.summary.revision!==s.revision)throw failure('CORRECTION_REVISION_CONFLICT');
    this.state.source=source;this.state.sourceFor=itemId;
  });}
  preview(){return this.f.run(async()=>{
    if(this.f.instructions?.open)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    if(this.state.exclusion)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    if(this.record.pending)throw failure('MODELING_REQUEST_PENDING');
    const proposal=latestChange(this.f);
    if(proposal&&proposal.id!==this.record.deferredProposal&&['generating','prepared','needs_clarification','failed','stale'].includes(proposal.status))throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    // An explicit reread revokes the old confirmation even if it fails before
    // a newer draft or preview is received.
    this.state.preview=null;this.state.publishConfirmed=false;
    await this.loadDraft();const s=this.state.summary;
    if(s?.stale_reason)throw failure('MODELING_DRAFT_STALE');
    if(!s||s.status!=='editing')throw failure('CORRECTION_BASE_CHANGED');
    const base={documentId:this.owner.documentId,draftId:s.id,revision:s.revision,editor:this.editor()};
    let result,items=[];
    for(let offset=0;offset<10000;offset+=50){const page=await this.call('preview',{...base,offset,limit:50});
      if(page.revision!==s.revision)throw failure('CORRECTION_REVISION_CONFLICT');
      if(page.stale_reason){
        this.state.summary={...s,stale_reason:page.stale_reason};this.state.selected=[];this.state.context=null;this.state.ruleConfirmed=false;
        throw failure('MODELING_DRAFT_STALE');
      }
      result=page;items.push(...page.items);if(items.length>=page.total)break;if(!page.items.length)throw failure('SEMANTICA_INVALID_RESPONSE');}
    if(items.length!==result.total)throw failure('MODELING_CHANGE_CONTEXT_TOO_LARGE');
    const w=currentMaterialWorkflow(this.f);
    const unchanged=items.length===0&&s.ontology_status!=='draft'&&w?.document_version_id===this.f.state.detail?.document_version_id&&publishedMaterial(w);
    const complete={...result,items,unchanged_published:unchanged,...(unchanged?{ready_for_confirmation:false}:{})};
    if(unchanged)this.f.state.inputNotice='当前草稿与已发布内容一致，没有可发布的修改。请先生成建议并确认应用到草稿。';
    if(complete.issues?.length){const data=await validationFacts(this,complete);complete.issue_items=data.issues;}
    this.state.preview=complete;this.state.publishConfirmed=false;this.f.state.inspectCard=null;
    this.f.state.composerContext=null;this.f.state.inputRouting=null;if(!unchanged)this.f.state.inputNotice='';
  });}
  publish(){return this.f.run(async()=>{
    if(this.f.instructions?.open)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    if(this.state.exclusion)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    const s=this.state.summary,p=this.state.preview;
    if(s?.stale_reason)throw failure('MODELING_DRAFT_STALE');
    if(!s||!p||p.unchanged_published||p.revision!==s.revision||p.ready_for_confirmation!==true||!this.state.publishConfirmed||s.status!=='editing')throw failure('MODELING_CONFIRMATION_REQUIRED');
    await this.request('publish',{documentId:this.owner.documentId,draftId:s.id,revision:s.revision,confirmed:true,editor:this.editor()});
    await this.loadDraft();await this.f.snapshot();
  });}
  publishRules(){return this.f.run(async()=>{
    if(this.f.instructions?.open)throw failure('MODELING_CHANGE_REVIEW_REQUIRED');
    const target=this.record.ontologyDraftId;
    if(!target||!this.independent&&this.state.summary||!this.state.ruleConfirmed||this.state.context?.ontology_id!==target)throw failure('MODELING_CONFIRMATION_REQUIRED');
    await this.request('rule-publish',{ontologyId:target});await this.f.snapshot();await this.context();
  });}
  continueExtraction(){return this.f.run(async()=>{
    const shown=this.record.rulesPublished,original=this.f.state.selectedIntent;
    if(!shown)throw failure('MODELING_CONFIRMATION_REQUIRED');
    await this.f.ready();this.bind();const f=this.f,d=f.state.detail;
    if(original!==f.state.selectedIntent||shown.ontologyId!==f.state.ontology?.id||shown.documentVersionId!==d?.document_version_id)throw failure('MODELING_SNAPSHOT_CHANGED');
    if(nextConversationStep(f)!=='rules-ready')throw failure('MODELING_CONFIRMATION_REQUIRED');
    if(!materialSourceUsable(d))throw failure('MODELING_SOURCE_CHANGED');
    if(f.intake.hasEdits||f.state.reviewingSource)throw failure('MODELING_SOURCE_SAVE_REQUIRED');
    if(currentMaterialWorkflow(f)?.tasks?.some(t=>['queued','running','publishing'].includes(t.status)))throw failure('MODELING_MATERIAL_BUSY');
    const goal=f.state.goalDirty?f.state.goal:d.goal?.goal||f.saved.confirmedGoals?.[d.id]?.goal||f.state.goal||'';
    const instructions=f.state.goalDirty?f.state.instructions:d.goal?.instructions??f.saved.confirmedGoals?.[d.id]?.instructions??f.state.instructions??'';
    // Continue with an unconfirmed goal, never through automatic processing.
    f.saved.materialContinuationRequest={mode:'restart',ruleContinuation:true,sourceReviewed:f.intake.sourceReviewed,fromIntent:d.id,conversationId:f.saved.conversationId,documentId:d.document_id,versionId:d.document_version_id,goal,instructions};
    await f.write('conversation-intent-create',{conversationId:f.saved.conversationId,revision:f.state.overview.revision,documentId:d.document_id},'material-continue');
    await f.snapshot();f.state.inspectCard='goal';f.state.composerContext='goal';
    f.state.inputNotice='已进入新的对话抽取流程。请核对整理目标，确认后查看抽取计划；尚未开始抽取。';
  });}
  retryPublication(){return this.f.run(async()=>{
    if(!['failed','cancelled'].includes(this.state.publication?.status))throw failure('MODELING_CONFIRMATION_REQUIRED');
    await this.request('publish-retry',{documentId:this.owner.documentId,draftId:this.owner.draftId,editor:this.editor()});
    await this.loadDraft();await this.f.snapshot();
  });}
  newDraft(){return this.f.run(async()=>{
    if(this.state.summary?.status!=='submitted'||this.state.publication?.status!=='succeeded')throw failure('MODELING_CONFIRMATION_REQUIRED');
    await this.ensureSession();await this.request('draft-create',{documentId:this.owner.documentId,editor:this.editor()});
    this.state.publication=null;await this.loadDraft();await this.context();
  });}
  editMaterial(){return this.f.run(async()=>{
    await this.f.ready();this.bind();
    this.setTarget('facts');
    const documentId=this.f.state.detail?.document_id;
    const workflow=await this.f.read('conversation-material-workflow',{documentId});
    if(workflow.document_id!==documentId||workflow.document_version_id!==this.f.state.detail?.document_version_id)throw failure('MODELING_SOURCE_CHANGED');
    if(workflow.tasks?.some(t=>['queued','running'].includes(t.status)))throw failure('MODELING_MATERIAL_BUSY');
    if(workflow.stage==='awaiting_review'&&!workflow.draft){
      // Automatic candidates are not the published baseline. Use the existing
      // extraction-result merge controls instead of opening an empty fact draft.
      this.f.state.openDetailedEditor=documentId;this.f.state.openMaterialEditor=false;return;
    }
    await this.ensureSession();
    if(this.owner?.draftId&&this.state.summary?.status==='editing'){
      await this.loadDraft();await this.context();this.f.state.inspectCard='draft';this.f.state.openMaterialEditor=false;return;
    }
    const leases=await this.f.read('conversation-editor-leases',{documentId,editor:this.editor(),operationId:this.f.uuid()});
    this.state.leases=leases.items.filter(d=>d.status==='editing');
    this.f.state.inspectCard='draft';this.f.state.openMaterialEditor=false;
    if(this.state.leases.length){this.state.needsDraft=true;return;}
    if(!workflow.publication&&workflow.stage!=='awaiting_review')throw failure('MODELING_SOURCE_NOT_READY');
    await this.request('draft-create',{documentId,editor:this.editor()});
    this.state.publication=null;await this.loadDraft();await this.context();
  });}
  prepareDiscard(){
    if(this.f.state.busy||this.record.pending||this.state.summary?.status!=='editing'||!this.owner?.draftId)return;
    this.state.discardPrompt={documentId:this.owner.documentId,id:this.state.summary.id,revision:this.state.summary.revision};this.f.emit();
  }
  async discardForAutomatic(){
    const shown=this.state.discardPrompt;if(!shown)return;
    let discarded=false;
    await this.f.run(async()=>{
      if(this.f.saved.pending||this.record.pending||this.owner?.documentId!==shown.documentId||this.owner?.draftId!==shown.id)throw failure('MODELING_REQUEST_PENDING');
      const fresh=await this.call('draft',{documentId:shown.documentId,draftId:shown.id,editor:this.editor()});
      if(fresh.id!==shown.id||fresh.revision!==shown.revision||fresh.status!=='editing'){this.state.discardPrompt=null;throw failure('CORRECTION_REVISION_CONFLICT');}
      const w=await this.f.read('conversation-material-workflow',{documentId:shown.documentId});
      if(w.tasks?.some(t=>['queued','running'].includes(t.status)))throw failure('MODELING_MATERIAL_BUSY');
      if(w.document_id!==shown.documentId)throw failure('MODELING_SNAPSHOT_CHANGED');
      if(pendingExtractionReview(this.f,w))throw failure('MATERIAL_REEXTRACTION_REVIEW_REQUIRED');
      await this.request('discard',{documentId:shown.documentId,draftId:shown.id,revision:shown.revision,confirmed:true,editor:this.editor()});discarded=true;
    });
    if(discarded&&!this.f.state.error)await this.returnToAutomatic(shown.documentId);
  }
  async tick(){
    const f=this.f;if(f.intake?.record&&!f.intake.sourceReviewed&&!retainedMaterialResults(f.state.detail)||!f.state.loaded||f.state.busy||f.state.error&&f.state.errorFromBackground&&!f.state.progressRetryable||f.saved.pending||f.reviewPending||f.claimPending||f.releasePending||this.claimRequest)return;
    this.bind();if(this.record.pending)return;
    const d=f.state.detail,editable=d?.document_version_id&&materialSourceUsable(d)&&!['queued','running'].includes(d.status)&&(d.status!=='cancelled'||this.state.summary?.id===d.review?.draft_id);
    const heartbeat=!this.independent&&this.owner?.draftId&&this.state.summary?.status==='editing'&&Date.now()-(this.lastHeartbeat||0)>=60000;
    const publishing=!this.independent&&(['queued','running'].includes(this.state.publication?.status)||this.state.summary?.status==='submitted'&&!this.state.publication);
    const generating=latestChange(f)?.status==='generating';
    const context=editable&&(!f.intake?.record||this.record.lastProposal||this.record.draftId||this.record.ontologyDraftId)&&!this.state.context&&!this.state.needsDraft&&(this.independent||!this.state.summary||this.state.summary.status==='editing'&&!this.state.summary.stale_reason);
    if(!heartbeat&&!publishing&&!generating&&!context)return;
    await f.run(async()=>{
      this.bind();if(this.record.pending)return;
      if(heartbeat){await this.call('heartbeat',{documentId:this.owner.documentId,draftId:this.owner.draftId,revision:this.state.summary.revision,editor:this.editor()});this.lastHeartbeat=Date.now();}
      if(publishing){await this.loadDraft();await f.snapshot();}
      const generating=this.state.proposals.filter(p=>p.id===latestChange(f)?.id&&p.status==='generating');
      for(const p of generating){const fresh=await this.call('read',{...this.ids(),proposalId:p.id,...(!this.independent&&this.owner?{editor:this.editor()}:{})});this.state.proposals=this.state.proposals.map(v=>v.id===p.id?fresh:v);}
      if(!this.state.context&&!this.state.needsDraft)await this.context();
      // Initial reading must not launch a second model request or interrupt a
      // goal/plan card with unsolicited rule changes. Suggestions are on demand.
    },{background:true});
  }
  clear(){this.resetView();this.owner=null;this.pending=null;this.claimRequest=null;this.scope='';this.lastHeartbeat=0;}
}
