import{mkdtemp,rm,readFile,writeFile}from'node:fs/promises';
import os from'node:os';
import path from'node:path';
import{createHash,randomUUID}from'node:crypto';
import{writeMiniappPackage}from'../core/package.mjs';
import{STANDARD_MAX_COMPRESSED_BYTES}from'../../team-client/applications/standard-deployment-limits.mjs';
export const STUDIO_ID='ai.wanx.studio';
export {createStudioEntry} from './host-entry.mjs';
export {installBundledWorkbench} from './bundled-workbench.mjs';
export {installPreviewNavigationGuard} from './preview-navigation.cjs';
export function createStudioControl({applications,assets,onChanged=async()=>{},navigation=()=>({projectId:null}),returnToClient=async()=>{throw new Error('STUDIO_RETURN_UNAVAILABLE')}}){
  const inFlight=new Map();
  const fail=code=>Object.assign(new Error(code),{code,status:409});
  return async function control({operation,body,connection,assertLive}){
    assertLive();
    if(operation==='navigation')return navigation(connection);
    if(operation==='return'){if(body?.protocolVersion!==2||!['projects','models','connectors','skills','environment'].includes(body.destination))throw fail('STUDIO_DESTINATION_DENIED');await returnToClient(body.destination);assertLive();return{protocolVersion:2}}
    if(operation==='projectChanged'){if(body?.protocolVersion!==2||!/^[a-f0-9]{32}$/.test(body.projectId))throw fail('STUDIO_PROJECT_INVALID');const response=await connection.request({path:'/api/app-studio/projects/'+body.projectId,method:'GET'});if(response.status!==200)throw fail('STUDIO_PROJECT_INVALID');assertLive();await onChanged();return{protocolVersion:2}}
    if(operation==='open'){
      if(typeof body.applicationId!=='string'||body.applicationId.length>64||!/^(?:ai\.wanx\.selfmade\.[a-f0-9]{32}|dev\.wanx\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.(?:[a-f0-9]{8}|a[a-f0-9]{8}))?)$/.test(body.applicationId))throw fail('STUDIO_APP_ID_DENIED');
      return applications.launch(body.applicationId);
    }
    if(operation!=='install'||!body||Object.keys(body).some(k=>!['projectId','artifactHash'].includes(k))||!/^[a-f0-9]{32}$/.test(body.projectId)||!/^[a-f0-9]{64}$/.test(body.artifactHash))throw fail('STUDIO_REQUEST_DENIED');
    const context=connection.context();const key=JSON.stringify([context.accountId,context.boxId,context.user.id,body.projectId,body.artifactHash]);
    if(inFlight.has(key))return inFlight.get(key);
    const job=(async()=>{
      const response=await connection.request({path:`/api/app-studio/projects/${body.projectId}/install/${body.artifactHash}`,method:'GET'});
      const decode=async r=>{let value=r.body;if(value?.[Symbol.asyncIterator]){const chunks=[];let size=0;for await(const chunk of value){size+=chunk.length;if(size>Math.ceil(STANDARD_MAX_COMPRESSED_BYTES/3)*4+1024*1024)throw fail('STUDIO_RESPONSE_TOO_LARGE');chunks.push(chunk)}value=Buffer.concat(chunks)}return JSON.parse(Buffer.isBuffer(value)?value.toString():typeof value==='string'?value:JSON.stringify(value))};
      const payload=await decode(response);if(response.status!==200)throw fail(payload.code||'USER_ACCEPTANCE_REQUIRED');
      assertLive();
      if(payload.artifactHash!==body.artifactHash)throw fail('INSTALLED_ARTIFACT_MISMATCH');
      const standardBytes=payload.packageBase64?Buffer.from(payload.packageBase64,'base64'):null;
      const standardHash=standardBytes?createHash('sha256').update(standardBytes).digest('hex'):null;
      if(standardBytes&&payload.packageSha256&&payload.packageSha256!==standardHash)throw fail('STANDARD_PACKAGE_HASH_MISMATCH');
      const restore=payload.restore!==undefined;
      if(restore&&(!standardBytes||!payload.packageSha256||standardBytes.toString('base64')!==payload.packageBase64||
        !payload.restore||Object.keys(payload.restore).sort().join()!=='artifactHash,schemaVersion,source'||payload.restore.schemaVersion!==1||payload.restore.source!=='restore'||
        payload.restore.artifactHash!==payload.artifactHash||typeof applications.restoreStandardPackage!=='function'))throw fail('STUDIO_RESTORE_DENIED');
      const installed=await applications.listInstalled();let current=installed.find(a=>a.applicationId===payload.applicationId);assertLive();
      if(!restore&&current?.version===payload.version){
        if(standardBytes){
          const descriptor=current.descriptor;
          if(!descriptor||descriptor.sha256!==standardHash||descriptor.applicationId!==payload.applicationId||descriptor.version!==payload.version)throw fail('INSTALLED_ARTIFACT_MISMATCH');
        }else{
          const record=JSON.parse(await readFile(path.join(current.installPath,'miniapp.runtime.json'),'utf8'));
          if(record.artifactHash!==payload.artifactHash)throw fail('INSTALLED_ARTIFACT_MISMATCH');
        }
      }else{
        const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-selfmade-install-'));
        try{
          if(standardBytes){
            const archive=path.join(directory,'application.zip');await writeFile(archive,standardBytes);assertLive();
            current=restore
              ?await applications.restoreStandardPackage({archivePath:archive,artifactHash:standardHash,manifest:payload.manifest,assertSession:assertLive})
              :await applications.install({archivePath:archive,standardArtifactHash:standardHash,manifest:payload.manifest});
          }else{await writeMiniappPackage(payload,directory,{assets});assertLive();current=await applications.install({sourceDir:directory})}
          assertLive();
        }finally{await rm(directory,{recursive:true,force:true})}
      }
      const receipt={operationId:randomUUID(),artifactHash:payload.artifactHash,applicationId:payload.applicationId,version:payload.version};
      const acknowledged=await connection.request({path:`/api/app-studio/projects/${body.projectId}/installed`,method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(receipt))});
      if(acknowledged.status!==200)throw fail('INSTALL_RECEIPT_NOT_COMMITTED');assertLive();await onChanged();
      return {applicationId:payload.applicationId,version:payload.version,state:'installed'};
    })().finally(()=>inFlight.delete(key));inFlight.set(key,job);return job;
  };
}
