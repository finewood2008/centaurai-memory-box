import {onboardingRequest} from '../shared/onboarding-contract.mjs';
import {proposalView} from './onboarding-result.mjs';
import {ruleReviewKey,questionList} from './onboarding-notes.mjs';

const copy=value=>structuredClone(value);
const fail=code=>Object.assign(new Error(code),{code});
const messages={
  MODELING_RULE_DECISIONS_REQUIRED:'部分建议无法默认采用，请修正标识或选择排除后再确认。',
  MODELING_RULE_DECISION_INVALID:'请核对类型标识、属性归属及关系起终点；先采用依赖的类型，或选择有效的复用目标。',
  MODELING_RULE_TARGET_CHANGED:'采用目标不存在或已重名，请重新选择目标。',
  MODELING_RULE_SOURCE_STALE:'回答或生效规则已变化，本批建议不能继续发布。请返回读取最新建议。',
  MODELING_RULE_CLARIFICATION_REQUIRED:'后端尚未提供可采用的本体，请返回重试生成或先使用当前规则。',
  ONTOLOGY_MODEL_EMPTY_RESULT:'本次未生成有效本体，请返回重试生成或修改建仓信息。',
  MODELING_RULE_DRAFT_CHANGED:'其他页面已修改草稿，请重新读取并核对差异后再确认。',
  MODELING_RULE_DIGEST_CHANGED:'发布内容与核对卡不一致，请重新读取草稿。',
  MODELING_RULE_ALREADY_PUBLISHED:'本批规则已发布，请读取发布回执。',
  MODELING_RULE_CONFIRMATION_REQUIRED:'请先核对完整规则和差异，再勾选发布确认。',
  MODELING_OPERATION_CONFLICT:'操作号与原请求不一致，请读取进度核对；不要反复提交。',
  MODELING_LOCAL_SAVE_FAILED:'无法保存本机恢复记录，尚未发送新请求。请检查存储权限。',
  MODELING_LOCAL_RECORD_INVALID:'本机规则恢复记录无效，请检查客户端版本，暂不提交。',
  SEMANTICA_OPERATION_NOT_ALLOWED:'当前 Host 通道尚未接入本体核对发布接口。请协调万象适配后重试，知识仓与建议仍保留。',
  SEMANTICA_UPGRADE_REQUIRED:'当前 Host 通道尚未接入本体核对发布接口。请协调万象适配后重试，知识仓与建议仍保留。',
  HOST_SESSION_EXPIRED:'账号或连接已变化，请重新进入当前知识仓。',
};
export const ruleMessage=error=>(error?.suggestionLabel?`「${error.suggestionLabel}」：`:'')+(messages[error?.code] || '规则操作尚未完成，请重新读取进度。重试会保留原操作号与请求内容。');
const defs=(schema,kind)=>schema[kind==='entity'?'entity_types':'relation_types'];

// Resolve the currently selected names without changing any user's decisions.
function selectedDefinitions(base,items,choices) {
  const schema=copy(base), maps={entity:Object.create(null),relation:Object.create(null)};
  for(const item of items.filter(i=>i.kind!=='property')){
    const c=choices[item.id];if(!c||!['add','reuse'].includes(c.action)||!c.target?.trim())continue;
    const name=c.target.trim().toUpperCase();maps[item.kind][item.name.trim().toUpperCase()]=name;
    if(c.action==='add'&&!defs(schema,item.kind).some(d=>d.name===name))
      defs(schema,item.kind).push({name,label:c.label||item.label,properties:[]});
  }
  const owner=item=>maps[item.owner_kind]?.[item.owner_name?.trim().toUpperCase()]||item.owner_name?.trim().toUpperCase();
  for(const item of items.filter(i=>i.kind==='property')){
    const c=choices[item.id];if(c?.action!=='add'||!c.target?.trim())continue;
    const definition=defs(schema,item.owner_kind).find(d=>d.name===owner(item));
    if(definition&&!definition.properties.some(p=>p.name===c.target.trim()))definition.properties.push({name:c.target.trim(),label:c.label||item.label});
  }
  return {schema,maps,owner};
}
export function reuseOptions(base,items,choices,item) {
  // Match schema construction order: a candidate cannot reuse itself or a
  // definition that has not yet been applied. All types precede properties.
  const ordered=[...items].sort((a,b)=>['entity','relation','property'].indexOf(a.kind)-['entity','relation','property'].indexOf(b.kind));
  const remaining=ordered.slice(0,ordered.findIndex(i=>i.id===item.id));
  const {schema,owner}=selectedDefinitions(base,remaining,choices);
  const options=item.kind==='property'
    ? defs(schema,item.owner_kind).find(d=>d.name===owner(item))?.properties||[] : defs(schema,item.kind);
  return options.map(d=>({name:d.name,label:d.label||d.name}));
}
export function dependencyWarnings(base,items,choices) {
  const {schema,maps,owner}=selectedDefinitions(base,items,choices), warnings={};
  for(const item of items){
    const c=choices[item.id];if(!c||!['add','reuse'].includes(c.action))continue;
    let missing=[];
    if(item.kind==='property'&&!defs(schema,item.owner_kind).some(d=>d.name===owner(item)))missing=[item.owner_name];
    if(item.kind==='relation'&&c.action==='add')missing=[...(item.source_types||[]),...(item.target_types||[])].filter(n=>!schema.entity_types.some(d=>d.name===(maps.entity[n.trim().toUpperCase()]||n.trim().toUpperCase())));
    if(missing.length)warnings[item.id]=`依赖的类型 ${[...new Set(missing)].join('、')} 未采用。请恢复或复用该类型，或排除此建议。`;
  }
  return warnings;
}

// A batch confirmation accepts these visible defaults; it never publishes on load.
export function defaultRuleChoices(base,suggestions) {
  const choices={}, schema=copy(base);
  for(const item of [...suggestions].sort((a,b)=>['entity','relation','property'].indexOf(a.kind)-['entity','relation','property'].indexOf(b.kind))) {
    const kind=item.kind==='property'?item.owner_kind:item.kind;
    const name=(item.name||'').trim();
    const definitions=['entity','relation'].includes(kind)?defs(schema,kind):[];
    const existing=item.kind==='property'
      ? definitions.find(d=>d.name===(item.owner_name||'').trim().toUpperCase())?.properties?.some(p=>p.name===name)
      : definitions.some(d=>d.name===name.toUpperCase());
    const action=existing?'reuse':item.allow_new_type===false?'':'add';
    choices[item.id]={action,target:name,label:item.label};
    if(action==='add' && item.kind!=='property')definitions.push({name:name.toUpperCase(),properties:[]});
    if(action==='add' && item.kind==='property')definitions.find(d=>d.name===(item.owner_name||'').trim().toUpperCase())?.properties.push({name});
  }
  return choices;
}

// Build a complete additive schema from explicit choices. Existing rules are preserved.
export function reviewedSchema(base, suggestions, choices) {
  const schema=copy(base), maps={entity:Object.create(null),relation:Object.create(null)}, decisions=[];
  const ordered=[...suggestions].sort((a,b)=>['entity','relation','property'].indexOf(a.kind)-['entity','relation','property'].indexOf(b.kind));
  for(const item of ordered) {
    try {
    const choice=choices[item.id];
    if(!choice || !['add','reuse','ignore'].includes(choice.action)) throw fail('MODELING_RULE_DECISIONS_REQUIRED');
    const decision={suggestion_id:item.id,action:choice.action,target_name:'',owner_kind:'',owner_name:''};
    if(choice.action==='ignore') {decisions.push(decision);continue;}
    const kind=item.kind==='property'?item.owner_kind:item.kind;
    if(!['entity','relation'].includes(kind) || choice.action==='add' && item.allow_new_type===false) throw fail('MODELING_RULE_DECISION_INVALID');
    const rawName=(choice.target || '').trim();
    const name=item.kind==='property'?rawName:rawName.toUpperCase(), label=(choice.label || item.label || name).trim();
    if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !label) throw fail('MODELING_RULE_DECISION_INVALID');
    if(item.kind==='property') {
      const ownerName=(item.owner_name||'').trim().toUpperCase();
      const owner=maps[kind][ownerName] || ownerName;
      const definition=defs(schema,kind).find(d=>d.name===owner);
      if(!definition) throw fail('MODELING_RULE_TARGET_CHANGED');
      const existing=definition.properties.find(p=>p.name===name);
      if(choice.action==='reuse' ? !existing : !!existing) throw fail('MODELING_RULE_TARGET_CHANGED');
      if(choice.action==='add') definition.properties.push({name,label,required:false,...(item.definition?{definition:item.definition}:{})});
      Object.assign(decision,{owner_kind:kind,owner_name:owner,target_name:name});
    } else {
      const definitions=defs(schema,kind), existing=definitions.find(d=>d.name===name);
      if(choice.action==='reuse' ? !existing : !!existing) throw fail('MODELING_RULE_TARGET_CHANGED');
      if(choice.action==='add') {
        const next={name,label,properties:[],...(item.definition?{definition:item.definition}:{})};
        if(kind==='relation') {
          const entityName=n=>{const name=n.trim().toUpperCase();return maps.entity[name]||name;};
          next.source_types=[...new Set((item.source_types||[]).map(entityName))];
          next.target_types=[...new Set((item.target_types||[]).map(entityName))];
          if(!next.source_types.length || !next.target_types.length || [...next.source_types,...next.target_types].some(n=>!schema.entity_types.some(e=>e.name===n))) throw fail('MODELING_RULE_DECISION_INVALID');
        }
        definitions.push(next);
      }
      maps[kind][item.name.trim().toUpperCase()]=name;decision.target_name=name;
    }
    decisions.push(decision);
    } catch(error) {error.suggestionId=item.id;error.suggestionLabel=item.label||item.name;throw error;}
  }
  return {schema,decisions};
}

export class RuleReview {
  constructor({call,storage,identity,warehouseId,proposalId,onChange=()=>{},uuid=()=>crypto.randomUUID()}) {
    Object.assign(this,{call,storage,warehouseId,proposalId,onChange,uuid});this.live=true;
    this.key=ruleReviewKey(identity,warehouseId,proposalId);
    this.state={loaded:false,busy:false,error:'',errorCode:null,workbench:null,draft:null,publication:null,ontologies:null,choices:{},pending:null,questions:[],confirmed:false,editing:false};
  }
  emit(){if(this.live)this.onChange();}
  reset(){this.live=false;this.state={};}
  persist(){try{this.storage.setItem(this.key,JSON.stringify({pending:this.state.pending,questions:this.state.questions}));}catch{throw fail('MODELING_LOCAL_SAVE_FAILED');}}
  async read(action,input){if(!this.live)throw fail('HOST_SESSION_EXPIRED');const r=await this.call(action,copy(input));if(!this.live)throw fail('HOST_SESSION_EXPIRED');return r;}
  async run(work){if(!this.live||this.state.busy)return;this.state.busy=true;this.state.error='';this.state.errorCode=null;this.emit();try{await work();}catch(e){if(this.live){
    this.state.error=ruleMessage(e);this.state.errorCode=e.code;this.state.errorSuggestionId=e.suggestionId||null;
    if(e.code==='MODELING_RULE_CLARIFICATION_REQUIRED'){this.state.loaded=false;this.state.confirmed=false;}
    // Only definite validation/conflict rejections can release the immutable envelope.
    if([400,409,413,422].includes(e.status)){
      this.state.pending=null;this.state.loaded=false;this.state.confirmed=false;
      try{this.persist();}catch{this.state.error=ruleMessage({code:'MODELING_LOCAL_SAVE_FAILED'});}
    }
  }}finally{if(this.live){this.state.busy=false;this.emit();}}}
  restore(){
    try{
      const value=JSON.parse(this.storage.getItem(this.key)||'{"pending":null}');
      if(value.pending){
        const p=value.pending;
        if(!['onboarding-rule-prepare','onboarding-rule-publish'].includes(p.action)||p.input.warehouseId!==this.warehouseId)throw Error();
        onboardingRequest(p.action,p.input);
        if(p.action==='onboarding-rule-prepare' && p.input.body.proposal_id!==this.proposalId)throw Error();
      }
      this.state.pending=value.pending;
      this.state.questions=questionList(value.questions);
    }catch{throw fail('MODELING_LOCAL_RECORD_INVALID');}
  }
  async load(){return this.run(async()=>{this.restore();await this.fetch();});}
  async fetch(){
    this.state.loaded=false;this.state.confirmed=false;
    this.state.publication=null;this.state.ontologies=null;
    const w=await this.read('onboarding-rules',{warehouseId:this.warehouseId,suggestionId:this.proposalId});
    if(!w || (!w.publication && (!w.proposal?.valid || w.proposal.id!==this.proposalId ||
      !Array.isArray(w.proposal.result?.suggestions) || !Array.isArray(w.base_ontology?.schema?.entity_types) ||
      !Array.isArray(w.base_ontology?.schema?.relation_types))) ||
      w.publication && (!['published','reused_existing'].includes(w.publication.status) || !w.publication.ontology_id))
      throw fail('MODELING_RULE_SOURCE_STALE');
    if(!w.publication){
      const view=proposalView(w.proposal);
      // Old human-reviewed drafts remain recoverable; fresh empty results do not create drafts.
      if(!view.canAdopt && w.draft?.status!=='prepared')throw fail('ONTOLOGY_MODEL_EMPTY_RESULT');
    }
    Object.assign(this.state,{workbench:w,draft:w.draft,publication:w.publication,editing:!w.draft,
      choices:w.publication?{}:defaultRuleChoices(w.base_ontology.schema,w.proposal.result.suggestions),loaded:true});
    if(w.draft && !w.publication)this.restoreDraftChoices(w.draft);
    this.state.questions=questionList(w.publication
      ? w.publication.unresolved_questions ?? w.publication.questions ?? this.state.questions
      : w.draft?.unresolved_questions ?? w.proposal.unresolved_questions ?? w.proposal.result.questions);
    if(w.publication){
      this.state.pending=null;this.persist();
      this.state.ontologies=await this.read('onboarding-ontologies',{warehouseId:this.warehouseId});
    }
  }
  restoreDraftChoices(draft){
      const w=this.state.workbench;
      // A saved draft may contain renames/exclusions. Never replace those with batch defaults.
      const decisions=new Map((draft.decisions||[]).map(d=>[d.suggestion_id,d]));
      for(const item of w.proposal.result.suggestions){
        const d=decisions.get(item.id);
        const kind=item.kind==='property'?item.owner_kind:item.kind;
        const definition=['entity','relation'].includes(kind)?defs(draft.schema||w.base_ontology.schema,kind)
          ?.find(v=>v.name===(item.kind==='property'?d?.owner_name:d?.target_name)):null;
        const label=item.kind==='property'?definition?.properties?.find(p=>p.name===d?.target_name)?.label:definition?.label;
        this.state.choices[item.id]={action:d?.action||'',target:d?.target_name||item.name,label:label||item.label};
      }
  }
  refresh(){return this.run(()=>this.fetch());}
  choose(id,key,value){if(!this.live||!this.state.loaded||this.state.busy||this.state.pending||this.state.publication)return;
    const item=this.state.workbench.proposal.result.suggestions.find(s=>s.id===id);if(!item)return;
    const current=this.state.choices[id]||{action:'',target:item.name,label:item.label};
    if(current[key]===value)return;
    this.state.choices[id]={...current,[key]:value};this.state.confirmed=false;this.state.editing=true;
    this.state.error='';this.state.errorSuggestionId=null;
    if(key==='target'&&item.allow_new_type===false&&value)this.state.choices[id].action='reuse';
  }
  edit(){if(this.state.busy||this.state.pending||this.state.publication)return;this.state.editing=true;this.state.confirmed=false;this.emit();}
  confirm(value){if(this.state.loaded&&!this.state.busy&&!this.state.pending&&!this.state.editing)this.state.confirmed=value===true;}
  async write(action,input){
    if(this.state.pending && this.state.pending.action!==action)throw fail('MODELING_OPERATION_CONFLICT');
    if(!this.state.pending){onboardingRequest(action,input);this.state.pending={action,input:copy(input)};}
    this.persist();const p=this.state.pending;
    const result=await this.read(p.action,p.input);
    if(action==='onboarding-rule-prepare' ? result.status!=='prepared'||!result.resource_id||!result.schema_digest||!result.publish_operation_id : !['published','reused_existing'].includes(result.status)||!result.ontology_id) throw fail('MODELING_RULE_SOURCE_STALE');
    if(Array.isArray(result.unresolved_questions))this.state.questions=questionList(result.unresolved_questions);
    this.state.pending=null;
    try{this.persist();}catch(error){this.state.pending=p;throw error;}
    return result;
  }
  save(){return this.run(async()=>{
    if(!this.state.loaded||this.state.publication) return;
    const w=this.state.workbench;
    const input=this.state.pending?.input || {warehouseId:this.warehouseId,body:{operation_id:this.uuid(),proposal_id:this.proposalId,
      expected_draft_id:this.state.draft?.resource_id||null,name:w.base_ontology.name+' · 初始化建议',
      ...reviewedSchema(w.base_ontology.schema,w.proposal.result.suggestions,this.state.choices)}};
    this.state.draft=await this.write('onboarding-rule-prepare',input);
    this.restoreDraftChoices(this.state.draft);
    this.state.editing=false;this.state.confirmed=false;
  });}
  publish(){return this.run(async()=>{
    if(!this.state.loaded||this.state.publication)return;
    if(!this.state.pending && (!this.state.confirmed||this.state.editing||!this.state.draft))throw fail('MODELING_RULE_CONFIRMATION_REQUIRED');
    const d=this.state.draft;
    const input=this.state.pending?.input || {warehouseId:this.warehouseId,previewId:d.resource_id,body:{operation_id:d.publish_operation_id,schema_digest:d.schema_digest,confirmed:true}};
    this.state.publication=await this.write('onboarding-rule-publish',input);this.state.confirmed=false;
    this.state.ontologies=await this.read('onboarding-ontologies',{warehouseId:this.warehouseId});
  });}
}
