// Compatibility routing for the existing change API. This selects a preview
// scope, never authorizes a write and is not a substitute for semantic planning.
export const changeTargets={rules:'仓库本体规则',goal:'本材料整理目标',facts:'材料实体、关系与证据',source:'材料正文'};
export function materialIntent(text,{context=null,clarification=null,goalStage=false,selected=false}={}){
  const value=String(text||'').trim();
  if(!value)return {kind:'question'};
  if(/^(?:请|帮我)?(?:解释|介绍|总结|概括|分析|检查|看看|不要修改|不修改)/.test(value)||/(?:为什么|为何|如何|怎么|怎样|是否|能否|可否|请问)/.test(value)||/[?？]$/.test(value))return {kind:'question'};
  const operations=/(?:修改|调整|增加|新增|删除|移除|去掉|合并|改为|改成|重命名|更名|补充|排除|只关注|重点关注|只抽取|希望|目标)/.test(value);
  const processing=/(?:重新抽取|重新提取|自动抽取|下一步|开始抽取|确认发布|发布知识)/.test(value);
  if((operations||processing||context||clarification)&&/(?:所有|全部|其他|其它|另一份|多份|跨仓|其他仓库).{0,8}(?:材料|文件|仓库)|(?:批量|全仓)(?:修改|重新|抽取|处理)/.test(value))return {kind:'scope'};
  const rules=/(?:本体|知识仓|仓库).*(?:类型|规则|关系|属性|结构)|(?:实体|关系)类型(?:定义|名称|规则)|(?:新增|增加|合并|删除).{0,12}(?:类型|属性定义)|(?:修改|调整).{0,8}(?:类型定义|本体)/.test(value);
  const goal=/(?:整理|抽取|提取|处理)(?:的)?(?:目标|目的|范围)|(?:目标|目的)(?:改为|改成|是|为)|(?:只|重点)(?:关注|抽取|整理)/.test(value);
  const source=/(?:修改|调整|更正|修正|替换|删除|补充).{0,8}(?:正文|原文|段落)|(?:正文|原文|段落).*(?:改为|改成|修正)/.test(value);
  // Type definitions are rule objects, not fact objects. Remove that noun
  // phrase only, retaining a separate explicit fact operation in the sentence.
  const factText=value.replace(/(?:实体|关系)类型(?:定义|名称|规则)?/g,'类型');
  const facts=/(?:这个|该|选中|这些|当前)(?:的)?(?:实体|事实|关系)|(?:实体|事实).*(?:改为|改成|更名|排除)|(?:修改|删除|排除|去掉|调整).*(?:事实|实体|证据)/.test(factText);
  const targets=[rules&&'rules',goal&&'goal',source&&'source',facts&&'facts'].filter(Boolean);
  // A command carrying a modification is a multi-step request. Existing APIs
  // cannot atomically plan/execute it; do not silently drop either half.
  // Standalone commands have already been handled by materialCommand. A
  // command with extra text must never fall through into a goal-stage answer.
  if(targets.length>1||processing)return {kind:'compound',targets};
  if(targets.length)return {kind:'change',target:targets[0]};
  if(['goal','rules','facts'].includes(context))return {kind:'change',target:context};
  if(clarification)return {kind:'change',target:clarification};
  if(goalStage&&(!operations||/^(?:我)?(?:希望|想要)/.test(value)))return {kind:'goal-dialogue'};
  if(operations)return selected?{kind:'change',target:'facts'}:{kind:'clarify'};
  return {kind:'question'};
}

export function proposalWithinTarget(proposal,target){
  const changes=proposal?.result?.changes;
  return Array.isArray(changes)&&changes.length>0&&changes.every(change=>change.scope===target);
}
