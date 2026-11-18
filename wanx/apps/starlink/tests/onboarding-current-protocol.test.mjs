import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {dialogueProgress,dialogueSideHTML} from '../ui/onboarding-dialogue.mjs';
import {nextDialogueQuestion} from '../ui/onboarding-dialogue-questions.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
import {baseScope,scopeCardsHTML,scopeChangesHTML,scopeQuestionHTML} from '../ui/onboarding-scope-workspace.mjs';

function setup(){
  const f=dialogueFixture({guidance:true}),storage=memory();let n=0;
  return {...f,model:()=>new OnboardingDialogue({...f,identity,storage,uuid:()=>`protocol-${++n}`})};
}
async function create(f){const m=f.model();await m.load();m.setName('当前协议验收仓');m.setPurpose('查询研发资料');await m.create();return m;}

test('scope review uses the persisted baseline and does not ask about covered fields',()=>{
  const question={question_id:'q',field:'purposes',text:'希望解决什么？',status:'pending'};
  const draft={revision:3,scope:{purposes:['查产品','查需求'],service_objects:['个人']},questions:[question],question_states:[question]};
  const snapshot={seed:{purpose:{purpose:'查产品\n查需求',_onboarding_scope:{purposes:['查产品','查需求']}}},draft};
  assert.deepEqual(baseScope(snapshot).purposes,['查产品','查需求']);
  assert.equal(scopeQuestionHTML(snapshot,true,'引导 1 / 5 轮'),'');
  const review=scopeChangesHTML(snapshot,{scope:draft.scope});
  assert.match(review,/服务对象/);
  assert.doesNotMatch(review,/查产品|查需求/);
  const older=scopeChangesHTML({draft},{scope:draft.scope});
  assert.match(older,/基础范围/);
  assert.doesNotMatch(older,/范围与现行一致/);
});

test('range cards ask one missing question even if a covered prompt comes first',()=>{
  const covered={question_id:'covered',field:'purposes',text:'已填写用途',status:'pending'};
  const missing={question_id:'missing',field:'material_sources',text:'补充资料来源',status:'pending'};
  const skipped={question_id:'skipped',field:'questions_to_answer',text:'将来要查什么',status:'skipped'};
  const snapshot={draft:{revision:0,scope:{purposes:['研发资料'],service_objects:['项目组']},
    questions:[covered,missing],question_states:[covered,missing,skipped]}};
  const prompt=scopeQuestionHTML(snapshot,true,'引导 1 / 5 轮');
  assert.match(prompt,/补充资料来源/);
  assert.doesNotMatch(prompt,/已填写用途/);
  const cards=scopeCardsHTML(snapshot,{deferredQuestionId:'missing'});
  assert.match(cards,/<h3>资料来源<\/h3>[^<]*<span[^>]*>稍后/);
  assert.match(cards,/<h3>希望回答的问题<\/h3>[^<]*<span[^>]*>跳过/);
  assert.match(cards,/<h3>用途<\/h3>[^<]*<span[^>]*>已覆盖/);
});

test('a postponed scope question and unsent scope edits survive returning to this warehouse',async()=>{
  const f=setup(),warehouse={id:'existing',name:'已有数据仓',state:'active'};
  f.db.warehouses.push(warehouse);
  let m=f.model();await m.load({warehouse,startUpdate:true});
  const id=m.currentQuestion.question_id;
  const sends=f.calls.filter(c=>c.action==='conversation-onboarding-send').length;
  m.deferQuestion();
  assert.equal(m.saved.deferredQuestionId,id);
  assert.equal(m.inputQuestion,null);
  m.setInput('稍后补充的业务范围');
  m.dispose();m=f.model();await m.load({warehouse,startUpdate:true});
  assert.equal(m.saved.deferredQuestionId,id);
  assert.equal(m.saved.input,'稍后补充的业务范围');
  assert.equal(f.calls.filter(c=>c.action==='conversation-onboarding-send').length,sends);
  m.setInput('');m.answerQuestion(id);
  assert.equal(m.saved.deferredQuestionId,null);
  assert.equal(m.inputQuestion.question_id,id);
});

test('a scope calibration trusts service readiness and holds the receipt until explicit entry',async()=>{
  const f=setup(),warehouse={id:'existing',name:'已有数据仓',state:'active'};
  f.db.warehouses.push(warehouse);
  let m=f.model();await m.load({warehouse,startUpdate:true});
  const snapshot=f.db.snapshots[m.saved.conversationId];
  snapshot.can_preview=true;
  assert.equal(snapshot.draft.ontology_proposed,false);
  await m.refresh();
  assert.equal(m.canPreview,true);
  await m.preview();
  assert.match(f.calls.find(c=>c.action==='conversation-onboarding-preview').input.name,/范围校准/);
  assert.equal(f.db.publishes,0);
  m.state.confirmed=true;
  f.db.lose='conversation-onboarding-publish';
  await m.publish();
  m.dispose();m=f.model();await m.load({warehouse,startUpdate:true});
  await m.recover();
  assert.equal(f.db.publishes,1);
  assert.equal(f.entries.length,0);
  assert.equal(m.saved.publication.changed,false);
  assert.equal(m.saved.publication.ontology_id,'base');
  assert.equal(m.state.snapshot.status,'published');
  assert.equal(m.saved.entryPending,true);
  await m.enter();
  assert.equal(f.entries[0].r.view,'ontology');
});

test('existing global answers and revision remain untouched when creating a dialogue warehouse',async()=>{
  const f=setup();f.db.root={id:'existing',revision:7,answers:{industry:'原行业',occupation:'原角色',background:'原背景'}};
  const original=structuredClone(f.db.root),m=await create(f);
  assert.equal(m.state.error,'');assert.deepEqual(f.db.root,original);
  assert.equal(f.calls.some(c=>c.action==='onboarding-save'),false);
  const request=f.calls.find(c=>c.action==='onboarding-create').input;
  assert.equal(request.onboardingId,'existing');assert.equal(request.body.expected_revision,7);
  assert.equal(request.body.purpose,'查询研发资料');assert.equal(request.body.answers,undefined);
  assert.equal(m.state.snapshot.draft.scope.industry,'');
  assert.equal(f.db.sessions[0].scenario,'onboarding');
});

test('first-time creation saves only an empty compatibility record and replays a lost receipt exactly',async()=>{
  const f=setup();f.db.lose='onboarding-save';let m=await create(f);
  const original=structuredClone(m.saved.pending.input);
  assert.deepEqual(original.body.answers,{});assert.equal(original.body.expected_revision,0);
  m.dispose();m=f.model();await m.load();await m.recover();
  assert.equal(m.state.error,'');assert.equal(f.db.warehouses.length,1);
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-save').map(c=>c.input),[original,original]);
  assert.deepEqual(f.db.root.answers,{});
});

test('lost warehouse creation using an existing record retains its operation and never writes global answers',async()=>{
  const f=setup();f.db.root={id:'existing',revision:3,answers:{background:'保留'}};f.db.lose='onboarding-create';
  let m=await create(f);const original=structuredClone(m.saved.pending.input);
  m.dispose();m=f.model();await m.load();await m.recover();
  assert.equal(m.state.error,'');assert.equal(f.db.warehouses.length,1);
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-create').map(c=>c.input),[original,original]);
  assert.equal(f.calls.some(c=>c.action==='onboarding-save'),false);
});

test('a nonempty record revision without an ID is rejected rather than overwritten',async()=>{
  const f=setup();f.db.root={revision:4,answers:{background:'保留'}};const m=await create(f);
  assert.equal(m.state.errorCode,'SEMANTICA_INVALID_RESPONSE');
  assert.equal(f.calls.some(c=>['onboarding-save','onboarding-create'].includes(c.action)),false);
});

test('deferred questions remain supplementary and can be explicitly answered by ID with lost-response recovery',async()=>{
  const f=setup();let m=await create(f);const s=f.db.snapshots[m.saved.conversationId];
  const q={question_id:'later',text:'补充资料范围',status:'deferred',answer:'',source:'model'};
  s.draft.questions=[];s.draft.question_states=[q];
  s.progress={round:7,guidance_rounds:5,max_guidance_rounds:5,remaining_rounds:0,guidance_complete:true};
  await m.refresh();
  const html=dialogueSideHTML({snapshot:m.state.snapshot,editable:m.editable});
  assert.match(html,/待补充/);assert.match(html,/data-od-question="later"/);assert.match(html,/补充回答/);
  assert.equal(nextDialogueQuestion(m.state.snapshot.draft),null);assert.equal(m.inputQuestion,null);
  m.answerQuestion(q.question_id,'仅研发材料');f.db.lose='conversation-onboarding-send';await m.sendComposer();
  const original=structuredClone(m.saved.pending.input);
  assert.deepEqual(original.questionActions,[{question_id:'later',action:'answer',answer:'仅研发材料'}]);
  m.dispose();m=f.model();await m.load();await m.recover();
  assert.equal(m.state.error,'');assert.equal(m.questions.find(q=>q.question_id==='later').status,'answered');
  assert.deepEqual(f.calls.filter(c=>c.action==='conversation-onboarding-send').map(c=>c.input),[original,original]);
  assert.equal(f.db.publishes,0);
});

test('guidance progress uses server guidance counters rather than all answer rounds',()=>{
  const p={round:7,guidance_rounds:5,max_guidance_rounds:5,remaining_rounds:0,guidance_complete:true};
  assert.match(dialogueProgress(p).label,/5 \/ 5/);assert.match(dialogueProgress(p).label,/已完成/);
  assert.match(dialogueProgress(p).hint,/行业和适用角色.*不计入/);
  assert.match(dialogueProgress({...p,round:2,guidance_rounds:0,remaining_rounds:5,guidance_complete:false}).label,/0 \/ 5/);
  assert.match(dialogueProgress({...p,guidance_rounds:2,remaining_rounds:3}).label,/2 \/ 5/);
  assert.equal(dialogueProgress({round:7}).label,'逐步明确范围');
});
