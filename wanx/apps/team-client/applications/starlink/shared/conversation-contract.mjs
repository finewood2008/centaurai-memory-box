// Finite personal conversation routes. Identity and authorization belong to Host/Bridge.
import {changeActions,changeRequest} from './conversation-change-contract.mjs';
import {dialogueActions,dialogueRequest} from './onboarding-dialogue-contract.mjs';
const C='/workbench/conversations';
const definitions={
  job:['GET','/workbench/jobs/:j','read'],
  'job-retry':['POST','/workbench/jobs/:j/retry','operation'],
  'material-workflows':['GET',C+'/materials','page'],
  'material-workflow':['GET',C+'/materials/:d','read'],
  'processing-preview':['POST',C+'/materials/:d/processing-previews','processingPreview'],
  'processing-confirm':['POST',C+'/materials/:d/processing-transitions','processingConfirm'],
  'processing-status':['GET',C+'/materials/:d/processing-transitions/:x','read'],
  'source-save':['POST','/documents/:d/correction','sourceSave'],
  'source-confirm':['POST','/workbench/documents/:d/source-confirmations','sourceConfirm'],
  'index-retry':['POST','/workbench/documents/:d/index-retries','indexRetry'],
  ontologies:['GET','/workbench/ontologies','read'],
  'published-run':['GET','/workbench/knowledge/runs/:k','read'],
  list:['GET',C,'page'],create:['POST',C,'create'],
  get:['GET',C+'/:c','get'],messages:['GET',C+'/:c/messages','messages'],
  send:['POST',C+'/:c/messages','send'],turns:['GET',C+'/:c/turns','page'],
  turn:['GET',C+'/:c/turns/:t','read'],
  'turn-cancel':['POST',C+'/:c/turns/:t/cancel','revision'],
  'turn-retry':['POST',C+'/:c/turns/:t/retry','revision'],
  intents:['GET',C+'/:c/intents','page'],'intent-create':['POST',C+'/:c/intents','intent'],
  intent:['GET',C+'/:c/intents/:i','read'],analyze:['POST',C+'/:c/intents/:i/analyze','analyze'],
  goal:['POST',C+'/:c/intents/:i/goal','goal'],plan:['GET',C+'/:c/intents/:i/plan','read'],
  confirm:['POST',C+'/:c/intents/:i/confirm','confirm'],
  cancel:['POST',C+'/:c/intents/:i/cancel','revision'],retry:['POST',C+'/:c/intents/:i/retry','revision'],
  candidates:['GET',C+'/:c/intents/:i/candidates','page'],
  'review-plan':['POST',C+'/:c/intents/:i/review-plan','reviewPlan'],
  review:['POST',C+'/:c/intents/:i/review','review'],
  'editor-session':['POST','/workbench/documents/:d/corrections/sessions','operation'],
  'editor-leases':['POST','/workbench/documents/:d/corrections/leases','editorRead'],
  'editor-claim':['POST','/workbench/documents/:d/corrections/:r/claim','release'],
  'editor-release':['POST','/workbench/documents/:d/corrections/:r/release','release'],
};
export const conversationActions=new Set([...Object.keys(definitions).map(k=>'conversation-'+k),...changeActions,...dialogueActions]);
const fields={read:[],page:['offset','limit'],get:['intentOffset'],messages:['afterSequence','limit'],
  processingPreview:['operationId','documentVersionId','workflowRevision'],
  processingConfirm:['operationId','previewId','previewDigest','workflowRevision','confirmed','replacementAcknowledgement'],
  sourceSave:['operationId','documentVersionId','segments'],
  sourceConfirm:['operationId','documentVersionId','confirmed'],
  indexRetry:['operationId','documentVersionId','confirmationId'],
  operation:['operationId'],create:['operationId','scenario'],revision:['operationId','revision'],
  send:['operationId','revision','content'],intent:['operationId','revision','documentId'],
  analyze:['operationId','documentVersionId'],goal:['operationId','revision','conversationRevision','goal','instructions','confirmed'],
  confirm:['operationId','revision','conversationRevision','planDigest','confirmed'],
  reviewPlan:['operationId','editor','draftId','offset','limit'],
  review:['operationId','revision','editor','planDigest','draftId','confirmed','deferredPolicy'],
  editorRead:['operationId','editor'],release:['operationId','revision','editor']};
const invalid=()=>{throw Object.assign(Error('MODELING_INVALID_REQUEST'),{code:'MODELING_INVALID_REQUEST',status:422});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const number=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export function conversationRequest(action,input={}){
  if(dialogueActions.has(action))return dialogueRequest(action,input);
  if(changeActions.has(action))return changeRequest(action,input);
  const def=definitions[action.slice('conversation-'.length)];
  if(!conversationActions.has(action))return null;
  const [method,template,kind]=def;
  const ids={c:'conversationId',i:'intentId',t:'turnId',d:'documentId',r:'draftId',k:'runId',x:'transitionId',j:'jobId'};
  const required=Object.entries(ids).filter(([k])=>template.includes(':'+k));
  const allowed=['warehouseId',...required.map(([,v])=>v),...fields[kind]];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||!id(input.warehouseId))invalid();
  let path='/warehouses/'+input.warehouseId+template;
  for(const [k,v] of required){if(!id(input[v]))invalid();path=path.replace(':'+k,input[v]);}
  const query=new URLSearchParams();
  for(const [key,wire,max] of [['offset','offset',Number.MAX_SAFE_INTEGER],['limit','limit',kind==='messages'?100:50],['afterSequence','after_sequence',Number.MAX_SAFE_INTEGER],['intentOffset','intent_offset',Number.MAX_SAFE_INTEGER]]){
    if(input[key]!==undefined){if(!number(input[key],key==='limit'?1:0,max))invalid();query.set(wire,String(input[key]));}
  }
  let body;
  if(method==='POST'){
    if(!id(input.operationId))invalid();
    body={_native_operation_id:input.operationId};
    if(!['reviewPlan','editorRead'].includes(kind))body.operation_id=input.operationId;
    if(fields[kind].includes('revision')){if(!number(input.revision,1))invalid();body.expected_revision=input.revision;}
    if(fields[kind].includes('conversationRevision')){if(!number(input.conversationRevision,1))invalid();body.expected_conversation_revision=input.conversationRevision;}
    for(const [key,wire] of [['content','content'],['goal','goal'],['instructions','instructions']])if(fields[kind].includes(key)){
      if(key==='instructions'&&input[key]===undefined)continue;
      if(typeof input[key]!=='string'||[...input[key]].length>8000||(key!=='instructions'&&!input[key].trim()))invalid();
      body[wire]=input[key];
    }
    for(const [key,wire] of [['documentId','document_id'],['documentVersionId','document_version_id'],['draftId','draft_id']])if(fields[kind].includes(key)){
      if(input[key]===undefined&&key!=='documentVersionId')continue;
      if((key==='documentVersionId'||input[key]!==null)&&!id(input[key]))invalid();
      if(kind==='reviewPlan'){if(input[key]!==null)query.set(wire,input[key]);}else body[wire]=input[key];
    }
    if(fields[kind].includes('confirmed')){if(input.confirmed!==true)invalid();body.confirmed=true;}
    if(kind==='processingPreview'||kind==='processingConfirm'){
      if(!number(input.workflowRevision,1))invalid();body.expected_workflow_revision=input.workflowRevision;
      if(kind==='processingPreview'){
        delete body.document_version_id;body.expected_document_version_id=input.documentVersionId;body.target_mode='automatic';
      }else{
        if(!id(input.previewId)||!/^[a-f0-9]{64}$/.test(input.previewDigest||''))invalid();
        body.preview_id=input.previewId;body.preview_digest=input.previewDigest;
        if(input.replacementAcknowledgement!==undefined){
          if(typeof input.replacementAcknowledgement!=='string'||!/^[a-f0-9]{64}$/.test(input.replacementAcknowledgement))invalid();
          body.replacement_acknowledgement=input.replacementAcknowledgement;
        }
      }
    }
    if(kind==='sourceSave'){
      if(!Array.isArray(input.segments)||!input.segments.length||input.segments.some(s=>!s||Object.keys(s).sort().join(',')!=='id,text'||!id(s.id)||typeof s.text!=='string')||new Set(input.segments.map(s=>s.id)).size!==input.segments.length)invalid();
      body={operation_id:input.operationId,payload:{base_version_id:input.documentVersionId,segments:input.segments}};
    }
    if(kind==='sourceConfirm'||kind==='indexRetry'){
      delete body.document_version_id;body.expected_document_version_id=input.documentVersionId;
      if(kind==='indexRetry'){if(!id(input.confirmationId))invalid();body.confirmation_id=input.confirmationId;}
    }
    if(fields[kind].includes('planDigest')){if(!/^[a-f0-9]{64}$/.test(input.planDigest||''))invalid();body.plan_digest=input.planDigest;}
    if(fields[kind].includes('editor')){
      const e=input.editor;
      if(!e||Object.keys(e).sort().join(',')!=='generation,session'||typeof e.session!=='string'||!/^[A-Za-z0-9_-]{20,200}$/.test(e.session)||typeof e.generation!=='string'||!/^\d{1,12}$/.test(e.generation))invalid();
      body._native_editor={...e};
    }
    if(input.deferredPolicy!==undefined){if(input.deferredPolicy!=='keep_existing')invalid();body.deferred_policy=input.deferredPolicy;}
    if(kind==='create'){if(input.scenario!==undefined&&!['material','onboarding'].includes(input.scenario))invalid();body.scenario=input.scenario||'material';}
    if(kind==='editorRead'){
      body.path='/api/documents/'+input.documentId+'/corrections/leases';body.query={};
      path='/warehouses/'+input.warehouseId+'/workbench/_correction_read';
    }
    if(new TextEncoder().encode(JSON.stringify(body)).length>(kind==='sourceSave'?8*1024*1024:128*1024))invalid();
  }
  return {path:path+(query.size?'?'+query:''),method,...(body?{body}:{}),timeoutMs:60000};
}

export function uploadBinding(input){
  const keys=['conversationId','intentId','expectedIntentRevision'];
  if(keys.every(k=>input[k]===undefined))return null;
  if(!id(input.conversationId)||!id(input.intentId)||!number(input.expectedIntentRevision,1))invalid();
  return {conversation_id:input.conversationId,intent_id:input.intentId,expected_intent_revision:input.expectedIntentRevision};
}
