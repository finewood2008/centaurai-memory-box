import {issueCategory} from '../shared/publication-validation.mjs';
import {createGraphPresentation} from './graph-presentation.mjs';
const suggestionMarker='\n\n【校验修正上下文】\n';
export const validationInstruction=(text,context)=>String(text)+suggestionMarker+context;
export const validationUserInstruction=value=>String(value||'').split(suggestionMarker)[0];

export function validationExclusionRequest(text){
  if(/^(?:请帮我|帮我|请)?(?:移除|删除|排除|去掉)(?:这些|这几条|选中的|选中)(?:条目|事实)[。！!\s]*$/.test(String(text||'').trim()))return {count:null,selected:true};
  const match=String(text||'').trim().match(/^(?:请帮我|帮我|请)?(?:移除|删除|排除|去掉)(?:这些|这|上述|当前|全部|所有)?(?:(\d+|[一二两三四五六七八九十])(?:条|个|项))?(?:有问题的|存在问题的|校验失败的|校验有问题的)(?:条目|事实)[。！!\s]*$/);
  if(!match)return null;
  const count=match[1]?Number(match[1])||({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[match[1]]):null;
  return {count};
}

export function validationSuggestionRequest(text){
  const value=String(text||'').trim().replace(/[。！!\s]+$/u,'').replace(/^(?:请帮我|帮我|请)/u,'');
  return /^(?:(?:根据|针对|结合)(?:这些|当前|本次|上述|选中的)?(?:发布校验问题|校验问题|问题|警告|错误))?(?:给出|提供|生成|建议)(?:一下)?(?:修正|修改|调整)(?:建议|方案)$/.test(value)||
    /^(?:给出|提供|生成)(?:这些|当前|本次|上述|选中的)(?:问题|警告|错误)(?:的)?(?:修正|修改|调整)(?:建议|方案)$/.test(value);
}

export async function validationFacts(changes,preview){
  const wanted=new Set(pendingValidationIssues(preview).map(issue=>issue.item_id).filter(Boolean)),items=[];
  const base={documentId:changes.owner.documentId,draftId:changes.owner.draftId,revision:preview.revision,editor:changes.editor()};
  for(const kind of ['entity','relation']){
    let offset=0,total;
    do{
      const page=await changes.call('items',{...base,kind,offset,limit:50});
      if(page.revision!==preview.revision||!Number.isSafeInteger(page.total)||page.total<0||page.total>10000||total!==undefined&&total!==page.total||page.offset!==undefined&&page.offset!==offset||!Array.isArray(page.items)||page.items.some(item=>!item.id||item.kind!==kind)||!page.items.length&&offset<page.total)throw Object.assign(Error('CORRECTION_REVISION_CONFLICT'),{code:'CORRECTION_REVISION_CONFLICT'});
      total=page.total;items.push(...page.items);offset+=page.items.length;
      if(offset>total)throw Object.assign(Error('SEMANTICA_INVALID_RESPONSE'),{code:'SEMANTICA_INVALID_RESPONSE'});
    }while(offset<total);
  }
  const names=new Map(items.filter(item=>item.kind==='entity').map(item=>[item.id,item.payload?.name||item.id]));
  const types=createGraphPresentation(changes.f.state.ontology?.schema);
  const presented=items.map(item=>({...item,display_name:item.payload?.name||(item.kind==='relation'?
    `${names.get(item.payload?.source_candidate_key)||'未知起点'} → ${types.relation(item.payload?.type||'关系')} → ${names.get(item.payload?.target_candidate_key)||'未知终点'}`:item.id)}));
  return {items:presented,issues:presented.filter(item=>wanted.has(item.id))};
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
