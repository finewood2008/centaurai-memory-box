import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingDialogue} from '../ui/onboarding-dialogue-state.mjs';
import {dialogueScopeHTML} from '../ui/onboarding-dialogue.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';
import {SemanticaService} from '../shell/service.mjs';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {dialogueFixture,identity,memory} from './fixtures/onboarding-dialogue.mjs';
function fixture(){const f=dialogueFixture(),storage=memory();let n=0;const model=()=>new OnboardingDialogue({...f,storage,identity,uuid:()=>`op-${++n}`});return {...f,storage,model};}
async function created(f){const m=f.model();await m.load();m.setName('研发人才库');await m.create();assert.equal(m.state.error,'');return m;}
async function ready(f){const m=await created(f);m.setInput('服务企业研发部门，用于人才匹配');await m.send();assert.equal(m.state.error,'');return m;}
const ids={warehouseId:'w',conversationId:'c'},send={...ids,operationId:'op',revision:0,draftDigest:'a'.repeat(64),content:'企业'};
test('registered onboarding routes preserve zero revision, identical operation IDs and long turn timeout',()=>{
  const req=conversationRequest('conversation-onboarding-send',send);assert.equal(req.path,'/warehouses/w/workbench/conversations/c/onboarding/turns');assert.equal(req.timeoutMs,285000);assert.equal(req.body.expected_revision,0);assert.equal(req.body.operation_id,req.body._native_operation_id);
  assert.equal(conversationRequest('conversation-onboarding-get',{...ids,offset:0,limit:20}).method,'GET');assert.equal(conversationRequest('conversation-onboarding-turn',{...ids,turnId:'t'}).path,'/warehouses/w/workbench/conversations/c/onboarding/turns/t');
  const p=conversationRequest('conversation-onboarding-preview',{...ids,operationId:'p',revision:1,draftDigest:'a'.repeat(64),name:'本体'});assert.equal(p.timeoutMs,45000);
  assert.throws(()=>conversationRequest('conversation-onboarding-send',{...send,editor:{}}));assert.throws(()=>conversationRequest('conversation-onboarding-send',{...send,revision:-1}));assert.throws(()=>conversationRequest('conversation-onboarding-send',{...send,content:'a'.repeat(8001)}));assert.throws(()=>conversationRequest('conversation-onboarding-get',{...ids,limit:51}));assert.throws(()=>conversationRequest('conversation-onboarding-publish',{...ids,operationId:'p',previewId:'pv',previewDigest:'a'.repeat(64),confirmed:false}));
  assert.equal(conversationRequest('conversation-create',{warehouseId:'w',operationId:'o'}).body.scenario,'material');assert.equal(conversationRequest('conversation-create',{warehouseId:'w',operationId:'o',scenario:'onboarding'}).body.scenario,'onboarding');
});
test('service forwards the registered route through Host with the 285s timeout',async()=>{
  let outgoing;const service=new SemanticaService({host:{context:async()=>identity,onSessionInvalidated:()=>()=>{},request:async(url,opts)=>{outgoing={url,opts};return new Response(JSON.stringify({status:'generating'}));}}});
  await service.call('conversation-onboarding-send',send);assert.match(outgoing.url,/\/api\/semantica\/warehouses\/w\/workbench\/conversations\/c\/onboarding\/turns$/);assert.equal(outgoing.opts.timeoutMs,285000);assert.equal(outgoing.opts.body.expected_revision,0);
});
test('name-only creation does not call a model; rounds update private scope and publish only after preview confirmation',async()=>{
  const f=fixture(),m=await created(f);assert.equal(f.db.generations,0);assert.equal(m.state.snapshot.draft.revision,0);assert.equal(f.calls.find(c=>c.action==='onboarding-create').input.body.purpose,'');assert.equal(f.db.sessions[0].scenario,'onboarding');
  for(let i=0;i<9;i++){m.setInput('第'+i+'轮，调整人才范围');await m.send();assert.equal(m.state.error,'');}
  assert.equal(m.state.snapshot.progress.round,9);assert.equal(f.db.publishes,0);await m.preview();assert.equal(m.state.page,'review');await m.publish();assert.equal(f.db.publishes,0);m.state.confirmed=true;await m.publish();assert.equal(f.db.publishes,1);assert.equal(f.entries.length,1);assert.equal(f.entries[0].r.ontology.id,'published');assert.equal(f.db.snapshots[m.saved.conversationId].publication.scope.questions_to_answer[0],'哪个人适合岗位');
});
for(const action of ['onboarding-save','onboarding-create','conversation-create','conversation-onboarding-send','conversation-onboarding-preview','conversation-onboarding-publish'])test('lost '+action+' response replays original body and never duplicates writes',async()=>{
  const f=fixture();let m;
  if(action.startsWith('conversation-onboarding-')){m=await ready(f);if(action.endsWith('publish')){await m.preview();m.state.confirmed=true;}}
  else {m=f.model();await m.load();m.setName('恢复测试仓');}
  f.db.lose=action;
  if(action.endsWith('send')){m.setInput('增加熟练程度');await m.send();}else if(action.endsWith('preview'))await m.preview();else if(action.endsWith('publish'))await m.publish();else await m.create();
  assert.equal(m.saved.pending?.action,action);const pending=structuredClone(m.saved.pending);m.dispose();m=f.model();await m.load();assert.equal(f.calls.filter(c=>c.action===action).length,action.endsWith('send')?2:1);
  await m.recover();assert.equal(m.state.error,'');assert.equal(m.saved.pending,null);const writes=f.calls.filter(c=>c.action===action);assert.deepEqual(writes.at(-1).input,pending.input);assert.equal(f.db.warehouses.length,1);assert.equal(f.db.sessions.length,1);assert.equal(f.db.generations,action.endsWith('send')?2:action.startsWith('conversation-onboarding-')?1:0);
});
test('failed HTTP200 turn preserves scope; only an explicit retry obtains a new operation ID',async()=>{
  const f=fixture(),m=await ready(f),before=m.state.snapshot.draft_digest;f.db.failTurn=true;m.setInput('错误输出');await m.send();assert.equal(m.saved.pending,null);assert.equal(m.state.snapshot.draft_digest,before);assert.equal(m.state.turns[0].status,'failed');const n=f.db.generations;await m.refresh();assert.equal(f.db.generations,n);m.setInput('重新调整');await m.send();assert.notEqual(f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-1).input.operationId,f.calls.filter(c=>c.action==='conversation-onboarding-send').at(-2).input.operationId);
});
test('polling reads pending generation, stops when idle, and never overwrites current scope from a historical turn',async()=>{
  const f=fixture(),m=await ready(f);const n=f.calls.length;await m.poll();assert.equal(f.calls.length,n);let finish;f.db.hold=new Promise(r=>{finish=r;});m.setInput('补充属性');const running=m.send();for(let i=0;i<15&&!m.inFlight;i++)await Promise.resolve();await m.poll();assert.equal(m.state.turns[0].status,'generating');const writes=f.calls.filter(c=>c.action==='conversation-onboarding-send').length;await m.poll();assert.equal(f.calls.filter(c=>c.action==='conversation-onboarding-send').length,writes);finish();await running;assert.equal(m.state.snapshot.draft.revision,2);assert.equal(m.generating,false);
});
test('changed digest invalidates preview and checkbox, and stale publication never submits',async()=>{
  const f=fixture(),m=await ready(f);await m.preview();m.state.confirmed=true;f.db.snapshots[m.saved.conversationId].draft_digest='d'.repeat(64);await m.publish();assert.equal(f.db.publishes,0);assert.equal(m.saved.preview,null);assert.equal(m.state.confirmed,false);
});
test('continuing natural language changes clears previous preview and reload never restores confirmation',async()=>{
  const f=fixture();let m=await ready(f);await m.preview();m.state.confirmed=true;m.dispose();m=f.model();await m.load();assert.equal(m.state.page,'review');assert.equal(m.state.confirmed,false);m.setInput('合并人员类型');await m.send();assert.equal(m.saved.preview,null);assert.equal(m.state.page,'chat');
});
test('replaced publication cannot auto-enter but explicitly entering reads actual current rules',async()=>{
  const f=fixture(),m=await ready(f);await m.preview();m.state.confirmed=true;f.db.lose='conversation-onboarding-publish';await m.publish();const s=f.db.snapshots[m.saved.conversationId];s.publication_effective=false;f.db.current='replacement';await m.recover();assert.equal(f.entries.length,0);assert.equal(m.state.errorCode,'MODELING_PUBLICATION_REPLACED');await m.enter();assert.equal(f.entries[0].r.ontology.id,'replacement');
});
test('account scope and disposal isolate delayed writes; storage failure prevents transport',async()=>{
  const f=fixture(),m=await created(f);const other=new OnboardingDialogue({...f,storage:f.storage,identity:{...identity,accountId:'other'}});await other.load();assert.equal(other.saved.warehouse,null);
  f.storage.setItem=()=>{throw Error('disk');};m.setInput('调整');const n=f.db.generations;await m.send();assert.equal(f.db.generations,n);assert.equal(m.state.errorCode,'MODELING_LOCAL_SAVE_FAILED');
});
test('a new session uses current server scope; former sessions remain discoverable',async()=>{
  const f=fixture(),m=await ready(f),old=m.saved.conversationId;await m.newSession();assert.notEqual(m.saved.conversationId,old);assert.equal(m.state.turns.length,0);await m.chooseSession(old);assert.equal(m.state.snapshot.draft.revision,1);
});
test('scope UI keeps business questions, excluded and uncertain fields separate and escapes markup',()=>{
  const html=dialogueScopeHTML({questions_to_answer:['哪个人适合岗位'],excluded_scope:['<script>'],uncertain_items:['评分规则']});assert.match(html,/希望回答的业务问题/);assert.match(html,/评分规则/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('unsent edits block preview and publication instead of silently ignoring the input',async()=>{
  const f=fixture(),m=await ready(f);m.setInput('排除价格');await m.preview();assert.equal(m.state.errorCode,'MODELING_UNSENT_ANSWER');assert.equal(m.saved.preview,null);m.setInput('');await m.preview();m.state.confirmed=true;m.setInput('还有修改');await m.publish();assert.equal(f.db.publishes,0);assert.equal(m.state.errorCode,'MODELING_UNSENT_ANSWER');
});
test('starting fresh cannot discard an unresolved creation request',async()=>{
  const f=fixture();let m=f.model();await m.load();m.setName('不可丢失的建仓');f.db.lose='onboarding-create';await m.create();const pending=structuredClone(m.saved.pending);m.dispose();m=f.model();await m.load({fresh:true});assert.equal(m.state.errorCode,'MODELING_REQUEST_PENDING');assert.deepEqual(m.saved.pending,pending);await m.recover();assert.equal(m.state.error,'');assert.equal(f.db.warehouses.length,1);
});
test('permission changes prevent replay and clear old visible scope',async()=>{
  const f=fixture(),m=await ready(f);f.db.lose='conversation-onboarding-send';m.setInput('修改范围');await m.send();const count=f.db.generations;f.db.warehouses=[];await m.recover();assert.equal(f.db.generations,count);assert.equal(m.state.loaded,false);assert.equal(m.state.snapshot,null);assert.equal(m.saved.pending.action,'conversation-onboarding-send');
});
test('disposing an in-flight dialogue retains recovery without consuming late responses',async()=>{
  const f=fixture(),m=await created(f);let release;f.db.hold=new Promise(r=>{release=r;});m.setInput('增加技能');const running=m.send();for(let i=0;i<20&&!m.inFlight;i++)await Promise.resolve();assert.equal(m.inFlight,'conversation-onboarding-send');m.dispose();release();await running;assert.equal(m.state.snapshot,null);assert.equal(m.saved.pending.action,'conversation-onboarding-send');const next=f.model();await next.load();await next.recover();assert.equal(f.db.generations,1);assert.equal(next.state.snapshot.draft.revision,1);
});
test('corrupted cached preview content cannot be confirmed against a matching digest',async()=>{
  const f=fixture(),m=await ready(f);await m.preview();m.saved.preview.scope.purposes=['错误缓存'];m.persist();m.dispose();const next=f.model();await next.load();assert.equal(next.saved.preview,null);assert.equal(next.state.confirmed,false);
});
test('definite warehouse name conflict allows correcting the name instead of trapping recovery',async()=>{
  const f=fixture(),m=f.model();await m.load();m.setName('重复仓名');f.db.refuse='onboarding-create';f.db.refuseCode='WAREHOUSE_NAME_CONFLICT';await m.create();assert.equal(m.saved.pending,null);assert.equal(m.saved.creation,null);assert.equal(f.db.warehouses.length,0);m.setName('修正后的仓名');f.db.refuse=null;await m.create();assert.equal(m.state.error,'');assert.equal(f.db.warehouses[0].name,'修正后的仓名');
});
test('operation conflicts retain the original request and cannot be replaced with a new model operation',async()=>{
  const f=fixture(),m=await ready(f);f.db.refuse='conversation-onboarding-send';f.db.refuseCode='MODELING_OPERATION_CONFLICT';m.setInput('请求冲突');await m.send();const pending=structuredClone(m.saved.pending),n=f.db.generations;assert.ok(pending);await m.send();assert.deepEqual(m.saved.pending,pending);assert.equal(f.db.generations,n);
});
test('material listing skips onboarding-only pages before selecting an existing material conversation',async()=>{
  const calls=[];const m=new ConversationFlow({identity,warehouseId:'w',storage:memory(),call:async(a,i)=>{calls.push({a,i});if(a==='conversation-list')return i.offset===0?{items:[{id:'ob',scenario:'onboarding'}],has_more:true,next_offset:20}:{items:[{id:'mat',scenario:'material',status:'active'}],has_more:false};throw Error(a);}});
  await m.list();assert.deepEqual(m.state.conversations.map(c=>c.id),['mat']);assert.equal(calls.length,2);assert.equal(calls[1].i.offset,20);
});


test('a failed preflight read leaves the name editable without a pending creation',async()=>{
  const f=fixture(),m=f.model();
  await m.load();m.setName('待创建的仓');
  const original=m.call;
  m.call=(action,input)=>action==='onboarding-read'
    ?Promise.reject(Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'})):original(action,input);
  await m.create();
  assert.equal(m.saved.creation,null);assert.equal(m.saved.pending,null);
  assert.equal(f.calls.some(c=>c.action==='onboarding-create'),false);
  m.setName('修改后的仓');m.call=original;await m.create();
  assert.equal(f.db.warehouses[0].name,'修改后的仓');
});

test('range calibration can publish only with the current ontology and no rule changes', async () => {
  const f=fixture(),m=await ready(f);
  m.saved.setupMode='update';
  await m.preview();
  assert.equal(m.state.page,'review');
  assert.equal(m.scopePublicationAllowed,false);
  m.state.confirmed=true;
  await m.publish();
  assert.equal(m.state.errorCode,'MODELING_SCOPE_RULE_CHANGE');
  assert.equal(f.db.publishes,0);

  const draft=f.db.snapshots[m.saved.conversationId].draft;
  draft.changes=[];
  await m.preview();
  assert.equal(m.scopePublicationAllowed,false,'an empty diff cannot bypass the schema comparison');
  m.saved.pending={
    action:'conversation-onboarding-publish',
    input:{...m.ids(),operationId:'old-confirm',previewId:m.saved.preview.resource_id,
      previewDigest:m.saved.preview.preview_digest,confirmed:true},
  };
  await m.recover();
  assert.equal(m.saved.pending,null);
  assert.equal(f.db.publishes,0);

  const {items:[base]}=await f.call('conversation-ontologies');
  draft.schema=base.schema;
  await m.preview();
  assert.equal(m.scopePublicationAllowed,true);
  m.state.confirmed=true;
  await m.publish();
  assert.equal(f.db.publishes,1);
  assert.equal(f.db.current,base.id);
});
