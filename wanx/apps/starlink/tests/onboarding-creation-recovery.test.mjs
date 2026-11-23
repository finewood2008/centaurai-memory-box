import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {dialogueTemplates} from '../ui/onboarding-templates.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';

test('all home templates fill editable inputs without a service write and survive reload',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();
  let m=new OnboardingDialogue({...f,identity,storage});await m.load();
  const reads=f.calls.length;
  for(const template of dialogueTemplates){m.applyTemplate(template);assert.equal(m.saved.name,template.name);assert.equal(m.saved.purpose,template.purpose);}
  assert.equal(f.calls.length,reads);assert.equal(f.db.warehouses.length,0);assert.equal(f.db.generations,0);
  m.setName('自定义研发知识仓');m.setPurpose('查询技术选型与架构');m.dispose();
  m=new OnboardingDialogue({...f,identity,storage});await m.load();
  assert.equal(m.saved.name,'自定义研发知识仓');assert.equal(m.saved.purpose,'查询技术选型与架构');
  await m.create();assert.equal(m.state.error,'');assert.equal(f.db.warehouses[0].name,'自定义研发知识仓');
  assert.equal(f.calls.find(c=>c.action==='onboarding-create').input.body.purpose,'查询技术选型与架构');
  m.applyTemplate(dialogueTemplates[0]);assert.equal(m.saved.name,'自定义研发知识仓');
});

test('guided warehouse replays the original structured profile after its receipt is lost',async()=>{
  const f=dialogueFixture({guidance:true}), storage=memory();
  const make=()=>new OnboardingDialogue({...f,identity,storage});
  const scope={industry:'制造业',occupation:'设备主管',service_objects:['生产部'],focus_objects:['A 产线'],background:'负责巡检'};
  let m=make();await m.load();m.setName('生产知识仓');m.setPurpose('跟踪故障');
  f.db.lose='onboarding-create';await m.create(scope);m.dispose();
  m=make();await m.load();await m.recover();
  const writes=f.calls.filter(c=>c.action==='onboarding-create');
  assert.equal(writes.length,2);
  assert.deepEqual(writes[0].input,writes[1].input);
  assert.deepEqual(writes[0].input.body.warehouse_scope,scope);
});

test('an invalid creation profile cannot reserve an operation or be replayed from storage',async()=>{
  const f=dialogueFixture(), storage=memory();
  const make=()=>new OnboardingDialogue({...f,identity,storage});
  const m=make();await m.load();m.setName('生产知识仓');
  const invalid={focus_objects:'设备'};
  const before=f.calls.length;
  await m.create(invalid);
  assert.equal(m.state.errorCode,'MODELING_INVALID_REQUEST');
  assert.equal(m.saved.creation,null);
  assert.equal(f.calls.length,before);
  for(const changes of [{profileInputs:[]},{creation:{name:'生产知识仓',operationId:'restore',warehouseScope:invalid}}]){
    storage.setItem(m.key,JSON.stringify({...m.saved,...changes}));
    const restored=make();
    assert.throws(()=>restored.restore(),{code:'MODELING_LOCAL_RECORD_INVALID'});
    assert.equal(f.calls.length,before);
  }
});

test('definite session refusal preserves the warehouse and retries with a new operation after reload',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();let reject=true,n=0;
  const call=async(action,input)=>{
    if(action==='conversation-create'&&reject){f.calls.push({action,input:structuredClone(input)});throw Object.assign(Error(),{code:'MODELING_INVALID_REQUEST',status:422});}
    return f.call(action,input);
  };
  const make=()=>new OnboardingDialogue({...f,call,storage,identity,uuid:()=>`recovery-${++n}`});
  let m=make();await m.load();m.applyTemplate(dialogueTemplates[2]);await m.create();
  assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,0);assert.equal(m.saved.pending,null);
  assert.match(m.state.error,/Bridge.*onboarding/);assert.doesNotMatch(m.state.error,/检查输入长度/);
  const warehouse=m.saved.warehouse.id,first=f.calls.find(c=>c.action==='conversation-create').input;
  assert.equal(m.state.loaded,true);assert.equal(m.editable,false);
  m.dispose();m=make();await m.load();assert.equal(m.state.loaded,true);assert.equal(m.saved.warehouse.id,warehouse);
  reject=false;await m.recover();assert.equal(m.state.error,'');assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,1);assert.equal(f.db.generations,1);
  const last=f.calls.filter(c=>c.action==='conversation-create').at(-1).input;
  assert.notEqual(last.operationId,first.operationId);assert.equal(last.scenario,'onboarding');assert.equal(last.warehouseId,warehouse);
});

test('lost session receipt reuses the exact operation and does not generate a second opening',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();let n=0;
  const make=()=>new OnboardingDialogue({...f,identity,storage,uuid:()=>`lost-${++n}`});
  let m=make();await m.load();m.applyTemplate(dialogueTemplates[0]);f.db.lose='conversation-create';await m.create();
  const original=structuredClone(m.saved.pending.input);assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,1);
  m.applyTemplate(dialogueTemplates[1]);assert.equal(m.saved.name,dialogueTemplates[0].name);
  m.dispose();m=make();await m.load();await m.recover();await m.refresh();
  assert.equal(m.state.error,'');assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,1);assert.equal(f.db.generations,1);
  assert.deepEqual(f.calls.filter(c=>c.action==='conversation-create').map(c=>c.input),[original,original]);
});

test('read-only refresh reattaches an existing session after the initial list failed',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();let failed=true,n=0;
  const warehouse=(await f.call('onboarding-create',{body:{operation_id:'other-warehouse',name:'已有仓库'}})).warehouse;
  const session=await f.call('conversation-create',{warehouseId:warehouse.id,operationId:'other-session',scenario:'onboarding'});
  const call=async(a,i)=>{if(a==='conversation-list'&&failed)throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'});return f.call(a,i);};
  const m=new OnboardingDialogue({...f,call,storage,identity,uuid:()=>`refresh-${++n}`});await m.load({warehouse});
  assert.equal(m.saved.conversationId,null);assert.equal(m.editable,false);
  const writes=f.calls.filter(c=>['onboarding-create','conversation-create','conversation-onboarding-start'].includes(c.action)).length;
  failed=false;await m.refresh();
  assert.equal(m.state.error,'');assert.equal(m.saved.conversationId,session.resource_id);assert.equal(m.state.snapshot.conversation_id,session.resource_id);assert.equal(m.editable,true);
  assert.equal(f.calls.filter(c=>['onboarding-create','conversation-create','conversation-onboarding-start'].includes(c.action)).length,writes);
  assert.equal(f.db.generations,0);
});

test('continue checks for a session created elsewhere before creating another one',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();let n=0;
  const m=new OnboardingDialogue({...f,storage,identity,uuid:()=>`concurrent-${++n}`});await m.load();
  m.applyTemplate(dialogueTemplates[0]);f.db.refuse='conversation-create';await m.create();f.db.refuse=null;
  const session=await f.call('conversation-create',{warehouseId:m.saved.warehouse.id,operationId:'other-window',scenario:'onboarding'});
  await m.recover();
  assert.equal(m.state.error,'');assert.equal(m.saved.conversationId,session.resource_id);
  assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,1);assert.equal(f.db.generations,1);
});

test('continue does not create a new session if checking existing sessions fails',async()=>{
  const f=dialogueFixture({guidance:true});let denyList=false,n=0;
  const call=async(a,i)=>{if(a==='conversation-list'&&denyList)throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'});return f.call(a,i);};
  const m=new OnboardingDialogue({...f,call,storage:memory(),identity,uuid:()=>`no-duplicate-${++n}`});await m.load();
  m.applyTemplate(dialogueTemplates[0]);f.db.refuse='conversation-create';await m.create();f.db.refuse=null;
  const attempts=f.calls.filter(c=>c.action==='conversation-create').length;denyList=true;await m.recover();
  assert.equal(m.state.errorCode,'SEMANTICA_CONNECTION_FAILED');assert.equal(f.calls.filter(c=>c.action==='conversation-create').length,attempts);
  assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,0);
});
