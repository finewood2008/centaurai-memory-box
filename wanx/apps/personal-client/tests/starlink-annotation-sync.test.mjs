import test from 'node:test';
import assert from 'node:assert/strict';
import {syncStarlinkAnnotation,readStarlinkAnnotation} from '../../builder/integration/personal-client/starlink-annotation-sync.mjs';

function fixture() {
  const binding={id:'a'.repeat(32),digest:'b'.repeat(64),documentId:'doc1',versionId:'v1',warehouseId:'warehouse1',annotationRevision:2,
    snapshot:{tags:['制造业'],description:'说明',needsReview:false,provenance:[{tag:'制造业',source:'manual',itemId:'a'.repeat(32)}]}};
  const calls=[]; let saved=null, failWrite=false, active=true;
  const check=()=>{if(!active)throw Object.assign(Error('HOST_SESSION_EXPIRED'),{code:'HOST_SESSION_EXPIRED'});};
  const service={capabilities:{source_annotations:{version:1}},async api(path,options={}) {
    calls.push({path,...options});
    if(options.method==='PUT') {
      if(failWrite)throw Object.assign(Error('network'),{code:'SEMANTICA_CONNECTION_FAILED'});
      const {operation_id,expected_document_version_id,expected_revision,...annotation}=options.body;
      saved={document_id:binding.documentId,document_version_id:binding.versionId,revision:1,annotation,index_status:'not_indexed'};
      return saved;
    }
    return saved || {document_id:binding.documentId,revision:0,annotation:null,index_status:'not_indexed'};
  }};
  return {binding,calls,service,check,setSaved:value=>saved=value,fail:value=>failWrite=value,expire:()=>active=false,
    sync:()=>syncStarlinkAnnotation({binding,service,check})};
}

test('server receipt distinguishes saved metadata from unbuilt search indexes and retries are idempotent',async()=>{
  const f=fixture(); assert.deepEqual(await f.sync(),{status:'saved',revision:1,indexStatus:'not_indexed'});
  assert.equal(f.calls[1].body.expected_revision,0);
  const wire=f.calls[1].body;
  f.setSaved({document_id:'doc1',document_version_id:'v1',revision:1,index_status:'not_indexed',annotation:{
    needs_review:wire.needs_review,description:wire.description,provenance:wire.provenance,tags:wire.tags,source:wire.source}});
  assert.equal((await f.sync()).status,'saved');
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});

test('a fresh session retries the same operation and cannot overwrite a different remote revision',async()=>{
  const f=fixture();f.fail(true);assert.equal((await f.sync()).status,'pending');
  const first=f.calls[1].body.operation_id;f.fail(false);assert.equal((await f.sync()).status,'saved');
  assert.equal(f.calls.filter(c=>c.method==='PUT')[1].body.operation_id,first);
  f.binding.snapshot.description='另一份说明';
  assert.equal((await f.sync()).status,'conflict');assert.equal(f.calls.filter(c=>c.method==='PUT').length,2);
});

test('old services never receive unsupported writes and expired sessions cannot publish metadata',async()=>{
  const f=fixture();f.service.capabilities={};assert.equal((await f.sync()).status,'unsupported');assert.equal(f.calls.length,0);
  f.service.capabilities={source_annotations:{version:1}};f.expire();await assert.rejects(f.sync(),{code:'HOST_SESSION_EXPIRED'});
});

test('an authorized document can display persisted metadata without any local Space import binding',async()=>{
  const f=fixture();await f.sync();
  const read=()=>readStarlinkAnnotation({service:f.service,warehouseId:f.binding.warehouseId,documentId:'doc1',versionId:'v1',check:f.check});
  const result=await read();assert.deepEqual(result.sourceAnnotation.snapshot.tags,['制造业']);
  assert.equal(result.sourceAnnotation.remoteOnly,true);assert.equal(result.annotationSync.status,'saved');
  const stale=await readStarlinkAnnotation({service:f.service,warehouseId:f.binding.warehouseId,documentId:'doc1',versionId:'v2',check:f.check});
  assert.equal(stale.annotationSync.status,'stale');
});

test('missing or mismatched import snapshots cannot trigger server reads or writes',async()=>{
  for(const change of [{snapshot:undefined},{annotationRevision:0},{snapshot:{tags:['后补标签'],description:'',revision:99}}]) {
    const f=fixture();Object.assign(f.binding,change);
    assert.equal((await f.sync()).status,'missing_snapshot');assert.equal(f.calls.length,0);
  }
});

test('metadata retry keeps the exact frozen payload while a request is in flight',async()=>{
  const f=fixture();let release;
  const initialApi=f.service.api;
  f.service.api=async(path,options)=>{
    if(!options)await new Promise(resolve=>release=resolve);
    return initialApi(path,options);
  };
  const pending=f.sync();
  f.binding.snapshot.tags.push('后续标签');f.binding.snapshot.description='后续说明';
  release();assert.equal((await pending).status,'saved');
  const written=f.calls.find(row=>row.method==='PUT').body;
  assert.deepEqual(written.tags,['制造业']);assert.equal(written.description,'说明');
});
