import {createDeploymentDelivery} from './deployment-delivery.mjs';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createEmbeddedWorkspace} from '../embedded-workspace.mjs';
import {createProjectPreview} from '../project-preview.mjs';
import {projectSummary} from '../host-entry.mjs';
const prefix='/api/_client/workshop';
const fail=code=>Object.assign(Error(code),{code});
const pid=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
export async function editablePackage(){
 return {reason:'WORKSHOP_FORMAT_UNSUPPORTED'};
}
export function createPersonalWorkshop({client,applications,assets,BrowserWindow,WebContentsView,ipcMain,control,nativeFoundation,onChanged=()=>{},onNavigate=()=>{}}){
 let delivery=null;
 let current=null,pending=null,lastScope='',revision=0,disposed=false;
 const key=()=>{const s=client.snapshot(),owner=s.dataIdentity?.profileId||s.account?.accountId,box=s.dataIdentity?.selected?.boxId||s.connection?.deviceId;if(!box&&owner&&lastScope&&JSON.parse(lastScope)[0]===owner)return lastScope;return JSON.stringify([owner,box,s.dataIdentity?.selected?.principalId])};
 function clear(){delivery?.invalidate();revision++;pending=null;const old=current;current=null;old?.link.close?.()}
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
 async function deliverySession(){
  const s=await session();
  if(!(s.active.deliveryCapabilityUntil>performance.now())){
   const capability=await s.request('/deployment/capabilities');
   s.assertLive();
   if(capability?.schemaVersion!==1||capability.available!==true||!Array.isArray(capability.operations)||!capability.operations.includes('deploy'))
    throw fail('DEPLOYMENT_ADAPTER_UNAVAILABLE');
   s.active.deliveryCapabilityUntil=performance.now()+60000;
  }
  return s;
 }
 if(nativeFoundation?.root&&applications.installDeployment)delivery=createDeploymentDelivery({session:deliverySession,scopeKey:key,root:path.join(path.dirname(nativeFoundation.root),'deployment-delivery'),assets:path.join(assets,'runtime'),applications,onChanged});
 const previews=createProjectPreview(session);
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
   if(payload.artifactHash!==artifactHash||payload.manifest?.protocolVersion!==3||payload.applicationId!==payload.manifest.applicationId||payload.version!==payload.manifest.version||!payload.packageBase64)throw fail('STANDARD_PACKAGE_REQUIRED');
   const bytes=Buffer.from(payload.packageBase64,'base64');
   if(!bytes.length||createHash('sha256').update(bytes).digest('hex')!==payload.packageSha256)throw fail('STANDARD_PACKAGE_HASH_MISMATCH');
   if(existing?.version===payload.version){if(existing.packageSha256!==payload.packageSha256)throw fail('INSTALLED_ARTIFACT_MISMATCH');}
   else{const archivePath=path.join(dir,'application.zip');await writeFile(archivePath,bytes);s.assertLive();await applications.install({archivePath,standardArtifactHash:payload.packageSha256,manifest:payload.manifest});}
   s.assertLive();await s.request(`/projects/${projectId}/installed`,'POST',{operationId:randomUUID(),artifactHash,applicationId:payload.applicationId,version:payload.version});onChanged();return{applicationId:payload.applicationId,version:payload.version};}
  finally{await rm(dir,{recursive:true,force:true})}
 }
 const workspace=createEmbeddedWorkspace({BrowserWindow,WebContentsView,ipcMain,control,createConnection:connection,assets,onChanged,onNavigate,title:'万象工坊',install,personal:true,nativeFoundation});
 return{
  async action(action,input={}){
   if(action==='preview.open')return previews.previewOpen(input);
   if(action==='preview.invoke')return previews.previewInvoke(input);
   if(action==='preview.close')return previews.previewClose(input);
   const s=await session();
   if(action==='list'){const result=await s.request('/_management/projects');return{items:result.projects.map(p=>{return{...projectSummary(p),management:p.management,workshop:p.workshop,templateUpdate:null}})};}
   if(action==='library'){
    const installed=await applications.listInstalled();s.assertLive();
    const items=installed.map(({applicationId})=>({applicationId,editable:false,reason:'WORKSHOP_FORMAT_UNSUPPORTED'}));
    let result;try{result=await s.request('/_management/projects')}catch(e){s.assertLive();return{items,workshopApplicationIds:[],projects:[],unavailable:true};}
    const workshopApplicationIds=result.projects.filter(project=>{
     const artifact=project.artifacts.find(value=>value.hash===project.installed?.artifactHash);
     return artifact?.packageSha256 && installed.some(item=>item.applicationId===project.appId && item.packageSha256===artifact.packageSha256);
    }).map(project=>project.appId);
    return{items,workshopApplicationIds,projects:result.projects.map(p=>({...projectSummary(p),workshop:p.workshop,installedArtifactHash:p.installed?.artifactHash||null}))};
   }
   if(action==='install-adopted'){if(!pid(input.projectId))throw fail('STUDIO_PROJECT_INVALID');const p=await s.request('/projects/'+input.projectId),h=p.versioning?.adoptedHash||p.acceptance?.artifactHash;if(!h)throw fail('ARTIFACT_NOT_ADOPTED');return install(input.projectId,h);}
   if(action==='sources'){
    return {items:[]};
   }
   if(action==='copy'||action==='template.update')throw fail('WORKSHOP_FORMAT_UNSUPPORTED');
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
