import {mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {STANDARD_MAX_COMPRESSED_BYTES} from '../../../team-client/applications/standard-deployment-limits.mjs';
const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=value=>'sha256:'+createHash('sha256').update(stable(value)).digest('hex');
const standardFormat='wanx-standard-expert-client-v1';
const standardContract={id:'wanx.expert-app.v1',version:'1.0.0',collections:{state:{json:'string'}}};
export function deploymentPayloadDigest(payload){const {packageBase64,...metadata}=payload;return digest(payload.format===standardFormat?metadata:payload)}
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
export function deploymentTicket(value){
 if(!value||!id(value.id)||!id(value.operationId)||!['prepare_client','activate'].includes(value.step)||!['wanx-miniapp-v1','wanx-expert-app-v1'].includes(value.profile)||
  !Number.isSafeInteger(value.generation)||value.generation<1||!Number.isSafeInteger(value.fence)||value.fence<1||
  !/^[a-f0-9]{64}$/.test(value.artifactHash)||!/^sha256:[a-f0-9]{64}$/.test(value.payloadDigest)||
  !/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(value.slotApplicationId)||!(typeof value.baseApplicationId==='string'&&(value.profile==='wanx-miniapp-v1'?/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/:/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(value.baseApplicationId))||
  !id(value.projectId)||!['dev','prod'].includes(value.environment)||typeof value.boxId!=='string'||!value.boxId||
  typeof value.nonce!=='string'||value.nonce.length<16||value.nonce.length>256||value.scopeId!==undefined&&!/^[a-f0-9]{64}$/.test(value.scopeId))throw fail('DEPLOYMENT_TICKET_INVALID');
 return value;
}
async function save(file,value){const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temporary,file)}finally{await rm(temporary,{force:true})}}
async function ownedDirectory(directory){await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw fail('DEPLOYMENT_STORAGE_INVALID')}
/** Host main owns this worker. Its endpoints are deliberately absent from renderer routing. */
export function createDeploymentDelivery({session,scopeKey,root,assets,applications,onChanged=()=>{},intervalMs=2500,runtimeNamespace='workshop'}){
 if(!['studio','workshop'].includes(runtimeNamespace))throw fail('DEPLOYMENT_NAMESPACE_INVALID');
 let stopped=false,pending=false,scope='',controller=new AbortController();
 let retryAfter=0,retryDelay=0;
 const invalidate=()=>{controller.abort(fail('HOST_SESSION_EXPIRED'));controller=new AbortController();scope='';retryAfter=retryDelay=0};
 async function processTicket(raw,s,signal,clientId,directory){
  let leaseDeadline=0;
  let ticket=deploymentTicket(raw);const route='/deployment/client-deliveries/'+ticket.id;
  const check=()=>{signal.throwIfAborted();s.assertLive();if(scopeKey()!==scope)throw fail('HOST_SESSION_EXPIRED');if(leaseDeadline&&performance.now()>=leaseDeadline)throw fail('DEPLOYMENT_CLIENT_LEASE_EXPIRED')};
  check();const context=s.active.link.context();if(context.boxId&&context.boxId!==ticket.boxId)throw fail('DEPLOYMENT_TARGET_DENIED');
  const issued={...ticket},claimStart=performance.now();ticket=deploymentTicket(await s.request(route+'/claim','POST',{nonce:ticket.nonce,clientId}));
  const ticketKeys=['id','operationId','step','fence','generation','projectId','artifactHash','version','baseApplicationId','slotApplicationId','environment','boxId','profile','payloadDigest','scopeId'];
  if(ticketKeys.some(k=>ticket[k]!==issued[k]))throw fail('DEPLOYMENT_TICKET_CHANGED');
  leaseDeadline=claimStart+45000;check();
  const initial={...ticket};
  const renew=async()=>{const started=performance.now();const next=deploymentTicket(await s.request(route+'/claim','POST',{nonce:ticket.nonce,clientId}));leaseDeadline=started+45000;check();if(ticketKeys.some(k=>next[k]!==initial[k]))throw fail('DEPLOYMENT_TICKET_CHANGED');ticket=next};
  const acknowledgement=state=>({nonce:ticket.nonce,clientId,state,artifactHash:ticket.artifactHash,slotApplicationId:ticket.slotApplicationId,operationId:ticket.operationId,step:ticket.step,fence:ticket.fence,generation:ticket.generation,payloadDigest:ticket.payloadDigest});
  try {
  const payload=await s.request(route+'/payload');check();
  if(payload.format!==standardFormat)throw fail('STANDARD_PACKAGE_REQUIRED');
  if(deploymentPayloadDigest(payload)!==ticket.payloadDigest||payload.applicationId!==ticket.baseApplicationId||payload.artifactHash!==ticket.artifactHash||payload.version!==ticket.version||payload.runtimeNamespace!==runtimeNamespace)throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  const d=payload.deployment;
  for(const key of ['profile','operationId','generation','baseApplicationId','slotApplicationId','boxId','environment'])if(d?.[key]!==ticket[key])throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  if(runtimeNamespace!=='studio'||ticket.profile!=='wanx-expert-app-v1'||!ticket.scopeId||d.scopeId!==ticket.scopeId||d.schemaVersion!==1||
    stable(payload.runtimeContract)!==stable(standardContract)||payload.manifest?.applicationId!==ticket.baseApplicationId||payload.manifest?.version!==ticket.version||payload.name!==payload.manifest?.name||
    Object.keys(payload).sort().join()!==['format','applicationId','name','version','artifactHash','manifest','packageSha256','packageBase64','runtimeNamespace','runtimeContract','deployment'].sort().join()||
    !/^[a-f0-9]{64}$/.test(payload.packageSha256)||typeof payload.packageBase64!=='string'||payload.packageBase64.length>Math.ceil(STANDARD_MAX_COMPRESSED_BYTES/3)*4||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.packageBase64)||payload.packageBase64.length%4!==0)throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  const stage=path.join(directory,ticket.id);await ownedDirectory(stage);
  const packageDirectory=path.join(stage,'package');await rm(packageDirectory,{recursive:true,force:true});check();
  const binding={...d,fence:ticket.fence,artifactHash:ticket.artifactHash,ticketId:ticket.id,payloadDigest:ticket.payloadDigest};
  let standardInput;
  {
   const bytes=Buffer.from(payload.packageBase64,'base64');
   if(!bytes.length||bytes.length>STANDARD_MAX_COMPRESSED_BYTES||bytes.toString('base64')!==payload.packageBase64||createHash('sha256').update(bytes).digest('hex')!==payload.packageSha256||
     typeof applications.validateStandardDeployment!=='function'||typeof applications.installStandardDeployment!=='function')throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
   const archivePath=path.join(stage,'package.zip'),temporary=archivePath+'.'+randomUUID()+'.tmp';
   try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});check();await rename(temporary,archivePath)}finally{await rm(temporary,{force:true})}
   standardInput={archivePath,manifest:payload.manifest,binding,artifactHash:ticket.artifactHash,packageSha256:payload.packageSha256,assertSession:check};
   const validated=await applications.validateStandardDeployment(standardInput,{signal});check();
   if(validated?.validated!==true||validated.applicationId!==ticket.slotApplicationId||validated.packageApplicationId!==ticket.baseApplicationId||validated.artifactHash!==ticket.artifactHash||validated.packageSha256!==payload.packageSha256)throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  }
  await save(path.join(stage,'journal.json'),{operationId:ticket.operationId,generation:ticket.generation,fence:ticket.fence,payloadDigest:ticket.payloadDigest,state:'prepared'});
  let state='prepared';
  if(ticket.step==='activate'){
   await renew();check();
   await applications.installStandardDeployment(standardInput,{signal});
   check();
   const installed=(await applications.listInstalled()).find(value=>value.applicationId===ticket.slotApplicationId);check();
   if(!installed?.deployment||installed.deployment.operationId!==ticket.operationId||installed.deployment.generation!==ticket.generation||installed.deployment.artifactHash!==ticket.artifactHash)throw fail('INSTALLED_ARTIFACT_MISMATCH');
   {
    const record=JSON.parse(await readFile(path.join(installed.installPath,'.wanx-install.json'),'utf8')),
      original=JSON.parse(await readFile(path.join(installed.installPath,'application.manifest.json'),'utf8')),
      bytes=await readFile(path.join(installed.installPath,'.wanx-standard-package.zip'));check();
    if(record.applicationId!==ticket.slotApplicationId||record.packageApplicationId!==ticket.baseApplicationId||record.descriptor?.manifest?.applicationId!==ticket.baseApplicationId||
      record.descriptor?.sha256!==payload.packageSha256||record.standardDeployment?.format!==standardFormat||record.standardDeployment?.runtimeNamespace!==runtimeNamespace||
      stable(record.deployment)!==stable(binding)||original.applicationId!==ticket.baseApplicationId||original.version!==ticket.version||createHash('sha256').update(bytes).digest('hex')!==payload.packageSha256)throw fail('INSTALLED_ARTIFACT_MISMATCH');
   }
   state='active';await save(path.join(stage,'journal.json'),{operationId:ticket.operationId,generation:ticket.generation,fence:ticket.fence,payloadDigest:ticket.payloadDigest,state});
  }
  await renew();check();
  await s.request(route+'/ack','POST',acknowledgement(state));check();
  if(state==='active'){await onChanged();check();await applications.launch(ticket.slotApplicationId);check();}
  } catch(error) {
    try{check();await s.request(route+'/ack','POST',{...acknowledgement('failed'),errorCode:'CLIENT_UNAVAILABLE'})}catch{}
    throw error;
  }
 }
 async function tick(){
  if(stopped||pending)return;
  const key=scopeKey();if(scope&&scope!==key)invalidate();scope=key;
  if(performance.now()<retryAfter)return;
  const signal=controller.signal;pending=true;
  try{
   const s=await session();signal.throwIfAborted();s.assertLive();if(scopeKey()!==key)return;
   const directory=path.join(root,createHash('sha256').update(key).digest('hex'));await ownedDirectory(directory);
   const clientFile=path.join(directory,'client.json');let clientId;
   try{clientId=JSON.parse(await readFile(clientFile,'utf8')).clientId;if(typeof clientId!=='string'||!id(clientId))throw fail('DEPLOYMENT_STORAGE_INVALID')}
   catch(error){if(error.code!=='ENOENT')throw error;clientId=randomUUID().replaceAll('-','');await save(clientFile,{clientId})}
   const result=await s.request('/deployment/client-deliveries');signal.throwIfAborted();s.assertLive();
   if(!result||!Array.isArray(result.items)||result.items.length>100)throw fail('DEPLOYMENT_TICKET_INVALID');
   for(const ticket of result.items){try{await processTicket(ticket,s,signal,clientId,directory)}catch(error){signal.throwIfAborted();s.assertLive();/* Keep uncertain work pending; never fabricate an acknowledgement. */}}
   retryAfter=retryDelay=0;
  }catch{
   if(!signal.aborted){
    retryDelay=Math.min(60000,Math.max(intervalMs,retryDelay)*2);
    retryAfter=performance.now()+retryDelay;
   }
  }
  finally{pending=false}
 }
 const timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();
 return{tick,invalidate,close(){stopped=true;clearInterval(timer);controller.abort();}};
}
