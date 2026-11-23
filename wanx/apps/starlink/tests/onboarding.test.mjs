import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingFlow, samples, validation, proposalFailure, currentRuleReview, ruleProposalId, messageFor} from '../ui/onboarding-state.mjs';
import {onboardingRequest, identityKey} from '../shared/onboarding-contract.mjs';
import {SemanticaService} from '../shell/service.mjs';
import {workbenchErrorReply} from '../shell/workbench-errors.mjs';
import {readWorkbenchReply} from '../ui/native-workbench.js';

const identity={accountId:'account-a',boxId:'box-a',user:{id:1,name:'测试用户'},dataScope:'personal'};
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};};
test('failed model receipts show a safe actionable reason without exposing backend messages',()=>{
  assert.match(messageFor({code:'MODELING_RULE_CLARIFICATION_REQUIRED'}),/尚未提供可采用的本体/);
  const receipt={status:'failed',error_code:'MODEL_AUTH_REQUIRED',message:'private upstream diagnostic'};
  assert.match(proposalFailure(receipt),/模型调用授权未通过/);
  assert.doesNotMatch(proposalFailure(receipt),/private upstream/);
  assert.match(proposalFailure({...receipt,error_code:'UNKNOWN_PRIVATE_CODE'}),/建议生成失败/);
  assert.match(proposalFailure({...receipt,error_code:'ONTOLOGY_INVALID_OUTPUT'}),/输出被截断或格式无效/);
  assert.match(proposalFailure({...receipt,error_code:'ONTOLOGY_MODEL_TIMEOUT'}),/模型生成超时/);
  assert.equal(proposalFailure({...receipt,status:'succeeded'}),'');
});
const error=(code,status=0)=>Object.assign(new Error('private diagnostic'),{code,status});
function fixture(storage=memory(), actor=identity) {
  const calls=[], receipts=new Map(); let counter=0;
  const backend={record:{id:null,revision:0,status:'not_started',answers:{},created_workspace_id:null},items:[],context:null,proposal:null,lose:null,fail:null};
  const call=async(action,input)=>{
    calls.push({action,input:structuredClone(input)});
    if(backend.fail===action) throw error('MODELING_REVISION_CHANGED',409);
    if(action==='onboarding-read') return structuredClone(backend.record);
    if(action==='onboarding-warehouses') return {items:structuredClone(backend.items)};
    if(action==='onboarding-context') return structuredClone({...backend.context,proposal:backend.proposal});
    if(action==='onboarding-suggestion') return structuredClone(backend.proposal);
    const b=input.body;
    let result=receipts.get(b.operation_id);
    if(!result) {
      if(action==='onboarding-save') {
        backend.record={id:'onboarding-a',revision:backend.record.revision+1,status:b.status,answers:b.answers,created_workspace_id:null};
        result={resource_id:backend.record.id,revision:backend.record.revision,onboarding:structuredClone(backend.record)};
      } else if(action==='onboarding-create') {
        if(backend.items.some(w=>w.name===b.name)) throw error('WAREHOUSE_NAME_CONFLICT',409);
        const warehouse={id:'warehouse-a',workspace_id:'derived-workspace-a',name:b.name,state:'active'};
        backend.items.push(warehouse);backend.record.status='completed';backend.record.revision++;backend.record.created_workspace_id=warehouse.workspace_id;
        backend.context={answers:Object.fromEntries(['industry','occupation','background','purpose','material_types','questions'].map(k=>[k,backend.record.answers[k]||''])),
          purpose_revision:1,onboarding_revision:backend.record.revision,base_ontology_id:'ontology-a',latest_confirmation_id:null,confirmation:null,proposal:null};
        result={resource_id:warehouse.id,warehouse,status:'created',revision:backend.record.revision};
      } else if(action==='onboarding-confirm') {
        backend.context.confirmation={id:'confirmation-a',answers:b.answers};backend.context.latest_confirmation_id='confirmation-a';
        result={resource_id:'confirmation-a',confirmation:backend.context.confirmation};
      } else if(action==='onboarding-generate') {
        backend.proposal={id:'suggestion-a',status:'succeeded',valid:true,confirmation_id:b.confirmation_id,base_ontology_id:b.base_ontology_id,result:{proposals:[{kind:'entity',label:'合同'}]}};
        result=backend.proposal;
      } else throw Error('unexpected action '+action);
      receipts.set(b.operation_id,structuredClone(result));
    }
    if(backend.lose===action) {backend.lose=null;throw error('SEMANTICA_CONNECTION_FAILED');}
    return structuredClone(result);
  };
  const make=(opts={})=>new OnboardingFlow({call,storage,identity:actor,uuid:()=>`op-${++counter}`,...opts});
  return {backend,calls,storage,call,flow:make(),make};
}
async function prepared(f) {await f.flow.load();f.flow.applySample(samples[0]);f.flow.step('confirm');}

test('authoritative unresolved questions recover after failure, clear after ready, and never block a retry',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});
  f.backend.proposal={...f.backend.proposal,status:'failed',valid:false,can_review:false,unresolved_questions:['回执问题']};
  f.backend.context.unresolved_questions=['当前问题'];
  f.flow=f.make();await f.flow.load();
  assert.deepEqual(f.flow.state.reviewQuestions,['当前问题']);assert.equal(f.flow.state.ruleProposalId,null);
  const before=f.calls.filter(c=>c.action==='onboarding-generate').length;
  await f.flow.generate();
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,before+1);
  assert.deepEqual(f.flow.state.reviewQuestions,[],'Legacy successful receipts also replace previous failed question notes');
  f.flow.acceptProposal({...f.backend.proposal,status:'succeeded',valid:true,can_review:true,unresolved_questions:[],
    result:{outcome:'ready',suggestions:[{kind:'entity',name:'CASE'}],questions:[]}});
  assert.deepEqual(f.flow.state.reviewQuestions,[]);assert.deepEqual(f.flow.state.context.unresolved_questions,[]);
});

test('explicit server review denial blocks new review but preserves a matching saved draft',()=>{
  const p={id:'p',status:'succeeded',valid:true,can_review:false,result:{outcome:'needs_clarification',questions:['用途？'],suggestions:[{kind:'entity',name:'CASE'}]}};
  assert.equal(ruleProposalId({},p),null);
  assert.equal(ruleProposalId({rule_review:{id:'draft',proposal_id:'p'}},p),'p');
  assert.equal(ruleProposalId({rule_review:{id:'draft',proposal_id:'other'}},p),null);
});

test('clarification survives refresh and edited answers use latest revisions and new operation ids',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});
  const first=f.calls.find(c=>c.action==='onboarding-generate').input.body.operation_id;
  f.backend.proposal.result={outcome:'needs_clarification',questions:['合同和病例的用途是什么？'],explanation:'需澄清',suggestions:[{kind:'entity',name:'CASE'}]};
  await f.flow.refresh();assert.equal(f.flow.state.ruleProposalId,'suggestion-a');
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.ruleProposalId,'suggestion-a');
  await f.flow.editAnswers();f.flow.updateAnswer('purpose','只管理病例，查询历史病情');
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.answerEdit.answers.purpose,'只管理病例，查询历史病情');
  await f.flow.submitAnswers();
  const confirm=f.calls.filter(c=>c.action==='onboarding-confirm').at(-1);
  assert.equal(confirm.input.body.answers.purpose,'只管理病例，查询历史病情');
  assert.equal(confirm.input.body.expected_confirmation_id,'confirmation-a');
  assert.equal(confirm.input.body.expected_revision,1);
  assert.equal(f.calls.at(-3).action,'onboarding-suggestion');
  assert.notEqual(f.calls.at(-1).input.body.operation_id,first);
  assert.equal(f.flow.state.answerEdit,null);assert.equal(f.flow.state.ruleProposalId,'suggestion-a');
});

test('answer editing detects concurrent revision updates and does not overwrite before review',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});await f.flow.editAnswers();
  f.flow.updateAnswer('purpose','我的补充');f.backend.context.purpose_revision++;
  const writes=f.calls.filter(c=>c.input.body).length;await f.flow.submitAnswers();
  assert.equal(f.calls.filter(c=>c.input.body).length,writes);assert.equal(f.flow.state.needsReview,true);
  assert.equal(f.flow.state.answerEdit.answers.purpose,'我的补充');
  await f.flow.submitAnswers();assert.equal(f.calls.filter(c=>c.action==='onboarding-confirm').at(-1).input.body.expected_revision,2);
});

test('legacy clarification does not require edited answers before retrying generation',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});
  f.backend.proposal.result={outcome:'needs_clarification',questions:['合同是否纳入本仓？'],suggestions:[]};
  await f.flow.refresh();const generated=f.calls.filter(c=>c.action==='onboarding-generate');
  await f.flow.generate();
  const next=f.calls.filter(c=>c.action==='onboarding-generate');
  assert.equal(next.length,generated.length+1);
  assert.notEqual(next.at(-1).input.body.operation_id,generated.at(-1).input.body.operation_id);
  assert.equal(f.flow.state.error,'');
});

test('clarification does not block replay of an uncertain edited generation',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});
  f.backend.proposal.result={outcome:'needs_clarification',questions:['合同是否纳入本仓？'],suggestions:[]};
  await f.flow.refresh();const old=structuredClone(f.backend.proposal);
  await f.flow.editAnswers();f.flow.updateAnswer('purpose','只纳入采购合同');
  f.backend.lose='onboarding-generate';await f.flow.submitAnswers();const pending=structuredClone(f.flow.state.pending);
  f.backend.proposal=old;f.flow=f.make();await f.flow.load();
  await f.flow.generate();assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-generate').at(-1).input,pending.input);
  assert.equal(f.flow.state.pending,null);assert.equal(f.flow.state.ruleProposalId,'suggestion-a');
});

test('lost edited confirmation replays the same body and operation after refresh',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});await f.flow.editAnswers();
  f.flow.updateAnswer('purpose','明确用于病例');f.backend.lose='onboarding-confirm';await f.flow.submitAnswers();
  const pending=structuredClone(f.flow.state.pending);
  f.backend.proposal.status='stale';f.backend.proposal.valid=false;
  f.flow=f.make();await f.flow.load();f.flow.updateAnswer('purpose','不可改变待恢复请求');
  assert.equal(f.flow.state.answerEdit.answers.purpose,'明确用于病例');
  await f.flow.submitAnswers();
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-confirm').at(-1).input,pending.input);
  assert.equal(f.flow.state.pending,null);assert.equal(f.flow.state.answerEdit,null);
});

test('an older result cannot consume a newer uncertain generation envelope',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});
  const old=structuredClone(f.backend.proposal);
  f.backend.lose='onboarding-generate';await f.flow.generate();
  const pending=structuredClone(f.flow.state.pending);
  f.backend.proposal=old;f.flow=f.make();await f.flow.load();
  assert.deepEqual(f.flow.state.pending,pending);
  await f.flow.generate();
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-generate').at(-1).input,pending.input);
  assert.equal(f.flow.state.pending,null);
});

test('new edited generation response loss can replay after old suggestion becomes stale',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});await f.flow.editAnswers();
  f.flow.updateAnswer('purpose','已澄清用途');f.backend.lose='onboarding-generate';await f.flow.submitAnswers();
  const pending=structuredClone(f.flow.state.pending);
  f.backend.proposal.status='stale';f.backend.proposal.valid=false;
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.needsReview,true);
  await f.flow.generate();assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-generate').at(-1).input,pending.input);
  assert.equal(f.flow.state.pending,null);assert.equal(f.flow.state.proposal.status,'succeeded');
});

test('empty legacy proposals allow only existing human drafts or publication receipts to resume',()=>{
  const proposal={id:'p',status:'succeeded',valid:true,result:{suggestions:[]}};
  assert.equal(ruleProposalId({},proposal),null);
  assert.equal(ruleProposalId({rule_review:{proposal_id:'p',id:'saved-draft'}},proposal),'p');
  assert.equal(ruleProposalId({rule_review:{proposal_id:'p',publication:{status:'published'}}},proposal),'p');
  assert.equal(ruleProposalId({rule_review:{proposal_id:'other',id:'old'}},proposal),null);
});

test('failed refresh locks cached submissions until current roots and context load',async()=>{
  const f=fixture();await prepared(f);
  f.backend.fail='onboarding-read';await f.flow.refresh();assert.equal(f.flow.state.loaded,false);
  const before=f.calls.length;await f.flow.create({generate:true});await f.flow.generate();
  assert.equal(f.calls.length,before);
  f.backend.fail=null;await f.flow.refresh();assert.equal(f.flow.state.loaded,true);
  await f.flow.reviewAgain();f.flow.applySample(samples[0]);await f.flow.create();
  f.backend.fail='onboarding-context';await f.flow.refresh();assert.equal(f.flow.state.loaded,false);
  const after=f.calls.length;await f.flow.generate();assert.equal(f.calls.length,after);
  f.backend.fail=null;await f.flow.refresh();assert.equal(f.flow.state.loaded,true);
});

test('starting a new warehouse does not inherit an old proposal review conflict',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();await f.flow.generate();
  f.backend.proposal.status='stale';f.backend.proposal.valid=false;await f.flow.refresh();
  assert.equal(f.flow.state.needsReview,true);
  f.flow.begin();assert.equal(f.flow.state.warehouse,null);assert.equal(f.flow.state.needsReview,false);
});

test('confirmed creation automatically confirms answers and generates once without publishing',async()=>{
  const f=fixture();await prepared(f);
  await Promise.all([f.flow.create({generate:true}),f.flow.create({generate:true})]);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
  assert.equal(f.flow.state.proposal.valid,true);
  assert.equal(f.calls.some(c=>c.action==='onboarding-rule-publish'),false);
  await f.flow.refresh();assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
});

test('automatic generation response loss keeps warehouse and recovers without another model request',async()=>{
  const f=fixture();await prepared(f);f.backend.lose='onboarding-generate';await f.flow.create({generate:true});
  assert.equal(f.backend.items.length,1);assert.equal(f.flow.state.pending.action,'onboarding-generate');
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.proposal.valid,true);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
});

test('submitted form resumes its scoped generation after a lost response without starting a dialogue',async()=>{
  const f=fixture();
  await prepared(f);await f.flow.create();
  const warehouse=f.backend.items[0], make=()=>f.make({warehouseId:warehouse.id});
  f.backend.context.answers.background='已保存在本仓的背景';
  f.backend.lose='onboarding-generate';
  const start=f.calls.length;
  const flow=make();
  await flow.openSuggestions(warehouse,true);
  assert.equal(flow.state.pending.action,'onboarding-generate');
  assert.equal(f.calls.find(c=>c.action==='onboarding-confirm').input.body.answers.background,'已保存在本仓的背景');
  flow.reset();
  const reopened=make();
  await reopened.openSuggestions(warehouse,true);
  assert.equal(reopened.state.pending,null);
  assert.equal(reopened.state.proposal.valid,true);
  assert.deepEqual(f.calls.slice(start).map(c=>c.action),['onboarding-context','onboarding-confirm','onboarding-generate','onboarding-context','onboarding-suggestion']);
});

test('reopening a changed warehouse or browsing its suggestions waits for an explicit generation',async()=>{
  const f=fixture();
  await prepared(f);await f.flow.create();
  const warehouse=f.backend.items[0], flow=f.make({warehouseId:warehouse.id});
  await flow.openSuggestions(warehouse);
  f.backend.context.purpose_revision++;
  await flow.openSuggestions(warehouse,true);
  assert.equal(f.calls.some(c=>c.action==='onboarding-confirm'),false);
  await flow.generate();
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
});

test('automatic generation stops on changed answers, revisions or concurrent confirmation',async()=>{
  for(const change of [
    c=>{c.answers.background='Changed elsewhere';},
    c=>{c.onboarding_revision++;},
    c=>{c.purpose_revision++;},
    c=>{c.latest_confirmation_id='another-confirmation';},
  ]) {
    const f=fixture();let changed=false;
    f.flow=f.make({call:async(action,input)=>{
      const result=await f.call(action,input);
      if(action==='onboarding-context'&&!changed){changed=true;change(f.backend.context);return structuredClone(f.backend.context);}
      return result;
    }});
    await prepared(f);await f.flow.create({generate:true});
    assert.equal(f.backend.items.length,1);assert.equal(f.flow.state.needsReview,true);
    assert.equal(f.calls.some(c=>['onboarding-confirm','onboarding-generate'].includes(c.action)),false);
    await f.flow.refresh();assert.equal(f.flow.state.needsReview,true);
    await f.flow.reviewAgain();
    assert.equal(f.calls.some(c=>c.action==='onboarding-generate'),false);
    await f.flow.generate();assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
  }
});

test('new proposal takes priority over an older published rule batch',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();await f.flow.generate();
  f.backend.context.rule_review={proposal_id:'old-proposal',publication:{status:'published'}};
  await f.flow.refresh();
  assert.equal(f.flow.state.ruleProposalId,'suggestion-a');
  assert.equal(currentRuleReview(f.flow.state.context,f.flow.state.proposal),null);
  f.backend.context.rule_review.proposal_id='suggestion-a';
  f.backend.proposal={...f.backend.proposal,status:'stale',valid:false};
  await f.flow.refresh();
  assert.equal(currentRuleReview(f.flow.state.context,f.flow.state.proposal).publication.status,'published');
  assert.equal(f.flow.state.needsReview,false);
});

test('existing warehouse review resumes after starting another warehouse and reloading without writes',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();await f.flow.generate();
  f.flow.begin();f.flow.update('warehouse_name','Second warehouse');
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.warehouse,null);
  const writes=f.calls.filter(c=>c.input.body).length;
  await f.flow.resume('warehouse-a');
  assert.equal(f.flow.state.warehouse.id,'warehouse-a');assert.equal(f.flow.state.step,'result');
  assert.equal(f.flow.state.ruleProposalId,'suggestion-a');
  assert.equal(f.calls.filter(c=>c.input.body).length,writes);
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.warehouse.id,'warehouse-a');
});

test('resume cannot switch away from an uncertain write or open another account warehouse',async()=>{
  const f=fixture();await prepared(f);f.backend.lose='onboarding-save';await f.flow.create();
  const pending=structuredClone(f.flow.state.pending);await f.flow.resume('other');
  assert.deepEqual(f.flow.state.pending,pending);
  const isolated=fixture();await isolated.flow.load();await isolated.flow.resume('warehouse-a');
  assert.equal(isolated.flow.state.warehouse,null);assert.ok(isolated.flow.state.error);
});

test('normal creation respects all eight routes and only generates after explicit answer confirmation',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();
  assert.equal(f.flow.state.warehouse.id,'warehouse-a');
  assert.equal(f.calls.some(c=>c.action==='onboarding-confirm'),false);
  await f.flow.generate();await f.flow.refresh();
  assert.equal(f.flow.state.proposal.valid,true);
  assert.deepEqual([...new Set(f.calls.map(c=>c.action))],['onboarding-read','onboarding-warehouses','onboarding-save','onboarding-create','onboarding-context','onboarding-confirm','onboarding-generate','onboarding-suggestion']);
  assert.equal(f.calls.find(c=>c.action==='onboarding-confirm').input.body.onboarding_revision,2);
  assert.equal(f.calls.find(c=>c.action==='onboarding-context').input.warehouseId,'warehouse-a');
  assert.equal(f.calls.some(c=>/publish|upload|draft/.test(c.action)),false);
});
test('double click makes only one creation and one model request',async()=>{
  const f=fixture();await prepared(f);
  await Promise.all([f.flow.create(),f.flow.create()]);
  await Promise.all([f.flow.generate(),f.flow.generate()]);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-create').length,1);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
});
test('lost save response retries the identical complete request even after reload',async()=>{
  const f=fixture();await prepared(f);f.backend.lose='onboarding-save';await f.flow.create();
  const original=f.calls.find(c=>c.action==='onboarding-save').input;
  f.flow=f.make();await f.flow.load();
  assert.equal(f.calls.filter(c=>c.action==='onboarding-save').length,1);
  f.flow.update('purpose','changed');await f.flow.create();
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-save')[1].input,original);
  assert.equal(f.backend.items.length,1);
});
test('lost creation response is recovered from server onboarding and warehouse identity without another write',async()=>{
  const f=fixture();await prepared(f);f.backend.lose='onboarding-create';await f.flow.create();
  assert.equal(f.flow.state.pending.action,'onboarding-create');
  const writes=f.calls.filter(c=>c.input.body).length;
  f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.warehouse.id,'warehouse-a');assert.equal(f.flow.state.pending,null);
  assert.equal(f.calls.filter(c=>c.input.body).length,writes);
});
test('lost suggestion response recovers a valid proposal without repeating inference',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();f.backend.lose='onboarding-generate';await f.flow.generate();
  assert.equal(f.flow.state.pending.action,'onboarding-generate');
  f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.proposal.valid,true);assert.equal(f.flow.state.pending,null);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,1);
});
test('HTTP 200 failed suggestion is not success and never removes the warehouse',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();await f.flow.generate();
  f.backend.proposal={...f.backend.proposal,status:'failed',valid:false};await f.flow.refresh();
  assert.equal(f.flow.state.proposal.valid,false);assert.equal(f.flow.state.warehouse.id,'warehouse-a');
  assert.equal(f.backend.items.length,1);
});
test('server name conflict retains editable answers and requires a new operation for changed name',async()=>{
  const f=fixture();await prepared(f);f.backend.items.push({id:'other',name:samples[0].warehouse_name,state:'active'});
  await f.flow.create();const old=f.calls.find(c=>c.action==='onboarding-create').input.body.operation_id;
  assert.equal(f.flow.state.pending,null);assert.equal(f.flow.state.answers.industry,samples[0].industry);
  f.flow.update('warehouse_name','另一个知识仓');await f.flow.create();
  const next=f.calls.filter(c=>c.action==='onboarding-create')[1].input.body.operation_id;
  assert.notEqual(old,next);assert.equal(f.flow.state.warehouse.name,'另一个知识仓');
});
test('storage failure blocks a write, and malformed pending state never submits',async()=>{
  const f=fixture();await prepared(f);f.storage.setItem=()=>{throw Error('full');};await f.flow.create();
  assert.equal(f.calls.some(c=>c.input.body),false);assert.match(f.flow.state.error,/无法保存/);
  const bad=fixture({getItem:()=>'{broken',setItem:()=>{}});await bad.flow.load();
  assert.match(bad.flow.state.error,/恢复记录/);assert.equal(bad.calls.length,0);
});
test('different account or box cannot read the previous draft or pending request',async()=>{
  const f=fixture();await prepared(f);f.backend.lose='onboarding-save';await f.flow.create();
  for(const actor of [{...identity,user:{id:2}},{...identity,boxId:'box-b'},{...identity,accountId:'account-b'}]) {
    const other=fixture(f.storage,actor);await other.flow.load();
    assert.equal(other.flow.state.pending,null);assert.equal(other.flow.state.answers.industry,'');
    assert.notEqual(identityKey(actor),identityKey(identity));
  }
});
test('invalidation while reads are pending never installs old answers',async()=>{
  let finish;const f=fixture();const slow=f.make({call:()=>new Promise(resolve=>{finish=resolve;})});
  const read=slow.read('onboarding-read');slow.reset();finish({answers:{industry:'old'}});
  await assert.rejects(read,e=>e.code==='HOST_SESSION_EXPIRED');assert.equal(slow.state.record,null);
});
test('version conflict requires explicit re-reading rather than silently overwriting',async()=>{
  const f=fixture();await prepared(f);f.backend.fail='onboarding-save';await f.flow.create();
  assert.equal(f.flow.state.needsReview,true);const count=f.calls.length;
  await f.flow.create();assert.equal(f.calls.length,count);
  f.backend.fail=null;await f.flow.reviewAgain();assert.equal(f.flow.state.needsReview,false);
});
test('design length, required fields and normalized duplicate-name validation',()=>{
  assert.match(validation({...samples[0],industry:''},[]),/行业/);
  assert.match(validation({...samples[0],warehouse_name:'x'},[],true),/2–30/);
  assert.match(validation({...samples[0],warehouse_name:' ＡＢ '},[{name:'ab'}],true),/同名/);
});

test('cached creation cannot replay until bootstrap reads have succeeded',async()=>{
  const f=fixture();await prepared(f);
  const base=f.flow.call;
  f.flow.call=(action,input)=>action==='onboarding-create'?Promise.reject(error('SEMANTICA_CONNECTION_FAILED')):base(action,input);
  await f.flow.create();assert.equal(f.flow.state.pending.action,'onboarding-create');
  f.flow=f.make({call:(action,input)=>action==='onboarding-read'?Promise.reject(error('SEMANTICA_CONNECTION_FAILED')):base(action,input)});
  await f.flow.load();assert.equal(f.flow.state.loaded,false);
  await f.flow.create();assert.equal(f.backend.items.length,0);
});
test('definitely rejected input can be reviewed and edited without replaying a rejected envelope forever',async()=>{
  const f=fixture();await prepared(f);
  f.flow.call=(action,input)=>action==='onboarding-create'?Promise.reject(error('MODELING_INVALID_REQUEST',422)):f.call(action,input);
  await f.flow.create();assert.equal(f.flow.state.pending,null);assert.equal(f.flow.state.creation,null);
  assert.equal(f.flow.state.needsReview,true);assert.equal(f.flow.state.answers.industry,samples[0].industry);
  await f.flow.refresh();assert.equal(f.flow.state.needsReview,true);
  await f.flow.reviewAgain();f.flow.update('warehouse_name','修改后的仓');
  assert.equal(f.flow.state.answers.warehouse_name,'修改后的仓');
});
test('a removed previously created warehouse cannot trap all future onboarding loads',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();f.backend.items=[];
  f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.loaded,true);assert.equal(f.flow.state.warehouse,null);assert.equal(f.flow.state.step,'welcome');
  f.flow.begin();assert.equal(f.flow.state.step,'details');
  for(const field of ['material_types','purpose','questions','warehouse_name'])assert.equal(f.flow.state.answers[field],'');
  for(const field of ['industry','occupation'])assert.equal(f.flow.state.answers[field],samples[0][field]);
  assert.equal(f.flow.state.notice,'');
  f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.answers.material_types,'');assert.equal(f.flow.state.answers.purpose,'');
});

test('explicit new warehouse clears cached purpose even when no warehouse is selected',async()=>{
  const f=fixture();await prepared(f);f.flow.update('questions','上一个仓的问题');
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.answers.material_types,samples[0].material_types);
  f.flow.begin();
  for(const key of ['material_types','purpose','questions','warehouse_name'])assert.equal(f.flow.state.answers[key],'');
  assert.equal(f.flow.state.answers.background,'');
});

test('removed background cannot be injected into a new warehouse or confirmation',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});await f.flow.editAnswers();
  f.flow.updateAnswer('background','新的个人背景');f.flow.updateAnswer('purpose','本仓独有用途');
  await f.flow.submitAnswers();
  f.flow=f.make();await f.flow.load();f.flow.begin();
  assert.equal(f.flow.state.answers.background,'');
  assert.equal(f.calls.filter(c=>c.action==='onboarding-confirm').at(-1).input.body.answers.background,'');
  for(const key of ['purpose','material_types','questions','warehouse_name'])assert.equal(f.flow.state.answers[key],'');
});

test('completed server record seeds only personal fields and review does not restore deleted warehouse purpose',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();f.backend.items=[];
  f.storage.setItem(f.flow.key,'');f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.answers.background,'');
  assert.equal(f.flow.state.answers.material_types,'');
  await f.flow.reviewAgain();assert.equal(f.flow.state.answers.purpose,'');
  assert.equal(f.flow.state.answers.warehouse_name,'');
});

test('failed local confirmation commit preserves its original request and edit for replay',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});await f.flow.editAnswers();
  f.flow.updateAnswer('occupation','确认后的职业');
  const save=f.storage.setItem;let failCommit=true;
  f.storage.setItem=(key,raw)=>{
    const value=JSON.parse(raw);
    if(failCommit && !value.pending && !value.answerEdit && value.answers.occupation==='确认后的职业'){
      failCommit=false;throw Error('storage unavailable');
    }
    save(key,raw);
  };
  const generated=f.calls.filter(c=>c.action==='onboarding-generate').length;
  await f.flow.submitAnswers();
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,generated);
  assert.equal(f.flow.state.pending.action,'onboarding-confirm');
  assert.equal(f.flow.state.answerEdit.answers.occupation,'确认后的职业');
  const pending=structuredClone(f.flow.state.pending);
  f.flow=f.make();await f.flow.load();await f.flow.submitAnswers();
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-confirm').at(-1).input,pending.input);
  assert.equal(f.flow.state.pending,null);assert.equal(f.flow.state.answers.occupation,'确认后的职业');
});

test('new warehouse intent cannot erase an uncertain creation request',async()=>{
  const f=fixture();await prepared(f);f.backend.lose='onboarding-create';await f.flow.create();
  const pending=structuredClone(f.flow.state.pending),answers=structuredClone(f.flow.state.answers);
  f.flow.begin();assert.deepEqual(f.flow.state.pending,pending);assert.deepEqual(f.flow.state.answers,answers);
  assert.equal(f.flow.state.step,'confirm');
});

test('newer confirmed background can be analyzed without another text edit',async()=>{
  const f=fixture();await prepared(f);await f.flow.create({generate:true});
  f.backend.proposal.result={outcome:'needs_clarification',questions:['采购合同用途是什么？'],suggestions:[]};
  f.backend.context.answers.background='采购合同用于药品采购追溯，与病例分别管理';
  f.backend.context.confirmation={id:'new-confirmation',answers:structuredClone(f.backend.context.answers)};
  f.backend.context.latest_confirmation_id='new-confirmation';
  await f.flow.refresh();await f.flow.editAnswers();
  const count=f.calls.filter(c=>c.action==='onboarding-generate').length;
  await f.flow.submitAnswers();
  assert.equal(f.calls.filter(c=>c.action==='onboarding-generate').length,count+1);
  assert.equal(f.flow.state.error,'');
});
test('HTTP 200 stale proposal requires re-reading and explicit review before another write',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();await f.flow.generate();
  f.backend.proposal={...f.backend.proposal,status:'stale',valid:false};await f.flow.refresh();
  assert.equal(f.flow.state.needsReview,true);
  const writes=f.calls.filter(c=>c.input.body).length;await f.flow.generate();
  assert.equal(f.calls.filter(c=>c.input.body).length,writes);
});
test('corrupted saved answers must not crash the renderer or overwrite the retry record',async()=>{
  const f=fixture();await prepared(f);
  const raw=JSON.parse(f.storage.getItem(f.flow.key));raw.answers.industry={unexpected:true};
  const corrupted=JSON.stringify(raw);f.storage.setItem(f.flow.key,corrupted);
  f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.loaded,false);assert.equal(f.storage.getItem(f.flow.key),corrupted);
});
test('recovery replays the original generation even if its confirmation is no longer current',async()=>{
  const f=fixture();await prepared(f);await f.flow.create();
  let first=true;
  f.flow.call=(action,input)=>{
    if(action==='onboarding-generate' && first){first=false;return Promise.reject(error('SEMANTICA_CONNECTION_FAILED'));}
    return f.call(action,input);
  };
  await f.flow.generate();const pending=structuredClone(f.flow.state.pending);
  f.backend.context.confirmation=null;f.backend.proposal=null;
  const confirmations=f.calls.filter(c=>c.action==='onboarding-confirm').length;
  await f.flow.generate();
  assert.deepEqual(f.calls.filter(c=>c.action==='onboarding-generate').at(-1).input,pending.input);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-confirm').length,confirmations);
});
test('HTTP 403 after a possible commit retains the original envelope',async()=>{
  const f=fixture();await prepared(f);
  f.flow.call=(action,input)=>action==='onboarding-create'?Promise.reject(error('MODELING_OWNER_REQUIRED',403)):f.call(action,input);
  await f.flow.create();assert.equal(f.flow.state.pending.action,'onboarding-create');
  assert.ok(f.flow.state.creation);assert.equal(f.flow.state.needsReview,false);
});

const requests=[
  ['onboarding-read',{},'/modeling/onboarding','GET'],
  ['onboarding-warehouses',{},'/modeling/warehouses','GET'],
  ['onboarding-save',{body:{operation_id:'save',expected_revision:0,answers:{industry:'制造'},status:'in_progress'}},'/modeling/onboarding','POST'],
  ['onboarding-create',{onboardingId:'onboarding-a',body:{operation_id:'create',expected_revision:1,name:'测试仓'}},'/modeling/onboarding/onboarding-a/warehouse','POST'],
  ['onboarding-context',{warehouseId:'warehouse-a'},'/warehouses/warehouse-a/modeling/suggestion-context','GET'],
  ['onboarding-confirm',{warehouseId:'warehouse-a',body:{operation_id:'confirm',expected_revision:0,onboarding_revision:1,answers:{background:'',purpose:'',material_types:'',questions:''},expected_confirmation_id:null}},'/warehouses/warehouse-a/modeling/answer-confirmations','POST'],
  ['onboarding-generate',{warehouseId:'warehouse-a',body:{operation_id:'generate',confirmation_id:'confirmation-a',base_ontology_id:'ontology-a'}},'/warehouses/warehouse-a/modeling/answer-suggestions','POST'],
  ['onboarding-suggestion',{warehouseId:'warehouse-a',suggestionId:'suggestion-a'},'/warehouses/warehouse-a/modeling/answer-suggestions/suggestion-a','GET'],
];
for(const [action,input,path,method] of requests) test(`${action} maps through service and Host SDK without invented fields`,async()=>{
  let outgoing;const service=new SemanticaService({host:{context:async()=>identity,onSessionInvalidated:()=>()=>{},request:async(url,options)=>{
    outgoing={url,options};return new Response(JSON.stringify({receipt:'public'}));
  }}});
  assert.deepEqual(await service.call(action,input),{receipt:'public'});
  assert.equal(outgoing.url,'/api/semantica'+path);assert.equal(outgoing.options.method,method);
  assert.deepEqual(outgoing.options.body,input.body);assert.equal(outgoing.options.headers,undefined);
  assert.equal(outgoing.options.timeoutMs,action==='onboarding-generate'?300000:60000);
});
test('adapter rejects renderer-selected scopes, queries, paths and illegal field types',()=>{
  for(const [action,input] of [
    ['onboarding-read',{warehouseId:'other'}],['onboarding-read',{query:{limit:1}}],
    ['onboarding-create',{onboardingId:'../other',body:{}}],
    ['onboarding-save',{body:{operation_id:'x',expected_revision:true,answers:{}}}],
    ['onboarding-save',{body:{operation_id:'x',expected_revision:0,answers:{workspace_id:'other'}}}],
    ['onboarding-save',{body:{operation_id:'x',expected_revision:0,answers:{industry:'x'},authorization:'secret'}}],
  ]) assert.throws(()=>onboardingRequest(action,input),e=>e.code==='MODELING_INVALID_REQUEST');
});
test('service refuses team scope before any request',async()=>{
  let count=0;const service=new SemanticaService({host:{context:async()=>({...identity,dataScope:'team'}),onSessionInvalidated:()=>()=>{},request:async()=>{count++;}}});
  await assert.rejects(service.call('onboarding-read'),e=>e.code==='MODELING_HOST_CREATION_REQUIRED');assert.equal(count,0);
});
test('service discards a result when the account or warehouse changes during request',async()=>{
  for(const change of ['account','warehouse']) {
    let actor=identity;
    const service=new SemanticaService({host:{context:async()=>actor,onSessionInvalidated:()=>()=>{},request:async()=>{
      if(change==='account') actor={...identity,user:{id:2}};else await service.call('select-warehouse');
      return new Response('{}');
    }}});
    await assert.rejects(service.call('onboarding-read'),e=>e.code===(change==='account'?'HOST_SESSION_EXPIRED':'WAREHOUSE_CHANGED'));
  }
});
test('modeling error code and HTTP status survive IPC without upstream diagnostics',async()=>{
  const service=new SemanticaService({host:{context:async()=>identity,onSessionInvalidated:()=>()=>{},request:async()=>new Response(JSON.stringify({code:'MODELING_ANSWERS_STALE',message:'private prompt'}),{status:409})}});
  await assert.rejects(service.call('onboarding-read'),error=>{
    const reply=workbenchErrorReply(error);assert.equal(reply.code,'MODELING_ANSWERS_STALE');assert.equal(reply.status,409);
    assert.equal(JSON.stringify(reply).includes('private'),false);
    assert.throws(()=>readWorkbenchReply(reply),e=>e.code==='MODELING_ANSWERS_STALE'&&e.status===409);return true;
  });
});
