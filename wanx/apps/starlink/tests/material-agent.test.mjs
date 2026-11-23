import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {materialCommand,materialAutomaticCard,materialAgentFeedback,materialAgentTools,materialJobRetryAllowed} from '../ui/material-agent.mjs';
import {conversationInputRoute,nextConversationStep} from '../ui/conversation-next.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';
import {intakeCard} from '../ui/conversation-intake.mjs';
import {stoppedMaterialCard} from '../ui/material-continuation.mjs';
import {validationSuggestionRequest} from '../ui/material-validation-selection.mjs';

const digest='a'.repeat(64);
test('validation suggestion language selects a preview while questions, negations and extra actions do not',()=>{
  for(const text of ['请根据这些警告给出修正建议','生成修正建议','帮我给出这些问题的调整方案'])assert.equal(validationSuggestionRequest(text),true,text);
  for(const text of ['不要生成修正建议','是否可以生成修正建议？','生成修正建议并发布','针对其他仓库的问题给出修正建议'])assert.equal(validationSuggestionRequest(text),false,text);
  assert.equal(materialCommand('确认应用到草稿'),'apply-change');
  for(const text of ['下一步','确认发布','确认应用到草稿并发布','不要确认应用到草稿','第二条保留，其他按建议调整'])assert.notEqual(materialCommand(text),'apply-change',text);
});
test('dialogue suggestion and explicit confirmation use the currently displayed plan without publishing',async()=>{
  const h=harness(),f=h.flow;let suggested,applied;
  f.changes.adjustIssues=async options=>{suggested=options;};f.changes.apply=async id=>{applied=id;};
  f.state.input='请根据这些警告给出修正建议';await f.submitInput();assert.equal(suggested.suggest,true);assert.equal(suggested.all,true);
  f.changes.state.proposals=[{id:'current',status:'prepared',can_apply:true}];
  f.state.input='确认应用到草稿';await f.submitInput();assert.equal(applied,'current');assert.equal(f.state.input,'');
  applied=null;f.changes.record.deferredProposal='current';f.state.input='确认应用到草稿';await f.submitInput();assert.equal(applied,null);assert.equal(f.state.input,'确认应用到草稿');
  assert.equal(h.requests.some(r=>/change-(apply|publish)|processing-confirm/.test(r.action)),false);
});
test('explicit automatic extraction selects the existing preview command without swallowing extra scope',()=>{
  assert.equal(materialCommand('自动抽取'),'reextract');assert.equal(materialCommand('请自动抽取'),'reextract');
  assert.equal(materialCommand('自动抽取所有材料'),null);assert.equal(materialCommand('自动抽取，供应链相关内容'),null);
  for(const text of ['将文件重新自动抽取','把这份材料重新自动抽取','请帮我重新自动抽取当前材料','将当前文档自动提取'])assert.equal(materialCommand(text),'reextract',text);
  for(const text of ['将文件重新自动抽取并发布','将所有文件重新自动抽取','不要将文件重新自动抽取','将文件重新自动抽取，只关注产品'])assert.equal(materialCommand(text),null,text);
});

test('natural current-file automatic request replaces goal intent with a preview and does not submit extraction',async()=>{
  const h=harness(),f=h.flow;f.state.input='将文件重新自动抽取';f.state.composerContext='goal';f.state.inputRouting='compound';f.state.inputNotice='旧目标提示';
  await f.submitInput();assert.equal(f.state.error,'');assert.ok(f.agent.record.preview);assert.equal(f.state.composerContext,null);
  assert.equal(f.state.inputRouting,null);assert.doesNotMatch(f.state.inputNotice,/旧目标提示|包含多个操作/);
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-preview'),true);
  assert.equal(h.requests.some(r=>/conversation-(?:goal|send|change-generate|processing-confirm)$/.test(r.action)),false);
});
const replacement={draft_count:2,modified_draft_count:1,candidate_result_count:3,modified_candidate_result_count:1,replaces_manual_publication:true,requires_acknowledgement:true,preserves_history:true,description:'旧成果保留为历史 <说明>',acknowledgement_digest:'b'.repeat(64)};

test('replacement impact must be shown and explicitly acknowledged for the exact preview',async()=>{
  const h=harness(),f=h.flow;Object.assign(h.preview,{contract_version:'1.1.0',replacement});
  await f.agent.prepareAutomatic();
  const html=materialAutomaticCard(f);
  assert.match(html,/旧草稿 2 份（人工修改 1 份）/);assert.match(html,/旧候选结果 3 组（人工调整 1 组）/);
  assert.match(html,/失败或取消时保留该材料原有的已发布知识/);assert.match(html,/&lt;说明&gt;/);assert.match(html,/data-replacement-acknowledgement="b{64}"/);
  await f.agent.confirmAutomatic();assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_ACK_REQUIRED');
  await f.agent.confirmAutomatic({previewId:'different',replacementAcknowledgement:replacement.acknowledgement_digest});
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
  await f.agent.confirmAutomatic({previewId:'preview',replacementAcknowledgement:replacement.acknowledgement_digest});
  assert.equal(f.state.error,'');assert.equal(h.requests.find(r=>r.action==='conversation-processing-confirm').input.replacementAcknowledgement,replacement.acknowledgement_digest);
  assert.equal(h.requests.some(r=>r.action==='conversation-change-discard'),false);
});

test('a click on a superseded preview never confirms a newer preview without an acknowledgement requirement',async()=>{
  const h=harness(),f=h.flow;await f.agent.prepareAutomatic();
  await f.agent.confirmAutomatic({previewId:'previous-preview',replacementAcknowledgement:replacement.acknowledgement_digest});
  assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_PREVIEW_STALE');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
});

test('unresolved draft mutations block both the automatic confirmation control and its handler',async()=>{
  const h=harness(),f=h.flow;await f.agent.prepareAutomatic();
  for(const pending of ['pending','claimRequest']){
    f.changes[pending]={action:'unknown'};
    assert.match(materialAutomaticCard(f),/data-cv="material-auto-confirm"[^>]*disabled/);
    await f.agent.confirmAutomatic();assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');
    f.changes[pending]=null;
  }
  f.changes.record.pending={action:'unknown'};
  await f.agent.confirmAutomatic();assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
});

test('dialogue workflow tasks keep cached automatic preview confirmation locked',async()=>{
  const h=harness(),f=h.flow;await f.agent.prepareAutomatic();
  f.state.dialogueWorkflow={document_id:'doc',tasks:[{status:'running'}]};
  assert.match(materialAutomaticCard(f),/data-cv="material-auto-confirm"[^>]*disabled/);
  await f.agent.confirmAutomatic();assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
});

test('accepted replacement retires cached editing state while preserving unrelated materials and ontology drafts',()=>{
  const h=harness(),f=h.flow;f.changes.bind();
  f.changes.owner={documentId:'doc',draftId:'old',editor:{session:'s'.repeat(30),generation:'1'}};
  Object.assign(f.changes.record,{draftId:'old',savedDraftRevision:2,previousIntent:'previous',ontologyDraftId:'unpublished-rules',lastProposal:'proposal'});
  f.changes.state.summary={id:'old',revision:2,status:'editing'};f.changes.state.selected=['fact'];
  f.saved.materialContinuations={intent:{documentId:'doc',mode:'draft',draftId:'old',goal:'old-goal',instructions:'old-constraints'}};
  f.saved.materialOperations={other:{transitionId:'unrelated'}};
  f.state.candidates={items:[{id:'old-fact'}]};f.state.merge={draft_id:'old'};
  f.agent.apply({action:'conversation-processing-confirm',input:{documentId:'doc'}},{receipt:{document_id:'doc',transition_id:'new',replacement}});
  assert.equal(f.changes.owner,null);assert.equal(f.changes.state.summary,null);assert.equal(f.changes.record.draftId,undefined);
  assert.equal(f.changes.record.previousIntent,undefined);assert.equal(f.changes.record.ontologyDraftId,'unpublished-rules');
  assert.equal(f.changes.record.deferredProposal,'proposal');assert.equal(f.state.candidates,null);assert.equal(f.state.merge,null);
  assert.equal(f.saved.materialContinuations.intent.draftId,null);assert.equal(f.saved.materialContinuations.intent.goal,'');
  assert.equal(f.saved.materialOperations.other.transitionId,'unrelated');
});

test('replacement authorization is absent for ordinary or legacy previews and cancellation does not write',async()=>{
  for(const extra of [{},{contract_version:'1.1.0',replacement:{...replacement,requires_acknowledgement:false}},{publication_policy:'review_required'}]){
    const h=harness(),f=h.flow;Object.assign(h.preview,extra);await f.agent.prepareAutomatic();
    await f.agent.confirmAutomatic({previewId:'preview',replacementAcknowledgement:replacement.acknowledgement_digest});
    assert.equal(f.state.error,'');assert.equal(h.requests.find(r=>r.action==='conversation-processing-confirm').input.replacementAcknowledgement,undefined);
  }
  const h=harness();Object.assign(h.preview,{contract_version:'1.1.0',replacement});await h.flow.agent.prepareAutomatic();h.flow.agent.cancelPreview();
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'||r.action==='conversation-change-discard'),false);
});

test('malformed replacement digest and stale impact cannot authorize replacement',async()=>{
  const h=harness(),f=h.flow;Object.assign(h.preview,{contract_version:'1.1.0',replacement:{...replacement,acknowledgement_digest:'invalid'}});
  await f.agent.prepareAutomatic();assert.match(materialAutomaticCard(f),/data-cv="material-auto-confirm"[^>]*disabled/);
  await f.agent.confirmAutomatic({previewId:'preview',replacementAcknowledgement:'invalid'});assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_ACK_REQUIRED');
  f.agent.record.preview.replacement.acknowledgement_digest=replacement.acknowledgement_digest;
  f.state.librarySelection={document:{id:'doc',workflow:{document_id:'doc',document_version_id:'corrected',workflow_revision:4}}};
  await f.agent.confirmAutomatic({previewId:'preview',replacementAcknowledgement:replacement.acknowledgement_digest});
  assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_PREVIEW_STALE');assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
});

test('lost replacement confirmation recovers the same operation and acknowledgement after restart',async()=>{
  const h=harness(),f=h.flow;Object.assign(h.preview,{contract_version:'1.1.0',replacement});
  await f.agent.prepareAutomatic();h.lose('conversation-processing-confirm');
  await f.agent.confirmAutomatic({previewId:'preview',replacementAcknowledgement:replacement.acknowledgement_digest});
  const original=structuredClone(f.saved.pending);assert.equal(original.input.replacementAcknowledgement,replacement.acknowledgement_digest);
  f.saved=structuredClone(f.saved);f.agent.record.preview.replacement.acknowledgement_digest='c'.repeat(64);
  await f.retryPending();assert.equal(f.saved.pending,null);
  assert.deepEqual(h.requests.filter(r=>r.action==='conversation-processing-confirm').map(r=>r.input),[original.input,original.input]);
});

test('another user draft or running work cannot be bypassed by requesting a replacement preview',async()=>{
  const h=harness(),f=h.flow;
  h.respond.set('conversation-material-workflow',()=>({document_id:'doc',document_version_id:'corrected',actions:{prepare_automatic:{allowed:false}},automatic_processing:{blockers:[{code:'MATERIAL_REVIEW_REQUIRED'}]},tasks:[]}));
  await f.agent.prepareAutomatic();assert.equal(f.state.errorCode,'MATERIAL_REVIEW_REQUIRED');
  h.respond.set('conversation-material-workflow',()=>({document_id:'doc',actions:{prepare_automatic:{allowed:true}},tasks:[{status:'running'}]}));
  await f.agent.prepareAutomatic();assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-preview'||r.action==='conversation-processing-confirm'||r.action==='conversation-change-discard'),false);
});

test('manual candidate protection stops old-job retries and persists until a new processing round',async()=>{
  const h=harness(),f=h.flow;f.saved.materialOperations={doc:{transitionId:'t'}};
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',job_id:'job'},current:{is_current:true,stage:'failed'}}));
  h.respond.set('conversation-job',()=>({id:'job',document_id:'doc',kind:'knowledge_extract',status:'failed'}));
  h.respond.set('conversation-job-retry',()=>{throw Object.assign(Error('reviewed'),{status:409,code:'MATERIAL_REVIEW_REQUIRED'});});
  await f.agent.sync();assert.equal(materialJobRetryAllowed(f.agent.current.failureJob),true);
  await f.agent.retryAutomatic();assert.equal(f.state.errorCode,'MATERIAL_REVIEW_REQUIRED');assert.equal(f.saved.pending,null);
  f.saved=structuredClone(f.saved);await f.agent.sync();assert.equal(materialJobRetryAllowed(f.agent.current.failureJob),false);
  assert.match(materialAutomaticCard(f),/候选已被人工调整/);
  await f.agent.retryAutomatic();assert.equal(h.requests.filter(r=>r.action==='conversation-job-retry').length,1);
  await f.agent.prepareAutomatic();assert.ok(f.agent.record.preview);
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
  for(const error_code of ['MATERIAL_REVIEW_REQUIRED','MATERIAL_PROCESSING_GENERATION_STALE'])assert.equal(materialJobRetryAllowed({kind:'knowledge_extract',status:'failed',error_code}),false);
});
test('stale published material binds current source without creating a draft or inheriting its old goal',async()=>{
  const h=harness(),f=h.flow;
  Object.assign(f.state.detail,{status:'stale',goal:{goal:'过时目标',instructions:'旧约束'},review:{draft_id:'old-draft'}});
  assert.match(stoppedMaterialCard(f),/material-current/);
  h.respond.set('conversation-material-workflow',()=>({document_id:'doc',document_version_id:'corrected',tasks:[],publication:{id:'published'}}));
  let edits=0;f.changes.editMaterial=async()=>{edits++;};
  await f.agent.dialogue();assert.equal(f.state.error,'');assert.equal(edits,0);
  assert.equal(f.state.selectedIntent,'new-intent');assert.equal(f.saved.materialContinuations['new-intent'].goal,'');
  assert.equal(f.saved.materialContinuations['new-intent'].versionId,'corrected');
  assert.equal(f.intake.record.goalDraft.instructions,'');assert.equal(f.intake.record.stage,'goal');
  assert.equal(h.requests.some(r=>['conversation-confirm','conversation-change-publish'].includes(r.action)),false);
});
test('failed workflow authorization cannot create a new processing intent or open a draft',async()=>{
  const h=harness();h.flow.state.detail.status='stale';
  h.respond.set('conversation-material-workflow',()=>{throw Object.assign(Error('denied'),{status:403,code:'FORBIDDEN'});});
  let edits=0;h.flow.changes.editMaterial=async()=>edits++;
  await h.flow.agent.dialogue();assert.equal(edits,0);assert.equal(h.requests.some(r=>r.action==='conversation-intent-create'),false);
  assert.equal(h.flow.state.loaded,false);
});

test('returning to dialogue keeps the current processing round instead of selecting the first old link',async()=>{
  const h=harness(),f=h.flow;
  const links=[{conversation_id:'session',intent_id:'old',conversation_status:'active'},{conversation_id:'session',intent_id:'intent',conversation_status:'active'}];
  h.respond.set('conversation-material-workflow',()=>({document_id:'doc',document:{id:'doc'},label:'可继续',tasks:[],conversations:links,actions:{start_dialogue:{allowed:false}}}));
  f.state.librarySelection={document:{id:'doc'}};
  let selected;f.selectMaterial=async(c,i)=>{selected=i;f.state.librarySelection=null;};
  assert.equal(await f.agent.ensureConversation(),true);assert.equal(selected,'intent');
  f.state.librarySelection={document:{id:'doc'}};f.state.selectedIntent=null;f.saved.resumedIntents={old:'intent'};
  assert.equal(await f.agent.ensureConversation(),true);assert.equal(selected,'intent');
});
function harness(){
  const requests=[],receipts=new Map(),storage=new Map(),respond=new Map();let count=0,lose=null;
  const preview={document_id:'doc',preview_id:'preview',preview_digest:digest,workflow_revision:3,can_confirm:true,snapshot:{document_version_id:'corrected'},publication_policy:'automatic',blockers:[]};
  const flow=new ConversationFlow({warehouseId:'warehouse',identity:{boxId:'b',user:{id:1}},storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},uuid:()=>`op-${++count}`,call:async(action,input)=>{
    requests.push({action,input:structuredClone(input)});
    if(respond.has(action))return structuredClone(await respond.get(action)(input));
    let value=receipts.get(input.operationId);
    if(!value){
      if(action==='conversation-material-workflow')value={document_id:'doc',document_version_id:'corrected',workflow_revision:3,document:{id:'doc',original_name:'材料'},actions:{prepare_automatic:{allowed:true},edit_source:{allowed:true}},tasks:[]};
      if(action==='conversation-processing-preview')value=preview;
      if(action==='conversation-processing-confirm')value={receipt:{document_id:'doc',transition_id:'transition',job_id:'job'}};
      if(action==='conversation-processing-status')value={receipt:{document_id:'doc'},current:{stage:'running',is_current:true}};
      if(action==='conversation-source-save')value={document:{id:'doc',segment_count:1},version:{id:'corrected'},segments:input.segments};
      if(action==='conversation-intent-create')value={resource_id:'new-intent',revision:1};
      if(input.operationId)receipts.set(input.operationId,structuredClone(value));
    }
    if(lose===action){lose=null;throw Object.assign(Error('lost'),{status:0});}
    return structuredClone(value);
  }});
  flow.state.loaded=true;flow.state.detail={id:'intent',document_id:'doc',document_version_id:'old',source_status:'available',status:'awaiting_goal'};
  flow.state.selectedIntent='intent';flow.saved.conversationId='session';flow.state.overview={revision:1};
  flow.saved.intakeReviews={intent:{versionId:'old',edits:{},name:'材料'}};
  flow.intake.source={document:{id:'doc',segment_count:1},version:{id:'old'},segments:[{id:'s',text:'原文'}]};
  flow.ready=async()=>{if(flow.saved.pending)throw Object.assign(Error('pending'),{code:'MODELING_REQUEST_PENDING'});};flow.snapshot=async()=>{};
  return {flow,requests,preview,storage,respond,lose:action=>lose=action};
}

test('rapid preview clicks do not duplicate operations; restoring and polling a lost preview never confirms extraction',async()=>{
  const h=harness(),f=h.flow;h.lose('conversation-processing-preview');
  await Promise.all([f.agent.prepareAutomatic(),f.agent.prepareAutomatic()]);
  const writes=()=>h.requests.filter(r=>r.action==='conversation-processing-preview');
  assert.equal(writes().length,1);assert.ok(f.saved.pending);
  const pending=structuredClone(f.saved.pending);
  await f.tick();await f.agent.sync();assert.equal(writes().length,1);
  await f.retryPending();assert.equal(f.state.error,'');assert.deepEqual(writes()[1].input,pending.input);
  assert.ok(f.agent.record.preview);await f.agent.sync();await f.tick();
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
  // Only a separate explicit confirmation submits the preview; rapid repeat
  // calls cannot convert the same click sequence into a second extraction.
  await Promise.all([f.agent.confirmAutomatic({previewId:'preview'}),f.agent.confirmAutomatic({previewId:'preview'})]);
  assert.equal(h.requests.filter(r=>r.action==='conversation-processing-confirm').length,1);
});

test('published material opens read-only knowledge and questions never create a draft, goal or proposal',async()=>{
  const h=harness(),f=h.flow;
  const w={document_id:'doc',document_version_id:'old',document:{id:'doc'},tasks:[],stage:'published',publication:{id:'published',status:'published',document_version_id:'old'}};
  h.respond.set('conversation-material-workflow',()=>w);
  h.respond.set('conversation-published-run',()=>({run:{id:'published',document_id:'doc',document_version_id:'old',status:'published'},candidates:[]}));
  h.respond.set('conversation-send',()=>({turn_id:'answer'}));
  f.intake.record.stage='goal';
  await f.agent.dialogue();assert.equal(f.state.error,'');assert.equal(f.state.dialogueKnowledge.run.id,'published');
  assert.equal(f.intake.goalStage,false);assert.equal(nextConversationStep(f),'published');
  Object.assign(f.state,{input:'需要如何修正',messageMode:'change',composerContext:'facts'});f.changes.state.selected=Array.from({length:20},(_,i)=>String(i));
  await f.submitInput();assert.equal(f.state.error,'');
  assert.equal(h.requests.find(r=>r.action==='conversation-send').input.content,'需要如何修正');
  assert.equal(h.requests.some(r=>['conversation-intent-create','conversation-goal','conversation-change-draft-create','conversation-change-generate'].includes(r.action)),false);
  Object.assign(f.state.detail,{review:{draft_id:'old-submitted',status:'submitted'}});
  assert.equal(nextConversationStep(f),'published');
});

test('publication changes during baseline loading update the list and never retain a withdrawn result',async()=>{
  const h=harness(),f=h.flow;let reads=0;
  const w={document_id:'doc',document_version_id:'old',stage:'published',publication:{id:'run',status:'published',document_version_id:'old'}};
  f.state.warehouseMaterials=[{id:'doc',workflow:w}];f.state.baselinePage=8;
  h.respond.set('conversation-material-workflow',()=>++reads===1?w:{...w,stage:'draft',publication:{...w.publication,status:'withdrawn'}});
  h.respond.set('conversation-published-run',()=>({run:{id:'run',document_id:'doc',document_version_id:'old',status:'published'},candidates:[]}));
  await f.agent.syncDialogue();
  assert.equal(f.state.dialogueKnowledge,null);assert.equal(f.state.baselinePage,0);
  assert.equal(f.state.warehouseMaterials[0].workflow.publication.status,'withdrawn');
});

test('automatic result and assistant exclude unpublished candidates from published knowledge',()=>{
  const h=harness(),f=h.flow;
  const candidates=['published','rejected','pending_review'].map(status=>({status,payload:{name:`fact-${status}`}}));
  f.state.materialOperation={documentId:'doc',current:{is_current:true,stage:'published',publication_performed:true},knowledge:{candidates}};
  for(const html of [materialAutomaticCard(f),materialAgentFeedback(f)]){
    assert.match(html,/fact-published/);assert.doesNotMatch(html,/fact-rejected|fact-pending_review/);
  }
});

test('published entities show their type as a badge beside the name',()=>{
  const f=harness().flow;
  f.state.ontology={schema:{entity_types:[{name:'DATE',label:'日期',properties:[]}],relation_types:[]}};
  f.state.materialOperation={documentId:'doc',current:{is_current:true,stage:'published',publication_performed:true},
    knowledge:{candidates:[{status:'published',kind:'entity',payload:{name:'V1.0',type:'DATE',properties:{}}}]}};
  const html=materialAutomaticCard(f);
  assert.match(html,/<div class="cv-fact-title"><h4>V1\.0<\/h4><span class="cv-fact-type">日期<\/span>/);
  assert.doesNotMatch(html,/<p>实体 · 日期<\/p>/);
});

test('acceptance receipts and an unconfirmed publication stage never claim effective publication',()=>{
  const f=harness().flow;
  f.state.materialOperation={documentId:'doc',receipt:{publication_performed:true},current:{stage:'published',is_current:true,publication_performed:false},knowledge:{candidates:[{status:'published',payload:{name:'not-effective'}}]}};
  assert.match(materialAutomaticCard(f),/发布状态待确认/);
  assert.doesNotMatch(materialAutomaticCard(f),/本次抽取已发布|not-effective/);
  assert.doesNotMatch(materialAgentFeedback(f),/not-effective/);
  f.state.materialOperation.receipt.publication_performed=false;f.state.materialOperation.current.publication_performed=true;
  assert.match(materialAutomaticCard(f),/本次抽取已发布/);
});

test('changing material or losing access clears diagnostics, result pages and automatic switching state',()=>{
  const f=harness().flow;
  Object.assign(f.state,{dialogueFailureJob:{id:'private'},baselinePage:8,automaticResultPage:3,autoSwitch:true,materialSwitchProposal:{id:'p'},materialOperation:{documentId:'doc'}});
  f.clearView();
  assert.equal(f.state.dialogueFailureJob,null);assert.equal(f.state.baselinePage,0);assert.equal(f.state.automaticResultPage,0);
  assert.equal(f.state.autoSwitch,false);assert.equal(f.state.materialSwitchProposal,null);assert.equal(f.state.materialOperation,null);
});

test('automatic retry recovers the original job request and never creates an extraction preview',async()=>{
  const h=harness(),f=h.flow;let retried=false,lose=true;
  f.saved.materialOperations={doc:{transitionId:'t'}};
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',job_id:'job'},current:{is_current:true,stage:retried?'queued':'failed'}}));
  h.respond.set('conversation-job',()=>({id:'job',document_id:'doc',kind:'knowledge_extract',status:'failed',metrics:{extraction_failures:[]}}));
  h.respond.set('conversation-job-retry',input=>{assert.equal(input.jobId,'job');retried=true;if(lose){lose=false;throw Object.assign(Error('lost'),{status:0});}return {id:'job',document_id:'doc',status:'queued'};});
  await f.agent.sync();await f.agent.retryAutomatic();assert.ok(f.saved.pending);
  const original=structuredClone(f.saved.pending.input);await f.retryPending();assert.equal(f.saved.pending,null);
  assert.deepEqual(h.requests.filter(r=>r.action==='conversation-job-retry').map(r=>r.input),[original,original]);
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-preview'||r.action==='conversation-processing-confirm'),false);
  assert.equal(f.agent.current.failureJob,null);
});

test('old retry clicks cannot bypass unknown draft writes, active work or transition protection',async()=>{
  const h=harness(),f=h.flow;f.saved.materialOperations={doc:{transitionId:'t'}};
  const current={is_current:true,stage:'failed'};
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',job_id:'job'},current}));
  h.respond.set('conversation-job',()=>({id:'job',document_id:'doc',kind:'knowledge_extract',status:'failed'}));
  await f.agent.sync();
  for(const key of ['pending','claimRequest']){
    f.changes[key]={action:'unknown'};await f.agent.retryAutomatic();assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');f.changes[key]=null;
  }
  f.state.dialogueWorkflow={document_id:'doc',tasks:[{status:'running'}]};
  await f.agent.retryAutomatic();assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');f.state.dialogueWorkflow=null;
  current.error={code:'MATERIAL_PROCESSING_GENERATION_STALE'};
  await f.agent.retryAutomatic();assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_GENERATION_STALE');
  assert.equal(h.requests.some(r=>r.action==='conversation-job-retry'),false);
});
test('explicit commands do not swallow questions, negations, or extraction purposes',()=>{
  for(const s of ['下一步','进入下一步','请进入下一步！','开始抽取'])assert.equal(materialCommand(s),'next');
  assert.equal(materialCommand('请重新抽取'),'reextract');
  assert.equal(materialCommand('对话调整'),'dialogue');
  for(const s of ['不要重新抽取','为什么要重新抽取？','重新抽取会覆盖吗','我希望了解付款条款','摘要里有哪些人'])assert.equal(materialCommand(s),null);
});

test('next explains clarification and confirmation instead of waiting or silently applying',async()=>{
  const {flow:f,requests}=harness();f.saved.intakeReviews={};
  f.changes.state.proposals=[{id:'p',status:'needs_clarification',result:{questions:['范围？']}}];
  await f.agent.next();assert.match(f.state.inputNotice,/回答本轮待确认问题/);
  f.changes.state.proposals[0].status='prepared';await f.agent.next();assert.match(f.state.inputNotice,/确认应用/);
  assert.equal(requests.length,0);
  f.state.detail.review={draft_id:'draft'};let reads=0;f.changes.openDraft=async()=>reads++;
  await f.agent.next();assert.equal(reads,1);
});

function claimHarness(){
  const h=harness(),f=h.flow;f.saved.intakeReviews={};
  Object.assign(f.state.detail,{status:'awaiting_review',original_name:'已有材料',review:{draft_id:'draft',status:'editing'}});
  f.changes.bind();const lease={draft_id:'draft',revision:1,status:'editing',legacy_unowned:false};f.changes.state.leases=[structuredClone(lease)];
  h.respond.set('conversation-editor-session',()=>({editor_session:'s'.repeat(30)}));
  h.respond.set('conversation-editor-leases',()=>({items:[lease]}));
  h.respond.set('conversation-editor-claim',()=>({draft_id:'draft',revision:lease.revision,lease_generation:1}));
  h.respond.set('conversation-change-draft',()=>({id:'draft',revision:lease.revision,status:'editing',counts:{entity:1,relation:0}}));
  h.respond.set('conversation-change-items',()=>({items:[{id:'fact',kind:'entity',payload:{name:'保留的修改'}}],total:1,offset:0,revision:lease.revision}));
  h.respond.set('conversation-change-context',()=>({context_digest:digest,recent_proposals:[],schema:{entity_types:[],relation_types:[]}}));
  h.respond.set('conversation-change-preview',()=>({items:[],total:0,revision:lease.revision,issues:[],ready_for_confirmation:true}));
  const submit=async text=>{f.state.input=text;await f.submitInput();};
  return {...h,lease,submit};
}

test('next offers a scoped claim and explicit chat confirmation loads existing edits before publication preview',async()=>{
  const h=claimHarness(),f=h.flow;
  f.state.error='previous error';await h.submit('下一步');assert.equal(f.state.error,'');
  assert.match(f.changes.state.claimConfirmation.notice,/已有材料/);assert.match(f.changes.state.claimConfirmation.notice,/其他页面将停止编辑/);
  assert.equal(h.requests.some(r=>r.action==='conversation-editor-claim'),false);
  await h.submit('确认继续修改');assert.equal(f.state.error,'');assert.equal(f.changes.state.claimConfirmation,null);
  assert.equal(f.changes.state.items.items[0].payload.name,'保留的修改');assert.equal(f.state.input,'');
  assert.equal(h.requests.filter(r=>r.action==='conversation-editor-claim').length,1);
  await h.submit('下一步');assert.ok(f.changes.state.preview);assert.equal(f.changes.state.publishConfirmed,false);
  assert.equal(h.requests.some(r=>/publish$|goal$|generate$|draft-create$/.test(r.action)),false);
  await h.submit('确认继续修改');assert.equal(h.requests.filter(r=>r.action==='conversation-editor-claim').length,1);
});

test('cancelled, unsolicited, cross-material and outdated claim confirmations cannot take over editing',async()=>{
  for(const invalidation of ['unsolicited','cancel','material','revision','scope','source','import','preview']){
    const h=claimHarness(),f=h.flow;
    if(invalidation!=='unsolicited')await h.submit('下一步');
    if(invalidation==='cancel')await h.submit('取消接管');
    if(invalidation==='material')f.state.detail.document_id='other';
    if(invalidation==='revision')f.changes.state.leases[0].revision=2;
    if(invalidation==='scope')f.state.selectedIntent='other-intent';
    if(invalidation==='source')f.state.reviewingSource=true;
    if(invalidation==='import')f.state.materialPage='import';
    if(invalidation==='preview')f.saved.materialOperations={doc:{preview:{preview_id:'automatic'}}};
    await h.submit('确认继续修改');assert.equal(h.requests.some(r=>r.action==='conversation-editor-claim'),false,invalidation);
  }
  for(const text of ['确认继续修改？','不要确认继续修改','确认继续修改会怎样'])assert.equal(materialCommand(text),null);
});

test('ambiguous or legacy drafts are never selected implicitly and next refreshes the offered revision',async()=>{
  const h=claimHarness(),f=h.flow;h.lease.revision=3;await h.submit('下一步');assert.equal(f.changes.state.claimConfirmation.revision,3);
  delete f.state.detail.review;h.respond.set('conversation-editor-leases',()=>({items:[h.lease,{...h.lease,draft_id:'other'}]}));
  await h.submit('下一步');assert.equal(f.changes.state.claimConfirmation,null);assert.match(f.state.inputNotice,/选择/);
  h.respond.set('conversation-editor-leases',()=>({items:[{...h.lease,legacy_unowned:true}]}));
  await h.submit('下一步');assert.equal(f.changes.state.claimConfirmation,null);
  assert.equal(h.requests.some(r=>r.action==='conversation-editor-claim'),false);
});

test('lost claim response retries the same operation, while rejection requires fresh confirmation',async()=>{
  const h=claimHarness(),f=h.flow;let first=true;
  h.respond.set('conversation-editor-claim',()=>{if(first){first=false;throw Object.assign(Error('lost'),{status:0});}return {draft_id:'draft',revision:1,lease_generation:1};});
  await h.submit('下一步');await h.submit('确认继续修改');assert.ok(f.changes.claimRequest);
  await h.submit('取消接管');assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');
  await h.submit('确认继续修改');assert.equal(f.state.error,'');
  const claims=h.requests.filter(r=>r.action==='conversation-editor-claim');assert.equal(claims.length,2);assert.deepEqual(claims[0].input,claims[1].input);
  const other=claimHarness();other.respond.set('conversation-editor-claim',()=>{throw Object.assign(Error('changed'),{status:409,code:'CORRECTION_LEASE_CHANGED'});});
  await other.submit('下一步');await other.submit('确认继续修改');assert.equal(other.flow.changes.state.claimConfirmation,null);
  await other.submit('确认继续修改');assert.equal(other.requests.filter(r=>r.action==='conversation-editor-claim').length,1);
});

test('claim offer prefers the current draft over an older intent review and can use the only remaining draft',async()=>{
  const h=claimHarness(),f=h.flow;f.changes.record.draftId='current-draft';
  h.respond.set('conversation-editor-leases',()=>({items:[h.lease,{...h.lease,draft_id:'current-draft',revision:4}]}));
  await h.submit('下一步');assert.equal(f.changes.state.claimConfirmation.draftId,'current-draft');
  delete f.changes.record.draftId;
  h.respond.set('conversation-editor-leases',()=>({items:[{...h.lease,draft_id:'current-draft',revision:4}]}));
  await h.submit('下一步');assert.equal(f.changes.state.claimConfirmation.draftId,'current-draft');
  assert.equal(h.requests.some(r=>r.action==='conversation-editor-claim'),false);
});

test('a blocked switch and changed lease listing cannot destroy recovery of an accepted claim',async()=>{
  const h=claimHarness(),f=h.flow;let first=true;
  h.respond.set('conversation-editor-claim',()=>{if(first){first=false;throw Object.assign(Error('lost'),{status:0});}return {draft_id:'draft',revision:1,lease_generation:1};});
  await h.submit('下一步');await h.submit('确认继续修改');const prompt=f.changes.state.claimConfirmation,request=structuredClone(f.changes.claimRequest);
  f.ready=async()=>{if(f.changes.claimRequest)throw Object.assign(Error('pending'),{code:'MODELING_REQUEST_PENDING'});};
  await h.submit('重新抽取');assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');assert.equal(f.changes.state.claimConfirmation,prompt);
  f.changes.state.leases=[];
  await h.submit('确认继续修改');assert.equal(f.state.error,'');assert.equal(f.changes.claimRequest,null);
  assert.deepEqual(h.requests.filter(r=>r.action==='conversation-editor-claim').at(-1).input,{...request,warehouseId:'warehouse'});
});

test('busy claim handlers cannot report success or consume the confirmation input',async()=>{
  const h=claimHarness(),f=h.flow;await h.submit('下一步');const notice=f.state.inputNotice;
  f.state.input='确认继续修改';f.state.busy=true;
  assert.equal(await f.agent.confirmDraftClaim(),false);assert.equal(f.state.inputNotice,notice);
  await f.agent.command('claim-draft');assert.equal(f.state.input,'确认继续修改');assert.equal(f.state.inputNotice,notice);
  assert.equal(h.requests.some(r=>r.action==='conversation-editor-claim'),false);
  f.state.busy=false;await h.submit('确认继续修改');assert.equal(f.changes.state.summary.id,'draft');
});

test('invalid claim receipts remain recoverable without adopting an unrelated or malformed lease',async()=>{
  for(const bad of [{draft_id:'other',revision:1,lease_generation:1},{draft_id:'draft',revision:2,lease_generation:1},{draft_id:'draft',revision:1,lease_generation:0}]){
    const h=claimHarness(),f=h.flow;await h.submit('下一步');h.respond.set('conversation-editor-claim',()=>bad);
    await h.submit('确认继续修改');assert.equal(f.state.errorCode,'SEMANTICA_INVALID_RESPONSE');assert.ok(f.changes.claimRequest);assert.equal(f.changes.owner.draftId,undefined);
    const request=structuredClone(f.changes.claimRequest);
    h.respond.set('conversation-editor-claim',()=>({draft_id:'draft',revision:1,lease_generation:2}));
    await h.submit('确认继续修改');assert.equal(f.state.error,'');assert.equal(f.changes.owner.editor.generation,'2');
    assert.deepEqual(h.requests.filter(r=>r.action==='conversation-editor-claim').at(-1).input,{...request,warehouseId:'warehouse'});
  }
});
test('processing routes preserve version, workflow revision, digest and operation id',()=>{
  const p=conversationRequest('conversation-processing-preview',{warehouseId:'w',documentId:'d',documentVersionId:'corrected',workflowRevision:4,operationId:'op'});
  assert.equal(p.body.expected_document_version_id,'corrected');assert.equal(p.body.document_version_id,undefined);assert.equal(p.body.target_mode,'automatic');assert.equal(p.body._native_operation_id,'op');
  const c=conversationRequest('conversation-processing-confirm',{warehouseId:'w',documentId:'d',workflowRevision:4,previewId:'p',previewDigest:digest,operationId:'op',confirmed:true});
  assert.equal(c.body.preview_digest,digest);assert.equal(c.body.expected_workflow_revision,4);
  assert.throws(()=>conversationRequest('conversation-processing-confirm',{warehouseId:'w',documentId:'d',workflowRevision:4,previewId:'p',previewDigest:digest,operationId:'op',confirmed:false}));
});
test('source saving uses existing Bridge correction route and rejects forged fields or duplicate segments',()=>{
  const input={warehouseId:'w',documentId:'d',documentVersionId:'v',operationId:'op',segments:[{id:'s',text:'校对'}]};
  const r=conversationRequest('conversation-source-save',input);
  assert.equal(r.path,'/warehouses/w/documents/d/correction');assert.deepEqual(r.body,{operation_id:'op',payload:{base_version_id:'v',segments:input.segments}});
  assert.throws(()=>conversationRequest('conversation-source-save',{...input,segments:[...input.segments,...input.segments]}));
  assert.throws(()=>conversationRequest('conversation-source-save',{...input,workspace_id:'other'}));
});
test('automatic re-extraction uses latest corrected source and waits for preview confirmation',async()=>{
  const h=harness();await h.flow.agent.prepareAutomatic();
  assert.equal(h.requests.find(r=>r.action==='conversation-processing-preview').input.documentVersionId,'corrected');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
  assert.match(materialAutomaticCard(h.flow),/通过校验后自动发布/);
  assert.match(materialAutomaticCard(h.flow),/完整性未确认或触发人工保护/);
  await h.flow.agent.confirmAutomatic();assert.equal(h.flow.agent.record.transitionId,'transition');
});
test('manual publication protection is shown and not overridden',async()=>{
  const h=harness();h.preview.publication_policy='review_required';await h.flow.agent.prepareAutomatic();
  assert.match(materialAutomaticCard(h.flow),/有人工核对保护/);assert.doesNotMatch(materialAutomaticCard(h.flow),/并自动发布/);
  h.preview.can_confirm=false;h.flow.saved.materialOperations.doc.preview.can_confirm=false;
  await h.flow.agent.confirmAutomatic();assert.equal(h.flow.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
});

test('fresh workflow active tasks block a preview even when prepare_automatic is allowed',async()=>{
  const h=harness();
  h.respond.set('conversation-material-workflow',()=>({document_id:'doc',tasks:[{status:'running'}],actions:{prepare_automatic:{allowed:true}}}));
  await h.flow.agent.prepareAutomatic();
  assert.equal(h.flow.state.errorCode,'MODELING_MATERIAL_BUSY');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-preview'),false);
});

test('accepted confirmation keeps processing locked when its subsequent status read fails',async()=>{
  const h=harness(),f=h.flow;await f.agent.prepareAutomatic();
  h.respond.set('conversation-processing-status',()=>{throw Object.assign(Error('offline'),{status:503});});
  await f.agent.confirmAutomatic();
  assert.equal(f.agent.current.current.stage,'queued');
  assert.equal(f.agent.record.transitionId,'transition');
  await f.agent.prepareAutomatic();assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
  assert.equal(h.requests.filter(r=>r.action==='conversation-processing-preview').length,1);
  assert.equal(h.requests.filter(r=>r.action==='conversation-processing-confirm').length,1);
});

test('automatic path from source review saves edited text before preparing a plan and never confirms it implicitly',async()=>{
  const h=harness();h.flow.intake.edit('s','校对后的正文');
  await h.flow.agent.automaticFromSource();assert.equal(h.flow.state.error,'');
  assert.equal(h.requests[0].action,'conversation-source-save');
  assert.equal(h.requests.find(r=>r.action==='conversation-processing-preview').input.documentVersionId,'corrected');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
  const lost=harness();lost.flow.intake.edit('s','未确认保存');lost.lose('conversation-source-save');
  await lost.flow.agent.automaticFromSource();assert.ok(lost.flow.saved.pending);
  assert.equal(lost.requests.some(r=>r.action==='conversation-processing-preview'),false);
});
test('unknown confirmation result replays the original operation and accepted transition',async()=>{
  const h=harness();await h.flow.agent.prepareAutomatic();h.lose('conversation-processing-confirm');await h.flow.agent.confirmAutomatic();
  const original=structuredClone(h.flow.saved.pending);assert.ok(original);
  await h.flow.retryPending();assert.equal(h.flow.saved.pending,null);
  const writes=h.requests.filter(r=>r.action==='conversation-processing-confirm');assert.deepEqual(writes[0].input,writes[1].input);
  assert.equal(h.flow.agent.record.transitionId,'transition');
});

test('expired persisted preview offers regeneration and never submits an expired confirmation',async()=>{
  const h=harness(),f=h.flow;await f.agent.prepareAutomatic();
  f.agent.record.preview.expires_at=new Date(Date.now()-1000).toISOString();
  assert.match(materialAutomaticCard(f),/预览已过期/);assert.match(materialAutomaticCard(f),/重新预览抽取/);
  assert.doesNotMatch(materialAutomaticCard(f),/data-cv="material-auto-confirm"/);
  await f.agent.confirmAutomatic();assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_PREVIEW_EXPIRED');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
  await f.agent.sync();assert.equal(f.agent.record.previewError,'MATERIAL_PROCESSING_PREVIEW_EXPIRED');
  await f.agent.prepareAutomatic();assert.equal(f.agent.record.previewError,null);
  assert.match(materialAutomaticCard(f),/data-cv="material-auto-confirm"/);
});

test('backend expiry refusal revokes the cached confirmation and preserves a useful error',async()=>{
  const h=harness(),f=h.flow;await f.agent.prepareAutomatic();
  h.respond.set('conversation-processing-confirm',()=>{throw Object.assign(Error('expired'),{status:409,code:'MATERIAL_PROCESSING_PREVIEW_EXPIRED'});});
  await f.agent.confirmAutomatic();assert.equal(f.saved.pending,null);assert.match(f.state.error,/预览已过期/);
  assert.equal(f.agent.record.previewError,'MATERIAL_PROCESSING_PREVIEW_EXPIRED');
  await f.agent.confirmAutomatic();assert.equal(h.requests.filter(r=>r.action==='conversation-processing-confirm').length,1);
});

test('restart restores the server current automatic receipt even without a local transition id',async()=>{
  const h=harness(),f=h.flow;
  const workflow={document_id:'doc',document_version_id:'corrected',latest_transition_id:'accepted',tasks:[]};
  f.state.materialPage='import';f.state.librarySelection={document:{id:'doc',workflow}};
  f.saved.materialOperations={doc:{preview:{...h.preview,expires_at:new Date(0).toISOString()}}};
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',document_version_id:'corrected',preview_id:'preview',transition_id:'accepted',target_mode:'automatic'},current:{stage:'running',is_current:true}}));
  h.respond.set('conversation-material-workflow',()=>workflow);
  await f.agent.sync();assert.equal(f.agent.record.transitionId,'accepted');assert.equal(f.agent.record.preview,undefined);assert.equal(f.agent.current.current.stage,'running');
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'||r.action==='conversation-processing-preview'),false);
});

test('server discovery never replaces a pending original confirmation or restores an obsolete task',async()=>{
  const h=harness(),f=h.flow;
  f.state.materialPage='import';f.state.librarySelection={document:{id:'doc',workflow:{document_id:'doc',latest_transition_id:'old'}}};
  f.saved.pending={action:'conversation-processing-confirm',input:{operationId:'original'}};
  await f.agent.sync();assert.equal(h.requests.length,0);assert.equal(f.saved.pending.input.operationId,'original');
  f.saved.pending=null;
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',target_mode:'automatic'},current:{stage:'stale',is_current:false}}));
  await f.agent.sync();assert.equal(f.agent.record.transitionId,undefined);assert.equal(f.agent.current,null);
});

test('rereading a retired automatic transition clears its current UI but keeps the historical locator',async()=>{
  for(const reason of ['retired','dialogue','version']){
    const h=harness(),f=h.flow;f.state.materialPage='import';
    f.state.librarySelection={document:{id:'doc',workflow:{document_id:'doc',document_version_id:'corrected',latest_transition_id:'old'}}};
    f.saved.materialOperations={doc:{transitionId:'old'}};
    f.state.materialOperation={documentId:'doc',current:{stage:'running',is_current:true}};
    h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',document_version_id:reason==='version'?'older':'corrected',target_mode:reason==='dialogue'?'dialogue':'automatic'},current:{stage:reason==='retired'?'stale':'running',is_current:reason!=='retired'}}));
    await f.agent.sync();assert.equal(f.agent.current,null,reason);assert.equal(f.agent.record.transitionId,'old');
    assert.equal(h.requests.some(r=>/processing-(confirm|preview)|job-retry/.test(r.action)),false);
  }
});

test('an accepted preview is consumed even when its transition is already historical',async()=>{
  const h=harness(),f=h.flow;f.state.materialPage='import';
  f.state.librarySelection={document:{id:'doc',workflow:{document_id:'doc',document_version_id:'corrected'}}};
  f.saved.materialOperations={doc:{transitionId:'old',preview:structuredClone(h.preview),previewError:'MATERIAL_PROCESSING_PREVIEW_CONSUMED'}};
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',preview_id:'preview',transition_id:'old'},current:{stage:'stale',is_current:false}}));
  await f.agent.sync();assert.equal(f.agent.record.preview,undefined);assert.equal(f.agent.record.previewError,undefined);assert.equal(f.agent.current,null);
  assert.equal(f.agent.record.transitionId,'old');assert.equal(h.requests.length,1);
});

test('a historical status does not consume a preview while its original submission is unresolved',async()=>{
  const h=harness(),f=h.flow;f.state.materialPage='import';f.state.librarySelection={document:{id:'doc'}};
  f.saved.materialOperations={doc:{transitionId:'old',preview:structuredClone(h.preview)}};
  const pending={action:'conversation-processing-confirm',input:{operationId:'original',previewId:'preview'}};f.saved.pending=structuredClone(pending);
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',preview_id:'preview'},current:{stage:'stale',is_current:false}}));
  await f.agent.sync();assert.ok(f.agent.record.preview);assert.deepEqual(f.saved.pending,pending);
  assert.equal(h.requests.some(r=>r.action==='conversation-processing-confirm'),false);
});

test('publication losing currency during knowledge loading cannot restore an obsolete material card',async()=>{
  const h=harness(),f=h.flow;f.state.materialPage='import';
  f.state.librarySelection={document:{id:'doc',workflow:{document_id:'doc',document_version_id:'corrected'}}};
  f.saved.materialOperations={doc:{transitionId:'old'}};let reads=0;
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',document_version_id:'corrected',transition_id:'old'},current:++reads===1?{stage:'published',is_current:true,publication_performed:true,published_run_id:'run'}:{stage:'stale',is_current:false}}));
  h.respond.set('conversation-published-run',()=>({run:{id:'run',document_id:'doc',document_version_id:'corrected',status:'published'},candidates:[]}));
  await f.agent.sync();assert.equal(reads,2);assert.equal(f.agent.current,null);assert.equal(f.agent.record.transitionId,'old');
});

test('ambiguous status responses cannot silently clear the accepted task or consume its preview',async()=>{
  for(const bad of [{current:{stage:'stale'}},{current:{stage:'unknown',is_current:true}},{receipt:{document_id:'doc',transition_id:'other'},current:{stage:'stale',is_current:false}}]){
    const h=harness(),f=h.flow;f.state.materialPage='import';f.state.librarySelection={document:{id:'doc'}};
    f.saved.materialOperations={doc:{transitionId:'accepted',preview:structuredClone(h.preview)}};
    const before={documentId:'doc',current:{is_current:true,stage:'queued'}};f.state.materialOperation=structuredClone(before);
    h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',preview_id:'preview'},...bad}));
    await assert.rejects(f.agent.sync(),{code:'SEMANTICA_INVALID_RESPONSE'});
    assert.deepEqual(f.agent.current,before);assert.ok(f.agent.record.preview);
  }
});
test('source save response loss keeps the original version and edits until recovered',async()=>{
  const h=harness();h.flow.intake.edit('s','修改后的正文');h.lose('conversation-source-save');await h.flow.intake.confirm(false);
  assert.ok(h.flow.saved.pending);assert.equal(h.flow.intake.hasEdits,true);
  h.flow.intake.edit('s','超时后不应接受的新正文');assert.equal(h.flow.intake.record.edits.s,'修改后的正文');
  assert.match(intakeCard(h.flow),/data-intake-segment="s" rows="1" disabled/);
  await h.flow.retryPending();assert.equal(h.flow.intake.hasEdits,false);assert.equal(h.flow.intake.source.version.id,'corrected');
  const calls=h.requests.filter(r=>r.action==='conversation-source-save');assert.deepEqual(calls[0].input,calls[1].input);assert.equal(calls[0].input.documentVersionId,'old');
});

test('new automatic processing does not display the old dialogue results or advance its old plan',async()=>{
  const h=harness(),f=h.flow;
  f.state.knowledge={candidates:[{payload:{name:'旧发布实体'}}]};f.state.candidates={items:[{payload:{name:'旧候选'}}]};
  f.state.detail.status='ready_for_confirmation';f.state.detail.goal={goal:'旧目标'};f.saved.intakeReviews={};
  f.state.plan={};let confirmed=0;f.confirmPlan=async()=>confirmed++;
  for(const current of [{stage:'running',is_current:true},{stage:'published',is_current:false}]){
    f.state.materialOperation={documentId:'doc',current};
    assert.doesNotMatch(materialAgentFeedback(f),/旧发布实体|旧候选/);
    await f.agent.next();assert.equal(confirmed,0);assert.ok(f.state.inputNotice);
  }
  f.state.materialOperation=null;f.saved.materialOperations={doc:{preview:h.preview}};
  await f.agent.next();assert.equal(confirmed,0);assert.match(f.state.inputNotice,/重新抽取计划/);
});
test('unsaved text blocks re-extraction instead of silently extracting the old version',async()=>{
  const h=harness();h.flow.intake.edit('s','新正文');await h.flow.agent.prepareAutomatic();
  assert.equal(h.flow.state.errorCode,'MODELING_SOURCE_SAVE_REQUIRED');assert.equal(h.requests.length,0);
});
test('re-extraction command takes precedence over a stale goal composer context',async()=>{
  const h=harness();h.flow.state.composerContext='goal';h.flow.state.messageMode='change';h.flow.state.input='重新抽取';await h.flow.submitInput();
  assert.ok(h.flow.agent.record.preview);assert.equal(h.flow.state.instructions,'');assert.equal(h.flow.state.composerContext,null);
  assert.equal(h.requests.some(r=>r.action==='conversation-change-generate'),false);
});
test('a question during source review is sent verbatim without overwriting the material note',async()=>{
  const h=harness();let sent;h.flow.intake.record.note='原说明';h.flow.state.input='这份材料介绍了什么？';h.flow.send=async()=>{sent=h.flow.state.input;};await h.flow.submitInput();
  assert.equal(sent,'这份材料介绍了什么？');assert.equal(h.flow.intake.record.note,'原说明');assert.equal(h.flow.state.instructions,'');
});
test('next-step command dispatches source review and plan confirmation through existing guarded methods',async()=>{
  const h=harness();let count=0;h.flow.intake.confirm=async advance=>{assert.equal(advance,true);count++;};h.flow.state.input='下一步';await h.flow.submitInput();assert.equal(count,1);
  h.flow.saved.intakeReviews={};h.flow.state.detail.status='ready_for_confirmation';h.flow.state.detail.goal={goal:'明确目标'};h.flow.state.plan={};h.flow.confirmPlan=async()=>count++;
  h.flow.state.input='开始抽取';await h.flow.submitInput();assert.equal(count,2);
});
test('assistant results escape content and distinguish candidates from published facts',()=>{
  const h=harness();h.flow.state.candidates={items:[{kind:'entity',payload:{name:'<script>',type:'SKILL'},evidence:[{excerpt:'<原文>'}]}]};
  assert.match(materialAgentFeedback(h.flow),/待核对候选/);assert.match(materialAgentFeedback(h.flow),/&lt;script&gt;/);assert.match(materialAgentFeedback(h.flow),/&lt;原文&gt;/);
});
test('another material never sees a cached operation or result',()=>{
  const h=harness();h.flow.saved.materialOperations={other:{transitionId:'private'}};h.flow.state.materialOperation={documentId:'other',knowledge:{candidates:[{payload:{name:'private'}}]}};
  assert.deepEqual(h.flow.agent.record,{});assert.equal(h.flow.agent.current,null);assert.doesNotMatch(materialAgentFeedback(h.flow),/private/);
});

test('library selection cannot show the previous conversation results, candidates or processing status',()=>{
  const h=harness();h.flow.state.librarySelection={document:{id:'other',workflow:{}}};
  h.flow.state.knowledge={candidates:[{payload:{name:'上一份材料的私有结果'}}]};h.flow.state.candidates={items:[{payload:{name:'上一份候选'}}]};
  h.flow.state.turn={status:'running'};h.flow.state.detail.outcome={current_run_id:'previous'};
  const html=materialAgentFeedback(h.flow);
  assert.doesNotMatch(html,/私有结果|上一份候选|正在处理|正文已解析/);assert.equal(materialAgentTools(h.flow),'');
});
test('recovering a lost re-extraction preview exits source review so confirmation is visible',async()=>{
  const h=harness();h.flow.state.reviewingSource=true;h.lose('conversation-processing-preview');await h.flow.agent.prepareAutomatic();
  assert.ok(h.flow.saved.pending);assert.equal(h.flow.state.reviewingSource,true);
  await h.flow.retryPending();assert.equal(h.flow.state.reviewingSource,false);assert.match(materialAutomaticCard(h.flow),/确认开始并自动发布/);
});
test('recovering a lost dialogue handoff clears automatic UI and resets review on the new intent',async()=>{
  const h=harness();h.flow.saved.materialOperations={doc:{transitionId:'old'}};h.flow.state.materialOperation={documentId:'doc',current:{stage:'published',is_current:true}};
  h.flow.intake.record.stage='goal';h.flow.intake.record.goalTurnId='old-turn';
  h.lose('conversation-intent-create');await h.flow.agent.dialogue();assert.ok(h.flow.saved.pending);
  const original=structuredClone(h.flow.saved.pending);h.flow.saved=structuredClone(h.flow.saved);
  await h.flow.retryPending();
  assert.equal(h.flow.state.selectedIntent,'new-intent');assert.equal(h.flow.saved.materialOperations.doc,undefined);assert.equal(h.flow.state.materialOperation,null);
  assert.equal(h.flow.saved.intakeReviews['new-intent'].stage,'source');assert.equal(h.flow.saved.intakeReviews['new-intent'].goalTurnId,undefined);
  assert.equal(h.flow.saved.autoRead['new-intent'],true);assert.equal(h.flow.saved.selection.session,'new-intent');
  assert.deepEqual(h.requests.filter(r=>r.action==='conversation-intent-create').at(-1).input,original.input);
});
test('question-only mode never executes operation words or reopens goal confirmation',async()=>{
  const h=harness();h.flow.intake.record.stage='goal';h.flow.intake.record.goalNeedsConfirmation=false;
  h.flow.state.messageMode='question';h.flow.state.input='重新抽取';let sent;
  h.flow.send=async()=>{sent=h.flow.state.input;};await h.flow.submitInput();
  assert.equal(sent,'重新抽取');assert.equal(h.requests.length,0);assert.equal(h.flow.intake.record.goalNeedsConfirmation,false);
  assert.equal(conversationInputRoute('开始抽取',h.flow),'question');
});
test('superseded running operations stop polling and never show a live progress indicator',async()=>{
  const h=harness();h.flow.saved.materialOperations={doc:{transitionId:'old'}};h.flow.state.materialOperation={documentId:'doc',current:{stage:'running',is_current:false}};
  await h.flow.tick();assert.equal(h.requests.length,0);assert.match(materialAutomaticCard(h.flow),/已被后续操作替代/);
  assert.doesNotMatch(materialAgentFeedback(h.flow),/mw-agent-progress/);
});
test('progress is never borrowed from a different job in the same material',async()=>{
  const h=harness();h.flow.saved.materialOperations={doc:{transitionId:'t'}};
  h.respond.set('conversation-processing-status',()=>({receipt:{document_id:'doc',job_id:'current'},current:{stage:'running',is_current:true}}));
  h.respond.set('conversation-material-workflow',()=>({tasks:[{id:'another',total_units:500,completed_units:300}]}));
  await h.flow.agent.sync();assert.equal(h.flow.agent.current.progress,undefined);assert.doesNotMatch(materialAutomaticCard(h.flow),/300|500/);
});
test('unsaved edits in another conversation do not block a library material preview',async()=>{
  const h=harness();h.flow.state.librarySelection={document:{id:'doc'}};
  h.flow.intake.source.document.id='other';h.flow.intake.edit('s','另一份未保存正文');
  await h.flow.agent.prepareAutomatic();assert.equal(h.flow.state.error,'');assert.ok(h.flow.agent.record.preview);
});
test('dialogue adjustment cannot hide or replace an automatic job still running',async()=>{
  const h=harness();h.flow.saved.materialOperations={doc:{transitionId:'active'}};
  h.respond.set('conversation-material-workflow',()=>({document_id:'doc',tasks:[{id:'job',status:'running'}]}));
  await h.flow.agent.dialogue();assert.equal(h.flow.state.errorCode,'MODELING_MATERIAL_BUSY');
  assert.equal(h.flow.saved.materialOperations.doc.transitionId,'active');assert.equal(h.requests.some(r=>r.action==='conversation-intent-create'),false);
});
test('missing library workflow cannot edit the previous conversation under the new document id',async()=>{
  const h=harness();h.flow.state.librarySelection={document:{id:'other'}};
  h.respond.set('conversation-material-workflow',()=>{throw Object.assign(Error('unavailable'),{status:503});});
  await h.flow.agent.reviewSource();assert.equal(h.flow.state.reviewingSource,undefined);
  assert.equal(h.flow.intake.source.document.id,'doc');assert.equal(h.requests.some(r=>r.action==='conversation-intent-create'||r.action==='document'),false);
});
