import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersonalDataService,personalStarlinkTarget} from '../integration/personal-client/data-service.mjs';
const wid='12345678-1234-1234-1234-123456789abc';
function setup({applications,starlinkPackageDir,keyItems=[],keyGrant}={}){
  let state={phase:'ready',account:{phase:'authenticated',accountId:'owner',clientId:'client'},connection:{deviceId:'box',gatewayURL:'http://peer'}},deferred=null,denied=false;
  const listeners=new Set(),requests=[],opened=[],connections=[];
  const client={snapshot:()=>state,subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),applicationConnection:async id=>{
    connections.push(id);const captured=state;let closed=false;
    const live=()=>{if(state!==captured||closed)throw Object.assign(Error('HOST_SESSION_EXPIRED'),{code:'HOST_SESSION_EXPIRED'});};
    return {
      context:()=>{live();return {user:{id:2,role:'user'},boxId:state.connection.deviceId};},
      subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),
      close(){closed=true;},
      request:async input=>{
        live();requests.push(input);if(deferred)return deferred;
        const value=denied?{code:'SEMANTICA_RESOURCE_FORBIDDEN'}:input.path.endsWith('/warehouses')?{items:[{id:wid,name:'个人资料'}]}:input.path.endsWith('/keys')?(input.method==='POST'?keyGrant:{items:keyItems}):{id:wid,name:'个人资料'};
        return {status:denied?403:200,headers:{},body:Buffer.from(JSON.stringify(value))};
      },
    };
  }};
  const service=createPersonalDataService({client,starlinkPackageDir,applications:applications||{listInstalled:async()=>[{applicationId:'centaurai.wanx.semantica'}],launch:async input=>(opened.push(input),{opened:true})}});
  return {service,requests,opened,connections,deny:()=>denied=true,defer:p=>deferred=p,switch(){state={...state,account:{...state.account,accountId:'other'}};for(const f of [...listeners])f(state);}};
}
test('ordinary account reads personal warehouses without Team selector or administrator API',async()=>{
  const s=setup();assert.equal((await s.service.action('warehouses')).items[0].name,'个人资料');
  await s.service.action('graph',{warehouseId:wid});
  assert.deepEqual(s.connections,['centaurai.wanx.semantica']);
  assert(s.requests.every(r=>r.path.startsWith('/api/semantica/')&&!r.headers['x-wanx-data-context']));s.service.close();
});

test('internal MCP key is warehouse bound, expires in a day, revokes, and is unavailable to renderer actions',async()=>{
  const expires=Math.floor(Date.now()/1000)+86400;
  const s=setup({keyGrant:{token:'xg_'+ 'a'.repeat(40),key:{id:'key_1',expires_at:expires}}});
  try{
    const lease=await s.service.createMcpKey(wid);
    assert.equal(lease.expiresAt,expires*1000);
    const request=s.requests.find(r=>r.method==='POST'),body=JSON.parse(request.body);
    assert.equal(request.path,`/api/semantica/warehouses/${wid}/keys`);
    assert.equal(body.days,1);assert.deepEqual(body.scopes,['documents','evidence','graph','search','reasoning']);
    assert.equal(body.name,'MemoBox 本机工具临时连接');assert.match(body.operation_id,/^[a-f0-9-]{36}$/);
    await assert.rejects(s.service.action('createMcpKey',{warehouseId:wid}),{code:'TEAM_DATA_ACTION_DENIED'});
    await lease.revoke();assert.equal(s.requests.at(-1).path,`/api/semantica/warehouses/${wid}/keys/key_1/revoke`);
    const count=s.requests.length;s.switch();
    await assert.rejects(lease.revoke(),{code:'HOST_SESSION_EXPIRED'});assert.equal(s.requests.length,count);
  }finally{s.service.close()}
});
for(const previousVersion of [null,'0.2.25','0.3.4']) test(`personal Starlink ${previousVersion??'missing'} uses latest bundled package before opening`,async t=>{
  const source=await mkdtemp(path.join(os.tmpdir(),'wanx-starlink-fixture-'));
  t.after(()=>rm(source,{recursive:true,force:true}));
  await mkdir(path.join(source,'shell'));
  const manifest=JSON.stringify({version:'0.3.5-rc.20261031'});
  await writeFile(path.join(source,'application.manifest.json'),manifest);
  await writeFile(path.join(source,'shell','main.mjs'),'entry');
  let installed=false,opened=false;
  const s=setup({starlinkPackageDir:source,applications:{
    listInstalled:async()=>installed?[{applicationId:'centaurai.wanx.semantica'}]:previousVersion?[{applicationId:'centaurai.wanx.semantica',version:previousVersion}]:[],
    install:async({sourceDir})=>{assert.equal(await readFile(path.join(sourceDir,'application.manifest.json'),'utf8'),manifest);assert.equal(await readFile(path.join(sourceDir,'shell','main.mjs'),'utf8'),'entry');installed=true;},
    launch:async()=>{assert.equal(installed,true);opened=true;return {opened:true};},
  }});
  await s.service.action('open-starlink',{view:'warehouses'});
  assert.equal(opened,true);s.service.close();
});
test('late responses are rejected on account switch and cannot populate the next account',async()=>{
  const s=setup();let finish;s.defer(new Promise(r=>finish=r));const pending=s.service.action('warehouses');await new Promise(r=>setImmediate(r));s.switch();finish({status:200,headers:{},body:Buffer.from('{"items":[{"name":"旧账号"}]}')});await assert.rejects(pending);s.service.close();
});
test('personal opening preserves warehouse and target; privileged actions and malformed targets fail',async()=>{
  const s=setup();await s.service.action('open-starlink',{warehouseId:wid,view:'graph'});assert.deepEqual(s.opened[0],{applicationId:'centaurai.wanx.semantica',launchContext:{kind:'personal-data',version:1,warehouseId:wid,view:'graph'}});
  await assert.rejects(s.service.action('assistant-access-update',{warehouseId:wid}),{code:'TEAM_DATA_ACTION_DENIED'});
  assert.throws(()=>personalStarlinkTarget({warehouseId:'../../team',view:'graph'}));assert.throws(()=>personalStarlinkTarget({view:'graph',dataScope:'team'}));s.service.close();
});
test('server rejection of another warehouse is retained and never retried as a Team administrator',async()=>{
  const s=setup();s.deny();await assert.rejects(s.service.action('warehouse',{id:wid}),{code:'SEMANTICA_RESOURCE_FORBIDDEN'});assert(s.requests.every(r=>!r.path.startsWith('/api/admin')));s.service.close();
});
test('personal source reads stay in an explicit warehouse and fixed body version',async()=>{
  const s=setup();
  try{
    await s.service.action('evidence',{warehouseId:wid,id:'evidence_1'});
    assert.equal(s.requests.at(-1).path,`/api/semantica/warehouses/${wid}/evidence/evidence_1`);
    await s.service.action('document-text',{warehouseId:wid,id:'doc_1',versionId:'version_2',start:12,end:140});
    const request=s.requests.at(-1),url=new URL(request.path,'http://fixture');
    assert.equal(url.pathname,`/api/semantica/warehouses/${wid}/documents/doc_1/text`);
    assert.deepEqual(Object.fromEntries(url.searchParams),{version_id:'version_2',start:'12',end:'140'});
    assert.equal(request.method,'GET');assert.equal(request.headers['x-wanx-data-context'],undefined);
    await s.service.action('document-text',{warehouseId:wid,id:'short_doc',versionId:'version_2'});
    assert.deepEqual(Object.fromEntries(new URL(s.requests.at(-1).path,'http://fixture').searchParams),{version_id:'version_2',start:'0'});
    for(const input of [{id:'ev'},{warehouseId:wid,id:'../ev'},{warehouseId:wid,id:'ev',scope:'team'}])await assert.rejects(s.service.action('evidence',input),{code:'TEAM_DATA_TARGET_INVALID'});
    for(const input of [{warehouseId:wid,id:'doc'},{warehouseId:wid,id:'doc',versionId:'v',start:-1},{warehouseId:wid,id:'doc',versionId:'v',start:0,end:65537}])await assert.rejects(s.service.action('document-text',input),{code:'TEAM_DATA_TARGET_INVALID'});
  }finally{s.service.close()}
});
test('personal authorization summary exposes counts only and never issues or returns credentials',async()=>{
  const now=Math.floor(Date.now()/1000),s=setup({keyItems:[{expires_at:now+3600,prefix:'do-not-return',token:'secret'},{expires_at:now-10},{expires_at:now+3600,revoked_at:'2026-11-01'}]});
  try{
    assert.deepEqual(await s.service.action('authorization-summary',{warehouseId:wid}),{warehouseId:wid,warehouse:{id:wid,name:'个人资料'},active_count:1,expired_count:1,revoked_count:1});
    assert(s.requests.every(r=>r.method==='GET'&&!r.path.includes('/revoke')));
    await assert.rejects(s.service.action('authorization-summary',{warehouseId:wid,token:'secret'}),{code:'TEAM_DATA_TARGET_INVALID'});
    assert.deepEqual(personalStarlinkTarget({warehouseId:wid,view:'conversation'}),{kind:'personal-data',version:1,warehouseId:wid,view:'conversation'});
  }finally{s.service.close()}
});
test('a late personal evidence read cannot return into another account',async()=>{
  const s=setup();let finish;s.defer(new Promise(r=>finish=r));
  const pending=s.service.action('evidence',{warehouseId:wid,id:'evidence_1'});await new Promise(r=>setImmediate(r));s.switch();finish({status:200,headers:{},body:Buffer.from('{"excerpt":"old account source"}')});
  try{await assert.rejects(pending,{code:'HOST_SESSION_EXPIRED'})}finally{s.service.close()}
});

test('material workflow routes remain warehouse scoped and precise launch carries no authority',async()=>{
  const s=setup();
  await s.service.action('material-workflows',{warehouseId:wid,offset:50,limit:50});
  await s.service.action('material-workflow',{warehouseId:wid,documentId:'doc'});
  assert.match(s.requests[0].path,/workbench\/conversations\/materials\?offset=50&limit=50$/);
  assert.match(s.requests[1].path,/workbench\/conversations\/materials\/doc$/);
  await s.service.action('open-starlink',{warehouseId:wid,view:'conversation',documentId:'doc',conversationId:'c',intentId:'i'});
  assert.deepEqual(s.opened[0].launchContext,{kind:'personal-data',version:2,warehouseId:wid,view:'conversation',documentId:'doc',conversationId:'c',intentId:'i'});
  for(const input of [{warehouseId:wid,workspace_id:'foreign'},{warehouseId:wid,limit:51},{warehouseId:wid,offset:-1}])assert.equal((await s.service.action('material-workflows',input)).materialResponse.error.code,'TEAM_DATA_TARGET_INVALID');
  for(const input of [{warehouseId:wid,view:'graph',documentId:'doc'},{warehouseId:wid,view:'conversation',documentId:'doc',intentId:'i'},{warehouseId:wid,view:'conversation',documentId:'../doc'}])assert.throws(()=>personalStarlinkTarget(input));
  s.service.close();
});

test('material IPC result preserves safe HTTP diagnostics and native automatic operation identity',async()=>{
  const s=setup(),operationId='12345678-1234-1234-1234-123456789def';
  try{
    await s.service.action('material-preview',{warehouseId:wid,documentId:'doc',versionId:'v1',workflowRevision:4,operationId});
    let request=s.requests.at(-1),body=JSON.parse(request.body);
    assert.equal(body.operation_id,operationId);assert.equal(body._native_operation_id,operationId);assert.equal(body.expected_document_version_id,'v1');
    assert.equal(request.headers['x-request-id'],undefined,'native trust does not permit invented transport headers');
    const ack='b'.repeat(64);
    await s.service.action('material-transition',{warehouseId:wid,documentId:'doc',workflowRevision:4,operationId,previewId:'p',previewDigest:'a'.repeat(64),confirmed:true,replacementAcknowledgement:ack});
    assert.equal(JSON.parse(s.requests.at(-1).body).replacement_acknowledgement,ack);
    await s.service.action('material-transition-status',{warehouseId:wid,documentId:'doc',transitionId:'t'});
    assert.match(s.requests.at(-1).path,/materials\/doc\/processing-transitions\/t$/);
    s.deny();const value=await s.service.action('material-workflow',{warehouseId:wid,documentId:'doc'});
    assert.equal(value.materialResponse.ok,false);assert.equal(value.materialResponse.error.httpStatus,403);assert.equal(value.materialResponse.error.category,'authorization');
    assert.equal(value.materialResponse.error.code,'SEMANTICA_RESOURCE_FORBIDDEN');assert(value.materialResponse.error.requestId);
    assert.equal(value.materialResponse.value,undefined);
  }finally{s.service.close();}
});

const renameOperation='12345678-1234-1234-1234-123456789def';
test('personal rename sends only fixed metadata with the caller stable operation and no team selector',async()=>{
 const s=setup();try{
  for(let attempt=0;attempt<2;attempt++)await s.service.action('rename-warehouse',{warehouseId:wid,name:'  新名称  ',operationId:renameOperation});
  assert.equal(s.requests.length,2);
  for(const request of s.requests){
   assert.equal(request.path,`/api/semantica/warehouses/${wid}`);assert.equal(request.method,'PATCH');
   assert.deepEqual(JSON.parse(request.body),{name:'新名称',operation_id:renameOperation});assert.equal(request.headers['x-wanx-data-context'],undefined);
  }
  s.deny();await assert.rejects(s.service.action('rename-warehouse',{warehouseId:wid,name:'新名称',operationId:renameOperation}),{code:'SEMANTICA_RESOURCE_FORBIDDEN'});
  assert.equal(s.requests.length,3);
 }finally{s.service.close()}
});
test('personal rename cannot deliver an old-account completion after switching',async()=>{
 const s=setup();let finish;s.defer(new Promise(r=>finish=r));
 const pending=s.service.action('rename-warehouse',{warehouseId:wid,name:'新名称',operationId:renameOperation});
 await new Promise(r=>setImmediate(r));s.switch();finish({status:200,headers:{},body:Buffer.from(JSON.stringify({id:wid,name:'新名称'}))});
 try{await assert.rejects(pending,{code:'HOST_SESSION_EXPIRED'})}finally{s.service.close()}
});
