import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {validateApplicationManifest} from './manifest.mjs';
import {extractApplicationArchive} from './archive.mjs';
import yauzl from 'yauzl';
import {STANDARD_MAX_COMPRESSED_BYTES,STANDARD_MAX_EXTRACTED_BYTES,STANDARD_MAX_ARCHIVE_ENTRIES} from './standard-deployment-limits.mjs';

const fail=code=>Object.assign(new Error(code),{code});
export const STANDARD_EXPERT_FORMAT='wanx-standard-expert-client-v1';
export const STANDARD_PACKAGE_FILE='.wanx-standard-package.zip';
export const STANDARD_EXPERT_CONTRACT=Object.freeze({id:'wanx.expert-app.v1',version:'1.0.0',collections:{state:{json:'string'}}});
export const stableStandard=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const standardSha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const standardArtifactId=hash=>`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${((parseInt(hash.slice(16,18),16)&0x3f)|0x80).toString(16).padStart(2,'0')}${hash.slice(18,20)}-${hash.slice(20,32)}`;
export const isStandardDeployment=record=>record?.standardDeployment?.format===STANDARD_EXPERT_FORMAT;
export async function assertStandardDeploymentArchive(archivePath){
 const info=await lstat(archivePath);
 if(!info.isFile()||info.isSymbolicLink())throw fail('APPLICATION_ARCHIVE_INVALID');
 if(info.size>STANDARD_MAX_COMPRESSED_BYTES)throw fail('APPLICATION_ARCHIVE_TOO_LARGE');
 let archive;
 try{
  archive=await yauzl.openPromise(archivePath,{strictFileNames:true});
  if(archive.entryCount<1||archive.entryCount>STANDARD_MAX_ARCHIVE_ENTRIES)throw fail('APPLICATION_ARCHIVE_TOO_LARGE');
  let total=0,count=0;
  for await(const entry of archive.eachEntry()){
   count++;total+=entry.uncompressedSize;
   if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||count>STANDARD_MAX_ARCHIVE_ENTRIES||total>STANDARD_MAX_EXTRACTED_BYTES)throw fail('APPLICATION_ARCHIVE_TOO_LARGE');
  }
 }finally{archive?.close()}
}
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===expected.toSorted().join();
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const bindingKeys=['schemaVersion','profile','baseApplicationId','slotApplicationId','environment','boxId','operationId','generation','fence','artifactHash','scopeId','ticketId','payloadDigest'];
export function standardDeploymentBinding(binding,artifactHash){
 if(!keys(binding,bindingKeys)||binding.schemaVersion!==1||binding.profile!=='wanx-expert-app-v1'||
  typeof binding.baseApplicationId!=='string'||!/^[a-z][a-z0-9._-]{1,63}$/.test(binding.baseApplicationId)||typeof binding.slotApplicationId!=='string'||!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(binding.slotApplicationId)||
  binding.baseApplicationId===binding.slotApplicationId||!['dev','prod'].includes(binding.environment)||
  typeof binding.boxId!=='string'||!binding.boxId||binding.boxId.length>128||!id(binding.operationId)||!id(binding.ticketId)||
  !Number.isSafeInteger(binding.generation)||binding.generation<1||!Number.isSafeInteger(binding.fence)||binding.fence<1||
  !hex(binding.artifactHash)||binding.artifactHash!==artifactHash||!hex(binding.scopeId)||!/^sha256:[a-f0-9]{64}$/.test(binding.payloadDigest))throw fail('APPLICATION_DEPLOYMENT_INVALID');
 return structuredClone(binding);
}
export function standardDeploymentManifest(record){
 if(!isStandardDeployment(record))throw fail('APPLICATION_DEPLOYMENT_INVALID');
 const proof=record.standardDeployment,b=standardDeploymentBinding(record.deployment,record.deployment?.artifactHash),d=record.descriptor;
 if(!keys(proof,['schemaVersion','format','packageSha256','runtimeNamespace','runtimeContract','files'])||proof.schemaVersion!==1||proof.runtimeNamespace!=='studio'||
  stableStandard(proof.runtimeContract)!==stableStandard(STANDARD_EXPERT_CONTRACT)||!hex(proof.packageSha256)||
  record.applicationId!==b.slotApplicationId||record.packageApplicationId!==b.baseApplicationId||record.installationSource!=='selfmade'||
  !d||d.schemaVersion!==3||d.applicationId!==b.baseApplicationId||d.sha256!==proof.packageSha256||d.artifactId!==standardArtifactId(b.artifactHash)||record.artifactId!==d.artifactId||
  d.version!==record.version||d.hostProtocol!==1||d.packageType!=='wanxapp'||!Number.isSafeInteger(d.size)||d.size<1||!Array.isArray(proof.files)||!proof.files.length)throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 const original=validateApplicationManifest(d.manifest);
 if(original.protocolVersion!==3||original.launchMode!=='shared'||original.releaseAccess||original.applicationId!==b.baseApplicationId||original.version!==d.version)throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 const {packageApplicationId,standardDeployment,deployment,...publicRecord}=record;
 const actual=validateApplicationManifest(publicRecord,{allowLegacyVersion:true});
 if(stableStandard(actual)!==stableStandard({...original,applicationId:b.slotApplicationId}))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 return original;
}
// Inventory is made from verified extracted ZIP bytes and checked again after copy.
// Standard shared Electron clients never need supplier symlinks or Host records.
export async function standardDeploymentFiles(directory,{installed=false,includePackageFile=false,assertSession=()=>{}}={}){
 const root=await realpath(directory),files=[];let total=0;
 async function visit(current,prefix=''){
  for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   assertSession();const relative=prefix+entry.name,file=path.join(current,entry.name),info=await lstat(file);
   if(!prefix&&(entry.name==='.wanx-install.json'||entry.name===STANDARD_PACKAGE_FILE&&!includePackageFile)){
    if(installed)continue;
    throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
   }
   if(info.isSymbolicLink()||!info.isDirectory()&&(!info.isFile()||info.nlink!==1))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
   if(info.isDirectory())await visit(file,relative+'/');
   else{
    total+=info.size;if(total>STANDARD_MAX_EXTRACTED_BYTES||files.length>=STANDARD_MAX_ARCHIVE_ENTRIES)throw fail('APPLICATION_ARCHIVE_TOO_LARGE');
    const bytes=await readFile(file);assertSession();
    const after=await lstat(file);
    if(info.dev!==after.dev||info.ino!==after.ino||info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs||bytes.length!==info.size)throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
    files.push({path:relative,size:bytes.length,sha256:standardSha(bytes)});
   }
  }
 }
 await visit(root);return files;
}
export async function verifyStandardDeploymentInstallation(record,{active=false,assertSession=()=>{}}={}){
 const original=standardDeploymentManifest(record),directory=await realpath(record.installPath),b=record.deployment;
 assertSession();
 if(path.basename(directory)!==`managed-${b.generation}-${b.operationId}`||path.basename(path.dirname(directory))!==record.applicationId)throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 const archive=path.join(directory,STANDARD_PACKAGE_FILE),info=await lstat(archive);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==record.descriptor.size||info.size>STANDARD_MAX_COMPRESSED_BYTES)throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 const bytes=await readFile(archive);
 if(standardSha(bytes)!==record.standardDeployment.packageSha256)throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 const manifest=validateApplicationManifest(JSON.parse(await readFile(path.join(directory,'application.manifest.json'),'utf8')));
 if(stableStandard(manifest)!==stableStandard(original)||stableStandard(await standardDeploymentFiles(directory,{installed:true,assertSession}))!==stableStandard(record.standardDeployment.files))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
 if(active){
  const parent=path.dirname(directory),marker=JSON.parse(await readFile(path.join(parent,'.wanx-managed-deployment.json'),'utf8')),
   pointer=JSON.parse(await readFile(path.join(parent,'.current-version.json'),'utf8'));
  if(stableStandard(marker)!==stableStandard(b)||pointer.key!==path.basename(directory))throw fail('APPLICATION_DEPLOYMENT_STALE');
  // Re-derive the expected inventory from the retained, verified ZIP at launch.
  // A mutable install record cannot bless changed code by rewriting its hashes.
  const staging=await mkdtemp(path.join(parent,'.verify-standard-'));
  try{
   const frozen=path.join(staging,'package.zip'),output=path.join(staging,'content');
   await writeFile(frozen,bytes,{flag:'wx',mode:0o600});await mkdir(output);
   await assertStandardDeploymentArchive(frozen);
   const source=await extractApplicationArchive(frozen,output);
   if(stableStandard(await standardDeploymentFiles(source,{assertSession}))!==stableStandard(record.standardDeployment.files))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
  }finally{await rm(staging,{recursive:true,force:true})}
 }
 assertSession();return original;
}

// These facts belong to one fresh list operation, not to an app ID or path.
// Object identity and a consumed fingerprint keep JSON clones and later mutations
// from turning stale metadata into a verified UI badge. Nothing is serialized.
const listedPresentationFacts=new WeakMap();
function presentationFingerprint(record){
 const manifest=standardDeploymentManifest(record);
 return standardSha(Buffer.from(stableStandard({manifest,installPath:record.installPath,
  descriptor:record.descriptor,deployment:record.deployment,standardDeployment:record.standardDeployment})));
}
export function createStandardDeploymentListing(){
 const verified=new Set();
 return {
  async verify(record){
   await verifyStandardDeploymentInstallation(record);
   verified.add(presentationFingerprint(record));
  },
  attest(record){
   const {presentation,...view}=record;
   try{
    const fingerprint=presentationFingerprint(view);
    if(verified.delete(fingerprint))listedPresentationFacts.set(view,fingerprint);
   }catch{/* Unverified records remain ordinary display records. */}
   return view;
  },
 };
}
// UI-only projection consumes the current list's fact; it performs no disk work.
export function applicationPresentation(record) {
 const {presentation,...view}=record,fingerprint=listedPresentationFacts.get(record);
 listedPresentationFacts.delete(record);
 if(!fingerprint)return view;
 try {
  if(presentationFingerprint(view)!==fingerprint)return view;
  const environment=record.deployment.environment;
  return {...view,presentation:{environment,label:environment==='dev'?'联调':'正式'}};
 }catch{return view}
}
