import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:[new URL('../ui/deployment/directory-controller.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {createDirectoryDeploymentController}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const A='a'.repeat(32),B='b'.repeat(32),digest='sha256:'+'c'.repeat(64),APP='ai.wanx.selfmade.'+'d'.repeat(32),releaseId='release-example';
const item=()=>({releaseId,applicationId:APP,name:'合成应用',version:'0.1.0',directoryDigest:digest});
const target=environment=>({organizationId:'org-example',boxId:'box-example',applicationId:APP,environment});
const ref=()=>({releaseId:'expert-release-example',bundleDigest:'sha256:'+'e'.repeat(64)});
const context=()=>({schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,releaseId,applicationId:APP,artifact:{hash:'f'.repeat(64),version:'0.1.0'},target:{organizationId:'org-example',boxId:'box-example',applicationId:APP},environments:[{id:'dev',generation:0,health:'empty',activeReleaseRef:null},{id:'prod',generation:0,health:'empty',activeReleaseRef:null}],supportedActions:['deploy'],supportedCapabilities:['data','foundation']});
const operation=(extra={})=>({id:A,target:target('dev'),kind:'deploy',releaseRef:ref(),state:'queued',phase:'validating',revision:1,createdAt:100,updatedAt:100,deadline:200,commitStatus:'not_committed',committedGeneration:null,previousGeneration:0,components:[],errorCode:null,...extra});
const receipt=()=>({receipt:{receiptId:'receipt-example',operationId:A,outcome:'succeeded',commitStatus:'committed',componentResults:[{componentId:'backend',role:'backend',required:true,status:'ready',actualVersion:'0.1.0'},{componentId:'client',role:'client',required:true,status:'ready',actualVersion:'0.1.0'}],observedAt:'2026-11-13T00:00:00Z'},deliveryStatus:'delivered',attempts:1});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({override}={}){
  const calls=[];let ctx=context(),op=operation(),delivery=null,history=[];
  const request=async(path,method='GET',body)=>{
    calls.push({path,method,body});const custom=override?.(path,method,body);if(custom!==undefined)return custom;
    if(path==='/deployment/directory-releases')return{schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,items:[item()]};
    if(path.endsWith('/ingest'))return item();
    if(path.endsWith('/context'))return structuredClone(ctx);
    if(path.endsWith('/prepare'))return{schemaVersion:1,preparationId:'prepare-example',releaseId,directoryDigest:digest,environment:body.environment,expectedGeneration:0,releaseRef:ref(),target:target(body.environment)};
    if(path.endsWith('/submit'))return structuredClone(op);
    if(path==='/deployment/operations?limit=100')return{items:structuredClone(history)};
    if(path===`/deployment/operations/${A}`)return structuredClone(op);
    if(path===`/deployment/operations/${A}/receipt`)return structuredClone(delivery);
    throw Error('unexpected route '+path);
  };
  const controller=createDirectoryDeploymentController(request);
  return{controller,calls,setContext(value){ctx=value},setOperation(value){op=value},setDelivery(value){delivery=value},setHistory(value){history=value},async ready(){await controller.loadReleases();controller.setReleaseId(releaseId);await controller.ingest();}};
}

test('reading an imported delivery is explicit; only confirmed deploy prepares and submits the selected digest',async()=>{
  const f=fixture();await f.controller.loadReleases();assert.ok(f.calls.every(c=>c.method==='GET'));
  f.controller.setReleaseId(releaseId);await f.controller.ingest();assert.equal(f.controller.getSnapshot().selected.directoryDigest,digest);assert.equal(f.controller.deployReady(),true);
  await f.controller.deploy();assert.equal(f.calls.filter(c=>c.path.endsWith('/prepare')).length,0);
  f.controller.confirm(true);await f.controller.deploy();const prepare=f.calls.find(c=>c.path.endsWith('/prepare')),submit=f.calls.find(c=>c.path.endsWith('/submit'));
  assert.deepEqual(Object.keys(prepare.body).sort(),['directoryDigest','environment','operationId']);assert.equal(prepare.body.directoryDigest,digest);assert.match(prepare.body.operationId,/^[a-f0-9]{32}$/);
  assert.equal(submit.body.preparationId,'prepare-example');assert.equal(f.controller.getSnapshot().operation.state,'queued');assert.equal(f.controller.getSnapshot().pending,false);assert.equal(f.controller.shouldPoll(),true);f.controller.dispose();
});

test('an ambiguous submit retries the same preparation and idempotency key with no fresh preparation',async()=>{
  let first=true;const f=fixture({override:(path)=>{if(path.endsWith('/submit')&&first){first=false;return Promise.reject(Error('HOST_REQUEST_TIMEOUT'))}}});await f.ready();f.controller.confirm(true);await f.controller.deploy();
  assert.equal(f.controller.getSnapshot().pending,true);f.controller.setReleaseId('another-release');f.controller.setEnvironment('prod');assert.equal(f.controller.getSnapshot().releaseId,releaseId);assert.equal(f.controller.getSnapshot().environment,'dev');
  await f.controller.deploy();const posts=f.calls.filter(c=>c.path.endsWith('/submit'));assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(f.calls.filter(c=>c.path.endsWith('/prepare')).length,1);f.controller.dispose();
});

test('unknown profiles, foreign versions and unsupported capabilities never reach prepare',async()=>{
  for(const patch of [{profile:'other-runtime'},{applicationId:'other-app'},{artifact:{hash:'f'.repeat(64),version:'9.0.0'}},{supportedCapabilities:['data','shell']},{supportedCapabilities:['data']},{supportedCapabilities:['data','foundation','foundation']}]){
    const f=fixture();f.setContext({...context(),...patch});await f.ready();f.controller.confirm(true);await f.controller.deploy();assert.ok(f.controller.getSnapshot().importError);assert.equal(f.calls.some(c=>c.path.endsWith('/prepare')),false);f.controller.dispose();
  }
});

test('paths are not release IDs and an unavailable directory capability cannot ingest',async()=>{
  const f=fixture();await f.controller.loadReleases();for(const value of ['../app','/tmp/app','file:///app','app/subdirectory']){f.controller.setReleaseId(value);await f.controller.ingest();}assert.equal(f.calls.some(c=>c.path.endsWith('/ingest')),false);f.controller.dispose();
  const no=fixture({override:path=>path==='/deployment/directory-releases'?Promise.resolve({schemaVersion:1,profile:'wanx-expert-app-v1',available:false,reason:'DEPLOYMENT_ADAPTER_UNAVAILABLE',items:[]}):undefined});await no.controller.loadReleases();no.controller.setReleaseId(releaseId);await no.controller.ingest();assert.ok(no.calls.every(c=>c.method==='GET'));no.controller.dispose();
});

test('a late import or preparation cannot publish into another selected release or a disposed scope',async()=>{
  const importGate=deferred(),f=fixture({override:path=>path.endsWith('/ingest')?importGate.promise:undefined});await f.controller.loadReleases();f.controller.setReleaseId(releaseId);const pending=f.controller.ingest();await tick();f.controller.setReleaseId('another-release');importGate.resolve(item());await pending;assert.equal(f.controller.getSnapshot().selected,null);assert.equal(f.calls.some(c=>c.path.endsWith('/context')),false);f.controller.dispose();
  const prepareGate=deferred(),g=fixture({override:path=>path.endsWith('/prepare')?prepareGate.promise:undefined});await g.ready();g.controller.confirm(true);const deployment=g.controller.deploy();await tick();g.controller.dispose();prepareGate.resolve({schemaVersion:1,preparationId:'prepare-example',releaseId,directoryDigest:digest,environment:'dev',expectedGeneration:0,releaseRef:ref(),target:target('dev')});await deployment;assert.equal(g.calls.some(c=>c.path.endsWith('/submit')),false);
});

test('a refresh failure retains visible operation but disables mutations until a fresh successful read',async()=>{
  let broken=false;const f=fixture({override:path=>broken&&path.endsWith('/context')?Promise.reject(Error('AUTH_FAILED')):undefined});await f.ready();f.controller.confirm(true);await f.controller.deploy();f.setOperation(operation({state:'succeeded',revision:2,commitStatus:'committed',committedGeneration:1}));await f.controller.refresh();broken=true;await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().operation.state,'succeeded');assert.ok(f.controller.getSnapshot().readError);assert.equal(f.controller.deployReady(),false);f.controller.confirm(true);await f.controller.deploy();assert.equal(f.calls.filter(c=>c.path.endsWith('/submit')).length,1);
  broken=false;await f.controller.refresh();assert.equal(f.controller.deployReady(),true);f.controller.dispose();
});

test('operation responses must match the prepared target, release and generation',async()=>{
  for(const bad of [operation({target:target('prod')}),operation({releaseRef:{...ref(),bundleDigest:'sha256:'+'0'.repeat(64)}}),operation({previousGeneration:4})]){
    const f=fixture();f.setOperation(bad);await f.ready();f.controller.confirm(true);await f.controller.deploy();assert.equal(f.controller.getSnapshot().operation,null);assert.equal(f.controller.getSnapshot().pending,true);assert.ok(f.controller.getSnapshot().deploymentError);f.controller.dispose();
  }
});

test('polling reports actual components and delivered receipt without issuing writes',async()=>{
  const f=fixture();await f.ready();f.controller.confirm(true);await f.controller.deploy();const posts=f.calls.filter(c=>c.method==='POST').length;
  f.setOperation(operation({state:'succeeded',revision:2,commitStatus:'committed',committedGeneration:1,components:receipt().receipt.componentResults}));f.setDelivery(receipt());await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().operation.components.length,2);assert.equal(f.controller.getSnapshot().receipt.deliveryStatus,'delivered');assert.equal(f.controller.shouldPoll(),false);assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);f.controller.dispose();
});

test('history recovery filters exact owner target scope and environment instead of showing a foreign operation',async()=>{
  const f=fixture();f.setHistory([operation({id:B,target:{...target('dev'),boxId:'other-box'}}),operation({target:target('prod')}),operation({id:B,target:{...target('dev'),organizationId:'other-org'}})]);await f.ready();assert.equal(f.controller.getSnapshot().operation,null);f.controller.dispose();
});

test('a definite preparation rejection releases the attempt and requires refreshed confirmation',async()=>{
  const f=fixture({override:path=>path.endsWith('/prepare')?Promise.reject(Error('DEPLOYMENT_DEV_VERIFICATION_REQUIRED')):undefined});await f.ready();f.controller.setEnvironment('prod');f.controller.confirm(true);await f.controller.deploy();assert.equal(f.controller.getSnapshot().pending,false);assert.equal(f.controller.getSnapshot().confirmed,false);assert.ok(f.controller.getSnapshot().readError);assert.equal(f.calls.some(c=>c.path.endsWith('/submit')),false);f.controller.dispose();
});

test('refresh requires renewed confirmation and cannot redirect an uncertain request to another box',async()=>{
  const f=fixture();await f.ready();f.controller.confirm(true);await f.controller.refresh();assert.equal(f.controller.getSnapshot().confirmed,false);f.controller.dispose();
  const g=fixture({override:path=>path.endsWith('/submit')?Promise.reject(Error('HOST_REQUEST_TIMEOUT')):undefined});await g.ready();g.controller.confirm(true);await g.controller.deploy();
  g.setContext({...context(),target:{...context().target,boxId:'replacement-box'}});await g.controller.refresh();assert.ok(g.controller.getSnapshot().readError);assert.equal(g.controller.deployReady(),false);
  await g.controller.deploy();assert.equal(g.calls.filter(c=>c.path.endsWith('/submit')).length,1);g.controller.dispose();
});

test('concurrent confirmations never prepare or submit a duplicate deployment',async()=>{
  const gate=deferred(),f=fixture({override:path=>path.endsWith('/prepare')?gate.promise:undefined});await f.ready();f.controller.confirm(true);const first=f.controller.deploy();await tick();await f.controller.deploy();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/prepare')).length,1);gate.resolve({schemaVersion:1,preparationId:'prepare-example',releaseId,directoryDigest:digest,environment:'dev',expectedGeneration:0,releaseRef:ref(),target:target('dev')});await first;
  assert.equal(f.calls.filter(c=>c.path.endsWith('/submit')).length,1);f.controller.dispose();
});
