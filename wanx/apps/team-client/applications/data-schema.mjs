import {fileIdentity} from './file-identity.mjs';
import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import semver from 'semver';

const unknown=()=>Object.assign(new Error('APPLICATION_DATA_COMPATIBILITY_UNKNOWN'),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink;
const writerMatches=(a,b)=>Boolean(a&&b&&a.artifactId===b.artifactId&&a.descriptorDigest===b.descriptorDigest);
async function directory({applicationRoot,directory,assertLive=()=>{}},create=false){
 assertLive();
 const anchor=path.dirname(path.resolve(applicationRoot)),relative=path.relative(anchor,path.resolve(directory));
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw unknown();
 let current=await realpath(anchor);
 for(const part of relative.split(path.sep)){
  current=path.join(current,part);
  if(create)try{await mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  let info;try{info=await lstat(current);}catch(e){if(e.code==='ENOENT'&&!create)return null;throw e;}
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(current)!==current)throw unknown();
 }
 assertLive();return current;
}
export async function readDataSchema(input){
 let handle;
 try{
  const root=await directory(input);if(!root)return null;
  const file=path.join(root,'.data-schema.json');let info;
  try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4096)throw unknown();
  // lstat dev can be 0 on Windows; keep its link evidence and compare file handles.
  const snapshot=await fileIdentity(file);
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=await handle.stat();
  if(!same(snapshot,opened)||opened.ino!==info.ino||opened.size!==info.size)throw unknown();
  const bytes=Buffer.alloc(4097);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
  if(bytesRead!==info.size||!same(opened,await handle.stat())||!same(snapshot,await fileIdentity(file))||!same(info,await lstat(file)))throw unknown();
  const value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
  if(value?.schemaVersion!==1||value.applicationId!==input.applicationId||Object.keys(value).sort().join()!=='applicationId,dataSchemaVersion,schemaVersion,writer'||
    !semver.valid(value.dataSchemaVersion)||!value.writer||Object.keys(value.writer).sort().join()!=='artifactId,descriptorDigest'||!writerMatches(value.writer,input.writer))throw unknown();
  if(await directory(input)!==root)throw unknown();return value.dataSchemaVersion;
 }catch{throw unknown();}finally{await handle?.close();}
}
export async function writeDataSchema(input){
 let temporary;
 try{
  if(!semver.valid(input.dataSchemaVersion)||!input.writer)throw unknown();
  const root=await directory(input,true);
  // Interrupted writes are Host-owned projections, not application data. Only
  // this reserved bounded regular-file namespace may be cleaned on recovery.
  const abandoned=(await readdir(root)).filter(name=>/^\.data-schema-[a-f0-9-]{36}\.tmp$/.test(name));
  if(abandoned.length>64)throw unknown();
  for(const name of abandoned){const filename=path.join(root,name),info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4096)throw unknown();await rm(filename);}
  temporary=path.join(root,'.data-schema-'+randomUUID()+'.tmp');
  // Validate any existing marker before replacing it; never follow a redirected file.
  const filename=path.join(root,'.data-schema.json');
  try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw unknown();}catch(e){if(e.code!=='ENOENT')throw e;}
  const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify({schemaVersion:1,applicationId:input.applicationId,dataSchemaVersion:input.dataSchemaVersion,writer:input.writer}));await handle.sync();}finally{await handle.close();}
  if(await directory(input)!==root)throw unknown();await rename(temporary,filename);
  if(process.platform!=='win32'){const fd=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
  input.assertLive?.();
 }catch{throw unknown();}finally{if(temporary)await rm(temporary,{force:true});}
}
