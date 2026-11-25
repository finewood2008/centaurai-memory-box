const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stages={entities:'实体抽取',relations:'关系抽取',joint:'联合抽取'};
const groundedReasons={LLM_OUTPUT_EVIDENCE_ERROR:'实体、关系或新增类型缺少可定位的原文依据',LLM_OUTPUT_REFERENCE_ERROR:'实体编号重复或关系端点引用无效',LLM_OUTPUT_ONTOLOGY_ERROR:'类型定义冲突或关系端点类型不符合本体',LLM_OUTPUT_NONFACT_ERROR:'关系把否定、计划或不确定陈述作为已成立事实'};
const reasons={LLM_OUTPUT_SCHEMA_ERROR:'模型输出结构不符合要求',LLM_OUTPUT_INVALID_JSON:'模型输出不是有效 JSON',LLM_OUTPUT_TRUNCATED:'模型输出被截断',EXTRACTION_PARTIAL_FAILURE:'部分抽取批次失败',LLM_OUTPUT_ERROR:'模型输出不符合要求',LLM_OUTPUT_CONTINUATION_STALLED:'模型续抽重复已有结果，未能确认抽取完整性',LLM_OUTPUT_CONTINUATION_LIMIT:'续抽达到安全轮数上限，未能确认抽取完整性',LLM_OUTPUT_DUPLICATE_ENTITY_IDS:'实体编号重复或冲突，无法定位关系端点',LLM_OUTPUT_EMPTY_ENTITY_ID:'实体编号为空，无法定位关系端点',EXTRACTION_CONTEXT_BUDGET:'正文、提示词与输出预留超过模型上下文预算'};
const kinds={invalid_json:'模型输出不是有效 JSON',truncated:'模型输出被截断',invalid_response:'未收到有效模型输出',response_too_large:'模型输出超过大小限制'};
const validators={required:'缺少必填字段',type:'字段类型不符合要求',additionalProperties:'包含不支持的字段',maxItems:'列表条目过多',maxLength:'字段内容过长',maximum:'数值超过允许范围',enum:'字段值不在允许范围内'};
export const extractionRepreviewRequired=job=>[job?.retry_blocked_code,job?.error_code].some(code=>['MODELING_PROMPT_CHANGED','MODELING_MODEL_CHANGED','LLM_PROMPT_CHANGED','LLM_MODEL_CHANGED'].includes(code));
export function extractionValidationHTML(job){
  const validation=job?.metrics?.joint_validation;
  const count=key=>Number.isSafeInteger(validation?.[key])&&validation[key]>0?validation[key]:0;
  const entities=count('rejected_entities'),relations=count('rejected_relations'),types=count('rejected_types');
  const blocked=validation?.publication_blocked===true;
  const summary=job?.knowledge_summary;
  const noCandidates=blocked&&(!!job?.metrics?.extraction_empty_reason||summary?.candidate_entities===0&&summary?.candidate_relations===0);
  const issue=job?.metrics?.extraction_completeness_issues?.find?.(item=>typeof item?.message==='string');
  if(job?.metrics?.extraction_empty_reason&&!entities&&!relations&&!types&&!issue)return '';
  if(!entities&&!relations&&!types&&!blocked)return '';
  const automatic=validation?.valid_candidates_automatic===true;
  const diff=job?.metrics?.publication_diff;
  const missing=[['entities','个实体'],['relations','条关系'],['properties','项属性']].filter(([key])=>Number.isSafeInteger(diff?.[key])&&diff[key]>0).map(([key,label])=>`${diff[key]} ${label}`);
  const repairDropped=Array.isArray(job?.metrics?.extraction_completeness_issues)&&job.metrics.extraction_completeness_issues.some(i=>i?.reason==='REPAIR_DROPPED_FACTS');
  const message=blocked?(missing.length?`重新抽取比当前发布版本少了 ${missing.join('、')}。本次未替换图谱，已有知识保留，请核对差异。`:repairDropped?'模型纠错遗漏了首轮已通过校验的事实。首轮候选已保留，本次未自动入图，请核对后发布。':issue?.message||(noCandidates?'本轮没有可核对的候选。':'抽取结果需核对，本次未自动入图，已有知识保留。')):automatic?'通过校验的候选已进入自动发布流程，已有有效知识保留。':'其他通过校验的候选已保留。';
  const counts=[entities?`${entities} 个实体`:'',relations?`${relations} 条关系`:'',types?`${types} 个新类型`:''].filter(Boolean);
  const rows=Array.isArray(job.metrics?.joint_rejections)?job.metrics.joint_rejections:[];
  return `<section class="cv-extraction-failures"><p>${counts.length?`已隔离 ${counts.join('、')}，校验未通过。`:''}${esc(message)}</p>${rows.length?`<details><summary>查看校验问题</summary>${diagnosticRowsHTML(rows)}</details>`:''}${job.document_id&&!noCandidates?`<button class="text-link" data-overview-document="${esc(job.document_id)}">${automatic&&!blocked?'查看隔离结果':'前往资料库核对'}</button>`:''}</section>`;
}
export function extractionFailuresHTML(job){
  if(!job||!['failed','cancelled'].includes(job.status))return '';
  if(extractionRepreviewRequired(job))return '<section class="cv-extraction-failures" role="alert"><p>抽取版本或模型配置已变化，旧任务不能继续重试。请重新预览并确认新任务。</p></section>';
  const rows=Array.isArray(job.metrics?.extraction_failures)?job.metrics.extraction_failures:[];
  if(!rows.length)return '';
  return `<section class="cv-extraction-failures" aria-label="抽取失败批次"><h4>本次失败批次</h4><p>以下为抽取工作批次，与正文阅读分组不同。重试原任务将保留可复用的成功批次。</p>${diagnosticRowsHTML(rows)}</section>`;
}
function diagnosticRowsHTML(rows){
  return rows.map(row=>{
    const d=row?.diagnostic,known=d?.version===1&&['semantica','bridge','upstream'].includes(d.source)&&!!stages[row.stage];
    const diagnostic=known?(d.kind==='schema_validation'?validators[d.validator]||'模型输出结构不符合要求':kinds[d.kind]):null;
    const reason=groundedReasons[row?.reason]||diagnostic||reasons[row?.reason]||'本批抽取失败，未返回精确诊断';
    const batch=Number.isSafeInteger(row?.batch_index)&&row.batch_index>=0?`第 ${row.batch_index+1} 批`:'批次待确认';
    const path=known&&typeof d.field_path==='string'&&d.field_path.length<=512&&d.field_path.split('/').length<=17&&/^(\/(?:\d+|\*|entities|relations|new_types|entity_types|relation_types|evidence_ids|definition|source_types|target_types|name|type|id|label|text|quote|subject_id|object_id|predicate|properties|confidence|evidence|source|target|source_candidate_key|target_candidate_key|segment_id|excerpt|e|r|n|t|p|c|s))*$/.test(d.field_path)?d.field_path:null;
    return `<article><p>${batch} · ${stages[row?.stage]||'阶段未确定'} · ${esc(reason)}</p>${path!==null?`<details><summary>查看字段位置</summary><code>${esc(path||'根对象')}</code></details>`:''}</article>`;
  }).join('');
}
