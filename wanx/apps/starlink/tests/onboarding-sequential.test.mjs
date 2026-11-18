import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDialogueQuestion} from '../ui/onboarding-dialogue-questions.mjs';
import {dialogueSideHTML} from '../ui/onboarding-dialogue.mjs';
import {OnboardingDialogue,dialogueError} from '../ui/onboarding-dialogue-state.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
async function setup(){const f=dialogueFixture({guidance:true});let n=0;const m=new OnboardingDialogue({...f,identity,storage:memory(),uuid:()=>`sequential-${++n}`});await m.load();m.setName('逐题引导仓');await m.create();return {f,m};}

test('context exhaustion shows both the configured limit and the required budget',()=>{
  const error_code='MODELING_CONTEXT_BUDGET';
  const text=dialogueError({error_code,context_budget:{context_tokens:4096,required_context_tokens:6780}});
  assert.match(text,/上限是 4096/);
  assert.match(text,/至少需要 6780/);
  assert.match(text,/草稿已保留/);
  assert.equal(dialogueError({error_code,context_budget:{context_tokens:'4096',required_context_tokens:6780}}),
    dialogueError({code:error_code}));
});

test('a cloud billing refusal shows model selection and preserves the draft',()=>{
  const text=dialogueError({error_code:'MODEL_BILLING_REQUIRED'});
  assert.match(text,/云端模型因计费问题/);
  assert.match(text,/模型设置/);
  assert.match(text,/草稿已保留/);
});

test('one question advances only with server ledger success, never from staged or failed answers',async()=>{
  const {f,m}=await setup(),draft=()=>m.state.snapshot.draft,[q1,q2]=m.questions;
  assert.equal(nextDialogueQuestion(draft()).question_id,q1.question_id);
  m.stageQuestion(q1.question_id,'answer','研发部门');assert.equal(nextDialogueQuestion(draft()).question_id,q1.question_id);
  f.db.failTurn=true;await m.send();assert.equal(nextDialogueQuestion(draft()).question_id,q1.question_id);
  m.restoreReply(m.state.turns[0].resource_id);await m.send();assert.equal(nextDialogueQuestion(draft()).question_id,q2.question_id);
  m.stageQuestion(q2.question_id,'uncertain');assert.equal(nextDialogueQuestion(draft()).question_id,q2.question_id);await m.send();
  const next=nextDialogueQuestion(draft());assert.notEqual(next.question_id,q2.question_id);m.stageQuestion(next.question_id,'skip');await m.send();assert.equal(nextDialogueQuestion(draft()),null);
});

test('ledger overrides stale current questions and scope values do not count as answers',()=>{
  const q={question_id:'one',status:'pending',text:'问题一'},q2={question_id:'two',status:'pending',text:'问题二'};
  assert.equal(nextDialogueQuestion({questions:[q,q2],question_states:[{...q,status:'answered'},q2]}).question_id,'two');
  assert.equal(nextDialogueQuestion({questions:[q],question_states:[]}),null);
  assert.equal(nextDialogueQuestion({questions:[],question_states:[q],scope:{service_objects:['已有内容']}}),null);
});

test('initial sidebar shows pending scope and collapsed default definitions without a graph',async()=>{
  const {m}=await setup(),html=dialogueSideHTML({snapshot:m.state.snapshot,editable:true});
  assert.match(html,/等待明确业务范围/);assert.match(html,/<dd>尚未明确<\/dd>/);assert.match(html,/<details id="od-current-rules">/);assert.match(html,/<details id="od-ledger">/);
  assert.doesNotMatch(html,/ob-ontology-node/);assert.doesNotMatch(html,/data-od-question=/);
  assert.match(html,/不是根据本次回答生成的建议/);
});

test('actual ontology suggestions show a graph and scope-only revisions keep it',async()=>{
  const {f,m}=await setup();m.setInput('建立人才与技能范围');await m.send();
  assert.match(dialogueSideHTML({snapshot:m.state.snapshot}),/ob-ontology-node/);
  const s=f.db.snapshots[m.saved.conversationId];s.draft.scope.purposes=['调整用途'];s.draft.changes=[];await m.refresh();
  const html=dialogueSideHTML({snapshot:m.state.snapshot});assert.match(html,/ob-ontology-node/);assert.match(html,/调整用途/);assert.doesNotMatch(html,/等待明确业务范围/);
});
