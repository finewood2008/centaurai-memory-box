import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash,generateKeyPairSync,sign,randomUUID}from'node:crypto';
import {createRequire}from'node:module';
import {verifyEnvelope}from'../../personal-client/applications/descriptor.mjs';
const {ZipFile}=createRequire(new URL('../../personal-client/package.json',import.meta.url))('yazl');
const signingKeys=generateKeyPairSync('ed25519'),trustedKeys={test:signingKeys.publicKey.export({type:'spki',format:'pem'})};
import {createApplicationInstaller as personalInstaller}from'../../personal-client/applications/installer.mjs';
import {createApplicationInstaller as teamInstaller}from'../../team-client/applications/installer.mjs';
import {writeMiniappPackage}from'../core/package.mjs';
import {createDeploymentDelivery,deploymentTicket}from'../integration/personal-client/deployment-delivery.mjs';
const stable=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=x=>'sha256:'+createHash('sha256').update(stable(x)).digest('hex');
const base='ai.wanx.selfmade.'+'a'.repeat(32),slot='ai.wanx.selfmade.'+'b'.repeat(32);
function payload(generation=1,version='1.0.0',operationId='c'.repeat(32)){
 return{applicationId:slot,name:'部署测试',version,artifactHash:'d'.repeat(64),manifest:{schemaVersion:1,name:'部署测试',entry:'src/app.js',capabilities:['data'],collections:{}},bundle:'test',css:'',runtimeNamespace:'workshop',deployment:{schemaVersion:1,profile:'wanx-miniapp-v1',operationId,environment:'dev',generation,baseApplicationId:base,slotApplicationId:slot,boxId:'box-test'}};
}
for(const[edition,createApplicationInstaller]of [['personal',personalInstaller],['team',teamInstaller]]){
const test=(name,run)=>nodeTest(edition+': '+name,run);
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'deployment-delivery-test-'));try{const assets=path.join(root,'assets');await mkdir(assets);for(const f of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])await writeFile(path.join(assets,f),'');await run({root,assets,installer:createApplicationInstaller({rootDir:path.join(root,'installed'),trustedKeys})})}finally{await rm(root,{recursive:true,force:true})}}
async function source(root,assets,p,postfix='source'){const directory=path.join(root,postfix);await writeMiniappPackage(p,directory,{assets});return directory}
const binding=p=>({...p.deployment,fence:1,artifactHash:p.artifactHash});
test('trusted managed slot installs real files; explicit downgrade uses generation, ordinary imports remain denied',()=>fixture(async({root,assets,installer})=>{
 const p=payload(),dir=await source(root,assets,p);const record=await installer.installDeployment({sourceDir:dir,binding:binding(p)});
 assert.equal(record.applicationId,slot);assert.equal(JSON.parse(await readFile(path.join(record.installPath,'miniapp.runtime.json'))).deployment.environment,'dev');
 await installer.installDeployment({sourceDir:dir,binding:binding(p)});
 const old=payload(2,'0.9.0','e'.repeat(32));const olddir=await source(root,assets,old,'old');await installer.installDeployment({sourceDir:olddir,binding:binding(old)});
 assert.equal((await installer.resolveCurrent(slot)).version,'0.9.0');
 await assert.rejects(installer.installDeployment({sourceDir:dir,binding:binding(p)}),/APPLICATION_DEPLOYMENT_STALE/);
 await assert.rejects(installer.install({sourceDir:dir}),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
}));
test('managed delivery cannot take over an ordinary slot or publish after scope cancellation',()=>fixture(async({root,assets,installer})=>{
 const p=payload(),dir=await source(root,assets,p);await installer.install({sourceDir:dir});
 await assert.rejects(installer.installDeployment({sourceDir:dir,binding:binding(p)}),/APPLICATION_DEPLOYMENT_SLOT_OCCUPIED/);
 const controller=new AbortController();controller.abort(Error('scope invalidated'));
 await assert.rejects(installer.installDeployment({sourceDir:dir,binding:binding(p)},{signal:controller.signal}),/scope invalidated/);
}));
test('worker prepare does not install; activate ACK follows actual filesystem install and disk verification',()=>fixture(async({root,assets,installer})=>{
 const p=payload();let step='prepare_client',acks=[],installs=0;
 const ticket=()=>({id:(step==='activate'?'f':'1').repeat(32),nonce:'nonce-value-123456789',profile:'wanx-miniapp-v1',operationId:p.deployment.operationId,projectId:'2'.repeat(32),baseApplicationId:base,slotApplicationId:slot,generation:1,fence:1,step,artifactHash:p.artifactHash,version:p.version,environment:'dev',boxId:'box-test',payloadDigest:hash(p)});
 const s={assertLive(){},active:{link:{context:()=>({boxId:'box-test'})}},async request(route,method,body){if(route==='/deployment/client-deliveries')return{items:[ticket()]};if(route.endsWith('/claim'))return ticket();if(route.endsWith('/payload'))return p;if(route.endsWith('/ack')){acks.push(body);return{accepted:true}}throw Error('unexpected request')}};
 const worker=createDeploymentDelivery({session:async()=>s,scopeKey:()=> 'owner-box',root:path.join(root,'journal'),assets,applications:{installDeployment:async(...args)=>{installs++;return installer.installDeployment(...args)},listInstalled:()=>installer.list(),launch:async()=>({launched:true})},intervalMs:100000});
 try{await worker.tick();assert.equal(installs,0);assert.equal(acks[0].state,'prepared');step='activate';await worker.tick();assert.equal(installs,1);assert.equal(acks[1].state,'active');assert.equal((await installer.list())[0].deployment.generation,1);await worker.tick();assert.equal((await installer.list()).length,1)}finally{worker.close()}
}));
test('wrong payload digest reports only failure, never prepared/active or installs',()=>fixture(async({root,assets})=>{
 let calls=0,acks=[];const p=payload(),ticket={id:'1'.repeat(32),nonce:'nonce-value-123456789',profile:'wanx-miniapp-v1',operationId:p.deployment.operationId,projectId:'2'.repeat(32),baseApplicationId:base,slotApplicationId:slot,generation:1,fence:1,step:'activate',artifactHash:p.artifactHash,version:p.version,environment:'dev',boxId:'box-test',payloadDigest:'sha256:'+'0'.repeat(64)};
 const s={assertLive(){},active:{link:{context:()=>({boxId:'box-test'})}},async request(route,method,body){if(route.endsWith('client-deliveries'))return{items:[ticket]};if(route.endsWith('/claim'))return ticket;if(route.endsWith('/payload'))return p;if(route.endsWith('/ack'))acks.push(body)}};
 const w=createDeploymentDelivery({session:async()=>s,scopeKey:()=> 'owner-box',root:path.join(root,'journal'),assets,applications:{installDeployment:()=>{calls++},listInstalled:()=>[]},intervalMs:100000});try{await w.tick();assert.equal(calls,0);assert.equal(acks.length,1);assert.equal(acks[0].state,'failed');assert.equal(acks[0].errorCode,'CLIENT_UNAVAILABLE')}finally{w.close()}
}));

test('expert profile preserves the external base identity while the trusted worker installs only its managed slot',()=>fixture(async({root,assets,installer})=>{
 const p=payload();p.deployment.profile='wanx-expert-app-v1';p.deployment.baseApplicationId='demo.expert.application';p.manifest.capabilities=['foundation','data'];
 const ticket={id:'1'.repeat(32),nonce:'nonce-value-123456789',profile:p.deployment.profile,operationId:p.deployment.operationId,projectId:'2'.repeat(32),baseApplicationId:p.deployment.baseApplicationId,slotApplicationId:slot,generation:1,fence:1,step:'activate',artifactHash:p.artifactHash,version:p.version,environment:'dev',boxId:'box-test',payloadDigest:hash(p)};
 const acks=[];let launched;
 const s={assertLive(){},active:{link:{context:()=>({boxId:'box-test'})}},async request(route,method,body){if(route.endsWith('client-deliveries'))return{items:[ticket]};if(route.endsWith('/claim'))return ticket;if(route.endsWith('/payload'))return p;if(route.endsWith('/ack')){assert.equal((await installer.list())[0].deployment.baseApplicationId,p.deployment.baseApplicationId);acks.push(body);return{accepted:true}}throw Error('unexpected request')}};
 const worker=createDeploymentDelivery({session:async()=>s,scopeKey:()=> 'owner-box',root:path.join(root,'journal'),assets,applications:{installDeployment:(...args)=>installer.installDeployment(...args),listInstalled:()=>installer.list(),launch:async id=>{launched=id}},intervalMs:100000});
 try{await worker.tick();assert.equal(acks.length,1);assert.equal(acks[0].state,'active');assert.equal(launched,slot);const current=await installer.resolveCurrent(slot);assert.equal(current.deployment.profile,'wanx-expert-app-v1');const actual=JSON.parse(await readFile(path.join(current.installPath,'miniapp.runtime.json')));assert.equal(actual.deployment.baseApplicationId,'demo.expert.application');assert.equal(actual.applicationId,slot);}finally{worker.close()}
 assert.throws(()=>deploymentTicket({...ticket,profile:'unknown-expert-profile'}),/DEPLOYMENT_TICKET_INVALID/);
 assert.throws(()=>deploymentTicket({...ticket,profile:'wanx-miniapp-v1'}),/DEPLOYMENT_TICKET_INVALID/);
 assert.throws(()=>deploymentTicket({...ticket,baseApplicationId:'../outside'}),/DEPLOYMENT_TICKET_INVALID/);
}));

test('scope invalidation during the real file copy cannot publish a managed current pointer',()=>fixture(async({root,assets})=>{
 const controller=new AbortController();
 const installer=createApplicationInstaller({rootDir:path.join(root,'cancelled'),copy:async(...args)=>{await cp(...args);controller.abort(Error('scope changed during copy'))}});
 const p=payload(),dir=await source(root,assets,p);
 await assert.rejects(installer.installDeployment({sourceDir:dir,binding:binding(p)},{signal:controller.signal}),/scope changed during copy/);
 assert.deepEqual(await installer.list(),[]);
}));

async function signedSlot(root){
 const manifest={applicationId:slot,name:'signed slot',version:'9.0.0',protocolVersion:1,runtime:'electron',launchMode:'shared',entrypoint:'runtime-main.cjs'};
 const zip=new ZipFile(),chunks=[];zip.addBuffer(Buffer.from(JSON.stringify(manifest)),'wanx-app.json');zip.addBuffer(Buffer.from('module.exports={};'),'runtime-main.cjs');
 const done=new Promise((resolve,reject)=>{zip.outputStream.on('data',x=>chunks.push(x));zip.outputStream.on('error',reject);zip.outputStream.on('end',resolve)});zip.end();await done;
 const bytes=Buffer.concat(chunks),descriptor={schemaVersion:1,artifactId:randomUUID(),applicationId:slot,version:manifest.version,os:'universal',arch:'universal',packageType:'wanxapp',fileName:'slot.wanxapp',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,minWanxVersion:'0.1.0',hostProtocol:1,manifest};
 const encoded=Buffer.from(JSON.stringify(descriptor)),envelope={keyId:'test',descriptorBase64:encoded.toString('base64'),signatureBase64:sign(null,encoded,signingKeys.privateKey).toString('base64')};
 assert.equal(verifyEnvelope(envelope,trustedKeys).applicationId,slot);
 const archivePath=path.join(root,'signed-slot.wanxapp');await writeFile(archivePath,bytes);return{archivePath,envelope};
}
test('a genuinely signed package and ordinary selectors cannot replace or erase a managed slot',()=>fixture(async({root,assets,installer})=>{
 const p=payload(),dir=await source(root,assets,p);await installer.installDeployment({sourceDir:dir,binding:binding(p)});
 const before=await installer.resolveCurrent(slot),signed=await signedSlot(root);
 for(const input of [signed,{...signed,onlyIfMissing:true}])await assert.rejects(installer.installVerifiedPackage(input),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(installer.rollback(slot),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(installer.selectCurrent(slot,'9.0.0'),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await assert.rejects(installer.uninstall(slot),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 await installer.prune(slot);assert.deepEqual(await installer.resolveCurrent(slot),before);
}));
test('a reserved managed marker without a committed current pointer also rejects signed takeover',()=>fixture(async({root,installer})=>{
 const directory=path.join(root,'installed',slot);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'.wanx-managed-deployment.json'),JSON.stringify(binding(payload())));
 assert.deepEqual(await installer.list(),[]);
 await assert.rejects(installer.installVerifiedPackage(await signedSlot(root)),/APPLICATION_MANAGED_DEPLOYMENT_REQUIRED/);
 assert.deepEqual(await installer.list(),[]);
}));

test('Studio delivery persists its trusted namespace and refuses a Workshop payload even with a matching digest',()=>fixture(async({root,assets,installer})=>{
 const p=payload();p.runtimeNamespace='studio';p.deployment.profile='wanx-expert-app-v1';
 let payloadNamespace='studio';const acks=[];
 const current=()=>({...p,runtimeNamespace:payloadNamespace});
 const ticket=()=>({id:'1'.repeat(32),nonce:'nonce-value-123456789',profile:p.deployment.profile,operationId:p.deployment.operationId,projectId:'2'.repeat(32),baseApplicationId:base,slotApplicationId:slot,generation:1,fence:1,step:'activate',artifactHash:p.artifactHash,version:p.version,environment:'dev',boxId:'box-test',payloadDigest:hash(current())});
 const s={assertLive(){},active:{link:{context:()=>({boxId:'box-test'})}},async request(route,method,body){if(route.endsWith('client-deliveries'))return{items:[ticket()]};if(route.endsWith('/claim'))return ticket();if(route.endsWith('/payload'))return current();if(route.endsWith('/ack')){acks.push(body);return{accepted:true}}throw Error('unexpected request')}};
 const worker=createDeploymentDelivery({runtimeNamespace:'studio',session:async()=>s,scopeKey:()=> 'owner-box',root:path.join(root,'journal'),assets,applications:{installDeployment:(...args)=>installer.installDeployment(...args),listInstalled:()=>installer.list(),launch:async()=>{}},intervalMs:100000});
 try{await worker.tick();assert.equal(acks.at(-1).state,'active');const installed=await installer.resolveCurrent(slot);const record=JSON.parse(await readFile(path.join(installed.installPath,'miniapp.runtime.json')));assert.equal(record.runtimeNamespace,'studio');payloadNamespace='workshop';await worker.tick();assert.equal(acks.at(-1).state,'failed');}finally{worker.close()}
}));
test('default Workshop delivery rejects a Studio namespace before installation',()=>fixture(async({root,assets,installer})=>{
 const p=payload();p.runtimeNamespace='studio';let installs=0;const acks=[];
 const ticket={id:'1'.repeat(32),nonce:'nonce-value-123456789',profile:p.deployment.profile,operationId:p.deployment.operationId,projectId:'2'.repeat(32),baseApplicationId:base,slotApplicationId:slot,generation:1,fence:1,step:'activate',artifactHash:p.artifactHash,version:p.version,environment:'dev',boxId:'box-test',payloadDigest:hash(p)};
 const s={assertLive(){},active:{link:{context:()=>({boxId:'box-test'})}},async request(route,method,body){if(route.endsWith('client-deliveries'))return{items:[ticket]};if(route.endsWith('/claim'))return ticket;if(route.endsWith('/payload'))return p;if(route.endsWith('/ack')){acks.push(body);return{accepted:true}}}};
 const worker=createDeploymentDelivery({session:async()=>s,scopeKey:()=> 'owner-box',root:path.join(root,'journal'),assets,applications:{installDeployment:async()=>{installs++},listInstalled:()=>installer.list()},intervalMs:100000});
 try{await worker.tick();assert.equal(installs,0);assert.equal(acks[0].state,'failed');assert.deepEqual(await installer.list(),[])}finally{worker.close()}
}));
}

nodeTest('invalid trusted namespace configuration is refused instead of creating a worker',()=>assert.throws(()=>createDeploymentDelivery({runtimeNamespace:'foreign'}),/DEPLOYMENT_NAMESPACE_INVALID/));
