// Material publication is independent of the lifecycle of a chat intent.
export function currentMaterialWorkflow(f){
  const id=f?.state.librarySelection?.document.id||f?.state.detail?.document_id;
  return [f?.state.librarySelection?.document.workflow,f?.state.dialogueWorkflow,f?.importer?.view?.workflow,
    f?.state.warehouseMaterials?.find(d=>d.id===id)?.workflow].find(w=>w?.document_id===id)||null;
}
export function publishedMaterial(w){return !!(w?.publication?.id&&w.publication.status==='published'&&w.publication.document_version_id===w.document_version_id);}
export function publishedMaterialQuality(w){
  if(!publishedMaterial(w))return null;
  const quality=w.publication.extraction_quality;
  if(!quality||typeof quality.coverage_unconfirmed!=='boolean'||!Number.isSafeInteger(quality.excluded_candidate_count)||quality.excluded_candidate_count<0)return null;
  return quality.coverage_unconfirmed||quality.excluded_candidate_count>0?quality:null;
}
export function pendingMaterialDraft(w){return !!(w?.draft&&w.draft.status!=='submitted'&&!w.draft.submitted_at&&(!w.draft.status||w.draft.status==='editing'));}
// Draft existence is a lease/workflow concern, not evidence of a content diff.
// Missing change metadata remains unknown, never an invented manual edit.
export function materialDraftChanges(w){
  if(!pendingMaterialDraft(w))return false;
  if(typeof w.draft.has_changes==='boolean')return w.draft.has_changes;
  if(Number.isSafeInteger(w.draft.change_count)&&w.draft.change_count>0)return true;
  if(w.draft.ontology_changed===true)return true;
  if(w.draft.change_count===0&&w.draft.ontology_changed===false)return false;
  return null;
}
export function automaticMaterialReview(w){
  if(w?.processing_mode!=='automatic')return false;
  if(Object.hasOwn(w,'extraction_review'))return !!w.extraction_review?.run_id;
  return w.stage==='awaiting_review'||w.automatic_processing?.candidate_result_count>0;
}
export function materialResultContext(f){
  const w=currentMaterialWorkflow(f),d=f?.state.detail;
  return !!(w&&w.document_id===d?.document_id&&w.document_version_id===d.document_version_id&&
    (publishedMaterial(w)||pendingMaterialDraft(w)||w.stage==='awaiting_review'));
}
export function materialWorkflowLabel(w){
  if(!w)return null;
  if(w.tasks?.some(t=>['queued','running'].includes(t.status)))return w.label||'材料处理中';
  if(materialDraftChanges(w)===true)return publishedMaterial(w)?'已发布 · 有未发布修改':'未发布 · 有待发布修改';
  if(automaticMaterialReview(w))return publishedMaterial(w)?'已发布 · 新抽取结果待核对':'自动抽取结果待核对';
  if(materialDraftChanges(w)===null)return publishedMaterial(w)?'已发布 · 草稿状态待确认':'草稿状态待确认';
  if(publishedMaterial(w))return '已发布';
  if(pendingMaterialDraft(w))return '未发布 · 草稿待核对';
  if(w.stage==='awaiting_review')return publishedMaterial(w)?'已发布 · 有待核对结果':'未发布 · 抽取结果待核对';
  return null;
}
export function pendingExtractionReview(f,w=currentMaterialWorkflow(f)){
  const d=f?.state.detail;
  return w?.stage==='awaiting_review'||d?.document_id===w?.document_id&&d?.execution?.status==='awaiting_review'&&
    !!d.review?.draft_id&&d.review.draft_id===f.changes?.state.summary?.id&&d.outcome?.publication?.effective!==true;
}
