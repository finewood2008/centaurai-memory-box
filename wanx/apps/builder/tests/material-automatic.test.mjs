import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialAutomatic} from '../integration/team-client/starlink/material-automatic.mjs';
import {assertWorkflow,unwrapMaterialResponse,materialDiagnostic,materialRequest} from '../integration/team-client/starlink/material-contract.mjs';
import {SemanticaService} from '../integration/team-client/starlink/service.mjs';

const warehouseId='12345678-1234-1234-1234-123456789abc';
function fixture(){
  const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  let context={recoveryScope:'owner/box',scope:'session',warehouseId},version='v1',revision=1,latest=null;
  let loseResponse=false,stale=false,forbidden=false,blocked=false,deferred=null,progress={stage:'published',is_current:true,publication_performed:true};
  const calls=[],receipts=new Map();let tasks=0;
  const workflow=()=>({document_id:'doc',document_version_id:version,workflow_revision:revision,automatic_processing:{},actions:{edit_source:{allowed:false},prepare_automatic:{allowed:true}},latest_transition_id:latest});
  const call=async(action,input)=>{
    calls.push([action,structuredClone(input)]);
    if(forbidden)throw Object.assign(Error('secret body must not leak'),{httpStatus:403,code:'MODELING_OWNER_REQUIRED',requestId:'req-denied'});
    if(action==='material-workflow')return workflow();
    if(action==='material-preview')return {contract_version:'1.1.0',document_id:'doc',operation_id:input.operationId,target_mode:'automatic',preview_id:input.operationId,preview_digest:'a'.repeat(64),workflow_revision:revision,expires_at:new Date(Date.now()+300000).toISOString(),can_confirm:!blocked,blockers:blocked?[{code:'MATERIAL_REVIEW_REQUIRED',detail:'他人草稿待处理',resolution:'wait'}]:[],snapshot:{document_version_id:version},publication_policy:'automatic',replacement:{draft_count:2,modified_draft_count:1,candidate_result_count:3,modified_candidate_result_count:1,replaces_manual_publication:true,requires_acknowledgement:true,preserves_history:true,description:'测试影响',acknowledgement_digest:'b'.repeat(64)}};
    if(action==='material-transition'){
      if(deferred)await deferred;
      if(stale){stale=false;version='v2';revision++;throw Object.assign(Error(),{code:'MATERIAL_PROCESSING_PREVIEW_STALE',httpStatus:409});}
      if(!receipts.has(input.operationId)){
        tasks++;latest='t'+tasks;
        receipts.set(input.operationId,{document_id:'doc',transition_id:latest,operation_id:input.operationId,preview_id:input.previewId,target_mode:'automatic',publication_performed:false});
      }
      if(loseResponse){loseResponse=false;throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED',requestId:'lost'});}
      return {receipt:receipts.get(input.operationId)};
    }
    if(action==='material-transition-status')return {receipt:[...receipts.values()].find(r=>r.transition_id===input.transitionId),current:progress};
    throw Error(action);
  };
  const create=()=>createMaterialAutomatic({call,changed(){},getContext:()=>context,getStorage:()=>storage,setTimer:()=>1,clearTimer(){}});
  return {create,calls,data,workflow,tasks:()=>tasks,lose(){loseResponse=true},stale(){stale=true},deny(){forbidden=true},block(){blocked=true},progress:p=>progress=p,defer:p=>deferred=p,switch(){context={...context,scope:'other',recoveryScope:'other/box'}}};
}

test('preview displays manual replacement and only explicit confirmation sends its exact digest',async()=>{
  const f=fixture(),flow=f.create();await flow.prepare('doc');
  assert.equal(f.tasks(),0);assert.match(flow.render('doc'),/人工修改 1/);assert.match(flow.render('doc'),/替换历史人工发布/);
  await flow.action('material-auto-confirm');assert.equal(f.tasks(),1);
  assert.equal(f.calls.find(([a])=>a==='material-transition')[1].replacementAcknowledgement,'b'.repeat(64));
  assert.match(flow.render('doc'),/本轮结果已发布/);assert.equal(f.data.size,0);
});
test('lost confirmation response survives refresh and replays the original request without another task',async()=>{
  const f=fixture(),flow=f.create();await flow.prepare('doc');f.lose();await flow.action('material-auto-confirm');
  assert.equal(f.tasks(),1);assert.match(flow.render('doc'),/恢复原确认请求/);
  const original=f.calls.find(([a])=>a==='material-transition')[1];flow.reset();
  const restored=f.create();await restored.restore('doc',f.workflow());
  assert.equal(f.tasks(),1);await restored.action('material-auto-confirm');
  assert.deepEqual(f.calls.filter(([a])=>a==='material-transition').at(-1)[1],original);
  assert.equal(f.tasks(),1);assert.match(restored.render('doc'),/本轮结果已发布/);
  const reopened=f.create();await reopened.restore('doc',f.workflow());assert.match(reopened.render('doc'),/本轮结果已发布/);
});
test('double clicks send one confirmation; stale version requires new preview and explicit consent',async()=>{
  const f=fixture(),flow=f.create();await flow.prepare('doc');
  let finish;f.defer(new Promise(r=>finish=r));const first=flow.action('material-auto-confirm');await flow.action('material-auto-confirm');
  assert.equal(f.calls.filter(([a])=>a==='material-transition').length,1);finish();await first;
  await flow.prepare('doc');f.stale();await flow.action('material-auto-confirm');assert.equal(f.tasks(),1);
  assert.match(flow.render('doc'),/重新预览并确认/);await flow.action('material-auto-confirm');assert.equal(f.tasks(),1);
  const oldPreview=f.calls.filter(([a])=>a==='material-preview').at(-1)[1];await flow.action('material-auto-preview');
  const newPreview=f.calls.filter(([a])=>a==='material-preview').at(-1)[1];
  assert.notEqual(oldPreview.operationId,newPreview.operationId);assert.equal(newPreview.versionId,'v2');
  assert.equal(f.tasks(),1);await flow.action('material-auto-confirm');assert.equal(f.tasks(),2);
});
test('blocked preview and cancelled consent never start processing',async()=>{
  const f=fixture(),flow=f.create();f.block();await flow.prepare('doc');await flow.action('material-auto-confirm');
  assert.match(flow.render('doc'),/他人草稿待处理/);assert.equal(f.tasks(),0);
  await flow.action('material-auto-dismiss');await flow.action('material-auto-confirm');assert.equal(f.tasks(),0);
});
test('authorization failures clear visible impact and cannot expose a foreign receipt',async()=>{
  const f=fixture(),flow=f.create();await flow.prepare('doc');f.deny();await flow.action('material-auto-confirm');
  assert.equal(f.tasks(),0);assert.doesNotMatch(flow.render('doc'),/测试影响|secret body|恢复原确认请求/);
  assert.match(flow.render('doc'),/HTTP 403.*MODELING_OWNER_REQUIRED.*req-denied/);
});
test('late confirmation cannot populate another account and never reports extraction success as publication',async()=>{
  const f=fixture(),flow=f.create();await flow.prepare('doc');
  f.progress({stage:'running',is_current:true,publication_performed:false});await flow.action('material-auto-confirm');
  assert.doesNotMatch(flow.render('doc'),/本轮结果已发布/);
  flow.reset();f.switch();await flow.restore('doc',{latest_transition_id:null});assert.doesNotMatch(flow.render('doc'),/本轮结果已发布|恢复原确认请求/);
});
test('unavailable persistence prevents confirm POST',async()=>{
  const f=fixture();const flow=createMaterialAutomatic({call:async()=>{throw Error('must not send')},changed(){},getContext:()=>({warehouseId,recoveryScope:'owner'}),getStorage:()=>null});
  await flow.prepare('doc');assert.match(flow.render('doc'),/无法保存或读取恢复记录/);
});
test('diagnostics keep HTTP 200 schema failure distinct from network, auth and server failures without source text',async()=>{
  const safe=materialDiagnostic({code:'MODELING_OWNER_REQUIRED',httpStatus:403,requestId:'r1',message:'secret',body:'source',token:'key'});
  assert.deepEqual(safe,{code:'MODELING_OWNER_REQUIRED',category:'authorization',httpStatus:403,requestId:'r1'});
  const service=new SemanticaService({host:{onSessionInvalidated(){},request:async()=>new Response(JSON.stringify({document_id:'wrong'}),{headers:{'x-request-id':'r200'}})}});
  const response=await service.api('/test',{diagnostic:true});
  const value=unwrapMaterialResponse({materialResponse:{ok:true,...response}});
  assert.throws(()=>assertWorkflow(value,'doc','v1'),{code:'MATERIAL_RESPONSE_INVALID',category:'structure',httpStatus:200,requestId:'r200'});
  for(const status of [401,403,404,409,500,502]){
    service.host.request=async()=>new Response(JSON.stringify({code:'MATERIAL_PROCESSING_PREVIEW_STALE',detail:'do not log raw text'}),{status});
    await assert.rejects(service.api('/test',{diagnostic:true}),e=>e.httpStatus===status&&e.requestId&&e.code==='MATERIAL_PROCESSING_PREVIEW_STALE'&&!e.message.includes('raw text'));
  }
  service.host.request=async()=>{throw Error('network secret')};
  await assert.rejects(service.api('/test',{diagnostic:true}),e=>e.category==='network'&&e.httpStatus===null&&!!e.requestId&&!e.message.includes('secret'));
});
test('native automatic requests bind document, warehouse, immutable version, operation and acknowledgement',()=>{
  const base={warehouseId,documentId:'doc',operationId:'12345678-1234-1234-1234-123456789def',workflowRevision:4};
  const preview=materialRequest('material-preview',{...base,versionId:'v1'});
  assert.match(preview.path,/materials\/doc\/processing-previews$/);
  assert.equal(preview.options.body.operation_id,preview.options.body._native_operation_id);
  assert.equal(preview.options.body.expected_document_version_id,'v1');
  const confirm=materialRequest('material-transition',{...base,previewId:'p1',previewDigest:'a'.repeat(64),confirmed:true,replacementAcknowledgement:'b'.repeat(64)});
  assert.equal(confirm.options.body.replacement_acknowledgement,'b'.repeat(64));
  for(const patch of [{documentId:'../doc'},{warehouseId:null},{workspace_id:'foreign'},{confirmed:false},{replacementAcknowledgement:'bad'}])
    assert.throws(()=>materialRequest('material-transition',{...base,previewId:'p',previewDigest:'a'.repeat(64),confirmed:true,...patch}));
});
