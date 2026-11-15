import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:[new URL('../ui/deployment/project-expert-controller.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {createProjectExpertController}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const PID='a'.repeat(32),APP='ai.wanx.selfmade.'+'b'.repeat(32),HASH='c'.repeat(64),CONTENT='d'.repeat(64),TASK='e'.repeat(32);
const template={resourceId:'general-assistant',version:'0.0.0+sha.'+'f'.repeat(12),digest:'sha256:'+'f'.repeat(64)};
const verification={schemaVersion:1,checks:[{id:'text-roundtrip',input:{text:'请只回复 WANX_EXPERT_READY'},expected:{contains:'WANX_EXPERT_READY'}}]};
const contract=()=>({template:{...template},verification:structuredClone(verification)});
const source=()=>({artifactHash:HASH,version:'0.1.0',versionRevision:3,taskId:TASK,contentHash:CONTENT,profile:'wanx-expert-app-v1'});
const context=()=>({schemaVersion:1,profile:'wanx-expert-app-v1',available:true,reason:null,projectId:PID,configuration:{revision:1,editable:true,contract:contract()},templates:[{...template,name:'通用助手'}],source:source()});
const release=()=>({schemaVersion:1,profile:'wanx-expert-app-v1',release:{releaseId:'studio-release-example',applicationId:APP,version:'0.1.0',name:'合成专家应用',directoryDigest:'sha256:'+'1'.repeat(64)},source:{...source(),projectId:PID}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{resolve,reject,promise}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({override,anchor={artifactHash:HASH,versionRevision:3}}={}){
 const calls=[];let ctx=context();
 const request=async(path,method='GET',body)=>{
  calls.push({path,method,body});const custom=override?.(path,method,body);if(custom!==undefined)return custom;
  if(method==='GET')return structuredClone(ctx);
  if(method==='PUT'){ctx={...ctx,configuration:{...ctx.configuration,revision:ctx.configuration.revision+1,contract:body.template?{template:body.template,verification:body.verification}:null}};return structuredClone(ctx);}
  if(path.endsWith('/release'))return release();
  throw Error('unexpected request');
 };
 const controller=createProjectExpertController(request,{projectId:PID,applicationId:APP,source:anchor});
 return{controller,calls,setContext(next){ctx=next}};
}

test('reading expert contract never generates or deploys a release; export requires a separate confirmation',async()=>{
 const f=fixture();await f.controller.refresh();assert.equal(f.controller.getSnapshot().context.source.artifactHash,HASH);assert.ok(f.calls.every(c=>c.method==='GET'));
 await f.controller.exportRelease();assert.equal(f.calls.some(c=>c.method==='POST'),false);
 f.controller.confirmExport(true);await f.controller.exportRelease();const call=f.calls.find(c=>c.method==='POST');
 assert.equal(call.path,`/projects/${PID}/deployment/release`);assert.equal(call.body.expectedArtifactHash,HASH);assert.equal(call.body.expectedVersionRevision,3);assert.match(call.body.operationId,/^[a-f0-9]{32}$/);
 assert.equal(f.controller.getSnapshot().delivery.release.releaseId,'studio-release-example');assert.equal(f.calls.some(c=>/\/prepare$|\/submit$/.test(c.path)),false);f.controller.dispose();
});

test('an ambiguous export retries the same source and operation instead of making a new request',async()=>{
 let first=true;const f=fixture({override:(path,method)=>method==='POST'&&first?(first=false,Promise.reject(Error('HOST_REQUEST_TIMEOUT'))):undefined});await f.controller.refresh();f.controller.confirmExport(true);await f.controller.exportRelease();
 assert.equal(f.controller.getSnapshot().exportPending,true);assert.equal(f.controller.getSnapshot().delivery,null);await f.controller.exportRelease();
 const calls=f.calls.filter(c=>c.method==='POST');assert.equal(calls.length,2);assert.deepEqual(calls[0].body,calls[1].body);assert.equal(f.controller.getSnapshot().exportPending,false);f.controller.dispose();
});

test('source drift, foreign project and unavailable profile cannot export adopted bytes',async()=>{
 for(const patch of [{source:{...source(),artifactHash:'0'.repeat(64)}},{source:{...source(),versionRevision:4}},{projectId:'0'.repeat(32)},{profile:'untrusted-profile'},{available:false,reason:'DEPLOYMENT_ADAPTER_UNAVAILABLE',source:null}]){
  const f=fixture();f.setContext({...context(),...patch});await f.controller.refresh();f.controller.confirmExport(true);await f.controller.exportRelease();assert.equal(f.calls.some(c=>c.method==='POST'),false);f.controller.dispose();
 }
});

test('an export response for another application, source, revision or profile never becomes deployable',async()=>{
 for(const value of [{...release(),release:{...release().release,applicationId:'other-app'}},{...release(),source:{...release().source,artifactHash:'0'.repeat(64)}},{...release(),source:{...release().source,versionRevision:4}},{...release(),profile:'wrong-profile'}]){
  const f=fixture({override:(_path,method)=>method==='POST'?Promise.resolve(value):undefined});await f.controller.refresh();f.controller.confirmExport(true);await f.controller.exportRelease();assert.equal(f.controller.getSnapshot().delivery,null);assert.ok(f.controller.getSnapshot().exportError);f.controller.dispose();
 }
});

test('concurrent export and disposed scope cannot publish a late release or make duplicate writes',async()=>{
 const gate=deferred(),f=fixture({override:(_path,method)=>method==='POST'?gate.promise:undefined});await f.controller.refresh();f.controller.confirmExport(true);const pending=f.controller.exportRelease();await tick();await f.controller.exportRelease();assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 f.controller.dispose();gate.resolve(release());await pending;assert.equal(f.controller.getSnapshot().delivery,null);
});

test('configuration uses explicit finite fields and retries an unknown save with the original operation',async()=>{
 let first=true;const f=fixture({override:(_path,method)=>method==='PUT'&&first?(first=false,Promise.reject(Error('HOST_REQUEST_TIMEOUT'))):undefined});await f.controller.refresh();await f.controller.saveContract(template,verification);assert.equal(f.controller.getSnapshot().configurationPending,true);
 await f.controller.saveContract(null,null);const puts=f.calls.filter(c=>c.method==='PUT');assert.equal(puts.length,2);assert.deepEqual(puts[0].body,puts[1].body);assert.deepEqual(Object.keys(puts[0].body).sort(),['expectedRevision','operationId','template','verification']);assert.equal(puts[0].body.expectedRevision,1);assert.equal(f.controller.getSnapshot().configurationPending,false);f.controller.dispose();
});

test('configuration cannot broaden an unavailable template or modify a busy project',async()=>{
 const f=fixture();await f.controller.refresh();await f.controller.saveContract({...template,resourceId:'arbitrary-expert'},verification);assert.equal(f.calls.some(c=>c.method==='PUT'),false);
 f.setContext({...context(),configuration:{...context().configuration,editable:false}});await f.controller.refresh();await f.controller.saveContract(template,verification);assert.equal(f.calls.some(c=>c.method==='PUT'),false);f.controller.dispose();
});

test('a failed read keeps existing delivery visible but blocks all further writes',async()=>{
 let broken=false;const f=fixture({override:(_path,method)=>method==='GET'&&broken?Promise.reject(Error('HOST_SESSION_EXPIRED')):undefined});await f.controller.refresh();f.controller.confirmExport(true);await f.controller.exportRelease();broken=true;await f.controller.refresh();assert.ok(f.controller.getSnapshot().delivery);assert.ok(f.controller.getSnapshot().readError);f.controller.confirmExport(true);await f.controller.exportRelease();await f.controller.saveContract(template,verification);assert.equal(f.calls.filter(c=>c.method!=='GET').length,1);f.controller.dispose();
});

test('refresh renews confirmation and a definite source rejection does not retain an uncertain export',async()=>{
 const f=fixture({override:(_path,method)=>method==='POST'?Promise.reject(Error('VERSION_CHANGED')):undefined});await f.controller.refresh();f.controller.confirmExport(true);await f.controller.refresh();assert.equal(f.controller.getSnapshot().exportConfirmed,false);f.controller.confirmExport(true);await f.controller.exportRelease();assert.equal(f.controller.getSnapshot().exportPending,false);assert.ok(f.controller.getSnapshot().readError);f.controller.dispose();
});

test('an explicitly rejected configuration can be corrected after refresh instead of becoming an uncertain replay',async()=>{
 const f=fixture({override:(_path,method)=>method==='PUT'?Promise.reject(Object.assign(Error('request rejected'),{code:'INPUT_CREDENTIAL_DETECTED'})):undefined});await f.controller.refresh();await f.controller.saveContract(template,verification);
 assert.equal(f.controller.getSnapshot().configurationPending,false);assert.ok(f.controller.getSnapshot().readError);await f.controller.saveContract(null,null);assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);await f.controller.refresh();await f.controller.saveContract(null,null);assert.equal(f.calls.filter(c=>c.method==='PUT').length,2);f.controller.dispose();
});

test('a late configuration response cannot update a disposed project scope',async()=>{
 const gate=deferred(),f=fixture({override:(_path,method)=>method==='PUT'?gate.promise:undefined});await f.controller.refresh();const before=f.controller.getSnapshot().context;const saving=f.controller.saveContract(template,verification);await tick();f.controller.dispose();gate.resolve({...context(),configuration:{...context().configuration,revision:2}});assert.equal(await saving,false);assert.equal(f.controller.getSnapshot().context,before);
});

test('full frozen contract metadata is accepted while only finite template and verification fields leave the UI',async()=>{
 const f=fixture();f.setContext({...context(),configuration:{...context().configuration,contract:{schemaVersion:1,profile:'wanx-expert-app-v1',revision:1,...contract()}}});await f.controller.refresh();assert.equal(f.controller.getSnapshot().readError,'');await f.controller.saveContract({...template,name:'通用助手'},verification);
 const call=f.calls.find(c=>c.method==='PUT');assert.deepEqual(Object.keys(call.body.template).sort(),['digest','resourceId','version']);f.controller.dispose();
});
