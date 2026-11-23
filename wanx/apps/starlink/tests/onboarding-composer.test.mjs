import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
async function setup(){const f=dialogueFixture({guidance:true}),storage=memory();let n=0;const options={...f,identity,storage,uuid:()=>`composer-${++n}`},m=new OnboardingDialogue(options);await m.load();m.setName('部门知识仓');await m.create();return {...f,options,m,storage};}
const last=f=>f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-1).input;

test('typing directly sends exactly one current question action without duplicating the answer in content',async()=>{
  const f=await setup(),m=f.m,id=m.inputQuestion.question_id;m.setInput('某个部门');assert.equal(m.saved.questionActions.length,0);await m.sendComposer();
  assert.deepEqual(last(f).questionActions,[{question_id:id,action:'answer',answer:'某个部门'}]);assert.equal(last(f).content,'');assert.equal(m.saved.input,'');assert.equal(m.saved.inputQuestionId,null);assert.notEqual(m.inputQuestion.question_id,id);
});

test('reference fills bottom composer and still needs explicit send; free mode sends only content',async()=>{
  const f=await setup(),m=f.m,id=m.inputQuestion.question_id,count=f.db.generations;m.answerQuestion(id,'研发部门');assert.equal(m.saved.input,'研发部门');assert.equal(m.saved.questionActions.length,0);assert.equal(f.db.generations,count);
  m.setInputMode('free');m.setInput('先排除个人住址');await m.sendComposer();assert.equal(last(f).content,'先排除个人住址');assert.equal(last(f).questionActions,undefined);assert.equal(m.questions.find(q=>q.question_id===id).status,'pending');
});

test('composer target survives reload; newer questions cannot silently reassign an existing answer',async()=>{
  const f=await setup(),m=f.m,id=m.inputQuestion.question_id;m.setInput('某个部门');m.dispose();const next=new OnboardingDialogue(f.options);await next.load();assert.equal(next.inputQuestion.question_id,id);
  const s=f.db.snapshots[next.saved.conversationId];s.draft.question_states.find(q=>q.question_id===id).status='superseded';await next.refresh();const n=f.db.generations;await next.sendComposer();assert.equal(f.db.generations,n);assert.equal(next.state.errorCode,'MODELING_ONBOARDING_QUESTION_STALE');assert.equal(next.saved.input,'某个部门');
});

test('lost reply restores identical bound answer and operation without generating twice',async()=>{
  const f=await setup(),m=f.m;m.setInput('研发部门');f.db.lose='conversation-onboarding-send';await m.sendComposer();const p=structuredClone(m.saved.pending);assert.equal(p.composer.input,'研发部门');m.dispose();const next=new OnboardingDialogue(f.options);await next.load();await next.recover();assert.equal(f.db.generations,2);assert.deepEqual(last(f),p.input);assert.equal(next.saved.input,'');assert.equal(next.saved.questionActions.length,0);
});

test('failed bound answer can be restored and retried with its original question ID',async()=>{
  const f=await setup(),m=f.m,id=m.inputQuestion.question_id;m.setInput('部门');f.db.failTurn=true;await m.sendComposer();const turn=m.state.turns[0],op=last(f).operationId;assert.equal(turn.status,'failed');assert.equal(m.inputQuestion.question_id,id);
  m.restoreReply(turn.resource_id);await m.sendComposer();assert.equal(last(f).questionActions[0].question_id,id);assert.notEqual(last(f).operationId,op);assert.equal(m.questions.find(q=>q.question_id===id).status,'answered');
});

test('skip remains a skip even with supplementary text; switching back to answer replaces the staged skip',async()=>{
  const f=await setup(),m=f.m,id=m.inputQuestion.question_id;m.stageQuestion(id,'skip');m.setInput('我想先说明用途');await m.sendComposer();assert.deepEqual(last(f).questionActions,[{question_id:id,action:'skip'}]);assert.equal(last(f).content,'我想先说明用途');
  const next=m.inputQuestion.question_id;m.stageQuestion(next,'skip');m.setInputMode('answer');m.setInput('人才匹配');await m.sendComposer();assert.deepEqual(last(f).questionActions,[{question_id:next,action:'answer',answer:'人才匹配'}]);
});

test('legacy free text drafts stay free text after upgrading and bound answers enforce API length',async()=>{
  const f=await setup(),m=f.m;const old=structuredClone(m.saved);delete old.inputMode;delete old.inputQuestionId;old.input='修改范围';f.storage.setItem(m.key,JSON.stringify(old));m.dispose();const next=new OnboardingDialogue(f.options);await next.load();assert.equal(next.saved.inputMode,'free');await next.sendComposer();assert.equal(last(f).content,'修改范围');
  next.setInputMode('answer');next.setInput('字'.repeat(4001));const count=f.db.generations;await next.sendComposer();assert.equal(f.db.generations,count);assert.equal(next.saved.input.length,4001);
});
