import test from 'node:test';
import assert from 'node:assert/strict';
import {validationExclusionRequest,validationSelection} from '../ui/material-validation-selection.mjs';
import {publicationIssuesHTML} from '../ui/conversation-changes-view.mjs';
const preview={revision:1,issue_count:3,items:[{item_id:'relation',after:{type:'AFFECTS'}}],issues:[
  {item_id:'relation',severity:'error',message:'两端类型不符'},
  {item_id:'relation',severity:'warning',message:'缺少方向依据'},
  {item_id:'other',severity:'info',message:'属性空缺'},
]};
test('explicit validation removal resolves repeated hints to one fact and ignores informational hints',()=>{
  assert.deepEqual(validationExclusionRequest('移除这两条有问题的条目'),{count:2});
  assert.deepEqual(validationExclusionRequest('移除这些条目'),{count:null,selected:true});
  assert.deepEqual(validationSelection(preview,null,2),{ids:['relation'],issueCount:2});
  assert.ok(validationSelection(preview,null,3).error);
  for(const text of ['为什么不能移除这些有问题的条目？','不要移除这些有问题的条目','移除其他材料有问题的条目','移除这些有问题的条目并发布'])assert.equal(validationExclusionRequest(text),null);
  const html=publicationIssuesHTML(preview,false,['relation']);
  assert.equal((html.match(/data-cv-issue="relation"/g)||[]).length,1);
  assert.match(html,/data-cv="change-issues-exclude"[^>]*>移除选中条目/);
});

test('unchanged validation facts display their names even when absent from the publication diff',()=>{
  const html=publicationIssuesHTML({...preview,items:[],issue_items:[{id:'relation',kind:'relation',display_name:'产品 → 影响 → 项目'}]},false,['relation']);
  assert.match(html,/产品 → 影响 → 项目/);assert.doesNotMatch(html,/> relation <small>/);
});
test('partial results, unbound issues and oversized batches cannot become implicit removals',()=>{
  assert.ok(validationSelection({...preview,issue_count:100}).error);
  assert.deepEqual(validationSelection({...preview,issue_count:100},['relation']),{ids:['relation'],issueCount:2});
  assert.ok(validationSelection({...preview,issues:[{severity:'error'}]}).error);
  assert.ok(validationSelection(preview,['other']).error);
  assert.ok(validationSelection({issues:Array.from({length:21},(_,i)=>({item_id:String(i),severity:'error'}))}).error);
});
