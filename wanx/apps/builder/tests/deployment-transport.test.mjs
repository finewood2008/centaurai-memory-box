import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createEmbeddedWorkspace} from '../integration/embedded-workspace.mjs';
import {studioRoute} from '../integration/workspace-policy.mjs';
import {requestErrorCode} from '../core/request-errors.mjs';

const prefix='/api/app-studio/deployment';
const operation=prefix+'/operations/'+'a'.repeat(32);
const target='organizationId=org-1&boxId=box_1&applicationId=app.example&environment=dev';
const allowed=[
 ['GET',prefix+'/capabilities'],['POST',prefix+'/releases'],
 ['POST',prefix+'/operations'],['GET',prefix+'/operations'],
 ['GET',prefix+'/operations?limit=100'],['GET',prefix+'/operations?'+target+'&limit=1'],
 ['GET',prefix+'/environments?'+target],['GET',prefix+'/environments?'+target.replace('dev','prod')],
 ['GET',operation],['GET',operation+'/receipt'],['POST',operation+'/resume'],
 ['POST',operation+'/receipt/retry'],['GET',operation+'/events'],
 ['GET',operation+'/events?after=0&limit=100'],['GET',operation+'/events?after=9007199254740991'],
];
const denied=[
 ['GET',prefix+'/releases'],['POST',prefix+'/capabilities'],['DELETE',operation],
 ['PUT',prefix+'/operations'],['POST',operation+'/events'],['GET',operation+'/resume'],
 ['POST',operation+'/receipt'],['GET',operation+'/receipt/retry'],
 ['POST',operation+'/recover'],['POST',prefix+'/recover'],['POST',prefix+'/admin'],
 ['POST',prefix+'/executor'],['POST',prefix+'/executor/operations'],
 ['GET',operation.replace('a'.repeat(32),'A'.repeat(32))],['GET',operation+'a'],
 ['GET',operation+'/'],['POST',prefix+'/operations?limit=1'],['POST',prefix+'/releases?x=1'],
 ['POST',operation+'/resume?boxId=other'],['GET',operation+'?after=0'],
 ['GET',prefix+'/capabilities?x=1'],['GET',prefix+'/environments'],
 ['GET',prefix+'/operations?boxId=box'],['GET',prefix+'/environments?'+target+'&limit=1'],
 ['GET',prefix+'/operations?'+target+'&boxId=other'],['GET',prefix+'/environments?'+target+'&environment=prod'],
 ['GET',prefix+'/operations?limit=1&limit=2'],['GET',prefix+'/operations?constructor=x'],
 ['GET',prefix+'/operations?__proto__=x'],['GET',prefix+'/operations?recover=true'],
 ['GET',prefix+'/environments?'+target.replace('dev','production')],
 ['GET',prefix+'/environments?'+target.replace('box_1','_box')],
 ['GET',prefix+'/environments?'+target.replace('box_1','a'.repeat(129))],
 ['GET',prefix+'/environments?'+target.replace('box_1','')],
 ['GET',prefix+'/environments?'+target.replace('box_1','box+1')],
 ['GET',prefix+'/environments?'+target.replace('box_1','box%2f1')],
 ['GET',prefix+'/environments?'+target.replace('box_1','盒子')],
 ['GET',operation+'/events?after=0&after=1'],['GET',operation+'/events?limit=1&other=1'],
 ...['-1','1.1','1e2','9007199254740992','','01','+1','Infinity','NaN'].map(n=>['GET',operation+'/events?after='+n]),
 ...['0','101','1.5','01','','-1','9007199254740992'].map(n=>['GET',operation+'/events?limit='+n]),
 ['GET',prefix+'/../context'],['GET',prefix+'/operations/../capabilities'],
 ['GET',prefix+'/capabi\nlities'],['GET',prefix+'/capabilities#fragment'],
 ['GET','https://evil.example'+prefix+'/capabilities'],
];

function embeddedTransport(){
 const handlers=new Map(),requests=[];let view,status=200,value={state:'pending'};
 const host=new EventEmitter();Object.assign(host,{isDestroyed:()=>false,getContentSize:()=>[1200,800],show(){},contentView:{addChildView(){},removeChildView(){}}});
 class View{constructor(){view=this;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},loadFile:async()=>{},setWindowOpenHandler(){},send(){},isDestroyed:()=>false,close(){}})}setBounds(){} }
 class Window extends EventEmitter{constructor(){super();this.contentView={addChildView(){},removeChildView(){}}}getContentSize(){return[1200,800]}show(){}focus(){}destroy(){} }
 const connection={context:()=>({accountId:'account',boxId:'box',user:{id:1}}),async request(input){requests.push(input);return{status,body:JSON.stringify(value)}}};
 const workspace=createEmbeddedWorkspace({BrowserWindow:Window,WebContentsView:View,ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},control:host,createConnection:async()=>connection,assets:'/trusted'});
 return{requests,open:()=>workspace.open({protocolVersion:2}),close:()=>workspace.close(),respond(s,v){status=s;value=v},request(route,method,body){const sender=view.webContents;return handlers.get('studio-embedded:request')({sender,senderFrame:sender.mainFrame},route,method,body)}};
}

// Execute the actual registered IPC handler, including post-response project work.
function standaloneTransport(){
 const requests=[],handlers=new Map(),events=new Map(),timers=new Set();let status=200,value={state:'pending'},win,resolveReady;
 const ready=new Promise(resolve=>resolveReady=resolve);
 const host={context:async()=>({accountId:'account',boxId:'box',user:{id:1}}),onSessionInvalidated(){},close(){},async request(path,options){requests.push({path,...options});return{ok:status>=200&&status<300,status,json:async()=>value}}};
 const noop=()=>{};
 class Window extends EventEmitter{
  constructor(){super();win=this;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},setWindowOpenHandler:noop,session:{setPermissionRequestHandler:noop,setPermissionCheckHandler:noop},send:noop});}
  async loadFile(){resolveReady()}
 }
 const modules={
  electron:{app:{setName:noop,on:(key,fn)=>events.set(key,fn),whenReady:()=>Promise.resolve(),setAboutPanelOptions:noop,quit:noop},BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},nativeTheme:{},Menu:{setApplicationMenu:noop,buildFromTemplate:()=>[]}},
  '../integration/workspace-policy.mjs':{studioRoute},'../core/request-errors.mjs':{requestErrorCode},
  '../integration/edit-scope.mjs':{rememberRequest:noop,rememberEdits:noop,stopEdits:noop,heartbeatEdits:()=>noop},
  '@centaurai/wanx-host-sdk':{fromEnvironment:()=>host},'@centaurai/wanx-host-sdk/electron':{attachElectronHost:noop},
 };
 const main=new URL('../shell/main.cjs',import.meta.url),require=createRequire(main);
 const context={require:name=>Object.hasOwn(modules,name)?modules[name]:require(name),process:{env:{}},__dirname:new URL('../shell/',import.meta.url).pathname,Buffer,Error,
  setInterval(fn){const timer={fn};timers.add(timer);return timer},clearInterval:timer=>timers.delete(timer)};
 runInNewContext(readFileSync(main,'utf8'),context,{filename:main.pathname});
 return{requests,timers,open:()=>ready,close:()=>events.get('before-quit')?.(),respond(s,v){status=s;value=v},request(route,method,body){const sender=win.webContents;return handlers.get('studio:request')({sender,senderFrame:sender.mainFrame},route,method,body)}};
}

test('deployment route policy accepts only the specified methods, targets and bounded cursors',()=>{
 for(const[method,path]of allowed)assert.equal(studioRoute(path,method),path);
 for(const[method,path]of denied)assert.throws(()=>studioRoute(path,method),/STUDIO_PATH_DENIED/,method+' '+path);
 assert.equal(studioRoute(prefix+'/environments?'+target.replace('box_1','a'.repeat(128))),prefix+'/environments?'+target.replace('box_1','a'.repeat(128)));
 assert.equal(studioRoute('/api/app-studio/context'),'/api/app-studio/context');
 assert.equal(studioRoute('/api/app-studio/projects/'+'b'.repeat(32)+'?legacy=1'),'/api/app-studio/projects/'+'b'.repeat(32)+'?legacy=1');
});

for(const[name,create]of [['embedded',embeddedTransport],['standalone',standaloneTransport]]){
 test(name+' IPC preserves a pending null receipt and still handles valid project responses',async()=>{
  const h=create();try{await h.open();h.respond(200,null);
   assert.equal(await h.request(operation+'/receipt','GET'),null);
   const project={id:'b'.repeat(32),tasks:[{state:'running'}]};h.respond(200,project);
   assert.deepEqual(await h.request('/api/app-studio/projects/'+project.id,'GET'),project);
   if(name==='standalone')assert.equal(h.timers.size,1,'valid project still starts its existing watcher');
  }finally{h.close()}
 });
 test(name+' transport enforces the shared deployment whitelist before host dispatch',async()=>{
  const h=create();try{await h.open();
   for(const[method,path]of allowed){await h.request(path,method);assert.equal(h.requests.at(-1).path,path);assert.equal(h.requests.at(-1).method,method)}
   const count=h.requests.length;
   for(const[method,path]of denied)await assert.rejects(h.request(path,method),/STUDIO_PATH_DENIED/,method+' '+path);
   assert.equal(h.requests.length,count,'denied routes never reach the box');
  }finally{h.close()}
 });
 test(name+' returns accepted operation state unchanged and preserves backend failure codes',async()=>{
  const h=create();try{await h.open();const pending={operationId:'a'.repeat(32),state:'pending',receipt:null};h.respond(202,pending);
   for(const route of [prefix+'/operations',operation+'/resume'])assert.deepEqual(await h.request(route,'POST',{requestId:'original'}),pending);
   h.respond(409,{detail:{code:'DEPLOYMENT_OPERATION_CONFLICT'}});
   await assert.rejects(h.request(prefix+'/operations','POST',{}),/DEPLOYMENT_OPERATION_CONFLICT/);
  }finally{h.close()}
 });
}

test('embedded 202 exception is limited to operation creation and resume',async()=>{
 const h=embeddedTransport();try{await h.open();h.respond(202,{state:'pending'});
  for(const[method,path]of allowed.filter(([method,path])=>!(method==='POST'&&[prefix+'/operations',operation+'/resume'].includes(path))))await assert.rejects(h.request(path,method),/STUDIO_REQUEST_FAILED/);
  await assert.rejects(h.request('/api/app-studio/context','GET'),/STUDIO_REQUEST_FAILED/);
  for(const status of [201,204,400,500]){h.respond(status,null);await assert.rejects(h.request(prefix+'/operations','POST'),/STUDIO_REQUEST_FAILED/)}
 }finally{h.close()}
});


test('project deployment context and submission are finite routes; main delivery commands stay private',async()=>{
 const root='/api/app-studio/projects/'+'b'.repeat(32)+'/deployment/';
 for(const [tail,method] of [['context','GET'],['prepare','POST'],['submit','POST']]){
  assert.equal(studioRoute(root+tail,method),root+tail);
  for(const suffix of ['?boxId=other','?','/','#fragment'])assert.throws(()=>studioRoute(root+tail+suffix,method),/STUDIO_PATH_DENIED/);
  assert.throws(()=>studioRoute(root+tail,method==='GET'?'POST':'GET'),/STUDIO_PATH_DENIED/);
 }
 for(const [tail,method]of [['client-deliveries','GET'],['client-deliveries/'+'c'.repeat(32)+'/claim','POST'],['client-deliveries/'+'c'.repeat(32)+'/payload','GET'],['client-deliveries/'+'c'.repeat(32)+'/ack','POST']])assert.throws(()=>studioRoute(prefix+'/'+tail,method),/STUDIO_PATH_DENIED/);
 const h=embeddedTransport();try{await h.open();h.respond(202,{id:'c'.repeat(32),state:'queued'});
  assert.equal((await h.request(root+'submit','POST',{})).state,'queued');
  await assert.rejects(h.request(root+'prepare','POST',{}),/STUDIO_REQUEST_FAILED/);
 }finally{h.close()}
});

test('directory deployment routes accept only bounded release IDs and explicit submission 202',async()=>{
 const root=prefix+'/directory-releases/expert-release_0.1.0/';
 for(const[route,method]of [[prefix+'/directory-releases','GET'],[prefix+'/expert-templates','GET'],[root+'context','GET'],[root+'ingest','POST'],[root+'prepare','POST'],[root+'submit','POST']]){
  assert.equal(studioRoute(route,method),route);
  for(const suffix of ['?','?path=/tmp/source','/','#fragment'])assert.throws(()=>studioRoute(route+suffix,method),/STUDIO_PATH_DENIED/);
  for(const wrong of ['DELETE','HEAD','PUT'])assert.throws(()=>studioRoute(route,wrong),/STUDIO_PATH_DENIED/);
 }
 for(const id of ['..','_hidden','a'.repeat(129),'a%2fb','a/b'])assert.throws(()=>studioRoute(prefix+'/directory-releases/'+id+'/context','GET'),/STUDIO_PATH_DENIED/);
 const h=embeddedTransport();try{await h.open();h.respond(202,{id:'c'.repeat(32),state:'queued'});
  assert.equal((await h.request(root+'submit','POST',{})).state,'queued');
  for(const tail of ['ingest','prepare'])await assert.rejects(h.request(root+tail,'POST',{}),/STUDIO_REQUEST_FAILED/);
 }finally{h.close()}
});
