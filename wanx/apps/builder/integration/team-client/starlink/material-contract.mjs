// Only identifiers and transport metadata cross the diagnostic boundary. Never copy
// a response body, exception message, request headers or source text into diagnostics.
export const materialActions = new Set(['material-workflows','material-workflow','material-preview','material-transition','material-transition-status']);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const revision = v => Number.isSafeInteger(v) && v > 0;
export function materialDiagnostic(error = {}, defaults = {}) {
  const status = error.httpStatus ?? defaults.httpStatus;
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'MATERIAL_REQUEST_FAILED';
  const category = error.category === 'structure' ? 'structure' : status === 401 || status === 403 || /AUTH|FORBIDDEN|OWNER_REQUIRED|SESSION/.test(code) ? 'authorization' : status === 404 ? 'unavailable' : status >= 500 ? 'server' : status >= 400 ? 'business' : /INVALID_RESPONSE|RESPONSE_INVALID/.test(code) ? 'structure' : 'network';
  const requestId = error.requestId ?? defaults.requestId;
  return {code, category, httpStatus:Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    requestId:id(requestId) ? requestId : null,
    ...((error.requestSource??defaults.requestSource)==='client'?{requestSource:'client'}:{})};
}
export function materialErrorText(error) {
  const d = materialDiagnostic(error);
  const label = {network:'网络或客户端入口异常',authorization:'登录或访问权限不足',unavailable:'材料不存在或接口版本不兼容',server:'服务端处理异常',business:'服务端拒绝当前操作',structure:'响应结构或材料版本不匹配'}[d.category];
  return `${label}（${d.httpStatus ? 'HTTP '+d.httpStatus+'；' : '未取得 HTTP 状态；'}${d.code}${d.requestId ? '；'+(d.requestSource==='client'?'客户端请求 ':'请求 ')+d.requestId : ''}）`;
}
export function unwrapMaterialResponse(result) {
  if (!result?.materialResponse) return result;
  const r = result.materialResponse;
  if (!r.ok) throw Object.assign(Error(r.error.code), r.error);
  return {...r.value, _transport:r.diagnostics};
}
export function assertWorkflow(w, documentId, versionId) {
  if (!w || w.document_id !== documentId || !(w.document_version_id===null||id(w.document_version_id)) || (versionId && w.document_version_id !== versionId) ||
      !revision(w.workflow_revision) || !w.actions || !w.automatic_processing ||
      ['edit_source','prepare_automatic'].some(k => typeof w.actions[k]?.allowed !== 'boolean') ||
      (w.actions.prepare_automatic.allowed&&!id(w.document_version_id))) invalid(w);
  return w;
}
export function invalid(value) {
  throw Object.assign(Error('MATERIAL_RESPONSE_INVALID'),materialDiagnostic({code:'MATERIAL_RESPONSE_INVALID',category:'structure'},value?._transport));
}
export function assertPreview(p, w, operationId) {
  if (!p || p.document_id !== w.document_id || p.operation_id !== operationId || p.target_mode !== 'automatic' ||
      !id(p.preview_id) || !digest(p.preview_digest) || p.workflow_revision !== w.workflow_revision ||
      !Number.isFinite(Date.parse(p.expires_at)) || typeof p.can_confirm !== 'boolean' || !Array.isArray(p.blockers) ||
      p.blockers.some(b => !b || typeof b.code !== 'string' || typeof b.detail !== 'string')) invalid(p);
  if (p.can_confirm && (p.snapshot?.document_version_id !== w.document_version_id || p.publication_policy !== 'automatic' ||
      !p.replacement || ['draft_count','modified_draft_count','candidate_result_count','modified_candidate_result_count'].some(k => !Number.isSafeInteger(p.replacement[k]) || p.replacement[k] < 0) ||
      ['requires_acknowledgement','replaces_manual_publication','preserves_history'].some(k => typeof p.replacement[k] !== 'boolean') ||
      (p.replacement.requires_acknowledgement && !digest(p.replacement.acknowledgement_digest)))) invalid(p);
  return p;
}
export function materialRequest(action, input) {
  const fields = { 'material-workflows':['offset','limit'], 'material-workflow':[],
    'material-preview':['operationId','versionId','workflowRevision'],
    'material-transition':['operationId','previewId','previewDigest','workflowRevision','confirmed','replacementAcknowledgement'],
    'material-transition-status':['transitionId']}[action];
  const fail = () => {throw Object.assign(Error('TEAM_DATA_TARGET_INVALID'),{code:'TEAM_DATA_TARGET_INVALID'});};
  if (!fields || !input || Array.isArray(input) || Object.keys(input).some(k => !['warehouseId',...(action==='material-workflows'?[]:['documentId']),...fields].includes(k)) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.warehouseId || '')) fail();
  const base='/warehouses/'+input.warehouseId+'/workbench/conversations/materials';
  if (action==='material-workflows') {
    const offset=input.offset??0,limit=input.limit??50;
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50) fail();
    return {path:base+'?'+new URLSearchParams({offset:String(offset),limit:String(limit)})};
  }
  if (!id(input.documentId)) fail();
  const path=base+'/'+input.documentId;
  if(action==='material-workflow')return {path};
  if(action==='material-transition-status'){if(!id(input.transitionId))fail();return {path:path+'/processing-transitions/'+input.transitionId};}
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.operationId || '') || !revision(input.workflowRevision)) fail();
  const body={operation_id:input.operationId,_native_operation_id:input.operationId,expected_workflow_revision:input.workflowRevision};
  if(action==='material-preview') {
    if(!id(input.versionId))fail();
    Object.assign(body,{target_mode:'automatic',expected_document_version_id:input.versionId});
  } else {
    if(!id(input.previewId)||!digest(input.previewDigest)||input.confirmed!==true||input.replacementAcknowledgement!==undefined&&!digest(input.replacementAcknowledgement)) fail();
    Object.assign(body,{preview_id:input.previewId,preview_digest:input.previewDigest,confirmed:true,
      ...(input.replacementAcknowledgement!==undefined?{replacement_acknowledgement:input.replacementAcknowledgement}:{})});
  }
  return {path:path+(action==='material-preview'?'/processing-previews':'/processing-transitions'),options:{method:'POST',body}};
}
