import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {compileArtifact,validateSources} from '../core/artifact.mjs';

const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export async function packTemplate(directory,{applicationId,version}){
  if(!/^[a-z][a-z0-9.-]{0,127}$/.test(applicationId)||!/^\d+\.\d+\.\d+$/.test(version))throw Error('TEMPLATE_IDENTITY_INVALID');
  const files={};
  async function read(name){
    const full=path.join(directory,name),info=await lstat(full);
    if(info.isSymbolicLink())throw Error('TEMPLATE_SYMLINK_DENIED');
    if(info.isDirectory()){for(const entry of (await readdir(full)).sort())await read(name+'/'+entry);return;}
    if(!info.isFile()||info.size>512*1024)throw Error('TEMPLATE_SOURCE_INVALID');
    files[name]=await readFile(full,'utf8');
  }
  await read('miniapp.manifest.json');await read('src');validateSources(files);
  const compiled=await compileArtifact(files);
  if(compiled.manifest.capabilities.some(c=>!['data','model','files','knowledge','foundation','dialogue'].includes(c)))throw Error('WORKSHOP_CAPABILITY_UNSUPPORTED');
  return {allowed:true,format:'wanx-miniapp-source-v1',applicationId,version,origin:'local',sourceHash:createHash('sha256').update(canonical(files)).digest('hex'),files};
}
