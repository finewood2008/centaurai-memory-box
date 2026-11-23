import test from 'node:test';
import assert from 'node:assert/strict';
import {syncStarxiaotuCatalog} from '../tools/sync-starxiaotu-catalog.mjs';
import {starxiaotuCatalog as catalog,validateStarxiaotuDecision,starxiaotuDecisionRequest,starxiaotuIntentRequest,starxiaotuCandidateLabel} from '../shared/starxiaotu-intent.mjs';
const decision=(intent,target,args={})=>({intent,target,arguments:args});
const body=()=>({operation_id:'classify-1',version:2,context:{focus:'page',material_title:''},text:'模型在哪儿配',page:'graph',history:[],ontology_conversation:false});
test('shared capability catalog and client artifact cannot drift',async()=>{await syncStarxiaotuCatalog({check:true});});
test('only finite intent/target/argument combinations can reach UI dispatch',()=>{
  for(const target of Object.keys(catalog.guides))assert.equal(starxiaotuDecisionRequest(decision('guide',target),'怎么用').key,target);
  for(const target of Object.keys(catalog.pages))assert.equal(starxiaotuDecisionRequest(decision('navigate',target),'带我去').destination,target);
  for(const metric of catalog.metrics)assert.equal(starxiaotuDecisionRequest(decision('query','project_stats',{metric}),'多少').metric,metric);
  for(const value of [decision('query','ontology_rules'),decision('search','materials',{query:'合同'}),decision('navigate','record',{query:'person-1'}),decision('ontology_change','ontology'),decision('clarify','none',{reason:'missing_context',candidates:[]}),decision('unsupported','none')])assert.deepEqual(validateStarxiaotuDecision(value),value);
  for(const value of [decision('publish','ontology'),decision('navigate','https://example.com'),decision('search','models',{query:'x'}),decision('query','project_stats',{metric:'secret_count'}),decision('ontology_change','ontology',{confirmed:true}),decision('guide','__proto__'),{...decision('guide','models'),url:'/private'},decision('search','materials',{query:'x',warehouseId:'other'}),decision('search','materials',{query:' '}),decision('clarify','none',{reason:'free text'})])assert.throws(()=>validateStarxiaotuDecision(value));
});

test('clarification candidates are exact finite actions and labels come from the registry',()=>{
  const candidates=[decision('guide','graph'),decision('search','materials',{query:'星图'})];
  const value=decision('clarify','none',{reason:'ambiguous',candidates});
  assert.deepEqual(validateStarxiaotuDecision(value),value);
  assert.deepEqual(candidates.map(starxiaotuCandidateLabel),['了解「星图」功能','检索资料「星图」']);
  const resolved=starxiaotuDecisionRequest(starxiaotuDecisionRequest(value,'帮我看看星图').candidates[1],'帮我看看星图');
  assert.deepEqual(resolved,{kind:'search',text:'帮我看看星图',query:'星图'});
  for(const alternatives of [[candidates[0]],[candidates[0],candidates[0]],[...candidates,candidates[1]],[candidates[0],decision('ontology_change','ontology')],[candidates[0],value],[{...candidates[0],label:'自由生成按钮'},candidates[1]]])assert.throws(()=>validateStarxiaotuDecision(decision('clarify','none',{reason:'ambiguous',candidates:alternatives})));
  assert.throws(()=>validateStarxiaotuDecision(decision('clarify','none',{reason:'ambiguous',candidates:[]})));
  const scoped=decision('search','materials',{query:'星图功能',scope:'active_material'});
  assert.equal(starxiaotuDecisionRequest(scoped,'这份资料里的星图有什么功能').scope,'active_material');
  assert.match(starxiaotuCandidateLabel(scoped),/检索当前资料/);
  for(const scope of ['other_warehouse','all',null])assert.throws(()=>validateStarxiaotuDecision(decision('search','materials',{query:'星图',scope})));
});

test('material context and resolved page history carry no arbitrary source contents or authority',()=>{
  const b={...body(),context:{focus:'material',material_title:'星图产品介绍.docx'},history:[{text:'搜索星图产品',page:'conversation',decision:decision('search','materials',{query:'星图产品'})}]};
  assert.deepEqual(starxiaotuIntentRequest({warehouseId:'selected',body:b}).body,b);
  for(const change of [{context:{focus:'material',material_title:''}},{context:{focus:'page',material_title:'文档'}},{context:{focus:'material',material_title:'文档',document_id:'another'}},{context:{focus:'material',material_title:'文档',text:'private source'}},{history:[{text:'歧义',page:'graph',decision:decision('clarify','none',{reason:'missing_context',candidates:[]})}]}])assert.throws(()=>starxiaotuIntentRequest({warehouseId:'selected',body:{...b,...change}}));
});
test('model decisions do not rewrite ontology instructions or supply authority',()=>{
  const text='给合同增加到期日期';
  assert.deepEqual(starxiaotuDecisionRequest(decision('ontology_change','ontology'),text),{kind:'ontology-change',text});
  assert.deepEqual(starxiaotuDecisionRequest(decision('search','materials',{query:'合同到期'}),'哪些合同到期了'),{kind:'search',text:'哪些合同到期了',query:'合同到期'});
  assert.equal(starxiaotuDecisionRequest(decision('guide','models'),'抽取用的那个模型怎么换').kind,'explain');
});
test('classifier context is bounded and warehouse authority stays in the selected route',()=>{
  const request=starxiaotuIntentRequest({warehouseId:'selected',body:body()});
  assert.equal(request.path,'/warehouses/selected/modeling/assistant-intent');assert.equal(request.method,'POST');
  for(const change of [{version:99},{text:' '},{text:'x'.repeat(2001)},{page:'private'},{warehouse_id:'other'},{history:[{text:'old',answer:'source secret'}]},{history:Array(5).fill({text:'old',page:'graph',decision:decision('guide','models')})}])assert.throws(()=>starxiaotuIntentRequest({warehouseId:'selected',body:{...body(),...change}}));
});
