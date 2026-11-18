import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {createStudioEntry} from '../integration/host-entry.mjs';
import {createApplicationInstaller} from '../../team-client/applications/installer.mjs';

const slot='ai.wanx.selfmade.'+'b'.repeat(32),sourceApp='ai.wanx.selfmade.'+'a'.repeat(32);
const stable=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=x=>'sha256:'+createHash('sha256').update(stable(x)).digest('hex');
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error('expected Host work did not complete');await new Promise(r=>setTimeout(r,5))}}
async function fixture(t,{copy,bootstrap=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-delivery-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const assets=path.join(root,'assets');await mkdir(assets);for(const f of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])await writeFile(path.join(assets,f),'');
 let admin=true,live=true;const requests=[],callers=[],acks=[],launched=[],events=new Set();
 const payload={applicationId:slot,name:'Studio expert',version:'1.0.0',artifactHash:'c'.repeat(64),manifest:{schemaVersion:1,name:'Studio expert',entry:'src/app.js',capabilities:['foundation'],collections:{}},bundle:'test',css:'',runtimeNamespace:'studio',deployment:{schemaVersion:1,profile:'wanx-expert-app-v1',operationId:'d'.repeat(32),environment:'dev',generation:1,baseApplicationId:sourceApp,slotApplicationId:slot,boxId:'box-test'}};
 const ticket={id:'e'.repeat(32),nonce:'nonce-value-123456789',profile:payload.deployment.profile,operationId:payload.deployment.operationId,projectId:'f'.repeat(32),baseApplicationId:sourceApp,slotApplicationId:slot,generation:1,fence:1,step:'activate',artifactHash:payload.artifactHash,version:payload.version,environment:'dev',boxId:'box-test',payloadDigest:hash(payload)};
 const context=()=>{if(!live)throw Error('SESSION_CHANGED');return{accountId:'synthetic-owner',clientId:'synthetic-installation',boxId:'box-test',user:{id:1}}};
 const connection={context,onInvalidated(fn){events.add(fn);return()=>events.delete(fn)},async request(input){requests.push(input);let value={};if(input.path==='/api/app-studio/context')value={protocolVersion:2,modelAvailable:true};else if(input.path==='/api/app-studio/deployment/capabilities'){if(!admin)return{status:403,body:JSON.stringify({code:'STUDIO_ADMIN_REQUIRED'})};value={schemaVersion:1,available:true,operations:['deploy']}}else if(input.path.endsWith('/client-deliveries'))value={items:[ticket]};else if(input.path.endsWith('/claim'))value=ticket;else if(input.path.endsWith('/payload'))value=payload;else if(input.path.endsWith('/ack')){acks.push(JSON.parse(input.body));value={accepted:true}}return{status:200,body:Buffer.from(JSON.stringify(value))}}};
 const installer=createApplicationInstaller({rootDir:path.join(root,'installed'),...(copy?{copy}: {})});
 let ready=false,selectedScope={accountId:'synthetic-owner',clientId:'synthetic-installation',boxId:'box-test'};const connectionEvents=new Set();
 const changed=()=>{for(const fn of connectionEvents)fn()};
 const entry=createStudioEntry({createConnection:async id=>{callers.push(id);return connection},assets,deploymentRoot:path.join(root,'journal'),deploymentIntervalMs:100000,...(bootstrap?{deploymentConnection:{subscribe(fn){connectionEvents.add(fn);return()=>connectionEvents.delete(fn)},getContext:()=>ready?selectedScope:null}}:{}),applications:{installDeployment:(...args)=>installer.installDeployment(...args),listInstalled:()=>installer.list(),launch:async id=>launched.push(id)}});
 t.after(()=>entry.close?.());
 return{root,entry,installer,requests,callers,acks,launched,deny(){admin=false},invalidate(){live=false;for(const fn of events)fn()},listenerCount:()=>events.size,connect(){ready=true;changed()},disconnect(){ready=false;changed()},switchAccount(){selectedScope={...selectedScope,accountId:'another-account'};changed()},heartbeat:changed,connectionListenerCount:()=>connectionEvents.size};
}

test('original Studio Host installs and ACKs through its real app-studio connection only after administrator authorization',async t=>{
 const h=await fixture(t);assert.equal(h.requests.length,0);
 const check=await h.entry.authorize();check();await until(()=>h.launched.length===1);
 assert.ok(h.callers.every(id=>id==='ai.wanx.studio'));
 assert.deepEqual(h.requests.slice(0,2).map(r=>r.path),['/api/app-studio/context','/api/app-studio/deployment/capabilities']);
 assert.ok(h.requests.every(r=>r.path.startsWith('/api/app-studio/')));
 assert.equal(h.acks[0].state,'active');assert.equal(h.launched[0],slot);
 const record=await h.installer.resolveCurrent(slot);assert.equal(JSON.parse(await readFile(path.join(record.installPath,'miniapp.runtime.json'))).runtimeNamespace,'studio');
 h.entry.close();assert.equal(h.listenerCount(),0);
});

test('ordinary published-app context access does not authorize the Studio deployment worker',async t=>{
 const h=await fixture(t);h.deny();await assert.rejects(h.entry.authorize(),/STUDIO_ADMIN_REQUIRED/);
 await new Promise(r=>setTimeout(r,20));assert.equal(h.requests.length,2);assert.equal(h.acks.length,0);assert.deepEqual(await h.installer.list(),[]);
});

test('Studio session invalidation during file copy fences installation and acknowledgement',async t=>{
 let release,started;const copied=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const h=await fixture(t,{copy:async(...args)=>{await cp(...args);started();await gate}});
 await h.entry.authorize();await copied;h.invalidate();release();
 await new Promise(r=>setTimeout(r,30));assert.deepEqual(await h.installer.list(),[]);assert.equal(h.acks.length,0);assert.equal(h.launched.length,0);assert.equal(h.listenerCount(),0);
});

test('Studio manager closing while authorization awaits cannot start a late worker',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-delivery-close-'));t.after(()=>rm(root,{recursive:true,force:true}));let release,calls=0;
 const gate=new Promise(r=>release=r),connection={context:()=>({accountId:'a',boxId:'b',user:{id:1}}),async request(){calls++;await gate;return{status:200,body:'{}'}}};
 const entry=createStudioEntry({createConnection:async()=>connection,deploymentRoot:path.join(root,'journal'),applications:{installDeployment(){throw Error('must not install')}}});
 const work=entry.authorize();await until(()=>calls===1);entry.close();release();await assert.rejects(work,/HOST_SESSION_EXPIRED/);assert.equal(calls,1);
});

test('a late administrator check from an older box cannot replace the current Studio delivery scope',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-delivery-race-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let selected='old',releaseOld;const oldGate=new Promise(r=>releaseOld=r),calls=[];
 const entry=createStudioEntry({deploymentRoot:path.join(root,'journal'),deploymentIntervalMs:100000,applications:{installDeployment(){throw Error('no tickets')}},createConnection:async()=>{const box=selected;return{context:()=>({accountId:'synthetic',boxId:box,user:{id:1}}),async request(input){calls.push({box,path:input.path});let value={};if(input.path.endsWith('/capabilities')){if(box==='old')await oldGate;value={schemaVersion:1,available:true,operations:['deploy']}}if(input.path.endsWith('/client-deliveries'))value={items:[]};return{status:200,body:JSON.stringify(value)}}}}});
 t.after(()=>entry.close());const older=entry.authorize();await until(()=>calls.some(c=>c.box==='old'&&c.path.endsWith('/capabilities')));selected='new';await entry.authorize();await until(()=>calls.some(c=>c.box==='new'&&c.path.endsWith('/client-deliveries')));releaseOld();await assert.rejects(older,/HOST_SESSION_EXPIRED/);
 assert.equal(calls.some(c=>c.box==='old'&&c.path.endsWith('/client-deliveries')),false);
});

test('trusted main-client readiness resumes accepted Studio delivery once, without reopening Builder',async t=>{
 const h=await fixture(t,{bootstrap:true});await new Promise(r=>setImmediate(r));assert.equal(h.callers.length,0);
 h.connect();await until(()=>h.launched.length===1);assert.equal(h.callers.length,1);
 for(let i=0;i<20;i++)h.heartbeat();await new Promise(r=>setTimeout(r,20));assert.equal(h.callers.length,1,'same-scope heartbeat does not recreate a connection or worker');
 h.disconnect();assert.equal(h.listenerCount(),0);h.connect();await until(()=>h.launched.length===2);assert.equal(h.callers.length,2);assert.equal((await h.installer.list()).length,1);
 h.entry.close();assert.equal(h.connectionListenerCount(),0);assert.equal(h.listenerCount(),0);h.heartbeat();assert.equal(h.callers.length,2);
});

test('ordinary-user bootstrap denial is silent and not retried on heartbeat',async t=>{
 const h=await fixture(t,{bootstrap:true});h.deny();h.connect();await until(()=>h.requests.length===2);
 for(let i=0;i<20;i++)h.heartbeat();await new Promise(r=>setTimeout(r,20));assert.equal(h.requests.length,2);assert.equal(h.callers.length,1);assert.equal(h.acks.length,0);assert.deepEqual(await h.installer.list(),[]);
});

test('trusted account switch fences a cached old context during managed file copy',async t=>{
 let release,started;const copied=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const h=await fixture(t,{bootstrap:true,copy:async(...args)=>{await cp(...args);started();await gate}});
 h.connect();await copied;h.switchAccount();release();
 await new Promise(r=>setTimeout(r,30));assert.deepEqual(await h.installer.list(),[]);assert.equal(h.acks.length,0);assert.equal(h.launched.length,0);assert.equal(h.listenerCount(),0);
});


const jsonResponse=(status,value)=>({status,body:JSON.stringify(value)});
async function compatibilityFixture(t,{capability=jsonResponse(404,{detail:'Not Found'}),management=jsonResponse(200,{protocolVersion:1,iterativeBuild:1,directEdits:1}),contextResponse=jsonResponse(200,{protocolVersion:2})}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-capability-compat-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const requests=[];let selected='box-old',installed=0;
 const reply=async(value,input)=>typeof value==='function'?await value(input):value;
 const entry=createStudioEntry({deploymentRoot:path.join(root,'journal'),deploymentIntervalMs:100000,
  applications:{installDeployment(){installed++;throw Error('compatibility must never install')}},
  createConnection:async()=>{const box=selected;return{context:()=>({accountId:'synthetic',boxId:box,user:{id:1}}),async request(input){
   requests.push({box,path:input.path});
   if(input.path==='/api/app-studio/context')return reply(contextResponse,{box,...input});
   if(input.path==='/api/app-studio/deployment/capabilities')return reply(capability,{box,...input});
   if(input.path==='/api/app-studio/_builder/context')return reply(management,{box,...input});
   if(input.path.endsWith('/client-deliveries'))return jsonResponse(200,{items:[]});
   throw Error('unexpected route '+input.path);
  }}}});
 t.after(()=>entry.close());return{entry,requests,installed:()=>installed,switchBox:()=>{selected='box-new'}};
}
test('a missing optional deployment endpoint permits legacy workspace only after real management authorization',async t=>{
 const h=await compatibilityFixture(t);const assertLive=await h.entry.authorize();assertLive();
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(h.requests.map(r=>r.path),['/api/app-studio/context','/api/app-studio/deployment/capabilities','/api/app-studio/_builder/context']);
 assert.equal(h.installed(),0);assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);
});
test('legacy fallback cannot authorize a published-app user or enable the deployment worker',async t=>{
 const h=await compatibilityFixture(t,{management:jsonResponse(403,{code:'STUDIO_ADMIN_REQUIRED'})});
 await assert.rejects(h.entry.authorize(),{code:'STUDIO_ADMIN_REQUIRED'});
 assert.equal(h.requests.at(-1).path,'/api/app-studio/_builder/context');assert.equal(h.installed(),0);
 assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);
});
test('permission, service, network and malformed capability failures are never treated as legacy compatibility',async t=>{
 const cases=[
  [jsonResponse(401,{code:'AUTH_FAILED'}),'AUTH_FAILED'],
  [jsonResponse(403,{code:'STUDIO_ADMIN_REQUIRED'}),'STUDIO_ADMIN_REQUIRED'],
  [jsonResponse(503,{detail:'Service unavailable'}),'STUDIO_REQUEST_FAILED'],
  [jsonResponse(404,{code:'STUDIO_IDENTITY_FORBIDDEN'}),'STUDIO_IDENTITY_FORBIDDEN'],
  [jsonResponse(404,{}),'STUDIO_REQUEST_FAILED'],
  [jsonResponse(404,{detail:'Deployment resource not found'}),'STUDIO_REQUEST_FAILED'],
  [{status:404,body:'<html>Not found</html>'},'STUDIO_RESPONSE_INVALID'],
  [{status:200,body:'broken-json'},'STUDIO_RESPONSE_INVALID'],
  [()=>{throw Object.assign(Error('network error'),{code:'NETWORK_FAILED'})},'NETWORK_FAILED'],
  [()=>{throw Object.assign(Error('spoofed transport status'),{code:'STUDIO_REQUEST_FAILED',status:404})},'STUDIO_REQUEST_FAILED'],
 ];
 for(const [capability,code] of cases){const h=await compatibilityFixture(t,{capability});await assert.rejects(h.entry.authorize(),{code});
  assert.equal(h.requests.some(r=>r.path.includes('/_builder/context')||r.path.includes('client-deliveries')),false);assert.equal(h.installed(),0);h.entry.close();}
});
test('only the deployment capability route may use the legacy fallback',async t=>{
 const h=await compatibilityFixture(t,{contextResponse:jsonResponse(404,{detail:'Not Found'})});
 await assert.rejects(h.entry.authorize(),{code:'STUDIO_REQUEST_FAILED'});
 assert.deepEqual(h.requests.map(r=>r.path),['/api/app-studio/context']);assert.equal(h.installed(),0);
});
test('fallback requires a valid supported management response rather than any HTTP 200',async t=>{
 for(const management of [jsonResponse(200,{}),jsonResponse(200,{protocolVersion:2,iterativeBuild:1}),jsonResponse(200,{protocolVersion:1,iterativeBuild:0}),{status:200,body:'invalid-json'}]){
  const h=await compatibilityFixture(t,{management});await assert.rejects(h.entry.authorize(),{code:'STUDIO_RESPONSE_INVALID'});
  assert.equal(h.installed(),0);assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);h.entry.close();
 }
});
test('HTTP status remains private rather than appearing on propagated renderer-facing errors',async t=>{
 const h=await compatibilityFixture(t,{capability:jsonResponse(503,{detail:'private server response'})});
 let caught;try{await h.entry.authorize()}catch(error){caught=error}
 assert.equal(caught.code,'STUDIO_REQUEST_FAILED');assert.deepEqual(Object.keys(caught),['code']);
 assert.equal(Object.hasOwn(caught,'status'),false);assert.equal(Object.hasOwn(caught,'statusCode'),false);
 assert.doesNotMatch(JSON.stringify(caught),/private server response|503/);
});
test('closing during legacy management authorization rejects a late success without starting a worker',async t=>{
 let finish;const gate=new Promise(resolve=>finish=resolve);
 const h=await compatibilityFixture(t,{management:()=>gate});const pending=h.entry.authorize();pending.catch(()=>{});
 await until(()=>h.requests.some(r=>r.path.endsWith('/_builder/context')));h.entry.close();finish(jsonResponse(200,{protocolVersion:1,iterativeBuild:1}));
 await assert.rejects(pending,{code:'HOST_SESSION_EXPIRED'});assert.equal(h.installed(),0);assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);
});
test('a late legacy management response from an older box cannot authorize the new scope',async t=>{
 let finish;const gate=new Promise(resolve=>finish=resolve);
 const h=await compatibilityFixture(t,{management:({box})=>box==='box-old'?gate:jsonResponse(200,{protocolVersion:1,iterativeBuild:1})});
 const pending=h.entry.authorize();pending.catch(()=>{});await until(()=>h.requests.some(r=>r.box==='box-old'&&r.path.endsWith('/_builder/context')));
 h.switchBox();const assertLive=await h.entry.authorize();assertLive();finish(jsonResponse(200,{protocolVersion:1,iterativeBuild:1}));
 await assert.rejects(pending,{code:'HOST_SESSION_EXPIRED'});assert.equal(h.installed(),0);assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);
});


test('a box missing both deployment and management routes requires an explicit box update without opening',async t=>{
 const h=await compatibilityFixture(t,{management:jsonResponse(404,{detail:'Not Found'})});
 await assert.rejects(h.entry.authorize(),{code:'STUDIO_BOX_UPDATE_REQUIRED'});
 assert.deepEqual(h.requests.map(r=>r.path),['/api/app-studio/context','/api/app-studio/deployment/capabilities','/api/app-studio/_builder/context']);
 assert.equal(h.installed(),0);assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);
});
test('only an exact ordinary management route 404 becomes the box-update error',async t=>{
 const cases=[
  [jsonResponse(401,{code:'AUTH_FAILED'}),'AUTH_FAILED'],
  [jsonResponse(403,{code:'STUDIO_ADMIN_REQUIRED'}),'STUDIO_ADMIN_REQUIRED'],
  [jsonResponse(503,{detail:'Service unavailable'}),'STUDIO_REQUEST_FAILED'],
  [jsonResponse(404,{code:'STUDIO_IDENTITY_FORBIDDEN'}),'STUDIO_IDENTITY_FORBIDDEN'],
  [jsonResponse(404,{detail:'Other resource not found'}),'STUDIO_REQUEST_FAILED'],
  [{status:404,body:'<html>Not Found</html>'},'STUDIO_RESPONSE_INVALID'],
  [()=>{throw Object.assign(Error('network error'),{code:'NETWORK_FAILED'})},'NETWORK_FAILED'],
  [()=>{throw Object.assign(Error('fake route status'),{code:'STUDIO_REQUEST_FAILED',status:404})},'STUDIO_REQUEST_FAILED'],
 ];
 for(const [management,code]of cases){const h=await compatibilityFixture(t,{management});await assert.rejects(h.entry.authorize(),{code});
  assert.equal(h.installed(),0);assert.equal(h.requests.some(r=>r.path.includes('client-deliveries')),false);h.entry.close();}
});
