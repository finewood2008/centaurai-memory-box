import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extractionFailuresHTML, extractionValidationHTML} from '../ui/extraction-diagnostics.mjs';
import {extractionCountsHTML, taskUnitLabel} from '../ui/logical-source-view.mjs';

const failed = {id:'failed',kind:'knowledge_extract',status:'failed',stage:'failed',metrics:{extraction_failures:[{
  batch_index:0,stage:'joint',reason:'LLM_OUTPUT_EVIDENCE_ERROR',diagnostic:{version:1,source:'semantica',
    kind:'schema_validation',validator:'const',field_path:'/relations/0/quote',message:'PRIVATE_RAW_REPLY'}}]}};

test('grounding failures display their own reason and field path without model text',()=>{
  const html=extractionFailuresHTML(failed);
  assert.match(html,/原文依据/);
  assert.match(html,/\/relations\/0\/quote/);
  assert.doesNotMatch(html,/PRIVATE|模型输出结构不符合要求/);
  const ids=structuredClone(failed);
  ids.metrics.extraction_failures[0].diagnostic.field_path='/relations/0/evidence_ids/0';
  assert.match(extractionFailuresHTML(ids),/\/relations\/0\/evidence_ids\/0/);
});

test('task page renders diagnostics and both entity and relation publication counts',async()=>{
  const source=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function renderTasks()');
  const end=source.indexOf('\nfunction ',start+1);
  const nextAsync=source.indexOf('\nasync function ',start+1);
  const body=source.slice(start,Math.min(...[end,nextAsync].filter(i=>i>=0)));
  const nodes=new Map();
  const $=key=>{if(!nodes.has(key))nodes.set(key,{querySelectorAll:()=>[]});return nodes.get(key);};
  const context=vm.createContext({$,state:{jobs:[{...failed,knowledge_summary:{candidate_entities:28,candidate_relations:18,published_entities:1,published_relations:0}}]},icon:()=>'',esc:String,doc:()=>null,date:()=>'',
    actualModel:()=>'',renderPager:()=>'',extractionFailuresHTML,extractionValidationHTML,extractionCountsHTML,taskUnitLabel,taskProgress:()=> '失败',jobStates:{failed:'失败'},jobNames:{}});
  vm.runInContext(body,context);
  context.renderTasks();
  assert.match(nodes.get('#tasks-body').innerHTML,/\/relations\/0\/quote/);
  assert.match(nodes.get('#tasks-body').innerHTML,/候选 28 个实体、18 条关系 · 入图 1 个实体、0 条关系/);
});

test('validated partial results do not ask for whole-batch review or claim graph success prematurely',()=>{
  const html=extractionValidationHTML({status:'succeeded',document_id:'d',metrics:{
    joint_validation:{rejected_relations:18,publication_blocked:false,valid_candidates_automatic:true}}});
  assert.match(html,/已进入自动发布流程/);
  assert.match(html,/查看隔离结果/);
  assert.doesNotMatch(html,/前往资料库核对|已自动入图/);
});

test('same-body omissions show missing counts while the published graph stays active',()=>{
  const job={status:'succeeded',metrics:{joint_validation:{publication_blocked:true},publication_diff:{entities:1,relations:2}}};
  assert.match(extractionValidationHTML(job),/少了 1 个实体、2 条关系/);
  assert.match(extractionValidationHTML(job),/本次未替换图谱，已有知识保留/);
  job.metrics.publication_diff={entities:'<img>',relations:-1};
  assert.doesNotMatch(extractionValidationHTML(job),/<img>|少了/);
  job.metrics.joint_validation.publication_blocked=false;
  job.metrics.publication_diff={entities:1,relations:2};
  assert.equal(extractionValidationHTML(job),'');
});

test('repair omissions explain why retained valid candidates were not published',()=>{
  const html=extractionValidationHTML({metrics:{joint_validation:{publication_blocked:true},
    extraction_completeness_issues:[{reason:'REPAIR_DROPPED_FACTS',message:'PRIVATE_MODEL_TEXT'}]}});
  assert.match(html,/首轮已通过校验的事实/);
  assert.match(html,/首轮候选已保留/);
  assert.doesNotMatch(html,/PRIVATE_MODEL_TEXT/);
});

test('property-only omissions explain why existing values are retained',()=>{
  const html=extractionValidationHTML({metrics:{joint_validation:{publication_blocked:true},
    publication_diff:{entities:0,relations:0,properties:2}}});
  assert.match(html,/少了 2 项属性/);
  assert.match(html,/已有知识保留/);
});

test('isolated relations are visible even for a completed extraction',()=>{
  const job={status:'succeeded',document_id:'d" onmouseover="bad',metrics:{joint_validation:{rejected_relations:2,publication_blocked:true}}};
  let html=extractionValidationHTML(job);
  assert.match(html,/隔离 2 条/);
  assert.match(html,/本次未自动入图/);
  assert.doesNotMatch(html, /document="d" onmouseover=/);
  job.metrics.joint_validation.publication_blocked=false;
  html=extractionValidationHTML(job);
  assert.match(html,/其他通过校验的候选已保留/);
  for(const count of [0,-1,'2','<script>',Infinity]){
    job.metrics.joint_validation.rejected_relations=count;
    assert.equal(extractionValidationHTML(job),'');
  }
});

test('isolated types and entities and blocked empty corrections are visible',()=>{
  const job={status:'succeeded',metrics:{joint_validation:{rejected_types:1,rejected_entities:2,rejected_relations:0},joint_rejections:[{
    batch_index:0,stage:'joint',reason:'LLM_OUTPUT_ONTOLOGY_ERROR',diagnostic:{version:1,source:'semantica',kind:'schema_validation',
    field_path:'/new_types/entity_types/0',message:'PRIVATE'}}]}};
  const html=extractionValidationHTML(job);
  assert.match(html,/2 个实体、1 个新类型/);
  assert.match(html,/\/new_types\/entity_types\/0/);
  assert.doesNotMatch(html,/PRIVATE/);
  assert.match(extractionValidationHTML({metrics:{joint_validation:{publication_blocked:true}}}),/已有知识保留/);
});
