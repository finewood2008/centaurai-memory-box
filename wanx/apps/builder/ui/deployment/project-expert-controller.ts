import {errorMessage} from './model';
import type {DirectoryRelease} from './directory-controller';

type Request=(path:string,method?:string,body?:unknown)=>Promise<unknown>;
export type ExpertTemplate={resourceId:string;version:string;digest:string;name?:string};
export type ExpertVerification={schemaVersion:1;checks:[{id:'text-roundtrip';input:{text:string};expected:{contains:string}}]};
export type ExpertContract={template:ExpertTemplate;verification:ExpertVerification};
export type ExpertSource={artifactHash:string;version:string;versionRevision:number;taskId:string;contentHash:string;profile:'wanx-expert-app-v1'};
export type ProjectExpertContext={schemaVersion:1;profile:'wanx-expert-app-v1';available:boolean;reason:string|null;projectId:string;configuration:{revision:number;editable:boolean;contract:ExpertContract|null};templates:ExpertTemplate[];source:ExpertSource|null};
export type StudioDelivery={schemaVersion:1;profile:'wanx-expert-app-v1';release:DirectoryRelease;source:ExpertSource&{projectId:string}};
type State={context:ProjectExpertContext|null;loading:boolean;readError:string;saving:boolean;configurationPending:boolean;configurationError:string;exporting:boolean;exportPending:boolean;exportConfirmed:boolean;exportError:string;delivery:StudioDelivery|null;notice:string};
type Anchor={projectId:string;applicationId:string;source:{artifactHash:string;versionRevision:number}|null};
const PROFILE='wanx-expert-app-v1';
const fail=():never=>{throw Error('EXPERT_DELIVERY_RESPONSE_INVALID')};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const text=(v:unknown,max=128)=>typeof v==='string'&&v.trim().length>0&&v.length<=max?v:fail();
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)?v:fail();
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:fail();
const digest=(v:unknown)=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v)?v:fail();
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:fail();
const bool=(v:unknown)=>typeof v==='boolean'?v:fail();
const sameTemplate=(a:ExpertTemplate,b:ExpertTemplate)=>a.resourceId===b.resourceId&&a.version===b.version&&a.digest===b.digest;
function template(value:unknown):ExpertTemplate {
 const t=object(value),d=digest(t.digest),version=text(t.version);
 if(version!=='0.0.0+sha.'+d.slice(7,19))return fail();
 return{resourceId:id(t.resourceId),version,digest:d,...(t.name!==undefined?{name:text(t.name,256)}:{})};
}
function verification(value:unknown):ExpertVerification {
 const v=object(value);if(v.schemaVersion!==1||!Array.isArray(v.checks)||v.checks.length!==1)return fail();
 const check=object(v.checks[0]);if(check.id!=='text-roundtrip')return fail();
 return{schemaVersion:1,checks:[{id:'text-roundtrip',input:{text:text(object(check.input).text,4000)},expected:{contains:text(object(check.expected).contains,512)}}]};
}
function source(value:unknown):ExpertSource {
 const s=object(value);if(s.profile!==PROFILE)return fail();
 return{profile:PROFILE,artifactHash:hash(s.artifactHash),version:text(s.version),versionRevision:integer(s.versionRevision),taskId:id(s.taskId),contentHash:hash(s.contentHash)};
}
function context(value:unknown,anchor:Anchor):ProjectExpertContext {
 const c=object(value),configuration=object(c.configuration);
 if(c.schemaVersion!==1||c.profile!==PROFILE||c.projectId!==anchor.projectId||!Array.isArray(c.templates)||c.templates.length>512)return fail();
 const selected=configuration.contract===null?null:object(configuration.contract),s=c.source===null?null:source(c.source);
 if(s&&(!anchor.source||s.artifactHash!==anchor.source.artifactHash||s.versionRevision!==anchor.source.versionRevision))throw Error('VERSION_CHANGED');
 const templates=c.templates.map(template);if(new Set(templates.map(t=>t.resourceId)).size!==templates.length)return fail();
 return{schemaVersion:1,profile:PROFILE,available:bool(c.available),reason:c.reason===null?null:id(c.reason),projectId:anchor.projectId,
  configuration:{revision:integer(configuration.revision),editable:bool(configuration.editable),contract:selected?{template:template(selected.template),verification:verification(selected.verification)}:null},templates,source:s};
}
function delivery(value:unknown,anchor:Anchor,expected:ExpertSource):StudioDelivery {
 const d=object(value),r=object(d.release),s=source(d.source);
 if(d.schemaVersion!==1||d.profile!==PROFILE||object(d.source).projectId!==anchor.projectId||r.applicationId!==anchor.applicationId||r.version!==expected.version||
  (['artifactHash','version','versionRevision','taskId','contentHash'] as const).some(key=>s[key]!==expected[key]))return fail();
 return{schemaVersion:1,profile:PROFILE,release:{releaseId:id(r.releaseId),applicationId:anchor.applicationId,version:expected.version,name:text(r.name,256),directoryDigest:digest(r.directoryDigest)},source:{...s,projectId:anchor.projectId}};
}
function message(error:unknown):string {
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.message:'';
 const messages:Record<string,string>={EXPERT_DELIVERY_RESPONSE_INVALID:'交付信息与当前项目或版本不一致，请刷新工作台。',EXPERT_CONTRACT_REQUIRED:'请先选择专家合同，完成能力检查并生成、采用新版本。',EXPERT_DEPLOYMENT_REQUIRED:'专家业务需先部署到联调环境，再从已安装应用验证。',EXPERT_TEMPLATE_CHANGED:'专家模板内容已变化，请重新选择模板并生成新版本。',EXPERT_TEMPLATE_UNAVAILABLE:'当前盒子没有这个专家模板，请刷新后重新选择。',EXPERT_CONFIGURATION_CHANGED:'专家配置已变化，请刷新后重新确认。',VERSION_CHANGED:'已采用版本或版本状态已变化，请刷新工作台后重新确认。'};
 return messages[code]||errorMessage(error);
}
const rejected=(error:unknown)=>['VERSION_CHANGED','ARTIFACT_INTEGRITY_FAILED','USER_ADOPTION_REQUIRED','EXPERT_CONTRACT_REQUIRED','EXPERT_CONFIGURATION_CHANGED','EXPERT_TEMPLATE_CHANGED','EXPERT_TEMPLATE_UNAVAILABLE','EXPERT_BACKEND_INVALID','EXPERT_VERIFICATION_INVALID','EXPERT_INPUT_INVALID','INPUT_CREDENTIAL_DETECTED','BUILD_ACTIVE','INTERVIEW_BUSY','PRD_NOT_SYNCHRONIZED','STUDIO_ADMIN_REQUIRED','STUDIO_IDENTITY_FORBIDDEN','DEPLOYMENT_SOURCE_CONFLICT','DEPLOYMENT_ADAPTER_UNAVAILABLE'].includes(error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.message:'');

/** Project/adoption is captured at construction; changing it disposes this scope. */
export function createProjectExpertController(request:Request,anchor:Anchor) {
 let state:State={context:null,loading:false,readError:'',saving:false,configurationPending:false,configurationError:'',exporting:false,exportPending:false,exportConfirmed:false,exportError:'',delivery:null,notice:''};
 let disposed=false,read=0;
 let saveAttempt:{body:{operationId:string;expectedRevision:number;template:ExpertTemplate|null;verification:ExpertVerification|null}}|null=null;
 let exportAttempt:{body:{operationId:string;expectedArtifactHash:string;expectedVersionRevision:number};source:ExpertSource}|null=null;
 const listeners=new Set<()=>void>(),route=`/projects/${anchor.projectId}/deployment/expert`;
 const update=(patch:Partial<State>)=>{if(disposed)return;state={...state,...patch};for(const listener of listeners)listener();};
 const exportReady=()=>!disposed&&!state.loading&&!state.readError&&!state.saving&&!state.configurationPending&&!state.exporting&&Boolean(state.context?.available&&state.context.source);
 async function refresh() {
  if(disposed||state.loading||state.saving||state.exporting)return;
  const turn=++read;update({loading:true,readError:'',...(!state.exportPending?{exportConfirmed:false}:{})});
  try{const c=context(await request(route),anchor);if(!disposed&&turn===read)update({context:c});}
  catch(error){if(!disposed&&turn===read)update({readError:message(error),exportConfirmed:false});}
  finally{if(!disposed&&turn===read)update({loading:false});}
 }
 async function saveContract(selected:ExpertTemplate|null,check:ExpertVerification|null):Promise<boolean> {
  const c=state.context;
  if(disposed||!c?.available||!c.configuration.editable||state.loading||state.readError||state.saving||state.exporting||state.exportPending)return false;
  if(!saveAttempt){
   try{
    const ref=selected?template(selected):null,verificationValue=ref?verification(check):null;
    if(ref&&!c.templates.some(t=>sameTemplate(t,ref)))throw Error('EXPERT_TEMPLATE_UNAVAILABLE');
    saveAttempt={body:{operationId:crypto.randomUUID().replaceAll('-',''),expectedRevision:c.configuration.revision,template:ref?{resourceId:ref.resourceId,version:ref.version,digest:ref.digest}:null,verification:verificationValue}};
   }catch(error){update({configurationError:message(error)});return false;}
  }
  const attempt=saveAttempt,turn=++read;update({saving:true,configurationError:'',exportConfirmed:false,notice:''});
  try{
   const result=context(await request(route,'PUT',attempt.body),anchor);
   if(disposed||turn!==read)return false;
   saveAttempt=null;update({context:result,configurationPending:false,delivery:null,notice:'专家配置已保存。请重新检查能力并生成、采用新版本。'});return true;
  }catch(error){if(!disposed&&turn===read){const definite=rejected(error);if(definite)saveAttempt=null;update({configurationPending:!definite,configurationError:message(error),...(definite?{readError:'配置条件已变化，请刷新后重新确认。'}:{notice:'暂未确认保存结果。重试会沿用本次配置和请求标识。'})});}return false;}
  finally{if(!disposed&&turn===read)update({saving:false});}
 }
 async function exportRelease() {
  const c=state.context;if(!state.exportConfirmed||!exportReady()||!c?.source)return;
  if(!exportAttempt)exportAttempt={body:{operationId:crypto.randomUUID().replaceAll('-',''),expectedArtifactHash:c.source.artifactHash,expectedVersionRevision:c.source.versionRevision},source:{...c.source}};
  const attempt=exportAttempt,turn=++read;update({exporting:true,exportError:'',notice:''});
  try{
   const result=delivery(await request(`/projects/${anchor.projectId}/deployment/release`,'POST',attempt.body),anchor,attempt.source);
   if(disposed||turn!==read)return;
   exportAttempt=null;update({delivery:result,exportPending:false,exportConfirmed:false,notice:'已从采用成果冻结交付目录，请核对发布版本后再确认部署。'});
  }catch(error){if(!disposed&&turn===read){const definite=rejected(error);if(definite)exportAttempt=null;update({exportPending:!definite,exportError:message(error),...(definite?{readError:'源版本或交付条件已变化，请刷新后重新确认。',exportConfirmed:false}:{notice:'尚未确认导出结果。重试沿用原采用版本和同一个请求标识，不会自动部署。'})});}}
  finally{if(!disposed&&turn===read)update({exporting:false});}
 }
 return{getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);}},refresh,saveContract,exportRelease,exportReady,
  confirmExport(value:boolean){if(!disposed&&!state.exporting&&!state.exportPending)update({exportConfirmed:value&&exportReady()});},
  abandonExport(){if(!disposed&&!state.exporting){exportAttempt=null;update({exportPending:false,exportConfirmed:false,delivery:null,readError:'请刷新并核对已有交付记录，再准备新的导出。'});}},
  dispose(){disposed=true;read++;listeners.clear();},
 };
}
