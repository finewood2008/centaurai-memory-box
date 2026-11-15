// Material publication is independent of the lifecycle of a chat intent.
export function currentMaterialWorkflow(f){
  const id=f?.state.librarySelection?.document.id||f?.state.detail?.document_id;
  return [f?.state.librarySelection?.document.workflow,f?.state.dialogueWorkflow,f?.importer?.view?.workflow,
    f?.state.warehouseMaterials?.find(d=>d.id===id)?.workflow].find(w=>w?.document_id===id)||null;
}
export function publishedMaterial(w){return !!(w?.publication?.id&&w.publication.status==='published'&&w.publication.document_version_id===w.document_version_id);}
export function pendingMaterialDraft(w){return !!(w?.draft&&w.draft.status!=='submitted'&&!w.draft.submitted_at&&(!w.draft.status||w.draft.status==='editing'));}
export function materialResultContext(f){
  const w=currentMaterialWorkflow(f),d=f?.state.detail;
  return !!(w&&w.document_id===d?.document_id&&w.document_version_id===d.document_version_id&&
    (publishedMaterial(w)||pendingMaterialDraft(w)||w.stage==='awaiting_review'));
}
export function materialWorkflowLabel(w){
  if(!w)return null;
  if(w.tasks?.some(t=>['queued','running'].includes(t.status)))return w.label||'材料处理中';
  if(pendingMaterialDraft(w))return publishedMaterial(w)?'已发布 · 有未发布修改':'未发布 · 草稿待核对';
  if(w.stage==='awaiting_review')return publishedMaterial(w)?'已发布 · 有待核对结果':'未发布 · 抽取结果待核对';
  if(publishedMaterial(w))return '已发布';
  return null;
}
export function pendingExtractionReview(f,w=currentMaterialWorkflow(f)){
  const d=f?.state.detail;
  return w?.stage==='awaiting_review'||d?.document_id===w?.document_id&&d?.execution?.status==='awaiting_review'&&
    !!d.review?.draft_id&&d.review.draft_id===f.changes?.state.summary?.id&&d.outcome?.publication?.effective!==true;
}
