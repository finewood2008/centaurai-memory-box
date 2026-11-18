import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {createApplicationInstaller} from '../applications/installer.mjs';
import {launchInstalledApplication} from '../applications/runtime.mjs';
import {createApplicationManager} from '../build/app/applications/manager.mjs';
import {createApplicationBackend} from '../applications/backend.mjs';
import {assertStandardDeploymentArchive} from '../applications/standard-deployment.mjs';
import {STANDARD_MAX_COMPRESSED_BYTES,STANDARD_MAX_EXTRACTED_BYTES,STANDARD_MAX_ARCHIVE_ENTRIES} from '../applications/standard-deployment-limits.mjs';
import {createDeploymentDelivery,deploymentPayloadDigest} from '../../builder/integration/personal-client/deployment-delivery.mjs';
const exec=promisify(execFile),slot='ai.wanx.selfmade.'+'b'.repeat(32),base='dev.wanx.standard.a12345678';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=(version='0.1.0')=>({applicationId:base,name:'Standard expert',version,protocolVersion:3,runtime:'electron',launchMode:'shared',entrypoint:'shell/main.cjs',capabilities:['identity.read','http.request'],compatibility:{backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[{id:'wanx.expert-app.v1',range:'>=1.0.0 <2.0.0',features:['context','expert','data']}],resourceDependencies:[],localDataSchema:{readRange:'=1.0.0',writeVersion:'1.0.0'}}});
function binding(generation=1,operationId='c'.repeat(32),artifactHash='d'.repeat(64)){
 return {schemaVersion:1,profile:'wanx-expert-app-v1',baseApplicationId:base,slotApplicationId:slot,boxId:'synthetic-box',environment:'dev',generation,operationId,fence:1,artifactHash,scopeId:'a'.repeat(64),ticketId:'e'.repeat(32),payloadDigest:'sha256:'+'f'.repeat(64)};
}
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'standard-deployment-')));t.after(()=>rm(root,{recursive:true,force:true}));
 async function archive(version='0.1.0',suffix=version,{extraBytes=0}={}){
  const source=path.join(root,'source-'+suffix),m=manifest(version);await mkdir(path.join(source,'shell'),{recursive:true});
  await writeFile(path.join(source,'application.manifest.json'),JSON.stringify(m));await writeFile(path.join(source,'shell/main.cjs'),'// synthetic standard entry '+version);
  if(extraBytes)await writeFile(path.join(source,'large.bin'),Buffer.alloc(extraBytes));
  const archivePath=path.join(root,'package-'+suffix+'.zip');await exec('/usr/bin/zip',['-q','-r',archivePath,'.'],{cwd:source});
  return {source,archivePath,manifest:m,packageSha256:sha(await readFile(archivePath))};
 }
 const installer=createApplicationInstaller({rootDir:path.join(root,'installed'),getCompatibilityContext:async()=>({hostProtocol:1})});
 return {root,installer,archive};
}
test('real installer installs original protocol3 ZIP in the trusted slot while retaining the base manifest',async t=>{
 const f=await fixture(t),pkg=await f.archive();
 assert.equal(typeof f.installer.installStandardDeployment,'function','real managed installer entry must exist');
 const record=await f.installer.installStandardDeployment({...pkg,binding:binding(),artifactHash:'d'.repeat(64)});
 assert.equal(record.applicationId,slot);assert.equal(record.packageApplicationId,base);
 assert.equal(record.descriptor.applicationId,base);assert.equal(record.descriptor.manifest.applicationId,base);
 assert.equal(record.descriptor.sha256,pkg.packageSha256);
 assert.equal(JSON.parse(await readFile(path.join(record.installPath,'application.manifest.json'))).applicationId,base);
 assert.equal(await readFile(path.join(record.installPath,'shell/main.cjs'),'utf8'),'// synthetic standard entry 0.1.0');
 assert.equal((await f.installer.resolveCurrent(slot)).deployment.scopeId,'a'.repeat(64));
});
test('same managed installation retries exact bytes and fences ordinary replacement, explicit generation supports rollback',async t=>{
 const f=await fixture(t),pkg=await f.archive(),input={...pkg,binding:binding(),artifactHash:'d'.repeat(64)};
 const first=await f.installer.installStandardDeployment(input),again=await f.installer.installStandardDeployment(input);
 assert.equal(again.installPath,first.installPath);assert.equal(again.installedAt,first.installedAt);
 const old=await f.archive('0.0.9'),oldBinding=binding(2,'1'.repeat(32),'2'.repeat(64));
 await f.installer.installStandardDeployment({...old,binding:oldBinding,artifactHash:oldBinding.artifactHash});
 assert.equal((await f.installer.resolveCurrent(slot)).version,'0.0.9');
 await assert.rejects(f.installer.installStandardDeployment(input),/APPLICATION_DEPLOYMENT_STALE/);
 for(const operation of ['rollback','uninstall'])await assert.rejects(f.installer[operation](slot),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(f.installer.selectCurrent(slot,'0.1.0'),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(f.installer.install({sourceDir:pkg.source,manifest:{...pkg.manifest,applicationId:slot}}),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
});
test('ZIP checksum, supplied manifest and immutable same-generation proof are independently enforced',async t=>{
 const f=await fixture(t),pkg=await f.archive(),input={...pkg,binding:binding(),artifactHash:'d'.repeat(64)};
 await assert.rejects(f.installer.installStandardDeployment({...input,packageSha256:'0'.repeat(64)}),/APPLICATION_DEPLOYMENT_MISMATCH/);
 await assert.rejects(f.installer.installStandardDeployment({...input,manifest:{...pkg.manifest,name:'changed'}}),/APPLICATION_MANIFEST_MISMATCH/);
 assert.deepEqual(await f.installer.list(),[]);
 await f.installer.installStandardDeployment(input);
 for(const change of [{environment:'prod'},{scopeId:'b'.repeat(64)},{baseApplicationId:'dev.other.app'}])
  await assert.rejects(f.installer.installStandardDeployment({...input,binding:{...input.binding,...change}}),/APPLICATION_DEPLOYMENT_(SLOT_OCCUPIED|MISMATCH)/);
 await assert.rejects(f.installer.installStandardDeployment({...input,binding:{...input.binding,operationId:'9'.repeat(32)}}),/APPLICATION_DEPLOYMENT_STALE/);
});
test('tampered installed entry bytes cannot be reused or launched under the retained ZIP hash',async t=>{
 const f=await fixture(t),pkg=await f.archive(),input={...pkg,binding:binding(),artifactHash:'d'.repeat(64)};
 const record=await f.installer.installStandardDeployment(input);await writeFile(path.join(record.installPath,'shell/main.cjs'),'// tampered');
 await assert.rejects(f.installer.installStandardDeployment(input),/APPLICATION_DEPLOYMENT_MISMATCH/);
 const edited=JSON.parse(await readFile(path.join(record.installPath,'.wanx-install.json')));
 const entry=edited.standardDeployment.files.find(x=>x.path==='shell/main.cjs');entry.size=Buffer.byteLength('// tampered');entry.sha256=sha(Buffer.from('// tampered'));
 await writeFile(path.join(record.installPath,'.wanx-install.json'),JSON.stringify(edited));
 let loaded=false;
 await assert.rejects(launchInstalledApplication({app:{},applicationRoot:path.join(f.root,'installed'),installPath:record.installPath,
  environment:{WANX_HOST_LAUNCH_ID:'synthetic-launch',WANX_HOST_TOKEN:'synthetic-host-token',WANX_HOST_CLIENT_APPLICATION_ID:slot},load:()=>{loaded=true}}),/APPLICATION_DEPLOYMENT_MISMATCH/);
 assert.equal(loaded,false);
});
test('session cancellation during copy reserves the generation but cannot publish the slot',async t=>{
 const f=await fixture(t),pkg=await f.archive(),controller=new AbortController();
 const installer=createApplicationInstaller({rootDir:path.join(f.root,'cancelled'),copy:async(...args)=>{await cp(...args);controller.abort(Error('session changed'))},getCompatibilityContext:async()=>({hostProtocol:1})});
 await assert.rejects(installer.installStandardDeployment({...pkg,binding:binding(),artifactHash:'d'.repeat(64)},{signal:controller.signal}),/session changed/);
 assert.deepEqual(await installer.list(),[]);
 await assert.rejects(readFile(path.join(f.root,'cancelled',slot,'.current-version.json')),{code:'ENOENT'});
});
test('the real bootstrap keeps slot audience/profile and loads the original standard entry only after proof validation',async t=>{
 const f=await fixture(t),pkg=await f.archive(),record=await f.installer.installStandardDeployment({...pkg,binding:binding(),artifactHash:'d'.repeat(64)});
 const paths={},loaded=[];const app={setName(){},setAppUserModelId(){},setPath:(key,value)=>{paths[key]=value},on(){},once(){},exit(){}};
 const environment={WANX_HOST_LAUNCH_ID:'synthetic-launch',WANX_HOST_TOKEN:'synthetic-host-token',WANX_HOST_CLIENT_APPLICATION_ID:slot};
 const previous=process.env.WANX_HOST_APPLICATION_DATA;t.after(()=>{if(previous===undefined)delete process.env.WANX_HOST_APPLICATION_DATA;else process.env.WANX_HOST_APPLICATION_DATA=previous});
 await launchInstalledApplication({app,applicationRoot:path.join(f.root,'installed'),installPath:record.installPath,environment,load:entry=>{loaded.push(entry)}});
 assert.equal(loaded.length,1);assert.ok(loaded[0].endsWith('/shell/main.cjs'));
 assert.equal(paths.userData,path.join(f.root,'installed','.runtime',slot));
 await assert.rejects(launchInstalledApplication({app,applicationRoot:path.join(f.root,'installed'),installPath:record.installPath,environment:{...environment,WANX_HOST_CLIENT_APPLICATION_ID:base},load:()=>{throw Error('must not load')}}),/APPLICATION_RECORD_INVALID/);
 // This is a bootstrap seam test; a loader stub is deliberately not real Electron UI evidence.
});
async function workerFixture(t,{changePayload=x=>x}={}){
 const f=await fixture(t),pkg=await f.archive(),bytes=await readFile(pkg.archivePath);
 let step='prepare_client',launches=0;
 const payload={format:'wanx-standard-expert-client-v1',applicationId:base,name:pkg.manifest.name,version:pkg.manifest.version,artifactHash:'d'.repeat(64),manifest:pkg.manifest,
  packageSha256:pkg.packageSha256,packageBase64:bytes.toString('base64'),runtimeNamespace:'studio',runtimeContract:{id:'wanx.expert-app.v1',version:'1.0.0',collections:{state:{json:'string'}}},
  deployment:Object.fromEntries(Object.entries(binding()).filter(([key])=>!['fence','artifactHash','ticketId','payloadDigest'].includes(key)))};
 const body=changePayload(payload),acks=[];
 const ticket=()=>({id:(step==='activate'?'2':'1').repeat(32),operationId:body.deployment.operationId,step,fence:1,generation:1,projectId:'3'.repeat(32),artifactHash:body.artifactHash,
  version:body.version,baseApplicationId:base,slotApplicationId:slot,environment:'dev',boxId:'synthetic-box',profile:'wanx-expert-app-v1',scopeId:'a'.repeat(64),nonce:'synthetic-nonce-123456789',payloadDigest:deploymentPayloadDigest(body)});
 const session={assertLive(){},active:{link:{context:()=>({boxId:'synthetic-box'})}},async request(route,method,input){if(route==='/deployment/client-deliveries')return{items:[ticket()]};if(route.endsWith('/claim'))return ticket();if(route.endsWith('/payload'))return body;if(route.endsWith('/ack')){acks.push(input);return{accepted:true}}throw Error('unexpected route')}};
 const worker=createDeploymentDelivery({runtimeNamespace:'studio',session:async()=>session,scopeKey:()=> 'synthetic-owner-box',root:path.join(f.root,'delivery'),intervalMs:100000,
  applications:{validateStandardDeployment:(input,options)=>f.installer.installStandardDeployment(input,{...options,validateOnly:true}),installStandardDeployment:(...args)=>f.installer.installStandardDeployment(...args),listInstalled:()=>f.installer.list(),launch:async id=>{assert.equal(id,slot);launches++}}});
 t.after(()=>worker.close());return {...f,payload:body,acks,worker,activate(){step='activate'},launches:()=>launches};
}
test('trusted worker validates the real ZIP without installation, then installs/ACKs exact slot bytes before launch',async t=>{
 const f=await workerFixture(t);await f.worker.tick();assert.equal(f.acks[0].state,'prepared');assert.deepEqual(await f.installer.list(),[]);
 f.activate();await f.worker.tick();assert.equal(f.acks.at(-1).state,'active');assert.equal(f.launches(),1);
 const record=await f.installer.resolveCurrent(slot);assert.equal(record.packageApplicationId,base);assert.equal(record.deployment.payloadDigest,deploymentPayloadDigest(f.payload));
 await f.worker.tick();assert.equal((await f.installer.list()).length,1);
});
test('base64 ZIP tampering is rejected even though payloadDigest deliberately excludes package bytes',async t=>{
 const f=await workerFixture(t,{changePayload:p=>({...p,packageBase64:Buffer.from('different package bytes').toString('base64')})});
 await f.worker.tick();assert.equal(f.acks.at(-1).state,'failed');assert.deepEqual(await f.installer.list(),[]);assert.equal(f.launches(),0);
});
test('a valid metadata digest cannot attest a manifest different from the actual ZIP',async t=>{
 const f=await workerFixture(t,{changePayload:p=>({...p,name:'different',manifest:{...p.manifest,name:'different'}})});
 await f.worker.tick();assert.equal(f.acks.at(-1).state,'failed');assert.deepEqual(await f.installer.list(),[]);
});
test('the real manager passes trusted proof through candidate readiness and preserves the authenticated slot connection for launch',async t=>{
 const f=await fixture(t),pkg=await f.archive(),calls=[],children=[],environments=[];
 let generation=1;
 const context={protocolVersion:1,accountId:'synthetic-account',clientId:'synthetic-client',boxId:'synthetic-box',connection:'ready',user:{id:7},applicationId:'wanx'};
 const connection={context:()=>context,subscribe:()=>()=>{},async request(input){
  calls.push(input);
  if(input.path.endsWith('/runtime')){
   assert.equal(input.path,'/api/app-studio/deployment/apps/'+slot+'/runtime');assert.equal(input.method,'POST');
   assert.deepEqual(JSON.parse(input.body.toString()),{artifactHash:'d'.repeat(64),environment:'dev',generation:1});
   return{status:200,body:Buffer.from(JSON.stringify({schemaVersion:1,transport:'wanx-expert-app-v1',launchToken:'L'.repeat(43),expiresAt:Date.now()/1000+3600}))};
  }
  assert.equal(input.headers?.['x-wanx-expert-launch'],'L'.repeat(43));
  if(input.path==='/api/wanx-expert-app/v1/invoke')return{status:200,body:Buffer.from('{"items":[]}')};
  assert.equal(input.path,'/api/wanx-expert-app/v1/context');assert.equal(input.method,'GET');
  const contract={id:'wanx.expert-app.v1',version:'1.0.0',features:['context','expert','data']};
  return{status:200,body:Buffer.from(JSON.stringify({schemaVersion:1,scopeId:'a'.repeat(64),applicationId:base,baseApplicationId:base,slotApplicationId:slot,boxId:'synthetic-box',environment:'dev',generation,operationId:'c'.repeat(32),artifactHash:'d'.repeat(64),packageSha256:pkg.packageSha256,runtimeNamespace:'studio',contract,
   backend:{schemaVersion:1,productId:'wanx',deviceId:'synthetic-box',observedAt:new Date().toISOString(),authorization:{status:'ready'},contracts:[contract],resources:[],bindings:[]}}))};
 }};
 const client={snapshot:()=>({phase:'ready',connection:{deviceId:'synthetic-box'}}),applicationConnection:async applicationId=>{assert.equal(applicationId,'wanx');return connection}};
 const backend=createApplicationBackend({client,account:{getIdentity:()=>({accountId:'synthetic-account'})},clientVersion:'1.0.0'});
 const manager=await createApplicationManager({applicationRoot:path.join(f.root,'manager-apps'),applicationId:'synthetic-host',...backend,
  createConnection:()=>{throw Error('must retain prepared slot connection')},
  spawn:(_file,_args,options)=>{assert.equal(options.env.WANX_HOST_CLIENT_APPLICATION_ID,slot);environments.push(options.env);const child=new EventEmitter();child.pid=12345;child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0)};children.push(child);queueMicrotask(()=>child.emit('message',{type:'wanx:application-ready',launchId:options.env.WANX_HOST_LAUNCH_ID}));return child}});
 t.after(()=>manager.close());
 const input={...pkg,binding:binding(),artifactHash:'d'.repeat(64)};
 assert.equal((await manager.validateStandardDeployment(input)).validated,true);assert.equal(calls.length,0,'candidate validation cannot read an uncommitted active context');
 await manager.installStandardDeployment(input);assert.equal(calls.length,0);
 assert.equal((await manager.launch(slot)).state,'running');assert.equal(calls.length,2);assert.equal(children.length,1);
 const env=environments[0],headers={authorization:'Bearer '+env.WANX_HOST_TOKEN};
 const publicContext=await(await fetch(env.WANX_HOST_BASE_URL+'/__wanx/context',{headers})).json();
 assert.equal(publicContext.applicationId,slot);assert.equal(publicContext.launchToken,undefined);
 const invoked=await fetch(env.WANX_HOST_BASE_URL+'/api/wanx-expert-app/v1/invoke',{method:'POST',headers:{...headers,'content-type':'application/json','x-wanx-expert-launch':'untrusted-page-value'},body:'{"operation":"expert.tasks","input":{}}'});
 assert.equal(invoked.status,200);assert.equal(calls.length,3);
 const denied=await fetch(env.WANX_HOST_BASE_URL+'/api/app-studio/deployment/apps/'+slot+'/runtime',{method:'POST',headers,body:'{}'});
 assert.notEqual(denied.status,200);assert.equal(calls.length,3,'an app cannot reopen or retarget the privileged runtime');
 await manager.stop(slot);generation=2;
 await assert.rejects(manager.launch(slot),/APPLICATION_PREPARATION_INVALID/);assert.equal(children.length,1,'stale generation cannot spawn another app');
});
test('a rejected ordinary uninstall cannot cancel a managed app whose session is still preparing',async t=>{
 const f=await fixture(t),source=path.join(f.root,'miniapp');await mkdir(path.join(source,'shell'),{recursive:true});
 const miniBinding={schemaVersion:1,profile:'wanx-miniapp-v1',baseApplicationId:'ai.wanx.selfmade.'+'a'.repeat(32),slotApplicationId:slot,boxId:'synthetic-box',operationId:'c'.repeat(32),environment:'dev',generation:1};
 await writeFile(path.join(source,'application.manifest.json'),JSON.stringify({applicationId:slot,name:'Managed miniapp',version:'1.0.0',protocolVersion:1,runtime:'electron',entrypoint:'shell/main.cjs'}));
 await writeFile(path.join(source,'shell/main.cjs'),'');await writeFile(path.join(source,'miniapp.runtime.json'),JSON.stringify({applicationId:slot,artifactHash:'d'.repeat(64),deployment:miniBinding}));
 let resolveConnection,entered;const preparing=new Promise(resolve=>{entered=resolve}),children=[];
 const manager=await createApplicationManager({applicationRoot:path.join(f.root,'managed-race'),applicationId:'synthetic-host',createConnection:()=>{entered();return new Promise(resolve=>{resolveConnection=resolve})},
  spawn:(_file,_args,options)=>{const child=new EventEmitter();child.pid=12345;child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0)};children.push(child);queueMicrotask(()=>child.emit('message',{type:'wanx:application-ready',launchId:options.env.WANX_HOST_LAUNCH_ID}));return child}});
 t.after(()=>manager.close());await manager.installDeployment({sourceDir:source,binding:{...miniBinding,fence:1,artifactHash:'d'.repeat(64)}});
 const opening=manager.launch(slot);await preparing;
 const removing=manager.uninstall(slot);resolveConnection({context:()=>({connection:'ready'})});
 await assert.rejects(removing,/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 assert.equal((await opening).state,'running');assert.equal(children.length,1);
});
test('the frozen 32/128 MiB contract accepts a legitimate client whose extracted files exceed 64 MiB',async t=>{
 const f=await fixture(t),pkg=await f.archive('0.1.0','large-valid',{extraBytes:65*1024*1024});
 assert.ok((await readFile(pkg.archivePath)).length<STANDARD_MAX_COMPRESSED_BYTES);
 const record=await f.installer.installStandardDeployment({...pkg,binding:binding(),artifactHash:'d'.repeat(64)});
 assert.ok(record.standardDeployment.files.reduce((n,file)=>n+file.size,0)>64*1024*1024);
 assert.equal(record.standardDeployment.files.find(file=>file.path==='large.bin').size,65*1024*1024);
});
test('compressed, decompressed and central-directory entry limits match the server contract and reject before publication',async t=>{
 const f=await fixture(t),tooExpanded=await f.archive('0.1.0','too-expanded',{extraBytes:STANDARD_MAX_EXTRACTED_BYTES+1});
 await assert.rejects(f.installer.installStandardDeployment({...tooExpanded,binding:binding(),artifactHash:'d'.repeat(64)}),/APPLICATION_ARCHIVE_TOO_LARGE/);
 const archivePath=path.join(f.root,'too-compressed.zip'),bytes=Buffer.alloc(STANDARD_MAX_COMPRESSED_BYTES+1);
 await writeFile(archivePath,bytes);
 await assert.rejects(f.installer.installStandardDeployment({archivePath,manifest:manifest(),packageSha256:sha(bytes),binding:binding(),artifactHash:'d'.repeat(64)}),/APPLICATION_ARCHIVE_TOO_LARGE/);
 const {ZipFile}=createRequire(new URL('../../personal-client/package.json',import.meta.url))('yazl'),zip=new ZipFile(),chunks=[];
 const done=new Promise((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.on('end',resolve);zip.outputStream.on('error',reject)});
 for(let n=0;n<=STANDARD_MAX_ARCHIVE_ENTRIES;n++)zip.addEmptyDirectory('directory-'+n);
 zip.end();await done;const entriesPath=path.join(f.root,'too-many-entries.zip');await writeFile(entriesPath,Buffer.concat(chunks));
 await assert.rejects(assertStandardDeploymentArchive(entriesPath),/APPLICATION_ARCHIVE_TOO_LARGE/);
 assert.deepEqual(await f.installer.list(),[]);
});
