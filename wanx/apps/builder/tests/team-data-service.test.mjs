import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTeamDataService,starlinkTarget} from '../integration/team-client/data-service.mjs';
const wid='12345678-1234-1234-1234-123456789abc';
const context=(boxId,accountId='platform',clientId='stable')=>({protocolVersion:1,boxId,accountId,clientId,user:{id:1}});
const me=role=>({id:1,role,application_id:'wanx'});
function setup({keyItems=[]}={}){let role='admin',account='a';const requests=[],listeners=new Set();
 const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:account,clientId:'c'},connection:{deviceId:'b'}}),subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),applicationConnection:async()=>({context:()=>context('b',account,'c'),subscribe:()=>()=>{},request:async i=>{requests.push(i);return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(i.path==='/api/auth/me'?me(role):i.path.endsWith('/keys')?{items:keyItems}:i.path.endsWith('/'+wid)?{id:wid,name:'团队资料'}:{items:[]}))}}})};
 const service=createTeamDataService({client,applications:{listInstalled:async()=>[]}});
 return {service,requests,role:r=>role=r,switch:()=>{account='b';for(const f of listeners)f()}};
}
test('team requests use the private selector and recheck live admin identity',async()=>{
 const s=setup();await s.service.action('warehouses');assert.equal(s.requests.at(-1).headers['x-wanx-data-context'],'team');
 s.role('user');await assert.rejects(s.service.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});assert.equal(s.requests.at(-1).path,'/api/auth/me');s.service.close();
});
test('old connection cannot read after account switch',async()=>{const s=setup(),link=await s.service.connection();s.switch();await assert.rejects(link.request({path:'/api/semantica/warehouses'}),{code:'TEAM_SESSION_CHANGED'});s.service.close()});
test('arbitrary management actions and malformed launch targets are rejected',async()=>{const s=setup();await assert.rejects(s.service.action('delete-warehouse'),{code:'TEAM_DATA_ACTION_DENIED'});assert.throws(()=>starlinkTarget({warehouseId:'../../other',view:'graph'}));assert.throws(()=>starlinkTarget({view:'models',token:'secret'}));await assert.rejects(s.service.action('open-starlink',{view:'warehouses'}),{code:'TEAM_STARLINK_NOT_INSTALLED'});s.service.close()});
for(const previousVersion of ['0.2.24','0.2.25','0.3.4']) test(`team Starlink ${previousVersion} upgrades before launch`,async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wanx-starlink-team-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bundle=path.join(root,'starlink');await mkdir(path.join(bundle,'shell'),{recursive:true});
 await writeFile(path.join(bundle,'application.manifest.json'),JSON.stringify({version:'0.3.5-rc.20261031'}));
 await writeFile(path.join(bundle,'shell/main.mjs'),'entry');
 const requests=[],calls=[];
 const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'a',clientId:'c'},connection:{deviceId:'b'}}),subscribe:()=>()=>{},applicationConnection:async()=>({context:()=>context('b','a','c'),subscribe:()=>()=>{},request:async input=>{requests.push(input);return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(input.path==='/api/auth/me'?me('admin'):{items:[]}))}}})};
 const applications={listInstalled:async()=>[{applicationId:'centaurai.wanx.semantica',version:previousVersion}],install:async({sourceDir})=>{assert.equal(await readFile(path.join(sourceDir,'shell/main.mjs'),'utf8'),'entry');calls.push('install');return {version:'0.3.5-rc.20261031'}},launch:async input=>{calls.push('launch');return input}};
 const service=createTeamDataService({client,applications,starlinkPackageDir:bundle});
 try{const result=await service.action('open-starlink',{view:'warehouses'});assert.deepEqual(calls,['install','launch']);assert.equal(result.launchContext.kind,'team-data')}
 finally{service.close()}
});
function platformSetup(){let generation=0,role='admin';const snapshots=new Set(),leases=new Set();
 const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'platform',clientId:'stable'},connection:{deviceId:'same-box'}}),subscribe:fn=>(snapshots.add(fn),()=>snapshots.delete(fn)),applicationConnection:async()=>{
  const captured=generation;const live=()=>{if(captured!==generation)throw Object.assign(Error('NETWORK_CHANGED'),{code:'NETWORK_CHANGED'})};
  return {context:()=>{live();return context('same-box')},subscribe:fn=>(leases.add(fn),()=>leases.delete(fn)),request:async input=>{live();return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(input.path==='/api/auth/me'?me(role):{items:[{id:'warehouse',name:'真实连接仓'}]}))}}};
 }};
 const service=createTeamDataService({client,applications:{}});
 const emit=()=>{for(const f of [...snapshots])f(client.snapshot());for(const f of [...leases])f(client.snapshot())};
 return {service,emit,reconnect:()=>{generation++;emit()},downgrade:()=>{role='user';emit()}};
}
test('normal platform health snapshots do not invalidate data or poison later requests',async()=>{
 const s=platformSetup();await s.service.action('warehouses');s.emit();assert.equal((await s.service.action('warehouses')).items[0].name,'真实连接仓');s.service.close();
});
test('same-account same-box reconnection rebuilds the cached data connection and keeps old leases invalid',async()=>{
 const s=platformSetup();await s.service.action('warehouses');const old=await s.service.connection();s.reconnect();assert.equal((await s.service.action('warehouses')).items.length,1);await assert.rejects(old.request({path:'/api/semantica/warehouses'}),{code:'NETWORK_CHANGED'});s.downgrade();await assert.rejects(s.service.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});s.service.close();
});
test('current-model reprocessing keeps document versions and config signature on the existing authorized API',async()=>{
 const s=setup(),wid='12345678-1234-1234-1234-123456789abc';
 await s.service.action('reprocess-models',{warehouseId:wid,documents:[{id:'doc',version_id:'version'}],expectedSignature:'a'.repeat(64)});
 const request=s.requests.find(r=>r.path==='/api/semantica/processing/reprocess'),body=JSON.parse(request.body.toString());
 assert.equal(request.headers['x-wanx-data-context'],'team');assert.equal(body.warehouse_id,wid);assert.equal(body.expected_signature,'a'.repeat(64));assert.deepEqual(body.documents,[{id:'doc',version_id:'version'}]);assert.match(body.operation_id,/^[a-f0-9-]{36}$/);
 s.role('user');await assert.rejects(s.service.action('reprocess-models',{warehouseId:wid}),{code:'TEAM_ADMIN_REQUIRED'});s.service.close();
});

test('warehouse creation uses the existing team API and server IDs without a local approval ledger',async()=>{
 const writes=[];let sequence=0;
 const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'platform',clientId:'stable'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>({
  context:()=>context('box'),subscribe:()=>()=>{},request:async input=>{
   let value;
   if(input.path==='/api/auth/me')value=me('admin');
   else if(input.path==='/api/semantica/warehouses'&&input.method==='POST'){
    assert.equal(input.headers['x-wanx-data-context'],'team');writes.push(JSON.parse(input.body));value={id:'server-warehouse-'+(++sequence),name:writes.at(-1).name};
   }else throw Error('unexpected path '+input.path);
   return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(value))};
  }
 })};
 const service=createTeamDataService({client,applications:{}});
 try{
  assert.equal((await service.action('create-warehouse',{name:'first'})).id,'server-warehouse-1');
  assert.equal((await service.action('create-warehouse',{name:'second'})).id,'server-warehouse-2');
  assert.deepEqual(writes.map(row=>row.name),['first','second']);
  assert.notEqual(writes[0].operation_id,writes[1].operation_id);
  assert.equal(writes.some(row=>'warehouse_id' in row),false);
 }finally{service.close()}
});
test('team source reads preserve admin selector, explicit warehouse and body version',async()=>{
 const s=setup();try{
  await s.service.action('evidence',{warehouseId:wid,id:'ev_1'});
  assert.equal(s.requests.at(-1).path,`/api/semantica/warehouses/${wid}/evidence/ev_1`);assert.equal(s.requests.at(-1).headers['x-wanx-data-context'],'team');
  await s.service.action('document-text',{warehouseId:wid,id:'doc_1',versionId:'v2',start:4,end:99});
  const request=s.requests.at(-1),url=new URL(request.path,'http://fixture');
  assert.equal(url.pathname,`/api/semantica/warehouses/${wid}/documents/doc_1/text`);assert.equal(url.searchParams.get('version_id'),'v2');assert.equal(url.searchParams.get('start'),'4');assert.equal(url.searchParams.get('end'),'99');
  await s.service.action('document-text',{warehouseId:wid,id:'short_doc',versionId:'v2'});
  assert.deepEqual(Object.fromEntries(new URL(s.requests.at(-1).path,'http://fixture').searchParams),{version_id:'v2',start:'0'});
  for(const input of [{id:'ev_1'},{warehouseId:wid,id:'../ev_1'},{warehouseId:wid,id:'ev',headers:{}}])await assert.rejects(s.service.action('evidence',input),{code:'TEAM_DATA_TARGET_INVALID'});
  await assert.rejects(s.service.action('document-text',{warehouseId:wid,id:'doc',versionId:'v',start:10,end:9}),{code:'TEAM_DATA_TARGET_INVALID'});
  s.role('user');await assert.rejects(s.service.action('evidence',{warehouseId:wid,id:'ev_1'}),{code:'TEAM_ADMIN_REQUIRED'});
 }finally{s.service.close()}
});
test('team authorization summary is a scoped credential-free read and conversation is a valid full target',async()=>{
 const now=Math.floor(Date.now()/1000),s=setup({keyItems:[{expires_at:now+3600,token:'never-return'},{expires_at:now-5},{expires_at:now+3600,revoked_at:'2026-11-01'}]});
 try{
  assert.deepEqual(await s.service.action('authorization-summary',{warehouseId:wid}),{warehouseId:wid,warehouse:{id:wid,name:'团队资料'},active_count:1,expired_count:1,revoked_count:1});
  assert(s.requests.filter(r=>r.path.startsWith('/api/semantica/')).every(r=>r.method==='GET'&&r.headers['x-wanx-data-context']==='team'));
  await assert.rejects(s.service.action('authorization-summary',{warehouseId:wid,scopes:['all']}),{code:'TEAM_DATA_TARGET_INVALID'});
  assert.deepEqual(starlinkTarget({warehouseId:wid,view:'conversation'}),{kind:'team-data',version:1,warehouseId:wid,view:'conversation'});
 }finally{s.service.close()}
});

test('team rename rechecks live administrator and transports only exact scoped PATCH and stable identity',async()=>{
 const s=setup(),operationId='12345678-1234-1234-1234-123456789def';try{
  for(let attempt=0;attempt<2;attempt++)await s.service.action('rename-warehouse',{warehouseId:wid,name:'  团队新名称  ',operationId});
  const writes=s.requests.filter(r=>r.method==='PATCH');assert.equal(writes.length,2);
  for(const request of writes){assert.equal(request.path,`/api/semantica/warehouses/${wid}`);assert.equal(request.headers['x-wanx-data-context'],'team');assert.deepEqual(JSON.parse(request.body),{name:'团队新名称',operation_id:operationId})}
  s.role('user');await assert.rejects(s.service.action('rename-warehouse',{warehouseId:wid,name:'changed',operationId}),{code:'TEAM_ADMIN_REQUIRED'});
  assert.equal(s.requests.filter(r=>r.method==='PATCH').length,2);
 }finally{s.service.close()}
});
