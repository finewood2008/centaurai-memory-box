import test from 'node:test';
import assert from 'node:assert/strict';
import {relatedSelection,requestsRelatedExclusion} from '../ui/material-related-selection.mjs';

function fixture(count=52){
  const calls=[],entities=[{id:'e1',kind:'entity'},{id:'e2',kind:'entity'}];
  const relations=Array.from({length:count},(_,n)=>({id:'r'+n,kind:'relation',payload:{source_candidate_key:n===count-1?'e1':'e2',target_candidate_key:'other'}}));
  const c={state:{selected:['e1'],summary:{revision:3}},owner:{documentId:'doc',draftId:'draft'},editor:()=>({session:'private',generation:'1'}),async call(action,input){
    calls.push({action,input});
    if(action==='draft')return {revision:3,status:'editing'};
    const items=input.kind==='entity'?entities:relations;
    return {revision:3,total:items.length,offset:input.offset,items:items.slice(input.offset,input.offset+input.limit)};
  }};
  return {c,calls,relations};
}
test('explicit linked exclusion reads all relation pages and preserves unrelated facts',async()=>{
  const {c,calls}=fixture();
  const result=await relatedSelection(c,'删除选中实体，同时排除相关关系');
  assert.deepEqual(result,{ids:['e1','r51'],relatedCount:1,entityCount:1});
  assert.deepEqual(c.state.selected,['e1']);
  assert.deepEqual(calls.filter(r=>r.input.kind==='relation').map(r=>r.input.offset),[0,50]);
  assert.ok(calls.every(r=>r.input.documentId==='doc'&&r.input.draftId==='draft'&&r.input.revision===3));
});
test('questions, negation and entity-only changes never widen the selection',async()=>{
  for(const instruction of ['不要删除实体及其关联关系','删除实体，保留关系','是否同时删除实体和关系？','修改实体名称','删除选中实体']){
    assert.equal(requestsRelatedExclusion(instruction),false);
    const {c,calls}=fixture();assert.equal(await relatedSelection(c,instruction),null);assert.equal(calls.length,0);
  }
});
test('more than twenty affected items is rejected without a partial selection',async()=>{
  const {c,relations}=fixture(20);for(const r of relations)r.payload.source_candidate_key='e1';
  await assert.rejects(()=>relatedSelection(c,'排除实体及其关联关系'),{code:'MODELING_RELATED_SELECTION_TOO_LARGE'});
  assert.deepEqual(c.state.selected,['e1']);
});
test('revision drift and incomplete pages cannot produce a linked modification',async()=>{
  for(const mode of ['revision','empty','final']){
    const {c}=fixture();const read=c.call.bind(c);
    c.call=async(action,input)=>{const value=await read(action,input);if(mode==='final'&&action==='draft')value.revision=4;
      if(input.kind==='relation'){if(mode==='revision')value.revision=4;if(mode==='empty')value.items=[];}return value;};
    await assert.rejects(()=>relatedSelection(c,'排除实体及其关联关系'));
    assert.deepEqual(c.state.selected,['e1']);
  }
});
