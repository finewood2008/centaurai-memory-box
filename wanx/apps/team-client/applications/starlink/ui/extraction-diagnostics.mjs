const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stages={entities:'实体抽取',relations:'关系抽取',joint:'联合抽取'};
const reasons={LLM_OUTPUT_SCHEMA_ERROR:'模型输出结构不符合要求',LLM_OUTPUT_INVALID_JSON:'模型输出不是有效 JSON',LLM_OUTPUT_TRUNCATED:'模型输出被截断',EXTRACTION_PARTIAL_FAILURE:'部分抽取批次失败',LLM_OUTPUT_ERROR:'模型输出不符合要求'};
const kinds={invalid_json:'模型输出不是有效 JSON',truncated:'模型输出被截断',invalid_response:'未收到有效模型输出',response_too_large:'模型输出超过大小限制'};
const validators={required:'缺少必填字段',type:'字段类型不符合要求',additionalProperties:'包含不支持的字段',maxItems:'列表条目过多',maxLength:'字段内容过长',maximum:'数值超过允许范围',enum:'字段值不在允许范围内'};
export function extractionFailuresHTML(job){
  if(!job||!['failed','cancelled'].includes(job.status))return '';
  const rows=Array.isArray(job.metrics?.extraction_failures)?job.metrics.extraction_failures:[];
  if(!rows.length)return '';
  return `<section class="cv-extraction-failures" aria-label="抽取失败批次"><h4>本次失败批次</h4><p>以下为抽取工作批次，与正文阅读分组不同。重试原任务将保留可复用的成功批次。</p>${rows.map(row=>{
    const d=row?.diagnostic,known=d?.version===1&&['semantica','bridge','upstream'].includes(d.source)&&!!stages[row.stage];
    const diagnostic=known?(d.kind==='schema_validation'?validators[d.validator]||'模型输出结构不符合要求':kinds[d.kind]):null;
    const reason=diagnostic||reasons[row?.reason]||'本批抽取失败，未返回精确诊断';
    const batch=Number.isSafeInteger(row?.batch_index)&&row.batch_index>=0?`第 ${row.batch_index+1} 批`:'批次待确认';
    const path=known&&typeof d.field_path==='string'&&d.field_path.length<=512&&d.field_path.split('/').length<=17&&/^(\/(?:\d+|\*|entities|relations|name|type|properties|confidence|evidence|source|target|source_candidate_key|target_candidate_key|segment_id|excerpt|e|r|n|t|p|c|s))*$/.test(d.field_path)?d.field_path:null;
    return `<article><p>${batch} · ${stages[row?.stage]||'阶段未确定'} · ${esc(reason)}</p>${path!==null?`<details><summary>查看字段位置</summary><code>${esc(path||'根对象')}</code></details>`:''}</article>`;
  }).join('')}</section>`;
}
