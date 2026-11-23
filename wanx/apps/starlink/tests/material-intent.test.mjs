import test from 'node:test';
import assert from 'node:assert/strict';
import {materialIntent,proposalWithinTarget} from '../ui/material-intent.mjs';

test('material intent distinguishes rule definitions, extraction purpose, facts and source',()=>{
  for(const [text,target] of [
    ['修改知识仓的类型，增加对产品研发知识的处理','rules'],
    ['新增产品类型','rules'],['修改本材料整理目标，只关注供应链内容','goal'],
    ['把这个实体改成产品类型','facts'],['排除甲公司这条事实','facts'],
    ['排除新结果中的错误事实','facts'],['修改正文第二段中的错别字','source']
  ])assert.deepEqual(materialIntent(text),{kind:'change',target},text);
});
test('questions and negations remain read only even within a modification',()=>{
  for(const text of ['需要如何修正','为什么抽取失败？','不要修改任何内容','是否增加产品类型'])
    assert.equal(materialIntent(text,{context:'rules',selected:true}).kind,'question');
});
test('compound operations and cross-material scope are not partially executed',()=>{
  for(const text of ['修改目标为产品研发，然后重新抽取','新增产品类型并重新抽取','下一步，修改抽取目标为研发','修改本体并修改整理目标'])
    assert.equal(materialIntent(text,{context:'rules'}).kind,'compound',text);
  assert.equal(materialIntent('修改所有材料的目标').kind,'scope');
  assert.equal(materialIntent('修改其他仓库的类型').kind,'scope');
  assert.equal(materialIntent('把采购方和供应方合并为当事人').kind,'clarify');
});
test('explicit context and a pending clarification retain scope without replacing clear new intent',()=>{
  assert.deepEqual(materialIntent('产品、需求、版本',{clarification:'rules'}),{kind:'change',target:'rules'});
  assert.deepEqual(materialIntent('付款和截止日期',{context:'goal'}),{kind:'change',target:'goal'});
  assert.deepEqual(materialIntent('修改整理目标为供应链',{context:'rules'}),{kind:'change',target:'goal'});
  assert.equal(materialIntent('供应链相关内容',{goalStage:true}).kind,'goal-dialogue');
});
test('only changes inside the declared target may be applied',()=>{
  assert.equal(proposalWithinTarget({result:{changes:[{scope:'rules'}]}},'rules'),true);
  for(const changes of [[],[{scope:'goal'}],[{scope:'rules'},{scope:'facts'}],[{}]])
    assert.equal(proposalWithinTarget({result:{changes}},'rules'),false);
});
test('type definition operations are not mistaken for edits to concrete facts',()=>{
  for(const text of ['修改实体类型定义','删除实体类型','合并实体类型','修改关系类型名称'])
    assert.deepEqual(materialIntent(text),{kind:'change',target:'rules'},text);
  assert.deepEqual(materialIntent('把这个实体的类型改成产品'),{kind:'change',target:'facts'});
  assert.equal(materialIntent('修改实体类型').kind,'clarify');
  assert.equal(materialIntent('修改实体类型定义，并删除这个实体').kind,'compound');
});
test('cross-material processing and clarification cannot inherit the current single-material target',()=>{
  for(const text of ['重新抽取所有材料','自动抽取其他材料','修改另一份文件的目标'])
    assert.equal(materialIntent(text,{context:'rules'}).kind,'scope',text);
  assert.equal(materialIntent('其他材料',{clarification:'goal'}).kind,'scope');
});
test('commands with extra instructions and ambiguous edits never become goal-stage answers',()=>{
  for(const text of ['下一步，整理供应链','重新抽取，供应链相关内容'])
    assert.equal(materialIntent(text,{goalStage:true}).kind,'compound');
  assert.equal(materialIntent('删除甲公司',{goalStage:true}).kind,'clarify');
  assert.equal(materialIntent('我希望提取供应链内容',{goalStage:true}).kind,'goal-dialogue');
});
