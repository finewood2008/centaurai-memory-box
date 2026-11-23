import catalog from './starxiaotu-catalog.mjs';
export {catalog as starxiaotuCatalog};
const object=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string' && value.trim() && [...value].length<=max && !/[\uD800-\uDFFF]/u.test(value);
const fail=()=>{throw Object.assign(new Error('意图识别结果无效，请选择功能或重新描述。'),{code:'MODELING_INTENT_INVALID'});};
const page=value=>[...Object.keys(catalog.pages),'onboarding','general'].includes(value);
export function validateStarxiaotuDecision(value) {
  if(!object(value,['intent','target','arguments']))return fail();
  const {intent,target,arguments:args}=value;
  if(typeof intent!=='string'||typeof target!=='string')return fail();
  let valid=false;
  if(intent==='guide' && Object.hasOwn(catalog.guides,target) || intent==='navigate' && Object.hasOwn(catalog.pages,target) || intent==='query' && target==='ontology_rules' || intent==='ontology_change' && target==='ontology' || intent==='unsupported' && target==='none')valid=object(args,[]);
  else if(intent==='search' && target==='materials' || intent==='navigate' && target==='record')valid=(object(args,['query'])||intent==='search'&&object(args,['query','scope'])&&['project','active_material'].includes(args.scope))&&text(args.query,500);
  else if(intent==='query' && target==='project_stats')valid=object(args,['metric'])&&catalog.metrics.includes(args.metric);
  else if(intent==='clarify' && target==='none'){
    valid=object(args,['reason','candidates'])&&['ambiguous','multiple','missing_context'].includes(args.reason)&&Array.isArray(args.candidates)&&[0,2].includes(args.candidates.length)&&(args.candidates.length>0||args.reason==='missing_context');
    if(valid){
      for(const candidate of args.candidates){if(!['guide','navigate','query','search'].includes(candidate?.intent))return fail();validateStarxiaotuDecision(candidate);}
      const signatures=args.candidates.map(c=>JSON.stringify([c.intent,c.target,Object.entries(c.arguments).sort()]));
      valid=new Set(signatures).size===signatures.length;
    }
  }
  if(!valid)return fail();
  return structuredClone(value);
}
export function starxiaotuIntentRequest(input) {
  if(!object(input,['warehouseId','body']) || typeof input.warehouseId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.warehouseId))return fail();
  const b=input.body;
  if(!object(b,['operation_id','version','text','page','context','history','ontology_conversation']) || typeof b.operation_id!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(b.operation_id) || b.version!==catalog.version || !text(b.text,2000) || !page(b.page) || typeof b.ontology_conversation!=='boolean' || !Array.isArray(b.history) || b.history.length>4)return fail();
  const context=b.context;
  if(!object(context,['focus','material_title'])||!['page','material'].includes(context.focus)||typeof context.material_title!=='string'||[...context.material_title].length>240||/[\uD800-\uDFFF]/u.test(context.material_title)||(context.focus==='material')!==Boolean(context.material_title.trim()))return fail();
  for(const item of b.history){if(!object(item,['text','page','decision'])||!text(item.text,500)||!page(item.page))return fail();validateStarxiaotuDecision(item.decision);if(['clarify','unsupported'].includes(item.decision.intent))return fail();}
  return {path:`/warehouses/${input.warehouseId}/modeling/assistant-intent`,method:'POST',body:structuredClone(b),timeoutMs:45000};
}
export function starxiaotuDecisionRequest(value, original) {
  const {intent,target,arguments:args}=validateStarxiaotuDecision(value);
  const text=String(original).trim();
  if(intent==='guide')return {kind:'explain',key:target,text};
  if(intent==='navigate')return target==='record'?{kind:'locate',text,query:args.query}:{kind:'navigate',destination:target,text};
  if(intent==='query')return target==='ontology_rules'?{kind:'ontology-query',text}:{kind:'project-overview',metric:args.metric,text};
  if(intent==='search')return {kind:'search',text,query:args.query,...(args.scope?{scope:args.scope}:{})};
  if(intent==='ontology_change')return {kind:'ontology-change',text};
  return {kind:intent,reason:args.reason,candidates:args.candidates,text};
}

export function starxiaotuCandidateLabel(candidate) {
  const {intent,target,arguments:args}=validateStarxiaotuDecision(candidate);
  if(intent==='guide')return '了解「'+catalog.guides[target].title+'」功能';
  if(intent==='navigate')return target==='record'?'定位记录「'+[...args.query].slice(0,28).join('')+'」':'前往「'+catalog.pages[target]+'」';
  if(intent==='query')return target==='ontology_rules'?'查看当前本体规则':({summary:'查看项目概览',document_count:'查看资料数量',entity_count:'查看实体数量',relation_count:'查看关系数量'})[args.metric];
  if(intent==='search')return (args.scope==='active_material'?'检索当前资料「':'检索资料「')+[...args.query].slice(0,28).join('')+'」';
  return fail();
}
