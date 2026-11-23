import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createApplicationInstaller} from '../applications/installer.mjs';
import {createUIBroadcast as teamBroadcast} from '../shell/ui-broadcast.mjs';
import {createUIBroadcast as personalBroadcast} from '../../personal-client/shell/ui-broadcast.mjs';

const exec=promisify(execFile),tick=()=>new Promise(resolve=>setImmediate(resolve));
const base='dev.wanx.presentation',name='wanx-app-1c485617';
async function installedPair(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'wanx-presentation-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source');await mkdir(path.join(source,'shell'),{recursive:true});
 const manifest={applicationId:base,name,version:'0.1.3',protocolVersion:3,runtime:'electron',launchMode:'shared',entrypoint:'shell/main.cjs',capabilities:['identity.read','http.request'],compatibility:{backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[{id:'wanx.expert-app.v1',range:'>=1.0.0 <2.0.0',features:['context','expert','data']}],resourceDependencies:[],localDataSchema:{readRange:'=1.0.0',writeVersion:'1.0.0'}}};
 await writeFile(path.join(source,'application.manifest.json'),JSON.stringify(manifest));await writeFile(path.join(source,'shell/main.cjs'),'// own fixture');
 const archivePath=path.join(root,'app.zip');await exec('/usr/bin/zip',['-q','-r',archivePath,'.'],{cwd:source});
 const packageSha256=createHash('sha256').update(await readFile(archivePath)).digest('hex');
 const installer=createApplicationInstaller({rootDir:path.join(root,'installed'),getCompatibilityContext:async()=>({hostProtocol:1})});
 for(const [environment,c] of [['dev','a'],['prod','b']]){
  const slot='ai.wanx.selfmade.'+c.repeat(32),binding={schemaVersion:1,profile:'wanx-expert-app-v1',baseApplicationId:base,slotApplicationId:slot,boxId:'synthetic-box',environment,generation:1,operationId:c.repeat(32),fence:1,artifactHash:'d'.repeat(64),scopeId:'e'.repeat(64),ticketId:'f'.repeat(32),payloadDigest:'sha256:'+'1'.repeat(64)};
  await installer.installStandardDeployment({archivePath,manifest,packageSha256,artifactHash:binding.artifactHash,binding});
 }
 return {installer,records:await installer.list()};
}
async function broadcast(create,records){
 let value,resolvePopulated;const errors=[];const populated=new Promise(resolve=>resolvePopulated=resolve);
 const frame = {
  isDestroyed: () => false,
  send(_channel, state) {
   value = state;
   if (state.applications?.length) resolvePopulated();
  },
 };
 const window = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, mainFrame: frame, send: frame.send },
 };
 const b=create({client:{snapshot:()=>({account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:'synthetic-box',mode:'local'}})},applications:{listInstalled:async()=>records},uiState:{snapshot:()=>({})},startup:{get:()=>({})},windows:()=>[window],onError:e=>errors.push(e)});
 let timer;try{b.publish();await Promise.race([populated,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('UI projection timeout')),5000)})]);}finally{clearTimeout(timer);b.dispose()}assert.deepEqual(errors,[]);return value.applications;
}
test('real same-name managed ZIP installations acquire distinct safe environment presentation at the team UI boundary',async t=>{
 const f=await installedPair(t),out=await broadcast(teamBroadcast,f.records);
 assert.equal(out.length,2);
 for(const record of out){
  assert.equal(record.name,name);assert.deepEqual(record.presentation,{environment:record.deployment.environment,label:record.deployment.environment==='dev'?'联调':'正式'});
  assert.deepEqual(Object.keys(record.presentation).sort(),['environment','label']);
 }
 assert.equal(f.records.every(record=>!Object.hasOwn(record,'presentation')),true,'presentation must not mutate installation authority');
});
test('ordinary, legacy, forged and damaged records do not acquire a badge or break other installed apps',async t=>{
 const f=await installedPair(t),good=f.records[0],bad=structuredClone(good);bad.standardDeployment.packageSha256='0'.repeat(64);
 const ordinary={applicationId:'ordinary.app',name:'dev production',presentation:{environment:'prod',label:'正式'},deployment:{environment:'prod'}};
 const legacy={...ordinary,applicationId:'legacy.app',installationSource:'selfmade'};
 const out=await broadcast(teamBroadcast,[ordinary,legacy,bad,f.records[1]]);
 assert.equal(out.length,4);for(const record of out.slice(0,3))assert.equal(record.presentation,undefined);
 assert.equal(out[3].presentation?.environment,'prod');
});
test('personal edition never advertises verified standard deployment support from imported metadata',async t=>{
 const f=await installedPair(t),out=await broadcast(personalBroadcast,f.records.map(record=>({...record,presentation:{environment:'dev',label:'联调'}})));
 assert.equal(out.length,2);for(const record of out)assert.equal(record.presentation,undefined);
});

async function panel(edition,records,catalog=[]){
 let markup='',listener;const events=new Map(),calls=[];
 const root={scrollHeight:264,get innerHTML(){return markup},set innerHTML(value){markup=value},addEventListener:(name,fn)=>events.set(name,fn),querySelector:()=>null,classList:{toggle(){}}};
 const state={account:{phase:'authenticated',accountId:'owner'},phase:'ready',connection:{deviceId:'synthetic-box',mode:'local'},applications:records,ui:{applicationOperations:{}}};
 const api={getState:async()=>state,getApplicationNames:async()=>catalog,getBalance:async()=>({available:0}),onState:fn=>listener=fn,action:async(name,input)=>calls.push([name,input])};
 const context={window:{wanxPanel:api,addEventListener(){}},document:{getElementById:id=>id==='panel'?root:null,addEventListener(){},body:{classList:{contains:()=>false,toggle(){}}}},requestAnimationFrame:queueMicrotask,setTimeout};
 const source=await readFile(new URL('../../builder/integration/application-presentation.js',import.meta.url),'utf8');
 vm.runInNewContext(source+'\n'+await readFile(new URL(`../../${edition}/local-ui/panel/panel.js`,import.meta.url),'utf8'),context);
 await tick();await tick();
 return {get html(){return markup},async update(applications){listener({...state,applications});await tick()},async open(applicationId){events.get('click')({target:{closest:()=>({dataset:{app:applicationId},disabled:false})}});await tick()},calls,context};
}
test('real panel preserves same-name badges and application-id routing across reordering and hostile catalog metadata',async t=>{
 const f=await installedPair(t),records=await broadcast(teamBroadcast,f.records),[dev,prod]=records;
 const catalog=records.map(record=>({applicationId:record.applicationId,name:'wrong directory name',presentation:{environment:'prod',label:'正式'}}));
 const h=await panel('team-client',records,catalog);
 for(const record of records){
  const row=h.html.split('<div class="app-row">').find(part=>part.includes(`data-app="${record.applicationId}"`));
  assert.ok(row);assert.match(row,new RegExp(`data-environment="${record.presentation.environment}"`));assert.ok(row.includes(name));assert.ok(!row.includes('wrong directory name'));
 }
 await h.update([prod,dev]);assert.ok(h.html.indexOf(prod.applicationId)<h.html.indexOf(dev.applicationId));
 await h.open(dev.applicationId);await h.open(prod.applicationId);
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(([action])=>action==='applications-request-open'))),[['applications-request-open',{applicationId:dev.applicationId}],['applications-request-open',{applicationId:prod.applicationId}]]);
});
test('catalog presentation cannot turn an ordinary panel app into a managed deployment in either edition',async()=>{
 for(const edition of ['personal-client','team-client']){
  const record={applicationId:'ordinary.dev.app',name:'ordinary'};
  const h=await panel(edition,[record],[{applicationId:record.applicationId,name:'<unsafe>',presentation:{environment:'dev',label:'联调'},deployment:{environment:'prod'}}]);
  if (edition === 'personal-client') {
   assert.match(h.html, /data-page="memory"/);
   assert.ok(!h.html.includes(record.applicationId));
  } else {
   assert.ok(h.html.includes('&lt;unsafe&gt;'));
  }
  assert.ok(!h.html.includes('<unsafe>'));
  assert.ok(!h.html.includes('data-environment='));
 }
});
test('the installed team UI bundle matches the canonical presentation source and keep its whitelist closed',async()=>{
 const root=new URL('../../builder/integration/',import.meta.url);
 for(const extension of ['js','css']){
  const expected=await readFile(new URL('application-presentation.'+extension,root));
  assert.deepEqual(await readFile(new URL(`../build/app/local-ui/application-presentation.${extension}`,import.meta.url)),expected);
 }
 const context={window:{}};vm.runInNewContext(await readFile(new URL('application-presentation.js',root),'utf8'),context);
 const {badge}=context.window.wanxApplicationPresentation;
 for(const presentation of [undefined,{environment:'dev',label:'正式'},{environment:'dev',label:'联调',scopeId:'private'},{environment:'<script>',label:'联调'}])assert.equal(badge({presentation}),'');
});

async function managementCard(edition,records,item){
 const source=await readFile(new URL(`../../${edition}/local-ui/renderer/renderer.js`,import.meta.url),'utf8');
 const start=source.indexOf('function applicationCard('),end=source.indexOf('function discoverableApplications()',start);
 assert.ok(start>=0&&end>start);
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context={window:{},currentState:{applications:records},applicationsTab:'local',withMarketName:value=>value,applicationCandidate:()=>null,marketCandidates:new Map(),escapeHTML:escape,operationFor:()=>null,operationMessage:()=>'',applicationPreparationStatus:()=>'',applicationActions:()=>'',applicationTone:()=>'',applicationIcon:()=>'',expandedDetails:new Set(),applicationManagement:()=>'',teamUIRole:'admin',availableFeaturedProductId:()=>null,isPrivateApplication:()=>false,activeDeviceName:()=>'',appLibrary:{items:[]},item};
 vm.runInNewContext(await readFile(new URL('../../builder/integration/application-presentation.js',import.meta.url),'utf8')+'\n'+source.slice(start,end)+'\nresult=applicationCard(item);',context);
 return context.result;
}
test('real management cards read environment only from the installed main snapshot, never from a catalog item',async t=>{
 const f=await installedPair(t),records=await broadcast(teamBroadcast,f.records);
 for(const record of records){
  const html=await managementCard('team-client',records,{...record,presentation:{environment:'dev',label:'联调'}});
  assert.ok(html.includes(`data-environment="${record.presentation.environment}"`));assert.ok(html.includes(`data-application-id="${record.applicationId}"`));
 }
 for(const edition of ['personal-client','team-client']){
  const record={applicationId:'market.app',name:'ordinary'},forged={...record,presentation:{environment:'prod',label:'正式'}};
  assert.ok(!(await managementCard(edition,[record],forged)).includes('data-environment='));
 }
});

test('one real list verifies each retained ZIP once and UI consumes only that listing evidence without a second read',async t=>{
 const f=await installedPair(t),original=fsPromises.readFile;let zipReads=0,diskReads=0;
 fsPromises.readFile=(file,...args)=>{diskReads++;if(String(file).endsWith('/.wanx-standard-package.zip'))zipReads++;return original(file,...args)};syncBuiltinESMExports();
 try{
  const records=await f.installer.list();assert.equal(zipReads,2,'one ZIP verification per listed app');const afterListReads=diskReads;
  const out=await broadcast(teamBroadcast,records);assert.equal(out.filter(record=>record.presentation).length,2);
  assert.equal(zipReads,2,'UI projection must not reread either retained ZIP');assert.equal(diskReads,afterListReads,'UI projection performs no filesystem read');
  const next=await f.installer.list();assert.equal(zipReads,4,'a new listing must obtain fresh verification');
  assert.equal((await broadcast(teamBroadcast,next)).filter(record=>record.presentation).length,2);assert.equal(zipReads,4);
 }finally{fsPromises.readFile=original;syncBuiltinESMExports()}
});
test('serialized or modified records cannot self-certify and listing evidence cannot be reused as a long-lived cache',async t=>{
 const f=await installedPair(t);
 const copied=structuredClone(f.records);
 assert.equal((await broadcast(teamBroadcast,copied)).some(record=>record.presentation),false,'same structure is not main-process verification provenance');
 const first=await broadcast(teamBroadcast,f.records);assert.equal(first.filter(record=>record.presentation).length,2);
 assert.equal((await broadcast(teamBroadcast,f.records)).some(record=>record.presentation),false,'each listing fact is consumed once');
 const changed=await f.installer.list();changed[0].deployment.environment='prod';
 const out=await broadcast(teamBroadcast,changed);assert.equal(out[0].presentation,undefined);assert.equal(out[1].presentation?.environment,'prod');
});

test('a later listing observes changed installed bytes instead of reusing prior display evidence',async t=>{
 const f=await installedPair(t);assert.equal((await broadcast(teamBroadcast,f.records)).filter(record=>record.presentation).length,2);
 await writeFile(path.join(f.records[0].installPath,'shell/main.cjs'),'// changed after prior listing');
 const fresh=await f.installer.list();assert.equal(fresh.length,1);assert.equal(fresh[0].deployment.environment,'prod');
 const out=await broadcast(teamBroadcast,fresh);assert.equal(out.length,1);assert.equal(out[0].presentation?.environment,'prod');
});
