// Business completion comes from server receipts; the selected tab is only navigation.
export function retainedMaterialResults(detail) {
  // Stop is not source invalidation. Only a server-retained completed execution
  // permits continuing its results; old cancelled executions remain blocked.
  return detail?.status==='cancelled'&&detail.source_status==='available'&&!!detail.document_version_id&&
    !detail.invalid_reason&&detail.execution?.status==='awaiting_review';
}
export function candidatesReady(detail) {
  return detail?.source_status==='available'&&(detail.status==='awaiting_review'||retainedMaterialResults(detail));
}
export function materialSourceUsable(detail) {
  return detail?.source_status==='available'&&detail.status!=='stale'&&(detail.status!=='cancelled'||retainedMaterialResults(detail));
}
export function extractionProgress(progress){
  const completed=Number.isSafeInteger(progress?.completed_units)&&progress.completed_units>=0?progress.completed_units:null;
  const total=Number.isSafeInteger(progress?.total_units)&&progress.total_units>0?progress.total_units:null;
  const known=completed!==null&&total!==null&&completed<=total;
  return {completed,total,known,remaining:known?total-completed:null,percent:known?Math.floor(completed/total*100):null};
}
export function publicationCurrent(detail) {
  const p=detail?.outcome?.publication;
  return p?.status==='succeeded'&&p.run_status==='published'&&p.effective===true&&
    !!p.run_id&&p.run_id===detail.outcome.current_run_id;
}
export function knowledgeCurrent(detail,value) {
  const correction=value?.verifiedCorrectionPublication;
  const corrected=correction?.status==='succeeded'&&correction.effective===true&&correction.run_status==='published'&&
    correction.document_id===detail?.document_id&&correction.document_version_id===detail?.document_version_id&&
    correction.current_run_id===detail?.outcome?.current_run_id;
  return materialSourceUsable(detail)&&(publicationCurrent(detail)||corrected)&&value?.run?.id===detail.outcome.current_run_id&&
    value.run.status==='published'&&value.run.document_id===detail.document_id&&
    value.run.document_version_id===detail.document_version_id&&Array.isArray(value.candidates);
}
export function materialProgress(detail,knowledge=null) {
  const goal=!!detail?.goal?.goal&&detail.source_status==='available'&&!['stale','cancelled'].includes(detail.status);
  const execution=goal&&!!detail?.execution?.id;
  return {goal,execution,published:knowledgeCurrent(detail,knowledge),stage:execution?3:goal?2:1};
}
export function planCurrent(plan,overview,detail,ontology) {
  return !!plan&&overview?.status==='active'&&detail?.status==='ready_for_confirmation'&&
    detail.source_status==='available'&&plan.intent_id===detail.id&&plan.revision===detail.revision&&
    plan.conversation_revision===overview.revision&&plan.document_version_id===detail.document_version_id&&
    plan.ontology_id===ontology?.id&&ontology.status==='published'&&plan.publication_policy==='review_required';
}
