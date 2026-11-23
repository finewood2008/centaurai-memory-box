// WANX registered onboarding routes; never accept actor or editor credentials.
const base='/workbench/conversations/:c/onboarding';
const routes={get:['GET',base,['offset','limit']],turn:['GET',base+'/turns/:t',[]],
  start:['POST',base+'/start',['revision','draftDigest']],
  send:['POST',base+'/turns',['revision','draftDigest','content','questionActions']],
  preview:['POST',base+'/preview',['revision','draftDigest','name']],
  trial:['POST',base+'/trial',['revision','draftDigest','documentId','documentVersionId']],
  publish:['POST',base+'/publish',['previewId','previewDigest','confirmed']]};
export const dialogueActions=new Set(Object.keys(routes).map(k=>'conversation-onboarding-'+k));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const invalid=()=>{throw Object.assign(Error('MODELING_INVALID_REQUEST'),{code:'MODELING_INVALID_REQUEST',status:422});};
export function validateQuestionActions(actions,{draft=false}={}){
  if(!Array.isArray(actions)||actions.length>2)invalid();const seen=new Set();
  for(const a of actions){
    if(!a||Array.isArray(a)||Object.keys(a).some(k=>!['question_id','action','answer'].includes(k))||typeof a.question_id!=='string'||!a.question_id.length||[...a.question_id].length>64||seen.has(a.question_id)||!['answer','skip','uncertain'].includes(a.action))invalid();
    seen.add(a.question_id);
    if(a.action==='answer'){if(typeof a.answer!=='string'||[...a.answer].length>4000||!draft&&!a.answer.trim())invalid();}
    else if(a.answer!==undefined)invalid();
  }
  return actions;
}
// Pydantic materializes the optional answer="" default in returned actions.
// Normalize only that default; outgoing skip/uncertain still omit answer.
export function questionActionsFromReceipt(actions){
  if(!Array.isArray(actions))invalid();
  const normalized=actions.map(a=>{const value={...a};if(['skip','uncertain'].includes(value.action)&&value.answer==='')delete value.answer;return value;});
  return validateQuestionActions(normalized);
}
export function dialogueRequest(action,input={}){
  if(!dialogueActions.has(action))return null;
  const [method,template,fields]=routes[action.slice('conversation-onboarding-'.length)],write=method==='POST';
  const allowed=['warehouseId','conversationId',...(template.includes(':t')?['turnId']:[]),...(write?['operationId']:[]),...fields];
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||!id(input.warehouseId)||!id(input.conversationId)||template.includes(':t')&&!id(input.turnId))invalid();
  let path='/warehouses/'+input.warehouseId+template.replace(':c',input.conversationId).replace(':t',input.turnId);
  const query=new URLSearchParams();for(const k of ['offset','limit'])if(input[k]!==undefined){if(!Number.isSafeInteger(input[k])||input[k]<(k==='limit'?1:0)||input[k]>(k==='limit'?50:Number.MAX_SAFE_INTEGER))invalid();query.set(k,input[k]);}
  let body;
  if(write){if(!id(input.operationId))invalid();body={operation_id:input.operationId,_native_operation_id:input.operationId};
    if(fields.includes('revision')){if(!Number.isSafeInteger(input.revision)||input.revision<0||!digest(input.draftDigest))invalid();body.expected_revision=input.revision;body.draft_digest=input.draftDigest;}
    if(fields.includes('name')){if(typeof input.name!=='string'||!input.name.trim()||[...input.name].length>120)invalid();body.name=input.name;}
    if(fields.includes('questionActions')){
      const content=input.content===undefined?'':input.content,actions=validateQuestionActions(input.questionActions===undefined?[]:input.questionActions);
      if(typeof content!=='string'||!content.trim()&&!actions.length||[...content].length+actions.reduce((n,a)=>n+[...(a.answer||'')].length,0)>8000)invalid();
      if(input.content!==undefined)body.content=content;
      if(input.questionActions!==undefined)body.question_actions=structuredClone(actions);
    }
    if(fields.includes('documentId')){
      if(!id(input.documentId)||!id(input.documentVersionId))invalid();
      Object.assign(body,{document_id:input.documentId,document_version_id:input.documentVersionId});
    }
    if(fields.includes('previewId')){if(!id(input.previewId)||!digest(input.previewDigest)||input.confirmed!==true)invalid();Object.assign(body,{preview_id:input.previewId,preview_digest:input.previewDigest,confirmed:true});}
  }
  return {path:path+(query.size?'?'+query:''),method,...(body?{body}:{}),timeoutMs:['conversation-onboarding-send','conversation-onboarding-start'].includes(action)?285000:45000};
}
