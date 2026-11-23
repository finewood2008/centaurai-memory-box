import test from 'node:test';
import assert from 'node:assert/strict';
import {materialJobRetryAllowed} from '../applications/starlink/ui/material-agent.mjs';
import {extractionFailuresHTML} from '../applications/starlink/ui/extraction-diagnostics.mjs';

test('changed extraction snapshots require a new preview and hide stale batch errors',()=>{
  for(const code of ['MODELING_PROMPT_CHANGED','MODELING_MODEL_CHANGED','LLM_PROMPT_CHANGED','LLM_MODEL_CHANGED']){
    const job={kind:'knowledge_extract',status:'failed',error_code:code,
      metrics:{extraction_failures:[{batch_index:0,stage:'entities',reason:'LLM_OUTPUT_CONTINUATION_STALLED'}]}};
    assert.equal(materialJobRetryAllowed(job),false);
    const html=extractionFailuresHTML(job);
    assert.match(html,/重新预览/);
    assert.doesNotMatch(html,/第 1 批|本次失败批次|模型续抽/);
    assert.equal(materialJobRetryAllowed({...job,error_code:null,retry_blocked_code:code}),false);
  }
});
test('ordinary output failures still allow retry and retain batch diagnostics',()=>{
  const job={kind:'knowledge_extract',status:'failed',error_code:'EXTRACTION_PARTIAL_FAILURE',
    metrics:{extraction_failures:[{batch_index:0,stage:'entities',reason:'LLM_OUTPUT_CONTINUATION_STALLED'}]}};
  assert.equal(materialJobRetryAllowed(job),true);
  assert.match(extractionFailuresHTML(job),/第 1 批/);
});
