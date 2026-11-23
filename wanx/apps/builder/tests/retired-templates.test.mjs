import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import foundation from '../foundation-runtime/foundation.cjs';
import {createPersonalWorkshop} from '../integration/personal-client/workshop-service.mjs';

test('native runtime and backend whitelist both support the actual conversation operations',async()=>{
 const contract=JSON.parse(await readFile(new URL('../backend/wanx_studio/foundation-contract.json',import.meta.url),'utf8'));
 assert.deepEqual(contract.operations,foundation.FOUNDATION_OPERATIONS);
 for(const op of ['conversation.send','conversation.status','conversation.cancel'])assert.ok(contract.operations.includes(op));
});

function fixture(applicationId){
 const calls=[],projectId='a'.repeat(32);
 const link={context:()=>({}),close(){},request:async input=>{
  calls.push(input);let value;
  if(input.path.endsWith('/sources'))value={items:[]};
  else if(input.path.endsWith('/copies'))value={id:projectId};
  else if(input.path.endsWith('/source-update'))value={updated:true};
  else if(input.path.endsWith('/projects/'+projectId))value={workshop:{applicationId}};
  else if(input.path.endsWith('/_management/projects'))value={projects:[{id:projectId,name:'历史项目',artifacts:[],management:{revision:1},workshop:{applicationId,sourceHash:'old'}}]};
  else throw Error('unexpected '+input.path);
  return{status:200,body:JSON.stringify(value)};
 }};
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'synthetic'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{listInstalled:async()=>[]},assets:'synthetic',control:{on(){},isDestroyed:()=>false},ipcMain:{handle(){},removeHandler(){}}});
 return{service,calls,projectId};
}
for (const template of ['knowledge-qa', 'zhike']) {
 test(`Workshop refuses to offer, copy or update the retired ${template} template`, async () => {
  const {service, calls, projectId} = fixture('centaurai.wanx.template.' + template);
  try {
   assert.deepEqual(await service.action('sources'), {items: []});
   assert.equal((await service.action('list')).items[0].templateUpdate, null);
   for (const action of ['copy', 'template.update']) {
    await assert.rejects(service.action(action, {projectId, sourceId: 'template:' + template}), /WORKSHOP_FORMAT_UNSUPPORTED/);
   }
   assert.ok(!calls.some(call => call.method === 'POST'));
  } finally {
   service.close();
  }
 });
}

test('the Workshop renderer cannot copy a retired template handed off by My Apps', async t => {
 const {service, calls} = fixture('centaurai.wanx.template.zhike');
 t.after(() => service.close());
 const window = {createStudioProduct: () => ({sync(){}, reset(){}, render(){return '';}})};
 const renderer = await readFile(new URL('../integration/personal-client/workshop.js', import.meta.url), 'utf8');
 vm.runInNewContext(renderer, {window});
 const actions = [];
 const view = window.createWanxWorkshop({changed(){}, request(action, input) {
  actions.push(action);
  return service.action(action, input);
 }});
 view.sync('owner-box', true, true);
 await new Promise(resolve => setImmediate(resolve));
 for (const sourceId of ['template:knowledge-qa', 'template:zhike']) {
  await view.action('workshop-open-source', {sourceId});
  await view.action('workshop-copy');
  assert.equal(view.copilotContext().errorCode, 'WORKSHOP_SOURCE_REQUIRED');
  assert.doesNotMatch(view.render(), /创建定制副本/);
 }
 assert.deepEqual(actions, ['list', 'sources', 'sources']);
 assert.deepEqual(calls.map(({method, path}) => [method, path]), [
  ['GET', '/api/_client/workshop/_management/projects'],
 ]);
});
