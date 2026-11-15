// Only registered personal conversation changes and correction operations.
const root='/workbench/conversations/:c/intents/:i';
const draft='/workbench/documents/:d/corrections/:r';
const routes={
  context:[root+'/change-context','context'],generate:[root+'/change-proposals','generate'],
  read:[root+'/change-proposals/:p/read','read'],apply:[root+'/change-proposals/:p/apply','apply'],
  draft:[draft,'private'],items:[draft+'/items','page'],preview:[draft+'/preview','preview'],
  publication:[draft+'/publication','private'],source:[draft+'/sources/:s','source'],
  heartbeat:[draft+'/heartbeat','heartbeat'],publish:[draft+'/apply','publish'],
  'publish-retry':[draft+'/publication/retry','retry'],
  'draft-create':['/workbench/documents/:d/corrections','createDraft'],
  discard:[draft+'/discard','discard'],
  'rule-publish':['/workbench/ontologies/:o/publish','rulePublish'],
};
export const changeActions=new Set(Object.keys(routes).map(k=>'conversation-change-'+k));
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const bad=()=>{throw Object.assign(Error('MODELING_INVALID_REQUEST'),{code:'MODELING_INVALID_REQUEST',status:422});};
const keys={context:['draftId','ontologyDraftId','selectedItemIds','proposalOffset','allowedScopes'],generate:['draftId','ontologyDraftId','selectedItemIds','contextDigest','instruction','allowedScopes'],
  read:[],apply:['proposalDigest','confirmed'],private:[],page:['revision','kind','offset','limit'],preview:['revision','offset','limit'],source:['revision','start'],heartbeat:['revision'],publish:['revision','confirmed'],rulePublish:[],retry:[],createDraft:[],discard:['revision','confirmed']};
export function changeRequest(action,input={}){
  if(!changeActions.has(action))return null;
  const [template,kind]=routes[action.slice('conversation-change-'.length)];
  const ids={c:'conversationId',i:'intentId',d:'documentId',r:'draftId',p:'proposalId',s:'sourceId',o:'ontologyId'};
  const required=Object.entries(ids).filter(([k])=>template.includes(':'+k));
  const allowed=['warehouseId','operationId',...(kind==='rulePublish'?[]:['editor']),...required.map(([,v])=>v),...keys[kind]];
  if(!input||Object.keys(input).some(k=>!allowed.includes(k))||!validId(input.warehouseId)||!validId(input.operationId))bad();
  let path=template;
  for(const [k,v] of required){if(!validId(input[v]))bad();path=path.replace(':'+k,input[v]);}
  const body={_native_operation_id:input.operationId};
  if(['generate','apply','publish','heartbeat','retry','createDraft','discard'].includes(kind))body.operation_id=input.operationId;
  if(input.editor!==undefined){const e=input.editor;
    if(!e||Object.keys(e).sort().join(',')!=='generation,session'||typeof e.session!=='string'||!/^[A-Za-z0-9_-]{20,200}$/.test(e.session)||typeof e.generation!=='string'||!/^\d{1,12}$/.test(e.generation))bad();
    body._native_editor={...e};
  }
  const privateRead=['private','page','preview','source'].includes(kind);
  if((privateRead||['heartbeat','publish','retry','createDraft','discard'].includes(kind)||input.draftId&&['context','generate'].includes(kind))&&!input.editor)bad();
  if(['context','generate'].includes(kind)){
    if(input.allowedScopes!==undefined){const scopes=input.allowedScopes;if(!Array.isArray(scopes)||!scopes.length||scopes.some(v=>!['rules','goal','facts'].includes(v))||new Set(scopes).size!==scopes.length)bad();body.allowed_scopes=[...scopes];}
    for(const [key,wire] of [['draftId','draft_id'],['ontologyDraftId','ontology_draft_id']])if(input[key]!==undefined){if(!validId(input[key]))bad();body[wire]=input[key];}
    const selected=input.selectedItemIds??[];
    if(!Array.isArray(selected)||selected.length>20||selected.some(v=>!validId(v))||new Set(selected).size!==selected.length||selected.length&&!input.draftId)bad();
    body.selected_item_ids=[...selected];
  }
  if(input.proposalOffset!==undefined){if(!integer(input.proposalOffset))bad();body.proposal_offset=input.proposalOffset;}
  if(kind==='generate'){
    if(!/^[a-f0-9]{64}$/.test(input.contextDigest||'')||typeof input.instruction!=='string'||!input.instruction.trim()||[...input.instruction].length>4000)bad();
    body.context_digest=input.contextDigest;body.instruction=input.instruction;
  }
  if(kind==='apply'){if(!/^[a-f0-9]{64}$/.test(input.proposalDigest||''))bad();body.proposal_digest=input.proposalDigest;}
  if(['apply','publish'].includes(kind)){if(input.confirmed!==true)bad();body.confirmed=true;}
  if(kind==='discard'){if(input.confirmed!==true||!integer(input.revision)||input.revision<1)bad();body.expected_revision=input.revision;body.note='用户确认放弃当前草稿，重新核对抽取计划';}
  if(['heartbeat','publish'].includes(kind)){if(!integer(input.revision)||input.revision<1)bad();body.expected_revision=input.revision;if(kind==='publish')body.note='';}
  if(privateRead){
    const query={};
    if(['page','preview','source'].includes(kind)){if(!integer(input.revision)||input.revision<1)bad();query.revision=String(input.revision);}
    for(const key of ['offset','limit','start'])if(input[key]!==undefined){if(!integer(input[key])||key==='limit'&&(input[key]<1||input[key]>50))bad();query[key]=String(input[key]);}
    if(kind==='page'){if(!['entity','relation'].includes(input.kind))bad();query.kind=input.kind;}
    body.path='/api'+path.slice('/workbench'.length);body.query=query;path='/workbench/_correction_read';
  }
  if(new TextEncoder().encode(JSON.stringify(body)).length>128*1024)bad();
  return {path:'/warehouses/'+input.warehouseId+path,method:'POST',body,timeoutMs:kind==='generate'?300000:60000};
}
