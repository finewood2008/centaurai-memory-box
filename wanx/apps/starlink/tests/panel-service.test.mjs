import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarlinkPanelService } from '../integration/client-service.mjs';
import { SemanticaService } from '../shell/service.mjs';

function fixture(options = {}) {
  let state = { phase: 'ready', account: { phase: 'authenticated', accountId: 'account', clientId: 'client' }, connection: { deviceId: 'box', gatewayURL: 'http://gateway' } };
  let listener, hold, userId = 1;
  const requests = [], events = [], links = [];
  const context = () => ({ accountId: state.account.accountId, boxId: state.connection.deviceId, user: { id: userId, username: 'fixture' } });
  const client = {
    snapshot: () => state, subscribe: fn => { listener = fn; return () => {}; },
    async applicationConnection(id) {
      if (id === undefined && options.modelRequest) return {context, close(){}, request: options.modelRequest};
      assert.equal(id, 'centaurai.wanx.semantica');
      const link = { context, subscribe: () => () => {}, close() { link.closed = true; },
        async request(input) {
          requests.push(input);
          if (options.request) return options.request(input);
          if (hold) await hold;
          const route = input.path;
          let value = {};
          if (route.endsWith('/warehouses')) value = { items: [{ id: 'warehouse', state: 'active' }] };
          if (route.endsWith('/search')) value = { results: [{ document_id: 'document', excerpt: 'synthetic evidence' }] };
          return { status: 200, body: Buffer.from(JSON.stringify(value)), headers: {} };
        } };
      links.push(link); return link;
    },
  };
  const service = createStarlinkPanelService({ client, starxiaotuModelStore: options.starxiaotuModelStore, emit: event => events.push(event) });
  return { service, requests, events, links, hold: promise => { hold = promise; },
    changeUser(id) { userId = id; },
    switchAccount(id) { state = { ...state, account: { ...state.account, accountId: id } }; listener(); } };
}

test('Starxiaotu follows the platform default and uses one saved model for both question and intent', async () => {
  let records, defaultRef = 'host/platform-a';
  const completions = [];
  const row = (model, input = ['text']) => ({model, input, name:model, provider_name:'host'});
  const models = [row('platform-a'), row('platform-b'), row('alternate'), row('embedding', ['embedding'])];
  const body = {operation_id:'intent-1',version:2,context:{focus:'page',material_title:''},
    text:'现在有多少资料？',page:'graph',history:[],ontology_conversation:false};
  const decision = {intent:'query',target:'project_stats',arguments:{metric:'document_count'}};
  const f = fixture({
    starxiaotuModelStore: {load:async()=>structuredClone(records), save:async value=>{records=structuredClone(value);}},
    modelRequest: async request => {
      if (request.method === 'GET') {
        assert.equal(request.path, '/api/wanx/memory-model');
        return {status:200,body:Buffer.from(JSON.stringify({capabilities:{memory_summary:{defaultRef,models}}}))};
      }
      assert.equal(request.path, '/api/wanx/memory-model/complete');
      const input = JSON.parse(request.body);
      completions.push(input);
      const model = (input.model_ref || defaultRef).split('/').at(-1);
      const message = JSON.parse(input.messages[1].content);
      const text = message.version === 2 ? decision : {answer:'合成答案',citations:[]};
      return {status:200,body:Buffer.from(JSON.stringify({model,text:JSON.stringify(text)}))};
    },
  });
  const ask = () => f.service.action('starxiaotu-answer',{question:'怎么使用？',history:[]});
  const intent = () => f.service.action('assistant-intent',{warehouseId:'selected',body});
  try {
    const catalog = (await f.service.action('starxiaotu-models')).value;
    assert.equal(catalog.selectedRef, null);
    assert.equal(catalog.defaultModel.ref, defaultRef);
    assert.equal(catalog.models.length, 3);
    assert.equal((await f.service.action('save-starxiaotu-model',{modelRef:'host/embedding'})).code, 'MODEL_CHOICE_UNAVAILABLE');
    assert.equal((await ask()).value.model, 'platform-a');
    defaultRef = 'host/platform-b';
    assert.equal((await ask()).value.model, 'platform-b');
    assert.deepEqual((await intent()).value, decision);
    assert.ok(completions.every(request => !Object.hasOwn(request, 'model_ref')));
    assert.equal((await f.service.action('save-starxiaotu-model',{modelRef:'host/alternate'})).value.selectedRef, 'host/alternate');
    await f.service.action('reset');
    assert.equal((await f.service.action('starxiaotu-models')).value.selectedRef, 'host/alternate');
    assert.equal((await ask()).value.model, 'alternate');
    assert.deepEqual((await intent()).value, decision);
    assert.deepEqual(completions.slice(-2).map(request=>request.model_ref), ['host/alternate', 'host/alternate']);
    f.switchAccount('other');
    assert.equal((await f.service.action('starxiaotu-models')).value.selectedRef, null);
    f.switchAccount('account');
    assert.equal((await f.service.action('save-starxiaotu-model',{modelRef:null})).value.selectedRef, null);
    assert.equal((await ask()).value.model, 'platform-b');
    assert.equal(Object.hasOwn(completions.at(-1), 'model_ref'), false);
  } finally { f.service.close(); }
});

test('intent classification uses the selected warehouse and validates model output at IPC',async()=>{
  const valid={intent:'guide',target:'models',arguments:{}};
  const body={operation_id:'intent-1',version:2,context:{focus:'page',material_title:''},text:'模型在哪儿配置',page:'graph',history:[],ontology_conversation:false};
  const f=fixture({request:async()=>({status:200,body:Buffer.from(JSON.stringify(valid)),headers:{}})});
  assert.deepEqual(await f.service.action('assistant-intent',{warehouseId:'selected',body}),{ok:true,value:valid});
  assert.equal(f.requests[0].path,'/api/semantica/warehouses/selected/modeling/assistant-intent');
  f.service.close();
  const bad=fixture({request:async()=>({status:200,body:Buffer.from(JSON.stringify({...valid,url:'/private'})),headers:{}})});
  assert.equal((await bad.service.action('assistant-intent',{warehouseId:'selected',body})).ok,false);
  bad.service.close();
});

test('a warehouse switch during intent authorization prevents sending the old question',async()=>{
  let release,requests=0;
  const service=new SemanticaService({host:{close(){},context:()=>new Promise(resolve=>{release=resolve;}),onSessionInvalidated:()=>()=>{},request:async()=>{requests++;throw new Error('must not send');}}});
  const pending=service.call('assistant-intent',{warehouseId:'selected',body:{operation_id:'intent-1',version:2,context:{focus:'page',material_title:''},text:'private question',page:'graph',history:[],ontology_conversation:false}});
  service.warehouseGeneration++;
  release({accountId:'account',boxId:'box',user:{id:1}});
  await assert.rejects(pending,error=>error.code==='WAREHOUSE_CHANGED');
  assert.equal(requests,0);service.close();
});

const overrideProject = '10000000-0000-4000-8000-000000000001';
const inheritingProject = '10000000-0000-4000-8000-000000000002';
const clearingProject = '10000000-0000-4000-8000-000000000003';
const globalModelPath = '/api/semantica/processing';
const projectModelPath = id => `/api/semantica/warehouses/${id}/processing`;
const projectModelReadPath = id => `${projectModelPath(id)}?warehouse_id=${id}`;
const sharedModelInput = {scope:'default', applyToAll:true, config:{expected_revision:2, mode:'manual', check_id:'checked'}};
const response = (value, status = 200) => ({status, body:Buffer.from(JSON.stringify(value)), headers:{}});

async function processingFixture(t, hooks = {}) {
  const projects = [
    {id:overrideProject, state:'active'}, {id:inheritingProject, state:'active'}, {id:clearingProject, state:hooks.projectState || 'clearing'},
  ];
  let sharedRevision = 2, projectRevision = 8, inherited = false;
  const f = fixture({async request(request) {
    const {path, method} = request;
    if (path.endsWith('/status')) return response({local_data_gate_mode:'required'});
    if (path.endsWith('/warehouses')) return response({items:projects});
    if (path === globalModelPath) {
      if (method === 'PUT') {
        const body = JSON.parse(request.body);
        assert.deepEqual(body, {...sharedModelInput.config, warehouse_id:null, operation_id:body.operation_id});
        assert.match(body.operation_id, /^[a-f0-9-]{36}$/);
        const failure = await hooks.saveShared?.();
        if (failure) return failure;
        sharedRevision++;
      }
      return response({warehouse_id:null, revision:sharedRevision});
    }
    if (path === projectModelReadPath(clearingProject)) {
      assert.equal(hooks.projectState, undefined, 'transfers should be left pending');
      assert.equal(method, 'GET');
      return response({warehouse_id:clearingProject, inherit:true, revision:0});
    }
    if (path === projectModelReadPath(inheritingProject)) {
      assert.equal(method, 'GET');
      return response({warehouse_id:inheritingProject, inherit:true, revision:0});
    }
    if (path === projectModelReadPath(overrideProject) || path === projectModelPath(overrideProject)) {
      if (method === 'PUT') {
        assert.equal(sharedRevision, 3, 'the owner default must be committed before project overrides are cleared');
        const body = JSON.parse(request.body);
        assert.deepEqual(body, {expected_revision:projectRevision, inherit:true, warehouse_id:overrideProject, operation_id:body.operation_id});
        projectRevision++;
        const failure = await hooks.saveOverride?.();
        if (failure) return failure;
        inherited = true;
      }
      return response({warehouse_id:overrideProject, inherit:inherited, revision:projectRevision});
    }
    return response({});
  }});
  assert.equal((await f.service.action('initialize')).ok, true);
  f.requests.length = 0;
  t.after(() => f.service.close());
  return f;
}

test('an explicit personal model save writes the checked shared profile first, then switches legacy overrides to inheritance', async t => {
  const f = await processingFixture(t);
  const result = await f.service.action('save-models', {...sharedModelInput, warehouseId:inheritingProject});
  assert.deepEqual(result, {ok:true, value:{warehouse_id:null, revision:3, modelSync:{pending:0}}});
  assert.deepEqual(f.requests.map(({method,path}) => [method,path]), [
    ['GET','/api/semantica/warehouses'],
    ['GET',projectModelReadPath(overrideProject)], ['GET',projectModelReadPath(inheritingProject)], ['GET',projectModelReadPath(clearingProject)],
    ['PUT',globalModelPath], ['GET',globalModelPath], ['PUT',projectModelPath(overrideProject)],
  ]);
});

test('model synchronization reports a partial save and retries against fresh project revisions without writing the shared profile again', async t => {
  let calls = 0;
  const f = await processingFixture(t, {saveOverride:() => ++calls === 1 && response({code:'MODEL_CONFIG_CONFLICT'}, 409)});
  assert.equal((await f.service.action('sync-models', {scope:'default', expectedRevision:2})).code, 'MODEL_CONFIG_CONFLICT');
  assert.deepEqual(f.requests, [], 'an old saved preference cannot authorize retroactive changes');
  assert.equal((await f.service.action('save-models', sharedModelInput)).value.modelSync.pending, 1);
  assert.equal((await f.service.action('sync-models', {scope:'default', expectedRevision:2})).code, 'MODEL_CONFIG_CONFLICT');
  f.changeUser(2);
  assert.equal((await f.service.action('sync-models', {scope:'default', expectedRevision:3})).code, 'MODEL_CONFIG_CONFLICT');
  f.changeUser(1);
  assert.deepEqual(await f.service.action('sync-models', {scope:'default', expectedRevision:3}),
    {ok:true, value:{modelSync:{pending:0}}});
  assert.equal((await f.service.action('sync-models', {scope:'default', expectedRevision:3})).code, 'MODEL_CONFIG_CONFLICT');
  assert.deepEqual(f.requests.filter(request => request.method === 'PUT').map(({path,body}) => [path,JSON.parse(body).expected_revision]), [
    [globalModelPath,2], [projectModelPath(overrideProject),8], [projectModelPath(overrideProject),9],
  ]);
});

test('refused and abandoned global model saves leave previous project overrides intact', async t => {
  const refused = await processingFixture(t, {saveShared:() => response({code:'MODEL_CHECK_REQUIRED'},409)});
  assert.equal((await refused.service.action('save-models', sharedModelInput)).code, 'MODEL_CHECK_REQUIRED');
  assert.deepEqual(refused.requests.filter(request => request.method === 'PUT').map(request => request.path), [globalModelPath]);

  let began, release;
  const begun = new Promise(resolve => { began = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const changed = await processingFixture(t, {saveShared:async () => { began(); await wait; }});
  const pending = changed.service.action('save-models', sharedModelInput);
  await begun;
  changed.switchAccount('other');
  release();
  assert.equal((await pending).code, 'HOST_SESSION_EXPIRED');
  assert.deepEqual(changed.requests.filter(request => request.method === 'PUT').map(request => request.path), [globalModelPath]);
});

test('projects owned by an in-progress transfer remain pending without a scoped mutation', async t => {
  const f = await processingFixture(t, {projectState:'importing'});
  assert.equal((await f.service.action('save-models', sharedModelInput)).value.modelSync.pending, 1);
  assert.ok(f.requests.every(({path}) => !path.includes(clearingProject)));
});

test('panel uses the current Host identity and routes knowledge reads through Bridge', async () => {
  const f = fixture();
  try {
    const init = await f.service.action('initialize');
    assert.equal(init.ok, true); assert.equal(init.value.identity.boxId, 'box');
    const result = await f.service.action('search', { warehouseId: 'warehouse', query: 'material' });
    assert.equal(result.ok, true); assert.equal(result.value.results[0].document_id, 'document');
    assert.equal(f.requests.at(-1).path, '/api/semantica/warehouses/warehouse/search');
    assert.equal(JSON.parse(f.requests.at(-1).body).query, 'material');
  } finally { f.service.close(); }
});

test('current-material retrieval forwards the client-bound document filter',async()=>{
  const f=fixture();
  try{
    const result=await f.service.action('search',{warehouseId:'warehouse',query:'星图产品功能',documentIds:['selected-document']});
    assert.equal(result.ok,true);
    assert.deepEqual(JSON.parse(f.requests.at(-1).body).document_ids,['selected-document']);
  }finally{f.service.close();}
});

test('space import errors retain actionable public codes across the panel boundary', async () => {
  const f = fixture({request: async () => ({status:404,body:Buffer.from('{}'),headers:{}})});
  try {
    const result = await f.service.action('space-list', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SPACE_UPGRADE_REQUIRED');
  } finally { f.service.close(); }
});

test('a service-side identity refusal releases the old session and can initialize again', async () => {
  const f = fixture();
  try {
    await f.service.action('initialize');
    f.changeUser(2);
    assert.equal((await f.service.action('onboarding-read')).ok, false);
    assert.equal(f.links[0].closed, true);
    const next = await f.service.action('initialize');
    assert.equal(next.ok, true);
    assert.equal(next.value.identity.user.id, 2);
  } finally { f.service.close(); }
});

test('closing the service refuses a file chooser that completes after logout', async () => {
  let finish;
  const service = new SemanticaService({host:{onSessionInvalidated:()=>()=>{},close(){}},
    selectFiles:()=>new Promise(resolve=>{finish=resolve;})});
  const pending = service.call('select-files', {warehouseId:'warehouse'});
  service.close(); finish([]);
  await assert.rejects(pending, {code:'HOST_SESSION_EXPIRED'});
  assert.equal(service.files.size, 0);
});

test('removed application management actions never reach the backend', async () => {
  const f = fixture();
  try {
    for (const action of ['select-files', 'create-key', 'import-skill', 'clear-warehouse', 'open-starlink']) {
      const result = await f.service.action(action, {});
      assert.equal(result.ok, false);
    }
    assert.equal(f.requests.length, 0); assert.equal(f.links.length, 0);
  } finally { f.service.close(); }
});

test('personal panel submits deletion only through the explicit warehouse and confirmation routes', async () => {
  const f = fixture();
  const warehouseId = '10000000-0000-4000-8000-000000000001';
  const operationId = '20000000-0000-4000-8000-000000000002';
  try {
    for (const input of [{}, {operationId}, {warehouseId,operationId}, {warehouseId,operationId,token:'test',typedName:''}]) {
      assert.equal((await f.service.action('delete-warehouse', input)).code, 'INVALID_RESOURCE');
    }
    assert.equal(f.requests.length, 0);
    assert.equal((await f.service.action('prepare-delete',{warehouseId,operationId})).ok,true);
    assert.equal((await f.service.action('delete-warehouse',{warehouseId,operationId,token:'fixture-token',typedName:'测试仓'})).ok,true);
    assert.deepEqual(f.requests.map(({path,method,body})=>[path,method,JSON.parse(body)]), [
      [`/api/semantica/warehouses/${warehouseId}/delete/prepare`, 'POST', {operation_id:operationId}],
      [`/api/semantica/warehouses/${warehouseId}/delete`, 'POST',
        {operation_id:operationId,confirmation_token:'fixture-token',typed_name:'测试仓'}],
    ]);
  } finally { f.service.close(); }
});

test('account changes discard pending reads and release their connection', async () => {
  const f = fixture(); let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.action('warehouses');
  await new Promise(resolve => setImmediate(resolve));
  f.switchAccount('other'); release();
  assert.equal((await pending).ok, false);
  assert.equal(f.links[0].closed, true);
  assert.equal((await f.service.action('initialize')).value.identity.accountId, 'other');
  assert.ok(f.events.some(event => event.type === 'invalidated'));
  f.service.close();
});

test('reset releases resources and starts a fresh session on the next visit', async () => {
  const f = fixture();
  await f.service.action('warehouses');
  await f.service.action('reset');
  assert.equal(f.links[0].closed, true);
  await f.service.action('warehouses'); assert.equal(f.links.length, 2);
  f.service.close();
});

test('星小图 uses the box text model and hands off only confirmed citation targets and known actions', async () => {
  const { answerStarxiaotu } = await import('../integration/starxiaotu-agent.mjs');
  const context = () => ({boxId:'box',user:{id:1}});
  const inputs = [], reads = [];
  const item = (text, status, id) => ({text, sensitive_status:status, document_id:id, document_version_id:'v1', segment_id:'s1'});
  const protectedItem = item('合成证据', 'masked', 'allowed');
  const gateway = {context,close(){},async request(request){
    inputs.push(request);
    return {status:200,body:Buffer.from(JSON.stringify({model:'fixture-model',text:JSON.stringify({answer:'有出处。',action:'publish',citations:[1,2,99]})}))};
  }};
  const service = {controller:new AbortController(),warehouseGeneration:0,assertLive(){},async call(action, input){
    assert.equal(input.warehouseId,'project');
    reads.push(action);
    if (action==='warehouse') return {id:'project',name:'合同档案',document_count:0};
    if (action==='conversation-ontologies') return {items:[
      {status:'draft',name:'未发布规则',schema:{entity_types:[{name:'PRIVATE_DRAFT'}]}},
      {status:'published',name:'合同规则',version_number:3,schema:{
        entity_types:[{name:'CONTRACT',label:'合同',properties:[{name:'DATE',label:'到期日',required:false}]}],
        relation_types:[{name:'REF',label:'引用',source_types:['CONTRACT'],target_types:['CONTRACT']}],
      }},
    ]};
    assert.equal(action,'search');
    return {sensitive:{enabled:true},items:[protectedItem,item('未检查的原文','pending','blocked')]};
  }};
  const call = useSources => answerStarxiaotu({client:{applicationConnection:async()=>gateway},service,link:{context},
    input:{question:'有什么依据？',history:['请找会议纪要'],warehouseId:'project',useSources,guide:'ontology'},live(){}});
  assert.deepEqual(await call(true),{answer:'有出处。',model:'fixture-model',action:null,projectContext:true,items:[protectedItem]});
  assert.equal(inputs[0].path,'/api/wanx/memory-model/complete');
  const {product_guide:guide, ...modelInput}=JSON.parse(JSON.parse(inputs[0].body).messages[1].content);
  assert.deepEqual(modelInput,{
    question:'有什么依据？',history:['请找会议纪要'],sources:[{number:1,text:'合成证据'}],
    project:{name:'合同档案',document_count:0,ontology:{
      status:'published',name:'合同规则',version:3,entity_type_count:1,relation_type_count:1,
      entity_types:[{label:'合同',attributes:[{label:'到期日',required:false}]}],
      relation_types:[{label:'引用',from:['合同'],to:['合同']}],
    }},
  });
  assert.equal(guide.title,'本体');
  const legacy=await call(false), legacyInput=JSON.parse(JSON.parse(inputs[1].body).messages[1].content);
  assert.deepEqual(legacy.items,[protectedItem]);
  assert.equal(legacy.projectContext,true);
  assert.deepEqual(legacyInput.sources,modelInput.sources);
  assert.deepEqual(legacyInput.project,modelInput.project);
  assert.deepEqual(reads,['warehouse','conversation-ontologies','search','warehouse','conversation-ontologies','search']);
  service.call = async () => {throw Error('project unavailable');};
  await assert.rejects(call(),{code:'SEMANTICA_CONNECTION_FAILED'});
  service.call = async () => {service.warehouseGeneration++; return {items:[protectedItem]};};
  await assert.rejects(call(true),{code:'WAREHOUSE_CHANGED'});
  assert.equal(inputs.length,2);
  const initial = await answerStarxiaotu({client:{applicationConnection:async()=>gateway},service,link:{context},
    input:{question:'怎么从零开始？',history:[],warehouseId:null,useSources:true},live(){}});
  assert.equal(initial.model,'fixture-model');
  assert.deepEqual(JSON.parse(JSON.parse(inputs[2].body).messages[1].content).sources,[]);
});
