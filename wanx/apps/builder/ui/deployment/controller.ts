import {errorMessage,parseProjectContext,parsePreparation,parseCapabilities,parseOperations,parseOperation,parseEventPage,parseDelivery,ACTIVE,canResume,type ProjectDeploymentContext,type Preparation,type DeploymentEnvironment,type Capabilities,type Operation,type ProgressEvent,type Delivery} from './model';

type Request=(path:string,method?:string,body?:unknown)=>Promise<unknown>;
export type DeploymentState={context:ProjectDeploymentContext|null;contextError:string;deploying:boolean;deploymentPending:boolean;deploymentError:string;deploymentNotice:string;submittedId:string|null;capabilities:Capabilities|null;capabilityError:string;loading:boolean;operations:Operation[];listError:string;listedCount:number;selectedId:string|null;operation:Operation|null;detailLoading:boolean;detailError:string;events:ProgressEvent[];eventsLoading:boolean;eventsError:string;nextCursor:number;hasMore:boolean;eventsTruncated:boolean;receipt:Delivery|null;receiptLoaded:boolean;receiptError:string;actionPending:'resume'|'receipt'|null;notice:string;actionError:string};
export const initialState=():DeploymentState=>({context:null,contextError:'',deploying:false,deploymentPending:false,deploymentError:'',deploymentNotice:'',submittedId:null,capabilities:null,capabilityError:'',loading:true,operations:[],listError:'',listedCount:0,selectedId:null,operation:null,detailLoading:false,detailError:'',events:[],eventsLoading:false,eventsError:'',nextCursor:0,hasMore:false,eventsTruncated:false,receipt:null,receiptLoaded:false,receiptError:'',actionPending:null,notice:'',actionError:''});

/** All data enters through the same authenticated request function as Builder. */
export function createDeploymentController(request:Request,applicationId:string,projectId?:string) {
  let state=initialState(),disposed=false,refreshing=false,selection=0,detailRequest=0,receiptRequest=0,eventsRequest=0;
  let attempt:{artifactHash:string;revision:number;environment:DeploymentEnvironment;operationId:string;idempotencyKey:string;context:ProjectDeploymentContext;preparation:Preparation|null}|null=null;
  const listeners=new Set<()=>void>();
  const update=(patch:Partial<DeploymentState>)=>{if(disposed)return;state={...state,...patch};for(const listener of listeners)listener()};
  const current=(turn:number,id:string)=>!disposed&&turn===selection&&id===state.selectedId;
  const assertOperation=(value:unknown,id?:string)=>{const operation=parseOperation(value);if(operation.target.applicationId!==applicationId||(id&&operation.id!==id))throw new Error('DEPLOYMENT_RESPONSE_INVALID');return operation};

  async function loadEvents() {
    const id=state.selectedId,turn=selection;
    if(disposed||!id||!state.operation||state.eventsLoading)return;
    const after=state.nextCursor,version=++eventsRequest;
    update({eventsLoading:true,eventsError:''});
    try {
      const page=parseEventPage(await request(`/deployment/operations/${id}/events?after=${after}&limit=100`),id,after);
      if(!current(turn,id)||version!==eventsRequest)return;
      const events=[...state.events,...page.items];
      update({events:events.slice(-1000),nextCursor:page.nextCursor,hasMore:page.hasMore,eventsTruncated:state.eventsTruncated||events.length>1000});
    } catch(error) {if(current(turn,id)&&version===eventsRequest)update({eventsError:errorMessage(error)})}
    finally {if(current(turn,id)&&version===eventsRequest)update({eventsLoading:false})}
  }

  async function loadReceipt() {
    const id=state.selectedId,turn=selection;
    if(disposed||!id||!state.operation||state.actionPending==='receipt')return;
    const version=++receiptRequest;
    try {
      const receipt=parseDelivery(await request(`/deployment/operations/${id}/receipt`),id);
      if(current(turn,id)&&version===receiptRequest)update({receipt,receiptLoaded:true,receiptError:''});
    } catch(error) {if(current(turn,id)&&version===receiptRequest)update({receiptError:errorMessage(error)})}
  }

  async function loadDetail() {
    const id=state.selectedId,turn=selection,version=++detailRequest;
    if(disposed||!id)return;
    update({detailLoading:true,detailError:''});
    try {
      const operation=assertOperation(await request(`/deployment/operations/${id}`),id);
      if(!current(turn,id)||version!==detailRequest)return;
      if(!state.operation||operation.revision>=state.operation.revision)update({operation});
      await Promise.all([loadEvents(),loadReceipt()]);
    } catch(error) {if(current(turn,id)&&version===detailRequest)update({detailError:errorMessage(error)})}
    finally {if(current(turn,id)&&version===detailRequest)update({detailLoading:false})}
  }

  async function select(id:string) {
    if(disposed||!state.operations.some(operation=>operation.id===id&&operation.target.applicationId===applicationId))return;
    if(state.selectedId===id){await loadDetail();return}
    selection++;
    update({selectedId:id,operation:null,detailLoading:false,detailError:'',events:[],eventsLoading:false,eventsError:'',nextCursor:0,hasMore:false,eventsTruncated:false,receipt:null,receiptLoaded:false,receiptError:'',actionPending:null,notice:'',actionError:''});
    await loadDetail();
  }

  async function refresh() {
    if(disposed||refreshing||state.actionPending||state.deploying)return;
    refreshing=true;update({loading:true});
    const results=await Promise.allSettled([request('/deployment/capabilities'),request('/deployment/operations?limit=100'),...(projectId?[request(`/projects/${projectId}/deployment/context`)]:[])]);
    if(disposed)return;
    try {
      if(projectId){const result=results[2];try{if(result.status==='rejected')throw result.reason;update({context:parseProjectContext(result.value,projectId,applicationId),contextError:''})}catch(error){update({context:null,contextError:errorMessage(error)})}}
      const capability=results[0];
      try {if(capability.status==='rejected')throw capability.reason;update({capabilities:parseCapabilities(capability.value),capabilityError:''})}
      catch(error){update({capabilities:null,capabilityError:errorMessage(error)})}
      const list=results[1];
      try {
        if(list.status==='rejected')throw list.reason;
        const operations=parseOperations(list.value);
        update({operations:operations.filter(operation=>operation.target.applicationId===applicationId),listedCount:operations.length,listError:''});
      } catch(error){update({listError:errorMessage(error)})}
      if(state.selectedId)await loadDetail();
      else if(state.operations.length)await select(state.operations[0].id);
    } finally {refreshing=false;update({loading:false})}
  }

  function deployReady(hash:string,revision:number,environment:DeploymentEnvironment) {
    const context=state.context;
    return Boolean(!disposed&&projectId&&context&&context.available&&context.profile==='wanx-miniapp-v1'&&context.target&&context.supportedActions.includes('deploy')&&context.environments.some(item=>item.id===environment)&&state.capabilities?.available&&state.capabilities.operations.includes('deploy')&&!state.contextError&&!state.capabilityError&&!state.listError&&!state.loading&&!state.deploying&&!state.actionPending&&!state.operations.some(item=>ACTIVE.has(item.state)&&item.target.environment===environment)&&context.artifact?.hash===hash&&Number.isSafeInteger(revision)&&revision>=0);
  }

  async function deploy(hash:string,revision:number,environment:DeploymentEnvironment) {
    if(!deployReady(hash,revision,environment))return;
    const context=state.context!;
    if(attempt&&(attempt.artifactHash!==hash||attempt.revision!==revision||attempt.environment!==environment)){
      update({deploymentError:errorMessage(new Error('DEPLOYMENT_ATTEMPT_PENDING'))});return;
    }
    attempt||={artifactHash:hash,revision,environment,operationId:crypto.randomUUID().replaceAll('-',''),idempotencyKey:crypto.randomUUID().replaceAll('-',''),context,preparation:null};
    const pending=attempt;
    update({deploying:true,deploymentPending:true,deploymentError:'',deploymentNotice:''});
    try {
      if(!pending.preparation){
        const value=await request(`/projects/${projectId}/deployment/prepare`,'POST',{artifactHash:pending.artifactHash,expectedRevision:pending.revision,environment:pending.environment,operationId:pending.operationId});
        if(disposed)return;
        pending.preparation=parsePreparation(value,pending.context,pending.artifactHash,pending.environment);
      }
      if(disposed)return;
      const preparation=pending.preparation;
      const operation=assertOperation(await request(`/projects/${projectId}/deployment/submit`,'POST',{preparationId:preparation.preparationId,idempotencyKey:pending.idempotencyKey}));
      if(disposed)return;
      if(operation.kind!=='deploy'||operation.previousGeneration!==preparation.expectedGeneration||Object.entries(preparation.target).some(([key,value])=>operation.target[key as keyof typeof operation.target]!==value)||operation.releaseRef?.releaseId!==preparation.releaseRef.releaseId||operation.releaseRef?.bundleDigest!==preparation.releaseRef.bundleDigest)throw new Error('DEPLOYMENT_RESPONSE_INVALID');
      attempt=null;
      update({deploymentPending:false,submittedId:operation.id,operations:[operation,...state.operations.filter(item=>item.id!==operation.id)],deploymentNotice:'部署请求已受理，正在跟踪后台任务；请以实际执行结果为准。'});
      await select(operation.id);
    } catch(error){if(!disposed){
      const code=typeof error==='object'&&error&&'code' in error?String(error.code):error instanceof Error?error.message:'';
      const rejected=['DEPLOYMENT_DEV_VERIFICATION_REQUIRED','DEPLOYMENT_VERSION_CHANGED','DEPLOYMENT_PREPARATION_INVALID','DEPLOYMENT_PREPARATION_NOT_FOUND','DEPLOYMENT_GENERATION_CONFLICT','BREAKING_SCHEMA_CHANGE'].includes(code);
      if(rejected)attempt=null;
      update({deploymentPending:!rejected,deploymentError:errorMessage(error)+(rejected?'':' 请求结果未确认时，请先刷新部署记录；重试会继续使用本次请求，不另建任务。')});
    }}
    finally {if(!disposed)update({deploying:false})}
  }

  function abandonAttempt(){if(disposed||state.deploying)return;attempt=null;update({deploymentPending:false,deploymentError:'',deploymentNotice:'已结束本次请求重试。请先核对部署记录，再发起新请求。'})}

  async function resume() {
    const operation=state.operation,id=state.selectedId,turn=selection;
    if(disposed||!id||!operation||!canResume(operation,state.capabilities)||state.actionPending||state.deploying||state.detailLoading||state.loading||state.detailError||state.listError||state.capabilityError)return;
    update({actionPending:'resume',actionError:'',notice:''});
    try {
      const next=assertOperation(await request(`/deployment/operations/${id}/resume`,'POST',{}),id);
      if(!current(turn,id))return;
      if(!state.operation||next.revision>=state.operation.revision)update({operation:next});
      update({notice:'已请求继续处理原任务，请以更新后的实际状态为准。'});
      await loadDetail();
    } catch(error){if(current(turn,id))update({actionError:errorMessage(error)})}
    finally {if(current(turn,id))update({actionPending:null})}
  }

  async function retryReceipt() {
    const id=state.selectedId,turn=selection;
    if(disposed||!id||!state.operation||state.receipt?.deliveryStatus!=='pending'||state.actionPending||state.deploying||state.detailLoading||state.loading||state.detailError||state.listError||state.capabilityError||state.receiptError)return;
    // Invalidate an older GET so it cannot erase the mutation's returned status.
    const version=++receiptRequest;
    update({actionPending:'receipt',actionError:'',notice:''});
    try {
      const receipt=parseDelivery(await request(`/deployment/operations/${id}/receipt/retry`,'POST',{}),id);
      if(!receipt)throw new Error('DEPLOYMENT_RESPONSE_INVALID');
      if(!current(turn,id))return;
      if(version===receiptRequest)update({receipt,receiptLoaded:true,receiptError:''});
      update({notice:receipt.deliveryStatus==='delivered'?'结果回执已送达。':'已尝试同步，结果回执仍待送达；部署不会因此重新执行。'});
    } catch(error){if(current(turn,id))update({actionError:errorMessage(error)})}
    finally {if(current(turn,id))update({actionPending:null})}
  }

  return {getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},refresh,select,loadEvents,resume,retryReceipt,deploy,deployReady,abandonAttempt,
    shouldPoll:()=>!disposed&&(state.operations.some(operation=>ACTIVE.has(operation.state))||Boolean(state.operation&&ACTIVE.has(state.operation.state))||state.receipt?.deliveryStatus==='pending'),
    dispose:()=>{disposed=true;selection++;listeners.clear()}};
}
