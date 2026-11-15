import {mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writeMiniappPackage} from '../../core/package.mjs';
const fail=code=>Object.assign(Error(code),{code});
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=value=>'sha256:'+createHash('sha256').update(stable(value)).digest('hex');
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
export function deploymentTicket(value){
 if(!value||!id(value.id)||!id(value.operationId)||!['prepare_client','activate'].includes(value.step)||!['wanx-miniapp-v1','wanx-expert-app-v1'].includes(value.profile)||
  !Number.isSafeInteger(value.generation)||value.generation<1||!Number.isSafeInteger(value.fence)||value.fence<1||
  !/^[a-f0-9]{64}$/.test(value.artifactHash)||!/^sha256:[a-f0-9]{64}$/.test(value.payloadDigest)||
  !/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(value.slotApplicationId)||!(typeof value.baseApplicationId==='string'&&(value.profile==='wanx-miniapp-v1'?/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/:/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(value.baseApplicationId))||
  !id(value.projectId)||!['dev','prod'].includes(value.environment)||typeof value.boxId!=='string'||!value.boxId||
  typeof value.nonce!=='string'||value.nonce.length<16||value.nonce.length>256)throw fail('DEPLOYMENT_TICKET_INVALID');
 return value;
}
async function save(file,value){const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temporary,file)}finally{await rm(temporary,{force:true})}}
async function ownedDirectory(directory){await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw fail('DEPLOYMENT_STORAGE_INVALID')}
/** Host main owns this worker. Its endpoints are deliberately absent from renderer routing. */
export function createDeploymentDelivery({session,scopeKey,root,assets,applications,onChanged=()=>{},intervalMs=2500,runtimeNamespace='workshop'}){
 if(!['studio','workshop'].includes(runtimeNamespace))throw fail('DEPLOYMENT_NAMESPACE_INVALID');
 let stopped=false,pending=false,scope='',controller=new AbortController();
 const invalidate=()=>{controller.abort(fail('HOST_SESSION_EXPIRED'));controller=new AbortController();scope=''};
 async function processTicket(raw,s,signal,clientId,directory){
  let leaseDeadline=0;
  let ticket=deploymentTicket(raw);const route='/deployment/client-deliveries/'+ticket.id;
  const check=()=>{signal.throwIfAborted();s.assertLive();if(scopeKey()!==scope)throw fail('HOST_SESSION_EXPIRED');if(leaseDeadline&&performance.now()>=leaseDeadline)throw fail('DEPLOYMENT_CLIENT_LEASE_EXPIRED')};
  check();const context=s.active.link.context();if(context.boxId&&context.boxId!==ticket.boxId)throw fail('DEPLOYMENT_TARGET_DENIED');
  const issued={...ticket},claimStart=performance.now();ticket=deploymentTicket(await s.request(route+'/claim','POST',{nonce:ticket.nonce,clientId}));
  if(['id','operationId','step','fence','generation','projectId','artifactHash','version','baseApplicationId','slotApplicationId','environment','boxId','profile','payloadDigest'].some(k=>ticket[k]!==issued[k]))throw fail('DEPLOYMENT_TICKET_CHANGED');
  leaseDeadline=claimStart+45000;check();
  const initial={...ticket};
  const renew=async()=>{const started=performance.now();const next=deploymentTicket(await s.request(route+'/claim','POST',{nonce:ticket.nonce,clientId}));leaseDeadline=started+45000;check();if(next.id!==initial.id||next.operationId!==initial.operationId||next.payloadDigest!==initial.payloadDigest||next.generation!==initial.generation||next.fence!==initial.fence||next.step!==initial.step)throw fail('DEPLOYMENT_TICKET_CHANGED');ticket=next};
  const acknowledgement=state=>({nonce:ticket.nonce,clientId,state,artifactHash:ticket.artifactHash,slotApplicationId:ticket.slotApplicationId,operationId:ticket.operationId,step:ticket.step,fence:ticket.fence,generation:ticket.generation,payloadDigest:ticket.payloadDigest});
  try {
  const payload=await s.request(route+'/payload');check();
  if(digest(payload)!==ticket.payloadDigest||payload.applicationId!==ticket.slotApplicationId||payload.artifactHash!==ticket.artifactHash||payload.version!==ticket.version||payload.runtimeNamespace!==runtimeNamespace)throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  const d=payload.deployment;
  for(const key of ['profile','operationId','generation','baseApplicationId','slotApplicationId','boxId','environment'])if(d?.[key]!==ticket[key])throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  const stage=path.join(directory,ticket.id);await ownedDirectory(stage);
  const packageDirectory=path.join(stage,'package');await rm(packageDirectory,{recursive:true,force:true});check();
  await writeMiniappPackage(payload,packageDirectory,{assets});check();
  const actual=JSON.parse(await readFile(path.join(packageDirectory,'miniapp.runtime.json'),'utf8'));
  if(actual.artifactHash!==ticket.artifactHash||actual.runtimeNamespace!==runtimeNamespace||stable(actual.deployment)!==stable(d))throw fail('DEPLOYMENT_PAYLOAD_MISMATCH');
  await save(path.join(stage,'journal.json'),{operationId:ticket.operationId,generation:ticket.generation,fence:ticket.fence,payloadDigest:ticket.payloadDigest,state:'prepared'});
  let state='prepared';
  if(ticket.step==='activate'){
   await renew();check();
   const binding={...d,fence:ticket.fence,artifactHash:ticket.artifactHash};
   await applications.installDeployment({sourceDir:packageDirectory,binding,assertSession:check},{signal});check();
   const installed=(await applications.listInstalled()).find(value=>value.applicationId===ticket.slotApplicationId);check();
   if(!installed?.deployment||installed.deployment.operationId!==ticket.operationId||installed.deployment.generation!==ticket.generation||installed.deployment.artifactHash!==ticket.artifactHash)throw fail('INSTALLED_ARTIFACT_MISMATCH');
   const record=JSON.parse(await readFile(path.join(installed.installPath,'miniapp.runtime.json'),'utf8'));check();
   if(record.applicationId!==ticket.slotApplicationId||record.artifactHash!==ticket.artifactHash||record.runtimeNamespace!==runtimeNamespace||stable(record.deployment)!==stable(d))throw fail('INSTALLED_ARTIFACT_MISMATCH');
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
  }catch{/* Reconnect and retry through the ordinary authenticated client session. */}
  finally{pending=false}
 }
 const timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();
 return{tick,invalidate,close(){stopped=true;clearInterval(timer);controller.abort();}};
}
