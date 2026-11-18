import test from 'node:test';
import assert from 'node:assert/strict';
import {createProgressPoller} from '../ui/onboarding-progress.mjs';
import {answerGuidance} from '../ui/onboarding-state.mjs';

function fixture(){
  const timers=new Map();let sequence=0,reads=0,active=true;
  let flow={live:true,state:{loaded:true,busy:false,error:'',proposal:{status:'generating'}},refresh:async()=>{reads++;}};
  const poller=createProgressPoller({current:()=>flow,active:()=>active,schedule:fn=>{const id=++sequence;timers.set(id,fn);return id;},cancel:id=>timers.delete(id)});
  return {poller,timers,get flow(){return flow;},get reads(){return reads;},hide:()=>{active=false;},replace:()=>{flow={...flow,state:{...flow.state}};},tick:async()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);await fn();}};
}
test('generation polling reads once per interval and stops at a terminal result',async()=>{
  const f=fixture();f.poller.sync();f.poller.sync();assert.equal(f.timers.size,1);
  await f.tick();assert.equal(f.reads,1);assert.equal(f.timers.size,1);
  f.flow.refresh=async()=>{f.flow.state.proposal.status='succeeded';};
  await f.tick();assert.equal(f.timers.size,0);
});
test('hidden, switched, busy and failed flows cannot continue polling',async()=>{
  for(const invalidate of [f=>f.hide(),f=>f.replace(),f=>{f.flow.live=false;},f=>{f.flow.state.busy=true;}]){
    const f=fixture();f.poller.sync();invalidate(f);await f.tick();assert.equal(f.reads,0);assert.equal(f.timers.size,0);
  }
  const f=fixture();f.poller.sync();f.flow.state.error='offline';f.poller.sync();assert.equal(f.timers.size,0);
});
test('polling never submits an uncertain request and does not overlap a pending read',async()=>{
  const f=fixture();f.flow.state.proposal=null;f.flow.state.pending={action:'onboarding-generate',input:{body:{operation_id:'same'}}};
  let finish;f.flow.refresh=async()=>{f.flow.state.busy=true;f.poller.sync();await new Promise(resolve=>{finish=resolve;});f.flow.state.busy=false;f.flow.state.pending=null;};
  f.poller.sync();const running=f.tick();f.poller.sync();assert.equal(f.timers.size,0);
  finish();await running;assert.equal(f.timers.size,0);
});
test('long input guidance ignores removed background and never edits submitted content',()=>{
  const answers={industry:'制造业',occupation:'研发',background:'旧'.repeat(8000),purpose:'短用途'};
  assert.doesNotMatch(answerGuidance(answers),/可能超出/);
  answers.purpose='用'.repeat(1400);const before=structuredClone(answers);
  assert.match(answerGuidance(answers),/可能超出当前模型预算/);assert.deepEqual(answers,before);
});
