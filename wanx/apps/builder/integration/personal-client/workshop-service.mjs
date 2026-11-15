import {createDeploymentDelivery} from './deployment-delivery.mjs';
import {readFile,lstat,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createEmbeddedWorkspace} from '../embedded-workspace.mjs';
import {createProjectPreview} from '../project-preview.mjs';
import {createNativeFoundationPool,connectionHost} from '../../core/foundation-native.mjs';
import {projectSummary} from '../host-entry.mjs';
import {writeMiniappPackage} from '../../core/package.mjs';
import {workshopTemplates,workshopTemplate,workshopTemplateForApplication} from '../../templates/catalog.mjs';
const prefix='/api/_client/workshop';
const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const pid=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
export async function editablePackage(item){
 try{
  const file=path.join(item.installPath,'wanx.editable.json'),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>3*1024*1024)throw fail('WORKSHOP_SOURCE_INVALID');
  const value=JSON.parse(await readFile(file,'utf8'));
  if(value.allowed!==true)throw fail('WORKSHOP_MODIFICATION_NOT_ALLOWED');
  if(value.format!=='wanx-miniapp-source-v1')throw fail('WORKSHOP_FORMAT_UNSUPPORTED');
  if(value.applicationId!==item.applicationId||value.version!==item.version||!value.files||value.sourceHash!==hash(value.files))throw fail('WORKSHOP_SOURCE_CHANGED');
  const manifest=JSON.parse(value.files['miniapp.manifest.json']);
  if(manifest.capabilities.some(cap=>!['data','model','files','knowledge','foundation','dialogue'].includes(cap)))throw fail('WORKSHOP_CAPABILITY_UNSUPPORTED');
  return{source:value};
 }catch(error){return{reason:error.code==='ENOENT'?'WORKSHOP_SOURCE_REQUIRED':error.code||'WORKSHOP_SOURCE_INVALID'}}
}
export function createPersonalWorkshop({client,applications,assets,BrowserWindow,WebContentsView,ipcMain,control,nativeFoundation,getCatalog=async()=>[],onChanged=()=>{},onNavigate=()=>{}}){
 let delivery=null;
 let current=null,pending=null,lastScope='',revision=0,disposed=false,sources=new Map(),previewFoundation;
 const key=()=>{const s=client.snapshot(),owner=s.dataIdentity?.profileId||s.account?.accountId,box=s.dataIdentity?.selected?.boxId||s.connection?.deviceId;if(!box&&owner&&lastScope&&JSON.parse(lastScope)[0]===owner)return lastScope;return JSON.stringify([owner,box,s.dataIdentity?.selected?.principalId])};
 function clear(){delivery?.invalidate();revision++;pending=null;sources.clear();previewFoundation?.close();previewFoundation=null;const old=current;current=null;old?.link.close?.()}
 function requestFailure(active,error){
  if(['HOST_SESSION_EXPIRED','SESSION_CLOSED','LOCAL_DATA_SESSION_CLOSED','NETWORK_CHANGED'].includes(error?.code||error?.message)){
   if(current===active)clear();
   return fail('HOST_SESSION_EXPIRED');
  }
  return error;
 }
 const unsubscribe=client.subscribe(()=>{if(lastScope&&lastScope!==key()){clear();lastScope=''}else if(current){try{current.link.context()}catch{clear()}}});
 async function session(){
  if(disposed)throw fail('HOST_SESSION_EXPIRED');
  if(current){try{current.link.context()}catch{clear()}}
  const k=key(),rev=revision;
  if(!current){pending||=(async()=>{const link=await client.applicationConnection();if(disposed||rev!==revision||k!==key()){link.close?.();throw fail('HOST_SESSION_EXPIRED')}lastScope=k;return current={key:k,link};})().finally(()=>{if(rev===revision)pending=null});await pending;}
  const active=current;
  const assertLive=()=>{if(disposed||current!==active||active.key!==key())throw fail('HOST_SESSION_EXPIRED');active.link.context()};
  const request=async(route,method='GET',body)=>{
   try{
   assertLive();const response=await active.link.request({path:prefix+route,method,signal:AbortSignal.timeout(method==='GET'?60000:240000),...(body?{headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))}:{})});assertLive();
   let raw=response.body;if(raw?.[Symbol.asyncIterator]){const parts=[];let size=0;for await(const chunk of raw){size+=chunk.length;if(size>16*1024*1024)throw fail('WORKSHOP_RESPONSE_TOO_LARGE');parts.push(chunk)}raw=Buffer.concat(parts)}
   const value=JSON.parse(Buffer.isBuffer(raw)?raw.toString():typeof raw==='string'?raw:JSON.stringify(raw));assertLive();if(response.status!==200)throw fail(response.status===404?'WORKSHOP_UPDATE_REQUIRED':value.code||value.detail?.code||'WORKSHOP_REQUEST_FAILED');return value;
   }catch(error){throw requestFailure(active,error)}
  };
  return{key:k,assertLive,request,active};
 }
 if(nativeFoundation?.root&&applications.installDeployment)delivery=createDeploymentDelivery({session,scopeKey:key,root:path.join(path.dirname(nativeFoundation.root),'deployment-delivery'),assets:path.join(assets,'runtime'),applications,onChanged});
 const previews=createProjectPreview(session,{invokeFoundation:async(descriptor,s)=>{if(!nativeFoundation)throw fail('FOUNDATION_NATIVE_REQUIRED');previewFoundation||=createNativeFoundationPool({host:connectionHost(s.active.link,s.assertLive),root:nativeFoundation.root,dialog:nativeFoundation.dialog,parent:control});return previewFoundation.invoke(descriptor);}});
 const installs=new Map();
 const connection=async()=>{
  const s=await session();
  return{nativeConnection:s.active.link,context:()=>{s.assertLive();return s.active.link.context()},subscribe:fn=>s.active.link.onInvalidated?.(()=>fn({type:'invalidated'}))||(()=>{}),request:async input=>{try{s.assertLive();const response=await s.active.link.request({...input,path:prefix+input.path.slice('/api/app-studio'.length)});s.assertLive();return response}catch(error){throw requestFailure(s.active,error)}}};
 };
 async function install(projectId,artifactHash){
  const s=await session(),key=s.key+projectId+artifactHash;
  if(installs.has(key))return installs.get(key);
  const job=installOnce(projectId,artifactHash).finally(()=>installs.delete(key));installs.set(key,job);return job;
 }
 async function installOnce(projectId,artifactHash){
  const s=await session(),payload=await s.request(`/projects/${projectId}/install/${artifactHash}`);s.assertLive();
  const dir=await mkdtemp(path.join(os.tmpdir(),'wanx-workshop-'));
  try{const existing=(await applications.listInstalled()).find(a=>a.applicationId===payload.applicationId);s.assertLive();
   if(existing?.version===payload.version){const record=JSON.parse(await readFile(path.join(existing.installPath,'miniapp.runtime.json'),'utf8'));if(record.artifactHash!==payload.artifactHash)throw fail('INSTALLED_ARTIFACT_MISMATCH');}
   else{await writeMiniappPackage(payload,dir,{assets:path.join(assets,'runtime')});s.assertLive();await applications.install({sourceDir:dir});}s.assertLive();await s.request(`/projects/${projectId}/installed`,'POST',{operationId:randomUUID(),artifactHash,applicationId:payload.applicationId,version:payload.version});onChanged();return{applicationId:payload.applicationId,version:payload.version};}
  finally{await rm(dir,{recursive:true,force:true})}
 }
 const workspace=createEmbeddedWorkspace({BrowserWindow,WebContentsView,ipcMain,control,createConnection:connection,assets,onChanged,onNavigate,title:'万象工坊',install,personal:true,nativeFoundation});
 return{
  async action(action,input={}){
   if(action==='preview.open')return previews.previewOpen(input);
   if(action==='preview.invoke')return previews.previewInvoke(input);
   if(action==='preview.close')return previews.previewClose(input);
   const s=await session();
   if(action==='list'){const result=await s.request('/_management/projects');return{items:result.projects.map(p=>{const template=workshopTemplateForApplication(p.workshop?.applicationId);return{...projectSummary(p),management:p.management,workshop:p.workshop,templateUpdate:template&&p.workshop.sourceHash!==template.sourceHash?template.version:null}})};}
   if(action==='library'){
    const installed=await applications.listInstalled();s.assertLive();
    const items=[],workshopApplicationIds=[];
    for(const item of installed){const check=await editablePackage(item);s.assertLive();let runtime;try{runtime=JSON.parse(await readFile(path.join(item.installPath,'miniapp.runtime.json'),'utf8'))}catch{}if(runtime?.runtimeNamespace==='workshop')workshopApplicationIds.push(item.applicationId);items.push({applicationId:item.applicationId,editable:Boolean(check.source),reason:check.reason});}
    let result;try{result=await s.request('/_management/projects')}catch(e){s.assertLive();return{items:items.map(i=>({...i,editable:false})),workshopApplicationIds,projects:[],unavailable:true};}
    return{items,workshopApplicationIds,projects:result.projects.map(p=>({...projectSummary(p),workshop:p.workshop,installedArtifactHash:p.installed?.artifactHash||null}))};
   }
   if(action==='install-adopted'){if(!pid(input.projectId))throw fail('STUDIO_PROJECT_INVALID');const p=await s.request('/projects/'+input.projectId),h=p.versioning?.adoptedHash||p.acceptance?.artifactHash;if(!h)throw fail('ARTIFACT_NOT_ADOPTED');return install(input.projectId,h);}
   if(action==='sources'){
    const next=new Map(),items=[];
    for(const item of workshopTemplates()){next.set(item.id,workshopTemplate(item.id));items.push(item);}
    const installed=await applications.listInstalled();s.assertLive();
    for(const item of installed){const result=await editablePackage(item);s.assertLive();const id='installed:'+item.applicationId;if(result.source)next.set(id,result.source);items.push({id,name:item.name,version:item.version,origin:item.installationSource==='market'?'市场应用':'本地应用',editable:Boolean(result.source),reason:result.reason});}
    const catalog=await getCatalog().catch(()=>[]);s.assertLive();
    for(const item of (Array.isArray(catalog)?catalog:catalog.items||[])){if(installed.some(i=>i.applicationId===item.applicationId))continue;items.push({id:'market:'+item.applicationId,name:item.name,version:item.version,origin:'市场应用',editable:false,reason:'WORKSHOP_MARKET_SOURCE_REQUIRED'});}
    const owned=await s.request('/sources');
    for(const item of owned.items){const id='kaiwu:'+item.id;if(!item.reason)next.set(id,{...item.source,projectId:item.id});items.push({id,name:item.name,version:item.source.version,origin:'开物成果',editable:!item.reason,reason:item.reason});}
    s.assertLive();sources=next;return{items};
   }
   if(action==='copy'){
    let source=sources.get(input.sourceId);if(!source)throw fail('WORKSHOP_SOURCE_CHANGED');
    if(source.projectId)source=await s.request('/sources/'+source.projectId+'?sourceHash='+source.sourceHash+'&version='+encodeURIComponent(source.version));
    const p=await s.request('/copies','POST',{operationId:input.operationId,name:input.name,source});s.assertLive();return{projectId:p.id};
   }
   if(action==='template.update'){if(!pid(input.projectId)||!/^[a-f0-9]{64}$/.test(input.artifactHash))throw fail('STUDIO_PROJECT_INVALID');const project=await s.request('/projects/'+input.projectId);const source=workshopTemplateForApplication(project.workshop?.applicationId);if(!source)throw fail('WORKSHOP_SOURCE_REQUIRED');return s.request('/projects/'+input.projectId+'/source-update','POST',{operationId:input.operationId,expectedArtifactHash:input.artifactHash,source});}
   if(action==='manage'){if(!pid(input.projectId))throw fail('STUDIO_PROJECT_INVALID');const {projectId,...body}=input;const result=await s.request('/_management/projects/'+projectId,'POST',body);s.assertLive();onChanged();return result;}
   if(action==='open'||action==='deployment.open'){
    if(action==='open'&&!pid(input.projectId))throw fail('STUDIO_PROJECT_INVALID');
    const target=action==='deployment.open'?{protocolVersion:2,projectId:null,section:'directory-deployment'}:{protocolVersion:2,projectId:input.projectId};
    try{return await workspace.open(target)}catch(error){
     if((error?.code||error?.message)!=='HOST_SESSION_EXPIRED'||disposed||s.key!==key())throw error;
     requestFailure(s.active,error);
     // Opening only reads the selected project. Rebuild once; writes are never replayed.
     return workspace.open(target);
    }
   }
   if(action.startsWith('runtime-model')&&!pid(input.projectId))throw fail('STUDIO_PROJECT_INVALID');
   if(action==='runtime-model'){return s.request('/_client/projects/'+input.projectId+'/runtime-model');}
   if(action==='runtime-model.save'){return s.request('/_client/projects/'+input.projectId+'/runtime-model','PUT',{operationId:input.operationId,expectedRevision:input.expectedRevision,modelId:input.modelId});}
   throw fail('WORKSHOP_ACTION_DENIED');
  },
  close(){delivery?.close();workspace.close();disposed=true;unsubscribe();clear()}
 };
}
