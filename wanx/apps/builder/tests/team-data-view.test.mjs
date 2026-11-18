import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const source=(await build({entryPoints:[fileURLToPath(new URL('../integration/team-client/data-view.js',import.meta.url))],bundle:true,platform:'browser',format:'iife',write:false,logLevel:'silent'})).outputFiles[0].text;
function make(request,timers={},document={},options={}){const window={localStorage:options.storage||memoryStorage()},context=vm.createContext({window,setInterval:()=>0,clearInterval,setTimeout:timers.setTimeout||(()=>0),clearTimeout:timers.clearTimeout||(()=>{}),document,FormData:class{constructor(target){this.target=target}get(name){return this.target?.[name]??''}},crypto:globalThis.crypto});vm.runInContext(source,context);return window.createTeamDataView({request,changed:()=>{},...options})}
const state={canLaunchApplications:true,account:{accountId:'a'},activeDeviceId:'box'};

test('isolated entities are hidden by default, can be toggled without network writes, and reset on warehouse change',async()=>{
 const calls=[];
 const view=make(async(name,input)=>{
  calls.push(name);
  if(name==='data.warehouses')return {items:[{id:'w',name:'test',entity_count:3},{id:'other',name:'other'}]};
  if(name==='data.warehouse')return {id:input.id};
  if(name==='data.graph')return {nodes:[{id:'a',canonical_name:'connected-a',entity_type:'PRODUCT'},{id:'b',canonical_name:'connected-b',entity_type:'TASK'},{id:'c',canonical_name:'isolated-c',entity_type:'OTHER'}],edges:[{id:'ab',subject_entity_id:'a',object_entity_id:'b',relation_type:'USES',evidence:[]}]};
  return {items:[]};
 });
 view.sync(state,true);await view.refresh();let html=view.render();
 assert.match(html,/connected-a/);assert.doesNotMatch(html,/isolated-c/);assert.match(html,/已隐藏 1 个孤立实体/);
 assert.match(html,/graph-isolated" role="switch" aria-checked="false"/);
 assert.doesNotMatch(html,/data-type="all"/);
 const before=calls.length;await view.action('graph-isolated');html=view.render();assert.equal(calls.length,before);
 assert.match(html,/isolated-c/);assert.match(html,/graph-isolated" role="switch" aria-checked="true"/);
 await view.refresh();assert.match(view.render(),/isolated-c/);
 await view.action('graph-isolated');assert.doesNotMatch(view.render(),/isolated-c/);
 await view.action('graph-isolated');await view.action('select',{id:'other'});assert.doesNotMatch(view.render(),/isolated-c/);
});

test('all-isolated graph explains the hidden nodes and always exposes the toggle',async()=>{
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'test',document_count:1}]}:name==='data.warehouse'?{id:'w'}:name==='data.graph'?{nodes:[{id:'a',canonical_name:'独立实体',entity_type:'OTHER'}],edges:[]}:{items:[]});
 view.sync(state,true);await view.refresh();assert.match(view.render(),/暂无有关系的实体/);assert.match(view.render(),/data-data-action="graph-isolated"/);assert.doesNotMatch(view.render(),/知识图谱尚未生成/);
 await view.action('graph-isolated');assert.match(view.render(),/aria-label="查看实体 独立实体"/);
});

test('v3 covers 17 types including OTHER with consistent filters, colors and details without schema metadata',async()=>{
 const types={PERSON:'人物',ORG:'组织',GPE:'地点',EVENT:'事件',CONCEPT:'概念',DOCUMENT:'材料',PRODUCT:'产品与系统',FEATURE:'功能',TECHNOLOGY:'方法与技术',DATE:'日期',PROJECT:'项目',BUSINESS_OBJECT:'业务对象',PROCESS:'流程',TASK:'任务',METRIC:'指标',ISSUE:'问题与风险',OTHER:'其它',CUSTOM_TYPE:'CUSTOM_TYPE'};
 const nodes=Object.keys(types).map(t=>({id:t,entity_type:t,canonical_name:'node-'+t}));
 const snapshot=JSON.stringify(nodes);
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'test'}]}:name==='data.warehouse'?{id:'w'}:name==='data.graph'?{nodes,edges:[]}:{items:[]});
 view.sync(state,true);await view.refresh();await view.action('graph-isolated');const full=view.render();
 for(const [type,label] of Object.entries(types)){
  assert(full.includes(`data-type="${type}"`));assert(full.includes(`>${label}</button>`));
  await view.action('graph-type',{type});await view.action('node',{id:type});const html=view.render();
  assert(html.includes(`<p class="data-detail-eyebrow">${label}</p>`));
  const color=html.match(new RegExp(`data-type="${type}"[^>]*><i style="background:(#[a-f0-9]+)"`))?.[1];
  assert(color);assert(html.includes(`style="--type-color:${color}"`));
  assert.equal((html.match(/aria-label="查看实体 node-/g)||[]).length,1);
 }
 assert.equal(JSON.stringify(nodes),snapshot);
});

test('test warehouse fixture renders six actual types and all 24 entities without CONCEPT',async()=>{
 const counts={BUSINESS_OBJECT:5,EVENT:2,METRIC:5,PROCESS:7,PRODUCT:3,TASK:2};
 const nodes=Object.entries(counts).flatMap(([type,count])=>Array.from({length:count},(_,i)=>({id:type+i,canonical_name:type+i,entity_type:type})));
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'test',entity_count:24}]}:name==='data.warehouse'?{id:'w'}:name==='data.graph'?{nodes,edges:[]}:{items:[]});
 view.sync(state,true);await view.refresh();await view.action('graph-isolated');const html=view.render();
 assert.equal((html.match(/data-data-action="graph-type"/g)||[]).length,6);
 assert.equal((html.match(/aria-label="查看实体 /g)||[]).length,24);
 assert.doesNotMatch(html,/data-type="CONCEPT"/);
});

test('graph preserves all published types, uses current schema labels and filters unknown types independently',async()=>{
 const types=['BUSINESS_OBJECT','PROCESS','METRIC','TASK','EVENT','PRODUCT','CUSTOM_TYPE'];
 let labels={entities:{BUSINESS_OBJECT:'业务对象',PROCESS:'流程',METRIC:'指标',TASK:'任务',CUSTOM_TYPE:'自定义<类型>'},relations:{MEASURES:'衡量'}};
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'test'}]}:name==='data.warehouse'?{id:'w',ontology_labels:labels}:name==='data.graph'?{
  nodes:types.map((t,i)=>({id:String(i),canonical_name:'entity-'+i,entity_type:t})),
  edges:[{id:'r',subject_entity_id:'2',object_entity_id:'0',relation_type:'MEASURES',evidence:[]}],
 }:{items:[]});
 view.sync(state,true);await view.refresh();await view.action('graph-isolated');let html=view.render();
 for(const type of types)assert(html.includes(`data-type="${type}"`));
 assert.doesNotMatch(html,/data-type="CONCEPT"/);assert.match(html,/业务对象/);assert.match(html,/自定义&lt;类型&gt;/);assert.match(html,/衡量/);
 await view.action('graph-type',{type:'CUSTOM_TYPE'});html=view.render();assert.match(html,/aria-label="查看实体 entity-6"/);assert.doesNotMatch(html,/aria-label="查看实体 entity-0"/);
 labels=null;await view.refresh();assert.match(view.render(),/>CUSTOM_TYPE<\/button>/);assert.doesNotMatch(view.render(),/自定义&lt;类型&gt;/);
});

function creationFixture(request,storage){
 const form={},button={},alert={},nameError={},input={focus(){}},dialog={dataset:{},showModal(){},close(){this.closed=true},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?button:s==='[name="name"]'?input:s==='.data-warehouse-name-error'?nameError:alert};
 const document={createElement:()=>dialog,body:{append(){}},querySelectorAll:()=>[]};
 const view=make(request,{},document,{edition:'personal',storage});view.sync(state,true);
 return {view,dialog,alert,nameError,submit:(name='测试仓',description='')=>form.onsubmit({preventDefault(){},target:{name,description}})};
}
function memoryStorage(){const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};}

test('quick creation recovers the same request across page reloads and reads current ontology, without a model call',async()=>{
 const storage=memoryStorage(),writes=[],calls=[];let lost=true;
 const request=async(name,input)=>{
  calls.push(name);
  if(name==='data.create-warehouse'){writes.push(input);if(lost){lost=false;throw Error('SEMANTICA_CONNECTION_FAILED')}return {id:'w',current_ontology:{name:'旧回执',status:'published'}}}
  if(name==='data.warehouses')return {items:[{id:'w',name:'测试仓',entity_count:0}]};
  if(name==='data.warehouse')return {id:'w',current_ontology:{name:'最新结构',status:'published',version_number:3,template_id:null,template_version:null}};
  return {items:[],nodes:[],edges:[]};
 };
 const first=creationFixture(request,storage);await first.view.action('create');await first.submit();
 assert.match(first.alert.textContent,/已保留原请求/);assert.equal(storage.values.size,1);
 const second=creationFixture(request,storage);await second.view.action('create');assert.match(second.dialog.innerHTML,/恢复原请求/);
 await second.submit('改名');assert.equal(writes.length,1);assert.match(second.alert.textContent,/尚未确认/);
 await second.submit();assert.equal(writes.length,2);assert.equal(JSON.stringify(writes[0]),JSON.stringify(writes[1]));assert.equal(storage.values.size,0);
 assert.match(second.view.render(),/最新结构/);assert.doesNotMatch(second.view.render(),/旧回执|通用知识结构已生效/);
 assert(calls.includes('data.select-warehouse'));assert(!calls.some(n=>/processing|model|ontology.*publish/.test(n)));
});

test('name conflict is field-specific and a corrected request receives a new operation ID',async()=>{
 const writes=[],fixture=creationFixture(async(name,input)=>{if(name==='data.create-warehouse'){writes.push(input);throw Error('WAREHOUSE_NAME_CONFLICT')}return {items:[]}},memoryStorage());
 await fixture.view.action('create');await fixture.submit();assert.match(fixture.nameError.textContent,/同名/);
 await fixture.submit('新名称');assert.equal(writes.length,2);assert.notEqual(writes[0].operationId,writes[1].operationId);
});

test('a saved creation receipt resumes with GET and never repeats POST after a detail failure',async()=>{
 const storage=memoryStorage();let writes=0,unavailable=true;
 const request=async name=>{
  if(name==='data.create-warehouse'){writes++;return {id:'w'}}
  if(name==='data.warehouse'){if(unavailable)throw Error('SEMANTICA_SERVICE_UNAVAILABLE');return {id:'w',current_ontology:null}}
  if(name==='data.warehouses')return {items:[{id:'w',name:'测试仓'}]};
  return {items:[],nodes:[],edges:[]};
 };
 const first=creationFixture(request,storage);await first.view.action('create');await first.submit();assert.equal(writes,1);
 unavailable=false;const second=creationFixture(request,storage);await second.view.action('create');await second.submit();
 assert.equal(writes,1);assert.equal(storage.values.size,0);assert.match(second.view.render(),/未提供已生效/);
});

test('failed warehouse selection remains retryable in the original creation dialog',async()=>{
 let writes=0,selections=0;const storage=memoryStorage();
 const fixture=creationFixture(async name=>{
  if(name==='data.create-warehouse'){writes++;return {id:'w'}}
  if(name==='data.warehouse')return {id:'w'};
  if(name==='data.warehouses')return {items:[{id:'w',name:'测试仓'}]};
  if(name==='data.select-warehouse'&&++selections===1)throw Error('SEMANTICA_CONNECTION_FAILED');
  return {items:[],nodes:[],edges:[]};
 },storage);
 await fixture.view.action('create');await fixture.submit();assert.equal(storage.values.size,1);
 await fixture.submit();assert.equal(writes,1);assert.equal(selections,2);assert.equal(storage.values.size,0);assert.equal(fixture.dialog.closed,true);
});

test('reconnect can recover an uncertain creation but a late selection cannot clear its receipt',async()=>{
 const storage=memoryStorage();let writes=0,release;
 const request=async name=>{
  if(name==='data.create-warehouse'){writes++;return {id:'w'}}
  if(name==='data.warehouse')return {id:'w'};
  if(name==='data.warehouses')return {items:[{id:'w',name:'测试仓'}]};
  if(name==='data.select-warehouse')return new Promise(r=>release=r);
  return {items:[],nodes:[],edges:[]};
 };
 const fixture=creationFixture(request,storage);await fixture.view.action('create');const submit=fixture.submit();
 await new Promise(r=>setImmediate(r));fixture.view.sync({...state,dataContextId:'new-session'},true);release();await submit;
 assert.equal(storage.values.size,1);
 const next=creationFixture(async name=>name==='data.select-warehouse'?{}:request(name),storage);
 next.view.sync({...state,dataContextId:'another-session'},true);await next.view.action('create');
 assert.match(next.dialog.innerHTML,/恢复原请求/);await next.submit();assert.equal(writes,1);assert.equal(storage.values.size,0);
});

test('storage failure and invalid warehouse names never send a creation request',async()=>{
 let writes=0;const storage={getItem:()=>null,setItem(){throw Error('quota')}};
 const fixture=creationFixture(async()=>{writes++},storage);await fixture.view.action('create');
 await fixture.submit('   ');assert.equal(writes,0);
 await fixture.submit();assert.equal(writes,0);assert.match(fixture.alert.textContent,/本地存储/);
});

test('unavailable recovery storage remains visible even on an already loaded warehouse page',async()=>{
 const storage={getItem(){throw Error('SecurityError')}};
 const fixture=creationFixture(async name=>name==='data.warehouses'?{items:[{id:'w',name:'已有仓'}]}:name==='data.warehouse'?{id:'w'}:{items:[],nodes:[],edges:[]},storage);
 await fixture.view.refresh();await fixture.view.action('create');assert.match(fixture.view.render(),/无法保存或读取建仓恢复记录/);
});

test('ordinary upload keeps warehouse and model confirmation and opens processing tasks',async()=>{
 const calls=[];
 const fixture=creationFixture(async(name,input)=>{
  calls.push([name,input]);
  if(name==='data.warehouses')return {items:[{id:'w',name:'通用资料'}]};
  if(name==='data.warehouse')return {id:'w',current_ontology:{status:'published',template_id:'personal_general'}};
  if(name==='data.select-files')return [{handle:'file-handle',name:'report.html',size:100}];
  if(name==='data.processing')return {effective:{extraction:{model:'configured-model'}}};
  return {items:[],nodes:[],edges:[]};
 },memoryStorage());
 await fixture.view.refresh();await fixture.view.action('import-local');
 assert.match(fixture.dialog.innerHTML,/configured-model/);assert.match(fixture.dialog.innerHTML,/checkbox.*required/);
 assert(!calls.some(([name])=>name==='data.upload'));await fixture.submit();
 const upload=calls.find(([name])=>name==='data.upload');assert.equal(upload[1].warehouseId,'w');assert.equal(upload[1].handle,'file-handle');
 assert(calls.some(([name,input])=>name==='data.jobs'&&input.warehouseId==='w'));
 assert(!calls.some(([name])=>/conversation|modeling|publish/.test(name)));
});

test('creation blocks duplicate submission and does not move a late receipt into another account',async()=>{
 const storage=memoryStorage(),calls=[];let release;
 const fixture=creationFixture(async(name)=>{calls.push(name);if(name==='data.create-warehouse')return new Promise(r=>release=r);return {items:[]}},storage);
 await fixture.view.action('create');const first=fixture.submit();await fixture.submit();assert.equal(calls.length,1);
 fixture.view.sync({...state,account:{accountId:'other'}},true);release({id:'old'});await first;
 assert(!calls.includes('data.select-warehouse'));assert.equal(storage.values.size,1);
 await fixture.view.action('create');assert.doesNotMatch(fixture.dialog.innerHTML,/恢复原请求|value="测试仓"/);
});

test('published ontology summary separates template versions and type counts from extracted entities',async()=>{
 let ontology={status:'published',name:'服务端模板名称',template_id:'personal_general',template_version:1,version_number:4,entity_type_count:16,relation_type_count:18};
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'空仓',entity_count:0,relation_count:0}]}:name==='data.warehouse'?{id:'w',current_ontology:ontology}:{items:[],nodes:[],edges:[]});
 view.sync(state,true);await view.refresh();const html=view.render();
 assert.match(html,/通用知识结构已生效/);assert.match(html,/模板版本 1/);assert.match(html,/仓内版本 4/);assert.match(html,/16 类实体/);assert.doesNotMatch(html,/16 个知识实体/);
 ontology=null;await view.refresh();assert.doesNotMatch(view.render(),/通用知识结构已生效/);assert.match(view.render(),/未提供已生效/);
});

test('material deletion requires confirmation and retries the same scoped operation',async()=>{
 const calls=[],form={},button={},dialog={dataset:{},showModal(){},close(){},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?button:{}};
 const document={createElement:()=>dialog,body:{append(){}},querySelectorAll:()=>[]};let attempts=0;
 const view=make(async(name,input)=>{
  calls.push([name,input]);
  if(name==='data.warehouses')return {items:[{id:'w',name:'warehouse'}]};
  if(name==='data.document')return {document:{id:'d',original_name:'test.pptx'},version:{id:'v'}};
  if(name==='data.delete-document'&&++attempts===1)throw Error('SEMANTICA_CONNECTION_FAILED');
  return {items:[]};
 },{},document);
 view.sync(state,true);await view.refresh();await view.action('delete-material',{id:'d'});
 assert.match(dialog.innerHTML,/删除材料及对应知识/);assert.match(dialog.innerHTML,/checkbox.*required/);
 assert(!calls.some(([name])=>name==='data.delete-document'));
 await form.onsubmit({preventDefault(){},target:{}});await form.onsubmit({preventDefault(){},target:{}});
 const writes=calls.filter(([name])=>name==='data.delete-document').map(([,input])=>input);
 assert.equal(writes.length,2);assert.equal(writes[0].operationId,writes[1].operationId);
 assert.equal(writes[0].confirmed,true);assert.equal(writes[0].id,'d');assert.equal(writes[0].versionId,'v');assert.equal(writes[0].warehouseId,'w');
});

test('task and search panels refresh the visible graph after publication',async()=>{
 let published=false;
 const view=make(async name=>{
  if(name==='data.warehouses')return {items:[{id:'w1',name:'资料仓',document_count:2,entity_count:published?2:0}]};
  if(name==='data.governance-summary')return {supported:false};
  if(name==='data.graph')return {nodes:published?[{entity_id:'a',canonical_name:'采购订单',entity_type:'FEATURE'},{entity_id:'b',canonical_name:'指标问题',entity_type:'CONCEPT'}]:[],edges:published?[{fact_id:'f',subject_entity_id:'b',object_entity_id:'a',relation_type:'AFFECTS',evidence:[{document_id:'d',excerpt:'订单受指标问题影响'}]}]:[]};
  return {items:[]};
 });
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w1',tab:'tasks'});
 published=true;await view.refresh();
 assert.match(view.render(),/采购订单/);assert.doesNotMatch(view.render(),/知识图谱尚未生成|待确认 undefined/);
 await view.action('tab',{tab:'search'});assert.match(view.render(),/采购订单/);
});

test('unsupported governance stops repeated probes and writes without hiding the graph',async()=>{
 const calls=[],view=make(async(name)=>{calls.push(name);if(name==='data.warehouses')return {items:[{id:'w1',name:'测试资料',entity_count:1}]};if(name==='data.governance-summary')return {supported:false};return {items:[],nodes:[],edges:[]}});
 view.sync(state,true);await view.refresh();await view.refresh();
 assert.equal(calls.filter(n=>n==='data.governance-summary').length,1);
 await view.action('reviews');assert.match(view.render(),/知识治理暂不可用/);assert.doesNotMatch(view.render(),/没有待确认事项/);
 await view.action('flag',{kind:'entity',id:'e1'});
 assert.equal(calls.filter(n=>n==='data.governance-reviews'||n==='data.governance-flag').length,0);
 view.sync({...state,activeDeviceId:'other'},true);await view.refresh();
 assert.equal(calls.filter(n=>n==='data.governance-summary').length,2);
});

test('the canonical data stylesheet reserves responsive inspector and refresh space',async()=>{
 const shared=await readFile(new URL('../integration/team-client/data.css',import.meta.url),'utf8');
 assert.match(shared,/data-lite-workspace/);assert.match(shared,/data-lite-inspector/);assert.match(shared,/data-sync-status/);assert.match(shared,/@media\(max-width:920px\)/);
});

test('suspend stops reads and late graph results, then resumes the selected warehouse and tab',async()=>{
 let calls=0,release,delay=false;
 const view=make(async name=>{calls++;if(name==='data.warehouses'){if(delay)return new Promise(r=>release=r);return{items:[{id:'warehouse',name:'会议知识',state:'active'}]}}return{items:[],nodes:[],edges:[]}});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'warehouse'});await view.action('tab',{tab:'search'});
 delay=true;const pending=view.refresh();view.suspend();const stopped=calls;await view.refresh();await view.action('create');assert.equal(calls,stopped);
 release({items:[{id:'late',name:'不应回填的旧仓库'}]});await pending;
 delay=false;view.sync({...state,dataContextId:'renewed-session'},true,{preserveSelection:true});await view.refresh();
 assert.match(view.render(),/会议知识/);assert.match(view.render(),/data-data-form="search"/);assert.doesNotMatch(view.render(),/不应回填/);
});
test('data page refuses user role and clears warehouses after scope change',async()=>{
 const view=make(async()=>({items:[{id:'warehouse',name:'旧团队知识',state:'active'}]}));
 view.sync(state,true);await view.refresh();assert.match(view.render(),/旧团队知识/);
 view.sync(state,false);assert.doesNotMatch(view.render(),/旧团队知识/);assert.match(view.render(),/管理员/);
});
test('late warehouse responses cannot fill another account',async()=>{
 let resolve;const view=make(()=>new Promise(r=>resolve=r));view.sync(state,true);const pending=view.refresh();view.sync({...state,account:{accountId:'b'}},true);resolve({items:[{id:'a',name:'不应泄漏的旧仓'}]});await pending;assert.doesNotMatch(view.render(),/不应泄漏/);
});
test('server failure stays visible and does not create a demonstration warehouse',async()=>{
 const view=make(async()=>{throw Error('SEMANTICA_NOT_CONFIGURED')});view.sync(state,true);await view.refresh();assert.match(view.render(),/尚未配置/);assert.doesNotMatch(view.render(),/客户知识仓/);
});
test('refresh replaces the previous Starlink installation action with the current service error',async()=>{
 for(const openCode of ['TEAM_STARLINK_NOT_INSTALLED','TEAM_STARLINK_UPGRADE_REQUIRED']){
  const view=make(async name=>{const code=name==='data.open-starlink'?openCode:'SEMANTICA_SERVICE_AUTH_FAILED';throw Object.assign(Error(code),{code})});
  view.sync(state,true);await view.action('open',{view:'warehouses'});
  assert.match(view.render(),/data-data-action="install-starlink"/);
  await view.refresh();const html=view.render();
  assert.doesNotMatch(html,/data-data-action="install-starlink"/);
  assert.match(html,/接入鉴权失败/);assert.match(html,/服务凭据及团队接入版本/);
  assert.match(html,/data-data-action="refresh"[^>]*>重试/);
 }
});
test('team service failures explain the relevant access or compatibility problem',async()=>{
 for(const [code,message] of [
  ['SEMANTICA_SERVICE_AUTH_FAILED',/接入鉴权失败/],
  ['SEMANTICA_RESOURCE_FORBIDDEN',/拒绝访问当前团队数据/],
  ['SEMANTICA_RESOURCE_NOT_FOUND',/未找到所请求的资源/],
  ['SEMANTICA_INVALID_REQUEST',/未接受当前请求/],
 ]){
  const view=make(async()=>{throw Object.assign(Error(code),{code})});view.sync(state,true);await view.refresh();
  assert.match(view.render(),message);assert.doesNotMatch(view.render(),/操作未完成|data-data-action="install-starlink"/);
 }
});
test('invalid IPC response is shown as a failure without breaking the shell',async()=>{
 const view=make(async()=>({ok:true,value:{items:[]}}));view.sync(state,true);await view.refresh();assert.doesNotThrow(()=>view.render());assert.match(view.render(),/操作未完成/);
});
const teamRows=[{id:'w1',name:'产品知识',entity_count:2},{id:'w2',name:'交付流程',entity_count:1}];
const realGraph={nodes:[{id:'product',canonical_name:'真实产品',entity_type:'PRODUCT'},{id:'team',canonical_name:'真实团队',entity_type:'ORG'}],edges:[{id:'fact',subject_entity_id:'team',object_entity_id:'product',relation_type:'USES',evidence:[{document_id:'doc',excerpt:'真实材料中的证据',locator_json:{page:2}}]}]};
test('overview loads the selected warehouse graph above warehouse statistics and opens the same Starlink target',async()=>{
 const calls=[];const view=make(async(name,input)=>{calls.push([name,input]);return name==='data.warehouses'?{items:teamRows}:name==='data.graph'?realGraph:{}});
 view.sync(state,true);await view.refresh();const html=view.render();
 assert(html.indexOf('data-lite-metrics')<html.indexOf('data-core-graph'));assert.match(html,/真实产品/);assert.match(html,/node-star/);assert.match(html,/data-edge/);assert.equal(calls[1][1].warehouseId,'w1');
 await view.action('node',{id:'team'});assert.match(view.render(),/真实材料中的证据/);assert.match(view.render(),/data-warehouse-id="w1"/);
 await view.action('open',{warehouseId:'w1',view:'graph'});assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['data.open-starlink',{warehouseId:'w1',view:'graph'}]));
});
test('switching preview warehouses drops late graph results and keeps the new scope',async()=>{
 let resolve,calls=0;const view=make(async(name,input)=>{if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph'){calls++;if(calls===1)return new Promise(r=>resolve=r);assert.equal(input.warehouseId,'w2');return {nodes:[{id:'new',canonical_name:'新仓实体'}],edges:[]}}});
 view.sync(state,true);const old=view.refresh();await new Promise(r=>setImmediate(r));await view.action('graph-warehouse',{id:'w2'});resolve(realGraph);await old;await view.action('graph-isolated');
 assert.match(view.render(),/新仓实体/);assert.doesNotMatch(view.render(),/真实产品/);
});
test('graph failure preserves the warehouse list and does not substitute sample nodes',async()=>{
 const view=make(async name=>{if(name==='data.warehouses')return {items:teamRows};throw Error('SEMANTICA_SERVICE_UNAVAILABLE')});
 view.sync(state,true);await view.refresh();const html=view.render();assert.match(html,/知识图谱/);assert.match(html,/暂时不可用/);assert.match(html,/data-data-action="warehouse-picker"/);assert.doesNotMatch(html,/data-core-node/);
 view.sync({...state,account:{accountId:'other'}},true);assert.doesNotMatch(view.render(),/产品知识/);
});
test('imported materials with no graph lead to processing tasks instead of suggesting another import',async()=>{
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'已导入仓',document_count:19}]}:name==='data.jobs'?{items:[{id:'p',kind:'knowledge_publish',status:'failed',stage:'failed'}]}:{nodes:[],edges:[]});
 view.sync(state,true);await view.refresh();assert.match(view.render(),/已导入 19 份材料/);assert.match(view.render(),/查看处理任务/);
 await view.action('select',{id:'w',tab:'tasks'});assert.match(view.render(),/图谱写入/);assert.match(view.render(),/无需再次调用抽取模型/);
});
test('failed and cancelled ontology suggestions show their reason and regeneration guidance without a task retry',async()=>{
 const reason='本体建议生成失败：上下文预算不足。当前上限为 4096 token，至少需要约 6612 token。';
 const rows=[{id:'ontology-failed',kind:'ontology_suggest',status:'failed',stage:'failed',error_message:reason},
  {id:'ontology-cancelled',kind:'ontology_suggest',status:'cancelled',stage:'cancelled'},
  {id:'extract-retry',document_id:'doc',kind:'knowledge_extract',status:'failed',stage:'failed'}];
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'个人资料'}]}:name==='data.jobs'?{items:rows}:{nodes:[],edges:[]}, {}, {},{edition:'personal'});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});
 const html=view.render(),tasks=html.match(/<article class="data-task">[\s\S]*?<\/article>/g)||[];
 const failed=tasks.find(task=>task.includes(reason)),cancelled=tasks.find(task=>task.includes('本体建议')&&task.includes('已取消'));
 assert(failed);assert(cancelled);assert.match(failed,/本体建议/);assert.doesNotMatch(failed,/ontology_suggest/);
 for(const task of [failed,cancelled]){
  assert.doesNotMatch(task,/data-data-action="retry"/);
  assert.match(task,/原建议入口.*重新生成/);
  assert.match(task,/自动导入.*管理员/);
 }
 assert.match(html,/data-data-action="retry"[^>]*data-id="extract-retry"/);
});
test('batch publication retry uses only failed publication jobs and stops on account change',async()=>{
 const requests=[],rows=[{id:'publish-a',kind:'knowledge_publish',status:'failed'},{id:'extract-old',kind:'knowledge_extract',status:'failed',error_code:'STALE_EXTRACTION_GENERATION'},{id:'publish-b',kind:'knowledge_publish',status:'failed'},{id:'published',kind:'knowledge_publish',status:'succeeded'},{id:'scan',kind:'sensitive_scan',status:'failed'}];
 let view;view=make(async(name,input)=>{
  if(name==='data.warehouses')return {items:[{id:'w',name:'真实团队仓'}]};
  if(name==='data.jobs')return {items:rows};
  if(name==='data.retry-job'){requests.push([name,input]);view.sync({...state,account:{accountId:'other'}},true);return {}}return {};
 });
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});assert.doesNotMatch(view.render(),/data-id="extract-old"/);
 await view.action('retry-publications');assert.equal(requests.length,1);assert.equal(requests[0][1].warehouseId,'w');assert.equal(requests[0][1].id,'publish-a');assert.doesNotMatch(view.render(),/真实团队仓/);
});
test('batch publication retry submits each failed publication once without rerunning extraction',async()=>{
 const calls=[];let retried=false;
 const view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:[{id:'w',name:'仓'}]};if(name==='data.jobs')return {items:retried?[]:[{id:'p1',kind:'knowledge_publish',status:'failed'},{id:'p2',kind:'knowledge_publish',status:'failed'},{id:'extract',kind:'knowledge_extract',status:'failed'}]};if(name==='data.retry-job'&&input.id==='p2')retried=true;return {}});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});await view.action('retry-publications');
 assert.deepEqual(calls.filter(([n])=>n==='data.retry-job').map(([,v])=>v.id),['p1','p2']);assert.equal(calls.filter(([n])=>n.includes('reprocess')).length,0);
});
test('active processing refreshes progress and account reset clears the scheduled read',async()=>{
 let scheduled,cleared;const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'处理仓',active_jobs:1}]}:{nodes:[],edges:[]},{setTimeout:fn=>(scheduled=fn,42),clearTimeout:id=>{cleared=id}});
 view.sync(state,true);await view.refresh();assert.equal(typeof scheduled,'function');view.sync(state,false);assert.equal(cleared,42);await scheduled();assert.match(view.render(),/仅管理员/);
});
test('current-model recovery targets only the latest failed extraction for each material',async()=>{
 const rows=[{id:'old',document_id:'d1',kind:'knowledge_extract',created_at:'2026-10-22T10:00:00Z',status:'failed'},{id:'done',document_id:'d1',kind:'knowledge_extract',created_at:'2026-10-22T11:00:00Z',status:'succeeded'},{id:'todo',document_id:'d2',kind:'knowledge_extract',created_at:'2026-10-22T11:30:00Z',status:'failed'},{id:'stale',document_id:'d3',kind:'knowledge_extract',created_at:'2026-10-22T11:30:00Z',status:'failed',error_code:'STALE_EXTRACTION_GENERATION'}];
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'仓'}]}:name==='data.jobs'?{items:rows}:{});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});assert.match(view.render(),/用当前模型补处理（1）/);
});
test('recovery confirmation displays the effective server model and submits its exact signature and document version only after confirmation',async()=>{
 const calls=[],form={},submit={},dialog={dataset:{},showModal(){},close(){},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?submit:{}};
 const document={createElement:()=>dialog,body:{append(){}},querySelectorAll:()=>[]};
 const view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:[{id:'w',name:'仓'}]};if(name==='data.jobs')return {items:[{id:'j',document_id:'d',kind:'knowledge_extract',status:'failed'}]};if(name==='data.processing')return {effective:{signature:'a'.repeat(64),extraction:{name:'已确认的在线模型',location:'external'}}};if(name==='data.documents')return {items:[{id:'d',original_name:'真实材料',status:'ready',active_version_id:'v7'},{id:'unrelated',status:'ready',active_version_id:'v1'}]};return {}}, {}, document);
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});await view.action('reprocess-failed');assert.match(dialog.innerHTML,/已确认的在线模型/);assert.match(dialog.innerHTML,/正文片段将发送/);assert(!calls.some(([n])=>n==='data.reprocess-models'));
 await form.onsubmit({preventDefault(){},target:{}});const input=calls.find(([n])=>n==='data.reprocess-models')[1];assert.equal(input.expectedSignature,'a'.repeat(64));assert.equal(JSON.stringify(input.documents),JSON.stringify([{id:'d',version_id:'v7'}]));
});
test('single file reextraction submits the automatic pipeline with the current document version',async()=>{
 const calls=[],form={},submit={},dialog={dataset:{},showModal(){},close(){},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?submit:{}};
 const document={createElement:()=>dialog,body:{append(){}},querySelectorAll:()=>[]};
 const view=make(async(name,input)=>{
  calls.push([name,input]);
  if(name==='data.warehouses')return {items:[{id:'w',name:'warehouse'}]};
  if(name==='data.document')return {document:{id:'d',original_name:'file.pptx',status:'ready'},version:{id:'v7'}};
  if(name==='data.processing')return {effective:{signature:'signature',extraction:{name:'model'}}};
  return {items:[]};
 },{},document);
 view.sync(state,true);await view.refresh();
 await view.action('reextract-document',{id:'d',versionId:'old'});
 assert.equal(dialog.innerHTML,undefined);
 await view.action('reextract-document',{id:'d',versionId:'v7'});
 assert.match(dialog.innerHTML,/file.pptx/);
 assert(!calls.some(([n])=>n==='data.reprocess-models'));
 await form.onsubmit({preventDefault(){},target:{}});
 const input=calls.find(([n])=>n==='data.reprocess-models')[1];
 assert.equal(input.warehouseId,'w');assert.equal(input.documents[0].id,'d');assert.equal(input.documents[0].version_id,'v7');
 assert(!calls.some(([n])=>n==='data.open-starlink'));
});

test('embedded workspace has two primary views and opens the full version from More',async()=>{
 const calls=[],view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph')return realGraph;if(name==='data.authorization-summary')return {active_count:2,expired_count:0,revoked_count:0,rawToken:'never-render',prefix:'never-prefix'};if(name==='data.governance-summary')return {supported:true,review_count:0,paused_count:0};return {items:[]}});
 view.sync(state,true);await view.refresh();let html=view.render();
 const menu=html.match(/<details class="wanx-action-menu"[\s\S]*?<\/details>/)[0];
 assert.equal((html.match(/data-data-action="open"/g)||[]).length,1);assert.match(menu,/data-data-action="open"/);assert.match(menu,/data-data-action="refresh"/);
 const nav=html.match(/<nav class="data-tabs"[\s\S]*?<\/nav>/)[0];assert.equal((nav.match(/data-data-action="tab"/g)||[]).length,2);assert.match(nav,/知识图谱/);assert.match(nav,/资料/);
 assert.match(html,/STARLINK/);assert.match(html,/2 个有效授权/);assert.doesNotMatch(html,/never-render|never-prefix|share-create|data-mcp-footer|星图专业工具|WanX Starlink/);
 await view.action('select',{id:'w2',tab:'graph'});await view.action('open');assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['data.open-starlink',{warehouseId:'w2',view:'graph'}]));
});
test('late authorization summaries cannot fill another account',async()=>{
 let resolve;const view=make(async name=>{if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph')return realGraph;if(name==='data.authorization-summary')return new Promise(r=>resolve=r)});
 view.sync(state,true);const old=view.refresh();await new Promise(r=>setImmediate(r));view.sync({...state,account:{accountId:'new'}},true);resolve({active_count:98});await old;assert.doesNotMatch(view.render(),/98 个有效授权/);
});
test('legacy credential actions open the full version without creating or reading a Key in the embedded UI',async()=>{
 const calls=[],view=make(async(name,input)=>{calls.push([name,input]);return name==='data.warehouses'?{items:teamRows}:name==='data.graph'?realGraph:{}});
 view.sync(state,true);await view.refresh();calls.length=0;await view.action('share-create');assert.equal(JSON.stringify(calls),JSON.stringify([['data.open-starlink',{warehouseId:'w1',view:'api'}]]));
});

test('personal embedded page shows individual ownership in empty and loading states without company controls',async()=>{
 let resolve;const view=make(async()=>new Promise(r=>resolve=r),{}, {},{edition:'personal'});
 view.sync(state,true);const pending=view.refresh();
 assert.match(view.render(),/正在读取当前个人的数据/);assert.doesNotMatch(view.render(),/\$\{owner\}|助理授权|团队管理员共同维护/);
 resolve({items:[]});await pending;
 assert.match(view.render(),/个人数据仓/);assert.match(view.render(),/仅当前账号可见/);
});

for(const edition of ['personal','team']){
 function refreshFixture(){
  let hold='',release,reject,completed=3,nextTimer=0;
  const frames=[],timers=new Map();
  const rows=[{id:'w1',name:'当前资料库',state:'active',active_jobs:1},{id:'w2',name:'其他资料库',state:'active'}];
  const reply=(name,input)=>name==='data.warehouses'?{items:rows}:name==='data.jobs'?{items:[{id:'job',document_name:'已导入材料.md',kind:'document_parse',status:'running',stage:'accepted',completed_units:completed,total_units:10}]}:name==='data.authorization-summary'?{active_count:input.warehouseId==='w1'?1:2,expired_count:0,revoked_count:0}:{items:[],nodes:[],edges:[]};
  const view=make(async(name,input)=>{
   if(name===hold){hold='';return new Promise((resolve,fail)=>{release=()=>resolve(reply(name,input));reject=fail})}
   return reply(name,input);
  },{setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id},clearTimeout:id=>timers.delete(id)}, {},{edition,changed:()=>frames.push(view.render())});
  return{view,frames,timers,async ready(){view.sync(state,true);await view.refresh();await view.action('select',{id:'w1',tab:'tasks'});frames.length=0},hold:name=>{hold=name},release:()=>release(),reject:error=>reject(error),progress:value=>{completed=value}};
 }

 test(`${edition}: background reads keep tasks and authorization summary in place without a full-page loading row`,async()=>{
  const f=refreshFixture();await f.ready();
  f.hold('data.warehouses');const pending=f.view.refresh();
  assert.equal(f.frames.length,0,'fast background reads must not rebuild the page at their start');
  const during=f.view.render();
  assert.doesNotMatch(during,/class="data-loading"/);
  assert.match(during,/已导入材料.md/);assert.match(during,/1 个有效授权/);
  assert.match(during,/data-sync-status/);
  f.progress(4);f.release();await pending;
  assert.match(f.view.render(),/4\/10/);assert.match(f.view.render(),/1 个有效授权/);
  assert.equal(f.frames.length,1);
 });

 test(`${edition}: only slow background reads show the reserved header indicator`,async()=>{
  const f=refreshFixture();await f.ready();f.hold('data.jobs');const pending=f.view.refresh();
  await new Promise(r=>setImmediate(r));
  const indicator=[...f.timers.values()].find(t=>t.delay>=200&&t.delay<1000);
  assert(indicator,'a delayed inline indicator is scheduled separately from task polling');
  indicator.fn();
  assert.match(f.view.render(),/data-sync-status[^>]*data-state="refreshing"/);
  assert.doesNotMatch(f.view.render(),/class="data-loading"/);
  assert.match(f.view.render(),/已导入材料.md/);
  f.release();await pending;
  assert.match(f.view.render(),/data-sync-status[^>]*data-state="ready"/);
 });

 test(`${edition}: changing tabs retains same-warehouse authorization summary but changing warehouses clears it`,async()=>{
  const f=refreshFixture();await f.ready();
  f.hold('data.authorization-summary');const tab=f.view.action('tab',{tab:'materials'});await new Promise(r=>setImmediate(r));
  assert.match(f.view.render(),/1 个有效授权/);assert.doesNotMatch(f.view.render(),/正在读取授权摘要/);
  f.release();await tab;
  f.hold('data.authorization-summary');const warehouse=f.view.action('select',{id:'w2'});await new Promise(r=>setImmediate(r));
  assert.doesNotMatch(f.view.render(),/1 个有效授权/);f.release();await warehouse;
  assert.match(f.view.render(),/2 个有效授权/);
 });

 test(`${edition}: transient background errors retain content and offer inline retry; expired sessions clear it`,async()=>{
  const f=refreshFixture();await f.ready();f.hold('data.warehouses');let pending=f.view.refresh();
  f.reject(Error('SEMANTICA_SERVICE_UNAVAILABLE'));await pending;
  assert.match(f.view.render(),/已导入材料.md/);assert.match(f.view.render(),/1 个有效授权/);
  assert.match(f.view.render(),/data-sync-status[^>]*data-state="error"/);
  assert.match(f.view.render(),/data-data-action="refresh"/);
  assert.doesNotMatch(f.view.render(),/class="data-error"/);
  f.hold('data.warehouses');pending=f.view.refresh();f.reject(Error('TEAM_SESSION_CHANGED'));await pending;
  assert.doesNotMatch(f.view.render(),/已导入材料.md|w1-key/);
 });

 test(`${edition}: an empty completed tab keeps its empty-state content while refreshing`,async()=>{
  let release,held=false;
  const view=make(async name=>name==='data.warehouses'?(held?new Promise(r=>release=r):{items:[{id:'w',name:'空仓',state:'active'}]}):{items:[],nodes:[],edges:[]}, {}, {},{edition});
  view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});
  assert.match(view.render(),/暂无处理任务/);held=true;const pending=view.refresh();
  assert.match(view.render(),/暂无处理任务/);release({items:[{id:'w',name:'空仓',state:'active'}]});await pending;
 });

 test(`${edition}: background updates keep the evidence-search empty state and do not impersonate a search`,async()=>{
  const f=refreshFixture();await f.ready();await f.view.action('tab',{tab:'search'});
  f.hold('data.warehouses');const pending=f.view.refresh();
  [...f.timers.values()].find(t=>t.delay>=200&&t.delay<1000).fn();
  assert.match(f.view.render(),/带着具体问题查找/);assert.doesNotMatch(f.view.render(),/检索中/);
  f.release();await pending;
 });

 for(const first of ['refresh','search'])test(`${edition}: concurrent evidence search and refresh keep independent progress when ${first} completes first`,async()=>{
  let held=false,releaseRefresh,releaseSearch;
  const row={id:'w',name:'当前资料库',state:'active'};
  const view=make(async name=>{
   if(name==='data.warehouses')return held?new Promise(r=>releaseRefresh=()=>r({items:[row]})):{items:[row]};
   if(name==='data.search')return new Promise(r=>releaseSearch=()=>r({items:[{document_id:'doc',document_name:'检索结果',text:'合成证据'}]}));
   if(name==='data.authorization-summary')return {hostBase:'/api/semantica/open/v1',keys:[]};
   return {items:[],nodes:[],edges:[]};
  }, {}, {},{edition});
  view.sync(state,true);await view.refresh();await view.action('select',{id:'w'});await view.action('tab',{tab:'search'});
  held=true;const refresh=view.refresh(),search=view.submit('search',{get:()=> '合成问题'});
  if(first==='refresh'){
   releaseRefresh();await refresh;
   assert.match(view.render(),/aria-busy="true"/);assert.match(view.render(),/检索中/);assert.doesNotMatch(view.render(),/未找到可交付的证据/);
   releaseSearch();await search;
  }else{
   releaseSearch();await search;
   assert.match(view.render(),/aria-busy="true"/);assert.match(view.render(),/合成证据/);
   releaseRefresh();await refresh;
  }
  assert.match(view.render(),/合成证据/);assert.match(view.render(),/aria-busy="false"/);
 });

 test(`${edition}: temporary authorization summary failure preserves the summary as stale; access denial clears it`,async()=>{
  const f=refreshFixture();await f.ready();f.hold('data.authorization-summary');let pending=f.view.refresh();await new Promise(r=>setImmediate(r));
  f.reject(Error('SEMANTICA_SERVICE_UNAVAILABLE'));await pending;
  assert.match(f.view.render(),/1 个有效授权/);assert.match(f.view.render(),/待更新/);
  f.hold('data.authorization-summary');pending=f.view.refresh();await new Promise(r=>setImmediate(r));
  f.reject(Error('SEMANTICA_RESOURCE_FORBIDDEN'));await pending;
  assert.doesNotMatch(f.view.render(),/w1-key|已导入材料.md/);
 });

 test(`${edition}: access denial during background refresh invalidates a concurrent late evidence result`,async()=>{
  let held=false,rejectRefresh,releaseSearch;
  const view=make(async name=>{
   if(name==='data.warehouses')return held?new Promise((_,reject)=>rejectRefresh=reject):{items:[{id:'w',name:'当前资料库',state:'active'}]};
   if(name==='data.search')return new Promise(r=>releaseSearch=()=>r({items:[{document_id:'private',text:'不应回填的证据'}]}));
   if(name==='data.authorization-summary')return {hostBase:'/api/semantica/open/v1',keys:[]};
   return {items:[],nodes:[],edges:[]};
  }, {}, {},{edition});
  view.sync(state,true);await view.refresh();await view.action('select',{id:'w'});await view.action('tab',{tab:'search'});
  held=true;const refresh=view.refresh(),search=view.submit('search',{get:()=> '问题'});
  rejectRefresh(Error('SEMANTICA_RESOURCE_FORBIDDEN'));await refresh;releaseSearch();await search;
  assert.doesNotMatch(view.render(),/不应回填的证据|当前资料库/);
 });
}

function modalFixture(){
 const dialogs=[];
 const document={querySelectorAll:()=>[],body:{append(){}},createElement:()=>{
  const form={},submit={},status={};const d={dataset:{},isConnected:true,showModal(){},close(){this.isConnected=false;this.onclose?.()},remove(){},addEventListener(){},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?submit:status};dialogs.push(d);return d;
 }};
 return {document,dialogs,submit(values={}){return dialogs.at(-1).querySelector('form').onsubmit({preventDefault(){},target:values})}};
}
function actualFixture(extra=()=>({}),document={}){
 const calls=[];const view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:[{id:'w1',name:'学院资料',document_count:2,entity_count:2,relation_count:1}]};if(name==='data.graph')return realGraph;if(name==='data.authorization-summary')return {active_count:2};if(name==='data.governance-summary')return {supported:true,review_count:1,paused_count:1};return extra(name,input)}, {},document);view.sync(state,true);return {view,calls};
}
test('review availability is honest and unavailable governance never masquerades as zero pending',async()=>{
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w1',name:'学院资料'}]}:name==='data.graph'?realGraph:{});view.sync(state,true);await view.refresh();const html=view.render();assert.doesNotMatch(html,/data-data-action="reviews"/);assert.doesNotMatch(html,/待确认 0/);await view.action('reviews');assert.match(view.render(),/需要升级/);assert.doesNotMatch(view.render(),/没有待确认事项/);
});
test('real pending counts and paused work come from the warehouse governance summary',async()=>{
 const {view}=actualFixture();await view.refresh();assert.doesNotMatch(view.render(),/data-data-action="reviews"|>上传资料<|data-lite-review-metric/);assert.match(view.render(),/1 项整理正在等待核对/);assert.doesNotMatch(view.render(),/模拟|演示资料|自动补全结论。已完成/);
});

for(const edition of ['personal','team'])test(`${edition}: More opens full Starlink in the selected warehouse and material view`,async()=>{
 const calls=[],menu={open:true,contains:()=>false};
 const view=make(async(name,input)=>{
  calls.push([name,input]);
  if(name==='data.warehouses')return {items:[{id:'w1',name:'仓库'}]};
  if(name==='data.graph')return {nodes:[],edges:[]};
  return {items:[]};
 },{},{querySelector:()=>menu,querySelectorAll:()=>[]},{edition});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w1'});
 assert.match(view.render(),/data-data-action="open"[^>]*data-view="materials"[^>]*data-warehouse-id="w1"[^>]*>打开完整版<\/button>/);
 await view.action('open',{warehouseId:'w1',view:'materials'});
 assert.equal(menu.open,false);
 assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['data.open-starlink',{warehouseId:'w1',view:'materials'}]);
});
test('a knowledge flag persists only after reason confirmation and uses revision zero on the first flag',async()=>{
 const modal=modalFixture(),{view,calls}=actualFixture(name=>name==='data.governance-reviews'?{items:[],total:0}:{id:'review'},modal.document);await view.refresh();await view.action('node',{id:'team'});assert.match(view.render(),/这条知识有问题/);await view.action('flag',{kind:'entity',id:'team'});assert.equal(calls.filter(([n])=>n==='data.governance-flag').length,0);await modal.submit({reason:'同名人员需要核对'});const input=calls.find(([n])=>n==='data.governance-flag')[1];assert.equal(input.expectedRevision,0);assert.equal(input.warehouseId,'w1');assert.equal(input.targetId,'team');assert.equal(input.reason,'同名人员需要核对');assert.match(input.operationId,/^[0-9a-f-]{36}$/i);
});
test('a failed governance write stays unconfirmed and retry reuses its operation ID',async()=>{
 const modal=modalFixture();let attempts=0;const {view,calls}=actualFixture(name=>{if(name==='data.governance-flag'){if(++attempts===1)throw Error('SEMANTICA_SERVICE_UNAVAILABLE');return{id:'review'}}if(name==='data.governance-reviews')return{items:[],total:0};return{}},modal.document);await view.refresh();await view.action('flag',{kind:'relation',id:'fact'});await modal.submit({reason:'依据不明确'});assert.match(view.render(),/操作结果尚未确认/);await view.action('governance-retry');const writes=calls.filter(([n])=>n==='data.governance-flag');assert.equal(writes.length,2);assert.equal(writes[0][1].operationId,writes[1][1].operationId);assert.doesNotMatch(view.render(),/操作结果尚未确认/);
});
test('AI suggestions remain proposals and require a separate apply confirmation with the actual revision',async()=>{
 const modal=modalFixture();const record={id:'r1',kind:'evidence',title:'证据不足',description:'讲师身份尚未确认',revision:4,status:'pending',evidence:[{document_id:'d',document_version_id:'v7',excerpt:'原文只提到同名人员'}],actions:[{id:'keep_pending',label:'保留待核对'}]};const {view,calls}=actualFixture(name=>name==='data.governance-detail'?record:name==='data.governance-propose'?{id:'p1',review_id:'r1',revision:5,status:'ready',before:{role:'讲师'},after:{role:'待确认'},evidence:[{document_id:'d',document_version_id:'v7',excerpt:'建议依照的证据'}]}:name==='data.governance-reviews'?{items:[],total:0}:{},modal.document);await view.refresh();await view.action('review-detail',{id:'r1'});assert.match(view.render(),/讲师身份尚未确认/);await view.action('review-propose');await modal.submit({reason:'不要从同名推断角色'});assert.match(view.render(),/建议修改 · 尚未应用/);assert.equal(calls.filter(([n])=>n==='data.governance-apply').length,0);assert.equal(calls.find(([n])=>n==='data.governance-propose')[1].expectedRevision,4);await view.action('review-apply');assert.equal(calls.filter(([n])=>n==='data.governance-apply').length,0);await modal.submit();const applied=calls.find(([n])=>n==='data.governance-apply')[1];assert.equal(applied.proposalId,'p1');assert.equal(applied.expectedRevision,5);assert.equal(applied.confirmed,true);
});
test('evidence source checks the requested version before showing any historical text',async()=>{
 const {view,calls}=actualFixture(name=>name==='data.document'?{document:{original_name:'学院原文',active_version_id:'v9'},version:{id:'v9'},segments:[{text:'当前已修改正文'}]}:name==='data.document-text'?{version_id:'v7',text:'证据固定版本原文'}:{});await view.refresh();await view.action('source',{id:'d',warehouseId:'w1',versionId:'v7'});assert.match(view.render(),/固定版本原文/);assert.match(view.render(),/证据固定版本原文/);assert.doesNotMatch(view.render(),/当前已修改正文/);const text=calls.find(([n])=>n==='data.document-text')[1];assert.equal(text.versionId,'v7');assert.equal(text.start,0);assert.equal('end' in text,false);
});
test('mismatched source versions and late review results cannot enter the current warehouse',async()=>{
 let resolve;const {view}=actualFixture(name=>name==='data.document'?{segments:[{text:'不可当成旧版本'}]}:name==='data.document-text'?{version_id:'v9',text:'错误版本正文'}:name==='data.governance-detail'?new Promise(r=>resolve=r):{});await view.refresh();await view.action('source',{id:'d',versionId:'v7'});assert.match(view.render(),/来源版本未能验证/);assert.doesNotMatch(view.render(),/错误版本正文|不可当成旧版本/);const pending=view.action('review-detail',{id:'r'});await new Promise(r=>setImmediate(r));view.sync({...state,account:{accountId:'other'}},true);resolve({id:'r',title:'旧账号身份事项',actions:[],evidence:[]});await pending;assert.doesNotMatch(view.render(),/旧账号身份事项/);
});

test('insufficient AI evidence remains pending and cannot be applied even through a direct UI action',async()=>{
 const modal=modalFixture();const record={id:'r1',kind:'identity',title:'同名身份不明确',revision:3,evidence:[],actions:[{id:'keep_pending',label:'保留待核对'}]};const {view,calls}=actualFixture(name=>name==='data.governance-detail'?record:name==='data.governance-propose'?{id:'p',review_id:'r1',revision:1,status:'insufficient',description:'没有支持同一身份的来源',before:{},after:null,evidence:[],model:'真实配置模型'}:{},modal.document);await view.refresh();await view.action('review-detail',{id:'r1'});await view.action('review-propose');await modal.submit({reason:'核对讲师与学员是否同一人'});assert.match(view.render(),/依据不足 · 继续待核对/);assert.match(view.render(),/没有支持同一身份的来源/);assert.match(view.render(),/真实配置模型/);assert.doesNotMatch(view.render(),/data-data-action="review-apply"/);await view.action('review-apply');assert.equal(calls.filter(([n])=>n==='data.governance-apply').length,0);
});
test('paused owner knowledge is visibly marked and opens its actual governance review instead of making another flag',async()=>{
 const graph={nodes:realGraph.nodes.map(n=>({...n,paused:n.id==='team',governance_review_id:n.id==='team'?'review-existing':null,governance_revision:2})),edges:realGraph.edges.map(e=>({...e,paused:true,governance_review_id:'review-existing'}))};const calls=[],view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph')return graph;if(name==='data.governance-summary')return {supported:true,review_count:1,paused_count:1};return {}});view.sync(state,true);await view.refresh();await view.action('node',{id:'team'});const html=view.render();assert.match(html,/is-paused/);assert.match(html,/已暂停此知识及其依赖关系对外使用/);assert.match(html,/data-data-action="review-detail" data-id="review-existing"/);assert.doesNotMatch(html,/data-data-action="flag"/);
});
test('unflag confirmation uses the server review revision and the explicit unflag endpoint',async()=>{
 const modal=modalFixture();const record={id:'r',kind:'entity',title:'原反馈',revision:7,evidence:[],actions:[{id:'unflag',label:'撤回反馈'}]};const {view,calls}=actualFixture(name=>name==='data.governance-detail'?record:name==='data.governance-reviews'?{items:[],total:0}:{},modal.document);await view.refresh();await view.action('review-detail',{id:'r'});await view.action('review-resolve',{actionId:'unflag'});assert.match(modal.dialogs.at(-1).innerHTML,/重新核验/);assert.equal(calls.filter(([n])=>n==='data.governance-unflag').length,0);await modal.submit();const input=calls.find(([n])=>n==='data.governance-unflag')[1];assert.equal(input.expectedRevision,7);assert.equal(input.reviewId,'r');assert.equal('reason' in input,false);assert.equal(calls.filter(([n])=>n==='data.governance-resolve').length,0);
});

test('short fixed-version text uses the backend bounded range instead of requesting beyond the file',async()=>{
 const {view,calls}=actualFixture((name,input)=>name==='data.document'?{document:{id:'d',original_name:'短资料'},version:{id:'v7'},segments:[]}:name==='data.document-text'?{document_id:'d',version_id:'v7',hash:'digest',text:'短文',start:0,end:2,total_chars:2,locators:[]}:{});await view.refresh();await view.action('source',{id:'d',versionId:'v7'});const html=view.render();assert.match(html,/固定版本原文/);assert.match(html,/正文范围 0–2 \/ 2 字/);assert.match(html,/短文/);assert.doesNotMatch(html,/继续读取正文/);assert.equal('end' in calls.find(([n])=>n==='data.document-text')[1],false);
});

test('a source read rejection from an old account cannot replace the new account status',async()=>{
 let reject;const {view}=actualFixture(name=>name==='data.document'?new Promise((_,fail)=>reject=fail):{});await view.refresh();const old=view.action('source',{id:'d',versionId:'v7'});await new Promise(r=>setImmediate(r));view.sync({...state,account:{accountId:'new'}},true);reject(Error('SEMANTICA_SERVICE_UNAVAILABLE'));await old;assert.doesNotMatch(view.render(),/暂时不可用|data-lite-inspector/);
});
test('governance pagination requests the actual next bounded page in the same warehouse',async()=>{
 const {view,calls}=actualFixture((name,input)=>name==='data.governance-reviews'?{items:[{id:'r'+input.offset,title:'真实队列页 '+input.offset}],total:101}:{});await view.refresh();await view.action('reviews');assert.match(view.render(),/1–1 \/ 101/);await view.action('reviews-page',{offset:'50'});assert.match(view.render(),/真实队列页 50/);const pages=calls.filter(([n])=>n==='data.governance-reviews');assert.equal(pages.at(-1)[1].offset,50);assert.equal(pages.at(-1)[1].limit,50);assert.equal(pages.at(-1)[1].warehouseId,'w1');
});

test('same-warehouse source selections retain the newest response and ignore a late earlier rejection',async()=>{
 let releaseA,rejectC;const {view}=actualFixture((name,input)=>{if(name==='data.document'){if(input.id==='a')return new Promise(r=>releaseA=r);if(input.id==='c')return new Promise((_,r)=>rejectC=r);return {document:{original_name:'最新选择B'},segments:[{text:'B的正文'}]}}return{}});await view.refresh();const a=view.action('source',{id:'a'});await view.action('source',{id:'b'});releaseA({document:{original_name:'旧选择A'},segments:[{text:'A的旧正文'}]});await a;assert.match(view.render(),/最新选择B/);assert.doesNotMatch(view.render(),/旧选择A|A的旧正文/);const c=view.action('source',{id:'c'});await view.action('source',{id:'b'});rejectC(Error('SEMANTICA_SERVICE_UNAVAILABLE'));await c;assert.match(view.render(),/最新选择B/);assert.doesNotMatch(view.render(),/暂时不可用/);
});
test('same-warehouse review selections and closing the inspector invalidate earlier detail reads',async()=>{
 let releaseA,releaseC;const {view}=actualFixture((name,input)=>{if(name==='data.governance-detail'){if(input.reviewId==='a')return new Promise(r=>releaseA=r);if(input.reviewId==='c')return new Promise(r=>releaseC=r);return{id:'b',title:'当前事项B',actions:[],evidence:[]}}return{}});await view.refresh();const a=view.action('review-detail',{id:'a'});await view.action('review-detail',{id:'b'});releaseA({id:'a',title:'旧事项A',actions:[],evidence:[]});await a;assert.match(view.render(),/当前事项B/);assert.doesNotMatch(view.render(),/旧事项A/);const c=view.action('review-detail',{id:'c'});await view.action('close-panel');releaseC({id:'c',title:'已关闭事项C',actions:[],evidence:[]});await c;assert.doesNotMatch(view.render(),/data-lite-inspector|已关闭事项C/);
});
test('a running proposal locks its review selection and a response must bind the original review ID',async()=>{
 const modal=modalFixture();let release;const {view,calls}=actualFixture((name,input)=>name==='data.governance-detail'?{id:input.reviewId,title:'事项'+input.reviewId,revision:2,actions:[],evidence:[]}:name==='data.governance-propose'?new Promise(r=>release=r):{},modal.document);await view.refresh();await view.action('review-detail',{id:'a'});await view.action('review-propose');const pending=modal.submit({reason:'按原文核对'});await new Promise(r=>setImmediate(r));await view.action('review-detail',{id:'b'});await view.action('close-panel');assert.equal(calls.filter(([n])=>n==='data.governance-detail').length,1);assert.match(view.render(),/事项a/);release({id:'proposal-a',review_id:'wrong-review',revision:1,status:'ready',before:{},after:{},evidence:[]});await pending;assert.doesNotMatch(view.render(),/data-data-action="review-apply"/);assert.equal(calls.filter(([n])=>n==='data.governance-apply').length,0);await view.action('flag',{kind:'entity',id:'new-target'});assert.equal(calls.filter(([n])=>n==='data.governance-flag').length,0);assert.match(view.render(),/上一项操作的结果尚未确认/);
});
test('proposal completion after a warehouse-context change cannot attach to the new review',async()=>{
 const modal=modalFixture();let release;const {view}=actualFixture((name,input)=>name==='data.governance-detail'?{id:input.reviewId,title:'事项'+input.reviewId,revision:2,actions:[],evidence:[]}:name==='data.governance-propose'?new Promise(r=>release=r):{},modal.document);await view.refresh();await view.action('review-detail',{id:'a'});await view.action('review-propose');const pending=modal.submit({reason:'按原文核对'});await new Promise(r=>setImmediate(r));await view.action('select',{id:'w1',tab:'graph'});await view.action('review-detail',{id:'b'});release({id:'proposal-a',review_id:'a',revision:1,status:'ready',before:{},after:{},evidence:[]});await pending;assert.match(view.render(),/事项b/);assert.doesNotMatch(view.render(),/proposal-a|建议修改 · 尚未应用|data-data-action="review-apply"/);
});
test('team assistant access is kept inside More with the current warehouse while personal never exposes it',async()=>{
 for(const edition of ['team','personal']){
  const view=make(async name=>name==='data.warehouses'?{items:teamRows}:name==='data.graph'?realGraph:{}, {},{}, {edition});view.sync(state,true);await view.refresh();const html=view.render();const menu=html.match(/<details class="wanx-action-menu"[\s\S]*?<\/details>/)[0];if(edition==='team'){assert.match(menu,/data-data-action="assistant-access" data-warehouse-id="w1"/);assert.equal((html.match(/data-data-action="assistant-access"/g)||[]).length,1)}else{assert.doesNotMatch(html,/assistant-access/);assert.match(html,/wanx-section-banner/);assert.match(html,/data-section="starlink"/);assert.match(html,/wanx-section-english">STARLINK/)}
 }
});

test('personal search renders source-label document references and opens their real pinned version',async()=>{
 const calls=[],annotation={tags:['橙色<松鼠>'],description:'说明<script>',revision:3,provenance:[{tag:'橙色<松鼠>',source:'inherited',itemId:'folder-source'}]};
 const view=make(async(name,input)=>{
  calls.push([name,input]);
  if(name==='data.warehouses')return {items:[{id:'w',name:'测试仓'}]};
  if(name==='data.warehouse')return {id:'w'};
  if(name==='data.search')return {items:[],annotationDocuments:[{documentId:'real-document',versionId:'real-version',title:'真实来源',text:'合成原始正文',folderPath:'教务 / <春季>',annotation}],annotationSearch:{incomplete:true}};
  if(name==='data.document')return {document:{id:input.id,original_name:'真实来源',active_version_id:'real-version'},version:{id:'real-version'},segments:[{text:'合成原始正文'}],sourceAnnotation:{snapshot:{...annotation,tags:['导入时标签']},current:annotation,needsRefresh:true,folderPath:'教务 / <春季>'}};
  if(name==='data.document-text')return {version_id:input.versionId,text:'合成原始正文'};
  return {items:[],nodes:[],edges:[]};
 },{},{},{edition:'personal'});
 view.sync(state,true);await view.refresh();await view.action('tab',{tab:'search'});await view.submit('search',{get:()=> '橙色松鼠'});
 let html=view.render();assert.match(html,/空间标签命中 · 文档引用/);assert.match(html,/空间目录 · 教务 \/ &lt;春季&gt;/);assert.doesNotMatch(html,/合成原始正文/);assert.match(html,/打开来源查看对应版本/);assert.match(html,/橙色&lt;松鼠&gt;/);assert.match(html,/部分空间标签索引尚未核验/);
 assert.match(html,/data-id="real-document" data-version-id="real-version"/);
 await view.action('source',{id:'real-document',versionId:'real-version'});html=view.render();
 assert.match(html,/合成原始正文/);assert.match(html,/空间标签与说明 · 需核对/);assert.match(html,/空间目录 · 教务 \/ &lt;春季&gt;/);assert.match(html,/导入时快照/);assert.match(html,/导入时标签/);assert.match(html,/当前空间标注/);assert.match(html,/文件夹继承 · 来源 folder-source/);assert.match(html,/说明&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal(calls.find(([name])=>name==='data.document-text')[1].versionId,'real-version');
});

test('team search ignores personal annotation-only responses',async()=>{
 const view=make(async(name,input)=>name==='data.warehouses'?{items:[{id:'w',name:'团队仓'}]}:name==='data.warehouse'?{id:input.id}:name==='data.search'?{items:[],annotationDocuments:[{documentId:'private',title:'个人标签来源',text:'不应出现在团队'}],annotationSearch:{incomplete:true}}:{items:[],nodes:[],edges:[]});
 view.sync(state,true);await view.refresh();await view.action('tab',{tab:'search'});await view.submit('search',{get:()=> '关键词'});
 assert.doesNotMatch(view.render(),/个人标签来源|不应出现在团队|空间标签命中|空间标签索引尚未核验/);
});

test('spreadsheet search shows the cited rows and opens the pinned character offset', async () => {
  const calls=[];
  const view=make(async(name,input)=>{
    calls.push([name,input]);
    if(name==='data.warehouses')return {items:[{id:'w',name:'合成测试仓'}]};
    if(name==='data.warehouse')return {id:'w'};
    if(name==='data.search')return {items:[{
      document_id:'sheet',document_version_id:'v2',original_name:'教务排期.xlsx',text:'六月十二日',
      locator:{source_segments:[{canonical_start:42,locator:{sheet:'排期',row:2}},
        {canonical_start:49,locator:{sheet:'排期',row:3}}]},
    }]};
    if(name==='data.document')return {document:{id:input.id,original_name:'教务排期.xlsx'},version:{id:'v3'},segments:[]};
    if(name==='data.document-text')return {version_id:input.versionId,text:'六月十二日',start:42,end:47,total_chars:47};
    return {items:[],nodes:[],edges:[]};
  },{},{},{edition:'personal'});
  view.sync(state,true);
  await view.refresh();
  await view.action('tab',{tab:'search'});
  await view.submit('search',{get:()=> '交付'});
  const label='工作表 排期 · 第 2–3 行';
  assert.ok(view.render().includes(`data-location="${label}" data-start="42"`));
  await view.action('source',{id:'sheet',versionId:'v2',start:'42',location:label});
  assert.ok(view.render().includes('引用位置 · '+label));
  const [,input]=calls.find(([name])=>name==='data.document-text');
  assert.equal(input.versionId,'v2');
  assert.equal(input.start,42);
});

test('committed imports expose pending labels and finish durable receipts after reopening without reuploading',async()=>{
 const dialogs=[],calls=[],uploads=[];let pending=true;
 const document={querySelectorAll:()=>[],body:{append(){}},createElement:()=>{
  const form={},submit={},status={},alert={},listeners={};
  const d={dataset:{},isConnected:true,showModal(){},close(){this.isConnected=false;this.onclose?.();listeners.close?.()},remove(){},
   addEventListener(name,fn){listeners[name]=fn},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?submit:s==='.data-upload-state'?status:alert};
  dialogs.push(d);return d;
 }};
 const view=make(async(name,input)=>{
  calls.push([name,input]);
  if(name==='data.warehouses')return {items:[{id:'w',name:'测试仓'}]};
  if(name==='data.warehouse')return {id:'w'};
  if(name==='data.select-files')return [{handle:'saved',name:'已完成.txt',size:20},{handle:'pending',name:'待索引.txt',size:20}];
  if(name==='data.upload'){uploads.push(input.handle);return {document:{id:'doc-'+input.handle},annotationIndex:{status:pending&&input.handle==='pending'?'pending':'saved'}}}
  if(name==='data.document')return {document:{id:input.id},annotationIndex:{status:pending?'pending':'saved'}};
  return {items:[],nodes:[],edges:[]};
 },{},document,{edition:'personal'});
 const submit=()=>dialogs.at(-1).querySelector('form').onsubmit({preventDefault(){},target:{confirmed:'on'}});
 view.sync(state,true);await view.refresh();await view.action('import-local');await submit();
 assert.deepEqual(uploads,['saved','pending']);assert.match(dialogs.at(-1).querySelector('.data-upload-state').textContent,/资料已导入；标签索引待完成：待索引.txt/);
 assert.equal(dialogs.at(-1).isConnected,true);assert.equal(dialogs.at(-1).querySelector('[type=submit]').textContent,'重试标签索引');
 dialogs.at(-1).close();await new Promise(r=>setImmediate(r));
 assert.deepEqual(Array.from(calls.find(([name])=>name==='data.release-files')[1].handles),['saved']);
 assert.match(view.render(),/1 份资料已导入，空间标签索引待完成/);
 await view.action('retry-annotation-imports');pending=false;await submit();
 assert.deepEqual(uploads,['saved','pending']);assert.equal(calls.filter(([name])=>name==='data.select-files').length,1);
 assert.equal(calls.find(([name])=>name==='data.document')[1].id,'doc-pending');
 assert.doesNotMatch(view.render(),/份资料已导入，空间标签索引待完成/);
});
