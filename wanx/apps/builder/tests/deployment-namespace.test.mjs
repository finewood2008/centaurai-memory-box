import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';import vm from 'node:vm';
import {validatePortable} from '../core/package.mjs';
const source=readFileSync(new URL('../shell/runtime-main.cjs',import.meta.url),'utf8');
function runtime(runtimeNamespace){
 const payload={applicationId:'ai.wanx.selfmade.'+'a'.repeat(32),artifactHash:'b'.repeat(64),manifest:{schemaVersion:1,capabilities:['foundation']},deployment:{environment:'dev',generation:1},...(runtimeNamespace===undefined?{}:{runtimeNamespace})};
 const requests=[],handlers=new Map();let window,boot;
 class Window{constructor(){window=this;this.webContents={mainFrame:{},setWindowOpenHandler(){},on(){}}}async loadFile(){}on(){}close(){}}
 const host={async context(){return{applicationId:payload.applicationId}},async request(route,input){requests.push({route,...input});return{ok:true,json:async()=>route.endsWith('/runtime')?{session:'synthetic-session',manifest:payload.manifest}:{items:[]}}},onSessionInvalidated(){},close(){}};
 const modules={electron:{app:{whenReady:()=>({then(fn){boot=Promise.resolve().then(fn);return boot}}),quit(){},on(){},getPath:()=>'/synthetic'},BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{}},'../core/foundation-native.mjs':{createNativeFoundationPool(){throw Error('must not use native foundation')}},'node:fs':{readFileSync:()=>JSON.stringify(payload)},'node:path':path,'./request-policy.cjs':{requestTimeout:()=>1000},'@centaurai/wanx-host-sdk':{fromEnvironment:()=>host},'@centaurai/wanx-host-sdk/electron':{attachElectronHost(){}}};
 vm.runInNewContext(source,{require:name=>modules[name],process:{env:{}},__dirname:'/synthetic'});
 return{requests,async invoke(){await boot;return handlers.get('miniapp:invoke')({sender:window.webContents,senderFrame:window.webContents.mainFrame},'foundation.invoke',{operation:'expert.tasks',input:{}})}};
}
for(const[namespace,prefix]of [['studio','/api/app-studio'],['workshop','/api/_client/workshop'],[undefined,'/api/app-studio']])test('actual runtime bootstrap uses '+String(namespace)+' namespace for opening and expert invocation',async()=>{const r=runtime(namespace);await r.invoke();assert.ok(r.requests.every(request=>request.route.startsWith(prefix+'/')));assert.match(r.requests[0].route,/\/deployment\/apps\/.*\/runtime$/);assert.match(r.requests[1].route,/\/runtime\/synthetic-session\/invoke$/)});
test('unknown explicit runtime namespace cannot silently fall back to Studio',()=>assert.throws(()=>runtime('foreign'),/RUNTIME_NAMESPACE_INVALID/));
test('the trusted packager rejects undeclared namespaces before writing files',()=>assert.throws(()=>validatePortable({runtimeNamespace:'foreign'}),/RUNTIME_NAMESPACE_INVALID/));
