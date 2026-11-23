import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createDashboardGateway} from '../octop/gateway.mjs';
import {createApplicationBackend} from '../applications/backend.mjs';
import {evaluateApplicationCompatibility} from '../applications/compatibility.mjs';

const slot='ai.wanx.selfmade.'+'a'.repeat(32),base='dev.wanx.expert.a1234abcd';
function fixture(transport){
  const compatibility={backendProductId:'wanx',clientRange:'>=0.1.0 <2.0.0',hostProtocolRange:'>=1.0.0 <2.0.0',backendContracts:[{id:'wanx.expert-app.v1',range:'>=1.0.0 <2.0.0',features:['context','expert','data']}],resourceDependencies:[],localDataSchema:{readRange:'=1.0.0',writeVersion:'1.0.0'}};
  const original={applicationId:base,name:'Managed expert',version:'0.1.0',protocolVersion:3,runtime:'electron',entrypoint:'shell/main.cjs',capabilities:['identity.read','http.request'],compatibility};
  const descriptor={schemaVersion:3,applicationId:base,artifactId:'12345678-1234-4234-8234-123456789abc',version:'0.1.0',sha256:'b'.repeat(64),manifest:structuredClone(original)};
  const deployment={schemaVersion:1,profile:'wanx-expert-app-v1',baseApplicationId:base,slotApplicationId:slot,boxId:'synthetic-box',environment:'dev',generation:2,fence:1,operationId:'c'.repeat(32),artifactHash:'d'.repeat(64),scopeId:'e'.repeat(64),ticketId:'f'.repeat(32),payloadDigest:'sha256:'+'1'.repeat(64)};
  const record={...original,applicationId:slot,packageApplicationId:base,artifactId:descriptor.artifactId,descriptor,deployment,standardDeployment:{schemaVersion:1,format:'wanx-standard-expert-client-v1',packageSha256:descriptor.sha256,runtimeNamespace:'studio',runtimeContract:{id:'wanx.expert-app.v1',version:'1.0.0',collections:{state:{json:'string'}}},files:[]}};
  const context={protocolVersion:1,accountId:'synthetic-account',clientId:'synthetic-client',boxId:'synthetic-box',connection:'ready',user:{id:7},applicationId:'wanx'};
  const state={phase:'ready',connection:{deviceId:'synthetic-box'}};
  const response={schemaVersion:1,applicationId:base,baseApplicationId:base,slotApplicationId:slot,boxId:'synthetic-box',environment:'dev',generation:2,operationId:deployment.operationId,artifactHash:deployment.artifactHash,packageSha256:descriptor.sha256,scopeId:deployment.scopeId,runtimeNamespace:'studio',contract:{id:'wanx.expert-app.v1',version:'1.0.0',features:['context','expert','data']},backend:{schemaVersion:1,productId:'wanx',deviceId:'synthetic-box',observedAt:new Date().toISOString(),authorization:{status:'ready'},contracts:[{id:'wanx.expert-app.v1',version:'1.0.0',features:['context','expert','data']}],resources:[],bindings:[]}};
  const requests=[],audiences=[];let status=200,launchStatus=200,afterRequest=()=>{};
  const launch={schemaVersion:1,transport:'wanx-expert-app-v1',launchToken:'L'.repeat(43),expiresAt:Date.now()/1000+3600};
  const connection={openStream:async()=>({unexpected:'stream'}),context:()=>context,request:async input=>{requests.push(input);afterRequest();if(transport)return transport(input);const mint=input.path.startsWith('/api/app-studio/deployment/apps/');return{status:mint?launchStatus:status,body:Buffer.from(JSON.stringify(mint?launch:response))}}};
  const adapter=createApplicationBackend({clientVersion:'1.0.4',account:{getIdentity:()=>({accountId:'synthetic-account'})},client:{snapshot:()=>state,applicationConnection:async id=>{audiences.push(id);return connection}}});
  const input=phase=>({manifest:record,descriptor,phase,managedDeployment:record});
  return{adapter,input,record,response,context,state,connection,requests,audiences,launch,launchStatus:v=>launchStatus=v,status:v=>status=v,afterRequest:fn=>afterRequest=fn};
}

test('trusted standard expert candidate and import check Host/data locally before backend commit',async()=>{
  for(const phase of ['candidate','import']){
    const f=fixture();
    const result=await f.adapter.getCompatibilityContext(f.input(phase));
    assert.equal(result.backendRequired,false);assert.equal(result.backend,undefined);
    assert.equal(evaluateApplicationCompatibility(f.record,result,{phase}).status,'client_compatible');
    assert.deepEqual(f.requests,[]);assert.deepEqual(f.audiences,[]);
  }
});


test('standard expert SSO launch mints a scoped credential before reading actual public context',async()=>{
  for(const phase of ['launch','rollback']){
    const f=fixture();const result=await f.adapter.getCompatibilityContext(f.input(phase));
    assert.deepEqual(f.audiences,['wanx']);
    assert.equal(f.requests.length,2);
    assert.equal(f.requests[0].path,'/api/app-studio/deployment/apps/'+slot+'/runtime');assert.equal(f.requests[0].method,'POST');
    assert.deepEqual(JSON.parse(f.requests[0].body),{artifactHash:f.record.deployment.artifactHash,environment:'dev',generation:2});
    assert.equal(f.requests[1].path,'/api/wanx-expert-app/v1/context');assert.equal(f.requests[1].method,'GET');
    assert.equal(f.requests[1].headers['x-wanx-expert-launch'],f.launch.launchToken);
    assert.deepEqual(result.backend,f.response.backend);
    assert.equal(evaluateApplicationCompatibility(f.record,{...result,localDataSchemaVersion:'1.0.0'},{phase}).status,'ready');
    assert.equal(result.applicationConnection.context().applicationId,slot);
    assert.equal(JSON.stringify(result.applicationConnection.context()).includes(f.launch.launchToken),false);
    result.assertCurrent();
  }
});

test('actual expert context must match the complete trusted deployment proof',async t=>{
  for(const [field,value] of [['schemaVersion',2],['applicationId','dev.wanx.another'],['baseApplicationId','dev.wanx.another'],['slotApplicationId','ai.wanx.selfmade.'+'0'.repeat(32)],['boxId','another-box'],['environment','prod'],['generation',1],['operationId','0'.repeat(32)],['artifactHash','0'.repeat(64)],['packageSha256','0'.repeat(64)],['scopeId','0'.repeat(64)],['runtimeNamespace','workshop'],['contract',{id:'wanx.expert-app.v1',version:'2.0.0',features:['context','expert','data']} ]]){
    await t.test(field,async()=>{const f=fixture();f.response[field]=value;await assert.rejects(f.adapter.getCompatibilityContext(f.input('launch')),{code:'APPLICATION_PREPARATION_INVALID'});});
  }
});


test('managed readiness rejects a different selected box or native principal',async t=>{
  for(const mutate of [f=>{f.context.boxId='another-box'},f=>{delete f.context.user},f=>{f.afterRequest(()=>{f.context.user.id=8})},f=>{f.afterRequest(()=>{f.state.connection.deviceId='another-box'})}]){
    const f=fixture();mutate(f);await assert.rejects(f.adapter.getCompatibilityContext(f.input('launch')),{code:'UPDATE_SESSION_CHANGED'});
  }
});


test('managed runtime contract semantics survive canonical JSON field ordering',async()=>{
  const f=fixture();f.record.standardDeployment.runtimeContract={collections:{state:{json:'string'}},version:'1.0.0',id:'wanx.expert-app.v1'};
  const result=await f.adapter.getCompatibilityContext(f.input('candidate'));assert.equal(result.backendRequired,false);
});


test('managed launch rejects missing actual capabilities, stale evidence and authorization denial without fallback',async t=>{
  for(const [label,mutate,code] of [
    ['missing actual contract',f=>{f.response.backend.contracts=[]},'BACKEND_CONTRACT_INCOMPATIBLE'],
    ['missing actual feature',f=>{f.response.backend.contracts[0].features=['context','data']},'BACKEND_CONTRACT_INCOMPATIBLE'],
    ['unsupported actual version',f=>{f.response.backend.contracts[0].version='2.0.0'},'BACKEND_CONTRACT_INCOMPATIBLE'],
    ['stale actual observation',f=>{f.response.backend.observedAt='2000-01-01T00:00:00.000Z'},'BACKEND_CAPABILITIES_UNKNOWN'],
    ['other backend device',f=>{f.response.backend.deviceId='other-box'},'APPLICATION_PREPARATION_INVALID'],
    ['revoked authorization',f=>{f.response.backend.authorization={status:'blocked',code:'EXPERT_BINDING_UNAVAILABLE'}},'EXPERT_BINDING_UNAVAILABLE'],
    ['legacy publication failure',f=>{f.status(409);f.response.code='RESOURCE_PUBLICATION_UNAVAILABLE'},'RESOURCE_PUBLICATION_UNAVAILABLE'],
    ['unstructured HTTP denial',f=>{f.status(403)},'APP_AUTHORIZATION_UNVERIFIED'],
  ])await t.test(label,async()=>{const f=fixture();mutate(f);await assert.rejects(f.adapter.getCompatibilityContext(f.input('launch')),{code});assert.equal(f.requests.length,2);assert.equal(f.requests[1].path,'/api/wanx-expert-app/v1/context');});
});

test('only a complete separate managed record enables local candidate readiness',async t=>{
  for(const [label,mutate] of [
    ['wrong profile',f=>{f.record.deployment.profile='wanx-miniapp-v1'}],
    ['missing scope',f=>{delete f.record.deployment.scopeId}],
    ['wrong package digest',f=>{f.record.standardDeployment.packageSha256='0'.repeat(64)}],
    ['wrong namespace',f=>{f.record.standardDeployment.runtimeNamespace='workshop'}],
    ['extra resource claim',f=>{f.record.compatibility.resourceDependencies=[{kind:'expert',resourceId:'another',minVersion:'1.0.0'}]}],
    ['extra backend claim',f=>{f.record.compatibility.backendContracts.push({id:'wanx.other.v1',range:'1.0.0',features:[]})}],
  ])await t.test(label,async()=>{const f=fixture();mutate(f);await assert.rejects(f.adapter.getCompatibilityContext(f.input('candidate')),{code:'APPLICATION_DEPLOYMENT_INVALID'});assert.deepEqual(f.requests,[]);});
  const ordinary=fixture(),input=ordinary.input('candidate');delete input.managedDeployment;
  await ordinary.adapter.getCompatibilityContext(input);
  assert.equal(ordinary.requests[0].path,'/api/platform/applications/readiness');
});

test('prepared slot connection retains the native principal and selection guards for later Host requests',async()=>{
  const f=fixture(),result=await f.adapter.getCompatibilityContext(f.input('launch'));
  assert.equal(result.applicationConnection.context().applicationId,slot);
  f.context.user.id=8;
  assert.throws(()=>result.applicationConnection.context(),{code:'UPDATE_SESSION_CHANGED'});
  await assert.rejects(result.applicationConnection.request({path:'/api/wanx-expert-app/v1/context',method:'GET'}),{code:'UPDATE_SESSION_CHANGED'});
  assert.equal(f.requests.length,2);
});


test('SSO launch credentials must have the exact scoped transport shape and a live expiry',async t=>{
  for(const mutate of [f=>{f.launch.launchToken='x'.repeat(42)},f=>{f.launch.launchToken='x'.repeat(42)+'.'},f=>{f.launch.transport='legacy'},f=>{f.launch.expiresAt=Date.now()/1000-1},f=>{f.launch.expiresAt=Date.now()/1000+7200},f=>{f.launch.extra='unexpected'}]){
    const f=fixture();mutate(f);await assert.rejects(f.adapter.getCompatibilityContext(f.input('launch')),{code:'APPLICATION_PREPARATION_INVALID'});
    assert.equal(f.requests.length,1);
  }
});

test('prepared SSO Host connection injects its credential only on allowed public routes and never exposes it',async()=>{
  const f=fixture(),result=await f.adapter.getCompatibilityContext(f.input('launch')),connection=result.applicationConnection;
  await connection.request({path:'/api/wanx-expert-app/v1/invoke',method:'POST',headers:{'X-Wanx-Expert-Launch':'forged','Authorization':'forged','Content-Type':'application/json'},body:JSON.stringify({operation:'expert.tasks',input:{}})});
  assert.equal(f.requests.at(-1).headers['x-wanx-expert-launch'],f.launch.launchToken);
  assert.equal(f.requests.at(-1).headers.Authorization,undefined);
  assert.equal(JSON.stringify(connection.context()).includes(f.launch.launchToken),false);
  const before=f.requests.length;
  for(const [path,method] of [['/api/app-studio/projects','GET'],['/api/wanx-expert-app/v1/invoke?x=1','POST'],['/api/wanx-expert-app/v1/context','POST'],['/api/wanx-expert-app/v1/%63ontext','GET'],['http://example.invalid/','GET']])await assert.rejects(connection.request({path,method}),{code:'APPLICATION_ROUTE_DENIED'});
  await assert.rejects(connection.openWebSocket({path:'/api/wanx-expert-app/v1/context'}),{code:'APPLICATION_ROUTE_DENIED'});
  await assert.rejects(connection.openStream({path:'/api/wanx-expert-app/v1/context'}),{code:'APPLICATION_ROUTE_DENIED'});
  assert.equal(f.requests.length,before);
  await connection.request({path:'/api/auth/me',method:'GET'});assert.equal(f.requests.at(-1).headers['x-wanx-expert-launch'],undefined);
});

test('expired captured SSO launch credentials cannot authorize later Host requests',async t=>{
  const f=fixture(),result=await f.adapter.getCompatibilityContext(f.input('launch'));
  const now=Date.now;Date.now=()=>now()+7200*1000;t.after(()=>{Date.now=now});
  await assert.rejects(result.applicationConnection.request({path:'/api/wanx-expert-app/v1/context'}),{code:'RUNTIME_SESSION_EXPIRED'});
  assert.equal(f.requests.length,2);
});


test('SSO managed readiness crosses the real HTTP gateway with native bearer and opaque launch scope',async t=>{
  let gateway;const f=fixture(input=>gateway.request(input)),received=[],sockets=new Set();
  const upstream=http.createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString('utf8');received.push({path:request.url,method:request.method,headers:request.headers,body});
    response.setHeader('content-type','application/json');
    if(request.headers.authorization!=='Bearer synthetic-native-bearer'){response.writeHead(403);return response.end('{"code":"AUTH_FAILED"}')}
    if(request.url==='/api/app-studio/deployment/apps/'+slot+'/runtime'&&request.method==='POST')return response.end(JSON.stringify(f.launch));
    if(request.headers['x-wanx-expert-launch']!==f.launch.launchToken){response.writeHead(403);return response.end('{"code":"EXPERT_IDENTITY_REQUIRED"}')}
    if(request.url==='/api/wanx-expert-app/v1/context'&&request.method==='GET')return response.end(JSON.stringify(f.response));
    if(request.url==='/api/wanx-expert-app/v1/invoke'&&request.method==='POST')return response.end('{"items":[],"context":{"scopeId":"'+f.record.deployment.scopeId+'"}}');
    response.writeHead(404);response.end('{}');
  });
  upstream.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  gateway=await createDashboardGateway({targetURL:'http://127.0.0.1:'+upstream.address().port,session:{getToken:()=> 'synthetic-native-bearer',onExpired:()=>()=>{},close(){}}});
  t.after(async()=>{await gateway.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>upstream.close(resolve))});
  const result=await f.adapter.getCompatibilityContext(f.input('launch'));
  assert.deepEqual(JSON.parse(received[0].body),{artifactHash:f.record.deployment.artifactHash,environment:'dev',generation:2});
  assert.equal(received[0].headers['x-wanx-expert-launch'],undefined);
  assert.equal(received[1].headers['x-wanx-expert-launch'],f.launch.launchToken);
  assert.equal(result.applicationConnection.context().applicationId,slot);
  assert.equal(result.applicationConnection.context().user.id,7);
  const response=await result.applicationConnection.request({path:'/api/wanx-expert-app/v1/invoke',method:'POST',headers:{'x-wanx-expert-launch':'forged'},body:JSON.stringify({operation:'expert.tasks',input:{}})});
  assert.equal(response.status,200);assert.equal(JSON.parse(response.body).context.scopeId,f.record.deployment.scopeId);
  assert.equal(received[2].headers['x-wanx-expert-launch'],f.launch.launchToken);
  assert.equal(received.every(request=>request.headers.authorization==='Bearer synthetic-native-bearer'),true);
  assert.equal(JSON.stringify(result.applicationConnection.context()).includes(f.launch.launchToken),false);
});


test('local-trust managed readiness preserves the claims/derive path without minting an SSO fallback',async()=>{
  const f=fixture();f.state.connection.authorization='local-trust-v1';
  Object.assign(f.context,{protocolVersion:2,authorization:'local-trust-v1',applicationId:slot,dataIdentity:{profileId:'profile',clientId:'client',generation:1,selected:{boxId:'synthetic-box',boxKeyThumbprint:'thumbprint',principalId:'principal',bindingId:'binding',sessionId:'session',ownershipEpoch:1}}});
  delete f.context.user;f.connection.kind='local-trust-v1';
  const derive=async()=>({derived:'claims'});f.connection.deriveApplication=derive;
  const result=await f.adapter.getCompatibilityContext(f.input('launch'));
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/wanx-expert-app/v1/context');
  assert.equal(f.requests[0].headers['x-wanx-expert-launch'],undefined);
  assert.equal(result.applicationConnection.deriveApplication,derive);
});
