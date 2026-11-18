import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../ui/deployment/directory-controller.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {createDirectoryDeploymentController}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const releaseId='release-current',oldRelease='release-previous',A='a'.repeat(32),B='b'.repeat(32),C='c'.repeat(32),digest='sha256:'+'d'.repeat(64);
const item={releaseId,applicationId:'example-app',name:'合成应用',version:'0.1.2',directoryDigest:digest};
const target={organizationId:'example-org',boxId:'example-box',applicationId:item.applicationId,environment:'dev'};
const ref=id=>({releaseId:id,bundleDigest:digest});
const context={schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,releaseId,applicationId:item.applicationId,artifact:{hash:'e'.repeat(64),version:item.version},target,environments:[{id:'dev',generation:1,health:'healthy',activeReleaseRef:ref(oldRelease)},{id:'prod',generation:0,health:'empty',activeReleaseRef:null}],supportedActions:['deploy'],supportedCapabilities:['data','foundation']};
const operation=(id,release=oldRelease,extra={})=>({id,target,kind:'deploy',releaseRef:ref(release),state:'succeeded',phase:'complete',revision:2,createdAt:100,updatedAt:101,deadline:200,commitStatus:'committed',committedGeneration:1,previousGeneration:0,components:[{componentId:'client',role:'client',required:true,status:'ready',actualVersion:release===releaseId?'0.1.2':'0.1.1'}],errorCode:null,...extra});
async function fixture(history){
 const calls=[];let items=history,detail=null;
 const c=createDirectoryDeploymentController(async(path,method='GET')=>{
  calls.push({path,method});
  if(path==='/deployment/directory-releases')return{schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,items:[item]};
  if(path.endsWith('/ingest'))return item;
  if(path.endsWith('/context'))return context;
  if(path==='/deployment/operations?limit=100')return{items};
  if(path.includes('/events?'))return{items:[],nextCursor:0,hasMore:false};
  if(path.endsWith('/receipt'))return null;
  if(path.startsWith('/deployment/operations/'))return detail||items.find(o=>path.endsWith(o.id));
  throw Error('unexpected route '+path);
 },releaseId);
 await c.loadReleases();await c.ingest();
 return{c,calls,setHistory(value){items=value},setDetail(value){detail=value}};
}
test('older release success is never shown as selected release result or read for its receipt/events',async()=>{
 const old=operation(A),f=await fixture([old]);
 const s=f.c.getSnapshot();assert.equal(s.operation,null);assert.equal(s.environmentOperation.id,A);
 assert.equal(s.context.environments.find(e=>e.id==='dev').activeReleaseRef.releaseId,oldRelease);
 assert.equal(s.environmentOperation.components[0].actualVersion,'0.1.1');
 assert.equal(s.receipt,null);assert.deepEqual(s.events,[]);
 assert.equal(f.calls.some(c=>c.path.includes('/receipt')||c.path.includes('/events?')),false);
 assert.equal(f.c.deployReady(),true);assert.equal(f.c.shouldPoll(),false);f.c.dispose();
});
test('same release history is recovered independently of newer different-release success',async()=>{
 const own=operation(A,releaseId),other=operation(B,oldRelease,{createdAt:200});
 const f=await fixture([other,own]);assert.equal(f.c.getSnapshot().operation.id,A);assert.equal(f.c.getSnapshot().environmentOperation.id,B);
 assert.ok(f.calls.some(c=>c.path===`/deployment/operations/${A}/receipt`));assert.equal(f.calls.some(c=>c.path===`/deployment/operations/${B}/receipt`),false);f.c.dispose();
});
test('another release running in the environment remains visible, blocks new deployment and continues polling',async()=>{
 const active=operation(B,oldRelease,{state:'preparing',phase:'prepare_backend',commitStatus:'not_committed',committedGeneration:null});
 const f=await fixture([active]);assert.equal(f.c.getSnapshot().operation,null);assert.equal(f.c.getSnapshot().environmentOperation.id,B);
 assert.equal(f.c.deployReady(),false);assert.equal(f.c.shouldPoll(),true);
 const writes=f.calls.filter(c=>c.method!=='GET').length;f.c.confirm(true);await f.c.deploy();assert.equal(f.calls.filter(c=>c.method!=='GET').length,writes);
 f.setHistory([operation(B)]);await f.c.refresh();assert.equal(f.c.getSnapshot().operation,null);assert.equal(f.c.deployReady(),true);assert.equal(f.c.shouldPoll(),false);f.c.dispose();
});
test('environment lock is retained when current release already has terminal history',async()=>{
 const own=operation(A,releaseId),other=operation(B,oldRelease,{state:'preparing',phase:'prepare_backend',commitStatus:'not_committed',committedGeneration:null,createdAt:200});
 const f=await fixture([own]);f.setHistory([own,other]);await f.c.refresh();
 assert.equal(f.c.getSnapshot().operation.id,A);assert.equal(f.c.getSnapshot().environmentOperation.id,B);assert.equal(f.c.deployReady(),false);assert.equal(f.c.shouldPoll(),true);f.c.dispose();
});
test('foreign targets do not become selected results or block the current environment',async()=>{
 const history=[operation(A,oldRelease,{target:{...target,boxId:'other-box'},state:'preparing'}),operation(B,releaseId,{target:{...target,environment:'prod'},state:'preparing'}),operation(C,oldRelease,{target:{...target,organizationId:'other-org'},state:'preparing'})];
 const f=await fixture(history);assert.equal(f.c.getSnapshot().operation,null);assert.equal(f.c.getSnapshot().environmentOperation,null);assert.equal(f.c.deployReady(),true);f.c.dispose();
});
test('changing release or environment clears both operation scopes',async()=>{
 for(const change of ['release','environment']){const f=await fixture([operation(A,releaseId),operation(B,oldRelease,{createdAt:200})]);
  if(change==='release')f.c.setReleaseId('replacement');else f.c.setEnvironment('prod');
  assert.equal(f.c.getSnapshot().operation,null);assert.equal(f.c.getSnapshot().environmentOperation,null);assert.deepEqual(f.c.getSnapshot().events,[]);f.c.dispose();}
});
test('a known operation detail cannot silently change its release binding',async()=>{
 const f=await fixture([operation(A,releaseId)]);f.setDetail(operation(A,oldRelease,{revision:3}));await f.c.refresh();
 assert.ok(f.c.getSnapshot().readError);assert.equal(f.c.getSnapshot().operation.releaseRef.releaseId,releaseId);assert.equal(f.c.deployReady(),false);f.c.dispose();
});

test('a known other-release operation falling out of the history page is queried until its lock ends',async()=>{
 const active=operation(B,oldRelease,{state:'preparing',phase:'prepare_backend',commitStatus:'not_committed',committedGeneration:null});
 const f=await fixture([active]);f.setHistory([]);f.setDetail(active);await f.c.refresh();
 assert.equal(f.c.getSnapshot().environmentOperation.id,B);assert.equal(f.c.deployReady(),false);assert.equal(f.c.shouldPoll(),true);
 f.setDetail(operation(B));await f.c.refresh();assert.equal(f.c.getSnapshot().environmentOperation.state,'succeeded');assert.equal(f.c.deployReady(),true);assert.equal(f.c.shouldPoll(),false);f.c.dispose();
});
test('another active environment operation without a release still blocks deployment',async()=>{
 const active=operation(B,oldRelease,{kind:'rollback',releaseRef:null,state:'preflight',phase:'validating',commitStatus:'not_committed',committedGeneration:null});
 const f=await fixture([active]);assert.equal(f.c.getSnapshot().operation,null);assert.equal(f.c.getSnapshot().environmentOperation.id,B);assert.equal(f.c.deployReady(),false);assert.equal(f.c.shouldPoll(),true);f.c.dispose();
});

test('a newer in-flight operation for the same release replaces terminal history and its event scope',async()=>{
 const own=operation(A,releaseId),next=operation(B,releaseId,{state:'preparing',phase:'prepare_backend',revision:1,createdAt:200,commitStatus:'not_committed',committedGeneration:null});
 const f=await fixture([own]);f.setHistory([next,own]);await f.c.refresh();
 assert.equal(f.c.getSnapshot().operation.id,B);assert.equal(f.c.getSnapshot().environmentOperation,null);assert.equal(f.c.deployReady(),false);assert.equal(f.c.shouldPoll(),true);
 assert.ok(f.calls.some(c=>c.path===`/deployment/operations/${B}/receipt`));f.c.dispose();
});
