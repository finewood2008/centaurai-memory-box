import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createExpertClient,parseRun} from '../templates/expert-client/src/state.js';
import {compileArtifact} from '../core/artifact.mjs';

const id='a'.repeat(32),runId='b'.repeat(32),scopeId='c'.repeat(64);
const run=(extra={})=>({id:runId,state:'running',text:'合成问题',result:null,errorCode:null,createdAt:100,updatedAt:100,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
function fixture(){
  const calls=[],runs=new Map();let row=null,count=0,readError=null,loseResponse=false,scope=scopeId;
  const api={data:{
    async get(){if(readError)throw readError;return structuredClone(row)},
    async put(body){calls.push({method:'data.put',body:structuredClone(body)});assert.equal(body.expectedRevision,row?._revision||0);row={...body.value,_revision:(row?._revision||0)+1};return structuredClone(row)},
  },foundation:{async invoke(method,body){
    calls.push({method,body:structuredClone(body)});
    if(method==='expert.tasks'){if(readError)throw readError;return{items:structuredClone([...runs.values()]),context:{scopeId:scope}}}
    if(method==='expert.run'){
      if(!runs.has(body.operationId)){runs.set(body.operationId,run({text:body.text}));count++}
      if(loseResponse){loseResponse=false;throw Error('HOST_REQUEST_TIMEOUT')}
      return{run:structuredClone(runs.get(body.operationId))};
    }
    if(method==='expert.cancel'){const r=[...runs.values()].find(r=>r.id===body.runId);r.state='cancel_requested';return{run:structuredClone(r)}}
    throw Error('Unexpected operation');
  }}};
  return{api,calls,runs,get count(){return count},get row(){return row},lose(){loseResponse=true},breakReads(error){readError=error},setScope(value){scope=value},client:()=>createExpertClient(api,{operationId:()=>id})};
}

test('client submits only the logical text request, with durable identity before execution',async()=>{
  const f=fixture(),client=f.client();await client.refresh();const r=await client.send(' 合成问题 ');
  assert.equal(r.id,runId);assert.equal(f.count,1);assert.deepEqual(f.calls.find(c=>c.method==='expert.run').body,{operationId:id,text:'合成问题'});
  const writes=f.calls.filter(c=>c.method==='data.put');assert.deepEqual(writes[0].body.value,{operationId:id,text:'合成问题',scopeId});assert.deepEqual(writes[1].body.value,{operationId:'',text:'',scopeId});
  assert.equal(client.getSnapshot().pending,null);assert.equal(client.getSnapshot().selectedId,runId);client.dispose();
});

test('lost submission response survives reopening; explicit retry reuses identity without another run',async()=>{
  const f=fixture(),first=f.client();await first.refresh();f.lose();await first.send('合成问题');assert.equal(first.getSnapshot().pending.operationId,id);first.dispose();
  const reopened=f.client();await reopened.refresh();assert.equal(reopened.getSnapshot().items.length,1);assert.equal(reopened.getSnapshot().pending.operationId,id);
  const before=f.calls.filter(c=>c.method==='expert.run').length;await reopened.refresh();assert.equal(f.calls.filter(c=>c.method==='expert.run').length,before,'refresh never resubmits');
  await reopened.retry();assert.equal(f.count,1);assert.equal(f.calls.filter(c=>c.method==='expert.run').length,2);assert.equal(reopened.getSnapshot().pending,null);reopened.dispose();
});

test('a new window restores completed results from server history and never automatically reruns interrupted work',async()=>{
  const f=fixture();f.runs.set(id,run({state:'succeeded',result:'已有结果'}));const client=f.client();await client.refresh();assert.equal(client.getSnapshot().items[0].result,'已有结果');
  f.runs.set(id,run({state:'interrupted'}));await client.refresh();assert.equal(client.getSnapshot().items[0].state,'interrupted');assert.equal(client.shouldPoll(),false);assert.equal(f.count,0);client.dispose();
});

test('copied pending data from another deployment scope is never retried or submitted on refresh',async()=>{
  const f=fixture(),dev=f.client();await dev.refresh();f.lose();await dev.send('dev request');assert.equal(f.count,1);dev.dispose();
  const before=f.calls.filter(c=>c.method==='expert.run').length;f.setScope('d'.repeat(64));f.runs.clear();const prod=f.client();await prod.refresh();
  assert.equal(prod.getSnapshot().pending,null);assert.equal(prod.getSnapshot().scopeId,'d'.repeat(64));await prod.retry();await prod.refresh();
  assert.equal(f.calls.filter(c=>c.method==='expert.run').length,before);assert.equal(f.row.scopeId,scopeId,'refresh does not mutate copied data');prod.dispose();
});

test('a missing runtime scope cannot enable submit or restore an unconfirmed request',async()=>{
  const f=fixture();f.setScope(undefined);const client=f.client();await client.refresh();assert.equal(client.getSnapshot().ready,false);await client.send('must not submit');await client.retry();assert.equal(f.count,0);client.dispose();
});

test('failed reads retain displayed history, block new writes and sanitize exception details',async()=>{
  const f=fixture();f.runs.set(id,run());const client=f.client();await client.refresh();f.breakReads(Error('https://private.example/token-secret'));await client.refresh();
  assert.equal(client.getSnapshot().items.length,1);assert.equal(client.getSnapshot().ready,false);assert.ok(!client.getSnapshot().error.includes('private'));
  await client.send('must not execute');assert.equal(f.count,0);f.breakReads(null);await client.refresh();assert.equal(client.getSnapshot().ready,true);client.dispose();
});

test('cancellation displays the actual server state and does not claim immediate cancellation',async()=>{
  const f=fixture();f.runs.set(id,run());const client=f.client();await client.refresh();await client.cancel(runId);
  assert.equal(client.getSnapshot().items[0].state,'cancel_requested');assert.ok(client.getSnapshot().notice.includes('请求取消'));assert.deepEqual(f.calls.find(c=>c.method==='expert.cancel').body,{runId});
  await client.cancel(runId);assert.equal(f.calls.filter(c=>c.method==='expert.cancel').length,1);client.dispose();
});

test('concurrent send cannot create another request and disposal fences late results',async()=>{
  const f=fixture(),gate=deferred(),original=f.api.foundation.invoke;f.api.foundation.invoke=async(method,body)=>method==='expert.run'?gate.promise:original(method,body);
  const client=f.client();await client.refresh();const pending=client.send('合成问题');await new Promise(r=>setImmediate(r));await client.send('another');
  assert.equal(f.calls.filter(c=>c.method==='data.put').length,1);const snapshot=client.getSnapshot();client.dispose();gate.resolve({run:run()});await pending;assert.equal(client.getSnapshot(),snapshot);assert.equal(f.row.operationId,id);
});

test('malformed or duplicate server runs cannot become accepted application history',async()=>{
  const f=fixture();f.api.foundation.invoke=async()=>({items:[run(),run()]});const client=f.client();await client.refresh();assert.equal(client.getSnapshot().ready,false);
  for(const value of [run({state:'unknown'}),run({result:{private:'object'}}),run({updatedAt:-1})])assert.throws(()=>parseRun(value),/EXPERT_RESPONSE_INVALID/);
  assert.equal(parseRun({...run(),agentId:'must-be-stripped'}).agentId,undefined);client.dispose();
});

test('the paired client compiles through the actual miniapp compiler with existing data/foundation capabilities',async()=>{
  const root=new URL('../templates/expert-client/',import.meta.url),names=['miniapp.manifest.json','src/app.js','src/state.js','src/styles.css'];
  const files=Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(new URL(name,root),'utf8')])));
  const compiled=await compileArtifact(files);assert.deepEqual(compiled.manifest.capabilities,['data','foundation']);assert.match(compiled.bundle,/expert\.run/);assert.match(compiled.css,/\.expert-app/);
  assert.ok(!compiled.bundle.includes('/api/agents/'));assert.ok(!compiled.bundle.includes('agentId'));
});
