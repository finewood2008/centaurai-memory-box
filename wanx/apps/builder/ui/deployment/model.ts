export type Target = {organizationId:string;boxId:string;applicationId:string;environment:'dev'|'prod'};
export type ReleaseRef = {releaseId:string;bundleDigest:string};
export type ComponentResult = {componentId:string;role:string;required:boolean;status:string;actualVersion?:string;errorCode?:string};
export type Operation = {id:string;target:Target;kind:string;releaseRef:ReleaseRef|null;state:string;phase:string;revision:number;createdAt:number;updatedAt:number;deadline:number;commitStatus:string;committedGeneration:number|null;previousGeneration:number;components:ComponentResult[];errorCode:string|null};
export type Capabilities = {schemaVersion:1;available:boolean;reason:string|null;operations:string[]};
export type ProgressEvent = {sequence:number;operationId:string;operationRevision:number;createdAt:number;type:string;state?:string;phase?:string};
export type EventPage = {items:ProgressEvent[];nextCursor:number;hasMore:boolean};
export type Receipt = {receiptId:string;operationId:string;outcome:string;commitStatus:string;componentResults:ComponentResult[];observedAt:string};
export type Delivery = {receipt:Receipt;deliveryStatus:'pending'|'delivered';attempts:number};

export const TERMINAL = new Set(['succeeded','rejected','failed_recovered','failed_degraded','recovery_required']);
export const ACTIVE = new Set(['queued','preflight','preparing','verifying','reconciling','blocked','waiting_box','waiting_client','compensating','committing']);
export const canResume=(operation:Operation|null,capabilities:Capabilities|null)=>Boolean(operation&&capabilities?.available&&capabilities.operations.includes(operation.kind)&&ACTIVE.has(operation.state));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const operationPattern = /^[a-f0-9]{32}$/;
const object = (value:unknown):Record<string,unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DEPLOYMENT_RESPONSE_INVALID');
  return value as Record<string,unknown>;
};
const fail = ():never => {throw new Error('DEPLOYMENT_RESPONSE_INVALID')};
const text = (value:unknown,max=128):string => typeof value==='string' && value.length<=max ? value : fail();
const id = (value:unknown):string => typeof value==='string' && idPattern.test(value) ? value : fail();
const integer = (value:unknown):number => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : fail();
const timestamp = (value:unknown):number => typeof value==='number' && Number.isFinite(value) && value>=0 ? value : fail();
const boolean = (value:unknown):boolean => typeof value==='boolean' ? value : fail();
const array = (value:unknown,max=128):unknown[] => Array.isArray(value) && value.length<=max ? value : fail();
export const operationId = (value:unknown):string => typeof value==='string' && operationPattern.test(value) ? value : fail();
export function parseTarget(value:unknown):Target {
  const source=object(value),environment=source.environment;
  if(environment!=='dev'&&environment!=='prod')return fail();
  return {organizationId:id(source.organizationId),boxId:id(source.boxId),applicationId:id(source.applicationId),environment};
}
function parseComponents(value:unknown):ComponentResult[] {
  return array(value).map(item=>{
    const source=object(item);
    return {componentId:id(source.componentId),role:id(source.role),required:boolean(source.required),status:id(source.status),
      ...(source.actualVersion!=null?{actualVersion:text(source.actualVersion,256)}:{}),
      ...(source.error!==undefined?{errorCode:id(object(source.error).code)}:{})};
  });
}
export function parseCapabilities(value:unknown):Capabilities {
  const source=object(value);
  if(source.schemaVersion!==1)return fail();
  return {schemaVersion:1,available:boolean(source.available),reason:source.reason===null?null:id(source.reason),operations:array(source.operations).map(id)};
}
export function parseOperation(value:unknown):Operation {
  const source=object(value),release=source.releaseRef===null?null:object(source.releaseRef);
  const releaseRef=release?{releaseId:id(release.releaseId),bundleDigest:text(release.bundleDigest)}:null;
  if(releaseRef&&!/^sha256:[a-f0-9]{64}$/.test(releaseRef.bundleDigest))return fail();
  return {id:operationId(source.id),target:parseTarget(source.target),kind:id(source.kind),releaseRef,
    state:id(source.state),phase:id(source.phase),revision:integer(source.revision),createdAt:timestamp(source.createdAt),
    updatedAt:timestamp(source.updatedAt),deadline:timestamp(source.deadline),commitStatus:id(source.commitStatus),
    committedGeneration:source.committedGeneration===null?null:integer(source.committedGeneration),previousGeneration:integer(source.previousGeneration),
    components:parseComponents(source.components),errorCode:source.errorCode==null?null:id(source.errorCode)};
}
export function parseOperations(value:unknown):Operation[] {return array(object(value).items,100).map(parseOperation)}
export function parseEventPage(value:unknown,operation:string,after:number):EventPage {
  const source=object(value);
  let cursor=after;
  const items=array(source.items,100).map(item=>{
    const event=object(item),sequence=integer(event.sequence);
    if(event.operationId!==operation||sequence<=cursor)return fail();
    cursor=sequence;
    return {sequence,operationId:operationId(event.operationId),operationRevision:integer(event.operationRevision),createdAt:timestamp(event.createdAt),type:id(event.type),
      ...(event.state!==undefined?{state:id(event.state)}:{}),...(event.phase!==undefined?{phase:id(event.phase)}:{})};
  });
  const nextCursor=integer(source.nextCursor),hasMore=boolean(source.hasMore);
  if(nextCursor!==cursor||(hasMore&&!items.length))return fail();
  return {items,nextCursor,hasMore};
}
export function parseDelivery(value:unknown,operation:string):Delivery|null {
  if(value===null)return null;
  const source=object(value),receipt=object(source.receipt);
  if(receipt.operationId!==operation||(source.deliveryStatus!=='pending'&&source.deliveryStatus!=='delivered'))return fail();
  return {receipt:{receiptId:id(receipt.receiptId),operationId:operationId(receipt.operationId),outcome:id(receipt.outcome),commitStatus:id(receipt.commitStatus),componentResults:parseComponents(receipt.componentResults),observedAt:text(receipt.observedAt)},deliveryStatus:source.deliveryStatus,attempts:integer(source.attempts)};
}

const stateLabels:Record<string,string>={queued:'已受理，等待处理',preflight:'正在预检',preparing:'正在准备',verifying:'正在验证',committing:'正在提交版本切换',reconciling:'正在核对执行结果',blocked:'等待条件满足',waiting_box:'等待盒子连接',waiting_client:'等待客户端连接',compensating:'正在恢复原环境',succeeded:'部署操作成功',rejected:'请求未通过',failed_recovered:'操作失败，原环境已恢复',failed_degraded:'操作失败，环境需处理',recovery_required:'需要人工恢复'};
const phaseLabels:Record<string,string>={validating:'校验请求',preflight:'检查部署条件',prepare_backend:'准备后端',prepare_client:'准备客户端',prepare_channels:'准备应用入口',prepare_data:'准备数据',verify_candidate:'验证待部署版本',commit:'确认版本切换',activate:'激活版本',verify_active:'验证运行状态',manage:'执行管理操作',compensate:'恢复原环境',recover:'核对与恢复',completed:'处理结束'};
const kindLabels:Record<string,string>={deploy:'部署',promote:'转正式',rollback:'回滚',restart:'重启',stop:'停止',uninstall:'卸载',purge:'清除',recover:'恢复'};
const componentLabels:Record<string,string>={ready:'已就绪',pending:'等待处理',preparing:'准备中',prepared:'已准备',activating:'激活中',waiting:'等待中',waiting_box:'等待盒子',waiting_client:'等待客户端',failed:'失败',blocked:'受阻',unknown:'状态待核对',stopped:'已停止',uninstalled:'已卸载',purged:'已清除',skipped:'无需处理',not_required:'无需处理'};
export const stateLabel=(state:string)=>stateLabels[state]||'未知任务状态';
export const phaseLabel=(phase:string)=>phaseLabels[phase]||'待核对阶段';
export const kindLabel=(kind:string)=>kindLabels[kind]||'部署操作';
export const componentLabel=(status:string)=>componentLabels[status]||'状态待核对';
export const commitLabel=(status:string)=>status==='committed'?'已提交版本切换':status==='not_committed'?'尚未提交版本切换':'提交状态待核对';
export function errorMessage(error:unknown):string {
  const code=typeof error==='object'&&error?(error as {code?:unknown}).code:undefined;
  const value=typeof code==='string'?code:error instanceof Error?error.message:'';
  const messages:Record<string,string>={
    DEPLOYMENT_ADAPTER_UNAVAILABLE:'当前盒子的部署执行能力尚未接通，可查看已有记录。',
    DEPLOYMENT_RESPONSE_INVALID:'部署服务返回的数据暂时无法识别，请刷新或联系管理员。',
    DEPLOYMENT_OPERATION_NOT_FOUND:'这条部署记录已不可访问，请刷新列表。',
    DEPLOYMENT_RECEIPT_NOT_FOUND:'这条操作尚未生成结果回执，请稍后刷新。',
    DEPLOYMENT_TARGET_DENIED:'当前账号无权管理这个部署目标。',
    STUDIO_ADMIN_REQUIRED:'当前账号没有部署管理权限，请使用有权限的账号打开。',
    STUDIO_IDENTITY_FORBIDDEN:'当前账号没有部署管理权限。',
    WORKSHOP_IDENTITY_REQUIRED:'当前工坊身份已失效，请重新连接盒子并打开工坊。',
    WORKSHOP_SESSION_EXPIRED:'当前工坊会话已失效，请重新连接盒子并打开工坊。',
    HOST_SESSION_EXPIRED:'万象连接已失效，请重新连接盒子并打开工作台。',
    BOX_IDENTITY_UNAVAILABLE:'盒子连接已失效，请在万象重新连接后打开工作台。',
    AUTH_FAILED:'登录状态已失效，请在万象重新登录后打开工作台。',
    IDENTITY_REQUIRED:'请从已登录的万象客户端打开工作台。',
    DEPLOYMENT_AUTHORITY_UNAVAILABLE:'暂时无法确认部署权限，请稍后重试。',
    DEPLOYMENT_CONTEXT_REQUIRED:'当前版本的部署信息尚未就绪，请刷新后重试。',
    DEPLOYMENT_ATTEMPT_PENDING:'上一次部署请求结果尚未确认，请先刷新记录，或重试同一次请求。',
    DEPLOYMENT_GENERATION_CONFLICT:'目标环境已经变化，请读取最新部署状态。',
    RECORD_CHANGED:'项目已发生变化，请刷新并重新确认采用版本。',
    DEPLOYMENT_PROFILE_UNAVAILABLE:'当前盒子尚未开通此类应用的部署。',
    RUNTIME_INCOMPATIBLE:'当前版本使用的能力尚未支持此部署方式。',
    DEPLOYMENT_DEV_VERIFICATION_REQUIRED:'请先将同一版本部署到联调环境并验证，再部署到正式环境。',
    DEPLOYMENT_VERSION_CHANGED:'已采纳版本已经变化，请刷新工作台后重新确认。',
    DEPLOYMENT_PREPARATION_INVALID:'部署准备信息不完整，请刷新工作台后重试。',
    DEPLOYMENT_PREPARATION_NOT_FOUND:'这次部署准备已经失效，请重新准备部署。',
  };
  return messages[value]||'部署信息暂时无法读取或操作未完成，请刷新后重试。';
}
export function formatTime(value:number):string {
  const date=new Date(value*1000);
  return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'时间未知';
}


export type DeploymentEnvironment='dev'|'prod';
export type ProjectDeploymentContext={schemaVersion:1;profile:string;available:boolean;reason:string|null;projectId:string;applicationId:string;artifact:{hash:string;version:string}|null;target:Omit<Target,'environment'>|null;environments:{id:DeploymentEnvironment;generation:number;health:string;activeReleaseRef:ReleaseRef|null}[];supportedActions:string[]};
export type Preparation={schemaVersion:1;preparationId:string;projectId:string;artifactHash:string;environment:DeploymentEnvironment;expectedGeneration:number;releaseRef:ReleaseRef;target:Target};
const artifactHash=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail();
const releaseReference=(value:unknown):ReleaseRef=>{const source=object(value);const bundleDigest=text(source.bundleDigest);if(!/^sha256:[a-f0-9]{64}$/.test(bundleDigest))return fail();return{releaseId:id(source.releaseId),bundleDigest}};
export function parseProjectContext(value:unknown,projectId:string,applicationId:string):ProjectDeploymentContext {
 const source=object(value);if(source.schemaVersion!==1||source.projectId!==projectId||source.applicationId!==applicationId)return fail();
 const target=source.target===null?null:object(source.target),artifact=source.artifact===null?null:object(source.artifact);
 const environments=array(source.environments,2).map(value=>{const item=object(value);if(item.id!=='dev'&&item.id!=='prod')return fail();return{id:item.id as DeploymentEnvironment,generation:integer(item.generation),health:id(item.health),activeReleaseRef:item.activeReleaseRef===null?null:releaseReference(item.activeReleaseRef)}});
 if(new Set(environments.map(item=>item.id)).size!==environments.length)return fail();
 if(target&&target.applicationId!==applicationId||source.available===true&&(!target||environments.length===0))return fail();
 return{schemaVersion:1,profile:id(source.profile),available:boolean(source.available),reason:source.reason===null?null:id(source.reason),projectId:operationId(source.projectId),applicationId:id(source.applicationId),artifact:artifact?{hash:artifactHash(artifact.hash),version:text(artifact.version)}:null,target:target?{organizationId:id(target.organizationId),boxId:id(target.boxId),applicationId:id(target.applicationId)}:null,environments,supportedActions:array(source.supportedActions).map(id)};
}
export function parsePreparation(value:unknown,context:ProjectDeploymentContext,hash:string,environment:DeploymentEnvironment):Preparation {
 const source=object(value),target=parseTarget(source.target);if(source.schemaVersion!==1||source.projectId!==context.projectId||source.artifactHash!==hash||source.environment!==environment||!context.target||Object.entries(context.target).some(([key,value])=>target[key as keyof Target]!==value)||target.environment!==environment)return fail();
 return{schemaVersion:1,preparationId:id(source.preparationId),projectId:operationId(source.projectId),artifactHash:artifactHash(source.artifactHash),environment,expectedGeneration:integer(source.expectedGeneration),releaseRef:releaseReference(source.releaseRef),target};
}
