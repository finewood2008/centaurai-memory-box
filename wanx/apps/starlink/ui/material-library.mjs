import {materialAccessLost} from './native-workbench.js';
const fail=code=>Object.assign(Error(code),{code});
const validWorkflow=w=>w&&typeof w.document_id==='string'&&w.document?.id===w.document_id&&typeof w.label==='string'&&
  Array.isArray(w.tasks)&&Array.isArray(w.conversations)&&typeof w.actions?.start_dialogue?.allowed==='boolean';
export const materialSourceRemoved=i=>i?.source_status==='source_unavailable'||['document_deleted','source_deleted','source_unavailable'].includes(i?.invalid_reason);

// Warehouse documents are the inventory. Conversation attachments only provide
// navigation links; they must not decide whether a document exists in the list.
export function warehouseMaterialEntries(flow){
  const groups={...flow.state.materialIndex,[flow.saved.conversationId]:flow.state.intents};
  const entries=new Map();
  for(const document of flow.state.warehouseMaterials||[]){
    if(!document.deleted_at&&document.status!=='deleted'&&!flow.saved.deletedDocuments?.[document.id])entries.set(document.id,{document,links:[]});
  }
  const selected=flow.state.librarySelection?.document;
  if(selected&&!selected.deleted_at&&selected.status!=='deleted'&&!entries.has(selected.id)&&!flow.saved.deletedDocuments?.[selected.id])entries.set(selected.id,{document:selected,links:[]});
  for(const [conversationId,intents] of Object.entries(groups))for(const intent of intents||[]){
    if(!intent.document_id||materialSourceRemoved(intent)||flow.saved.deletedDocuments?.[intent.document_id])continue;
    const row=entries.get(intent.document_id)||{document:{id:intent.document_id,original_name:intent.original_name},links:[]};
    row.links.push({conversationId,intent});entries.set(intent.document_id,row);
  }
  for(const row of entries.values())for(const link of row.document.workflow?.conversations||[]){
    if(link.conversation_status!=='active'||row.links.some(x=>x.intent.id===link.intent_id))continue;
    row.links.push({conversationId:link.conversation_id,intent:{id:link.intent_id,document_id:row.document.id,status:link.status}});
  }
  return [...entries.values()];
}

export async function readWarehouseMaterials(flow,more=false){
  const offset=more?flow.state.warehouseMaterialOffset||0:0;
  const value=await flow.read('conversation-material-workflows',{offset,limit:50});
  if(!Array.isArray(value.items)||!Number.isSafeInteger(value.total)||value.total<0||
    value.items.some(d=>!validWorkflow(d)))throw fail('SEMANTICA_INVALID_RESPONSE');
  if(!value.items.length&&offset<value.total)throw fail('SEMANTICA_INVALID_RESPONSE');
  const documents=new Map((more?flow.state.warehouseMaterials||[]:[]).map(d=>[d.id,d]));
  for(const workflow of value.items){const d={...workflow.document,workflow};if(!flow.saved.deletedDocuments?.[d.id])documents.set(d.id,d);}
  flow.state.warehouseMaterials=[...documents.values()];
  flow.state.warehouseMaterialTotal=value.total;
  flow.state.warehouseMaterialOffset=offset+value.items.length;
  flow.state.warehouseMaterialMore=offset+value.items.length<value.total;
  flow.state.warehouseMaterialError=false;
}

export async function selectWarehouseMaterial(flow,id,inspectCurrent=false){
  if(flow.readerOnly)return flow.importer.select(id);
  if(flow.state.busy)return;
  if(flow.saved.pending||flow.saved.materialDeletion||flow.saved.upload||flow.saved.intakeSubmission||flow.saved.roundOpening||flow.intake.staged||
    flow.reviewPending||flow.claimPending||flow.releasePending||flow.changes.record.pending||flow.changes.claimRequest){
    return flow.run(async()=>{throw fail('MODELING_REQUEST_PENDING');});
  }
  const row=warehouseMaterialEntries(flow).find(row=>row.document.id===id);
  if(!row||flow.saved.deletedDocuments?.[id])return;
  const links=row.links.filter(link=>!flow.saved.resumedIntents?.[link.intent.id]);
  if(links.length===1&&!inspectCurrent){
    const target=links[0];
    await flow.selectMaterial(target.conversationId,target.intent.id);
    if(!flow.state.error){flow.state.librarySelection=null;flow.emit();}return;
  }
  return flow.run(async()=>{
    flow.rememberMaterialComposer();
    // Read through the warehouse-scoped API, even when the row was cached.
    const value=await flow.read('document',{id});
    if(value.document?.id!==id)throw fail('SEMANTICA_INVALID_RESPONSE');
    const workflow=await flow.read('conversation-material-workflow',{documentId:id});
    if(!validWorkflow(workflow)||workflow.document_id!==id)throw fail('SEMANTICA_INVALID_RESPONSE');
    flow.state.librarySelection={document:{...workflow.document,workflow},links};
    flow.saved.libraryDocumentId=id;flow.persist?.();
  });
}

export async function refreshWarehouseMaterial(flow){
  const selected=flow.state.librarySelection;if(!selected)return;
  try{
    const workflow=await flow.read('conversation-material-workflow',{documentId:selected.document.id});
    if(!validWorkflow(workflow)||workflow.document_id!==selected.document.id)throw fail('SEMANTICA_INVALID_RESPONSE');
    if(flow.state.librarySelection!==selected)return;
    selected.document={...workflow.document,workflow};
    const row=flow.state.warehouseMaterials?.find(d=>d.id===workflow.document_id);if(row)Object.assign(row,selected.document);
  }catch(e){
    if(flow.state.librarySelection===selected){
      // Cached permissions must not survive failed authorization/status reads.
      delete selected.document.workflow;
      if(materialAccessLost(e)){flow.state.librarySelection=null;flow.state.warehouseMaterials=[];}
    }
    throw e;
  }
}

// This explicit action only associates the material for review. Extraction and
// publication still require the existing plan and publication confirmations.
export async function startWarehouseMaterialDialogue(flow){
  if(flow.readerOnly)return;
  const id=flow.state.librarySelection?.document.id;if(!id||flow.state.busy)return;
  let staged=false;
  await flow.run(async()=>{
    await flow.ready();
    const workflow=await flow.read('conversation-material-workflow',{documentId:id});
    if(!validWorkflow(workflow)||workflow.document_id!==id||workflow.actions.start_dialogue.allowed!==true)throw fail('MODELING_MATERIAL_BUSY');
    flow.state.documents=[workflow.document];staged=true;
  });
  if(!staged)return;
  await flow.intake.stageDocument(id);
  if(flow.intake.staged?.documentId===id)await flow.intake.submit({isolated:true,note:''});
}

// Launch locators are navigation hints, not permission to create a conversation
// or change a processing policy. All references are checked in the current scope.
export async function openWarehouseMaterial(flow,target){
  let selected=false;
  await flow.run(async()=>{
    const value=await flow.read('document',{id:target.documentId});
    if(value.document?.id!==target.documentId)throw fail('MODELING_RESOURCE_NOT_FOUND');
    if(target.conversationId){
      const intents=await flow.all('conversation-intents',{conversationId:target.conversationId});
      if(!intents.some(i=>i.id===target.intentId&&i.document_id===target.documentId))throw fail('MODELING_RESOURCE_NOT_FOUND');
      flow.state.materialIndex[target.conversationId]=intents;
    }
    const rows=new Map((flow.state.warehouseMaterials||[]).map(d=>[d.id,d]));
    rows.set(target.documentId,value.document);flow.state.warehouseMaterials=[...rows.values()];selected=true;
  });
  if(!selected||flow.state.error)return false;
  if(flow.readerOnly){
    await flow.importer.select(target.documentId);
    return !flow.state.error&&flow.importer.view?.documentId===target.documentId;
  }
  if(target.conversationId)await flow.selectMaterial(target.conversationId,target.intentId);
  else await selectWarehouseMaterial(flow,target.documentId);
  return !flow.state.error&&(flow.state.librarySelection?.document.id===target.documentId||flow.state.detail?.document_id===target.documentId);
}
