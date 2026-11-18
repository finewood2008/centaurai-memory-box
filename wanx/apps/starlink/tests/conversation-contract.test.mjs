import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationRequest,uploadBinding} from '../shared/conversation-contract.mjs';
import {conversationCases} from './fixtures/conversation-contract.mjs';
import {SemanticaService} from '../shell/service.mjs';

test('replacement acknowledgement is strictly validated and forwarded only on automatic transition requests',async()=>{
  const input={warehouseId:'w',documentId:'d',operationId:'op',previewId:'p',previewDigest:'a'.repeat(64),workflowRevision:1,confirmed:true,replacementAcknowledgement:'b'.repeat(64)};
  const r=conversationRequest('conversation-processing-confirm',input);assert.equal(r.body.replacement_acknowledgement,input.replacementAcknowledgement);
  const {replacementAcknowledgement,...old}=input;assert.equal(Object.hasOwn(conversationRequest('conversation-processing-confirm',old).body,'replacement_acknowledgement'),false);
  for(const bad of [null,true,{},[],123,'','b'.repeat(63),'B'.repeat(64),'b'.repeat(65)])assert.throws(()=>conversationRequest('conversation-processing-confirm',{...input,replacementAcknowledgement:bad}));
  assert.throws(()=>conversationRequest('conversation-processing-preview',{warehouseId:'w',documentId:'d',operationId:'op',documentVersionId:'v',workflowRevision:1,replacementAcknowledgement}));
  assert.throws(()=>conversationRequest('conversation-confirm',{warehouseId:'w',conversationId:'c',intentId:'i',operationId:'op',revision:1,conversationRevision:1,planDigest:'a'.repeat(64),confirmed:true,replacementAcknowledgement}));
  let sent;const service=new SemanticaService({host:{context:async()=>({boxId:'b',user:{id:1},dataScope:'personal'}),onSessionInvalidated:()=>()=>{},request:async(path,options)=>{sent=options.body;return new Response('{}');}}});
  await service.call('conversation-processing-confirm',input);assert.deepEqual(sent,r.body);
});

test('warehouse material inventory uses bounded read-only Bridge routes with no caller authority fields',()=>{
  const page=conversationRequest('conversation-material-workflows',{warehouseId:'warehouse',offset:50,limit:50});
  assert.equal(page.method,'GET');assert.equal(page.body,undefined);
  assert.equal(page.path,'/warehouses/warehouse/workbench/conversations/materials?offset=50&limit=50');
  assert.equal(conversationRequest('conversation-material-workflow',{warehouseId:'warehouse',documentId:'document'}).path,'/warehouses/warehouse/workbench/conversations/materials/document');
  for(const input of [{warehouseId:'warehouse',limit:51},{warehouseId:'warehouse',workspace_id:'other'}])assert.throws(()=>conversationRequest('conversation-material-workflows',input));
});
test('all finite conversation actions preserve operation, revisions and editor metadata through service',async()=>{
  const requests=[];
  const service=new SemanticaService({host:{context:async()=>({boxId:'box',user:{id:1},dataScope:'personal'}),
    onSessionInvalidated:()=>()=>{},request:async(path,options)=>{requests.push({path,...options});return new Response(JSON.stringify({status:'accepted'}));}}});
  for(const [action,input] of conversationCases){
    const r=conversationRequest(action,input);assert.ok(r);
    await service.call(action,input);const actual=requests.at(-1);
    assert.equal(actual.path,'/api/semantica'+r.path);assert.deepEqual(actual.body,r.body);
    if(r.method==='POST'){assert.equal(r.body._native_operation_id,input.operationId);
      const nativeOnly=['conversation-review-plan','conversation-editor-leases','conversation-change-context','conversation-change-read',
        'conversation-change-draft','conversation-change-items','conversation-change-preview','conversation-change-publication','conversation-change-source','conversation-change-rule-publish'];
      assert.equal(r.body.operation_id,nativeOnly.includes(action)?undefined:input.operationId);}
    assert.equal(r.body?.workspace_id,undefined);
  }
});
test('scope injection, invalid operation, missing confirmations and bad editor are rejected before transport',()=>{
  for(const [action,input] of conversationCases){assert.throws(()=>conversationRequest(action,{...input,workspace_id:'forged'}));
    if(input.operationId)assert.throws(()=>conversationRequest(action,{...input,operationId:'bad/operation'}));
    if(input.confirmed)assert.throws(()=>conversationRequest(action,{...input,confirmed:false}));
    if(input.editor)assert.throws(()=>conversationRequest(action,{...input,editor:{...input.editor,generation:1}}));
  }
  assert.throws(()=>conversationRequest('conversation-send',{warehouseId:'w',conversationId:'c',operationId:'o',revision:1,content:'😀'.repeat(8001)}));
  assert.equal(conversationRequest('conversation-send',{warehouseId:'w',conversationId:'c',operationId:'o',revision:1,content:'😀'.repeat(8000)}).method,'POST');
  assert.throws(()=>uploadBinding({conversationId:'c'}));assert.throws(()=>uploadBinding({conversationId:'c',intentId:'i',expectedIntentRevision:true}));
});
test('lease discovery uses the fixed correction read wrapper and never exposes session metadata in URL',()=>{
  const r=conversationRequest('conversation-editor-leases',{warehouseId:'w',documentId:'d',operationId:'read',editor:{session:'s'.repeat(30),generation:'1'}});
  assert.equal(r.path,'/warehouses/w/workbench/_correction_read');assert.equal(r.method,'POST');
  assert.deepEqual(r.body,{_native_operation_id:'read',_native_editor:{session:'s'.repeat(30),generation:'1'},path:'/api/documents/d/corrections/leases',query:{}});
});
test('late conversation response is rejected after warehouse or host identity changes',async()=>{
  let resolve,started;const ready=new Promise(r=>started=r);
  const service=new SemanticaService({host:{context:async()=>({boxId:'b',user:{id:1}}),onSessionInvalidated:()=>()=>{},
    request:async()=>{started();return new Promise(r=>resolve=r);}}});
  const pending=service.call(...conversationCases[0]);await ready;service.warehouseGeneration++;
  resolve(new Response('{}'));await assert.rejects(pending,{code:'WAREHOUSE_CHANGED'});
});
