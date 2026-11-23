import {ACTIVE,parseOperation,parseOperations,parseDelivery,parseEventPage,errorMessage,deploymentErrorCode,type Operation,type ProgressEvent,type Delivery,type Target,type ReleaseRef,type DeploymentEnvironment} from './model';

type Request=(path:string,method?:string,body?:unknown)=>Promise<unknown>;
export type DirectoryRelease={releaseId:string;applicationId:string;name:string;version:string;directoryDigest:string};
export type DirectoryContext={schemaVersion:1;profile:'wanx-expert-app-v1';available:boolean;reason:string|null;releaseId:string;applicationId:string;artifact:{hash:string;version:string}|null;target:Omit<Target,'environment'>|null;environments:{id:DeploymentEnvironment;generation:number;health:string;activeReleaseRef:ReleaseRef|null}[];supportedActions:string[]};
type Preparation={preparationId:string;releaseId:string;directoryDigest:string;environment:DeploymentEnvironment;expectedGeneration:number;releaseRef:ReleaseRef;target:Target};
type Attempt={release:DirectoryRelease;context:DirectoryContext;environment:DeploymentEnvironment;operationId:string;idempotencyKey:string;preparation:Preparation|null};
export type DirectoryDeploymentState={releaseId:string;releases:DirectoryRelease[];available:boolean|null;reason:string|null;listing:boolean;listError:string;ingesting:boolean;importError:string;selected:DirectoryRelease|null;context:DirectoryContext|null;environment:DeploymentEnvironment;confirmed:boolean;refreshing:boolean;readError:string;submitting:boolean;pending:boolean;deploymentError:string;notice:string;operation:Operation|null;environmentOperation:Operation|null;receipt:Delivery|null;receiptLoaded:boolean;receiptError:string;events:ProgressEvent[];eventsLoading:boolean;eventsError:string;nextCursor:number;hasMore:boolean;eventsTruncated:boolean};
const emptyEvents=()=>({events:[] as ProgressEvent[],eventsLoading:false,eventsError:'',nextCursor:0,hasMore:false,eventsTruncated:false});
const PROFILE='wanx-expert-app-v1';
const base='/deployment/directory-releases';
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digestPattern=/^sha256:[a-f0-9]{64}$/;
const rejectedCodes=new Set(['DIRECTORY_RELEASE_NOT_FOUND','DIRECTORY_RELEASE_CHANGED','DEPLOYMENT_VERSION_CHANGED',
  'DEPLOYMENT_DEV_VERIFICATION_REQUIRED','DEPLOYMENT_PREPARATION_INVALID','DEPLOYMENT_PREPARATION_NOT_FOUND',
  'DEPLOYMENT_GENERATION_CONFLICT','DEPLOYMENT_ENVIRONMENT_BUSY','BREAKING_SCHEMA_CHANGE','STUDIO_ADMIN_REQUIRED','STUDIO_IDENTITY_FORBIDDEN',
  'DEPLOYMENT_TARGET_DENIED','AUTH_FAILED','IDENTITY_REQUIRED']);
const fail=():never=>{throw Error('DEPLOYMENT_RESPONSE_INVALID')};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const text=(v:unknown,max=128):string=>typeof v==='string'&&v.length>0&&v.length<=max?v:fail();
const id=(v:unknown):string=>typeof v==='string'&&idPattern.test(v)?v:fail();
const digest=(v:unknown):string=>typeof v==='string'&&digestPattern.test(v)?v:fail();
const integer=(v:unknown):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:fail();
const bool=(v:unknown):boolean=>typeof v==='boolean'?v:fail();
const array=(v:unknown,max=128):unknown[]=>Array.isArray(v)&&v.length<=max?v:fail();
const ref=(v:unknown):ReleaseRef=>{const r=object(v);return{releaseId:id(r.releaseId),bundleDigest:digest(r.bundleDigest)}};
const sameTarget=(a:Target,b:Target)=>a.applicationId===b.applicationId&&a.organizationId===b.organizationId&&a.boxId===b.boxId&&a.environment===b.environment;
const target=(v:unknown):Target=>{const t=object(v);if(t.environment!=='dev'&&t.environment!=='prod')return fail();return{organizationId:id(t.organizationId),boxId:id(t.boxId),applicationId:id(t.applicationId),environment:t.environment}};
function release(value:unknown,expected?:string):DirectoryRelease {
  const r=object(value),releaseId=id(r.releaseId);
  if(expected&&releaseId!==expected)return fail();
  return{releaseId,applicationId:id(r.applicationId),name:text(r.name,256),version:text(r.version),directoryDigest:digest(r.directoryDigest)};
}
function context(value:unknown,selected:DirectoryRelease):DirectoryContext {
  const c=object(value);
  if(c.schemaVersion!==1||c.profile!==PROFILE||c.releaseId!==selected.releaseId||c.applicationId!==selected.applicationId)return fail();
  const a=c.artifact===null?null:object(c.artifact),t=c.target===null?null:object(c.target);
  if(a&&(typeof a.hash!=='string'||!/^[a-f0-9]{64}$/.test(a.hash)||a.version!==selected.version))return fail();
  if(t&&t.applicationId!==selected.applicationId)return fail();
  const environments=array(c.environments,2).map(value=>{const e=object(value);if(e.id!=='dev'&&e.id!=='prod')return fail();return{id:e.id as DeploymentEnvironment,generation:integer(e.generation),health:id(e.health),activeReleaseRef:e.activeReleaseRef===null?null:ref(e.activeReleaseRef)}});
  if(new Set(environments.map(e=>e.id)).size!==environments.length)return fail();
  if(c.available===true&&(!a||!t||!environments.length))return fail();
  const capabilities=array(c.supportedCapabilities).map(id);
  if(capabilities.some(cap=>!['data','foundation'].includes(cap))||new Set(capabilities).size!==capabilities.length||(c.available===true&&(!capabilities.includes('data')||!capabilities.includes('foundation'))))return fail();
  return{schemaVersion:1,profile:PROFILE,available:bool(c.available),reason:c.reason===null?null:id(c.reason),releaseId:selected.releaseId,applicationId:selected.applicationId,
    artifact:a?{hash:a.hash as string,version:a.version as string}:null,target:t?{organizationId:id(t.organizationId),boxId:id(t.boxId),applicationId:id(t.applicationId)}:null,environments,supportedActions:array(c.supportedActions).map(id)};
}
function preparation(value:unknown,attempt:Attempt):Preparation {
  const p=object(value),t=target(p.target),c=attempt.context;
  if(p.schemaVersion!==1||p.releaseId!==attempt.release.releaseId||p.directoryDigest!==attempt.release.directoryDigest||p.environment!==attempt.environment||!c.target||!sameTarget(t,{...c.target,environment:attempt.environment}))return fail();
  return{preparationId:id(p.preparationId),releaseId:id(p.releaseId),directoryDigest:digest(p.directoryDigest),environment:attempt.environment,expectedGeneration:integer(p.expectedGeneration),releaseRef:ref(p.releaseRef),target:t};
}
function message(error:unknown):string {
  const code=deploymentErrorCode(error);
  const messages:Record<string,string>={DIRECTORY_RELEASE_NOT_FOUND:'当前账号下未找到这个交付版本，请核对版本标识，并确认已投递到当前盒子。',DIRECTORY_RELEASE_CHANGED:'交付目录内容已变化，请重新读取确定版本。',DIRECTORY_RELEASE_CONFLICT:'这个版本标识已对应另一份交付内容，请使用新交付的版本标识重新读取。',DIRECTORY_SOURCE_INCOMPLETE:'交付文件尚不完整，请等待投递完成后重新读取；若仍失败，请联系交付方。',DIRECTORY_SOURCE_UNSAFE:'交付目录无法安全读取，请联系管理员检查目录权限和交付文件。',DIRECTORY_MANIFEST_INVALID:'交付清单或文件不符合部署标准，请开物团队检查。',EXPERT_TEMPLATE_CHANGED:'专家模板版本已经变化，请重新交付并验证。',EXPERT_TEMPLATE_UNAVAILABLE:'当前盒子没有这个版本所需的专家模板。'};
  return messages[code]||errorMessage(error);
}

/** One controller belongs to one authenticated workbench scope. No filesystem paths cross this interface. */
export function createDirectoryDeploymentController(request:Request,initialReleaseId='') {
  let state:DirectoryDeploymentState={releaseId:initialReleaseId,releases:[],available:null,reason:null,listing:false,listError:'',ingesting:false,importError:'',selected:null,context:null,environment:'dev',confirmed:false,refreshing:false,readError:'',submitting:false,pending:false,deploymentError:'',notice:'',operation:null,environmentOperation:null,receipt:null,receiptLoaded:false,receiptError:'',...emptyEvents()};
  let disposed=false,scope=0,listTurn=0,readTurn=0,eventsTurn=0,attempt:Attempt|null=null;
  const listeners=new Set<()=>void>();
  const update=(patch:Partial<DirectoryDeploymentState>)=>{if(disposed)return;state={...state,...patch};for(const listener of listeners)listener()};
  const current=(turn:number)=>!disposed&&scope===turn;
  function deployReady() {
    return !disposed&&state.available===true&&!state.listError&&!state.importError&&!state.readError&&!state.receiptError&&!state.ingesting&&!state.refreshing&&!state.submitting&&Boolean(state.selected&&state.context?.available&&state.context.profile===PROFILE&&state.context.target&&state.context.artifact&&state.context.releaseId===state.selected.releaseId&&state.releaseId===state.selected.releaseId&&state.context.supportedActions.includes('deploy')&&state.context.environments.some(e=>e.id===state.environment))&&(!state.environmentOperation||!ACTIVE.has(state.environmentOperation.state))&&(state.pending||!state.operation||!ACTIVE.has(state.operation.state));
  }
  async function loadReleases() {
    if(disposed||state.listing)return;
    const turn=++listTurn;update({listing:true,listError:''});
    try{
      const result=object(await request(base));
      if(disposed||turn!==listTurn)return;
      if(result.schemaVersion!==1||result.profile!==PROFILE)return fail();
      const releases=array(result.items,100).map(value=>release(value));
      if(new Set(releases.map(r=>r.releaseId)).size!==releases.length)return fail();
      update({releases,available:bool(result.available),reason:result.reason===null?null:id(result.reason)});
    }catch(error){if(!disposed&&turn===listTurn)update({available:false,listError:message(error),...(!state.pending?{confirmed:false}:{})});}
    finally{if(!disposed&&turn===listTurn)update({listing:false});}
  }
  function setReleaseId(value:string) {
    if(disposed||state.submitting||state.pending||value===state.releaseId)return;
    scope++;readTurn++;attempt=null;
    update({releaseId:value,selected:null,context:null,confirmed:false,ingesting:false,refreshing:false,importError:'',readError:'',deploymentError:'',notice:'',operation:null,environmentOperation:null,receipt:null,receiptLoaded:false,receiptError:'',...emptyEvents()});
  }
  function setEnvironment(environment:DeploymentEnvironment) {
    if(disposed||state.pending||state.submitting||state.ingesting||!['dev','prod'].includes(environment)||environment===state.environment)return;
    scope++;readTurn++;attempt=null;
    update({environment,confirmed:false,refreshing:false,readError:'',deploymentError:'',notice:'',operation:null,environmentOperation:null,receipt:null,receiptLoaded:false,receiptError:'',...emptyEvents()});
  }
  function operation(value:unknown,c:DirectoryContext,environment:DeploymentEnvironment,expectedId?:string,expectedRelease?:ReleaseRef) {
    const o=parseOperation(value);
    if(!c.target||o.kind!=='deploy'||!sameTarget(o.target,{...c.target,environment})||(expectedId&&o.id!==expectedId)||(expectedRelease&&(o.releaseRef?.releaseId!==expectedRelease.releaseId||o.releaseRef?.bundleDigest!==expectedRelease.bundleDigest)))return fail();
    return o;
  }
  async function loadEvents() {
    const id=state.operation?.id,turn=scope,read=readTurn;
    if(disposed||!id||state.eventsLoading)return;
    const after=state.nextCursor,version=++eventsTurn;
    const matches=()=>current(turn)&&read===readTurn&&version===eventsTurn&&state.operation?.id===id;
    update({eventsLoading:true,eventsError:''});
    try{
      const page=parseEventPage(await request(`/deployment/operations/${id}/events?after=${after}&limit=100`),id,after);
      if(!matches())return;
      const events=[...state.events,...page.items];
      update({events:events.slice(-1000),nextCursor:page.nextCursor,hasMore:page.hasMore,eventsTruncated:state.eventsTruncated||events.length>1000});
    }catch(error){if(matches())update({eventsError:message(error)});}
    finally{if(matches())update({eventsLoading:false});}
  }
  async function refresh() {
    const selected=state.selected,turn=scope,environment=state.environment;
    if(disposed||!selected||state.ingesting||state.submitting)return;
    const read=++readTurn;eventsTurn++;
    update({refreshing:true,eventsLoading:false,readError:'',receiptError:'',...(!state.pending?{confirmed:false}:{})});
    try{
      const c=context(await request(`${base}/${selected.releaseId}/context`),selected);
      if(!current(turn)||read!==readTurn)return;
      if(attempt&&(!c.target||!attempt.context.target||!sameTarget({...c.target,environment},{...attempt.context.target,environment})||c.artifact?.hash!==attempt.context.artifact?.hash))return fail();
      update({context:c});
      // The selected release result and the environment lock are different scopes.
      // Always check the environment even when this release has terminal history.
      const items=parseOperations(await request('/deployment/operations?limit=100'));
      if(!current(turn)||read!==readTurn)return;
      const scoped=c.target?items.filter(o=>sameTarget(o.target,{...c.target!,environment})).sort((a,b)=>b.createdAt-a.createdAt):[];
      const knownOther=state.environmentOperation;
      if(knownOther&&ACTIVE.has(knownOther.state)&&!scoped.some(o=>o.id===knownOther.id)){
        // A bounded history page cannot prove an in-flight environment lock ended.
        const observed=parseOperation(await request(`/deployment/operations/${knownOther.id}`));
        if(!current(turn)||read!==readTurn)return;
        if(!c.target||observed.id!==knownOther.id||observed.kind!==knownOther.kind||!sameTarget(observed.target,{...c.target,environment})||
          observed.releaseRef?.releaseId!==knownOther.releaseRef?.releaseId||observed.releaseRef?.bundleDigest!==knownOther.releaseRef?.bundleDigest)return fail();
        scoped.push(observed.revision>=knownOther.revision?observed:knownOther);scoped.sort((a,b)=>b.createdAt-a.createdAt);
      }
      let o=state.operation;
      if(o){
        const observed=operation(await request(`/deployment/operations/${o.id}`),c,environment,o.id,o.releaseRef||undefined);
        if(!current(turn)||read!==readTurn)return;
        if(observed.revision>=o.revision)o=observed;
        const index=scoped.findIndex(item=>item.id===o!.id);
        if(index>=0)scoped[index]=o;else scoped.push(o);
        scoped.sort((a,b)=>b.createdAt-a.createdAt);
      }
      const selectedOperations=scoped.filter(item=>item.kind==='deploy'&&item.releaseRef?.releaseId===selected.releaseId);
      o=selectedOperations.find(item=>ACTIVE.has(item.state))||selectedOperations[0]||o;
      if(!current(turn)||read!==readTurn)return;
      const other=scoped.filter(item=>item.kind!=='deploy'||item.releaseRef?.releaseId!==selected.releaseId);
      const activeOther=other.find(item=>ACTIVE.has(item.state));
      const latest=scoped[0];
      update({environmentOperation:activeOther||(latest&&other.includes(latest)?latest:null)});
      if(o&&(!state.operation||state.operation.id!==o.id||o.revision>=state.operation.revision))update({operation:o,...(state.operation?.id!==o.id?{receipt:null,receiptLoaded:false,...emptyEvents()}:{})});
      if(o){
        try{
          const delivery=parseDelivery(await request(`/deployment/operations/${o.id}/receipt`),o.id);
          if(current(turn)&&read===readTurn)update({receipt:delivery,receiptLoaded:true});
        }catch(error){if(current(turn)&&read===readTurn)update({receiptError:message(error)});}
        if(current(turn)&&read===readTurn)await loadEvents();
      }else update({operation:null,receipt:null,receiptLoaded:true,...emptyEvents()});
    }catch(error){if(current(turn)&&read===readTurn)update({readError:message(error),...(!state.pending?{confirmed:false}:{})});}
    finally{if(current(turn)&&read===readTurn)update({refreshing:false});}
  }
  async function ingest() {
    const releaseId=state.releaseId;
    if(disposed||state.ingesting||state.pending||state.submitting||state.available!==true||state.listError)return;
    if(!idPattern.test(releaseId)){update({importError:'请填写有效的交付版本标识，只使用字母、数字、点、横线或下划线。'});return;}
    const turn=++scope;readTurn++;attempt=null;
    update({ingesting:true,selected:null,context:null,importError:'',readError:'',confirmed:false,operation:null,environmentOperation:null,receipt:null,receiptLoaded:false,receiptError:'',deploymentError:'',notice:'',...emptyEvents()});
    try{
      const selected=release(await request(`${base}/${releaseId}/ingest`,'POST',{}),releaseId);
      if(!current(turn))return;
      const c=context(await request(`${base}/${releaseId}/context`),selected);
      if(!current(turn))return;
      update({selected,context:c,notice:'已读取并校验交付版本，请核对目标环境后部署。'});
    }catch(error){if(current(turn))update({importError:message(error)});}
    finally{if(current(turn))update({ingesting:false});}
    if(current(turn)&&state.selected)await refresh();
  }
  async function deploy() {
    if(!state.confirmed||!deployReady()||!state.selected||!state.context)return;
    const turn=scope;
    if(!attempt){const operationId=crypto.randomUUID().replaceAll('-','');attempt={release:{...state.selected},context:state.context,environment:state.environment,operationId,idempotencyKey:'directory-'+operationId,preparation:null};}
    const a=attempt;
    if(a.release.releaseId!==state.selected.releaseId||a.release.directoryDigest!==state.selected.directoryDigest||a.environment!==state.environment)return;
    // A previous submit may have reached the server. A later rejected retry
    // cannot prove that first request was rejected or release its identity.
    const submissionUncertain=state.pending&&a.preparation!==null;
    update({submitting:true,deploymentError:'',notice:''});
    try{
      if(!a.preparation){
        const value=await request(`${base}/${a.release.releaseId}/prepare`,'POST',{directoryDigest:a.release.directoryDigest,environment:a.environment,operationId:a.operationId});
        if(!current(turn))return;
        a.preparation=preparation(value,a);
      }
      const p=a.preparation;
      const value=await request(`${base}/${a.release.releaseId}/submit`,'POST',{preparationId:p.preparationId,idempotencyKey:a.idempotencyKey});
      if(!current(turn))return;
      const o=operation(value,a.context,a.environment);
      if(o.previousGeneration!==p.expectedGeneration||o.releaseRef?.releaseId!==p.releaseRef.releaseId||o.releaseRef?.bundleDigest!==p.releaseRef.bundleDigest)return fail();
      attempt=null;eventsTurn++;
      update({pending:false,confirmed:false,operation:o,...emptyEvents(),receipt:null,receiptLoaded:false,notice:'部署请求已受理，正在等待后端与客户端实际执行结果。'});
    }catch(error){if(current(turn)){
      const code=deploymentErrorCode(error);
      const rejected=!submissionUncertain&&rejectedCodes.has(code);
      if(rejected)attempt=null;
      update({pending:!rejected,confirmed:!rejected,deploymentError:message(error),...(rejected?{readError:'部署条件已变化，请刷新并重新确认。'}:{notice:'提交结果尚未确认。请先刷新记录；重试将沿用本次准备和请求标识。'})});
    }}finally{if(current(turn))update({submitting:false});}
    if(current(turn)&&state.operation)await refresh();
  }
  return{getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},loadReleases,setReleaseId,setEnvironment,ingest,refresh,loadEvents,deploy,deployReady,
    confirm(value:boolean){if(!disposed&&!state.submitting&&!state.pending)update({confirmed:value&&deployReady()});},
    shouldPoll:()=>!disposed&&!state.submitting&&!state.ingesting&&!state.refreshing&&Boolean(state.environmentOperation&&ACTIVE.has(state.environmentOperation.state)||state.operation&&(ACTIVE.has(state.operation.state)||state.receipt?.deliveryStatus==='pending')),
    dispose(){disposed=true;scope++;listTurn++;readTurn++;listeners.clear();},
  };
}
