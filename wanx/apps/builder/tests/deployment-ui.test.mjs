import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

async function moduleAt(file) {
  const result=await build({entryPoints:[new URL(file,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const {createDeploymentController}=await moduleAt('../ui/deployment/controller.ts');
const {parseDelivery,parseOperation,stateLabel,errorMessage,canResume}=await moduleAt('../ui/deployment/model.ts');
const A='a'.repeat(32),B='b'.repeat(32),APP='ai.wanx.selfmade.example';
const capabilities={schemaVersion:1,available:true,reason:null,operations:['deploy','promote','rollback','restart']};
const operation=(id=A,extra={})=>({id,target:{organizationId:'org-example',boxId:'box-example',applicationId:APP,environment:'dev'},kind:'deploy',releaseRef:{releaseId:'release-example',bundleDigest:'sha256:'+'a'.repeat(64)},state:'queued',phase:'validating',revision:1,createdAt:100,updatedAt:100,deadline:200,commitStatus:'not_committed',committedGeneration:null,previousGeneration:0,components:[],...extra});
const event=(sequence,id=A)=>({sequence,operationId:id,operationRevision:sequence,createdAt:100+sequence,type:'progress',state:'preparing',phase:'prepare_backend'});
const page=(items,after=0,hasMore=false)=>({items,nextCursor:items.at(-1)?.sequence??after,hasMore});
const receipt=(status='pending',id=A)=>({receipt:{receiptId:'receipt-example',operationId:id,outcome:'succeeded',commitStatus:'committed',componentResults:[],observedAt:'2026-11-13T00:00:00Z'},deliveryStatus:status,attempts:1});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function harness({operations=[operation()],caps=capabilities,delivery=null,override}={}) {
  const calls=[];
  const request=async(path,method='GET',body)=>{
    calls.push({path,method,body});
    const custom=override?.(path,method,body);
    if(custom!==undefined)return custom;
    if(path==='/deployment/capabilities')return caps;
    if(path==='/deployment/operations?limit=100')return{items:operations};
    const id=path.match(/\/operations\/([a-f0-9]{32})/)?.[1];
    if(path.endsWith('/receipt/retry'))return delivery;
    if(path.endsWith('/receipt'))return delivery;
    if(path.includes('/events?'))return page([],Number(new URL('http://example'+path).searchParams.get('after')));
    if(path.endsWith('/resume')||/^\/deployment\/operations\/[a-f0-9]{32}$/.test(path))return operations.find(item=>item.id===id);
    throw new Error('unexpected path');
  };
  return {controller:createDeploymentController(request,APP),calls};
}

test('unavailable capabilities remain distinct from empty history and never submit a synthetic deployment',async()=>{
  const {controller,calls}=harness({operations:[],caps:{...capabilities,available:false,reason:'DEPLOYMENT_ADAPTER_UNAVAILABLE'}});
  await controller.refresh();await controller.resume();await controller.retryReceipt();
  assert.equal(controller.getSnapshot().capabilities.available,false);
  assert.deepEqual(controller.getSnapshot().operations,[]);
  assert.equal(controller.getSnapshot().listError,'');
  assert.equal(controller.shouldPoll(),false);
  assert.ok(calls.every(call=>call.method==='GET'));
  controller.dispose();
});

test('recent owner history is fetched with the actual all-or-complete-target contract and filters only the exact app identity',async()=>{
  const foreign=operation(B,{target:{...operation().target,applicationId:'different-app'}});
  const {controller,calls}=harness({operations:[foreign,operation()]});
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().operations.map(item=>item.id),[A]);
  assert.equal(controller.getSnapshot().listedCount,2);
  assert.equal(controller.getSnapshot().selectedId,A);
  assert.ok(calls.some(call=>call.path==='/deployment/operations?limit=100'));
  assert.ok(!calls.some(call=>call.path.includes(B)||call.path.includes('applicationId=')));
  controller.dispose();
});

test('permission failure is not empty success, and untrusted exception details never become visible copy',async()=>{
  const {controller}=harness({override:path=>path==='/deployment/capabilities'?Promise.reject(Object.assign(new Error('private-token-value'),{code:'STUDIO_ADMIN_REQUIRED'})):path==='/deployment/operations?limit=100'?Promise.reject(new Error('private-token-value')):undefined});
  await controller.refresh();
  const state=controller.getSnapshot();
  assert.match(state.capabilityError,/权限/);assert.ok(state.listError);assert.equal(state.loading,false);
  assert.doesNotMatch(JSON.stringify(state),/private-token-value/);
  assert.doesNotMatch(errorMessage(new Error('https://private-host/token=secret')),/secret|private-host/);
  controller.dispose();
});

test('disposed account/project requests cannot publish data into the replacement scope',async()=>{
  const pending=deferred();const old=harness({override:path=>path==='/deployment/operations?limit=100'?pending.promise:undefined});
  let notifications=0;old.controller.subscribe(()=>notifications++);
  const refresh=old.controller.refresh();await turn();old.controller.dispose();const count=notifications;
  const next=harness({operations:[]});await next.controller.refresh();pending.resolve({items:[operation()]});await refresh;
  assert.equal(notifications,count);assert.deepEqual(next.controller.getSnapshot().operations,[]);
  assert.equal(old.controller.shouldPoll(),false);next.controller.dispose();
});

test('a late detail response for a deselected operation cannot replace the current detail or load its receipt',async()=>{
  const pending=deferred();const {controller,calls}=harness({operations:[operation(),operation(B)],override:path=>path===`/deployment/operations/${A}`?pending.promise:undefined});
  const refresh=controller.refresh();await turn();await controller.select(B);pending.resolve(operation());await refresh;
  assert.equal(controller.getSnapshot().selectedId,B);assert.equal(controller.getSnapshot().operation.id,B);
  assert.ok(!calls.some(call=>call.path===`/deployment/operations/${A}/receipt`));controller.dispose();
});

test('event pagination uses the returned cursor, appends in order, and never restarts at zero on refresh',async()=>{
  const {controller,calls}=harness({override:path=>path.includes('/events?')?(path.includes('after=0&')?page([event(1)],0,true):path.includes('after=1&')?page([event(2)],1,false):page([],2)):undefined});
  await controller.refresh();assert.equal(controller.getSnapshot().hasMore,true);await controller.loadEvents();await controller.refresh();
  assert.deepEqual(controller.getSnapshot().events.map(item=>item.sequence),[1,2]);
  assert.equal(controller.getSnapshot().nextCursor,2);
  assert.equal(calls.filter(call=>call.path.includes('/events?after=0&')).length,1);
  assert.ok(calls.some(call=>call.path.includes('/events?after=2&')));controller.dispose();
});

test('a cross-operation event page is rejected without rendering it or losing previously read events',async()=>{
  const {controller}=harness({override:path=>path.includes('/events?')?(path.includes('after=0&')?page([event(1)],0,true):page([event(2,B)],1)):undefined});
  await controller.refresh();await controller.loadEvents();
  assert.deepEqual(controller.getSnapshot().events.map(item=>item.sequence),[1]);
  assert.equal(controller.getSnapshot().nextCursor,1);assert.match(controller.getSnapshot().eventsError,/无法识别/);controller.dispose();
});

test('202 resume preserves queued state and a normal refresh does not call resume',async()=>{
  const {controller,calls}=harness();await controller.refresh();await controller.refresh();
  assert.ok(calls.every(call=>call.method==='GET'));await controller.resume();
  assert.equal(controller.getSnapshot().operation.state,'queued');
  assert.match(controller.getSnapshot().notice,/实际状态/);
  const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);
  assert.equal(writes[0].path,`/deployment/operations/${A}/resume`);assert.deepEqual(writes[0].body,{});controller.dispose();
});

test('terminal, unknown-state, unknown-kind, and unavailable operations cannot be resumed',async()=>{
  for(const [op,caps] of [[operation(A,{state:'succeeded'}),capabilities],[operation(A,{state:'future_state'}),capabilities],[operation(A,{kind:'future_kind'}),capabilities],[operation(),{...capabilities,available:false,reason:'DEPLOYMENT_ADAPTER_UNAVAILABLE'}]]){
    const {controller,calls}=harness({operations:[op],caps});await controller.refresh();await controller.resume();
    assert.ok(calls.every(call=>call.method==='GET'));controller.dispose();
  }
  assert.equal(stateLabel('committing'),'正在提交版本切换');
  assert.equal(stateLabel('future_state'),'未知任务状态');
  assert.equal(canResume(operation(A,{state:'committing'}),capabilities),true);
});

test('a successful HTTP receipt retry with pending delivery never reports receipt sent or reruns deployment',async()=>{
  const {controller,calls}=harness({operations:[operation(A,{state:'succeeded'})],delivery:receipt()});
  await controller.refresh();await controller.retryReceipt();
  assert.equal(controller.getSnapshot().receipt.deliveryStatus,'pending');
  assert.match(controller.getSnapshot().notice,/仍待送达/);assert.doesNotMatch(controller.getSnapshot().notice,/已送达/);
  assert.deepEqual(calls.filter(call=>call.method==='POST').map(call=>call.path),[`/deployment/operations/${A}/receipt/retry`]);controller.dispose();
});

test('detail refresh during a receipt retry cannot invalidate or overwrite the delivered mutation response',async()=>{
  const pending=deferred();const {controller,calls}=harness({operations:[operation(A,{state:'succeeded'})],delivery:receipt(),override:(path,method)=>method==='POST'?pending.promise:undefined});
  await controller.refresh();const before=calls.filter(call=>call.path.endsWith('/receipt')).length;
  const retry=controller.retryReceipt();await turn();await controller.select(A);
  assert.equal(calls.filter(call=>call.path.endsWith('/receipt')).length,before);
  pending.resolve({...receipt('delivered'),attempts:2});await retry;
  assert.equal(controller.getSnapshot().receipt.deliveryStatus,'delivered');assert.equal(controller.getSnapshot().receipt.attempts,2);
  assert.match(controller.getSnapshot().notice,/已送达/);assert.equal(controller.shouldPoll(),false);controller.dispose();
});

test('real backend receipt fixtures accept nullable component versions and only retain public renderer fields',async()=>{
  for(const file of ['success.receipt.json','rejected.receipt.json','failed-recovered.receipt.json','failed-degraded.receipt.json','recovery-required.receipt.json']){
    const source=JSON.parse(await readFile(new URL(`../backend/tests/fixtures/deployment/${file}`,import.meta.url),'utf8'));
    source.operationId=A;
    const value=parseDelivery({receipt:source,deliveryStatus:'pending',attempts:0},A);
    assert.equal(value.receipt.outcome,source.outcome);
    assert.equal(value.receipt.componentResults.length,source.componentResults.length);
    const op=parseOperation({...operation(),components:source.componentResults,checkpoint:{secret:'not-for-renderer'},owner:'not-for-renderer'});
    assert.ok(!('checkpoint' in op));assert.ok(!('owner' in op));
  }
  const op=parseOperation(operation(A,{components:[{componentId:'backend',role:'backend',required:true,status:'unknown',actualReleaseRef:null,actualVersion:null}]}));
  assert.equal(op.errorCode,null);assert.equal(op.components[0].actualVersion,undefined);
});

test('stale detail, capability, or list errors prevent mutations until a successful refresh',async()=>{
  for(const route of ['/deployment/capabilities','/deployment/operations?limit=100',`/deployment/operations/${A}`]){
    let broken=false;
    const {controller,calls}=harness({delivery:receipt(),override:path=>broken&&path===route?Promise.reject(new Error('AUTH_FAILED')):undefined});
    await controller.refresh();broken=true;await controller.refresh();await controller.resume();await controller.retryReceipt();
    assert.ok(calls.every(call=>call.method==='GET'));
    broken=false;await controller.refresh();await controller.resume();
    assert.ok(calls.some(call=>call.method==='POST'));controller.dispose();
  }
});


const PROJECT='c'.repeat(32),HASH='d'.repeat(64),PREPARATION='prepare-'+'e'.repeat(32);
const deploymentContext=()=>({schemaVersion:1,profile:'wanx-miniapp-v1',available:true,reason:null,projectId:PROJECT,applicationId:APP,artifact:{hash:HASH,version:'0.1.0'},target:{organizationId:'org-example',boxId:'box-example',applicationId:APP},environments:[{id:'dev',generation:0,health:'empty',activeReleaseRef:null},{id:'prod',generation:0,health:'empty',activeReleaseRef:null}],supportedActions:['deploy']});
function submissionHarness({context=deploymentContext(),override}={}) {
 const calls=[];
 const preparation={schemaVersion:1,preparationId:PREPARATION,projectId:PROJECT,artifactHash:HASH,environment:'dev',expectedGeneration:0,releaseRef:operation().releaseRef,target:operation().target};
 const request=async(path,method='GET',body)=>{
  calls.push({path,method,body});const custom=override?.(path,method,body);if(custom!==undefined)return custom;
  if(path===`/projects/${PROJECT}/deployment/context`)return context;
  if(path==='/deployment/capabilities')return capabilities;
  if(path==='/deployment/operations?limit=100')return{items:[]};
  if(path.endsWith('/deployment/prepare'))return preparation;
  if(path.endsWith('/deployment/submit')||path===`/deployment/operations/${A}`)return operation();
  if(path.includes('/events?'))return page([]);
  if(path.endsWith('/receipt'))return null;
  throw new Error('Unexpected test route');
 };
 return{controller:createDeploymentController(request,APP,PROJECT),calls};
}

test('trusted project context enables prepare and 202 submit without fabricating target or announcing completion',async()=>{
 const {controller,calls}=submissionHarness();await controller.refresh();assert.equal(controller.deployReady(HASH,4,'dev'),true);
 assert.ok(calls.every(call=>call.method==='GET'));
 await controller.deploy(HASH,4,'dev');
 const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,2);
 assert.deepEqual(Object.keys(writes[0].body).sort(),['artifactHash','environment','expectedRevision','operationId']);
 assert.equal(writes[0].body.artifactHash,HASH);assert.equal(writes[0].body.expectedRevision,4);
 assert.deepEqual(Object.keys(writes[1].body).sort(),['idempotencyKey','preparationId']);
 assert.equal(controller.getSnapshot().operation.state,'queued');assert.equal(controller.getSnapshot().submittedId,A);
 assert.match(controller.getSnapshot().deploymentNotice,/已受理/);assert.doesNotMatch(controller.getSnapshot().deploymentNotice,/部署成功/);
 assert.equal(controller.deployReady(HASH,4,'dev'),false);controller.dispose();
});

test('lost submit response retries the same preparation and idempotency key without preparing again',async()=>{
 let submits=0;
 const {controller,calls}=submissionHarness({override:(path)=>path.endsWith('/deployment/submit')&&submits++===0?Promise.reject(new Error('connection closed')):undefined});
 await controller.refresh();await controller.deploy(HASH,2,'dev');
 assert.equal(controller.getSnapshot().deploymentPending,true);assert.ok(controller.getSnapshot().deploymentError);
 await controller.refresh();assert.equal(calls.filter(call=>call.method==='POST').length,2);
 await controller.deploy(HASH,2,'dev');
 const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,3);
 assert.deepEqual(writes[1].body,writes[2].body);assert.equal(writes.filter(call=>call.path.endsWith('/prepare')).length,1);
 assert.equal(controller.getSnapshot().deploymentPending,false);controller.dispose();
});

test('unconfirmed deployment cannot silently change environment or create a second request',async()=>{
 const {controller,calls}=submissionHarness({override:path=>path.endsWith('/deployment/submit')?Promise.reject(new Error('timeout')):undefined});
 await controller.refresh();await controller.deploy(HASH,3,'dev');await controller.deploy(HASH,3,'prod');
 assert.equal(calls.filter(call=>call.method==='POST').length,2);assert.match(controller.getSnapshot().deploymentError,/上一次/);
 controller.abandonAttempt();assert.equal(controller.getSnapshot().deploymentPending,false);controller.dispose();
});

test('unknown profiles, foreign projects, stale artifacts and context permission errors cannot submit',async()=>{
 for(const context of [{...deploymentContext(),profile:'future-profile'},{...deploymentContext(),projectId:B},{...deploymentContext(),artifact:{hash:'f'.repeat(64),version:'0.2.0'}},{...deploymentContext(),available:false,reason:'DEPLOYMENT_TARGET_DENIED'}]){
  const {controller,calls}=submissionHarness({context});await controller.refresh();await controller.deploy(HASH,1,'dev');
  assert.equal(controller.deployReady(HASH,1,'dev'),false);assert.ok(calls.every(call=>call.method==='GET'));controller.dispose();
 }
 const {controller,calls}=submissionHarness({override:path=>path.endsWith('/deployment/context')?Promise.reject(new Error('AUTH_FAILED')):undefined});
 await controller.refresh();await controller.deploy(HASH,1,'dev');assert.ok(controller.getSnapshot().contextError);assert.ok(calls.every(call=>call.method==='GET'));controller.dispose();
});

test('switching account or project while preparing cannot submit from a late response',async()=>{
 const pending=deferred();const {controller,calls}=submissionHarness({override:path=>path.endsWith('/deployment/prepare')?pending.promise:undefined});
 await controller.refresh();let updates=0;controller.subscribe(()=>updates++);
 const deployment=controller.deploy(HASH,1,'dev');await turn();controller.dispose();const previous=updates;
 pending.resolve({schemaVersion:1,preparationId:PREPARATION,projectId:PROJECT,artifactHash:HASH,environment:'dev',expectedGeneration:0,releaseRef:operation().releaseRef,target:operation().target});await deployment;
 assert.equal(updates,previous);assert.ok(!calls.some(call=>call.path.endsWith('/deployment/submit')));
});

test('concurrent deploy clicks do not issue duplicate prepare or submit requests',async()=>{
 const pending=deferred();const {controller,calls}=submissionHarness({override:path=>path.endsWith('/deployment/submit')?pending.promise:undefined});
 await controller.refresh();const first=controller.deploy(HASH,1,'dev');await turn();await controller.deploy(HASH,1,'dev');
 assert.equal(calls.filter(call=>call.method==='POST').length,2);pending.resolve(operation());await first;controller.dispose();
});


test('a definite preparation rejection releases the pending attempt so the user can choose dev first',async()=>{
 const {controller,calls}=submissionHarness({override:path=>path.endsWith('/deployment/prepare')?Promise.reject(new Error('DEPLOYMENT_DEV_VERIFICATION_REQUIRED')):undefined});
 await controller.refresh();await controller.deploy(HASH,1,'prod');
 assert.equal(controller.getSnapshot().deploymentPending,false);assert.match(controller.getSnapshot().deploymentError,/联调环境/);
 assert.equal(controller.deployReady(HASH,1,'dev'),true);assert.ok(!calls.some(call=>call.path.endsWith('/deployment/submit')));controller.dispose();
});


test('a submission response for the wrong action or generation is never accepted as this deployment',async()=>{
 for(const wrong of [operation(A,{kind:'rollback'}),operation(A,{previousGeneration:8})]){
  const {controller}=submissionHarness({override:path=>path.endsWith('/deployment/submit')?wrong:undefined});
  await controller.refresh();await controller.deploy(HASH,1,'dev');
  assert.equal(controller.getSnapshot().submittedId,null);assert.equal(controller.getSnapshot().deploymentPending,true);
  assert.match(controller.getSnapshot().deploymentError,/无法识别/);controller.dispose();
 }
});


test('an unsupported project capability is a project-level restriction even while the deployment service is available',async()=>{
 const context={...deploymentContext(),available:false,reason:'RUNTIME_INCOMPATIBLE',supportedCapabilities:['data']};
 const {controller,calls}=submissionHarness({context});await controller.refresh();
 assert.equal(controller.getSnapshot().capabilities.available,true);
 assert.equal(controller.getSnapshot().context.available,false);
 assert.equal(errorMessage(new Error(controller.getSnapshot().context.reason)),'当前版本使用的能力尚未支持此部署方式。');
 await controller.deploy(HASH,1,'dev');assert.equal(controller.deployReady(HASH,1,'dev'),false);
 assert.ok(calls.every(call=>call.method==='GET'));controller.dispose();
});
