import test from 'node:test';
import assert from 'node:assert/strict';
import {editedScope, readScope} from '../ui/onboarding-scope-editor.mjs';
import {onboardingRequest} from '../shared/onboarding-contract.mjs';

test('direct editing patches only changed fields and can clear a list', () => {
  const initial = {industry:'制造', purposes:['保存\n原始多行文本'], excluded_scope:['保留原文']};
  assert.deepEqual(editedScope(initial,{industry:' 制造 ',purposes:'保存\n原始多行文本',excluded_scope:''}),
    {excluded_scope:[]});
  assert.deepEqual(editedScope(initial,{purposes:'查找需求\n\n核对依据'}),{purposes:['查找需求','核对依据']});
});

test('direct scope reads the live base version and never opens or sends a conversation on older boxes', async () => {
  const calls=[];
  const call=async (action,input) => {
    calls.push(action);
    if(action==='onboarding-context')return {purpose_revision:3,base_ontology_id:'rules'};
    if(action==='conversation-ontologies')return {items:[{id:'rules',status:'published',version_number:7}]};
    if(action==='conversation-list')return {items:[{id:'old',scenario:'onboarding',status:'active'},{id:'current',scenario:'onboarding',status:'active'}]};
    if(action==='conversation-onboarding-get')return {status:'guiding',draft:{revision:0,purpose_revision:input.conversationId==='old'?2:3},
      seed:{purpose:{purpose:'查找需求\n核对原文',_onboarding_scope:{purposes:['查找需求','核对原文']},service_objects:['产品组']}}};
    throw Error(action);
  };
  const result=await readScope(call,'warehouse');
  assert.equal(result.canPublish,false);
  assert.deepEqual(result.scope.purposes,['查找需求','核对原文']);
  assert.deepEqual(result.scope.service_objects,['产品组']);
  assert.deepEqual(calls,['onboarding-context','conversation-ontologies','conversation-list','conversation-onboarding-get','conversation-onboarding-get']);
});

test('publishing direct scope requires confirmation and accepts only editable fields', () => {
  const input={warehouseId:'warehouse',body:{operation_id:'op',expected_revision:3,base_ontology_id:'rules',
    changes:{purposes:['核对原文']},confirmed:true}};
  const request=onboardingRequest('onboarding-scope-publish',input);
  assert.equal(request.path,'/warehouses/warehouse/modeling/warehouse-scope/publish');
  assert.equal(request.method,'POST');
  for(const body of [{...input.body,confirmed:false},{...input.body,changes:{schema:{}}},{...input.body,changes:{}}])
    assert.throws(()=>onboardingRequest('onboarding-scope-publish',{...input,body}),/MODELING_INVALID_REQUEST/);
});
