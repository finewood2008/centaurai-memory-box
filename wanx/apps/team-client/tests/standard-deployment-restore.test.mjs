import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {createApplicationInstaller} from '../applications/installer.mjs';
import {createStudioControl} from '../../builder/integration/host-control.mjs';
const exec=promisify(execFile),applicationId='dev.wanx.restore.a12345678',projectId='3'.repeat(32);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'standard-restore-')));t.after(()=>rm(root,{recursive:true,force:true}));
 async function build(version,artifactHash){
  const source=path.join(root,'source-'+version);await mkdir(path.join(source,'shell'),{recursive:true});
  const manifest={applicationId,name:'Restore standard',version,protocolVersion:3,runtime:'electron',launchMode:'shared',entrypoint:'shell/main.cjs',capabilities:['identity.read'],compatibility:{backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[],resourceDependencies:[],localDataSchema:{readRange:'=1.0.0',writeVersion:'1.0.0'}}};
  await writeFile(path.join(source,'application.manifest.json'),JSON.stringify(manifest));await writeFile(path.join(source,'shell/main.cjs'),'// immutable original version '+version);
  const archivePath=path.join(root,'package-'+version+'.zip');await exec('/usr/bin/zip',['-q','-r',archivePath,'.'],{cwd:source});const bytes=await readFile(archivePath);
  return{archivePath,payload:{applicationId,version,artifactHash,manifest,packageSha256:hash(bytes),packageBase64:bytes.toString('base64')}};
 }
 const old=await build('0.1.0','a'.repeat(64)),latest=await build('0.1.1','b'.repeat(64));let adopted=old.payload,schema=null;
 const installer=createApplicationInstaller({rootDir:path.join(root,'installed'),getCompatibilityContext:async()=>({hostProtocol:1,...(schema?{localDataPresent:true,localDataSchemaVersion:schema}:{})})}),receipts=[];
 const control=createStudioControl({applications:{install:(...args)=>installer.install(...args),restoreStandardPackage:(...args)=>installer.restoreStandardPackage(...args),listInstalled:()=>installer.list()}});
 const connection={context:()=>({accountId:'synthetic-account',boxId:'synthetic-box',user:{id:7}}),async request(input){
  if(input.method==='GET'){
   assert.equal(input.path,`/api/app-studio/projects/${projectId}/install/${adopted.artifactHash}`);return{status:200,body:Buffer.from(JSON.stringify(adopted))};
  }
  const receipt=JSON.parse(input.body.toString());assert.equal(receipt.artifactHash,adopted.artifactHash);receipts.push(receipt);return{status:200,body:Buffer.from('{}')};
 }};
 const install=(body={projectId,artifactHash:adopted.artifactHash})=>control({operation:'install',body,connection,assertLive(){}});
 await install();adopted=latest.payload;await install();assert.equal((await installer.resolveCurrent(applicationId)).version,'0.1.1');
 const data=path.join(root,'installed','.runtime',applicationId,'customer.json');await mkdir(path.dirname(data),{recursive:true});await writeFile(data,'{"preserved":true}');
 return{root,installer,old,latest,receipts,install,data,adopt(payload){adopted=payload},schema(value){schema=value},restore(){adopted={...old.payload,restore:{schemaVersion:1,source:'restore',artifactHash:old.payload.artifactHash}}}};
}
for(const pruned of [false,true])test('the original Host installs adopted 0.1.0 after 0.1.1 restore with '+(pruned?'a pruned':'a retained')+' old directory',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.installer.installStandardPackage({archivePath:f.old.archivePath,manifest:f.old.payload.manifest,artifactHash:f.old.payload.packageSha256}),/APPLICATION_VERSION_DOWNGRADE/);
 if(pruned)await rm(path.join(f.root,'installed',applicationId,'0.1.0'),{recursive:true});
 f.schema('1.0.0');f.restore();await f.install();
 const record=await f.installer.resolveCurrent(applicationId);assert.equal(record.version,'0.1.0');assert.equal(record.descriptor.sha256,f.old.payload.packageSha256);
 assert.equal(JSON.parse(await readFile(path.join(record.installPath,'application.manifest.json'))).version,'0.1.0');
 assert.equal(await readFile(path.join(record.installPath,'shell/main.cjs'),'utf8'),'// immutable original version 0.1.0');
 assert.equal(await readFile(f.data,'utf8'),'{"preserved":true}');assert.equal(f.receipts.at(-1).artifactHash,f.old.payload.artifactHash);
 await f.install();assert.equal((await f.installer.list()).length,1,'restore retry revalidates and reuses the current old ZIP');
});
test('ordinary historical adoption and renderer force cannot select a lower installed standard version',async t=>{
 const f=await fixture(t);f.adopt(f.old.payload);
 await assert.rejects(f.install(),/APPLICATION_VERSION_DOWNGRADE/);
 await assert.rejects(f.install({projectId,artifactHash:f.old.payload.artifactHash,force:true}),/STUDIO_REQUEST_DENIED/);
 assert.equal((await f.installer.resolveCurrent(applicationId)).version,'0.1.1');assert.equal(f.receipts.length,2);
});
test('restore rejects incompatible preserved data and leaves the newer pointer and both packages intact',async t=>{
 const f=await fixture(t);f.schema('2.0.0');f.restore();
 await assert.rejects(f.install(),/APPLICATION_DATA_SCHEMA_INCOMPATIBLE/);
 assert.equal((await f.installer.resolveCurrent(applicationId)).version,'0.1.1');assert.equal(await readFile(f.data,'utf8'),'{"preserved":true}');assert.equal(f.receipts.length,2);
});
test('restore cannot attest tampered retained bytes or a marker/hash not matching the authenticated adopted payload',async t=>{
 const f=await fixture(t);f.restore();await writeFile(path.join(f.root,'installed',applicationId,'0.1.0','shell/main.cjs'),'// tampered old bytes');
 await assert.rejects(f.install(),/MARKET_PACKAGE_INVALID/);assert.equal((await f.installer.resolveCurrent(applicationId)).version,'0.1.1');
 f.adopt({...f.old.payload,restore:{schemaVersion:1,source:'restore',artifactHash:f.latest.payload.artifactHash}});
 await assert.rejects(f.install(),/STUDIO_RESTORE_DENIED/);assert.equal(f.receipts.length,2);
});
