import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {writeMiniappPackage} from '../../builder/tests/fixtures/miniapp-package.mjs';
import {writeApplicationZip} from './support/application-zip.mjs';

const slot='ai.wanx.selfmade.'+'a'.repeat(32),base='example.local.expert';
async function fixture(t,edition){
 const root=await mkdtemp(path.join(os.tmpdir(),'managed-local-removal-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const {createApplicationInstaller}=await import(`../../${edition}-client/applications/installer.mjs`);
 const rootDir=path.join(root,'installed'),open=(options={})=>createApplicationInstaller({rootDir,getCompatibilityContext:async()=>({hostProtocol:1}),...options});
 const assets=path.join(root,'assets');await mkdir(assets);
 for(const file of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])await writeFile(path.join(assets,file),'module.exports={}');
 async function miniapp(generation=1){
  const deployment={schemaVersion:1,profile:'wanx-expert-app-v1',operationId:String(generation).repeat(32),generation,environment:'dev',baseApplicationId:base,slotApplicationId:slot,boxId:'synthetic-box'};
  const payload={applicationId:slot,name:'Local deployed app',version:`0.1.${generation}`,artifactHash:String(generation).repeat(64),manifest:{schemaVersion:1,name:'Local deployed app',entry:'src/app.js',capabilities:['foundation'],collections:{}},bundle:'test',css:'',runtimeNamespace:'studio',deployment};
  const sourceDir=path.join(root,`source-${generation}`);await writeMiniappPackage(payload,sourceDir,{assets});
  return {sourceDir,binding:{...deployment,fence:1,artifactHash:payload.artifactHash}};
 }
 const data=path.join(rootDir,'.runtime',slot);await mkdir(data,{recursive:true});await writeFile(path.join(data,'retained.txt'),'business data');
 return {root,rootDir,open,miniapp,data};
}
for(const edition of ['personal','team']){
 test(`${edition}: local managed uninstall preserves data and fences replay across restart`,async t=>{
  const f=await fixture(t,edition),installer=f.open(),one=await f.miniapp();
  const installed=await installer.installDeployment(one);
  await assert.rejects(installer.uninstall(slot),{code:'APPLICATION_MANAGED_DEPLOYMENT_REQUIRED'});
  await installer.uninstallLocal(slot);
  assert.deepEqual(await installer.list(),[]);
  await assert.rejects(installer.resolveCurrent(slot),{code:'APPLICATION_NOT_INSTALLED'});
  await assert.rejects(access(installed.installPath),{code:'ENOENT'});
  assert.equal(await readFile(path.join(f.data,'retained.txt'),'utf8'),'business data');
  const reopened=f.open();await reopened.recover();
  for(const fence of [1,2])await assert.rejects(reopened.installDeployment({...one,binding:{...one.binding,fence}}),{code:'APPLICATION_DEPLOYMENT_USER_REMOVED'});
  await assert.rejects(reopened.uninstall(slot),{code:'APPLICATION_MANAGED_DEPLOYMENT_REQUIRED'});
  const two=await f.miniapp(2);await reopened.installDeployment(two);
  assert.equal((await reopened.resolveCurrent(slot)).deployment.generation,2);
  await reopened.recover();assert.equal((await reopened.resolveCurrent(slot)).deployment.generation,2);
  assert.equal(await readFile(path.join(f.data,'retained.txt'),'utf8'),'business data');
 });
 test(`${edition}: recovery waits for a newer installation before deciding removal cleanup`,async t=>{
  const f=await fixture(t,edition);let copied,release;
  const started=new Promise(resolve=>{copied=resolve}),gate=new Promise(resolve=>{release=resolve});
  const installer=f.open({copy:async(...args)=>{if(args[0].endsWith('source-2')){copied();await gate;}return cp(...args)}});
  await installer.installDeployment(await f.miniapp());await installer.uninstallLocal(slot);
  const installing=installer.installDeployment(await f.miniapp(2));await started;
  let recovered=false;const recovery=installer.recover().then(()=>{recovered=true});
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(recovered,false);}
  finally{release();}
  await Promise.all([installing,recovery]);
  assert.equal((await installer.resolveCurrent(slot)).deployment.generation,2);
 });
 test(`${edition}: committed removal hides interrupted cleanup and recovery cannot resurrect it`,async t=>{
  const f=await fixture(t,edition),installer=f.open(),one=await f.miniapp();await installer.installDeployment(one);
  let checks=0;await assert.rejects(installer.uninstallLocal(slot,()=>{if(++checks===3)throw Error('session canceled after commit')}),/session canceled after commit/);
  assert.deepEqual(await installer.list(),[]);
  const reopened=f.open();await reopened.recover();assert.deepEqual(await reopened.list(),[]);
  await assert.rejects(access(path.join(f.rootDir,slot,'.current-version.json')),{code:'ENOENT'});
  await assert.rejects(reopened.installDeployment(one),{code:'APPLICATION_DEPLOYMENT_USER_REMOVED'});
  await reopened.installDeployment(await f.miniapp(2));assert.equal((await reopened.resolveCurrent(slot)).deployment.generation,2);
 });
}
test('team: standard ZIP managed removal rejects replay and admits a newly authorized generation',async t=>{
 const f=await fixture(t,'team'),installer=f.open();
 const manifest={applicationId:base,name:'Standard ZIP',version:'0.1.0',protocolVersion:3,runtime:'electron',launchMode:'shared',entrypoint:'main.cjs',capabilities:['identity.read'],compatibility:{backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[{id:'wanx.expert-app.v1',range:'>=1.0.0 <2.0.0',features:['context','expert','data']}],resourceDependencies:[],localDataSchema:{readRange:'=1.0.0',writeVersion:'1.0.0'}}};
 const archivePath=path.join(f.root,'standard.zip');await writeApplicationZip(archivePath,[{name:'application.manifest.json',body:JSON.stringify(manifest)},{name:'main.cjs',body:'module.exports={}'}]);
 const packageSha256=createHash('sha256').update(await readFile(archivePath)).digest('hex');
 const one=await f.miniapp(),binding={...one.binding,scopeId:'b'.repeat(64),ticketId:'c'.repeat(32),payloadDigest:'sha256:'+'d'.repeat(64)};
 const input={archivePath,manifest,packageSha256,artifactHash:binding.artifactHash,binding};
 await installer.installStandardDeployment(input);await installer.uninstallLocal(slot);
 assert.deepEqual(await installer.list(),[]);
 await assert.rejects(installer.installStandardDeployment(input),{code:'APPLICATION_DEPLOYMENT_USER_REMOVED'});
 await assert.rejects(installer.installStandardDeployment({...input,binding:{...binding,fence:2}}),{code:'APPLICATION_DEPLOYMENT_USER_REMOVED'});
 await installer.installStandardDeployment({...input,binding:{...binding,generation:2,operationId:'e'.repeat(32)}});
 await installer.recover();assert.equal((await installer.resolveCurrent(slot)).deployment.generation,2);
 assert.equal(await readFile(path.join(f.data,'retained.txt'),'utf8'),'business data');
});

for(const edition of ['personal','team'])test(`${edition}: local removal also uninstalls an ordinary imported package`,async t=>{
 const f=await fixture(t,edition),installer=f.open(),sourceDir=path.join(f.root,'ordinary'),id='wanx-app-4c30d936';
 await mkdir(sourceDir);
 await writeFile(path.join(sourceDir,'main.cjs'),'module.exports={}');
 await writeFile(path.join(sourceDir,'application.manifest.json'),JSON.stringify({applicationId:id,name: 'Ordinary local ZIP',version:'0.1.1',protocolVersion:1,runtime:'electron',entrypoint:'main.cjs'}));
 const data=path.join(f.rootDir,'.runtime',id);await mkdir(data,{recursive:true});await writeFile(path.join(data,'retained.txt'),'business data');
 await installer.install({sourceDir});
 assert.equal((await installer.list())[0].installationSource,'local');
 await installer.uninstallLocal(id);assert.deepEqual(await installer.list(),[]);
 assert.equal(await readFile(path.join(data,'retained.txt'),'utf8'),'business data');
});
