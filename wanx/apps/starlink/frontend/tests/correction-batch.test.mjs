import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildBatchPlan, canReviewWarnings, readBatchItems} from '../src/correctionBatch.ts';
import {operationEnvelope} from '../src/corrections.ts';
import {groupPublicationIssues} from '../../shared/publication-validation.mjs';

const fact=(id,kind='entity',issues=[])=>({id,kind,payload:{name:id,type:'TYPE',properties:{category:'分类',description:'描述',keep:0}},evidence:[{segment_id:'s',excerpt:'依据'}],review_note:'旧说明',issues});
const warning=id=>({item_id:id,code:'SEMANTIC_REVIEW',message:'核对归属',severity:'warning',reviewed:false});
test('publication groups deduplicate repeated messages per fact without hiding counts or mixing gate severities',()=>{
  const w=warning('a'), groups=groupPublicationIssues([w,{...w},{...w,code:'OTHER',message:'其他警告'}, {...w,item_id:'b'},
    {...w,severity:'info'}, {...w,reviewed:true}, {...w,severity:'error',reviewed:true}]);
  assert.equal(groups.warning.length,2);assert.equal(groups.warning[0].count,3);assert.equal(groups.warning[0].issues.length,2);
  assert.equal(groups.info.length,1);assert.equal(groups.reviewed.length,1);assert.equal(groups.error.length,1);
});
test('batch semantic review only acknowledges explicitly selected warnings, never errors or notices',()=>{
  const a=fact('a','entity',[warning('a')]), b=fact('b','relation',[warning('b')]);
  const plan=buildBatchPlan([a,b],['a','b'],'review',' 已核对原文，关系成立 ');
  assert.equal(plan.upserts.length,2);assert.equal(plan.upserts[0].review_note,'已核对原文，关系成立');
  assert.deepEqual(plan.upserts[0].payload,a.payload);assert.deepEqual(plan.upserts[0].evidence,a.evidence);
  assert.equal(a.review_note,'旧说明');assert.equal('issues' in plan.upserts[0],false);
  for(const issues of [[{...warning('x'),severity:'error'}],[{...warning('x'),reviewed:true}],[{...warning('x'),severity:'info'}],[]]){
    const item=fact('x','entity',issues);assert.equal(canReviewWarnings(item),false);
    assert.throws(()=>buildBatchPlan([item],['x'],'review','说明'));
  }
});
test('property removal is explicit, nonmutating and clears previous semantic approval',()=>{
  const a=fact('a'),b=fact('b'), plan=buildBatchPlan([a,b],['a'],'properties','原文未提及',['category']);
  assert.deepEqual(plan.upserts[0].payload.properties,{description:'描述',keep:0});assert.equal(plan.upserts[0].review_note,'');
  assert.equal(a.payload.properties.category,'分类');assert.equal(b.payload.properties.category,'分类');assert.deepEqual(plan.removeIds,[]);
  assert.throws(()=>buildBatchPlan([a],['a'],'properties','原因',[]));
  assert.throws(()=>buildBatchPlan([a],['a'],'properties','原因',['unknown']));
});
test('batch exclusion only removes selected relations and preserves entity endpoints',()=>{
  const entity=fact('e'),relation=fact('r','relation');
  assert.deepEqual(buildBatchPlan([entity,relation],['r'],'relations','关系不成立').removeIds,['r']);
  assert.throws(()=>buildBatchPlan([entity,relation],['e','r'],'relations','不成立'));
  assert.throws(()=>buildBatchPlan([relation],['r','r'],'relations','不成立'));
  assert.throws(()=>buildBatchPlan([relation],['missing'],'relations','不成立'));
  assert.throws(()=>buildBatchPlan([relation],['r'],'relations',''));
  assert.throws(()=>buildBatchPlan([],Array.from({length:101},(_,i)=>String(i)),'relations','理由'));
});
test('all issue pages are loaded and revision changes, duplicate/missing pages and truncated responses fail closed',async()=>{
  const a=fact('a'),b=fact('b'), offsets=[];
  const result=await readBatchItems(async offset=>{offsets.push(offset);return {items:[offset===0?a:b],total:2,offset,revision:3};},3);
  assert.deepEqual(offsets,[0,1]);assert.deepEqual(result,[a,b]);
  for(const response of [
    {items:[a],total:1,offset:0,revision:4},
    {items:[],total:1,offset:0,revision:3},
    {items:[a,a],total:2,offset:0,revision:3},
    {items:[{...a,issues:undefined}],total:1,offset:0,revision:3},
    {items:[a],total:1,offset:1,revision:3},
  ]) await assert.rejects(readBatchItems(async()=>response,3));
  await assert.rejects(readBatchItems(async offset=>({items:offset?[b]:[a],total:offset?3:2,offset,revision:3}),3));
});
test('batch writes use the existing immutable revision and operation envelope',()=>{
  const item=fact('a','entity',[warning('a')]),plan=buildBatchPlan([item],['a'],'review','已核对');
  const envelope=operationEnvelope(8,plan.upserts,plan.removeIds,'已核对','original-op');
  plan.upserts[0].payload.name='later';
  assert.equal(envelope.upserts[0].payload.name,'a');assert.equal(envelope.expected_revision,8);assert.equal(envelope.operation_id,'original-op');
  assert.equal('review_basis' in envelope.upserts[0],false);
});
