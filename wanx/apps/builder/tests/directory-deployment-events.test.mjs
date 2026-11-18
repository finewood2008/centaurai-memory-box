import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../ui/deployment/directory-controller.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {createDirectoryDeploymentController}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const A='a'.repeat(32),B='b'.repeat(32),digest='sha256:'+'c'.repeat(64),releaseId='example-release';
const item={releaseId,applicationId:'example-app',name:'合成应用',version:'1.0.0',directoryDigest:digest};
const target={organizationId:'example-org',boxId:'example-box',applicationId:item.applicationId};
const ctx={schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,releaseId,applicationId:item.applicationId,artifact:{hash:'d'.repeat(64),version:item.version},target,environments:[{id:'dev',generation:1,health:'healthy',activeReleaseRef:null},{id:'prod',generation:0,health:'empty',activeReleaseRef:null}],supportedActions:['deploy'],supportedCapabilities:['data','foundation']};
const operation=(id=A)=>({id,target:{...target,environment:'dev'},kind:'deploy',releaseRef:{releaseId,bundleDigest:digest},state:'succeeded',phase:'complete',revision:2,createdAt:100,updatedAt:101,deadline:200,commitStatus:'committed',committedGeneration:1,previousGeneration:0,components:[],errorCode:null});
const event=(sequence,id=A)=>({sequence,operationId:id,operationRevision:1,createdAt:100,type:'phase_waiting',state:'waiting_box',phase:'prepare_backend'});
const page=(items,hasMore=false,after=0)=>({items,nextCursor:items.at(-1)?.sequence??after,hasMore});
const gate=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{resolve,promise}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(events){
 const calls=[];let op=operation();
 const c=createDirectoryDeploymentController(async(path,method='GET')=>{
  calls.push({path,method});
  if(path==='/deployment/directory-releases')return{schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,items:[item]};
  if(path.endsWith('/ingest'))return item;
  if(path.endsWith('/context'))return ctx;
  if(path==='/deployment/operations?limit=100')return{items:[op]};
  if(path.includes('/events?'))return events(path);
  if(path.endsWith('/receipt'))return null;
  if(path===`/deployment/operations/${op.id}`)return op;
  throw Error('unexpected request');
 });
 await c.loadReleases();c.setReleaseId(releaseId);await c.ingest();
 return{c,calls,setOperation(value){op=value}};
}
test('directory refresh reads terminal history incrementally and manual pagination only performs GETs',async()=>{
 const f=await fixture(path=>path.includes('after=0&')?page([event(1)],true):page([event(2)],false));
 assert.deepEqual(f.c.getSnapshot().events.map(e=>e.sequence),[1]);assert.equal(f.c.getSnapshot().hasMore,true);
 const writes=f.calls.filter(c=>c.method!=='GET').length;
 await f.c.loadEvents();assert.deepEqual(f.c.getSnapshot().events.map(e=>e.sequence),[1,2]);
 assert.equal(f.c.getSnapshot().nextCursor,2);assert.equal(f.c.getSnapshot().hasMore,false);
 assert.equal(f.calls.filter(c=>c.method!=='GET').length,writes);f.c.dispose();
});
test('event errors and foreign events retain history and never block a terminal deployment',async()=>{
 let mode='ok';const f=await fixture(path=>mode==='throw'?Promise.reject(Error('HOST_REQUEST_TIMEOUT')):mode==='foreign'?page([event(2,B)]):page([event(1)]));
 for(const value of ['throw','foreign']){mode=value;await f.c.refresh();assert.ok(f.c.getSnapshot().eventsError);assert.equal(f.c.getSnapshot().readError,'');assert.equal(f.c.deployReady(),true);assert.equal(f.c.getSnapshot().events.length,1);}
 f.c.dispose();
});
test('changing release or environment discards a late event response and clears old history',async()=>{
 for(const change of ['release','environment']){
  const pending=gate();let late=false;
  const f=await fixture(()=>late?pending.promise:page([event(1)]));late=true;
  const read=f.c.loadEvents();await tick();
  if(change==='release')f.c.setReleaseId('another-release');else f.c.setEnvironment('prod');
  assert.deepEqual(f.c.getSnapshot().events,[]);assert.equal(f.c.getSnapshot().nextCursor,0);
  pending.resolve(page([event(2)]));await read;assert.deepEqual(f.c.getSnapshot().events,[]);assert.equal(f.c.getSnapshot().eventsLoading,false);f.c.dispose();
 }
});
test('a newer refresh invalidates a late manual event read without duplicate events',async()=>{
 const pending=gate();let count=0;
 const f=await fixture(()=>++count===2?pending.promise:count===1?page([event(1)]):page([event(2)]));
 const read=f.c.loadEvents();await tick();await f.c.refresh();pending.resolve(page([event(2)],true));await read;
 assert.deepEqual(f.c.getSnapshot().events.map(e=>e.sequence),[1,2]);assert.equal(f.c.getSnapshot().hasMore,false);assert.equal(f.c.getSnapshot().eventsLoading,false);f.c.dispose();
});
test('re-ingest resets the event cursor for a replacement operation',async()=>{
 let id=A;const f=await fixture(()=>page([event(1,id)]));id=B;f.setOperation(operation(B));await f.c.ingest();
 assert.equal(f.c.getSnapshot().operation.id,B);assert.deepEqual(f.c.getSnapshot().events.map(e=>e.operationId),[B]);assert.equal(f.c.getSnapshot().nextCursor,1);f.c.dispose();
});
test('event retention is capped at 1000 while the cursor continues advancing',async()=>{
 const f=await fixture(path=>{const after=Number(new URL(path,'https://example.test').searchParams.get('after'));return page(Array.from({length:100},(_,i)=>event(after+i+1)),true)});
 for(let i=0;i<10;i++)await f.c.loadEvents();
 const s=f.c.getSnapshot();assert.equal(s.events.length,1000);assert.equal(s.events[0].sequence,101);assert.equal(s.nextCursor,1100);assert.equal(s.eventsTruncated,true);f.c.dispose();
});

test('re-ingesting clears history immediately and dispose prevents late event publication',async()=>{
 for(const action of ['ingest','dispose']){
  const pending=gate();let late=false;
  const f=await fixture(()=>late?pending.promise:page([event(1)]));late=true;
  const read=f.c.loadEvents();await tick();
  if(action==='ingest'){
   late=false;const ingest=f.c.ingest();assert.deepEqual(f.c.getSnapshot().events,[]);await ingest;
  }else f.c.dispose();
  const snapshot=f.c.getSnapshot();pending.resolve(page([event(2)]));await read;
  assert.equal(f.c.getSnapshot(),snapshot);f.c.dispose();
 }
});
