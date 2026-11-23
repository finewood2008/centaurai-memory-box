// Synthetic intent provider for UI integration tests; not a semantic accuracy test.
import catalog from '../../shared/starxiaotu-catalog.mjs';
import {starxiaotuNeedle} from '../../ui/starxiaotu-records.mjs';
const guide=catalog.guides;
const guideKey=value=>({conversation:'library',list:'data',attribute:'entity',type:'entity',record:'data',source:'library',evidence:'library'})[value]||(guide[value]?value:'general');
function classifyStarxiaotuRequest(value, context = 'general', {ontologyConversation = false} = {}) {
  const text = String(value ?? '').trim();
  if (!text) return {kind:'empty',text};
  // Explicit lookup is read-only even when the requested document title contains edit verbs.
  const explicitSearch = /^(?:请问|请|麻烦)?\s*(?:帮我|替我)?\s*(?:检索|搜索|查找|找一下)(?!功能|怎么|如何)/.test(text);
  const sourceQuestion = /(?:资料|材料|文档|原文|正文|文件)(?:库)?(?:里|中|内).*(?:提到|提及|记载|介绍|讲|如何|怎么|什么|有没有)|(?:资料|材料|文档|原文).*(?:提到|提及|记载|讲过)/.test(text);
  if (explicitSearch) return {kind:'search',text};
  // A negated operation must never create an ontology proposal.
  if (/(?:不要|别|不需要|无需|不用|暂不|先不)\s*(?:帮我|替我|直接)?\s*(?:修改|改|删除|新增|增加|添加|保存|更新|发布|导入|创建)/.test(text)) {
    const key=/脱敏规则/.test(text)?'sensitive':/本体|属性|字段|类型/.test(text)?'ontology':/模型/.test(text)?'models':guideKey(context);
    return {kind:'explain',text,key};
  }
  const usageQuestion = /^(?:请问|请|麻烦)?\s*(?:告诉我|教我|介绍一下|解释一下)?\s*(?:(?:怎么|如何|怎样)(?:使用|进行|才能|可以)?(?:搜索|检索|查找|导入|批量导入|上传|创建|新建|修改|编辑|校对|查看|看|统计|设置|配置|打开|进入)|(?:搜索|检索|导入|批量导入|创建|新建)(?:功能)?(?:怎么用|如何使用|怎么操作))/.test(text);
  if (usageQuestion && !sourceQuestion) {
    if(/(?:查看|看|统计)(?:一下)?(?:(?:我|当前|这个|本|项目|星图|的|有|共有|总共|多少|所有|全部))*?(?:资料|材料|文档|实体|关系)(?:的)?(?:数量|总数|有多少)?[？?。！!\s]*$/.test(text))return {kind:'explain',text,key:/多少|数量|总数|统计/.test(text)?'overview':/实体/.test(text)?'knowledge':/关系/.test(text)?'data':'library'};
    const key=/搜索|检索|查找/.test(text)?'search':/导入|上传/.test(text)?'import':/(?:创建|新建).*(?:星图|项目|仓库|知识仓)/.test(text)?'create':/(?:修改|编辑|校对).*(?:原文|正文)/.test(text)?'sourceEdit':/(?:修改|编辑|校对).*(?:记录|关系)/.test(text)&&!/本体|关系类型/.test(text)?'recordEdit':null;
    if(key)return {kind:'explain',text,key};
  }
  const writing = /(?:修改|改成|改为|改名|重命名|删(?:除|掉)|新增|增加|添加|补充|创建|保存|更新|合并|批量|写入|撤销|重新(?:提取|处理)|重提取|替换|调整|导入|设为)/.test(text);
  const pageQuestion = /^(?:请问|请|帮我)?\s*(?:(?:这个|当前|本|该)(?:页面|板块|页)|这里|此页)(?:的)?\s*(?:怎么用|有什么用|是什么意思|有哪些功能|有什么功能|能做什么|可以做什么|能帮我什么|如何使用|怎样使用)[？?。！!\s]*$/.test(text) || /^(?:你能做什么|能问什么|怎么提问)[？?。！!\s]*$/.test(text);
  const pageHelp = pageQuestion && /有哪些功能|有什么功能|能做什么|可以做什么|能帮我什么/.test(text);
  const explainOnly = (pageHelp || /(?:什么是|是什么|是啥|是什么意思|有什么用|怎么用|如何使用|怎样使用|有哪些功能|有什么功能|区别|关系是什么|(?:怎么|如何|怎样)(?:才能|可以)?(?:修改|增加|添加|删除|编辑|导入|创建|调整|设置|配置|查看|看|打开|进入)|(?:在哪|哪里)(?:里)?(?:可以|能)?(?:查看|看|打开)|(?:支持|能不能|可以).*(?:修改|编辑).*(?:吗|么|？|\?))/.test(text)) &&
    !/(?:帮我|替我|代我|执行|直接).*(?:改|删|增|添|保存|更新|合并|创建|导入|提取)/.test(text);
  if(/^(?:请|帮我)?(?:看看|查看|介绍一下|概括一下|总结一下)?(?:当前|这个|本)?(?:星图|项目|资料库)(?:里|里面|中)?(?:都)?(?:有|包含|收录了|整理了)(?:什么|哪些(?:资料|材料|知识|内容)?|多少(?:资料|材料|实体|关系))(?:内容|资料|材料|知识)?[？?。！!\s]*$/.test(text))return {kind:'project-overview',text};
  if(/^(?:请|帮我)?(?:查看|看看|统计)(?:一下)?(?:当前项目|当前星图|这个项目|本项目|我)?(?:的)?(?:资料|材料|文档|实体|关系)(?:的)?(?:数量|总数)[？?。！!\s]*$/.test(text)||/^(?:我|当前项目|当前星图|这个项目|本项目)?(?:一共|总共)?有多少(?:份|个|条)?(?:资料|材料|文档|实体|关系)[？?。！!\s]*$/.test(text))return {kind:'project-overview',text};
  const corpus = /(?:资料|材料|文档|原文|正文|文件)(?:库)?(?:里|中|内)|(?:检索|搜索)|(?:资料|材料|文档|原文).*(?:提到|提及|记载|讲过)|(?:提到|提及).*(?:资料|材料|文档)/.test(text);
  if (sourceQuestion || corpus && (!writing || explainOnly)) return {kind:'search',text};
  const pages = [['overview','概览'],['ontology','本体'],['conversation','资料库'],['knowledge','知识页'],['data','数据列表'],['graph','星图'],['models','模型设置'],['warehouses','项目列表|我的项目'],['tasks','处理任务|任务中心'],['sensitive','脱敏规则']];
  for(const [destination,name] of pages) {
    if(new RegExp('^(?:请|麻烦)?(?:帮我)?(?:直接)?(?:带我(?:去|到)|前往|进入|打开|跳转到|跳到|切换到|去)(?:一下)?[「“\\s]*(?:'+name+')(?:页面|页|板块)?[」”\\s]*[？?。！!]*$').test(text))return {kind:'navigate',text,destination};
  }
  for(const [destination,name] of pages) {
    if(new RegExp('^(?:请问)?(?:'+name+')(?:页面|功能|入口)?(?:在哪(?:里)?|在哪里打开|怎么打开)[？?。！!\\s]*$').test(text))return {kind:'explain',text,key:guideKey(destination)};
  }
  if(!pageQuestion && /本体|实体类型|关系类型|类型定义|属性|字段/.test(text) && /当前|我的|我有哪些|已定义|已配置/.test(text) && !writing && !/怎么|如何|怎样|在哪|哪里|有什么用|是什么意思/.test(text))return {kind:'ontology-query',text};
  if (explainOnly || /^(?:介绍|解释|了解)(?:一下)?/.test(text) || /你能做什么|能问什么|怎么提问/.test(text)) {
    const key = /处理任务/.test(text) ? 'tasks' : /脱敏规则/.test(text) ? 'sensitive' : /星图设置/.test(text) ? 'onboarding' : /模型|脱敏|设置/.test(text) ? 'models' : /项目列表|切换项目|不同项目/.test(text) ? 'warehouses' : /知识页/.test(text) ? 'knowledge' : /本体|规则/.test(text) ? 'ontology' : /资料库|原文|来源|证据/.test(text) ? 'library' : /数据列表|记录/.test(text) ? 'data' : /关系|连线/.test(text) ? 'relation' : /属性|字段|实体|类型|必填|选填/.test(text) ? 'entity' : /概览/.test(text) ? 'overview' : /星图/.test(text) ? 'graph' : 'general';
    if (key==='general' && pageQuestion && guideKey(context)!=='general') return {kind:'explain',text,key:guideKey(context)};
    return key==='general' && !/你能做什么|能问什么|怎么提问|介绍星小图|解释星小图/.test(text) ? {kind:'search',text} : {kind:'explain',text,key};
  }
  if (/本体|实体类型|关系类型|类型定义|类型结构|属性|字段/.test(text) && !writing && /查看|看看|列出|展示|查询|有哪些|有什么|哪些|多少/.test(text)) return {kind:'ontology-query',text};
  if (ontologyConversation && /^(?:确认应用到草稿|确认应用|按这个建议修改|按建议修改|采用建议|确认|下一步|继续|进入下一步)[。！!\s]*$/.test(text) || /^(?:发布|确认发布|确认发布规则|核对并发布|查看发布预览|我已核对[，,\s]*确认发布)[。！!\s]*$/.test(text)) return {kind:'ontology-control',text};
  if (ontologyConversation && /必填|选填/.test(text) && /改|设|调整|保留|保持|取消/.test(text) && !/原文|正文|记录|模型/.test(text))return {kind:'ontology-change',text};
  if (writing && !explainOnly) {
    const destination = /脱敏规则/.test(text) ? 'sensitive' : /模型|脱敏|设置/.test(text) ? 'models' : /记录|原文|正文/.test(text) && !/本体|实体类型|关系类型|类型定义/.test(text) ? 'conversation' : /本体|规则|实体类型|关系类型|类型结构|类型定义|属性|字段/.test(text) ? 'ontology' : 'conversation';
    return {kind:destination==='ontology'?'ontology-change':'write',text,destination};
  }
  if (/^(?:请)?(?:帮我|替我|给我)?(?:直接|自动)?(?:定位|跳到|找到|打开)/.test(text)) return {kind:'locate',text};
  if (/^(?:请)?(?:帮我)?(?:看看|看一下|查看|看一看)\s*\S+/.test(text) || /^(?:本体|合同)[？?。\s]*$/.test(text) || ontologyConversation && !/[？?]|什么|哪|谁|多少/.test(text))return {kind:'clarify',text,editing:ontologyConversation};
  return {kind:'search',text};
}

export function syntheticStarxiaotuDecision(body) {
  const r=classifyStarxiaotuRequest(body.text,body.page,{ontologyConversation:body.ontology_conversation});
  const result=(intent,target,args={})=>({intent,target,arguments:args});
  if(r.kind==='explain')return result('guide',r.key);
  if(r.kind==='navigate')return result('navigate',r.destination);
  if(r.kind==='ontology-query')return result('query','ontology_rules');
  if(r.kind==='project-overview')return result('query','project_stats',{metric:'summary'});
  if(r.kind==='ontology-change')return result('ontology_change','ontology');
  if(r.kind==='write')return result('guide',r.destination==='conversation'?'sourceEdit':r.destination);
  if(r.kind==='clarify')return result('clarify','none',{reason:'ambiguous',candidates:[result('query','ontology_rules'),result('search','materials',{query:body.text})]});
  return result(r.kind==='locate'?'navigate':'search',r.kind==='locate'?'record':'materials',{query:starxiaotuNeedle(body.text)||body.text});
}
