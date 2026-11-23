import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudioControl} from '../integration/host-control.mjs';
import {createTeamService} from '../integration/team-client/service.mjs';
import {createApplicationInstaller} from '../../team-client/applications/installer.mjs';
import {createApplicationInstaller as personalInstaller} from '../../personal-client/applications/installer.mjs';

const exec=promisify(execFile);
async function fixture(t,{legacy=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'studio-standard-install-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source');await mkdir(path.join(source,'shell'),{recursive:true});
  const manifest={applicationId:'dev.wanx.standard.12345678',name:'Standard installation',version:'0.1.0',protocolVersion:3,runtime:'electron',entrypoint:'shell/main.cjs',capabilities:['identity.read'],compatibility:{backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[],resourceDependencies:[],localDataSchema:{readRange:'=1.0.0',writeVersion:'1.0.0'}}};
  await writeFile(path.join(source,'application.manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(source,'shell/main.cjs'),'// synthetic standard entry; never executed');
  const archive=path.join(root,'application.zip');await exec('/usr/bin/zip',['-q','-r',archive,'.'],{cwd:source});
  const bytes=await readFile(archive),packageSha256=createHash('sha256').update(bytes).digest('hex');
  const payload=legacy?{applicationId:'ai.wanx.selfmade.'+'c'.repeat(32),name:'Legacy installation',version:'0.1.0',artifactHash:'a'.repeat(64),manifest:{schemaVersion:1,name:'Legacy installation',entry:'src/app.js',capabilities:[],collections:{}},bundle:'// legacy synthetic UI',css:''}:{applicationId:manifest.applicationId,version:manifest.version,artifactHash:'a'.repeat(64),manifest,packageBase64:bytes.toString('base64'),packageSha256};
  for(const name of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])await writeFile(path.join(source,name),'');
  const installer=createApplicationInstaller({rootDir:path.join(root,'installed'),getCompatibilityContext:async()=>({hostProtocol:1})});
  const receipts=[];
  const connection={context:()=>({accountId:'synthetic-account',boxId:'synthetic-box',user:{id:1}}),request:async input=>{if(input.method==='POST'){receipts.push(JSON.parse(input.body));return{status:200,body:Buffer.from('{}')}}return{status:200,body:Buffer.from(JSON.stringify(payload))}}};
  const control=createStudioControl({assets:source,applications:{install:(...args)=>installer.install(...args),listInstalled:()=>installer.list()}});
  const install=()=>control({operation:'install',body:{projectId:'b'.repeat(32),artifactHash:'a'.repeat(64)},connection,assertLive(){}});
  const context={protocolVersion:1,accountId:'synthetic-account',clientId:'synthetic-client',boxId:'synthetic-box',user:{id:1}};
  const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:context.accountId,clientId:context.clientId},connection:{deviceId:context.boxId}}),applicationConnection:async()=>({context:()=>context,request:async input=>({status:200,body:Buffer.from(JSON.stringify(input.path==='/api/auth/me'?{id:1,role:'admin',application_id:'wanx'}:payload))})})};
  const launched=[];
  const team=createTeamService({client,applications:{install:(...args)=>installer.install(...args),listInstalled:()=>installer.list(),launch:async applicationId=>{launched.push(applicationId);return{applicationId}}}});
  const open=()=>team.action('open',{applicationId:payload.applicationId,artifactHash:payload.artifactHash});
  return{root,archive,payload,installer,install,receipts,packageSha256,open,launched};
}

test('personal installer records the exact adopted package and rejects mismatched identity',async t=>{
  const app=await fixture(t);
  const installer=personalInstaller({rootDir:path.join(app.root,'personal'),getCompatibilityContext:async()=>({hostProtocol:1})});
  const input={archivePath:app.archive,standardArtifactHash:app.packageSha256,manifest:app.payload.manifest};
  await assert.rejects(installer.install({...input,manifest:{...input.manifest,version:'1.0.1'}}),{code:'APPLICATION_MANIFEST_MISMATCH'});
  await assert.rejects(installer.install({...input,standardArtifactHash:'a'.repeat(64)}),{code:'APPLICATION_ARTIFACT_INVALID'});
  assert.equal((await installer.list()).length,0);
  await installer.install(input);
  const [installed]=await installer.list();
  assert.equal(installed.applicationId,input.manifest.applicationId);
  assert.equal(installed.packageSha256,input.standardArtifactHash);
});

test('original Kaiwu installs a standard ZIP through the real installer with its verified descriptor',async t=>{
  const f=await fixture(t);await f.install();
  const [installed]=await f.installer.list();
  assert.equal(installed.descriptor?.sha256,f.packageSha256);
  assert.equal(installed.descriptor?.applicationId,f.payload.applicationId);
  assert.equal(installed.descriptor?.manifest.protocolVersion,3);
  assert.equal(f.receipts.length,1);
});


test('standard installation retries reuse only the same verified ZIP and reject changed bytes without a receipt',async t=>{
  const f=await fixture(t);await f.install();await f.install();
  assert.equal((await f.installer.list()).length,1);
  assert.equal(f.receipts.length,2);
  f.payload.packageBase64=Buffer.from('PKdifferent archive').toString('base64');
  await assert.rejects(f.install(),{code:'STANDARD_PACKAGE_HASH_MISMATCH'});
  assert.equal(f.receipts.length,2);
});


test('original Kaiwu opens both existing and letter-prefixed generated standard IDs',async()=>{
  const launched=[];const control=createStudioControl({applications:{launch:async id=>launched.push(id)}});
  for(const applicationId of ['dev.wanx.standard.12345678','dev.wanx.standard.a12345678'])await control({operation:'open',body:{applicationId},assertLive(){}});
  assert.deepEqual(launched,['dev.wanx.standard.12345678','dev.wanx.standard.a12345678']);
  for(const applicationId of ['dev.wanx.standard.b12345678','dev.wanx.'+'a'.repeat(64)])await assert.rejects(control({operation:'open',body:{applicationId},assertLive(){}}),{code:'STUDIO_APP_ID_DENIED'});
});


test('same-version standard reuse rejects changed digests or missing descriptors without accepting receipts',async t=>{
  const f=await fixture(t);await f.install();
  const original=f.payload.packageBase64;
  const changed=Buffer.concat([Buffer.from(original,'base64'),Buffer.from('different ZIP bytes')]);
  f.payload.packageBase64=changed.toString('base64');f.payload.packageSha256=createHash('sha256').update(changed).digest('hex');
  await assert.rejects(f.install(),{code:'INSTALLED_ARTIFACT_MISMATCH'});
  f.payload.packageBase64=original;f.payload.packageSha256=f.packageSha256;
  const [installed]=await f.installer.list();delete installed.descriptor;
  await writeFile(path.join(installed.installPath,'.wanx-install.json'),JSON.stringify(installed));
  await assert.rejects(f.install(),{code:'INSTALLED_ARTIFACT_MISMATCH'});
  assert.equal(f.receipts.length,1);
});

test('real standard installer refuses payload/ZIP manifest disagreement before a receipt',async t=>{
  const f=await fixture(t);f.payload.manifest.name='Unexpected replacement';
  await assert.rejects(f.install(),{code:'APPLICATION_MANIFEST_MISMATCH'});
  assert.deepEqual(await f.installer.list(),[]);assert.equal(f.receipts.length,0);
});

test('legacy miniapp installation is refused before writing or acknowledging',async t=>{
  const f=await fixture(t,{legacy:true});
  await assert.rejects(f.install(),{code:'STANDARD_PACKAGE_REQUIRED'});
  assert.deepEqual(await f.installer.list(),[]);assert.equal(f.receipts.length,0);
});

test('Team standard opening uses the real installer and validates bytes again on reuse',async t=>{
  const f=await fixture(t);await f.open();await f.open();
  assert.equal((await f.installer.list())[0].descriptor.sha256,f.packageSha256);
  assert.equal(f.launched.length,2);
  f.payload.packageBase64=Buffer.from('PKchanged but stale declared digest').toString('base64');
  await assert.rejects(f.open(),{code:'STANDARD_PACKAGE_HASH_MISMATCH'});
  assert.equal(f.launched.length,2);
});


test('Team same-version reuse rejects a descriptor for another application before launch',async t=>{
  const f=await fixture(t);await f.open();
  const [installed]=await f.installer.list();installed.descriptor.applicationId='dev.wanx.another';
  await writeFile(path.join(installed.installPath,'.wanx-install.json'),JSON.stringify(installed));
  await assert.rejects(f.open(),{code:'TEAM_ARTIFACT_MISMATCH'});
  assert.equal(f.launched.length,1);
});
