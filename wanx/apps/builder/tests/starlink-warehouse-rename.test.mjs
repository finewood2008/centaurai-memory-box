import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createWarehouseRenameJournal} from '../integration/team-client/starlink/rename-warehouse.mjs';

const source=(await build({entryPoints:[fileURLToPath(new URL('../integration/team-client/data-view.js',import.meta.url))],bundle:true,platform:'browser',format:'iife',write:false,logLevel:'silent'})).outputFiles[0].text;
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const state={canLaunchApplications:true,account:{accountId:'account',clientId:'client'},activeDeviceId:'box',dataOwnerId:'owner'};
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values}};

function fixture({edition='personal',store=storage(),request}={}){
  const dialogs=[],calls=[],warehouses=[{id,name:'企业资料库',description:'原说明',document_count:4,entity_count:328,active_jobs:1},{id:other,name:'另一资料库',document_count:1,entity_count:0}];
  const document={querySelector:()=>null,querySelectorAll:()=>[],body:{append(d){dialogs.push(d)}},createElement(){
    const form={},submit={},alert={},nameError={},input={focus(){this.focused=true}},listeners={};
    return {dataset:{},form,submit,alert,nameError,input,listeners,isConnected:true,showModal(){},remove(){this.isConnected=false},close(){this.closed=true;this.onclose?.()},querySelectorAll:()=>[],
      addEventListener(type,callback){listeners[type]=callback},querySelector(selector){return selector==='form'?form:selector==='[type=submit]'?submit:selector==='[name="name"]'?input:selector==='.data-warehouse-name-error'?nameError:alert}};
  }};
  const call=async(name,input)=>{
    calls.push([name,structuredClone(input)]);
    const custom=await request?.(name,input,warehouses);
    if(custom!==undefined)return custom;
    if(name==='data.warehouses')return {items:structuredClone(warehouses)};
    if(name==='data.warehouse')return {...warehouses.find(w=>w.id===input.id)};
    if(name==='data.rename-warehouse'){const w=warehouses.find(w=>w.id===input.warehouseId);w.name=input.name;return {...w}}
    if(name==='data.graph')return {nodes:[],edges:[]};
    if(name==='data.authorization-summary')return {active_count:0};
    if(name==='data.governance-summary')return {supported:false};
    return {items:[]};
  };
  const window={localStorage:store};
  const context=vm.createContext({window,document,crypto:globalThis.crypto,setTimeout:()=>0,clearTimeout(){},FormData:class{constructor(target){this.target=target}get(name){return this.target[name]??''}}});
  vm.runInContext(source,context);
  const view=window.createTeamDataView({request:call,changed(){},edition});view.sync(state,true);
  return {view,dialogs,calls,warehouses,store,get current(){return dialogs.at(-1)},submit(name){return this.current.form.onsubmit({preventDefault(){},target:{name}})}};
}
const writes=f=>f.calls.filter(([name])=>name==='data.rename-warehouse');

for(const edition of ['personal','team'])test(`${edition}: rename updates current warehouse without changing selection or its contents`,async()=>{
  const f=fixture({edition});await f.view.refresh();const selected=f.view.currentWarehouse();
  assert.match(f.view.render(),/重命名数据仓/);
  await f.view.action('rename-warehouse');assert.match(f.current.innerHTML,/企业资料库/);assert.equal(f.current.input.focused,true);
  await f.submit('  新企业资料库  ');
  assert.equal(f.view.currentWarehouse(),selected);assert.match(f.view.render(),/新企业资料库/);
  assert.deepEqual(JSON.parse(JSON.stringify(writes(f)[0][1])),{warehouseId:id,name:'新企业资料库',operationId:writes(f)[0][1].operationId});
  assert.equal(f.warehouses[0].description,'原说明');assert.equal(f.warehouses[0].document_count,4);assert.equal(f.warehouses[0].entity_count,328);assert.equal(f.warehouses[0].active_jobs,1);
  assert.equal(f.store.values.size,0);assert.equal(f.current.closed,true);
  assert(!f.calls.some(([name])=>/create-warehouse|delete|extract|select-warehouse/.test(name)));
});

test('picker has separate rename controls and renaming another row does not select it',async()=>{
  const f=fixture();await f.view.refresh();await f.view.action('warehouse-picker');const picker=f.current;
  assert.match(picker.innerHTML,/data-rename-warehouse=/);assert.doesNotMatch(picker.innerHTML,/<button[^>]*data-choose[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  const selected=f.view.currentWarehouse();
  picker.listeners.click({target:{closest:s=>s==='[data-rename-warehouse]'?{dataset:{renameWarehouse:other}}:null}});
  await new Promise(r=>setImmediate(r));assert.match(f.current.innerHTML,/另一资料库/);await f.submit('新的另一资料库');
  assert.equal(f.view.currentWarehouse(),selected);assert.equal(writes(f)[0][1].warehouseId,other);
  await f.view.action('warehouse-picker');assert.match(f.current.innerHTML,/新的另一资料库/);
});

test('empty, long and control-character names are rejected before any write',async()=>{
  const f=fixture();await f.view.refresh();await f.view.action('rename-warehouse');
  for(const name of ['   ','a'.repeat(61),'a\nb','a\u0085b']){await f.submit(name);assert.match(f.current.alert.textContent,/1 至 60/)}
  assert.equal(writes(f).length,0);assert.equal(f.store.values.size,0);
});

test('name conflict keeps the form editable and a corrected name gets a new operation',async()=>{
  let conflict=true;
  const f=fixture({request(name){if(name==='data.rename-warehouse'&&conflict){conflict=false;throw Error('WAREHOUSE_NAME_CONFLICT')}}});
  await f.view.refresh();await f.view.action('rename-warehouse');await f.submit('已占用');
  assert.equal(f.current.input.readOnly,false);assert.match(f.current.nameError.textContent,/同名/);assert.equal(f.current.closed,undefined);
  await f.submit('可用名称');assert.notEqual(writes(f)[0][1].operationId,writes(f)[1][1].operationId);assert.match(f.view.render(),/可用名称/);
});

test('lost write response survives reload and retries only the same target/name/operation',async()=>{
  const store=storage();let lost=true;
  const first=fixture({store,request(name,input,warehouses){if(name==='data.rename-warehouse'){warehouses[0].name=input.name;if(lost){lost=false;throw Error('SEMANTICA_SERVICE_UNAVAILABLE')}}}});
  await first.view.refresh();await first.view.action('rename-warehouse');await first.submit('待确认名称');
  assert.match(first.current.alert.textContent,/尚未确认/);assert.equal(first.current.input.readOnly,true);
  const next=fixture({store});await next.view.refresh();await next.view.action('rename-warehouse');
  assert.match(next.current.innerHTML,/待确认名称/);await next.submit('不能替换未知请求');assert.equal(writes(next).length,0);
  await next.submit('待确认名称');assert.deepEqual(JSON.parse(JSON.stringify(writes(first)[0][1])),JSON.parse(JSON.stringify(writes(next)[0][1])));
  assert.equal(store.values.size,0);assert.match(next.view.render(),/待确认名称/);
});

test('a known successful write followed by failed read resumes with GET without rewriting the name',async()=>{
  let readsFail=false;
  const f=fixture({request(name){if(name==='data.rename-warehouse')readsFail=true;if(name==='data.warehouse'&&readsFail)throw Error('SEMANTICA_SERVICE_UNAVAILABLE')}});
  await f.view.refresh();await f.view.action('rename-warehouse');await f.submit('已保存的名称');assert.equal(writes(f).length,1);
  readsFail=false;await f.submit('已保存的名称');assert.equal(writes(f).length,1);assert.equal(f.store.values.size,0);
});

test('a late rename response cannot update another account/device view or clear the original recovery',async()=>{
  let release;
  const f=fixture({request(name){if(name==='data.rename-warehouse')return new Promise(r=>release=r)}});
  await f.view.refresh();await f.view.action('rename-warehouse');const pending=f.submit('旧账号名称');
  await new Promise(r=>setImmediate(r));f.view.sync({...state,activeDeviceId:'other-box',dataOwnerId:'other-owner'},true);
  release({id,name:'旧账号名称'});await pending;
  assert.doesNotMatch(f.view.render(),/旧账号名称/);assert.equal(f.store.values.size,1);
});

test('renaming to the same trimmed name does not issue a metadata write',async()=>{
  const f=fixture();await f.view.refresh();await f.view.action('rename-warehouse');await f.submit(' 企业资料库 ');assert.equal(writes(f).length,0);
});

test('malformed recovery is preserved instead of overwriting its unknown operation',()=>{
  const store=storage(),journal=createWarehouseRenameJournal(store);store.setItem('wanx.warehouse-rename:scope:'+id,'{}');
  assert.throws(()=>journal.read('scope',id),/WAREHOUSE_RENAME_RECOVERY_UNAVAILABLE/);assert.equal(store.values.size,1);
});
