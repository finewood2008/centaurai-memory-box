import {answerLimits, identityKey, onboardingRequest} from '../shared/onboarding-contract.mjs';
import {proposalView} from './onboarding-result.mjs';
import {unresolvedQuestions,savedReviewQuestions} from './onboarding-notes.mjs';

export const labels = {industry:'行业', occupation:'职业', material_types:'主要资料', purpose:'用途与目标', questions:'希望回答的问题'};
export const samples = [
  {name:'企业法务', industry:'制造业', occupation:'企业法务', material_types:'采购合同、补充协议、履约记录', purpose:'查询签约主体、履约义务和违约责任', warehouse_name:'采购合同知识仓'},
  {name:'人力资源', industry:'企业服务', occupation:'人力资源专员', material_types:'员工制度、劳动合同、办理流程', purpose:'查询员工制度的适用条件和办理流程', warehouse_name:'人力资源知识仓'},
  {name:'研发管理', industry:'软件与互联网', occupation:'研发负责人', material_types:'技术文档、架构方案、系统说明', purpose:'查询技术方案与系统依赖', warehouse_name:'研发管理知识仓'},
];
export const onboardingMessages = {
  MODEL_AUTH_REQUIRED:'万象模型调用授权未通过。请检查本机 Bridge 模型回调配置并重启 Semantica，再读取进度后重试。知识仓和回答已保留。',
  MODEL_DEFAULT_NOT_CONFIGURED:'万象尚未配置默认处理模型，请配置并检查模型后重试。知识仓和回答已保留。',
  MODEL_DEFAULT_UNAVAILABLE:'当前万象默认模型不可用，请在模型与处理中检查配置后重试。知识仓和回答已保留。',
  ONTOLOGY_MODEL_FAILED:'模型未返回有效的知识结构建议，请检查处理模型后重试。知识仓和回答已保留。',
  ONTOLOGY_MODEL_EMPTY_RESULT:'本次未生成有效本体，信息已保留。可重试生成或修改建仓信息。',
  ONTOLOGY_INVALID_OUTPUT:'模型输出被截断或格式无效，本次未生成可采用的本体。知识仓和回答已保留；请检查处理模型的输出预算后重试，无需反复回答澄清问题。',
  ONTOLOGY_MODEL_TIMEOUT:'模型生成超时，知识仓和回答已保留。请先读取进度，再决定是否重新生成。',
  MODELING_RULE_CLARIFICATION_REQUIRED:'后端尚未提供可采用的本体，请重试生成或先使用当前规则。本次未发布新规则。',
  MODELING_ANSWERS_UNCHANGED:'信息未变化，可以直接重新生成初始本体。',
  ONTOLOGY_CONTEXT_TOO_SMALL:'回答与当前知识结构超出模型上下文预算，请精简回答或调整处理模型后重试。',
  WAREHOUSE_NAME_CONFLICT:'已有同名知识仓，请修改名称后重新确认。',
  MODELING_INVALID_REQUEST:'填写内容不符合要求，请检查字段及长度。',
  MODELING_OPERATION_CONFLICT:'操作号与原请求内容不一致。请重新读取进度并核对，不要反复提交。',
  MODELING_REVISION_CHANGED:'引导内容已在其他页面更新，请重新读取并核对。',
  MODELING_ANSWERS_STALE:'回答已发生变化，请重新读取并确认。',
  MODELING_SUGGESTION_STALE:'回答或基础规则已变化，请重新读取后再确认。',
  MODELING_SUGGESTION_BUSY:'建议正在生成，请读取进度，不要重复提交。',
  MODELING_SUGGESTION_TIMEOUT:'建议生成超时，知识仓与回答已保留。请先读取进度。',
  MODELING_SUGGESTION_FAILED:'建议生成失败，知识仓与回答已保留，可重新读取后重试。',
  MODELING_HOST_CREATION_REQUIRED:'本流程仅支持个人知识仓，请从万象的个人空间打开。',
  MODELING_RESOURCE_NOT_FOUND:'引导或知识仓已不存在，或当前账号无权访问。',
  MODELING_WORKSPACE_BUSY:'知识仓正在处理其他操作，请稍后读取进度。',
  MODELING_WAREHOUSE_LIMIT:'个人知识仓数量已达到上限。',
  MODELING_ANSWERS_EMPTY:'请填写行业、职业，以及希望整理的资料或用途，再生成初始本体。',
  MODELING_OWNER_REQUIRED:'当前会话没有初始化知识仓的权限，请检查万象账号。',
  MODELING_LOCAL_SAVE_FAILED:'无法保存本机恢复记录。本次尚未继续提交，请检查可用空间或存储权限。',
  MODELING_LOCAL_RECORD_INVALID:'本机恢复记录无法读取。请保留记录并检查当前客户端版本，避免重复建仓。',
  MODELING_REVIEW_REQUIRED:'内容或请求状态已变化，请读取最新内容并重新核对后再提交。',
  MODELING_CHANNEL_UNAVAILABLE:'当前连接未接入个人仓初始化接口。请更新并重启万象的 Bridge 或本机 Host 适配服务。',
  MODELING_GATE_REQUIRED:'当前连接使用 required 数据网关，该通道尚未接入初始化接口。请先完成两端通道适配。',
  SEMANTICA_SERVICE_TIMEOUT:'等待超时，操作可能已完成。请读取进度后再决定是否重试。',
  SEMANTICA_CONNECTION_FAILED:'连接中断，操作结果尚未确认。请保留当前内容并读取进度。',
  SEMANTICA_RESOURCE_FORBIDDEN:'当前会话无权访问建仓接口，请检查账号权限及盒端接入配置。',
  SEMANTICA_INVALID_RESPONSE:'建仓记录返回格式异常，请重新读取；持续失败时请检查客户端与盒端版本。已有知识仓会保留。',
  HOST_SESSION_EXPIRED:'万象会话已失效，请重新连接后打开星图。',
};
export const messageFor = error => onboardingMessages[error?.code] || '操作未完成，请读取进度并核对。知识仓不会因建议失败被撤销。';
export const proposalFailure = proposal => proposal?.status === 'failed'
  ? messageFor({code: Object.hasOwn(onboardingMessages, proposal.error_code) ? proposal.error_code : 'MODELING_SUGGESTION_FAILED'}) : '';
export function answerGuidance(answers) {
  const length=Object.keys(labels).reduce((sum,key)=>sum+[...(answers?.[key]||'')].length,0);
  return length>1200
    ? `当前已填写 ${length} 字。建仓建议只描述资料种类和关键用途，完整材料可入仓后上传。较长内容可能超出当前模型预算；此提示不代表实际 token 限额，不会截断你的回答。`
    : '简要描述资料种类和关键用途即可，完整材料可在建仓后上传。';
}
const fail = code => Object.assign(new Error(messageFor({code})), {code});
const copy = value => structuredClone(value);
const blank = () => Object.fromEntries([...Object.keys(answerLimits),'warehouse_name'].map(key=>[key,'']));
const normalize = name => name.normalize('NFKC').trim().toLowerCase();
const sameAnswers = (a,b) => Object.keys(answerLimits).every(key=>(a?.[key]||'')===(b?.[key]||''));
const profileAnswers = answers => Object.fromEntries(['industry','occupation'].map(key=>[key,answers?.[key]||'']));
const generationAnswers = answers => Object.fromEntries(Object.keys(answerLimits).map(key=>[key,key==='background'?'':answers?.[key]||'']));
export function currentRuleReview(context, proposal) {
  const review=context?.rule_review;
  return review && (!proposal?.id || review.proposal_id===proposal.id) ? review : null;
}
// Only server-confirmed completion may bypass the saved onboarding result on startup.
export function completedOnboardingWarehouse(state, preferredWarehouseId=null) {
  if(!state.loaded || state.busy || state.error || state.needsReview || state.pending || state.creation ||
    state.answerEdit || state.step!=='result' || !state.warehouse) return null;
  const publication=currentRuleReview(state.context,state.proposal)?.publication;
  if(!['published','reused_existing'].includes(publication?.status))return null;
  const active=state.warehouses.filter(w=>w.state==='active');
  if(!active.some(w=>w.id===state.warehouse.id))return null;
  return active.find(w=>w.id===preferredWarehouseId) || active.find(w=>w.id===state.warehouse.id);
}
export function ruleProposalId(context, proposal) {
  const review=currentRuleReview(context,proposal);
  if(['published','reused_existing'].includes(review?.publication?.status))return review.proposal_id;
  const view=proposalView(proposal);
  return (review?.id || review?.draft) ? review.proposal_id : view.canAdopt ? proposal.id : null;
}
const answerBase=context=>({onboarding_revision:context.onboarding_revision,purpose_revision:context.purpose_revision,
  latest_confirmation_id:context.latest_confirmation_id??null,base_ontology_id:context.base_ontology_id});
export function validation(answers, warehouses, name = false) {
  for (const key of ['industry','occupation']) if (!answers[key]?.trim()) return `请填写${labels[key]}。`;
  for (const [key,max] of Object.entries(answerLimits)) if ([...(answers[key] || '')].length > max) return `${labels[key]}最多 ${max} 字。`;
  if (!name) return '';
  const length = [...(answers.warehouse_name || '').trim()].length;
  if (length < 2 || length > 30) return '知识仓名称请使用 2–30 个字符。';
  if (warehouses.some(w => w.state !== 'deleted' && normalize(w.name) === normalize(answers.warehouse_name))) return onboardingMessages.WAREHOUSE_NAME_CONFLICT;
  return '';
}

// All navigation decisions live here so the three-screen route can evolve independently.
export class OnboardingFlow {
  constructor({call, storage, identity, onChange = () => {}, uuid = () => crypto.randomUUID()}) {
    this.call=call; this.storage=storage; this.uuid=uuid; this.onChange=onChange;this.identity=identity;
    this.key='starlink.onboarding.v1.'+identityKey(identity);
    this.epoch=0; this.live=true;
    this.state={step:'welcome', answers:blank(), record:null, warehouses:[], pending:null, creation:null,
      warehouse:null, context:null, proposal:null, ruleProposalId:null, reviewQuestions:[], answerEdit:null, busy:false, error:'', notice:'', needsReview:false, loaded:false};
  }
  emit() { if(this.live) this.onChange(this.state); }
  persist() {
    try {
      const {step,answers,pending,creation,warehouse,needsReview,ruleProposalId,answerEdit} = this.state;
      this.storage.setItem(this.key,JSON.stringify({version:1,step,answers,pending,creation,warehouse,needsReview,ruleProposalId,answerEdit}));
    } catch { throw fail('MODELING_LOCAL_SAVE_FAILED'); }
  }
  restore() {
    let value;
    try {
      const raw=this.storage.getItem(this.key); if(!raw) return;
      value=JSON.parse(raw);
      if(value.version!==1 || !['welcome','details','confirm','result'].includes(value.step) || typeof value.needsReview!=='boolean') throw Error();
      const checkAnswers=answers=>onboardingRequest('onboarding-save',{body:{operation_id:'validate-cache',expected_revision:0,answers}});
      checkAnswers(value.answers);
      if(value.answerEdit){
        if(!value.warehouse || !value.answerEdit.base)throw Error();
        checkAnswers(value.answerEdit.answers);
      }
      if(value.warehouse) {
        onboardingRequest('onboarding-context',{warehouseId:value.warehouse.id});
        if(typeof value.warehouse.name!=='string') throw Error();
      }
      if(value.ruleProposalId) onboardingRequest('onboarding-rules',{warehouseId:value.warehouse?.id,suggestionId:value.ruleProposalId});
      if(value.creation) {
        checkAnswers(value.creation.answers);
        checkAnswers({creation_operation:value.creation.operation});
        if(!value.creation.operation) throw Error();
        if(value.creation.saved) onboardingRequest('onboarding-create',{onboardingId:value.creation.saved.id,
          body:{operation_id:value.creation.operation,expected_revision:value.creation.saved.revision,name:value.creation.answers.warehouse_name}});
      }
      if(value.pending) {
        const request=onboardingRequest(value.pending.action,value.pending.input);
        if(!request || request.method!=='POST' || request.path!==value.pending.path) throw Error();
        if(['onboarding-save','onboarding-create'].includes(value.pending.action)) {
          if(!value.creation) throw Error();
          if(value.pending.action==='onboarding-save' && value.pending.input.body.answers.creation_operation!==value.creation.operation) throw Error();
          if(value.pending.action==='onboarding-create' && (value.pending.input.body.operation_id!==value.creation.operation ||
            value.pending.input.onboardingId!==value.creation.saved?.id || value.pending.input.body.expected_revision!==value.creation.saved?.revision)) throw Error();
        } else if(!value.warehouse || value.pending.input.warehouseId!==value.warehouse.id) throw Error();
      }
    } catch { throw fail('MODELING_LOCAL_RECORD_INVALID'); }
    const {step,pending,creation,warehouse,needsReview,ruleProposalId=null,answerEdit=null}=value;
    Object.assign(this.state,{step,pending,creation,warehouse,needsReview,ruleProposalId,answerEdit,answers:{...blank(),...value.answers}});
  }
  async read(action,input={}) {
    const epoch=this.epoch;
    if(!this.live) throw fail('HOST_SESSION_EXPIRED');
    const value=await this.call(action,copy(input));
    if(!this.live || epoch!==this.epoch) throw fail('HOST_SESSION_EXPIRED');
    return value;
  }
  async run(work) {
    if(this.state.busy || !this.live) return;
    this.state.busy=true; this.state.error=''; this.emit();
    try { await work(); }
    catch(error) {
      if(!this.live) return;
      this.state.error=messageFor(error);
      // 403 may follow a completed upstream write: do not discard its retry receipt.
      if(error.code==='WAREHOUSE_NAME_CONFLICT' && this.state.pending?.action==='onboarding-create') {
        this.state.pending=null; this.state.creation=null; this.state.step='confirm';
      }
      if(['MODELING_REVISION_CHANGED','MODELING_ANSWERS_STALE','MODELING_SUGGESTION_STALE','MODELING_OPERATION_CONFLICT'].includes(error.code))
        this.state.needsReview=true;
      // Validation rejections are definite. Allow explicit review/edit; keep uncertain
      // 403/408/5xx outcomes and their immutable request envelopes for recovery.
      if(this.state.pending && [400,413,422].includes(error.status)) {
        if(['onboarding-save','onboarding-create'].includes(this.state.pending.action)) this.state.creation=null;
        this.state.pending=null;this.state.needsReview=true;
      }
      if(error.code!=='MODELING_LOCAL_RECORD_INVALID') {
        try { this.persist(); } catch(storageError) { this.state.error=messageFor(storageError); }
      }
    } finally { if(this.live) { this.state.busy=false; this.emit(); } }
  }
  async load() {
    return this.run(async()=>{
      this.state.loaded=false;
      this.restore();
      await this.readRoots();
      if(!this.state.pending && !this.state.creation && !this.state.warehouse && !Object.values(this.state.answers).some(Boolean)) {
        const record=this.state.record;
        if(record.status==='in_progress') {
          this.state.answers={...blank(),...record.answers};
          this.state.step=record.answers?.flow_step==='confirm' ? 'confirm':'details';
        } else this.state.answers={...blank(),...profileAnswers(record.answers)};
      }
      await this.recoverContext();
      this.state.loaded=true;
      this.persist();
    });
  }
  async readRoots() {
    const [record,list]=await Promise.all([this.read('onboarding-read'),this.read('onboarding-warehouses')]);
    if(!Number.isSafeInteger(record?.revision) || !Array.isArray(list?.items)) throw fail('SEMANTICA_INVALID_RESPONSE');
    this.state.record=record; this.state.warehouses=list.items;
    const operation=this.state.creation?.operation;
    if(operation && record.answers?.creation_operation===operation && record.created_workspace_id) {
      const warehouse=list.items.find(w=>w.workspace_id===record.created_workspace_id && w.state==='active');
      if(warehouse) {
        this.state.warehouse=warehouse; this.state.creation=null;
        if(['onboarding-save','onboarding-create'].includes(this.state.pending?.action)) this.state.pending=null;
        this.state.step='result'; this.persist();
      }
    }
    if(this.state.warehouse) {
      const current=list.items.find(w=>w.id===this.state.warehouse.id && w.state==='active');
      if(current) {this.state.warehouse=current;this.state.notice='';}
      else {
        this.state.context=null; this.state.proposal=null;this.state.ruleProposalId=null;this.state.answerEdit=null;this.state.reviewQuestions=[];
        if(this.state.pending || this.state.creation) throw fail('MODELING_RESOURCE_NOT_FOUND');
        this.state.answers={...blank(),...profileAnswers(this.state.answers)};
        this.state.warehouse=null;this.state.step='welcome';
        this.state.notice='上次使用的知识仓已删除或暂不可访问，请选择其他仓或重新创建。';
      }
    }
  }
  update(field,value) {
    if(!this.live || !this.state.loaded || this.state.busy || this.state.pending || this.state.creation || this.state.warehouse) return;
    if(!(field in blank()) || field==='background') return;
    this.state.answers[field]=value;
    try { this.persist(); } catch(error) { this.state.error=messageFor(error); }
  }
  step(step) {
    if(!this.live || !this.state.loaded || this.state.busy || this.state.pending || this.state.creation) return;
    const issue=step==='confirm' && validation(this.state.answers,[],false);
    this.state.error=issue || '';
    if(!issue) this.state.step=step;
    try { this.persist(); } catch(error) { this.state.error=messageFor(error); }
    this.emit();
  }
  applySample(sample) {
    if(!this.live || !this.state.loaded || this.state.busy || this.state.pending || this.state.creation) return;
    this.state.answers={...blank(),...Object.fromEntries(Object.keys(blank()).map(k=>[k,sample[k] || '']))};
    this.state.answers.background='';
    this.step('details');
  }
  begin() {
    if(!this.live || !this.state.loaded || this.state.busy) return;
    if(this.state.pending || this.state.creation) {this.state.step=this.state.warehouse?'result':'confirm';this.emit();return;}
    // Explicit new-warehouse intent is distinct from restoring an unfinished draft.
    this.state.answers={...blank(),...profileAnswers(this.state.answers)};
    this.state.warehouse=null;this.state.context=null;this.state.proposal=null;this.state.ruleProposalId=null;this.state.answerEdit=null;this.state.reviewQuestions=[];
    this.state.needsReview=false;this.state.notice='';
    this.step('details');
  }
  async resume(warehouseId) {
    if(!this.state.loaded) return;
    return this.run(async()=>{
      // Do not abandon an uncertain creation or generation to open another warehouse.
      if(this.state.creation || this.state.pending && this.state.warehouse?.id!==warehouseId)
        throw fail('MODELING_REVIEW_REQUIRED');
      this.state.loaded=false;
      await this.readRoots();
      const warehouse=this.state.warehouses.find(w=>w.id===warehouseId && w.state==='active');
      if(!warehouse) throw fail('MODELING_RESOURCE_NOT_FOUND');
      const changed=this.state.warehouse?.id!==warehouseId;
      Object.assign(this.state,{warehouse,step:'result',context:null,proposal:null,ruleProposalId:null,notice:''});
      if(changed) {this.state.needsReview=false;this.state.answerEdit=null;}
      await this.recoverContext();this.state.loaded=true;this.persist();
    });
  }
  async write(action,input,accept) {
    if(this.state.pending && this.state.pending.action!==action) throw fail('MODELING_OPERATION_CONFLICT');
    if(!this.state.pending) {
      const request=onboardingRequest(action,input);
      this.state.pending={action,path:request.path,input:copy(input),
        ...(action==='onboarding-generate'?{previousProposalId:this.state.proposal?.id||null}:{})};
    }
    this.persist(); // Must succeed before sending any write.
    const pending=this.state.pending;
    const result=await this.read(pending.action,pending.input);
    const before=copy(this.state);
    try {
      accept(result);
      this.state.pending=null;
      this.persist(); // Commit the result and removal of its pending envelope together.
    } catch(error) {
      // Retain the original envelope and edit/creation snapshot if the local commit fails.
      this.state=before;
      throw error;
    }
    return result;
  }
  async create({generate=false}={}) {
    if(!this.state.loaded) return;
    return this.run(async()=>{
      if(this.state.needsReview) throw fail('MODELING_REVISION_CHANGED');
      if(this.state.warehouse) { await this.recoverContext(); return; }
      if(!this.state.creation) {
        this.state.answers.background='';
        const issue=validation(this.state.answers,this.state.warehouses,true);
        if(issue) {this.state.error=issue;return;}
        this.state.creation={operation:this.uuid(),answers:copy(this.state.answers),saved:null};
        this.persist();
      }
      const creation=this.state.creation;
      if(!creation.saved) {
        await this.write('onboarding-save',{body:{operation_id:this.uuid(),expected_revision:this.state.record.revision,status:'in_progress',
          answers:{...creation.answers,warehouse_name:creation.answers.warehouse_name.trim(),flow_mode:'create',flow_step:'confirm',creation_operation:creation.operation}}},result=>{
          if(!result.resource_id || !Number.isSafeInteger(result.revision)) throw fail('SEMANTICA_INVALID_RESPONSE');
          creation.saved={id:result.resource_id,revision:result.revision};
          this.state.record=result.onboarding || {...this.state.record,id:result.resource_id,revision:result.revision};
        });
      }
      let createdRevision=null;
      await this.write('onboarding-create',{onboardingId:creation.saved.id,body:{operation_id:creation.operation,
        expected_revision:creation.saved.revision,name:creation.answers.warehouse_name.trim(),purpose:creation.answers.purpose}},result=>{
        if(['cleared','deleted'].includes(result.status) || !result.warehouse?.id) throw fail('MODELING_RESOURCE_NOT_FOUND');
        this.state.warehouse=result.warehouse; this.state.step='result'; this.state.creation=null;this.state.notice='';
        createdRevision=result.revision;
      });
      await this.readRoots(); await this.recoverContext();
      if(generate && !this.state.proposal && !this.state.needsReview) {
        const context=this.state.context;
        // Creation is consent only for the answers on its confirmation screen.
        // A changed version also requires review even if its text was changed back.
        if(!sameAnswers(context?.answers,creation.answers) || !Number.isSafeInteger(createdRevision) ||
          context.onboarding_revision!==createdRevision || context.purpose_revision!==1 || context.latest_confirmation_id!=null)
          throw fail('MODELING_ANSWERS_STALE');
        await this.generateConfirmed();
      }
    });
  }
  async recoverContext() {
    if(!this.state.warehouse) return;
    const warehouseId=this.state.warehouse.id;
    this.state.context=null;this.state.proposal=null;this.state.reviewQuestions=[];
    const context=await this.read('onboarding-context',{warehouseId});
    this.state.context=context;
    let proposal=context.proposal;
    if(proposal?.id) proposal=await this.read('onboarding-suggestion',{warehouseId,suggestionId:proposal.id});
    this.state.proposal=proposal || null;
    const review=currentRuleReview(context,proposal);
    this.state.reviewQuestions=unresolvedQuestions(context,proposal,review?.publication,
      review?.publication?savedReviewQuestions(this.storage,this.identity,warehouseId,review.proposal_id):[]);
    this.state.ruleProposalId=ruleProposalId(context,proposal);
    if(['published','reused_existing'].includes(review?.publication?.status)) this.state.needsReview=false;
    else if(proposal?.status==='stale') this.state.needsReview=true;
    const pending=this.state.pending;
    if(pending?.action==='onboarding-generate' && Object.hasOwn(pending,'previousProposalId') && proposal && proposal.id!==pending.previousProposalId && proposal.confirmation_id===pending.input.body.confirmation_id &&
      proposal.base_ontology_id===pending.input.body.base_ontology_id && ['succeeded','failed','stale'].includes(proposal.status)) {
      this.state.pending=null; this.persist();
    }
  }
  async refresh() {
    if(!this.state.loaded) return this.load();
    return this.run(async()=>{
      this.state.loaded=false;
      await this.readRoots();await this.recoverContext();this.state.loaded=true;this.persist();
    });
  }
  async reviewAgain() {
    if(!this.state.loaded) return;
    return this.run(async()=>{
      await this.readRoots(); await this.recoverContext();
      this.state.pending=null; this.state.creation=null; this.state.needsReview=false;
      if(!this.state.warehouse) {
        const record=this.state.record;
        this.state.answers=record.status==='in_progress' && !record.created_workspace_id
          ? {...blank(),...record.answers} : {...blank(),...profileAnswers(this.state.answers)};
        this.state.step='details';
      }
      this.persist();
    });
  }
  async generate() {
    if(!this.state.loaded) return;
    return this.run(()=>this.generateConfirmed());
  }
  async editAnswers() {
    if(!this.state.loaded||this.state.pending)return;
    return this.run(async()=>{
      await this.readRoots();await this.recoverContext();
      if(!this.state.context || this.state.proposal?.status==='generating')return;
      this.state.answerEdit={answers:generationAnswers(this.state.context.answers),base:answerBase(this.state.context)};
      this.state.needsReview=false;this.persist();
    });
  }
  updateAnswer(field,value) {
    if(!this.live||!this.state.loaded||this.state.busy||this.state.pending||!this.state.answerEdit||!(field in answerLimits)||field==='background')return;
    this.state.answerEdit.answers[field]=value;
    try{this.persist();}catch(error){this.state.error=messageFor(error);}
  }
  cancelAnswerEdit(){
    if(!this.live||this.state.busy||this.state.pending)return;
    this.state.answerEdit=null;this.persist();this.emit();
  }
  async submitAnswers(){
    if(!this.state.loaded||!this.state.answerEdit)return;
    return this.run(async()=>{
      if(!this.state.pending){
        const issue=validation(this.state.answerEdit.answers,[],false);
        if(issue){this.state.error=issue;return;}
        await this.readRoots();await this.recoverContext();
        if(!this.state.context)throw fail('MODELING_RESOURCE_NOT_FOUND');
        const base=answerBase(this.state.context);
        if(JSON.stringify(base)!==JSON.stringify(this.state.answerEdit.base)){
          this.state.answerEdit.base=base;
          throw fail('MODELING_ANSWERS_STALE');
        }
        this.state.needsReview=false;
      }
      await this.generateConfirmed();
    });
  }
  async generateConfirmed() {
      if(this.state.needsReview&&!this.state.pending) throw fail('MODELING_ANSWERS_STALE');
      if(!this.state.context || !this.state.warehouse) throw fail('MODELING_RESOURCE_NOT_FOUND');
      const warehouseId=this.state.warehouse.id;
      // Recover first when delivery of a previous generation response was uncertain.
      if(this.state.pending?.action==='onboarding-generate') {
        await this.recoverContext();
        if(!this.state.pending || this.state.proposal?.status==='generating') return;
      }
      if(this.state.proposal?.status==='generating') {await this.recoverContext();return;}
      const context=this.state.context;
      let confirmation=context.confirmation;
      if(this.state.pending?.action==='onboarding-generate') {
        // No new confirmation may precede replay of an uncertain generation request.
        // Its original confirmation and base version are validated by the server.
        await this.write('onboarding-generate',this.state.pending.input,result=>this.acceptProposal(result));
        return;
      }
      if(!confirmation || this.state.answerEdit || context.answers?.background || this.state.pending?.action==='onboarding-confirm') {
        await this.write('onboarding-confirm',{warehouseId,body:{operation_id:this.uuid(),expected_revision:context.purpose_revision,
          onboarding_revision:context.onboarding_revision,expected_confirmation_id:context.latest_confirmation_id,
          answers:generationAnswers(this.state.answerEdit?.answers||context.answers)}},result=>{
          if(!result.resource_id) throw fail('SEMANTICA_INVALID_RESPONSE');
          confirmation=result.confirmation || {id:result.resource_id}; this.state.context.confirmation=confirmation;
          this.state.context.answers=copy(confirmation.answers||this.state.pending.input.body.answers);
          Object.assign(this.state.answers,profileAnswers(this.state.context.answers));
          this.state.context.latest_confirmation_id=confirmation.id;
          this.state.answerEdit=null;
          this.state.needsReview=false;
        });
      }
      await this.write('onboarding-generate',{warehouseId,body:{operation_id:this.uuid(),confirmation_id:confirmation.id,
        base_ontology_id:context.base_ontology_id}},result=>{
        this.acceptProposal(result);
      });
  }
  acceptProposal(result) {
    if(!result.id || !result.status) throw fail('SEMANTICA_INVALID_RESPONSE');
    if(result.id!==this.state.proposal?.id)this.state.ruleProposalId=null;
    this.state.proposal=result;
    // A new generation receipt is newer than the context fetched before that write.
    this.state.reviewQuestions=unresolvedQuestions(null,result,null,this.state.reviewQuestions);
    this.state.context.unresolved_questions=[...this.state.reviewQuestions];
    this.state.ruleProposalId=ruleProposalId(this.state.context,result);
    this.state.needsReview=result.status==='stale';
  }
  reset() {
    this.live=false;this.epoch++;this.state={...this.state,answers:blank(),record:null,warehouses:[],warehouse:null,context:null,proposal:null,pending:null,creation:null,answerEdit:null,reviewQuestions:[]};
  }
}
