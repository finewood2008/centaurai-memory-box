import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {quickCreateWarehouse,readQuickCreation} from '../ui/onboarding-quick.mjs';

const source=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
const drain=()=>new Promise(resolve=>setImmediate(resolve));

for (const lost of ['create', 'entry']) test(`quick creation with lost ${lost} response survives reopening without a duplicate`, async () => {
  const records = new Map();
  const storage = { getItem: key => records.get(key), setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key) };
  const identity = { accountId: 'actor', boxId: 'box', user: { id: 'user' } };
  const seen = [];
  let fail = true;
  const options = { storage, identity, name: '测试仓', description: '合成资料',
    async call(action, input) {
      assert.equal(action, 'create-warehouse'); seen.push(input);
      if (lost === 'create' && fail) { fail = false; throw Error('response lost'); }
      return { id: 'created' };
    },
    async enter(warehouse, { view }) {
      assert.equal(warehouse.id, 'created');
      assert.equal(view, 'conversation');
      if (lost === 'entry' && fail) { fail = false; throw Error('workspace unavailable'); }
    },
  };
  await assert.rejects(quickCreateWarehouse(options));
  assert.equal(readQuickCreation(storage, identity).input.operationId, seen[0].operationId);
  assert.equal(readQuickCreation(storage, { ...identity, boxId: 'other' }), null);
  await quickCreateWarehouse({ ...options, name: '不同名称' });
  assert.equal(seen.length, lost === 'create' ? 2 : 1);
  if (lost === 'create') assert.deepEqual(seen[0], seen[1]);
  assert.equal(readQuickCreation(storage, identity), null);
});

test('a quick warehouse already created by the former host only opens its stored ID', async () => {
  const storage = { getItem:()=>null, removeItem:()=>{} };
  const identity = { accountId:'actor', boxId:'box', user:{id:'user'} };
  const input = { name:'之前的仓', description:'', operationId:'legacy-operation' };
  let receipt = { id:'legacy-warehouse', input };
  await quickCreateWarehouse({ storage, identity, legacyQuick(operation) {
    if (operation===undefined) return receipt;
    assert.equal(operation,input.operationId);
    receipt=null;
  }, call:()=>assert.fail('Do not resend an acknowledged write'), enter:async warehouse=>assert.equal(warehouse.id,'legacy-warehouse') });
  assert.equal(receipt,null);
});

test('batch retry skips confirmed batches and reuses the uncertain batch even after double click',async()=>{
  const documents=Array.from({length:201},(_,i)=>({id:'d'+i,active_version_id:'v'+i,status:'ready'}));
  let fail=true,release;const seen=[];
  const h={state:{warehouseId:'w',generation:1,processing:{signature:'sig'}},crypto:{randomUUID},
    confirm:()=>true,currentWarehouse:()=>({name:'fixture'}),actualModel:()=>'',toast:()=>{},setView:()=>{},refresh:async()=>{},errorText:e=>e.message,
    definiteWriteRejection:e=>[400,401,403,404,409,413,422].includes(e.status),call:async(action,input)=>{
      if(action==='documents')return{items:documents.slice(input.offset,input.offset+100),total:documents.length};
      seen.push(input);
      if(seen.length===1)await new Promise(resolve=>{release=resolve});
      if(input.documents[0].id==='d100'&&fail){fail=false;throw Error('second batch response lost')}
      return{job_ids:[]};
    }};
  vm.createContext(h);vm.runInContext(source.slice(source.indexOf('const reprocessPlans ='),source.indexOf('$("#model-scope").addEventListener')),h);
  const pending=h.reprocessModels(true);await drain();
  await h.reprocessModels(true);assert.equal(seen.length,1);release();await pending;
  await h.reprocessModels(true);
  assert.deepEqual(seen.map(b=>b.documents[0].id),['d0','d100','d100','d200']);
  assert.equal(seen[1].operationId,seen[2].operationId);
  assert.equal(seen[1].expectedSignature,seen[2].expectedSignature);
});

test('definite rejection refreshes only unaccepted materials before reconfirmation',async()=>{
  const documents=Array.from({length:101},(_,i)=>({id:'d'+i,active_version_id:'v'+i,status:'ready'}));
  let reject=true;const seen=[];
  const h={state:{warehouseId:'w',generation:1,processing:{signature:'old'}},crypto:{randomUUID},confirm:()=>true,
    currentWarehouse:()=>({name:'fixture'}),actualModel:()=>'',toast:()=>{},setView:()=>{},refresh:async()=>{},errorText:e=>e.message,
    definiteWriteRejection:e=>e.status===409,call:async(action,input)=>{
      if(action==='documents')return{items:documents.slice(input.offset,input.offset+100),total:documents.length};
      seen.push(input);if(input.documents[0].id==='d100'&&reject){reject=false;throw Object.assign(Error('config changed'),{status:409})}
      return{job_ids:[]};
    }};
  vm.createContext(h);vm.runInContext(source.slice(source.indexOf('const reprocessPlans ='),source.indexOf('$("#model-scope").addEventListener')),h);
  await h.reprocessModels(true);h.state.processing.signature='new';documents[100].active_version_id='new-version';
  await h.reprocessModels(true);
  assert.deepEqual(seen.map(b=>b.documents[0].id),['d0','d100','d100']);
  assert.notEqual(seen[1].operationId,seen[2].operationId);
  assert.equal(seen[2].documents[0].version_id,'new-version');assert.equal(seen[2].expectedSignature,'new');
});

test('retryable writes carry plain refusal metadata through the panel bridge and renderer',async()=>{
  const { createPanelBridge } = await import('../ui/panel-bridge.mjs');
  const bridge = createPanelBridge({call:async()=>({ok:false,code:'MODEL_CONFIG_CONFLICT',status:409,message:'config changed'})}, {});
  const h={state:{generation:1,warehouseId:'w'},bridge};
  vm.createContext(h);vm.runInContext(source.slice(source.indexOf('async function call(action,'),source.indexOf('function syncControls()')),h);
  await assert.rejects(h.call('reprocess-models',{}),e=>e.status===409&&e.code==='MODEL_CONFIG_CONFLICT');
});
