import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import foundation from '../foundation-runtime/foundation.cjs';
import {packTemplate} from '../templates/pack.mjs';
import {workshopTemplates,workshopTemplate,workshopTemplateForApplication} from '../templates/catalog.mjs';
import {createPersonalWorkshop} from '../integration/personal-client/workshop-service.mjs';

test('Zhike is a bundled standard source, with editable modules and no customer data or original binding',async()=>{
 const packed=await packTemplate(new URL('../templates/zhike/',import.meta.url).pathname,{applicationId:'centaurai.wanx.template.zhike',version:'0.12.1'});
 assert.deepEqual(workshopTemplate('template:zhike'),packed);
 assert.equal(workshopTemplates().find(t=>t.id==='template:zhike').origin,'工坊模板');
 assert.equal(Object.keys(packed.files).length,4);
 const config=JSON.parse(packed.files['src/config.json']);assert.equal(config.moduleLibrary.modules.length,13);
 assert.ok(config.featurePack.modules.every(m=>m.id!=='experts'));
 assert.deepEqual(JSON.parse(packed.files['miniapp.manifest.json']).capabilities,['data','model','files','foundation']);
 const text=JSON.stringify(packed.files);
 assert.doesNotMatch(text,/weekly-app-f83f6e03|local-3b31c48|wanx-local|Bearer\s+[A-Za-z0-9_.-]{20,}|\/Users\/|\/Volumes\//);
 for(const id of ['toString','constructor','unknown'])assert.equal(workshopTemplate(id),null);
 const copy=workshopTemplate('template:zhike');copy.files['src/config.json']='{}';assert.notEqual(workshopTemplate('template:zhike').files['src/config.json'],'{}');
 assert.equal(workshopTemplateForApplication(packed.applicationId).sourceHash,packed.sourceHash);
});

test('native runtime and backend whitelist both support the actual conversation operations',async()=>{
 const contract=JSON.parse(await readFile(new URL('../backend/wanx_studio/foundation-contract.json',import.meta.url),'utf8'));
 assert.deepEqual(contract.operations,foundation.FOUNDATION_OPERATIONS);
 for(const op of ['conversation.send','conversation.status','conversation.cancel'])assert.ok(contract.operations.includes(op));
});

function fixture(applicationId='centaurai.wanx.template.zhike'){
 const calls=[],projectId='a'.repeat(32);
 const link={context:()=>({}),close(){},request:async input=>{
  calls.push(input);let value;
  if(input.path.endsWith('/sources'))value={items:[]};
  else if(input.path.endsWith('/copies'))value={id:projectId};
  else if(input.path.endsWith('/source-update'))value={updated:true};
  else if(input.path.endsWith('/projects/'+projectId))value={workshop:{applicationId}};
  else if(input.path.endsWith('/_management/projects'))value={projects:[{id:projectId,name:'我的知客',artifacts:[],management:{revision:1},workshop:{applicationId,sourceHash:'old'}}]};
  else throw Error('unexpected '+input.path);
  return{status:200,body:JSON.stringify(value)};
 }};
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'synthetic'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{listInstalled:async()=>[]},assets:'synthetic',control:{on(){},isDestroyed:()=>false},ipcMain:{handle(){},removeHandler(){}}});
 return{service,calls,projectId};
}
test('Workshop offers Zhike without an installed application and copies the bundled source only',async()=>{
 const {service,calls}=fixture();try{
  const sources=await service.action('sources');const template=sources.items.find(t=>t.id==='template:zhike');assert.ok(template.editable);assert.equal(template.files,undefined);
  await service.action('copy',{sourceId:template.id,name:'我的客户应用',operationId:'synthetic'});
  const payload=JSON.parse(calls.find(c=>c.path.endsWith('/copies')).body.toString());
  assert.deepEqual(payload.source,workshopTemplate('template:zhike'));assert.equal(payload.name,'我的客户应用');assert.equal(payload.source.state,undefined);
 }finally{service.close()}
});
test('template updates use the project actual source and never swap Zhike with Q&A',async()=>{
 for(const applicationId of ['centaurai.wanx.template.zhike','centaurai.wanx.template.knowledge-qa','private.app']){
  const {service,calls,projectId}=fixture(applicationId);try{
   const list=await service.action('list');assert.equal(list.items[0].templateUpdate,applicationId==='private.app'?null:workshopTemplateForApplication(applicationId).version);
   const input={projectId,artifactHash:'b'.repeat(64),operationId:'synthetic',sourceId:'template:knowledge-qa'};
   if(applicationId==='private.app'){await assert.rejects(service.action('template.update',input),/WORKSHOP_SOURCE_REQUIRED/);assert.ok(!calls.some(c=>c.method==='POST'));}
   else{await service.action('template.update',input);const payload=JSON.parse(calls.find(c=>c.method==='POST').body.toString());assert.equal(payload.source.applicationId,applicationId);}
  }finally{service.close()}
 }
});
