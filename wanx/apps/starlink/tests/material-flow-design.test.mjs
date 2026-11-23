import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationInputRoute} from '../ui/conversation-next.mjs';
import {materialWorkflowLabel} from '../ui/material-state.mjs';
import {extractionFailuresHTML} from '../ui/extraction-diagnostics.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';

test('questions override selected facts, pending clarification and explicit change mode',()=>{
  for(const mode of ['auto','change'])for(const text of ['需要如何修正','这些内容应该怎么调整','请问哪些实体需要修改','帮我分析这些关系有什么问题','为什么需要重新抽取']){
    const f={state:{detail:{document_version_id:'v'},messageMode:mode,composerContext:'facts'},changes:{record:{},state:{proposals:[{status:'needs_clarification',id:'p'}]}}};
    assert.equal(conversationInputRoute(text,f),'question',text);
    assert.equal(conversationInputRoute('将选中的实体改为产品',f),'change');
  }
});
test('material publication and unapplied draft state have distinct labels',()=>{
  const w={document_version_id:'v',publication:{id:'r',status:'published',document_version_id:'v'}};
  assert.equal(materialWorkflowLabel(w),'已发布');
  w.draft={status:'editing'};assert.equal(materialWorkflowLabel(w),'已发布 · 草稿状态待确认');
  w.draft.has_changes=true;assert.equal(materialWorkflowLabel(w),'已发布 · 有未发布修改');
  w.draft.submitted_at='now';assert.equal(materialWorkflowLabel(w),'已发布');
  w.publication.document_version_id='old';assert.equal(materialWorkflowLabel(w),null);
});

test('automatic publication, new candidates and actual edits remain distinct after draft creation and reset',()=>{
  const w={document_version_id:'v',processing_mode:'automatic',stage:'published',publication:{id:'r',status:'published',document_version_id:'v'},
    automatic_processing:{candidate_result_count:0,modified_draft_count:0}};
  assert.equal(materialWorkflowLabel(w),'已发布');
  w.stage='draft';w.draft={status:'editing',revision:1,has_changes:false};assert.equal(materialWorkflowLabel(w),'已发布');
  w.automatic_processing.candidate_result_count=1;assert.equal(materialWorkflowLabel(w),'已发布 · 新抽取结果待核对');
  w.draft.has_changes=true;assert.equal(materialWorkflowLabel(w),'已发布 · 有未发布修改');
  w.draft.has_changes=false;w.draft.revision=9;w.automatic_processing.modified_draft_count=1;
  assert.equal(materialWorkflowLabel(w),'已发布 · 新抽取结果待核对');
  w.extraction_review=null;assert.equal(materialWorkflowLabel(w),'已发布');
  w.extraction_review={run_id:'new',reason_code:'EXTRACTION_COMPLETENESS_REVIEW',next_action:'review_candidates'};
  assert.equal(materialWorkflowLabel(w),'已发布 · 新抽取结果待核对');
  delete w.draft.has_changes;delete w.extraction_review;w.automatic_processing.candidate_result_count=0;
  assert.equal(materialWorkflowLabel(w),'已发布 · 草稿状态待确认','replacement history alone does not establish a current diff');
  w.draft.change_count=0;w.draft.ontology_changed=true;assert.equal(materialWorkflowLabel(w),'已发布 · 有未发布修改');
  w.draft.ontology_changed=false;assert.equal(materialWorkflowLabel(w),'已发布');
});
test('diagnostics use one-based extraction batches, safe fields and clear stale errors when a retry runs',()=>{
  const job={status:'failed',metrics:{extraction_failures:[{batch_index:13,stage:'relations',reason:'LLM_OUTPUT_SCHEMA_ERROR',diagnostic:{version:1,source:'bridge',kind:'schema_validation',validator:'type',field_path:'/relations/0/confidence',message:'RAW_SECRET'}}]}};
  const html=extractionFailuresHTML(job);assert.match(html,/第 14 批 · 关系抽取 · 字段类型不符合要求/);assert.match(html,/\/relations\/0\/confidence/);assert.doesNotMatch(html,/RAW_SECRET/);
  job.status='running';assert.equal(extractionFailuresHTML(job),'');job.status='failed';job.metrics.extraction_failures[0].stage='unknown';
  assert.match(extractionFailuresHTML(job),/阶段未确定/);assert.doesNotMatch(extractionFailuresHTML(job),/confidence|字段类型不符合要求/);
  assert.equal(extractionFailuresHTML({status:'failed'}),'');
});
test('discard requires private ownership, exact revision and explicit confirmation; job retry keeps original ID',()=>{
  const input={warehouseId:'w',documentId:'d',draftId:'draft',operationId:'op',revision:2,confirmed:true,editor:{session:'s'.repeat(30),generation:'1'}};
  const r=conversationRequest('conversation-change-discard',input);
  assert.match(r.path,/\/documents\/d\/corrections\/draft\/discard$/);assert.equal(r.body.expected_revision,2);assert.equal(r.body.operation_id,'op');assert.equal(r.body.confirmed,undefined);
  assert.throws(()=>conversationRequest('conversation-change-discard',{...input,confirmed:false}));
  const {editor,...noEditor}=input;assert.throws(()=>conversationRequest('conversation-change-discard',noEditor));
  assert.equal(conversationRequest('conversation-job-retry',{warehouseId:'w',jobId:'job',operationId:'same'}).path,'/warehouses/w/workbench/jobs/job/retry');
});
