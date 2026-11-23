import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,link,rename,lstat} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {ZipFile} from 'yazl';
import {createApplicationManager} from '../build/app/applications/manager.mjs';
import {localApplicationProfile,applicationProfilePath} from '../applications/data-profile.mjs';
import filesystem from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const id='centaurai.wanx.zhijun';
const compatibility={backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[],resourceDependencies:[],localDataSchema:{readRange:'>=1.0.0 <2.0.0',writeVersion:'1.0.0'}};
async function fixture(t,{credential=true,data=true,schema=null,audited=false,contextPatch={},contract=compatibility,identity=null}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'wanx-schema-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const applicationRoot=path.join(root,'apps'),profile=identity?applicationProfilePath(applicationRoot,id,localApplicationProfile(identity)):path.join(applicationRoot,'.runtime',id);
 const manifest={applicationId:id,name:'知君',version:'1.0.1',protocolVersion:3,runtime:'electron',launchMode:'shared',entrypoint:audited?'market/main.mjs':'main.mjs',capabilities:[],compatibility:contract};
 const zip=new ZipFile(),chunks=[];zip.addBuffer(Buffer.from(JSON.stringify(manifest)),'wanx-app.json');zip.addBuffer(Buffer.from('export default {};'),manifest.entrypoint);
 const done=new Promise((resolve,reject)=>{zip.outputStream.on('data',v=>chunks.push(v));zip.outputStream.on('end',resolve);zip.outputStream.on('error',reject)});zip.end();await done;
 const bytes=Buffer.concat(chunks),archivePath=path.join(root,'app.wanxapp');await writeFile(archivePath,bytes);
 const descriptor={schemaVersion:3,artifactId:randomUUID(),applicationId:id,version:'1.0.1',os:'universal',arch:'universal',packageType:'wanxapp',fileName:'app.wanxapp',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,minWanxVersion:'0.1.0',hostProtocol:1,compatibility:contract,manifest};
 const keys=generateKeyPairSync('ed25519'),raw=Buffer.from(JSON.stringify(descriptor));
 const envelope={keyId:'test',descriptorBase64:raw.toString('base64'),signatureBase64:sign(null,raw,keys.privateKey).toString('base64')};
 let spawned=0;
 const connection={...(identity?{kind:'local-trust-v1',deriveApplication:async()=>({kind:'local-trust-v1',context:()=>({connection:'ready',boxId:'box-a',dataIdentity:identity}),close(){}})}:{}),context:()=>({connection:'ready',boxId:'box-a',user:{id:1}})};
 const manager=await createApplicationManager({applicationRoot,...(identity?{getDataIdentity:()=>identity}:{}),trustedKeys:{test:keys.publicKey.export({type:'spki',format:'pem'})},
 getCompatibilityContext:async()=>({hostProtocol:1,backend:{schemaVersion:1,productId:'wanx',deviceId:'box-a',observedAt:new Date().toISOString(),authorization:{status:'ready'},contracts:[],resources:[],bindings:[]},applicationConnection:connection,...contextPatch}),
 spawn(_file,_args,options){spawned++;const child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0)};queueMicrotask(()=>child.emit('message',{type:'wanx:application-ready',launchId:options.env.WANX_HOST_LAUNCH_ID}));return child;}});
 t.after(()=>manager.close());await manager.installVerifiedPackage({archivePath,envelope});
 const writer={artifactId:descriptor.artifactId,descriptorDigest:createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')};
 if(data){await mkdir(path.join(profile,'Local Storage'),{recursive:true});await writeFile(path.join(profile,'Local Storage','existing'),'preserve');}
 if(credential){const credentialRoot=path.join(applicationRoot,'.data-access',...(identity?[localApplicationProfile(identity)]:[]));await mkdir(credentialRoot,{recursive:true});await writeFile(path.join(credentialRoot,id+'.json'),JSON.stringify({schemaVersion:1,applicationId:id,writer}));}
 if(schema){await mkdir(profile,{recursive:true});await writeFile(path.join(profile,'.data-schema.json'),JSON.stringify({schemaVersion:1,applicationId:id,dataSchemaVersion:schema,writer}));}
 return {manager,profile,applicationRoot,writer,descriptor,keys,archivePath,spawned:()=>spawned};
}
test('same signed writer with data and no schema stamp launches and backfills without deleting data',async t=>{
 const f=await fixture(t);await f.manager.launch(id);
 const stamp=JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8'));
 assert.equal(stamp.dataSchemaVersion,'1.0.0');assert.deepEqual(stamp.writer,f.writer);assert.equal(await readFile(path.join(f.profile,'Local Storage','existing'),'utf8'),'preserve');assert.equal(f.spawned(),1);
 await f.manager.stop(id);await f.manager.launch(id);assert.equal(f.spawned(),2);
});
test('data without a writer credential stays unknown and does not acquire a stamp',async t=>{
 const f=await fixture(t,{credential:false});await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});await assert.rejects(readFile(path.join(f.profile,'.data-schema.json')),{code:'ENOENT'});assert.equal(f.spawned(),0);
});
test('out of range schema remains incompatible even for the same signed writer',async t=>{
 const f=await fixture(t,{schema:'2.0.0'});await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_SCHEMA_INCOMPATIBLE'});assert.equal(f.spawned(),0);assert.equal(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).dataSchemaVersion,'2.0.0');
});
test('first signed launch writes a schema stamp before child starts',async t=>{
 const f=await fixture(t,{credential:false,data:false});await f.manager.launch(id);assert.equal(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).dataSchemaVersion,'1.0.0');
});
test('retained shared application profile is healed in place without shadowing it',async t=>{
 const f=await fixture(t),legacy=path.join(f.applicationRoot,'..','application-data',id);
 await mkdir(path.dirname(legacy),{recursive:true});await rename(f.profile,legacy);
 await f.manager.launch(id);assert.equal(await readFile(path.join(legacy,'Local Storage','existing'),'utf8'),'preserve');
 assert.equal(JSON.parse(await readFile(path.join(legacy,'.data-schema.json'),'utf8')).dataSchemaVersion,'1.0.0');
 await assert.rejects(lstat(f.profile),{code:'ENOENT'});
});
test('a present stamp cannot replace missing writer evidence or name a different writer',async t=>{
 for(const credential of [false,true]){
  const f=await fixture(t,{credential,schema:'1.0.0'});const stamp=JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8'));
  if(credential){stamp.writer.descriptorDigest='0'.repeat(64);await writeFile(path.join(f.profile,'.data-schema.json'),JSON.stringify(stamp));}
  await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});assert.equal(f.spawned(),0);
 }
});
test('linked and malformed stamps cannot be trusted or replaced during self healing',async t=>{
 for(const attack of process.platform==='win32'?['hardlink','malformed']:['symlink','hardlink','malformed']){
  const f=await fixture(t,{schema:'1.0.0'}),file=path.join(f.profile,'.data-schema.json'),other=path.join(f.applicationRoot,'saved-marker');
  if(attack==='symlink'){await rename(file,other);await symlink(other,file);}
  if(attack==='hardlink')await link(file,other);
  if(attack==='malformed')await writeFile(file,'{bad json');
  await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});assert.equal(f.spawned(),0);
 }
});
test('stamp evidence cannot conflict with explicit provider schema or hide malformed audited data',async t=>{
 const f=await fixture(t,{schema:'1.0.0',contextPatch:{localDataSchemaVersion:'1.1.0'}});
 await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});
 const audited=await fixture(t,{audited:true});const scoped=path.join(audited.profile,'host-scopes','a'.repeat(64));
 await mkdir(scoped,{recursive:true});await writeFile(path.join(scoped,'roles.json'),'{invalid');
 await assert.rejects(audited.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});
 await assert.rejects(readFile(path.join(audited.profile,'.data-schema.json')),{code:'ENOENT'});
});
test('a healed audited profile accepts its own metadata marker on a later launch',async t=>{
 const f=await fixture(t,{audited:true});await f.manager.launch(id);await f.manager.stop(id);await f.manager.launch(id);assert.equal(f.spawned(),2);
});
test('a failed marker projection retains an atomic pending credential and self heals on retry',{skip:process.platform==='win32'},async t=>{
 const {chmod}=await import('node:fs/promises');const f=await fixture(t);
 await chmod(f.profile,0o500);
 try{await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});}finally{await chmod(f.profile,0o700);}
 const access=path.join(f.applicationRoot,'.data-access',id+'.json');
 const pending=JSON.parse(await readFile(access,'utf8'));assert.equal(pending.schemaVersion,2);assert.ok(pending.stampPending);assert.equal(f.spawned(),0);
 await f.manager.launch(id);assert.equal(JSON.parse(await readFile(access,'utf8')).stampPending,null);
 assert.equal(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).dataSchemaVersion,'1.0.0');
});
test('a simulated cross-writer crash only repairs the exact old marker and removes Host temporary writes',async t=>{
 const f=await fixture(t,{audited:true,schema:'1.0.0'}),access=path.join(f.applicationRoot,'.data-access',id+'.json');
 const oldWriter={artifactId:randomUUID(),descriptorDigest:'a'.repeat(64)};
 await writeFile(path.join(f.profile,'.data-schema.json'),JSON.stringify({schemaVersion:1,applicationId:id,writer:oldWriter,dataSchemaVersion:'1.0.0'}));
 await writeFile(access,JSON.stringify({schemaVersion:2,applicationId:id,writer:f.writer,dataSchemaVersion:'1.0.0',stampPending:{location:'primary',previous:{writer:oldWriter,dataSchemaVersion:'1.0.0'}}}));
 const temporary=path.join(f.profile,'.data-schema-'+randomUUID()+'.tmp');await writeFile(temporary,'{partial');
 await f.manager.launch(id);assert.equal(JSON.parse(await readFile(access,'utf8')).stampPending,null);assert.deepEqual(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).writer,f.writer);await assert.rejects(readFile(temporary),{code:'ENOENT'});
});
test('cross-writer recovery closes the Host reader before replacing its pending record',async t=>{
 const f=await fixture(t,{audited:true,schema:'1.0.0'}),access=path.join(f.applicationRoot,'.data-access',id+'.json');
 const oldWriter={artifactId:randomUUID(),descriptorDigest:'a'.repeat(64)};
 await writeFile(path.join(f.profile,'.data-schema.json'),JSON.stringify({schemaVersion:1,applicationId:id,writer:oldWriter,dataSchemaVersion:'1.0.0'}));
 await writeFile(access,JSON.stringify({schemaVersion:2,applicationId:id,writer:f.writer,dataSchemaVersion:'1.0.0',stampPending:{location:'primary',previous:{writer:oldWriter,dataSchemaVersion:'1.0.0'}}}));
 const originalOpen=filesystem.open,originalRename=filesystem.rename,readers=new Set();
 t.after(()=>{filesystem.open=originalOpen;filesystem.rename=originalRename;syncBuiltinESMExports();});
 filesystem.open=async(...args)=>{
  const handle=await originalOpen(...args);
  if(args[0]===access){
   readers.add(handle);const close=handle.close.bind(handle);
   handle.close=async()=>{try{return await close();}finally{readers.delete(handle);}};
  }
  return handle;
 };
 // Model Windows refusing to replace a destination still held by a reader.
 filesystem.rename=async(from,to)=>{if(to===access&&readers.size)throw Object.assign(Error('target is open'),{code:'EPERM'});return originalRename(from,to);};
 syncBuiltinESMExports();
 await f.manager.launch(id);
 assert.equal(JSON.parse(await readFile(access,'utf8')).stampPending,null);
 assert.deepEqual(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).writer,f.writer);
 assert.equal(readers.size,0);
 await f.manager.stop(id);await f.manager.launch(id);assert.equal(f.spawned(),2);
});
test('pending cross-writer recovery refuses a different old writer or schema without rewriting evidence',async t=>{
 for(const mismatch of ['writer','schema']){
  const f=await fixture(t,{audited:true,schema:'1.0.0'}),access=path.join(f.applicationRoot,'.data-access',id+'.json'),file=path.join(f.profile,'.data-schema.json');
  const oldWriter={artifactId:randomUUID(),descriptorDigest:'a'.repeat(64)};
  const marker=JSON.stringify({schemaVersion:1,applicationId:id,writer:oldWriter,dataSchemaVersion:'1.0.0'});
  const pending=JSON.stringify({schemaVersion:2,applicationId:id,writer:f.writer,dataSchemaVersion:'1.0.0',stampPending:{location:'primary',previous:{writer:mismatch==='writer'?{...oldWriter,artifactId:randomUUID()}:oldWriter,dataSchemaVersion:mismatch==='schema'?'1.1.0':'1.0.0'}}});
  await writeFile(file,marker);await writeFile(access,pending);
  const temporary=path.join(f.profile,'.data-schema-'+randomUUID()+'.tmp');await writeFile(temporary,'{partial');
  await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});
  assert.equal(f.spawned(),0);assert.equal(await readFile(file,'utf8'),marker);assert.equal(await readFile(access,'utf8'),pending);assert.equal(await readFile(temporary,'utf8'),'{partial');
 }
});
test('authoritative Host schema takes precedence over an old audited layout heuristic',async t=>{
 const f=await fixture(t,{audited:true,schema:'2.0.0',contract:{...compatibility,localDataSchema:{readRange:'>=2.0.0 <3.0.0',writeVersion:'2.0.0'}}});
 const scoped=path.join(f.profile,'host-scopes','b'.repeat(64));await mkdir(scoped,{recursive:true});await writeFile(path.join(scoped,'roles.json'),JSON.stringify({version:1,users:{}}));
 await f.manager.launch(id);assert.equal(f.spawned(),1);assert.equal(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).dataSchemaVersion,'2.0.0');
});
test('inactive retained profile markers are not mistaken for the active writer',async t=>{
 const f=await fixture(t,{schema:'1.0.0'}),legacy=path.join(f.applicationRoot,'..','application-data',id);
 await mkdir(legacy,{recursive:true});await writeFile(path.join(legacy,'.data-schema.json'),JSON.stringify({schemaVersion:1,applicationId:id,dataSchemaVersion:'1.0.0',writer:{artifactId:randomUUID(),descriptorDigest:'a'.repeat(64)}}));
 await f.manager.launch(id);await f.manager.stop(id);await f.manager.launch(id);assert.equal(f.spawned(),2);
});
test('schema healing stays within the selected local principal and ownership epoch',async t=>{
 const identity={profileId:'profile-a',boxId:'box-a',boxKeyThumbprint:'box-pin-a',ownershipEpoch:1,principalId:'principal-a'};
 const f=await fixture(t,{identity});await f.manager.launch(id);await f.manager.stop(id);
 const original=await readFile(path.join(f.profile,'.data-schema.json'),'utf8');identity.principalId='principal-b';
 const other=applicationProfilePath(f.applicationRoot,id,localApplicationProfile(identity));await mkdir(path.join(other,'Local Storage'),{recursive:true});await writeFile(path.join(other,'Local Storage','existing'),'other-principal-data');
 await assert.rejects(f.manager.launch(id),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});await assert.rejects(readFile(path.join(other,'.data-schema.json')),{code:'ENOENT'});assert.equal(await readFile(path.join(f.profile,'.data-schema.json'),'utf8'),original);
});
test('a lower-writing compatible package does not claim that existing data was downgraded',async t=>{
 const f=await fixture(t,{schema:'2.0.0',contract:{...compatibility,localDataSchema:{readRange:'>=1.0.0 <3.0.0',writeVersion:'1.0.0'}}});
 const oldWriter={artifactId:randomUUID(),descriptorDigest:'b'.repeat(64)};
 await writeFile(path.join(f.applicationRoot,'.data-access',id+'.json'),JSON.stringify({schemaVersion:1,applicationId:id,writer:oldWriter}));
 await writeFile(path.join(f.profile,'.data-schema.json'),JSON.stringify({schemaVersion:1,applicationId:id,dataSchemaVersion:'2.0.0',writer:oldWriter}));
 await f.manager.launch(id);assert.equal(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).dataSchemaVersion,'2.0.0');
 const access=JSON.parse(await readFile(path.join(f.applicationRoot,'.data-access',id+'.json'),'utf8'));assert.equal(access.dataSchemaVersion,'2.0.0');assert.deepEqual(access.writer,f.writer);
 const manifest={...f.descriptor.manifest,version:'1.0.2',compatibility};
 const zip=new ZipFile(),chunks=[];zip.addBuffer(Buffer.from(JSON.stringify(manifest)),'wanx-app.json');zip.addBuffer(Buffer.from('export default {};'),manifest.entrypoint);
 const done=new Promise((resolve,reject)=>{zip.outputStream.on('data',v=>chunks.push(v));zip.outputStream.on('end',resolve);zip.outputStream.on('error',reject)});zip.end();await done;
 const bytes=Buffer.concat(chunks),archivePath=path.join(path.dirname(f.archivePath),'reader-one-only.wanxapp');await writeFile(archivePath,bytes);
 const descriptor={...f.descriptor,artifactId:randomUUID(),version:manifest.version,manifest,compatibility,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
 const raw=Buffer.from(JSON.stringify(descriptor)),envelope={keyId:'test',descriptorBase64:raw.toString('base64'),signatureBase64:sign(null,raw,f.keys.privateKey).toString('base64')};
 await assert.rejects(f.manager.installVerifiedPackage({archivePath,envelope}),{code:'APPLICATION_DATA_SCHEMA_INCOMPATIBLE'});
 assert.equal(JSON.parse(await readFile(path.join(f.profile,'.data-schema.json'),'utf8')).dataSchemaVersion,'2.0.0');
});
