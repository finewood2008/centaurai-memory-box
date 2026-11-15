import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {generateKeyPairSync, sign, randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createApplicationInstaller} from '../applications/installer.mjs';

for (const protocolVersion of [2,3]) test(`signed v${protocolVersion} version selection uses Host writer continuity without hiding incompatible schema`, async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'wanx-select-continuity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='centaurai.wanx.zhijun', artifactId=randomUUID();
 const compatibility={backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[],
  ...(protocolVersion===3?{resourceDependencies:[]}:{requiredExperts:[]}),localDataSchema:{readRange:'>=1.0.0 <2.0.0',writeVersion:'1.0.0'}};
 const manifest={applicationId:id,name:'Zhijun',version:'1.0.0',protocolVersion,runtime:'electron',entrypoint:'main.mjs',capabilities:['identity.read'],compatibility};
 const descriptor={schemaVersion:protocolVersion===3?3:2,artifactId,applicationId:id,version:'1.0.0',os:'universal',arch:'universal',packageType:'wanxapp',fileName:'test.wanxapp',sha256:'c'.repeat(64),size:1,minWanxVersion:'0.1.0',hostProtocol:1,compatibility,manifest};
 const keys=generateKeyPairSync('ed25519'),bytes=Buffer.from(JSON.stringify(descriptor));
 const envelope={keyId:'test',descriptorBase64:bytes.toString('base64'),signatureBase64:sign(null,bytes,keys.privateKey).toString('base64')};
 const appDir=path.join(root,id),installPath=path.join(appDir,artifactId);await mkdir(installPath,{recursive:true});
 await writeFile(path.join(installPath,'.wanx-install.json'),JSON.stringify({...manifest,artifactId,descriptor,envelope,installPath}));
 const legacy=path.join(appDir,'legacy');await mkdir(legacy);await writeFile(path.join(legacy,'.wanx-install.json'),JSON.stringify({...manifest,protocolVersion:1,compatibility:undefined,version:'legacy',installPath:legacy}));
 const pointer=path.join(appDir,'.current-version.json');const reset=()=>writeFile(pointer,JSON.stringify({choices:['legacy','1.0.0']}));await reset();
 let trusted=true,schema=null;
 const installer=createApplicationInstaller({rootDir:root,trustedKeys:{test:keys.publicKey.export({type:'spki',format:'pem'})},getCompatibilityContext:()=>({hostProtocol:1,localDataPresent:true,localDataSchemaVersion:schema}),hasTrustedDataContinuity:async value=>trusted&&value.artifactId===artifactId});
 await installer.selectCurrent(id,'1.0.0');assert.equal((await installer.resolveCurrent(id)).artifactId,artifactId);
 await reset();trusted=false;await assert.rejects(installer.selectCurrent(id,'1.0.0'),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});
 trusted=true;schema='2.0.0';await assert.rejects(installer.selectCurrent(id,'1.0.0'),{code:'APPLICATION_DATA_SCHEMA_INCOMPATIBLE'});
});
