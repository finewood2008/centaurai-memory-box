import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {EventEmitter} from 'node:events';
import {createApplicationManager} from '../applications/manager.mjs';
import {writeMiniappPackage} from '../../builder/core/package.mjs';

test('team main-process managed installation survives launch pruning and rejects ordinary mutations',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-managed-manager-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const assets=path.join(root,'assets');await mkdir(assets);for(const file of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])await writeFile(path.join(assets,file),'module.exports={}');
 const slot='ai.wanx.selfmade.'+'a'.repeat(32),deployment={schemaVersion:1,profile:'wanx-expert-app-v1',operationId:'b'.repeat(32),generation:1,environment:'dev',baseApplicationId:'example.studio.expert',slotApplicationId:slot,boxId:'synthetic-box'};
 const payload={applicationId:slot,name:'Studio expert',version:'0.1.0',artifactHash:'c'.repeat(64),manifest:{schemaVersion:1,name:'Studio expert',entry:'src/app.js',capabilities:['foundation'],collections:{}},bundle:'test',css:'',runtimeNamespace:'studio',deployment};
 const directory=path.join(root,'package');await writeMiniappPackage(payload,directory,{assets});
 let current=true;const children=[];
 const manager=await createApplicationManager({applicationRoot:path.join(root,'apps'),applicationId:'wanx-host',assertClientUsable(){if(!current)throw Error('UPDATE_REQUIRED')},createConnection:async()=>({context:()=>({accountId:'synthetic-account',boxId:'synthetic-box',user:{id:1}})}),spawn:(_file,_args,options)=>{const child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0)};children.push(child);queueMicrotask(()=>child.emit('message',{type:'wanx:application-ready',launchId:options.env.WANX_HOST_LAUNCH_ID}));return child}});
 t.after(()=>manager.close());
 const input={sourceDir:directory,binding:{...deployment,fence:1,artifactHash:payload.artifactHash}};
 const release=manager.beginMaintenance();await assert.rejects(manager.installDeployment(input),/UPDATE_IN_PROGRESS/);release();
 current=false;await assert.rejects(manager.installDeployment(input),/UPDATE_REQUIRED/);current=true;
 const controller=new AbortController();controller.abort(Error('scope ended'));await assert.rejects(manager.installDeployment(input,{signal:controller.signal}),/scope ended/);
 const installed=await manager.installDeployment(input);assert.equal(installed.deployment.profile,'wanx-expert-app-v1');
 await manager.launch(slot);await new Promise(r=>setImmediate(r));assert.equal(children.length,1);
 assert.equal((await manager.listInstalled())[0].deployment.generation,1);
 assert.equal(JSON.parse(await readFile(path.join(installed.installPath,'miniapp.runtime.json'))).runtimeNamespace,'studio');
 await assert.rejects(manager.install({sourceDir:directory}),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(manager.uninstall(slot),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(manager.rollback(slot),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
  assert.equal(children[0].exitCode,null,'ordinary actions do not stop the managed app');
 await manager.close();await assert.rejects(manager.installDeployment(input),/APPLICATIONS_CLOSED/);
});

test('team manager bootstraps accepted delivery from trusted readiness without launching Builder and unsubscribes on close',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-delivery-bootstrap-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const scope={accountId:'synthetic',clientId:'synthetic-installation',boxId:'synthetic-box'},listeners=new Set();let ready=false,admin=true;const requests=[],callers=[];
 const manager=await createApplicationManager({applicationRoot:path.join(root,'apps'),applicationId:'wanx-host',studioConnection:{getContext:()=>ready?scope:null,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}},createConnection:async id=>{callers.push(id);return{context:()=>({...scope,user:{id:1}}),async request(input){requests.push(input.path);if(input.path.endsWith('/capabilities')&&!admin)return{status:403,body:'{"code":"STUDIO_ADMIN_REQUIRED"}'};return{status:200,body:JSON.stringify(input.path.endsWith('/capabilities')?{schemaVersion:1,available:true,operations:['deploy']}:input.path.endsWith('/client-deliveries')?{items:[]}:{protocolVersion:2})}}}}});
 t.after(()=>manager.close());const emit=()=>{for(const fn of listeners)fn()},until=async predicate=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('bootstrap did not complete');await new Promise(r=>setTimeout(r,5))}};
 await new Promise(r=>setImmediate(r));assert.equal(callers.length,0);ready=true;emit();await until(()=>requests.length===3);
 for(let i=0;i<20;i++)emit();await new Promise(r=>setTimeout(r,15));assert.deepEqual(callers,['ai.wanx.studio']);assert.ok(requests.every(p=>p.startsWith('/api/app-studio/')));
 ready=false;emit();admin=false;ready=true;emit();await until(()=>requests.length===5);for(let i=0;i<20;i++)emit();await new Promise(r=>setTimeout(r,15));assert.equal(requests.length,5,'ordinary-user denial is not repeatedly polled');
 await manager.close();assert.equal(listeners.size,0);emit();assert.equal(requests.length,5);
});
