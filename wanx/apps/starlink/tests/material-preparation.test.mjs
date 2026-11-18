import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {materialImportHTML,materialPreparationIndex} from '../ui/material-import.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';

function harness(){
  const store=new Map(),calls=[],receipts=new Map();let sequence=0;
  const db={version:'v',lose:false,wrongReceipt:false,confirmationCount:0,retryCount:0,publication:null,draft:null,stage:'source_ready',
    preparation:{status:'awaiting_confirmation',ready:false,source_review:{status:'unconfirmed',confirmation_id:null,confirmed_version_id:null},indexing:{document_version_id:'v',status:'not_started',retryable:false}}};
  const f=new ConversationFlow({warehouseId:'w',identity:{boxId:'b',user:{id:1}},uuid:()=>`op-${++sequence}`,storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},call:async(action,input)=>{
    calls.push({action,input:structuredClone(input)});
    if(action==='document')return {document:{id:'d',segment_count:1},version:{id:db.version},segments:[{id:'s',text:'正文'}]};
    if(action==='conversation-material-workflow')return structuredClone({document_id:'d',document_version_id:db.version,document:{id:'d',status:'ready'},stage:db.stage,draft:db.draft,publication:db.publication,tasks:[],conversations:[],preparation:db.preparation});
    if(['conversation-source-confirm','conversation-index-retry'].includes(action)){
      assert.equal(input.documentVersionId,db.version);
      let result=receipts.get(input.operationId);
      if(!result){
        if(action==='conversation-source-confirm'){assert.equal(input.confirmed,true);db.confirmationCount++;}
        else{assert.equal(input.confirmationId,'confirmation');db.retryCount++;}
        db.preparation={status:'indexing',ready:false,source_review:{status:'confirmed',confirmation_id:'confirmation',confirmed_version_id:db.version},indexing:{document_version_id:db.version,status:'queued',job_id:'job',retryable:false}};
        result={receipt:{operation_id:input.operationId,document_id:db.wrongReceipt?'other':'d',document_version_id:db.version,confirmation_id:'confirmation',index_status:'queued',extraction_started:false,publication_performed:false}};
        receipts.set(input.operationId,result);
      }
      if(db.lose){db.lose=false;throw Object.assign(Error('offline'),{status:0});}
      return structuredClone(result);
    }
    throw Error('Unexpected '+action);
  }});
  f.state.loaded=true;f.state.materialPage='import';f.snapshot=async()=>{};f.continueUploads=async()=>{};
  return {f,db,calls};
}
test('source commands use the registered scoped bridge contract',()=>{
  const input={warehouseId:'w',documentId:'d',documentVersionId:'v',operationId:'op'};
  const confirm=conversationRequest('conversation-source-confirm',{...input,confirmed:true});
  assert.equal(confirm.path,'/warehouses/w/workbench/documents/d/source-confirmations');
  assert.deepEqual(confirm.body,{_native_operation_id:'op',operation_id:'op',expected_document_version_id:'v',confirmed:true});
  const retry=conversationRequest('conversation-index-retry',{...input,confirmationId:'c'});
  assert.equal(retry.path,'/warehouses/w/workbench/documents/d/index-retries');assert.equal(retry.body.confirmation_id,'c');
  assert.throws(()=>conversationRequest('conversation-source-confirm',{...input,confirmed:false}));
  assert.throws(()=>conversationRequest('conversation-index-retry',input));
});
test('preparation readiness requires a complete current-version index snapshot',()=>{
  const view={source:{version:{id:'current'}},workflow:{preparation:{ready:true,indexing:{status:'ready',document_version_id:'old'}}}};
  assert.equal(materialPreparationIndex(view),'unknown');
  view.workflow.preparation.indexing.document_version_id='current';assert.equal(materialPreparationIndex(view),'ready');
  view.source.version=null;view.workflow.preparation={};assert.equal(materialPreparationIndex(view),'unknown');
});
test('local confirmation cannot fake server confirmation; durable confirmation starts indexing and survives reload',async()=>{
  const {f,db,calls}=harness();f.saved.importReviews={d:'v'};await f.importer.read('d');
  assert.equal(f.importer.confirmed,false);assert.match(materialImportHTML(f,''),/确认正文并建立索引/);
  await f.importer.confirm();assert.equal(f.state.error,'');assert.equal(db.confirmationCount,1);assert.equal(f.importer.confirmed,true);
  assert.match(materialImportHTML(f,''),/索引任务正在排队/);assert.equal(f.importer.complete,false);
  delete f.saved.importReviews;await f.importer.read('d');assert.equal(f.importer.confirmed,true);
  db.preparation.ready=true;db.preparation.indexing.status='ready';await f.importer.read('d');assert.equal(f.importer.complete,true);
  assert.equal(calls.some(c=>c.action==='workbench-request'||c.action==='conversation-processing-confirm'),false);
});

test('server-exempt historical material stays ready across reopening without local confirmation or writes',async()=>{
  const {f,db,calls}=harness();
  db.stage='published';db.publication={id:'run',status:'published',document_version_id:'v'};
  db.preparation={status:'ready',ready:true,source_review:{status:'not_required',confirmed_version_id:null},indexing:{status:'ready',document_version_id:'v',retryable:false}};
  for(let opening=0;opening<2;opening++){
    delete f.saved.importReviews;await f.importer.select('d');
    assert.equal(f.importer.confirmed,true);assert.equal(f.importer.complete,true);
    const html=materialImportHTML(f,'');
    assert.match(html,/无需重复确认/);assert.match(html,/当前正文索引已就绪/);
    assert.doesNotMatch(html,/data-cv="import-confirm"|当前正文尚未完成确认|当前版本已在服务端确认|请核对内容后确认正文/);
  }
  assert.equal(db.confirmationCount,0);
  assert.equal(calls.some(c=>/confirm|retry|publish/.test(c.action)),false);
});

test('a shared index update preserves published material and never starts another extraction',async()=>{
  const {f,db,calls}=harness();
  db.stage='published';db.publication={id:'run',status:'published',document_version_id:'v'};
  db.preparation={status:'indexing',ready:false,source_review:{status:'not_required'},indexing:{status:'running',document_version_id:'v',retryable:false}};
  f.state.deletionNotice='另一份材料删除已受理。';
  for(const status of ['running','queued']){
    db.preparation.indexing.status=status;await f.importer.read('d');
    const html=materialImportHTML(f,'');
    assert.match(html,/更新检索索引/);assert.match(html,/已有发布知识保留/);
    assert.match(html,/不会重新抽取当前材料/);assert.doesNotMatch(html,/服务端正在建立索引/);
    assert.equal(f.importer.complete,false);
  }
  assert.ok(calls.every(call=>['document','conversation-material-workflow'].includes(call.action)));
  db.preparation.indexing.status='ready';db.preparation.ready=true;await f.importer.read('d');
  assert.equal(f.importer.complete,true);assert.doesNotMatch(materialImportHTML(f,''),/数据仓检索索引正在更新/);
});

test('a publication for an older body version does not label a first index build as maintenance',async()=>{
  const {f,db}=harness();
  db.publication={id:'old-run',status:'published',document_version_id:'old'};
  db.preparation={status:'indexing',ready:false,source_review:{status:'not_required'},indexing:{status:'running',document_version_id:'v',retryable:false}};
  await f.importer.read('d');
  assert.match(materialImportHTML(f,''),/服务端正在建立索引/);
  assert.doesNotMatch(materialImportHTML(f,''),/已有发布知识保留/);
});

test('server review requirements and current-version indexing remain authoritative for historical material',async()=>{
  const {f,db}=harness();f.saved.importReviews={d:'v'};
  db.preparation={status:'ready',ready:true,source_review:{status:'not_required'},indexing:{status:'ready',document_version_id:'old',retryable:false}};
  await f.importer.read('d');assert.equal(f.importer.confirmed,true);assert.equal(f.importer.complete,false);
  for(const review of [{status:'unconfirmed'},{status:'stale',confirmed_version_id:'old'},{status:'confirmed',confirmed_version_id:'old'},undefined]){
    db.preparation.source_review=review;await f.importer.read('d');
    assert.equal(f.importer.confirmed,false);assert.equal(f.importer.complete,false);
  }
  db.preparation.source_review={status:'not_required'};db.preparation.indexing.document_version_id='v';db.preparation.indexing.status='running';
  await f.importer.read('d');assert.equal(f.importer.confirmed,true);assert.equal(f.importer.complete,false);
});
test('failed index shows cause and explicit scoped retry, never starts extraction',async()=>{
  const {f,db}=harness();await f.importer.read('d');await f.importer.confirm();
  Object.assign(db.preparation.indexing,{status:'failed',retryable:true,error:{code:'EMBEDDING_ERROR',detail:'模型服务不可用'}});
  await f.importer.read('d');const html=materialImportHTML(f,'');assert.match(html,/模型服务不可用/);assert.match(html,/import-index-retry/);
  await f.importer.retryIndex();assert.equal(db.retryCount,1);assert.equal(f.state.error,'');
  assert.match(materialImportHTML(f,''),/索引任务正在排队/);
  await f.importer.retryIndex();assert.equal(db.retryCount,1);
});
test('unknown confirmation is recovered with the original operation and no duplicate index scheduling',async()=>{
  const {f,db,calls}=harness();await f.importer.read('d');db.lose=true;await f.importer.confirm();
  assert.ok(f.saved.pending);assert.equal(db.confirmationCount,1);
  const original=structuredClone(f.saved.pending.input);await f.retryPending();assert.equal(f.saved.pending,null);
  assert.equal(db.confirmationCount,1);assert.equal(f.importer.confirmed,true);
  assert.deepEqual(calls.filter(c=>c.action==='conversation-source-confirm').map(c=>c.input),[original,original]);
});
test('source version drift and malformed acceptance never mark the wrong material confirmed',async()=>{
  const {f,db}=harness();await f.importer.read('d');db.version='new';await f.importer.confirm();
  assert.equal(db.confirmationCount,0);assert.equal(f.state.errorCode,'MODELING_SOURCE_CHANGED');
  db.version='v';await f.importer.read('d');db.wrongReceipt=true;await f.importer.confirm();
  assert.equal(f.saved.importReviews,undefined);assert.ok(f.saved.pending);assert.equal(f.state.errorCode,'SEMANTICA_INVALID_RESPONSE');
});
test('fresh publication removes the pending review entry; a genuine new draft preserves the published baseline',async()=>{
  const {f,db}=harness();db.stage='draft';db.draft={status:'editing'};await f.importer.read('d');
  assert.match(materialImportHTML(f,''),/继续核对草稿/);
  db.stage='published';db.draft=null;db.publication={id:'run',status:'published',document_version_id:'v'};await f.importer.read('d');
  assert.doesNotMatch(materialImportHTML(f,''),/继续核对草稿/);
  db.stage='draft';db.draft={status:'editing',submitted_at:'2026-11-11T00:00:00Z'};await f.importer.read('d');
  assert.doesNotMatch(materialImportHTML(f,''),/继续核对草稿/);
  db.draft={status:'editing',submitted_at:null};await f.importer.read('d');
  assert.match(materialImportHTML(f,''),/已发布 · 草稿状态待确认/);assert.match(materialImportHTML(f,''),/继续核对草稿/);
  db.draft.has_changes=false;await f.importer.read('d');
  assert.doesNotMatch(materialImportHTML(f,''),/有未发布修改/);
  db.draft.has_changes=true;await f.importer.read('d');
  assert.match(materialImportHTML(f,''),/已发布 · 有未发布修改/);
});
