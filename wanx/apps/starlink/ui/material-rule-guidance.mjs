const marker='\n\n【本体建议约定】\n';
const guidance='只生成待用户确认的本体规则建议，不修改目标或材料事实。根据当前目标、现有本体和用户已说明的业务含义，优先复用已有类型。新增类型或关系时，请主动建议中文标签、编码和清楚的定义；关系还需说明两端类型。建议不是材料中已存在的事实，不要因材料没有出现类型定义原文而要求用户填写 label/definition。已有类型未要求改变的定义保持原样。严格保留用户已明确的约束，例如不增加属性或关系；不要重复询问。仅在业务含义存在关键歧义时，用普通业务语言追问，不要求用户提供技术字段。';
export function ruleUserInstruction(value){const text=String(value||''),suffix=marker+guidance;return text.endsWith(suffix)?text.slice(0,-suffix.length):text;}
export function ruleSuggestionInstruction(value){return ruleUserInstruction(value)+marker+guidance;}
export function ruleStageHint(flow){
  const c=flow.changes,p=c.state.proposals.find(p=>p.id===c.record.lastProposal);
  if(p?.id!==c.record.deferredProposal&&(c.record.proposalTargets?.[p?.id]||'facts')==='rules'){
    if(p.status==='prepared')return '建议已生成。下一步：核对中文名称、含义和关系两端，确认应用后再发布本体。';
    if(p.status==='needs_clarification')return '请补充业务含义，或点击“助手先建议名称与含义”。已说明的限制会随本轮补充一起提交。';
    if(p.status==='generating')return '正在生成本体建议，请等候结果。尚未应用或发布。';
  }
  if(c.record.ontologyDraftId)return '建议已保存为本体草稿。下一步：核对完整本体并确认发布，尚未开始抽取。';
  if(c.record.rulesPublished)return '本体已发布。下一步：核对本材料的抽取目标与计划，再确认开始抽取。';
  return '先让助手建议名称和含义，或直接用业务语言补充。建议生成后再确认应用、发布本体并核对抽取计划。';
}
