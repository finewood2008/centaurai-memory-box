// Scoped semantic planning. Reading/interpretation never authorizes a business write.
const base='/workbench/conversations/:c';
const routes={context:'/instruction-context',interpret:'/instruction-plans',list:'/instruction-plans/list',read:'/instruction-plans/:p/read',prepare:'/instruction-plans/:p/prepare',confirm:'/instruction-plans/:p/confirm',abandon:'/instruction-plans/:p/abandon'};
export const instructionActions=new Set(Object.keys(routes).map(k=>'conversation-instruction-'+k));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bad=()=>{throw Object.assign(Error('MODELING_INVALID_REQUEST'),{code:'MODELING_INVALID_REQUEST',status:422});};
export function instructionRequest(action,input={}){
  if(!instructionActions.has(action))return null;
  const kind=action.slice('conversation-instruction-'.length),step=['prepare','confirm','abandon'].includes(kind),context=['context','interpret'].includes(kind);
  const fields=['warehouseId','conversationId','operationId','editor',...((step||kind==='read')?['planId']:[]),...(context?['intentId','draftId','selectedItemIds','allowedScopes']:kind==='list'?['intentId']:[]),...(kind==='interpret'?['contextDigest','instruction','clarificationPlanId']:[]),...(step?['revision']:[]),...(kind==='confirm'?['stepDigest','confirmed','replacementAcknowledgement']:[])];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))||!id(input.warehouseId)||!id(input.conversationId)||!id(input.operationId))bad();
  let path='/warehouses/'+input.warehouseId+base.replace(':c',input.conversationId)+routes[kind];
  if(path.includes(':p')){if(!id(input.planId))bad();path=path.replace(':p',input.planId);}
  const body={_native_operation_id:input.operationId};
  if(step||kind==='interpret')body.operation_id=input.operationId;
  if(input.editor!==undefined){const e=input.editor;if(!e||Object.keys(e).sort().join(',')!=='generation,session'||typeof e.session!=='string'||!/^[A-Za-z0-9_-]{20,200}$/.test(e.session)||typeof e.generation!=='string'||!/^\d{1,12}$/.test(e.generation))bad();body._native_editor={...e};}
  if(context||kind==='list'){
    if(!id(input.intentId))bad();body.intent_id=input.intentId;
  }
  if(context){
    const scopes=input.allowedScopes,selected=input.selectedItemIds??[];
    if(!Array.isArray(scopes)||!scopes.length||scopes.length>8||new Set(scopes).size!==scopes.length||scopes.some(v=>!['question','answer','goal','rules','facts','source','extract','publish'].includes(v)))bad();
    if(!Array.isArray(selected)||selected.length>20||selected.some(v=>!id(v))||new Set(selected).size!==selected.length)bad();
    if(input.draftId!==undefined){if(!id(input.draftId)||!input.editor||!scopes.includes('facts'))bad();body.draft_id=input.draftId;}
    if(selected.length&&!input.draftId)bad();
    body.selected_item_ids=[...selected];body.allowed_scopes=[...scopes];
  }
  if(kind==='interpret'){
    if(!digest(input.contextDigest)||typeof input.instruction!=='string'||!input.instruction.trim()||[...input.instruction].length>4000)bad();
    body.context_digest=input.contextDigest;body.instruction=input.instruction;
    if(input.clarificationPlanId!==undefined){if(!id(input.clarificationPlanId))bad();body.clarification_plan_id=input.clarificationPlanId;}
  }
  if(step){if(!Number.isSafeInteger(input.revision)||input.revision<1)bad();body.expected_revision=input.revision;}
  if(kind==='confirm'){
    if(!digest(input.stepDigest)||input.confirmed!==true)bad();body.step_digest=input.stepDigest;body.confirmed=true;
    if(input.replacementAcknowledgement!==undefined){if(!digest(input.replacementAcknowledgement))bad();body.replacement_acknowledgement=input.replacementAcknowledgement;}
  }
  return {path,method:'POST',body,timeoutMs:['interpret','prepare'].includes(kind)?300000:60000};
}
