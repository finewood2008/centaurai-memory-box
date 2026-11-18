import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalView} from '../ui/onboarding-result.mjs';

test('server can_review denies new review even with candidates; old receipts remain compatible',()=>{
  const p={status:'succeeded',valid:true,result:{outcome:'needs_clarification',questions:['用途？'],suggestions:[{kind:'entity',name:'CONTRACT'}]}};
  assert.equal(proposalView(p).canAdopt,true);
  for(const can_review of [false,null,'true'])assert.equal(proposalView({...p,can_review}).canAdopt,false);
  assert.equal(proposalView({...p,can_review:true}).canAdopt,true);
  assert.equal(proposalView({...p,can_review:true,status:'stale'}).canAdopt,false);
  assert.equal(proposalView({...p,can_review:true,valid:false}).canAdopt,false);
  assert.equal(proposalView({...p,can_review:true,result:{...p.result,suggestions:[]}}).canAdopt,false);
});

test('actual owner suggestions render entity, relation and property candidates',()=>{
  const proposal={status:'succeeded',valid:true,result:{suggestions:[
    {kind:'entity',name:'DRUG',label:'药品',definition:'资料所描述的药品',reason:'用户需要整理药品资料',evidence:{quote:'药品'}},
    {kind:'relation',name:'TREATS',label:'用于治疗'},
    {kind:'property',name:'dosage_form',label:'剂型'},
  ],summary:[{text:'整理药品资料',evidence:{quote:'药品'}}],rejected_count:0}};
  const before=structuredClone(proposal), result=proposalView(proposal);
  assert.equal(result.empty,false);assert.equal(result.suggestions.length,3);
  assert.equal(result.suggestions[0].quote,'药品');assert.equal(result.summaries[0].text,'整理药品资料');
  assert.deepEqual(proposal,before);
});

test('successful zero suggestions stays empty even if a legacy fallback has types',()=>{
  const result=proposalView({status:'succeeded',valid:true,result:{suggestions:[],entity_types:[{name:'PERSON'}],summary:[{text:'职业为药剂师'}],rejected_count:0}});
  assert.equal(result.valid,false);assert.equal(result.canAdopt,false);assert.equal(result.empty,true);
  assert.equal(result.rejected,0);assert.equal(result.summaries.length,1);
});

test('failed or stale candidates never appear as valid suggestions',()=>{
  for (const status of ['failed','stale','generating']) {
    const result=proposalView({status,valid:true,result:{suggestions:[{kind:'entity',name:'DRUG'}]}});
    assert.equal(result.valid,false);assert.deepEqual(result.suggestions,[]);
  }
});

test('consistent clarification candidates permit explicit review without hiding remaining questions',()=>{
  const proposal={status:'succeeded',valid:true,result:{suggestions:[{kind:'entity',name:'CONTRACT',label:'合同'}],
    questions:['采购合同和病例是否属于同一个业务场景？'],explanation:'需明确资料用途',outcome:'needs_clarification'}};
  const view=proposalView(proposal);
  assert.equal(view.valid,true);assert.equal(view.canAdopt,true);assert.equal(view.suggestions.length,1);
  assert.deepEqual(view.questions,proposal.result.questions);assert.equal(view.explanation,'需明确资料用途');
  delete proposal.result.outcome;
  assert.equal(proposalView(proposal).outcome,'needs_clarification');
  proposal.result.outcome='ready';assert.equal(proposalView(proposal).canAdopt,false);
  proposal.result.questions=[];assert.equal(proposalView(proposal).canAdopt,true);
});

test('clarification without usable candidates cannot enter adoption',()=>{
  const result=proposalView({status:'succeeded',valid:true,result:{outcome:'needs_clarification',questions:['请补充用途'],suggestions:[]}});
  assert.equal(result.valid,true);assert.equal(result.canAdopt,false);
});

test('no_changes needs explicit outcome and explanation; empty or contradictory results cannot be adopted',()=>{
  for(const result of [{explanation:'文字说明'}, {outcome:'ready',explanation:'文字说明',suggestions:[]},
    {outcome:'no_changes',suggestions:[]}, {outcome:'needs_clarification',questions:[]},
    {outcome:'no_changes',explanation:'复用',suggestions:[{kind:'entity',name:'DRUG'}]}]) {
    const view=proposalView({status:'succeeded',valid:true,result});
    assert.equal(view.valid,false);assert.equal(view.canAdopt,false);
  }
  const view=proposalView({status:'succeeded',valid:true,result:{outcome:'no_changes',explanation:'现有类型已覆盖用途',questions:[],suggestions:[]}});
  assert.equal(view.valid,true);assert.equal(view.canAdopt,false);
});
