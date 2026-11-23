import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {editablePackage,createPersonalWorkshop} from '../integration/personal-client/workshop-service.mjs';

test('personal delivery waits for deployment capability, backs off and resumes polling', {timeout:10000}, async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'workshop-poll-'));
 const calls=[];
 let now=0,available=false,received;
 const firstList=new Promise(resolve=>{received=resolve});
 t.mock.timers.enable({apis:['setInterval']});
 t.mock.method(performance,'now',()=>now);
 const link={context:()=>({boxId:'box'}),close(){},async request({path:route}){
  const action=route.split('/').at(-1);calls.push(action);
  if(action==='client-deliveries')received();
  return{status:200,body:JSON.stringify(action==='capabilities'
    ?{schemaVersion:1,available,operations:available?['deploy']:[]}:{items:[]})};
 }};
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box'}}),
  subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{installDeployment(){}},
  nativeFoundation:{root:path.join(root,'foundation')},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}}});
 const advance=async()=>{now+=2500;t.mock.timers.tick(2500);await new Promise(resolve=>setImmediate(resolve))};
 try{
  await advance();await advance();
  assert.deepEqual(calls,['capabilities']);
  available=true;
  await advance();await firstList;
  assert.deepEqual(calls,['capabilities','capabilities','client-deliveries']);
 }finally{service.close();await rm(root,{recursive:true,force:true})}
});

test('the actual Workshop 404 settles into an upgrade error under renderer sync reentry, with one explicit retry',async()=>{
 const source=await readFile(new URL('../integration/personal-client/workshop.js',import.meta.url),'utf8');
 let calls=0,available=false,view,html='';
 const link={context:()=>({}),close(){},async request(input){
  assert.equal(input.path,'/api/_client/workshop/_management/projects');calls++;
  if(available)return{status:200,body:JSON.stringify({projects:[]})};
  if(calls===1)return{status:404,body:JSON.stringify({detail:'Not Found'})};
  return new Promise(()=>{});
 }};
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}}});
 const window={createStudioProduct:()=>({sync(){},reset(){},pause(){},render:()=>'',mounted(){}})};
 vm.runInNewContext(source,{window,crypto:{randomUUID:()=> 'stable-op'}});
 view=window.createWanxWorkshop({request:(action,input)=>service.action(action,input),changed(){view.sync('alice-box',true,true);html=view.render()}});
 try{
  view.sync('alice-box',true,true);await new Promise(r=>setImmediate(r));
  assert.match(html,/万象工坊 <span class="feature-beta">Beta<\/span>/);
  assert.doesNotMatch(html,/academy-copilot-toggle/);
  assert.equal(calls,1,'a failed automatic read must not restart whenever the renderer syncs');
  assert.match(html,/当前盒端尚未提供工坊服务/);assert.doesNotMatch(html,/正在读取…/);
  for(let i=0;i<3;i++)view.sync('alice-box',true,true);
  assert.equal(calls,1);
  available=true;await view.action('workshop-refresh');
  assert.equal(calls,2);assert.doesNotMatch(view.render(),/当前盒端尚未提供工坊服务|正在读取…/);
 }finally{service.close()}
});

test('Workshop read failure waits for manual retry but a fresh connection can read once again',async()=>{
 const source=await readFile(new URL('../integration/personal-client/workshop.js',import.meta.url),'utf8');
 let calls=0,online=true,view;
 const window={createStudioProduct:()=>({sync(){},reset(){},pause(){},render:()=>'',mounted(){}})};
 vm.runInNewContext(source,{window,crypto:{randomUUID:()=> 'stable-op'}});
 view=window.createWanxWorkshop({request:async()=>{calls++;if(calls===1)throw Error('TRANSPORT_FAILED');return{items:[]}},changed(){view.sync('alice-box',online,true)}});
 view.sync('alice-box',online,true);await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);assert.match(view.render(),/操作未完成/);
 online=false;view.sync('alice-box',online,true);online=true;view.sync('alice-box',online,true);await new Promise(r=>setImmediate(r));
 assert.equal(calls,2);assert.doesNotMatch(view.render(),/操作未完成|正在读取…/);
});

test('the real Workshop bridge carries management revisions and routes archive/restore to the box',async()=>{
 const projectId='a'.repeat(32),calls=[];
 let revision=7,archived=false,changes=0;
 const project=()=>({id:projectId,appId:'app.copy',name:'删除验证',stage:'preview',artifacts:[],workshop:{name:'来源',version:'1.0.0'},deletedAt:archived?1:null,management:{revision,bytes:100,versions:{}}});
 const link={context:()=>({}),close(){},async request(input){
  calls.push({path:input.path,method:input.method,body:input.body&&JSON.parse(input.body.toString())});
  if(input.method==='GET')return{status:200,body:JSON.stringify({projects:[project()]})};
  const body=JSON.parse(input.body.toString());
  assert.equal(body.expectedRevision,revision);assert.equal(body.confirmedByUser,true);
  archived=body.action==='delete';revision++;
  return{status:200,body:JSON.stringify({project:project(),cleanedBytes:0})};
 }};
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box-a'}}),subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}},onChanged:()=>changes++});
 try{
  const active=await service.action('list');
  assert.equal(calls[0].path,'/api/_client/workshop/_management/projects');
  assert.equal(active.items[0].management.revision,7);
  for(const action of ['delete','restore']){
   const p=(await service.action('list')).items[0];
   const result=await service.action('manage',{projectId,operationId:action,action,expectedRevision:p.management.revision,confirmedByUser:true});
   assert.equal(Boolean(result.project.deletedAt),action==='delete');
   const call=calls.at(-1);
   assert.equal(call.path,'/api/_client/workshop/_management/projects/'+projectId);
   assert.equal(call.method,'POST');assert.equal(call.body.projectId,undefined);
  }
  assert.equal(changes,2);
  await assert.rejects(service.action('manage',{projectId:'../outside'}),/STUDIO_PROJECT_INVALID/);
 }finally{service.close()}
});

test('Workshop replaces a closed transport even when context still looks live, without replaying a write',async()=>{
 let generation=1;const writes=[];
 const projectId='a'.repeat(32);
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>{
  const captured=generation;
  return{context:()=>({accountId:'alice',boxId:'box',user:{id:1}}),close(){},async request(input){
   if(input.method==='POST')writes.push(input);
   if(captured!==generation)throw Object.assign(Error('SESSION_CLOSED'),{code:'SESSION_CLOSED'});
   return{status:200,body:JSON.stringify({projects:[{id:projectId,appId:'app.copy',name:'连接 '+captured,stage:'preview',artifacts:[]}]})};
  }};
 }},applications:{},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}}});
 try{
  assert.equal((await service.action('list')).items[0].name,'连接 1');
  generation=2;
  await assert.rejects(service.action('manage',{projectId,operationId:'delete-once',action:'delete',expectedRevision:0,confirmedByUser:true}),/SESSION_(?:CLOSED|EXPIRED)/);
  assert.equal((await service.action('list')).items[0].name,'连接 2');
  assert.equal(writes.length,1,'a disconnected write remains uncertain until an explicit user retry');
 }finally{service.close()}
});

test('a late closed-session response cannot discard the replacement Workshop connection',async()=>{
 let generation=1,hold=false,release;const closes=[];
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>{
  const captured=generation;return{context:()=>({}),close(){closes.push(captured)},request:async input=>{
   if(captured===1&&input.method==='GET'&&hold)return new Promise((_,reject)=>{release=reject});
   if(captured!==generation)throw Object.assign(Error('SESSION_CLOSED'),{code:'SESSION_CLOSED'});
   return{status:200,body:JSON.stringify({projects:[]})};
  }};
 }},applications:{},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}}});
 try{
  await service.action('list');hold=true;
  const late=service.action('list');const rejected=assert.rejects(late,/HOST_SESSION_EXPIRED/);
  await new Promise(resolve=>setImmediate(resolve));generation=2;
  await assert.rejects(service.action('manage',{projectId:'a'.repeat(32)}),/HOST_SESSION_EXPIRED/);
  await service.action('list');
  release(Object.assign(Error('SESSION_CLOSED'),{code:'SESSION_CLOSED'}));await rejected;
  await service.action('list');
  assert.deepEqual(closes,[1],'only the expired transport is closed before service disposal');
 }finally{service.close()}
});

test('closing Workshop while a connection is being created rejects and disposes the late connection',async()=>{
 let release,closed=false;
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:()=>new Promise(resolve=>{release=resolve})},applications:{},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}}});
 const waiting=service.action('list');const rejected=assert.rejects(waiting,/HOST_SESSION_EXPIRED/);
 service.close();release({close(){closed=true},request(){throw Error('late connection must never send')}});
 await rejected;assert.equal(closed,true);
 await assert.rejects(service.action('list'),/HOST_SESSION_EXPIRED/);
});

test('the first explicit Workshop open after same-box reconnection replaces the expired workbench',async()=>{
 let generation=1;const projectId='a'.repeat(32),views=[],handlers=new Map(),requests=[];
 const control=new EventEmitter();Object.assign(control,{getContentSize:()=>[1280,800],isDestroyed:()=>false,show(){},contentView:{addChildView(){},removeChildView(){}}});
 class View{constructor(){this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},loadFile:async()=>{},setWindowOpenHandler(){},send(){},isDestroyed:()=>false,close(){this.closed=true}});views.push(this)}setBounds(){}getBounds(){return{x:0,y:0,width:1280,height:800}}}
 class Win extends EventEmitter{constructor(){super();this.contentView={addChildView(){},removeChildView(){}}}getContentSize(){return[1280,800]}show(){}hide(){}focus(){}destroy(){}}
 const service=createPersonalWorkshop({client:{snapshot:()=>({phase:'ready',account:{accountId:'alice'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>{
  const captured=generation;return{context:()=>({accountId:'alice',boxId:'box',user:{id:1}}),close(){},async request(input){
   requests.push({generation:captured,...input});
   if(captured!==generation)throw Object.assign(Error('SESSION_CLOSED'),{code:'SESSION_CLOSED'});
   return{status:200,body:JSON.stringify({id:projectId,tasks:[],name:'会话 '+captured})};
  }};
 }},applications:{},assets:'unused',ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},control,BrowserWindow:Win,WebContentsView:View});
 try{
  await service.action('open',{projectId});
  generation=2;
  assert.equal((await service.action('open',{projectId})).projectId,projectId);
  assert.equal(views[0].webContents.closed,true);
  const sender=views.at(-1).webContents;
  const project=await handlers.get('studio-embedded:request')({sender,senderFrame:sender.mainFrame},'/api/app-studio/projects/'+projectId);
  assert.equal(project.name,'会话 2');
  assert.ok(requests.every(request=>request.method==='GET'),'opening only repeats the safe project read');
 }finally{service.close()}
});

test('missing project management evidence shows an actionable error without an unhandled delete',async()=>{
 const source=await readFile(new URL('../integration/personal-client/workshop.js',import.meta.url),'utf8');
 const calls=[],window={createStudioProduct:()=>({sync(){},reset(){},pause(){},render:()=>'',mounted(){}})};
 vm.runInNewContext(source,{window,crypto:{randomUUID:()=> 'stable-op'}});
 const view=window.createWanxWorkshop({changed(){},request:async(action,input)=>{
  calls.push({action,input});return{items:[{id:'p',name:'旧列表',workshop:{name:'来源',version:'1.0.0'}}]};
 }});
 view.sync('alice-box',true,true);await new Promise(r=>setImmediate(r));
 await view.action('workshop-delete');await view.action('workshop-manage');
 assert.match(view.render(),/项目管理信息尚未读取/);
 assert.equal(calls.filter(c=>c.action==='manage').length,0);
});


test('installed miniapp sources are not editable',async()=>{
 assert.deepEqual(await editablePackage({applicationId:'old',version:'1.0.0'}),{reason:'WORKSHOP_FORMAT_UNSUPPORTED'});
});

test('a project list arriving after an account switch cannot expose the previous account’s projects',async()=>{
 const source=await readFile(new URL('../integration/personal-client/workshop.js',import.meta.url),'utf8');
 const window={createStudioProduct:()=>({sync(){},reset(){},pause(){},render:()=>'',mounted(){}})};
 vm.runInNewContext(source,{window});
 let resolveAlice;
 const aliceList=new Promise(resolve=>{resolveAlice=resolve});
 const lists=[aliceList, {items:[{id:'bob-project',name:'Bob project',versions:[]}]}];
 const view=window.createWanxWorkshop({changed(){},request(action){
  assert.equal(action,'list');
  return lists.shift();
 }});
 view.sync('alice-box',true,true);
 view.sync('bob-box',true,true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(view.render(),/Bob project/);
 resolveAlice({items:[{id:'alice-project',name:'Alice private project',versions:[]}]});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(view.render(),/Bob project/);
 assert.doesNotMatch(view.render(),/Alice private project/);
 assert.equal(lists.length,0);
});

test('project archive/restore/filter and version cleanup preserve failed operation and fence account switches',async()=>{
 const source=await readFile(new URL('../integration/personal-client/workshop.js',import.meta.url),'utf8');
 let archived=false,version=0,failOnce=true;const writes=[];
 const window={createStudioProduct:()=>({sync(){},reset(){},pause(){},render:()=>'',mounted(){}})};
 vm.runInNewContext(source,{window,crypto:{randomUUID:()=> 'management-op'}});
 const view=window.createWanxWorkshop({changed(){},request:async(action,input)=>{
  if(action==='list')return{items:[{id:'p',name:'会议记录',versions:[{hash:'v1',version:'0.1.1'}],latestVersion:'0.1.1',deletedAt:archived?1:null,management:{revision:version,bytes:8192},workshop:{name:'原版',version:'1.0.0'}}]};
  if(action==='manage'){writes.push({...input});if(failOnce){failOnce=false;throw Error('TRANSPORT_FAILED')}archived=input.action==='delete';version++;return{cleanedBytes:0}};
 }});
 view.sync('alice-local',true,true);await new Promise(r=>setImmediate(r));
 await view.action('workshop-delete');assert.match(view.render(),/确认移入回收站/);
 await view.action('workshop-manage');assert.match(view.render(),/操作未完成/);
 await view.action('workshop-manage');assert.deepEqual(writes[0],writes[1]);
 await view.action('workshop-filter',{mode:'deleted'});assert.match(view.render(),/项目已收起/);assert.match(view.render(),/已安装应用继续可用/);
 await view.action('workshop-restore');await view.action('workshop-manage');
 await view.action('workshop-filter',{mode:'active'});assert.match(view.render(),/继续修改/);
 await view.action('workshop-clean-version',{hash:'v1'});assert.match(view.render(),/清理历史版本/);assert.match(view.render(),/业务数据保留/);
 view.sync('bob-local',true,true);assert.doesNotMatch(view.render(),/清理历史版本/);
});

async function trashView(request){
 const source=await readFile(new URL('../integration/personal-client/workshop.js',import.meta.url),'utf8');
 const window={createStudioProduct:()=>({sync(){},reset(){},pause(){},render:()=>'',mounted(){}})};
 let id=0;
 vm.runInNewContext(source,{window,crypto:{randomUUID:()=>`purge-${++id}`}});
 const view=window.createWanxWorkshop({changed(){},request});
 view.sync('alice-box',true,true);await new Promise(r=>setImmediate(r));
 return view;
}
const trashProject=(id,extra={})=>({id,name:`项目 ${id}`,deletedAt:1,management:{revision:7},workshop:{name:'合成来源'},...extra});

test('empty trash ignores search, skips protected/unknown projects, and retries only unfinished operations',async()=>{
 let items=[trashProject('a'),trashProject('b'),trashProject('installed',{management:{revision:7,purgeBlocked:'已安装应用仍依赖此项目'}}),trashProject('unknown',{management:undefined}),trashProject('active',{deletedAt:null})];
 const writes=[],receipts=new Set();let failOnce=true,inFlight=0,maxInFlight=0;
 const view=await trashView(async(action,input)=>{
  if(action==='list')return{items:structuredClone(items)};
  assert.equal(action,'manage');writes.push({...input});maxInFlight=Math.max(maxInFlight,++inFlight);
  try{
   await new Promise(r=>setImmediate(r));
   assert.equal(input.action,'purge');assert.equal(input.expectedRevision,7);assert.equal(input.confirmedByUser,true);
   if(!receipts.has(input.operationId)){
    assert.ok(items.some(p=>p.id===input.projectId));items=items.filter(p=>p.id!==input.projectId);receipts.add(input.operationId);
   }
   if(input.projectId==='b'&&failOnce){failOnce=false;throw Error('TRANSPORT_FAILED')}
   return{purged:true};
  }finally{inFlight--}
 });
 await view.action('workshop-filter',{mode:'deleted'});view.field('search','项目 a');
 await view.action('workshop-empty-trash');assert.equal(writes.length,0);
 assert.match(view.render(),/确认清空 2 个项目/);assert.match(view.render(),/搜索结果之外/);
 assert.match(view.render(),/已安装应用仍依赖此项目/);assert.match(view.render(),/项目管理信息尚未读取/);
 await view.action('workshop-empty-trash-confirm');
 assert.deepEqual(writes.map(p=>p.projectId),['a','b']);assert.equal(maxInFlight,1);
 assert.match(view.render(),/重试未完成项目/);assert.match(view.render(),/已删除 1 个/);
 await view.action('workshop-empty-trash-confirm');
 assert.deepEqual(writes.map(p=>p.projectId),['a','b','b']);assert.deepEqual(writes[1],writes[2]);
 assert.match(view.render(),/已删除 2 个/);assert.ok(items.some(p=>p.id==='active'));
 await view.action('workshop-cancel');view.field('search','');
 assert.doesNotMatch(view.render(),/清空回收站？/);assert.match(view.render(),/项目 installed/);
});

test('bulk cleanup confirms a fixed snapshot and never deletes newly archived projects',async()=>{
 let items=[trashProject('first')];const writes=[];
 const view=await trashView(async(action,input)=>{
  if(action==='list')return{items:structuredClone(items)};
  writes.push(input);items=[trashProject('newly-archived')];return{purged:true};
 });
 await view.action('workshop-filter',{mode:'deleted'});await view.action('workshop-empty-trash');
 await view.action('workshop-empty-trash-confirm');
 assert.deepEqual(writes.map(p=>p.projectId),['first']);
 assert.match(view.render(),/回收站还有 1 个项目/);assert.doesNotMatch(view.render(),/回收站已清空/);
});

test('disconnect stops bulk cleanup and reconnect never automatically resends; account switch clears the batch',async()=>{
 let items=[trashProject('one'),trashProject('two')],release,hold=true;const writes=[];
 const view=await trashView(async(action,input)=>{
  if(action==='list')return{items:structuredClone(items)};
  writes.push({...input});if(hold){hold=false;await new Promise(r=>release=r)}
  items=items.filter(p=>p.id!==input.projectId);return{purged:true};
 });
 await view.action('workshop-filter',{mode:'deleted'});await view.action('workshop-empty-trash');
 const pending=view.action('workshop-empty-trash-confirm');
 view.sync('alice-box',false,true);release();await pending;
 assert.equal(writes.length,1);
 view.sync('alice-box',true,true);await new Promise(r=>setImmediate(r));
 assert.equal(writes.length,1);
 await view.action('workshop-empty-trash-confirm');
 assert.deepEqual(writes.map(p=>p.projectId),['one','one','two']);assert.deepEqual(writes[0],writes[1]);
 assert.match(view.render(),/回收站已清空/);
 items=[trashProject('other')];await view.refresh();await view.action('workshop-empty-trash');
 view.sync('bob-box',true,true);await new Promise(r=>setImmediate(r));
 assert.doesNotMatch(view.render(),/清空回收站？/);
 await view.action('workshop-empty-trash-confirm');assert.equal(writes.length,3);
});

test('protected-only trash can be reviewed but cannot submit a purge; cancel never writes',async()=>{
 const writes=[];
 const view=await trashView(async(action,input)=>{
  if(action==='list')return{items:[trashProject('locked',{management:{revision:1,purgeBlocked:'已安装应用仍依赖此项目'}})]};
  writes.push(input);return{purged:true};
 });
 await view.action('workshop-filter',{mode:'deleted'});await view.action('workshop-empty-trash');
 assert.match(view.render(),/保留：已安装应用仍依赖此项目/);
 assert.doesNotMatch(view.render(),/data-action="workshop-empty-trash-confirm"/);
 await view.action('workshop-cancel');assert.equal(writes.length,0);
});

test('library verifies installed source permission and identifies box projects separately from computer packages',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'workshop-library-'));
 const projectId='b'.repeat(32),files={'miniapp.manifest.json':JSON.stringify({capabilities:['data']}),'src/app.js':'export function mount(){}'};
 const source={allowed:true,format:'wanx-miniapp-source-v1',applicationId:'sample.editable',version:'1.0.0',files,sourceHash:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
 await writeFile(path.join(dir,'wanx.editable.json'),JSON.stringify(source));await writeFile(path.join(dir,'miniapp.runtime.json'),JSON.stringify({runtimeNamespace:'workshop'}));
 let unavailable=false;
 const link={context:()=>({}),close(){},async request(){return unavailable?{status:404,body:'{}'}:{status:200,body:JSON.stringify({projects:[{id:projectId,appId:'sample.copy',name:'盒子副本',stage:'installed',artifacts:[],installed:{version:'0.1.0',artifactHash:'a'.repeat(64)}}]})}}};
 const service=createPersonalWorkshop({client:{snapshot:()=>({account:{accountId:'alice'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{listInstalled:async()=>[{applicationId:'sample.editable',version:'1.0.0',installPath:dir},{applicationId:'wrong.identity',version:'1.0.0',installPath:dir}]},assets:'unused',ipcMain:{handle(){},removeHandler(){}},control:{on(){}}});
 try{
  const library=await service.action('library');assert.equal(library.items[0].editable,false);assert.equal(library.items[1].editable,false);assert.equal(library.projects[0].installedVersion,'0.1.0');assert.equal(library.projects[0].appId,'sample.copy');assert.deepEqual(library.workshopApplicationIds,[]);
  unavailable=true;const missing=await service.action('library');assert.equal(missing.unavailable,true);assert.ok(missing.items.every(i=>!i.editable));assert.equal(missing.projects.length,0);
 }finally{service.close();await rm(dir,{recursive:true,force:true})}
});
