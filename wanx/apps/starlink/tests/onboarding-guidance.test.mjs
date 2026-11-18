import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {questionCardsHTML,questionLedgerHTML,questionActionsHTML,turnInputHTML} from '../ui/onboarding-dialogue-questions.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';
import {questionActionsFromReceipt} from '../shared/onboarding-dialogue-contract.mjs';
import {SemanticaService} from '../shell/service.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
function fixture(){const f=dialogueFixture({guidance:true}),storage=memory();let n=0;return {...f,storage,model:()=>new OnboardingDialogue({...f,storage,identity,uuid:()=>`op-${++n}`})};}
async function create(f){const m=f.model();await m.load();m.setName('动态引导仓');await m.create();return m;}
const ids={warehouseId:'w',conversationId:'c',operationId:'op',revision:0,draftDigest:'a'.repeat(64)};
test('start and structured question actions use only registered Bridge routes and validated wire fields',async()=>{
  const request=conversationRequest('conversation-onboarding-start',ids);assert.equal(request.path,'/warehouses/w/workbench/conversations/c/onboarding/start');assert.equal(request.timeoutMs,285000);assert.equal(request.body.expected_revision,0);assert.equal(request.body.operation_id,request.body._native_operation_id);assert.equal(request.body.content,undefined);
  const questionActions=[{question_id:'server-id',action:'answer',answer:'企业'},{question_id:'another-id',action:'uncertain'}];
  const turn=conversationRequest('conversation-onboarding-send',{...ids,questionActions});assert.deepEqual(turn.body.question_actions,questionActions);assert.equal(turn.body.content,undefined);assert.equal(turn.timeoutMs,285000);
  for(const bad of [[{question_id:'x',action:'answer',answer:' '}],[{question_id:'x',action:'skip',answer:'不能附带'}],[{question_id:'x',action:'unknown'}],[{question_id:'x',action:'skip'},{question_id:'x',action:'uncertain'}],Array.from({length:3},(_,i)=>({question_id:''+i,action:'skip'}))])assert.throws(()=>conversationRequest('conversation-onboarding-send',{...ids,questionActions:bad}));
  assert.throws(()=>conversationRequest('conversation-onboarding-send',{...ids,questionActions,content:'字'.repeat(8000)}));
  assert.throws(()=>conversationRequest('conversation-onboarding-send',{...ids,content:'',questionActions:[]}));
  assert.throws(()=>conversationRequest('conversation-onboarding-start',{...ids,questionActions:[]}));
  assert.throws(()=>conversationRequest('conversation-onboarding-send',{...ids,content:'test',_native_editor:{}}));
  let sent;const service=new SemanticaService({host:{context:async()=>identity,onSessionInvalidated:()=>()=>{},request:async(url,opts)=>{sent={url,opts};return new Response(JSON.stringify({status:'generating'}));}}});
  await service.call('conversation-onboarding-start',ids);assert.match(sent.url,/\/api\/semantica\/warehouses\/w\/workbench\/conversations\/c\/onboarding\/start$/);assert.equal(sent.opts.timeoutMs,285000);
  await service.call('conversation-onboarding-send',{...ids,questionActions});assert.deepEqual(sent.opts.body.question_actions,questionActions);
});
test('first entry automatically starts only once; opening advances revision but not answer rounds or ontology readiness',async()=>{
  const f=fixture(),m=await create(f);assert.equal(m.state.error,'');assert.equal(f.db.generations,1);assert.equal(m.state.snapshot.draft.revision,1);assert.equal(m.state.snapshot.progress.round,0);assert.equal(m.state.snapshot.draft.ontology_proposed,false);assert.equal(m.state.snapshot.can_preview,false);assert.equal(m.state.turns[0].kind,'opening');
  const i=f.calls.findIndex(c=>c.action==='conversation-onboarding-start');assert.ok(f.calls.slice(0,i).some(c=>c.action==='conversation-onboarding-get'));assert.equal(f.calls.some(c=>c.action==='conversation-send'),false);
  await m.refresh();m.dispose();const next=f.model();await next.load();await next.refresh();assert.equal(f.db.generations,1);await next.preview();assert.equal(next.saved.preview,null);
});
test('lost opening response restores exact original operation after reload, with no second model generation',async()=>{
  const f=fixture();f.db.lose='conversation-onboarding-start';const m=await create(f),pending=structuredClone(m.saved.pending);assert.equal(pending.action,'conversation-onboarding-start');m.dispose();const next=f.model();await next.load();assert.equal(f.db.generations,1);await next.recover();assert.equal(next.state.error,'');assert.equal(f.db.generations,1);assert.deepEqual(f.calls.filter(c=>c.action==='conversation-onboarding-start').at(-1).input,pending.input);
});
test('failed HTTP200 opening retains fallback; refresh/reload never retry, explicit retry uses a new operation',async()=>{
  const f=fixture();f.db.failOpening=true;const m=await create(f);assert.equal(m.state.turns[0].status,'failed');assert.equal(m.state.snapshot.draft.revision,0);assert.equal(m.state.snapshot.guidance_source,'fallback');assert.equal(m.saved.pending,null);const original=f.calls.find(c=>c.action==='conversation-onboarding-start').input.operationId;await m.refresh();m.dispose();const next=f.model();await next.load();assert.equal(f.db.generations,1);await next.start();assert.equal(f.db.generations,2);assert.notEqual(f.calls.filter(c=>c.action==='conversation-onboarding-start').at(-1).input.operationId,original);assert.equal(next.state.snapshot.progress.round,0);
});
test('a server-recorded failure is not automatically restarted when local recovery storage is absent',async()=>{
  const f=fixture();f.db.failOpening=true;const m=await create(f);m.dispose();const next=new OnboardingDialogue({...f,identity,storage:memory()});await next.load({warehouse:f.db.warehouses[0]});assert.equal(f.db.generations,1);assert.equal(next.state.snapshot.guidance_source,'fallback');
});
test('pending opening polls active_turn_id, blocks duplicate submissions and leaves draft untouched until receipt',async()=>{
  const f=fixture(),m=f.model();await m.load();m.setName('正在开场');let finish;f.db.hold=new Promise(r=>{finish=r;});const running=m.create();for(let i=0;i<80&&m.inFlight!=='conversation-onboarding-start';i++)await Promise.resolve();assert.equal(m.inFlight,'conversation-onboarding-start');await m.poll();assert.ok(m.state.snapshot.active_turn_id);assert.equal(m.state.snapshot.draft.revision,0);assert.equal(m.editable,false);await m.send();await m.start();await m.poll();assert.ok(f.calls.some(c=>c.action==='conversation-onboarding-turn'));assert.equal(f.db.generations,1);finish();await running;assert.equal(m.generating,false);assert.equal(m.state.snapshot.draft.revision,1);
});
test('reference and staged actions do not change question states; successful mixed input preserves opaque IDs',async()=>{
  const f=fixture(),m=await create(f),[q1,q2]=m.questions;const n=f.calls.length;
  m.stageQuestion(q1.question_id,'answer',q1.examples[0]);m.stageQuestion(q2.question_id,'uncertain');assert.equal(f.calls.length,n);assert.ok(m.questions.every(q=>q.status==='pending'));m.setInput('增加技能等级属性');await m.send();assert.equal(m.state.error,'');
  const request=f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-1).input;assert.deepEqual(request.questionActions,[{question_id:q1.question_id,action:'answer',answer:q1.examples[0]},{question_id:q2.question_id,action:'uncertain'}]);assert.equal(request.content,'增加技能等级属性');assert.equal(m.questions.find(q=>q.question_id===q1.question_id).status,'answered');assert.equal(m.questions.find(q=>q.question_id===q2.question_id).status,'uncertain');assert.equal(m.saved.questionActions.length,0);
  // A field already has a value but its new clarification must remain visible.
  assert.ok(m.state.snapshot.draft.scope.material_sources.length);const followup=m.state.snapshot.draft.questions[0];assert.match(questionCardsHTML([followup],{editable:true}),/是否包含历史简历/);
  m.stageQuestion(followup.question_id,'skip');await m.send();assert.equal(m.state.error,'');const actionOnly=f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-1).input;assert.equal(actionOnly.content,'');assert.deepEqual(actionOnly.questionActions,[{question_id:followup.question_id,action:'skip'}]);assert.equal(m.questions.find(q=>q.question_id===followup.question_id).status,'skipped');
  m.stageQuestion(q2.question_id,'answer','匹配人才与岗位');await m.send();assert.equal(m.questions.find(q=>q.question_id===q2.question_id).status,'answered');
});
test('failed actions leave original ledger and schema intact; restore reply carries both input and actions',async()=>{
  const f=fixture(),m=await create(f),before=structuredClone(m.state.snapshot.draft),q=m.questions[0];m.stageQuestion(q.question_id,'skip');m.setInput('同时补充查询范围');f.db.failTurn=true;await m.send();assert.deepEqual(m.state.snapshot.draft,before);assert.equal(m.state.turns[0].status,'failed');const failed=m.state.turns[0];assert.equal(failed.question_actions[0].answer,'');m.restoreReply(failed.resource_id);assert.equal(m.saved.input,failed.content);assert.deepEqual(m.saved.questionActions,questionActionsFromReceipt(failed.question_actions));await m.send();assert.equal(m.questions.find(q=>q.question_id===failed.question_actions[0].question_id).status,'skipped');assert.notEqual(f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-1).input.operationId,f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-2).input.operationId);
});
test('uncertain turn response replays original question actions even if input draft changed',async()=>{
  const f=fixture(),m=await create(f);m.stageQuestion(m.questions[0].question_id,'uncertain');f.db.lose='conversation-onboarding-send';await m.send();const p=structuredClone(m.saved.pending);m.dispose();const next=f.model();await next.load();await next.recover();assert.deepEqual(f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-1).input,p.input);assert.equal(f.db.generations,2);assert.equal(next.questions.find(q=>q.question_id===p.input.questionActions[0].question_id).status,'uncertain');
});
test('question actions survive reload, block preview, validate current ownership and do not infer IDs from text',async()=>{
  const f=fixture(),m=await create(f);m.stageQuestion(m.questions[0].question_id,'answer');m.setQuestionAnswer(m.questions[0].question_id,'部门');m.persist();m.dispose();const next=f.model();await next.load();assert.equal(next.saved.questionActions[0].answer,'部门');await next.preview();assert.equal(next.state.errorCode,'MODELING_UNSENT_ANSWER');const q=next.saved.questionActions[0].question_id;f.db.snapshots[next.saved.conversationId].draft.question_states=f.db.snapshots[next.saved.conversationId].draft.question_states.filter(p=>p.question_id!==q);const count=f.db.generations;await next.send();assert.equal(next.state.errorCode,'MODELING_ONBOARDING_QUESTION_STALE');assert.equal(f.db.generations,count);assert.equal(next.saved.questionActions[0].question_id,q);
});
test('question ledger renders all five states and escapes answers without representing staged skips as completed',()=>{
  const statuses=['pending','answered','skipped','uncertain','superseded'],questions=statuses.map((status,i)=>({question_id:'id-'+i,text:'问题'+i,status,source:'model',answer:status==='answered'?'<script>':''}));const html=questionLedgerHTML(questions,{editable:true});for(const text of ['待回答','已回答','已跳过','暂不确定','已被后续引导替换'])assert.ok(html.includes(text));assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(questionActionsHTML([{question_id:'id-0',action:'skip'}],questions),/点击发送后提交/);assert.equal(turnInputHTML({kind:'opening'},questions),'');assert.match(turnInputHTML({question_actions:[{question_id:'id-0',action:'skip'}]},questions),/跳过/);
});
test('preview and publication preserve skipped and uncertain questions even with no current questions',async()=>{
  const f=fixture(),m=await create(f);for(const [i,q] of m.questions.entries())m.stageQuestion(q.question_id,i?'uncertain':'skip');await m.send();for(const q of m.state.snapshot.draft.questions)m.stageQuestion(q.question_id,'skip');await m.send();assert.equal(m.state.snapshot.draft.questions.length,0);await m.preview();assert.equal(m.saved.preview.question_states.filter(q=>q.status==='uncertain').length,1);m.state.confirmed=true;await m.publish();assert.equal(f.db.publishes,1);assert.ok(f.entries[0].r.publication.unresolved_questions.length>=2);
});
test('scope-only server changes keep the schema graph and never replace latest state with an older turn',async()=>{
  const f=fixture(),m=await create(f);m.setInput('定义人才与技能');await m.send();const schema=structuredClone(m.state.snapshot.draft.schema),s=f.db.snapshots[m.saved.conversationId];s.draft.scope.purposes=['只调整用途'];s.draft.scope_changes=[{field:'purposes',before:['人才与岗位匹配'],after:['只调整用途']}];s.draft.changes=[];await m.refresh();assert.deepEqual(m.state.snapshot.draft.schema,schema);assert.equal(m.state.snapshot.draft.scope.purposes[0],'只调整用途');
});
