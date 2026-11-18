import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicationIssuesHTML} from '../ui/conversation-changes-view.mjs';
import {publicationIssueAdvice} from '../shared/publication-validation.mjs';

test('validation advice requires evidence and never treats a review note as a replacement for fixing errors',()=>{
  assert.match(publicationIssueAdvice({severity:'warning',message:'来源可能包含计划、否定或疑问'}),/排除/);
  assert.match(publicationIssueAdvice({severity:'warning',message:'关系缺少方向明确的依据'}),/方向/);
  assert.match(publicationIssueAdvice({severity:'error',message:'端点类型不符合约束'}),/不能|不可|不应|不能用/);
  assert.equal(publicationIssueAdvice({severity:'info',message:'属性未提及'}),null);
  assert.equal(publicationIssueAdvice({severity:'warning',reviewed:true,message:'已核对'}),null);
});

test('relation evidence failures mentioning properties require reviewing or excluding the relation',()=>{
  for(const severity of ['warning','error']){
    const issue={item_id:'relation',code:'SEMANTIC_REVIEW',severity,message:'关系缺少对应行为或属性的肯定陈述'};
    const advice=publicationIssueAdvice(issue);
    assert.match(advice,/原文/);
    assert.match(advice,/排除关系/);
    assert.match(advice,/编辑器中调整来源引用并填写核对说明/);
    assert.match(advice,/重新校验/);
    assert.match(advice,/核对说明不能替代来源证据，也不能放行阻塞错误/);
    assert.doesNotMatch(advice,/仅修正或移除没有依据的属性|不必删除整条事实/);
    const html=publicationIssuesHTML({revision:1,issue_count:1,items:[],issues:[issue]});
    assert.match(html,/排除关系/);
  }
  assert.doesNotMatch(publicationIssueAdvice({code:'SEMANTIC_REVIEW',severity:'warning',message:'请核对行为或属性依据'}),/仅修正或移除没有依据的属性/);
});

test('structured property issues keep property-specific advice without inferring scope from message words',()=>{
  for(const scope of [{property_name:'dose'}, {code:'MATERIAL_PROPERTY_UNSUPPORTED'}]){
    const advice=publicationIssueAdvice({code:'SEMANTIC_REVIEW',severity:'error',message:'关系缺少对应行为或属性的肯定陈述',...scope});
    assert.match(advice,/仅修正或移除没有依据的属性/);
    assert.match(advice,/不能用核对说明放行阻塞错误/);
    assert.doesNotMatch(advice,/排除这条关系/);
  }
});
test('workbench separates notices and reviewed warnings, keeps errors open and escapes server text',()=>{
  const preview={revision:4,issue_count:4,items:[],issues:[
    {item_id:'a',code:'X',message:'<script>bad</script>',severity:'error'},
    {item_id:'b',code:'Y',message:'请核对',severity:'warning'},
    {item_id:'c',code:'Z',message:'已核对',severity:'warning',reviewed:true},
    {item_id:'d',code:'MATERIAL_PROPERTY_UNMENTIONED',message:'保持空缺',severity:'info'},
  ]};
  const html=publicationIssuesHTML(preview);
  assert.match(html,/阻塞错误 1 项/);assert.match(html,/待核对警告 1 项/);assert.match(html,/可忽略提示 1 项/);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  assert.match(html,/<details open[^>]*validation-4-error/);assert.doesNotMatch(html,/<details open[^>]*validation-4-info/);
  assert.match(html,/data-cv="advanced-review"/);
  assert.match(publicationIssuesHTML({...preview,issue_count:101},true),/已载入 1 项/);
  assert.match(publicationIssuesHTML(preview,true),/data-cv="advanced-review" disabled/);
});
