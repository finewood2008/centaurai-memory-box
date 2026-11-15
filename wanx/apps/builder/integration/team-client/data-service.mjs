import {validatedCorrection,validatedDeletion} from './starlink/correction.mjs';
import {validatedWarehouseRename} from './starlink/warehouse-rename.mjs';
import { needsBundledStarlink } from '../bundled-starlink-version.mjs';
import {assistantAwareTeamDataService} from './assistant-team-data-addon.mjs';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SemanticaService} from './starlink/service.mjs';
import drive from './starlink/drive.cjs';
import {createDataShareAccess} from './data-share-service.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const ID='centaurai.wanx.semantica';
const ACTIONS=new Set(['initialize','warehouses','warehouse','create-warehouse','rename-warehouse','select-warehouse','documents','document','delete-document','correct','document-text','evidence','authorization-summary','jobs','graph','retrieval','search','retry-job','build-index','processing','reprocess-models','select-files','select-space-files','space-list','release-files','upload']);
const VIEWS=new Set(['warehouses','conversation','materials','graph','search','tasks','sensitive','models','skills','reasoning','api','data']);
const SOURCE_ACTIONS=new Set(['document-text','evidence','authorization-summary']);
const GOVERNANCE_ACTIONS=new Set(['governance-summary','governance-reviews','governance-detail','governance-resolve','governance-flag','governance-propose','governance-apply','governance-unflag']);
function operationId(value,required=false){
  if(value===undefined&&!required)return randomUUID();
  if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))throw fail('TEAM_DATA_TARGET_INVALID');
  return value;
}
function governanceRequest(action,input){
  const writing=!['governance-summary','governance-reviews','governance-detail'].includes(action);
  const fields={
    'governance-summary':[], 'governance-reviews':['offset','limit'], 'governance-detail':['reviewId'],
    'governance-resolve':['reviewId','actionId','reason'], 'governance-flag':['kind','targetId','reason'],
    'governance-propose':['reviewId','reason'], 'governance-apply':['proposalId','confirmed'], 'governance-unflag':['reviewId'],
  }[action];
  const allowed=['warehouseId',...fields,...(writing?['operationId','expectedRevision']:[])];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||
      typeof input.warehouseId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');
  const resource=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw fail('TEAM_DATA_TARGET_INVALID');return value;};
  const prefix='/warehouses/'+input.warehouseId+'/workbench/governance';
  if(action==='governance-summary')return {path:prefix+'/summary'};
  if(action==='governance-reviews'){
    const offset=input.offset??0,limit=input.limit??20;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('TEAM_DATA_TARGET_INVALID');
    return {path:prefix+'/reviews?'+new URLSearchParams({offset:String(offset),limit:String(limit)})};
  }
  if(action==='governance-detail')return {path:prefix+'/reviews/'+resource(input.reviewId)};
  const operation=operationId(input.operationId,true),revision=input.expectedRevision;
  if(!Number.isSafeInteger(revision)||revision<(action==='governance-flag'?0:1))throw fail('TEAM_DATA_TARGET_INVALID');
  const body={operation_id:operation,expected_revision:revision,_native_operation_id:operation};
  if(Object.hasOwn(input,'reason')){
    if(typeof input.reason!=='string'||input.reason.length>2000)throw fail('TEAM_DATA_TARGET_INVALID');
    body.reason=input.reason.trim();
  }
  let endpoint;
  if(action==='governance-flag'){
    if(!['entity','relation'].includes(input.kind))throw fail('TEAM_DATA_TARGET_INVALID');
    Object.assign(body,{kind:input.kind,target_id:resource(input.targetId),reason:body.reason??'用户标记待核对'});endpoint='/flag';
  }else if(action==='governance-resolve'){
    body.action_id=resource(input.actionId);endpoint='/reviews/'+resource(input.reviewId)+'/resolve';
  }else if(action==='governance-propose'){
    if(!body.reason)throw fail('TEAM_DATA_TARGET_INVALID');
    body.review_id=resource(input.reviewId);endpoint='/proposals';
  }else if(action==='governance-apply'){
    if(input.confirmed!==true)throw fail('TEAM_DATA_TARGET_INVALID');
    body.confirmed=true;endpoint='/proposals/'+resource(input.proposalId)+'/apply';
  }else {body.review_id=resource(input.reviewId);endpoint='/unflag';}
  return {path:prefix+endpoint,options:{method:'POST',body,timeoutMs:330000}};
}
function sourcePath(action,input){
  const fields=action==='document-text'?['warehouseId','id','versionId','start','end']:action==='evidence'?['warehouseId','id']:['warehouseId'];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))||
      typeof input.warehouseId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');
  const prefix='/warehouses/'+input.warehouseId;
  if(action==='authorization-summary')return prefix;
  if(typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.id))throw fail('TEAM_DATA_TARGET_INVALID');
  if(action==='evidence')return prefix+'/evidence/'+encodeURIComponent(input.id);
  const start=input.start??0,end=input.end;
  if(typeof input.versionId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.versionId)||
      !Number.isSafeInteger(start)||start<0||end!==undefined&&(!Number.isSafeInteger(end)||end<=start||end-start>65536))throw fail('TEAM_DATA_TARGET_INVALID');
  return prefix+'/documents/'+encodeURIComponent(input.id)+'/text?'+new URLSearchParams({version_id:input.versionId,start:String(start),...(end!==undefined?{end:String(end)}:{})});
}
async function authorizationSummary(service,warehouseId){
  const warehouse=await service.call('warehouse',{id:warehouseId}),keys=await service.call('keys',{warehouseId});
  if(warehouse?.id!==warehouseId||!Array.isArray(keys?.items)||keys.items.some(k=>!k||!Number.isFinite(k.expires_at)))throw fail('TEAM_DATA_RESPONSE_INVALID');
  const now=Date.now()/1000;
  return {warehouseId,warehouse:{id:warehouseId,name:warehouse.name},active_count:keys.items.filter(k=>!k.revoked_at&&k.expires_at>now).length,
    expired_count:keys.items.filter(k=>!k.revoked_at&&k.expires_at<=now).length,revoked_count:keys.items.filter(k=>k.revoked_at).length};
}
export function starlinkTarget(input={}){
  if(Object.keys(input).some(k=>!['warehouseId','view'].includes(k))||
     (input.warehouseId!=null&&!/^[a-f0-9-]{36}$/.test(input.warehouseId))||!VIEWS.has(input.view||'graph'))throw fail('TEAM_DATA_TARGET_INVALID');
  return {kind:'team-data',version:1,warehouseId:input.warehouseId||null,view:input.view||'graph'};
}
function createBaseTeamDataService({client,applications,selectFiles,starlinkPackageDir,writeClipboard,getMcpDetails,emit=()=>{}}){
  let service,serviceConnection,creating,scopeKey,share,disposed=false,scopeRevision=0;
  const key=()=>{const s=client.snapshot();return s.phase==='ready'?JSON.stringify([s.account?.accountId,s.account?.clientId,s.connection?.deviceId]):null};
  const invalidate=()=>{scopeRevision++;const old=service;service=null;serviceConnection=null;creating=null;scopeKey=null;old?.close();share?.clear();emit({type:'invalidated'})};
  const stop=client.subscribe(()=>{if(scopeKey&&scopeKey!==key())invalidate()});
  async function identity(){
    if(disposed)throw fail('TEAM_SESSION_CHANGED');
    const next=key();if(!next)throw fail('TEAM_SESSION_CHANGED');
    const connection=await client.applicationConnection('wanx');
    const context=connection.context(),state=client.snapshot();
    if(context.protocolVersion!==1||context.authorization!=null||context.dataIdentity||state.account?.phase!=='authenticated'||!context.accountId||!context.clientId||!context.boxId||context.accountId!==state.account.accountId||context.clientId!==state.account.clientId||context.boxId!==state.connection?.deviceId){invalidate();throw fail('TEAM_IDENTITY_INVALID')}
    const response=await connection.request({path:'/api/auth/me'});
    if(next!==key())throw fail('TEAM_SESSION_CHANGED');
    if(response.status!==200){invalidate();throw fail('TEAM_LOGIN_EXPIRED')}
    const me=JSON.parse(response.body.toString('utf8'));
    if(me.role!=='admin'||me.application_id!=='wanx'||!Number.isSafeInteger(me.id)||me.id<=0||me.id!==context.user?.id){invalidate();throw fail('TEAM_ADMIN_REQUIRED')}
    if(scopeKey&&scopeKey!==next)invalidate();
    scopeKey=next;return {connection,me,next};
  }
  async function connection(target){
    const {connection:base,me,next}=await identity();
    const assertLive=()=>{base.context();if(next!==key())throw fail('TEAM_SESSION_CHANGED')};
    return {...base,context:()=>{assertLive();return {...base.context(),user:me,dataScope:'team',starlinkTarget:target||null}},
      async request(input){
        assertLive();await identity();assertLive();
        const headers={...input.headers};delete headers['x-wanx-data-context'];
        if(/^\/api\/semantica\//.test(input.path)&&!input.path.startsWith('/api/semantica/open/'))headers['x-wanx-data-context']='team';
        const result=await base.request({...input,headers});assertLive();return result;
      }};
  }
  async function instance(){
    await identity();
    if(service){
      try{service.assertLive();serviceConnection.context();return service}
      catch{invalidate();await identity()}
    }
    if(creating)return creating;
    const version=scopeRevision;
    const pending=(async()=>{
      const base=await connection();
      if(version!==scopeRevision)throw fail('TEAM_SESSION_CHANGED');
      let candidate;
      const host={context:async()=>base.context(),
        // Platform subscribe emits health/directory snapshots too. Only a dead
        // captured connection invalidates this service, never a healthy snapshot.
        onSessionInvalidated:notify=>base.subscribe(()=>{
          try{base.context();return}catch{}
          if(service===candidate)invalidate();
          notify({type:'invalidated',code:'HOST_SESSION_EXPIRED'});
        }),close(){},
        async request(path,options={}){
          let {body,headers={},method='GET'}=options;
          if(body!=null&&!(body instanceof Uint8Array)){body=Buffer.from(JSON.stringify(body));headers={...headers,'content-type':'application/json'}}
          const r=await base.request({path,method,headers,...(body!=null?{body}:{})});
          return new Response(r.body.length?r.body:null,{status:r.status,headers:r.headers});
        }};
      host.drive=drive.createDriveClient(host);
      candidate=new SemanticaService({host,selectFiles,emit});
      try{candidate.context=base.context();candidate.assertLive();if(version!==scopeRevision)throw fail('TEAM_SESSION_CHANGED')}
      catch(error){candidate.close();throw error}
      service=candidate;serviceConnection=base;return candidate;
    })();
    creating=pending;
    try{return await pending}finally{if(creating===pending)creating=null}
  }
  share=createDataShareAccess({identity,instance,writeClipboard,getMcpDetails});
  async function installStarlink(){
    if(!starlinkPackageDir)throw fail('TEAM_STARLINK_NOT_INSTALLED');
    const temporary=await mkdtemp(path.join(os.tmpdir(),'wanx-starlink-'));
    async function materialize(source,target){
      await mkdir(target,{recursive:true});
      for(const entry of await readdir(source,{withFileTypes:true})){
        const from=path.join(source,entry.name),to=path.join(target,entry.name);
        if(entry.isDirectory())await materialize(from,to);
        else if(entry.isFile())await writeFile(to,await readFile(from),{flag:'wx'});
        else throw fail('TEAM_STARLINK_PACKAGE_INVALID');
      }
    }
    try{await materialize(starlinkPackageDir,path.join(temporary,'package'));await identity();const installed=await applications.install({sourceDir:path.join(temporary,'package')});await identity();return installed}
    finally{await rm(temporary,{recursive:true,force:true})}
  }
  return {connection,
    async action(action,input={}){
      if(action==='release-share-key')return share.action(action,input);
      await identity();
      if(share.supports(action))return share.action(action,input);
      if(action==='install-starlink')return installStarlink();
      if(action==='open-starlink'){
        const target=starlinkTarget(input);
        if(target.warehouseId)await (await instance()).call('warehouse',{id:target.warehouseId});
        const installed=(await applications.listInstalled()).find(a=>a.applicationId===ID);
        if(await needsBundledStarlink(installed,starlinkPackageDir,applications))await installStarlink();
        return applications.launch({applicationId:ID,launchContext:target});
      }
      if(!ACTIONS.has(action)&&!GOVERNANCE_ACTIONS.has(action))throw fail('TEAM_DATA_ACTION_DENIED');
      if(action==='correct')input=validatedCorrection(input);
      if(action==='rename-warehouse')input=validatedWarehouseRename(input);
      if(action==='delete-document')input=validatedDeletion(input);
      const source=SOURCE_ACTIONS.has(action)?sourcePath(action,input):null;
      const governance=GOVERNANCE_ACTIONS.has(action)?governanceRequest(action,input):null;
      if(action==='select-warehouse'&&input.warehouseId&&!/^[a-f0-9-]{36}$/.test(input.warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');
      if(action==='create-warehouse')input={name:input.name,description:input.description||'',operationId:operationId(input.operationId)};
      if(['retry-job','build-index'].includes(action))input={...input,operationId:operationId(input.operationId)};
      const active=await instance();
      if(governance){
        try{return await active.api(governance.path,governance.options)}
        catch(error){
          if(action!=='governance-summary'||error.code!=='SEMANTICA_OPERATION_NOT_ALLOWED')throw error;
          return {supported:false};
        }
      }
      if(source)return action==='authorization-summary'?authorizationSummary(active,input.warehouseId):active.api(source);
      if(['select-files','select-space-files','upload'].includes(action)&&!active.capabilities)active.capabilities=await active.api('/capabilities');
      return active.call(action,input);
    },
    close(){disposed=true;stop();invalidate()}
  };
}

export const createTeamDataService=options=>assistantAwareTeamDataService(createBaseTeamDataService,options);
