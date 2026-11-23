import{mkdir,writeFile,copyFile,readFile,readdir}from'node:fs/promises';
import path from'node:path';
import{fileURLToPath}from'node:url';
import{frameDocument}from'../../core/frame.mjs';
const shell=fileURLToPath(new URL('../../shell/',import.meta.url));
export function validatePortable(payload){
  if(payload.runtimeNamespace!==undefined&&!['studio','workshop'].includes(payload.runtimeNamespace))throw new Error('RUNTIME_NAMESPACE_INVALID');
  if(!/^(?:ai\.wanx\.selfmade\.[a-f0-9]{32}|dev\.wanx\.[a-z0-9-]{1,96})$/.test(payload.applicationId)||!/^[a-f0-9]{64}$/.test(payload.artifactHash)||!/^\d+\.\d+\.\d+$/.test(payload.version))throw new Error('SELFMADE_PACKAGE_INVALID');
  const generated=JSON.stringify({manifest:payload.manifest,bundle:payload.bundle,css:payload.css});
  if(/(?:\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|\/Users\/|\/Volumes\/|\/home\/|192\.168\.\d+\.\d+|127\.0\.0\.1:\d+)/.test(generated))throw new Error('PACKAGE_CONTAINS_PRIVATE_LOCATOR');
  if(Buffer.byteLength(generated)>4*1024*1024)throw new Error('PACKAGE_TOO_LARGE');
}
export async function writeMiniappPackage(payload,directory,{assets}={}){
  validatePortable(payload);await mkdir(directory,{recursive:true,mode:0o700});
  const manifest={applicationId:payload.applicationId,name:payload.name,version:payload.version,protocolVersion:1,runtime:'electron',launchMode:'shared',entrypoint:'runtime-main.cjs',description:'本人自造的万象小应用',installationSource:'selfmade'};
  await writeFile(path.join(directory,'application.manifest.json'),JSON.stringify(manifest,null,2));
  // Ordinary portable packages omit source/owner/box identity and credentials.
  // Managed deployment packages below explicitly bind their runtime to one box/environment.
  const portable={applicationId:payload.applicationId,name:payload.name,version:payload.version,artifactHash:payload.artifactHash,manifest:payload.manifest,bundle:payload.bundle,css:payload.css};
  await writeFile(path.join(directory,'miniapp.runtime.json'),JSON.stringify(portable,null,2));
  if(payload.deployment){
    const d=payload.deployment,keys=['schemaVersion','profile','operationId','environment','generation','baseApplicationId','slotApplicationId','boxId'];if(Object.keys(d).length!==keys.length||Object.keys(d).some(k=>!keys.includes(k))||d.schemaVersion!==1||!['wanx-miniapp-v1','wanx-expert-app-v1'].includes(d.profile)||d.slotApplicationId!==payload.applicationId||!['dev','prod'].includes(d.environment)||!Number.isSafeInteger(d.generation)||d.generation<1||!(typeof d.baseApplicationId==='string'&&(d.profile==='wanx-miniapp-v1'?/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/:/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(d.baseApplicationId))||!/^[a-f0-9]{32}$/.test(d.operationId)||typeof d.boxId!=='string'||!d.boxId||d.boxId.length>128)throw new Error('DEPLOYMENT_PACKAGE_INVALID');
    portable.deployment={...d};await writeFile(path.join(directory,'miniapp.runtime.json'),JSON.stringify(portable,null,2));
  }
  if(payload.runtimeNamespace!==undefined){
    portable.runtimeNamespace=payload.runtimeNamespace;
    await writeFile(path.join(directory,'miniapp.runtime.json'),JSON.stringify(portable,null,2));
  }
  if(payload.editable?.allowed===true)await writeFile(path.join(directory,'wanx.editable.json'),JSON.stringify(payload.editable));
  // A packaged document gets its own CSP; srcdoc would inherit the trusted
  // parent's script-src and block the generated app's inline bootstrap.
  await writeFile(path.join(directory,'miniapp-frame.html'),frameDocument(payload.bundle,payload.css));
  for(const file of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html']){
    if(assets||file==='runtime.html')await copyFile(path.join(assets||shell,file),path.join(directory,file));
    else await writeFile(path.join(directory,file),'// Inert historical test fixture.\n');
  }
  return manifest;
}
