import {issueCategory} from '../shared/publication-validation.mjs';

export function validationExclusionRequest(text){
  const match=String(text||'').trim().match(/^(?:请帮我|帮我|请)?(?:移除|删除|排除|去掉)(?:这些|这|上述|当前|全部|所有)?(?:(\d+|[一二两三四五六七八九十])(?:条|个|项))?(?:有问题的|存在问题的|校验失败的|校验有问题的)(?:条目|事实)[。！!\s]*$/);
  if(!match)return null;
  const count=match[1]?Number(match[1])||({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[match[1]]):null;
  return {count};
}
export function pendingValidationIssues(preview){
  return (preview?.issues||[]).filter(i=>['error','warning'].includes(issueCategory(i)));
}
export function validationSelection(preview,requestedIds=null,count=null){
  const issues=pendingValidationIssues(preview),all=[...new Set(issues.map(i=>i.item_id))];
  const refuse=message=>({error:message});
  if(!preview||!issues.length)return refuse('当前没有可定位的待处理校验问题，请先读取本次发布校验结果。');
  if(!requestedIds&&preview.issue_count>preview.issues.length)return refuse('校验提示尚未完整读取，不能将部分条目当成全部。请在本页勾选明确要处理的条目。');
  const ids=requestedIds?[...new Set(requestedIds)]:all;
  if(!ids.length||ids.some(id=>!id||!all.includes(id)))return refuse('请勾选当前校验结果中需要处理的条目；没有条目标识的问题不能自动移除。');
  if(ids.length>20)return refuse('每次最多处理 20 条事实，请在本页勾选并分批调整。');
  if(count!==null&&count!==issues.length&&count!==ids.length)return refuse(`当前有 ${issues.length} 项待处理提示，对应 ${all.length} 条事实，与指定数量不符。请勾选要处理的条目。`);
  return {ids,issueCount:issues.filter(i=>ids.includes(i.item_id)).length};
}
