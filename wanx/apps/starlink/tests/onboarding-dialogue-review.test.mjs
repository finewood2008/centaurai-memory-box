import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {questionActionsFromReceipt} from '../shared/onboarding-dialogue-contract.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
function fixture(){const f=dialogueFixture({guidance:true}),storage=memory();let n=0;const model=()=>new OnboardingDialogue({...f,storage,identity,uuid:()=>`review-${++n}`});return {...f,storage,model};}
async function create(f){const m=f.model();await m.load();m.setName('回归测试仓');await m.create();assert.equal(m.state.error,'');return m;}
test('server-defaulted empty answers normalize only on receipt restoration, and never hide malformed skip answers',()=>{
  assert.deepEqual(questionActionsFromReceipt([{question_id:'q',action:'skip',answer:''},{question_id:'q2',action:'uncertain',answer:''}]),[{question_id:'q',action:'skip'},{question_id:'q2',action:'uncertain'}]);
  assert.throws(()=>questionActionsFromReceipt([{question_id:'q',action:'skip',answer:'wrong'}]));
  assert.throws(()=>questionActionsFromReceipt([{question_id:'q',action:'answer',answer:''}]));
});
test('HTTP200 generating receipt survives a failed GET and keeps polling the original turn without new writes',async()=>{
  const f=fixture(),m=await create(f),original=f.call;let failGet=false,generated=false,reads=[];
  m.call=async(a,i)=>{if(a==='conversation-onboarding-send'){
    generated=true;const r={resource_id:'accepted-running',conversation_id:i.conversationId,status:'generating',kind:'reply',content:i.content,publication_performed:false};
    const s=f.db.snapshots[i.conversationId];s.turns.items.unshift(r);s.active_turn_id=r.resource_id;s.can_preview=false;failGet=true;return structuredClone(r);
  }if(a==='conversation-onboarding-get'&&failGet){failGet=false;throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'});}if(a==='conversation-onboarding-turn')reads.push(i.turnId);return original(a,i);};
  m.setInput('继续处理');await m.send();assert.ok(generated);assert.equal(m.saved.pending,null);assert.equal(m.saved.activeTurn.turnId,'accepted-running');assert.equal(m.generating,true);assert.equal(m.editable,false);
  await m.poll();assert.deepEqual(reads,['accepted-running']);assert.equal(m.state.error,'');const n=f.db.generations;m.dispose();const next=f.model();await next.load();assert.equal(next.generating,true);assert.equal(f.db.generations,n);
  const s=f.db.snapshots[next.saved.conversationId];s.active_turn_id=null;s.turns.items[0].status='failed';await next.poll();assert.equal(next.generating,false);assert.equal(next.saved.activeTurn,null);assert.equal(next.state.turns[0].status,'failed');
});
test('switching conversations, restarting, and starting a new session retain unsent text and question actions per conversation',async()=>{
  const f=fixture(),m=await create(f),first=m.saved.conversationId,q=m.questions[0].question_id;m.setInput('未发送的补充');m.stageQuestion(q,'answer','原问题回答');
  await m.chooseSession(first);assert.equal(m.saved.input,'未发送的补充');assert.equal(m.saved.questionActions[0].answer,'原问题回答');
  await m.newSession();const second=m.saved.conversationId;assert.notEqual(second,first);assert.equal(m.saved.input,'');assert.equal(m.saved.questionActions.length,0);m.setInput('第二个会话');await m.chooseSession(first);assert.equal(m.saved.input,'未发送的补充');assert.equal(m.saved.questionActions[0].question_id,q);
  m.dispose();const next=f.model();await next.load();assert.equal(next.saved.input,'未发送的补充');await next.chooseSession(second);assert.equal(next.saved.input,'第二个会话');assert.equal(next.saved.questionActions.length,0);
});
test('fresh warehouse entry preserves the old conversation composer rather than erasing its saved progress',async()=>{
  const f=fixture(),m=await create(f),warehouse=m.saved.warehouse,conversation=m.saved.conversationId;m.setInput('稍后继续');m.stageQuestion(m.questions[0].question_id,'uncertain');m.dispose();
  const fresh=f.model();await fresh.load({fresh:true});assert.equal(fresh.saved.warehouse,null);fresh.dispose();
  const back=f.model();await back.load({warehouse});assert.equal(back.saved.conversationId,conversation);assert.equal(back.saved.input,'稍后继续');assert.equal(back.saved.questionActions[0].action,'uncertain');
});
test('continue editing stays in chat across reads, while reopening a saved preview still requires confirmation',async()=>{
  const f=fixture(),m=await create(f);m.setInput('建立人才类型');await m.send();await m.preview();assert.equal(m.state.page,'review');m.state.page='chat';m.state.confirmed=false;await m.refresh();assert.equal(m.state.page,'chat');assert.ok(m.saved.preview);m.dispose();const next=f.model();await next.load();assert.equal(next.state.page,'review');assert.equal(next.state.confirmed,false);
});
test('invalid recovery storage cannot be bypassed with refresh to overwrite an unknown pending operation',async()=>{
  const f=fixture(),m=f.model();f.storage.setItem(m.key,'{broken');await m.load();assert.equal(m.state.loaded,false);const raw=f.storage.getItem(m.key);await m.refresh();assert.equal(m.state.loaded,false);assert.equal(m.state.errorCode,'MODELING_LOCAL_RECORD_INVALID');m.saved.name='不能覆盖记录';await m.create();assert.equal(f.storage.getItem(m.key),raw);assert.equal(f.db.warehouses.length,0);
});
test('successful completion clears an obsolete polling failure instead of showing a stale error banner',async()=>{
  const f=fixture(),m=await create(f);let release;f.db.hold=new Promise(r=>{release=r;});m.setInput('正常完成的回答');const running=m.send();for(let i=0;i<30&&!m.inFlight;i++)await Promise.resolve();
  const original=m.call;let failRead=true;m.call=async(a,i)=>{if(a==='conversation-onboarding-get'&&failRead){failRead=false;throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'});}return original(a,i);};
  await m.poll();assert.ok(m.state.error);assert.equal(m.state.pollError,true);release();await running;assert.equal(m.state.error,'');assert.equal(m.state.pollError,false);assert.equal(m.state.turns[0].status,'succeeded');
});
