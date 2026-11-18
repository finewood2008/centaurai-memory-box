import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingHome,shouldResumeDialogue} from '../ui/onboarding-home-state.mjs';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {identityKey,onboardingRequest} from '../shared/onboarding-contract.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
const key='starlink.onboarding.v1.'+identityKey(identity);
const oldRecord={version:1,step:'result',answers:{industry:'企业服务',occupation:'法务',warehouse_name:'合同知识仓'},needsReview:false,warehouse:null,pending:null,creation:null};
async function pendingCreation(){
  const f=dialogueFixture(),storage=memory();
  const saved=await f.call('onboarding-save',{body:{operation_id:'old-save',expected_revision:0,answers:oldRecord.answers}});
  const input={onboardingId:saved.resource_id,body:{operation_id:'old-create',expected_revision:saved.revision,name:'合同知识仓',purpose:''}};
  const record={...oldRecord,needsReview:true,step:'confirm',creation:{operation:'old-create',answers:{...oldRecord.answers,purpose:''},saved:{id:saved.resource_id,revision:saved.revision}},pending:{action:'onboarding-create',path:onboardingRequest('onboarding-create',input).path,input}};
  storage.setItem(key,JSON.stringify(record));return {...f,storage,input};
}

test('home reads legacy records without requiring retired suggestion endpoints or replaying old generation',async()=>{
  const f=dialogueFixture(),storage=memory(),warehouse={id:'old',name:'合同知识仓',state:'active'};f.db.warehouses.push(warehouse);
  storage.setItem(key,JSON.stringify({...oldRecord,warehouse}));
  const m=new OnboardingHome({...f,storage,identity});await m.load();await m.refresh();
  assert.equal(m.state.loaded,true);assert.equal(m.state.error,'');assert.equal(m.state.warehouse.id,warehouse.id);
  assert.ok(f.calls.every(c=>['onboarding-read','onboarding-warehouses'].includes(c.action)));
});

test('legacy uncertain creation recovers the original operation without generating old suggestions',async()=>{
  const f=dialogueFixture(),storage=memory(),operation='old-create';
  const saved=await f.call('onboarding-save',{body:{operation_id:'old-save',expected_revision:0,answers:oldRecord.answers}});
  const input={onboardingId:saved.resource_id,body:{operation_id:operation,expected_revision:saved.revision,name:'合同知识仓',purpose:''}};
  const created=await f.call('onboarding-create',input);
  const record={...oldRecord,step:'confirm',creation:{operation,answers:{...oldRecord.answers,purpose:''},saved:{id:saved.resource_id,revision:saved.revision}},pending:{action:'onboarding-create',path:onboardingRequest('onboarding-create',input).path,input}};
  storage.setItem(key,JSON.stringify(record));const m=new OnboardingHome({...f,storage,identity});await m.load();
  assert.equal(m.state.loaded,true);assert.ok(m.state.creation);await m.create({generate:false});
  assert.equal(m.state.error,'');assert.equal(m.state.warehouse.id,created.warehouse.id);assert.equal(m.state.pending,null);assert.equal(m.state.creation,null);assert.equal(f.db.warehouses.length,1);
  const creates=f.calls.filter(c=>c.action==='onboarding-create');assert.equal(creates.length,2);assert.deepEqual(creates[0].input,creates[1].input);
  assert.equal(f.db.generations,0);
});

test('old needsReview cannot deadlock recovery of an immutable creation after removing the form',async()=>{
  const f=await pendingCreation(),m=new OnboardingHome({...f,identity});await m.load();await m.create();
  assert.equal(m.state.error,'');assert.equal(f.db.warehouses.length,1);assert.equal(m.state.creation,null);
  assert.deepEqual(f.calls.find(c=>c.action==='onboarding-create').input,f.input);
  assert.equal(f.db.generations,0);
});

for(const code of ['MODELING_REVISION_CHANGED','WAREHOUSE_NAME_CONFLICT'])test('definite refusal '+code+' releases old creation and archives the original envelope',async()=>{
  const f=await pendingCreation(),m=new OnboardingHome({...f,identity});f.db.refuse='onboarding-create';f.db.refuseCode=code;
  await m.load();await m.create();assert.ok(m.state.error);assert.equal(m.state.pending,null);assert.equal(m.state.creation,null);assert.equal(f.db.warehouses.length,0);
  assert.deepEqual(JSON.parse(f.storage.getItem(key+'.rejected-creation')).pending.input,f.input);
  const next=new OnboardingHome({...f,identity});await next.load();assert.equal(next.state.loaded,true);assert.equal(next.state.creation,null);
});

for(const [code,status] of [['MODELING_OPERATION_CONFLICT',409],['SEMANTICA_CONNECTION_FAILED',0],['MODELING_OWNER_REQUIRED',403]])test('uncertain/refused authorization '+code+' retains the original creation for recovery',async()=>{
  const f=await pendingCreation(),call=async(a,i)=>{if(a==='onboarding-create')throw Object.assign(Error(),{code,status});return f.call(a,i);};
  const m=new OnboardingHome({...f,identity,call});await m.load();await m.create();assert.ok(m.state.pending);assert.ok(m.state.creation);assert.deepEqual(m.state.pending.input,f.input);assert.equal(f.storage.getItem(key+'.rejected-creation'),null);
});

test('startup reads the original dialogue, resumes unfinished work, and enters materials only after publication',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();let n=0;const options={...f,storage,identity,uuid:()=>`startup-${++n}`};
  const m=new OnboardingDialogue(options);await m.load();m.setName('人才知识仓');await m.create();const count=f.calls.length;
  assert.equal(m.saved.pending,null);assert.equal(await shouldResumeDialogue(options),true);
  assert.ok(f.calls.slice(count).every(c=>c.action==='conversation-onboarding-get'));
  const snapshot=f.db.snapshots[m.saved.conversationId];snapshot.status='published';assert.equal(await shouldResumeDialogue(options),false);
  const failedRead=async()=>{throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'});};assert.equal(await shouldResumeDialogue({...options,call:failedRead}),true);
  assert.equal(f.db.generations,1);assert.equal(f.db.publishes,0);
});

test('pending and malformed dialogue records never fall through to materials or replay writes on startup',async()=>{
  const f=dialogueFixture(),storage=memory(),options={...f,storage,identity};const m=new OnboardingDialogue(options);
  assert.equal(await shouldResumeDialogue(options),false);m.setName('尚未创建');assert.equal(await shouldResumeDialogue(options),true);
  storage.setItem(m.key,'{broken');assert.equal(await shouldResumeDialogue(options),true);assert.equal(f.calls.length,0);assert.equal(storage.getItem(m.key),'{broken');
});

test('a slow startup read never overwrites a newer local composer or clears its pending request',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory();let n=0;const options={...f,storage,identity,uuid:()=>`slow-${++n}`};
  const m=new OnboardingDialogue(options);await m.load();m.setName('测试仓');await m.create();m.setInput('生成人才本体');await m.send();await m.preview();
  let release;const wait=new Promise(r=>{release=r;});
  const reading=shouldResumeDialogue({...options,call:async(a,i)=>{await wait;return f.call(a,i);}});
  // A changed digest invalidates the probe's old preview, but only in its memory.
  f.db.snapshots[m.saved.conversationId].draft_digest='f'.repeat(64);
  m.setInput('新的未发送回答');const latest=storage.getItem(m.key);release();await reading;
  assert.equal(storage.getItem(m.key),latest);
});

test('empty or deleted warehouse lists leave the user on creation home without fetching stale conversations',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory(),options={...f,storage,identity};const m=new OnboardingDialogue(options);await m.load();m.setName('稍后删除');await m.create();const count=f.calls.length;
  assert.equal(await shouldResumeDialogue({...options,warehouses:[]}),false);
  assert.equal(await shouldResumeDialogue({...options,warehouses:[{id:m.saved.warehouse.id,state:'deleted'}]}),false);assert.equal(f.calls.length,count);
  // Unknown writes are not discarded or silently restarted just because the list is empty.
  m.setInput('回答');f.db.lose='conversation-onboarding-send';await m.send();assert.equal(await shouldResumeDialogue({...options,warehouses:[]}),true);assert.ok(JSON.parse(storage.getItem(m.key)).pending);
});

test('templates prefill an editable name and purpose without creating anything until confirmation',async()=>{
  const f=dialogueFixture({guidance:true}),storage=memory(),options={...f,storage,identity};const m=new OnboardingDialogue(options);
  await m.load({fresh:true,template:{name:'采购合同知识仓',purpose:'整理合同，查询履约义务'}});assert.equal(m.saved.name,'采购合同知识仓');assert.equal(m.saved.purpose,'整理合同，查询履约义务');assert.equal(f.db.warehouses.length,0);assert.equal(f.db.generations,0);
  m.setName('部门合同仓');m.setPurpose('只整理当前合同');m.dispose();const next=new OnboardingDialogue(options);await next.load();assert.equal(next.saved.purpose,'只整理当前合同');await next.create();
  assert.equal(f.calls.find(c=>c.action==='onboarding-create').input.body.purpose,'只整理当前合同');assert.deepEqual(f.calls.find(c=>c.action==='onboarding-save').input.body.answers,{});assert.equal(f.db.generations,1);assert.equal(f.db.publishes,0);
});

test('only a successful warehouse listing can identify a missing warehouse, not an authorization error',async()=>{
  const f=dialogueFixture(),storage=memory(),options={...f,storage,identity},m=new OnboardingDialogue(options);await m.load();m.setName('原仓');await m.create();
  m.call=async()=>{throw Object.assign(Error(),{code:'MODELING_OWNER_REQUIRED',status:403});};await m.refresh();assert.notEqual(m.state.warehouseMissing,true);
  m.call=f.call;f.db.warehouses.length=0;await m.refresh();assert.equal(m.state.warehouseMissing,true);assert.equal(m.state.loaded,false);
});
