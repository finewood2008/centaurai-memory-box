import {mkdtemp,rm,rename,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
export async function exportStudioPackage({input,request,assertLive,chooseExport}) {
  if(!input||![2,3].includes(input.protocolVersion)||Object.keys(input).some(k=>!['protocolVersion','projectId','taskId','artifactHash','version'].includes(k))||!/^[a-f0-9]{32}$/.test(input.projectId)||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.taskId)||!/^[a-f0-9]{64}$/.test(input.artifactHash)||!/^\d+\.\d+\.\d+$/.test(input.version))throw fail('STUDIO_EXPORT_INVALID');
  const read=async()=>{
    assertLive();const payload=await request(`/projects/${input.projectId}/install/${input.artifactHash}`);assertLive();
    if(payload.artifactHash!==input.artifactHash||payload.taskId!==input.taskId||payload.version!==input.version)throw fail('ACCEPTANCE_STALE');
    return payload;
  };
  const payload=await read();
  if(!payload.packageBase64||!payload.packageSha256)throw fail('STANDARD_PACKAGE_REQUIRED');
  const destination=await chooseExport(`${payload.applicationId}-${payload.version}.zip`);assertLive();
  if(!destination)return{state:'cancelled'};
  // The destination comes from a native save dialog, never the renderer.
  const temporary=await mkdtemp(path.join(path.dirname(destination),'.wanx-export-'));
  try {
    const archive=path.join(temporary,'application.zip');
    if(payload.packageBase64){const bytes=Buffer.from(payload.packageBase64,'base64');if(!bytes.length||bytes.subarray(0,2).toString()!=='PK')throw fail('STANDARD_PACKAGE_INVALID');if(payload.packageSha256&&createHash('sha256').update(bytes).digest('hex')!==payload.packageSha256)throw fail('STANDARD_PACKAGE_HASH_MISMATCH');await writeFile(archive,bytes);}
    const fresh=await read();
    if(JSON.stringify(fresh)!==JSON.stringify(payload))throw fail('ACCEPTANCE_STALE');
    if(payload.packageBase64){try{await access(destination);throw fail('EXPORT_EXISTS')}catch(error){if(error.code!=='ENOENT')throw error}}
    assertLive();await rename(archive,destination);
    const sha256=createHash('sha256').update(await readFile(destination)).digest('hex');
    return{state:'exported',path:destination,sha256,version:payload.version,artifactHash:payload.artifactHash};
  } finally {await rm(temporary,{recursive:true,force:true})}
}
