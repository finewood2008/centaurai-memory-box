import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createEmbeddedWorkspace} from '../integration/embedded-workspace.mjs';
import navigation from '../integration/preview-navigation.cjs';

const {installPreviewNavigationGuard} = navigation;
function contents(){
  const wc=new EventEmitter(),mainFrame={};
  const requestListener=()=>{};
  Object.assign(wc,{mainFrame,session:{webRequest:{onBeforeRequest:requestListener},setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(fn){this.openWindow=fn},
    loadFile:async file=>{wc.loaded=file},send(){},isDestroyed:()=>false,close(){wc.emit('destroyed')}});
  return wc;
}
function event(wc,url,extra={}){
  return {url,isMainFrame:false,isSameDocument:false,frame:{parent:wc.mainFrame},initiator:null,
    prevented:false,preventDefault(){this.prevented=true},...extra};
}

test('only trusted main-frame initiation may load a direct offline srcdoc preview',async()=>{
  const wc=contents(),existing=wc.session.webRequest.onBeforeRequest;
  installPreviewNavigationGuard(wc);
  const initial=event(wc,'about:srcdoc',{initiator:wc.mainFrame});
  wc.emit('will-frame-navigate',initial);assert.equal(initial.prevented,false);
  await wc.loadFile('/trusted/ui/index.html');assert.equal(wc.loaded,'/trusted/ui/index.html');
  assert.equal(wc.session.webRequest.onBeforeRequest,existing,'a shared session request hook is untouched');
  assert.equal(wc.listenerCount('will-frame-navigate'),1);
  // Image/style data and blob resources are not frame navigations. The guard
  // registers no session interception; their availability remains CSP-owned.
  assert.deepEqual(wc.eventNames().filter(name=>String(name).includes('request')),[]);
});

test('self, nested, missing-frame and top-level navigation fail closed for every scheme',()=>{
  const wc=contents();installPreviewNavigationGuard(wc);
  const child={parent:wc.mainFrame};
  for(const url of ['https://example.invalid/','http://example.invalid/','file:///private/secret',
    'data:text/html,<h1>escape</h1>','blob:null/escape','about:blank','about:srcdoc','javascript:alert(1)']){
    for(const extra of [{initiator:child,frame:child},{initiator:null},{initiator:wc.mainFrame,frame:null},
      {initiator:child,frame:{parent:child}},{initiator:wc.mainFrame,frame:wc.mainFrame,isMainFrame:true}]){
      const attempt=event(wc,url,extra);wc.emit('will-frame-navigate',attempt);
      assert.equal(attempt.prevented,true,`${url} cannot escape its preview frame`);
    }
  }
  wc.mainFrame=undefined;
  const missing=event(wc,'about:srcdoc',{initiator:undefined,frame:null});
  wc.emit('will-frame-navigate',missing);assert.equal(missing.prevented,true);
  Object.defineProperty(wc,'mainFrame',{get(){throw Error('destroyed')}});
  const destroyed={url:'about:srcdoc',prevented:false,preventDefault(){this.prevented=true}};
  wc.emit('will-frame-navigate',destroyed);assert.equal(destroyed.prevented,true);
});

test('meta, redirect, top-level, webview and new-window escape attempts are denied',()=>{
  const wc=contents();installPreviewNavigationGuard(wc);
  for(const name of ['will-navigate','will-redirect','will-attach-webview']){
    for(const url of ['about:srcdoc','data:text/html,escape','https://example.invalid/','file:///trusted/ui/index.html']){
      const attempt=event(wc,url,{initiator:wc.mainFrame});wc.emit(name,attempt);assert.equal(attempt.prevented,true);
    }
  }
  assert.deepEqual(wc.openWindow({url:'https://example.invalid/'}),{action:'deny'});
  wc.emit('destroyed');assert.equal(wc.listenerCount('will-frame-navigate'),0);
});

test('the canonical embedded host installs frame protection before its trusted UI loads',async()=>{
  let view;
  class View{constructor(){view=this;this.webContents=contents()}setBounds(){}getBounds(){return{x:0,y:0,width:1,height:1}}}
  class Window extends EventEmitter{constructor(){super();this.contentView={addChildView(){},removeChildView(){}}}getContentSize(){return[100,100]}show(){}focus(){}destroy(){}}
  const control=new EventEmitter();Object.assign(control,{getContentSize:()=>[100,100],contentView:{addChildView(){},removeChildView(){}},show(){},isDestroyed:()=>false});
  const workspace=createEmbeddedWorkspace({BrowserWindow:Window,WebContentsView:View,control,
    ipcMain:{handle(){},removeHandler(){}},assets:'/trusted',createConnection:async()=>({context:()=>({accountId:'synthetic',boxId:'synthetic',user:{id:1}})})});
  try{
    await workspace.open({protocolVersion:2});
    assert.equal(view.webContents.listenerCount('will-frame-navigate'),1);
    assert.equal(view.webContents.loaded,'/trusted/workbench/ui/index.html');
    const attempt=event(view.webContents,'data:text/html,escape');view.webContents.emit('will-frame-navigate',attempt);assert.equal(attempt.prevented,true);
  }finally{workspace.close()}
});

test('the canonical standalone host installs frame protection before its trusted UI loads',async()=>{
  const source=await readFile(new URL('../shell/main.cjs',import.meta.url),'utf8');
  const nativeRequire=createRequire(import.meta.url),wc=contents();let ready;
  class Window extends EventEmitter{constructor(){super();this.webContents=wc}async loadFile(file){return wc.loadFile(file)}setBackgroundColor(){}}
  const host={context:async()=>({}),onSessionInvalidated(){},close(){}};
  const app={setName(){},whenReady(){return{then(fn){ready=fn();return ready}}},on(){},setAboutPanelOptions(){},quit(){}};
  wc.session.setPermissionRequestHandler=()=>{};wc.session.setPermissionCheckHandler=()=>{};
  const overrides={electron:{app,BrowserWindow:Window,ipcMain:{handle(){}},nativeTheme:{},Menu:{setApplicationMenu(){},buildFromTemplate:()=>[]}},
    '@centaurai/wanx-host-sdk':{fromEnvironment:()=>host},'@centaurai/wanx-host-sdk/electron':{attachElectronHost(){}},
    '../integration/workspace-policy.mjs':{studioRoute:v=>v},'../core/request-errors.mjs':{requestErrorCode:v=>v},
    './request-policy.cjs':{requestTimeout(){}},'../integration/preview-capture.cjs':{},
    '../integration/preview-navigation.cjs':navigation,
    '../integration/edit-scope.mjs':{heartbeatEdits:()=>()=>{},stopEdits(){}}};
  vm.runInNewContext(source,{require:id=>overrides[id]??nativeRequire(id),__dirname:'/trusted/shell',process:{env:{}},Buffer,setInterval,clearInterval,AbortSignal});
  await ready;
  assert.equal(wc.listenerCount('will-frame-navigate'),1);
  assert.equal(wc.loaded,path.join('/trusted/shell','../ui/index.html'));
  const attempt=event(wc,'https://example.invalid/');wc.emit('will-frame-navigate',attempt);assert.equal(attempt.prevented,true);
});
