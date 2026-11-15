const{app,BrowserWindow,ipcMain,dialog}=require('electron');
const{createNativeFoundationPool}=require('../core/foundation-native.mjs');
const fs=require('node:fs');
const path=require('node:path');
const{requestTimeout}=require('./request-policy.cjs');
const{fromEnvironment}=require('@centaurai/wanx-host-sdk');
const{attachElectronHost}=require('@centaurai/wanx-host-sdk/electron');
// WANX 0.1.4 local shared runtime uses the earlier data-path variable.
if(!process.env.WANX_HOST_USER_DATA_DIR&&process.env.WANX_HOST_APPLICATION_DATA)process.env.WANX_HOST_USER_DATA_DIR=process.env.WANX_HOST_APPLICATION_DATA;
attachElectronHost();
const host=fromEnvironment();let win,session,invalid=false,foundation;
const payload=JSON.parse(fs.readFileSync(path.join(__dirname,'miniapp.runtime.json'),'utf8'));
const runtimeNamespace=payload.runtimeNamespace??'studio';
if(!['studio','workshop'].includes(runtimeNamespace))throw new Error('RUNTIME_NAMESPACE_INVALID');
async function request(route,method='GET',body){if(invalid||!host)throw new Error('HOST_SESSION_EXPIRED');const target=(runtimeNamespace==='workshop'?'/api/_client/workshop':'/api/app-studio')+route;const response=await host.request(target,{method,body,timeoutMs:requestTimeout('/api/app-studio'+route,method,body)});const value=await response.json();if(!response.ok)throw new Error(value.code||value.detail?.code||'RUNTIME_FAILED');return value}
function sender(event){if(invalid||event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('RUNTIME_SENDER_DENIED')}
app.whenReady().then(async()=>{
  if(!host)throw new Error('HOST_REQUIRED');
  const context=await host.context();if(context.applicationId&&context.applicationId!==payload.applicationId)throw new Error('APP_IDENTITY_MISMATCH');
  const runtime=payload.deployment?await request('/deployment/apps/'+payload.applicationId+'/runtime','POST',{artifactHash:payload.artifactHash,environment:payload.deployment.environment,generation:payload.deployment.generation}):await request('/apps/'+payload.applicationId+'/runtime','POST',{artifactHash:payload.artifactHash,environment:'production'});session=runtime.session;
  win=new BrowserWindow({width:1120,height:820,minWidth:700,minHeight:560,title:payload.name,backgroundColor:'#f8fafc',webPreferences:{preload:path.join(__dirname,'runtime-preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  if(JSON.stringify(runtime.manifest)!==JSON.stringify(payload.manifest))throw new Error('APP_CONTRACT_CHANGED');
  ipcMain.handle('miniapp:load',event=>{sender(event);return{bundle:payload.bundle,css:payload.css,name:payload.name}});
  ipcMain.handle('miniapp:invoke',async(event,method,params)=>{sender(event);if(!['dialogue.invoke','foundation.invoke','data.list','data.get','data.put','data.delete','model.generate','model.list','model.select','files.read','knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence'].includes(method))throw new Error('METHOD_NOT_ALLOWED');const result=await request('/runtime/'+session+'/invoke','POST',{method,params});if(method==='foundation.invoke'&&result?.nativeFoundation){foundation||=createNativeFoundationPool({host,root:path.join(app.getPath('userData'),'foundation'),dialog,parent:win});const value=await foundation.invoke(result);await request('/runtime/'+session+'/invoke','POST',{method,params:{operation:'status',input:{}}});return value;}return result});
  ipcMain.handle('miniapp:files-list',async(event,parent)=>{sender(event);if(typeof parent!=='string'||parent.length>128)throw new Error('FILE_INPUT_INVALID');return request(payload.runtimeNamespace==='workshop'?'/runtime/'+session+'/files?parent='+encodeURIComponent(parent):'/files?parent='+encodeURIComponent(parent))});
  ipcMain.handle('miniapp:files-select',async(event,ids)=>{sender(event);return request('/runtime/'+session+'/files','POST',{ids})});
  ipcMain.handle('miniapp:knowledge-list',async event=>{sender(event);return request('/runtime/'+session+'/knowledge')});
  ipcMain.handle('miniapp:knowledge-select',async(event,ids)=>{sender(event);return request('/runtime/'+session+'/knowledge','POST',{ids})});
  ipcMain.handle('miniapp:haowen-native',async(event,body)=>{sender(event);return request('/runtime/'+session+'/haowen-native','POST',body)});
  host.onSessionInvalidated(()=>{invalid=true;win?.close()});
  await win.loadFile(path.join(__dirname,'runtime.html'));win.on('closed',()=>app.quit());
}).catch(()=>app.quit());
app.on('before-quit',()=>{invalid=true;foundation?.close();host?.close()});
