import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {continueMaterial,stoppedMaterialCard} from '../ui/material-continuation.mjs';
import {nextConversationStep} from '../ui/conversation-next.mjs';
import {conversationHTML} from '../ui/conversation.js';
import {materialListHTML} from '../ui/material-workspace.mjs';

function fixture({draft=false}={}){
  const store=new Map(),calls=[],receipts=new Map();let sequence=0;
  const old={id:'old',revision:2,status:'cancelled',source_status:'available',document_id:'doc',document_version_id:'v',original_name:'合同.txt',goal:{goal:'整理付款条件',instructions:'不抽取签署地点'},...(draft?{review:{draft_id:'draft'}}:{})};
  const db={items:[old],revision:1,lose:false};
  const make=()=>new ConversationFlow({warehouseId:'warehouse',identity:{boxId:'box',user:{id:1},dataScope:'personal'},storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},uuid:()=>`op-${++sequence}`,call:async(action,input)=>{
    calls.push({action,input:structuredClone(input)});
    if(action==='conversation-list')return {items:[{id:'conversation',status:'active',scenario:'material'}],has_more:false};
    if(action==='conversation-get')return {id:'conversation',scenario:'material',status:'active',revision:db.revision,source_stamp:'s'+db.revision,input_generation:db.revision};
    if(action==='conversation-messages')return {items:[{role:'user',sequence:1,content:'保留原历史对话'}],has_more:false};
    if(action==='conversation-intents')return {items:structuredClone(db.items),has_more:false};
    if(action==='conversation-intent')return structuredClone(db.items.find(i=>i.id===input.intentId));
    if(action==='conversation-ontologies')return {items:[{id:'ontology',status:'published'}]};
    if(action==='document')return {document:{id:'doc',segment_count:1},version:{id:db.items.at(-1).document_version_id},segments:[{id:'segment',text:'服务端原文'}]};
    if(action==='conversation-send')return {turn_id:'turn'};
    if(action==='conversation-goal'){
      const d=db.items.find(i=>i.id===input.intentId);d.goal={goal:input.goal,instructions:input.instructions};d.status='ready_for_confirmation';d.revision++;db.revision++;
      return {resource_id:d.id};
    }
    if(action==='conversation-intent-create'){
      if(!receipts.has(input.operationId)){
        assert.equal(input.documentId,'doc');assert.equal(input.conversationId,'conversation');
        const id='new-'+receipts.size;db.items.push({...old,id,revision:1,status:'awaiting_goal',goal:null,review:null});db.revision++;
        receipts.set(input.operationId,{resource_id:id,revision:1,conversation_revision:db.revision});
      }
      if(db.lose){db.lose=false;throw Object.assign(Error('lost'),{code:'SEMANTICA_CONNECTION_FAILED',status:0});}
      return receipts.get(input.operationId);
    }
    if(action==='conversation-editor-session')return {editor_session:'s'.repeat(30)};
    if(action==='conversation-editor-leases')return {items:[{draft_id:'draft',revision:3,status:'editing',suspended:true}]};
    if(action==='conversation-editor-claim')return {draft_id:'draft',revision:3,lease_generation:2};
    if(action==='conversation-change-draft')return {id:'draft',revision:3,status:'editing',counts:{entity:1,relation:0}};
    if(action==='conversation-change-items')return {items:[{id:'fact',kind:'entity',payload:{name:'原有草稿事实'},evidence:[]}],revision:3,total:1,offset:0};
    if(action==='conversation-change-context')return {context_digest:'a'.repeat(64),recent_proposals:[],proposal_has_more:false};
    throw Error('Unexpected '+action);
  }});
  return {db,calls,make,store};
}
const forbidden=/upload|conversation-confirm|change-publish|conversation-analyze|conversation-send|conversation-goal/;
test('after rule publication next opens an unconfirmed dialogue goal and survives a lost continuation response',async()=>{
  const h=fixture();h.db.items[0].status='awaiting_goal';const f=h.make();await f.load();
  f.saved.intakeReviews={old:{stage:'goal',versionId:'v',confirmed:true}};
  f.changes.setTarget('rules');f.changes.record.rulesPublished={ontologyId:'ontology',documentVersionId:'v'};f.changes.persist();
  assert.equal(nextConversationStep(f),'rules-ready');assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,f),/核对抽取目标与计划/);
  h.db.lose=true;await f.agent.next();assert.ok(f.saved.pending);const original=structuredClone(f.saved.pending.input);
  const restored=h.make();await restored.load();await restored.retryPending();assert.equal(restored.state.error,'');
  assert.equal(restored.state.selectedIntent,'new-0');assert.equal(restored.state.goal,'整理付款条件');assert.equal(restored.state.instructions,'不抽取签署地点');
  assert.equal(restored.state.goalDirty,true);assert.equal(nextConversationStep(restored),'goal');
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-intent-create').at(-1).input,original);
  assert.equal(h.db.items.length,2);assert.equal(h.calls.some(c=>forbidden.test(c.action)||c.action==='conversation-processing-confirm'),false);
  restored.state.dialogueWorkflow={document_id:'doc',document_version_id:'v',publication:{id:'published',status:'published',document_version_id:'v'}};
  restored.saved.intakeReviews={...restored.saved.intakeReviews,[restored.state.selectedIntent]:{stage:'goal',versionId:'v',goalNeedsConfirmation:true}};
  assert.equal(restored.intake.goalStage,true);
  await restored.goal();assert.equal(restored.state.error,'');assert.equal(nextConversationStep(restored),'plan');
  assert.equal(h.calls.some(c=>['conversation-confirm','conversation-processing-confirm'].includes(c.action)),false);
});
test('published rule continuation creates a goal review record when legacy material has no local intake history',async()=>{
  const h=fixture();h.db.items[0].status='awaiting_goal';const f=h.make();await f.load();
  f.state.dialogueWorkflow={document_id:'doc',document_version_id:'v',publication:{id:'run',status:'published',document_version_id:'v'}};
  f.changes.setTarget('rules');f.changes.record.rulesPublished={ontologyId:'ontology',documentVersionId:'v'};
  assert.equal(f.intake.record,undefined);await f.changes.continueExtraction();assert.equal(f.state.error,'');
  assert.equal(f.intake.record.stage,'goal');assert.equal(f.intake.goalStage,true);
  await f.goal();assert.equal(f.state.error,'');assert.equal(nextConversationStep(f),'plan');
  assert.equal(h.calls.some(c=>['conversation-confirm','conversation-processing-confirm'].includes(c.action)),false);
});
test('changed rule version prevents using an old published-rule continuation',async()=>{
  const h=fixture();h.db.items[0].status='awaiting_goal';const f=h.make();await f.load();
  f.changes.setTarget('rules');f.changes.record.rulesPublished={ontologyId:'old-ontology',documentVersionId:'v'};
  await f.changes.continueExtraction();assert.equal(f.state.errorCode,'MODELING_SNAPSHOT_CHANGED');
  assert.equal(h.calls.some(c=>c.action==='conversation-intent-create'),false);
});
test('new pending rule suggestions cannot be bypassed using the previous publication continuation',async()=>{
  const h=fixture();h.db.items[0].status='awaiting_goal';const f=h.make();await f.load();
  f.changes.setTarget('rules');f.changes.record.rulesPublished={ontologyId:'ontology',documentVersionId:'v'};
  f.changes.record.lastProposal='new-rule';f.changes.record.proposalTargets={'new-rule':'rules'};
  f.changes.state.proposals=[{id:'new-rule',status:'needs_clarification'}];
  await f.changes.continueExtraction();assert.equal(f.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');
  assert.equal(h.calls.some(c=>c.action==='conversation-intent-create'),false);
});
test('restart stays in the same conversation, keeps history and prefills unconfirmed goal without extraction',async()=>{
  const h=fixture(),f=h.make();await f.load();assert.match(stoppedMaterialCard(f),/重新开始处理/);
  await continueMaterial(f,'restart');assert.equal(f.state.error,'');assert.equal(f.saved.conversationId,'conversation');
  assert.equal(f.state.selectedIntent,'new-0');assert.equal(f.state.goal,'整理付款条件');assert.equal(f.state.instructions,'不抽取签署地点');assert.equal(f.state.goalDirty,true);
  assert.equal(nextConversationStep(f),'goal');assert.equal(f.state.messages[0].content,'保留原历史对话');
  assert.equal((materialListHTML(f).match(/class="mw-material /g)||[]).length,1);
  assert.equal(h.calls.some(c=>forbidden.test(c.action)),false);
  const restored=h.make();await restored.load();assert.equal(restored.state.selectedIntent,'new-0');assert.equal(restored.state.goal,'整理付款条件');
  assert.equal(h.calls.filter(c=>c.action==='conversation-intent-create').length,1);
});
test('continue existing draft opens recovery in the same work area and supports editing context after explicit claim',async()=>{
  const h=fixture({draft:true}),f=h.make();await f.load();assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,f),/继续核对已有草稿/);
  await continueMaterial(f,'draft');assert.equal(f.state.error,'');assert.equal(nextConversationStep(f),'draft');
  assert.equal(f.changes.record.draftId,'draft');assert.equal(f.changes.state.leases[0].draft_id,'draft');
  assert.equal(h.calls.some(c=>c.action==='conversation-editor-claim'),false);
  await f.changes.claim('draft');assert.equal(f.state.error,'');assert.equal(f.changes.state.items.items[0].payload.name,'原有草稿事实');
  assert.ok(f.changes.state.context);assert.equal(h.calls.some(c=>forbidden.test(c.action)),false);
  const restored=h.make();await restored.load();assert.equal(nextConversationStep(restored),'draft');assert.equal(restored.changes.record.draftId,'draft');
});
test('lost creation response replays the exact original request after reload and never duplicates a new intent',async()=>{
  const h=fixture({draft:true});let f=h.make();await f.load();h.db.lose=true;await continueMaterial(f,'draft');
  const original=h.calls.find(c=>c.action==='conversation-intent-create').input;assert.ok(f.saved.pending);
  f=h.make();await f.load();await f.retryPending();assert.equal(f.state.error,'');
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-intent-create').at(-1).input,original);
  assert.equal(h.db.items.length,2);assert.equal(nextConversationStep(f),'draft');
  assert.equal(f.changes.record.draftId,'draft');assert.equal(h.calls.some(c=>forbidden.test(c.action)),false);
});
test('unavailable source, active task and pending writes cannot be restarted',async()=>{
  for(const change of [{source_status:'unavailable'},{status:'running'}]){
    const h=fixture(),f=h.make();Object.assign(h.db.items[0],change);await f.load();
    assert.equal(stoppedMaterialCard(f),'');await continueMaterial(f,'restart');assert.equal(h.calls.some(c=>c.action==='conversation-intent-create'),false);
  }
  const h=fixture(),f=h.make();await f.load();f.saved.pending={action:'other'};await continueMaterial(f,'restart');assert.equal(h.calls.some(c=>c.action==='conversation-intent-create'),false);
});
test('double activation does not create two continuations and local goal edits are retained',async()=>{
  const h=fixture(),f=h.make();await f.load();f.state.goal='新的关注点';f.state.instructions='保留用户编辑';f.state.goalDirty=true;
  await Promise.all([continueMaterial(f,'restart'),continueMaterial(f,'restart')]);assert.equal(h.db.items.length,2);
  assert.equal(f.state.goal,'新的关注点');assert.equal(f.state.instructions,'保留用户编辑');
});
test('restart preserves unfinished body review and local edits instead of skipping to the goal',async()=>{
  const h=fixture(),f=h.make();await f.load();
  f.saved.intakeReviews={old:{name:'合同.txt',versionId:'v',stage:'source',edits:{segment:'用户修正'},note:'关注点'}};
  await continueMaterial(f,'restart');assert.equal(f.state.error,'');
  assert.equal(nextConversationStep(f),'source-review');assert.equal(f.intake.record.edits.segment,'用户修正');
  assert.equal(f.intake.hasEdits,true);assert.equal(h.calls.some(c=>forbidden.test(c.action)),false);
  const restored=h.make();await restored.load();assert.equal(nextConversationStep(restored),'source-review');assert.equal(restored.intake.record.edits.segment,'用户修正');
});
test('a new document version cannot resume the old draft or bypass body review',async()=>{
  const h=fixture({draft:true}),f=h.make();await f.load();await continueMaterial(f,'draft');
  h.db.items.at(-1).document_version_id='v2';await f.refresh();
  assert.equal(f.changes.record.draftId,undefined);assert.equal(f.changes.owner,null);
  assert.equal(nextConversationStep(f),'source-review');assert.equal(f.intake.source.version.id,'v2');
  assert.equal(h.calls.some(c=>c.action==='conversation-editor-claim'),false);
});
test('edited continuation goal and unsent text survive navigation while sent content and confirmed goals stay cleared',async()=>{
  const h=fixture();let f=h.make();await f.load();await continueMaterial(f,'restart');
  Object.assign(f.state,{goal:'修改后的目标',instructions:'新的排除范围',goalDirty:true,input:'尚未发送'});f.saveMaterialComposer();
  f=h.make();await f.load();assert.equal(f.state.goal,'修改后的目标');assert.equal(f.state.instructions,'新的排除范围');assert.equal(f.state.input,'尚未发送');
  await f.send();assert.equal(f.state.error,'');assert.equal(f.state.input,'');
  await f.goal();assert.equal(f.state.error,'');assert.equal(f.state.goalDirty,false);
  f=h.make();await f.load();assert.equal(f.state.input,'');assert.equal(f.state.goalDirty,false);assert.equal(f.state.goal,'修改后的目标');
});
test('invalidated sources never restore cached composer text or goals',async()=>{
  for(const change of [{source_status:'unavailable'},{document_version_id:'v2'}]){
    const h=fixture();let f=h.make();await f.load();Object.assign(f.state,{input:'旧原文',goal:'旧目标草稿',goalDirty:true});f.saveMaterialComposer();
    Object.assign(h.db.items[0],change);f=h.make();await f.load();assert.equal(f.state.input,'');assert.notEqual(f.state.goal,'旧目标草稿');
  }
});
test('reload follows a committed goal-change handoff even if its follow-up snapshot never saved the selection',async()=>{
  const h=fixture();let f=h.make();await f.load();
  h.db.items.push({...h.db.items[0],id:'changed',status:'awaiting_goal',goal:null});
  f.changes.record.application={status:'applied',active_intent_id:'changed',publication_performed:false,extraction_started:false};f.changes.persist();
  f=h.make();await f.load();assert.equal(f.state.selectedIntent,'changed');assert.equal(nextConversationStep(f),'goal');
  assert.equal(h.calls.some(c=>forbidden.test(c.action)),false);
  await f.selectMaterial('conversation','old');assert.equal(f.state.selectedIntent,'old');
});
