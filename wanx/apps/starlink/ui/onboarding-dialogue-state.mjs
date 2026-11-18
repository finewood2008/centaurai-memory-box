import {identityKey,onboardingRequest} from '../shared/onboarding-contract.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';
import {validateQuestionActions,questionActionsFromReceipt} from '../shared/onboarding-dialogue-contract.mjs';
import {nextDialogueQuestion,nextScopeQuestion} from './onboarding-dialogue-questions.mjs';
const clone=structuredClone;
function canonicalSchema(value){
  if(Array.isArray(value))return value.map(canonicalSchema);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalSchema(value[key])]));
  return value;
}
function restoreInputMode(value){
  value.inputMode??=value.input?'free':'answer';
  value.inputQuestionId??=null;
  value.deferredQuestionId??=null;
  if(!['answer','free'].includes(value.inputMode))throw Error();
  for(const id of [value.inputQuestionId,value.deferredQuestionId]){
    if(id!==null)validateQuestionActions([{question_id:id,action:'answer',answer:''}],{draft:true});
  }
}
const fail=(code,status=0)=>Object.assign(Error(code),{code,status});
export const scopeOnlyInstruction = '本轮仅校准业务范围，原样保留现行本体的类型、关系与属性。';
export const onboardingUnavailable = (code, status) => code === 'SEMANTICA_UPGRADE_REQUIRED' ||
  ['SEMANTICA_RESOURCE_NOT_FOUND','SEMANTICA_OPERATION_NOT_ALLOWED'].includes(code) && (status === undefined || status === 404);
const messages={MODELING_ONBOARDING_BUSY:'本轮正在生成，请读取原轮次进度。',MODELING_ONBOARDING_STALE:'本体、用途或草稿已变化。已保留历史，请读取最新状态；必要时基于当前规则开始新的建仓对话。',MODELING_ONBOARDING_NOT_READY:'请先明确服务对象、用途，并形成至少一个实体类型。',MODELING_ONBOARDING_TIMEOUT:'本轮生成超时，原草稿保留。请先读取进度，再决定是否重试。',MODELING_ONBOARDING_INVALID_OUTPUT:'模型结果不完整或结构无效，原草稿保留。',MODELING_ONBOARDING_MODEL_FAILED:'本轮生成失败，原草稿保留。请检查处理模型后重试。',MODELING_CONTEXT_BUDGET:'当前对话或本体超出模型预算。请精简要求、调整模型，或使用已有本体编辑流程。',MODELING_OPERATION_CONFLICT:'操作号与原请求不一致，请恢复原请求。',MODELING_SCENARIO_MISMATCH:'会话类型不匹配，请重新选择建仓会话。',MODELING_INVALID_REQUEST:'请检查输入长度、名称和请求内容。',MODELING_LOCAL_SAVE_FAILED:'本机恢复记录无法保存。请求未继续提交，请检查可用空间或存储权限。',MODELING_LOCAL_RECORD_INVALID:'恢复记录无法读取，请保留记录并检查客户端版本。',MODELING_REQUEST_PENDING:'上次请求结果尚未确认，请先恢复原请求。',MODELING_CONFIRMATION_REQUIRED:'请先核对最新的完整预览并勾选发布确认。',MODELING_RESOURCE_NOT_FOUND:'知识仓或会话不存在，或当前账号无权访问。',HOST_SESSION_EXPIRED:'账号会话已失效，请重新登录。',WAREHOUSE_NAME_CONFLICT:'已有同名知识仓，请修改名称。',MODELING_REVIEW_REQUIRED:'内容已更新，请重新核对后提交。',SEMANTICA_UPGRADE_REQUIRED:'当前 Bridge 尚未提供建仓对话接口，请更新并重启服务。',MODELING_PUBLICATION_REPLACED:'本次规则已发布，随后已有新版生效。进入数据仓可查看当前规则。',MODELING_PUBLISHED_ENTRY_FAILED:'规则已发布，暂时无法打开工作区。',MODELING_HOST_CREATION_REQUIRED:'请从万象个人空间打开星图后继续。'};
export function dialogueError(error) {
  const code = error?.code || error?.error_code || '';
  if (code === 'MODELING_SCOPE_RULE_CHANGE') return '范围向导仅更新业务范围。请移除草稿中的规则变更，或前往规则总览手动编辑本体。';
  if (code === 'MODELING_UNSENT_ANSWER') return '还有尚未发送的回答或修改要求，请先发送，或清空输入后核对现有范围。';
  if (code === 'MODEL_BILLING_REQUIRED') return '云端模型因计费问题无法调用。请在「模型设置」选择可用的模型后重试。草稿已保留。';
  if (code === 'MODELING_CONTEXT_BUDGET') {
    const {context_tokens: current, required_context_tokens: required} = error.context_budget || {};
    if (Number.isSafeInteger(current) && current > 0 && Number.isSafeInteger(required) && required > current) {
      return `当前配置的上下文上限是 ${current} 个 token，本轮预计至少需要 ${required} 个。请缩短输入，或在「模型设置」选择更长上下文的模型后重试。草稿已保留。`;
    }
  }
  if (messages[code]) return messages[code];
  if (/MODEL_|LLM_NOT_CONFIGURED/.test(code)) return '模型调用未完成，请检查“模型与处理”中的配置和授权后再试。';
  if (/SEMANTICA_(OPERATION_NOT_ALLOWED|QUERY_NOT_ALLOWED|INVALID_REQUEST)/.test(code)) return '当前 Bridge 尚未提供兼容的建仓对话入口，请更新并重启服务。';
  return '操作未完成，请读取状态或恢复原请求。不要重复创建或发布。';
}
const validSnapshot=v=>v&&typeof v.conversation_id==='string'&&['guiding','ready_for_preview','stale','published'].includes(v.status)&&Number.isSafeInteger(v.draft?.revision)&&v.draft.revision>=0&&/^[a-f0-9]{64}$/.test(v.draft_digest||'')&&Array.isArray(v.draft.schema?.entity_types)&&Array.isArray(v.draft.schema?.relation_types)&&v.draft.scope&&Array.isArray(v.turns?.items);
Object.assign(messages,{MODELING_ONBOARDING_ALREADY_STARTED:'开场已生成，请读取最新状态并继续回答或修改。',MODELING_ONBOARDING_QUESTION_STALE:'问题台账已变化，请读取最新问题后重新核对本轮操作。',MODELING_QUESTION_ACTION_LIMIT:'每次最多提交两个问题的操作，请先发送当前内容。'});

export class OnboardingDialogue {
  constructor({call,storage,identity,onChange=()=>{},onEnter=async()=>{},uuid=()=>crypto.randomUUID()}){
    this.call=call;this.storage=storage;this.onChange=onChange;this.onEnter=onEnter;this.uuid=uuid;this.live=true;this.readSequence=0;
    this.key='starlink.onboarding-dialogue.v1.'+identityKey(identity);
    this.saved={version:1,warehouse:null,conversationId:null,creation:null,pending:null,preview:null,input:'',inputMode:'answer',inputQuestionId:null,deferredQuestionId:null,name:'',questionActions:[],openingAttempts:[],activeTurn:null,composers:{},warehouseDrafts:{},setupMode:null,publication:null,entryPending:false};
    this.state={loaded:false,busy:false,error:'',errorCode:'',page:'name',snapshot:null,turns:[],sessions:[],tab:'graph',confirmed:false,pollError:false};
  }
  check(){if(!this.live)throw fail('HOST_SESSION_EXPIRED');}
  emit(){if(this.live)this.onChange();}
  persist(){this.check();try{this.storage.setItem(this.key,JSON.stringify(this.saved));}catch{throw fail('MODELING_LOCAL_SAVE_FAILED');}}
  restore(){this.restoreBlocked=false;try{const raw=this.storage.getItem(this.key);if(!raw)return;const s=JSON.parse(raw);
    if(s.version!==1||typeof s.name!=='string'||typeof s.input!=='string')throw Error();
    s.purpose??='';if(typeof s.purpose!=='string'||[...s.purpose].length>16000)throw Error();
    if(s.warehouse)conversationRequest('conversation-list',{warehouseId:s.warehouse.id});
    if(s.conversationId)conversationRequest('conversation-onboarding-get',{warehouseId:s.warehouse?.id,conversationId:s.conversationId});
    if(s.pending){if(!['onboarding-save','onboarding-create','conversation-create','conversation-onboarding-start','conversation-onboarding-send','conversation-onboarding-preview','conversation-onboarding-publish'].includes(s.pending.action))throw Error();this.validate(s.pending.action,s.pending.input);
      if(s.pending.input.warehouseId&&s.pending.input.warehouseId!==s.warehouse?.id)throw Error();
      if(s.pending.input.conversationId&&s.pending.input.conversationId!==s.conversationId)throw Error();
      if(s.pending.composer){if(typeof s.pending.composer.input!=='string')throw Error();validateQuestionActions(s.pending.composer.questionActions,{draft:true});}}
    if(s.creation&&(!s.creation.name||!s.creation.operationId||s.creation.purpose!==undefined&&(typeof s.creation.purpose!=='string'||[...s.creation.purpose].length>16000)))throw Error();
    s.questionActions??=[];s.openingAttempts??=[];s.activeTurn??=null;s.composers??={};validateQuestionActions(s.questionActions,{draft:true});
    if(s.activeTurn){if(s.activeTurn.conversationId!==s.conversationId)throw Error();conversationRequest('conversation-onboarding-turn',{warehouseId:s.warehouse?.id,conversationId:s.conversationId,turnId:s.activeTurn.turnId});}
    if(!s.composers||typeof s.composers!=='object'||Array.isArray(s.composers))throw Error();
    restoreInputMode(s);
    for(const value of Object.values(s.composers)){if(typeof value?.input!=='string')throw Error();validateQuestionActions(value.questionActions,{draft:true});restoreInputMode(value);}
    s.warehouseDrafts??={};s.setupMode??=null;s.publication??=null;s.entryPending??=false;
    if(!s.warehouseDrafts||typeof s.warehouseDrafts!=='object'||Array.isArray(s.warehouseDrafts)||![null,'new','update'].includes(s.setupMode))throw Error();
    for(const [warehouseId,draft] of Object.entries(s.warehouseDrafts)){
      conversationRequest('conversation-list',{warehouseId});
      if(!draft||!['new','update'].includes(draft.setupMode))throw Error();
      if(draft.conversationId)conversationRequest('conversation-onboarding-get',{warehouseId,conversationId:draft.conversationId});
      if(draft.activeTurn)conversationRequest('conversation-onboarding-turn',{warehouseId,conversationId:draft.conversationId,turnId:draft.activeTurn.turnId});
    }
    if(!Array.isArray(s.openingAttempts)||s.openingAttempts.some(id=>typeof id!=='string'))throw Error();this.saved=s;
  }catch{this.restoreBlocked=true;this.state.loaded=false;throw fail('MODELING_LOCAL_RECORD_INVALID');}}
  validate(action,input){const r=action.startsWith('onboarding-')?onboardingRequest(action,input):conversationRequest(action,input);if(!r)throw fail('MODELING_INVALID_REQUEST');return r;}
  async read(action,input={}){this.check();const request=this.validate(action,input);try{const r=await this.call(action,clone(input));this.check();return r;}catch(e){if(request.method==='GET')e.dialogueReadFailure=true;throw e;}}
  error(e){if(!this.live)return;this.state.errorCode=e.code||'';this.state.error=e.dialogueAction==='conversation-create'&&['MODELING_INVALID_REQUEST','SEMANTICA_INVALID_REQUEST'].includes(e.code)?'知识仓已创建，但建仓会话请求被拒绝。请检查 WANX Bridge 是否支持 onboarding 建仓场景；更新并重启后可继续创建会话，无需重建知识仓。':dialogueError(e);this.state.readFailure=e.dialogueReadFailure===true;
    if([401,403,404].includes(e.status)||e.code==='HOST_SESSION_EXPIRED'){this.state.loaded=false;this.state.snapshot=null;this.state.turns=[];this.state.confirmed=false;this.state.sessions=[];}
  }
  async run(fn){if(!this.live||this.state.busy)return;this.state.busy=true;this.state.error='';this.state.errorCode='';this.emit();try{await fn();}catch(e){this.error(e);}finally{this.state.busy=false;this.emit();}}
  async authorize(){
    let list;
    try{list=await this.read('onboarding-warehouses');}
    catch(error){
      // Existing-warehouse conversations can work on boxes without the global
      // first-run interface. Their normal warehouse list is already actor-scoped.
      if(!this.saved.warehouse||!onboardingUnavailable(error.code,error.status))throw error;
      list=await this.call('warehouses');this.check();
    }
    if(!Array.isArray(list?.items))throw fail('SEMANTICA_INVALID_RESPONSE');
    this.state.warehouseMissing=!!this.saved.warehouse&&!list.items.some(w=>w.id===this.saved.warehouse.id&&w.state==='active');
    if(this.state.warehouseMissing)throw fail('MODELING_RESOURCE_NOT_FOUND',404);
    return list.items;
  }
  ids(){return {warehouseId:this.saved.warehouse.id,conversationId:this.saved.conversationId};}
  get generating(){return this.saved.activeTurn?.conversationId===this.saved.conversationId||!!this.state.snapshot?.active_turn_id||this.state.turns.some(t=>t.status==='generating')||['conversation-onboarding-send','conversation-onboarding-start'].includes(this.inFlight);}
  get questions(){return this.state.snapshot?.draft.question_states||this.state.snapshot?.draft.questions||[];}
  get unsent(){return !!this.saved.input.trim()||!!this.saved.questionActions.length;}
  get editable(){return this.state.loaded&&!!this.saved.conversationId&&this.state.snapshot?.conversation_id===this.saved.conversationId&&!this.saved.pending&&!this.state.busy&&!this.generating&&!['published','stale'].includes(this.state.snapshot.status);}
  get canPreview(){return this.editable&&this.state.snapshot?.can_preview===true;}
  get scopePublicationAllowed(){
    const {preview}=this.saved,{baseRule,snapshot}=this.state;
    return !!preview&&Array.isArray(preview.changes)&&preview.changes.length===0&&
      !!baseRule?.schema&&baseRule.id===snapshot?.draft.base_ontology_id&&
      baseRule.id===preview.base_ontology_id&&preview.draft_digest===snapshot.draft_digest&&
      JSON.stringify(canonicalSchema(preview.schema))===JSON.stringify(canonicalSchema(baseRule.schema));
  }
  get currentQuestion(){return (this.saved.setupMode==='update'?nextScopeQuestion:nextDialogueQuestion)(this.state.snapshot?.draft);}
  get inputQuestion(){if(this.saved.inputMode==='free')return null;return this.saved.inputQuestionId?this.questions.find(q=>q.question_id===this.saved.inputQuestionId)||{question_id:this.saved.inputQuestionId,text:'原问题已变化，请重新选择回答对象'}:this.currentQuestion;}
  rememberComposer(){if(this.saved.warehouse&&this.saved.conversationId)this.saved.composers[this.saved.warehouse.id+':'+this.saved.conversationId]={input:this.saved.input,inputMode:this.saved.inputMode,inputQuestionId:this.saved.inputQuestionId,deferredQuestionId:this.saved.deferredQuestionId,questionActions:clone(this.saved.questionActions)};}
  restoreComposer(){const c=this.saved.composers[this.saved.warehouse.id+':'+this.saved.conversationId];this.saved.input=c?.input||'';this.saved.inputMode=c?.inputMode||'answer';this.saved.inputQuestionId=c?.inputQuestionId||null;this.saved.deferredQuestionId=c?.deferredQuestionId||null;this.saved.questionActions=clone(c?.questionActions||[]);}
  async listSessions(){let offset=0,items=[];
    for(let page=0;page<200;page++){const r=await this.read('conversation-list',{warehouseId:this.saved.warehouse.id,offset,limit:50});if(!Array.isArray(r.items))throw fail('SEMANTICA_INVALID_RESPONSE');items.push(...r.items.filter(c=>c.scenario==='onboarding'));
      if(!r.has_more){this.state.sessions=items;return items;}if(!Number.isSafeInteger(r.next_offset)||r.next_offset<=offset)throw fail('SEMANTICA_INVALID_RESPONSE');offset=r.next_offset;}
    throw fail('MODELING_CONTEXT_BUDGET');
  }
  restoreSession(sessions){
    // Never replace an unresolved creation request with a different session:
    // its original operation must still be replayed to recover the receipt.
    if(this.saved.conversationId||this.saved.pending)return;
    const session=sessions.find(c=>c.status==='active');if(!session)return;
    const before=clone(this.saved);
    this.saved.conversationId=session.id;this.saved.activeTurn=null;this.saved.preview=null;this.restoreComposer();
    try{this.persist();}catch(e){this.saved=before;throw e;}
    this.state.snapshot=null;this.state.turns=[];this.state.confirmed=false;this.state.page='chat';
  }
  rememberWarehouseDraft(){
    const {warehouse,conversationId,activeTurn,preview,setupMode,publication,entryPending}=this.saved;
    if(!warehouse)return;
    this.rememberComposer();
    this.saved.warehouseDrafts={...this.saved.warehouseDrafts,[warehouse.id]:{conversationId,activeTurn,preview,setupMode:setupMode||'update',publication,entryPending}};
  }
  load({warehouse=null,fresh=false,template=null,newWarehouse=false,startUpdate=false}={}){return this.run(async()=>{
    this.restore();
    if((warehouse&&warehouse.id!==this.saved.warehouse?.id||fresh)&&(this.saved.pending||this.saved.creation))throw fail('MODELING_REQUEST_PENDING');
    if(fresh&&this.saved.warehouse){
      this.rememberWarehouseDraft();
      Object.assign(this.saved,{warehouse:null,conversationId:null,preview:null,name:'',purpose:'',activeTurn:null,setupMode:null,publication:null,entryPending:false,input:'',inputMode:'answer',inputQuestionId:null,deferredQuestionId:null,questionActions:[]});
      this.persist();
    }
    if(fresh&&template){if(typeof template.name!=='string'||typeof template.purpose!=='string'||[...template.purpose].length>16000)throw fail('MODELING_INVALID_REQUEST');this.saved.name=template.name;this.saved.purpose=template.purpose;this.persist();}
    if(warehouse&&warehouse.id!==this.saved.warehouse?.id){
      this.rememberWarehouseDraft();
      const draft=Object.hasOwn(this.saved.warehouseDrafts,warehouse.id)?this.saved.warehouseDrafts[warehouse.id]:null;
      Object.assign(this.saved,{warehouse,conversationId:null,activeTurn:null,preview:null,publication:null,entryPending:false,setupMode:newWarehouse?'new':'update',...draft,name:warehouse.name});
      this.restoreComposer();
      this.persist();
    }
    await this.authorize();this.state.loaded=true;
    if(startUpdate&&warehouse&&warehouse.id===this.saved.warehouse?.id&&this.saved.setupMode!=='update'&&!this.saved.pending&&!this.saved.entryPending){
      this.saved.setupMode='update';this.persist();
    }
    if(this.saved.warehouse){this.state.page='chat';const sessions=await this.listSessions();
      if(this.saved.conversationId&&!sessions.some(c=>c.id===this.saved.conversationId))throw fail('MODELING_RESOURCE_NOT_FOUND',404);
      this.restoreSession(sessions);
      if(!this.saved.conversationId&&!this.saved.pending)await this.createSession();
      if(this.saved.conversationId){
        await this.snapshot();
        if(startUpdate&&!this.saved.entryPending&&!this.saved.pending&&this.state.snapshot?.status==='published'){
          this.saved.setupMode='update';await this.createSession();await this.snapshot();
        }
        if(this.saved.preview)this.state.page='review';
      }
    }
    this.state.loaded=true;await this.maybeStart();
  });}
  async createSession(){await this.write('conversation-create',{warehouseId:this.saved.warehouse.id,operationId:this.uuid(),scenario:'onboarding'});await this.listSessions();}
  async write(action,input){
    if(action==='conversation-onboarding-publish'&&this.saved.setupMode==='update'&&!this.scopePublicationAllowed)throw fail('MODELING_SCOPE_RULE_CHANGE');
    if(this.saved.pending&&this.saved.pending.action!==action)throw fail('MODELING_REQUEST_PENDING');
    if(!this.saved.pending){this.validate(action,input);this.saved.pending={action,input:clone(input),...(action==='conversation-onboarding-send'?{composer:{input:this.saved.input,questionActions:clone(this.saved.questionActions)}}:{})};}
    this.persist();const p=this.saved.pending;this.inFlight=p.action;this.emit();let result;
    try{result=await this.read(p.action,p.input);}catch(e){
      if([400,409,413,422].includes(e.status)&&!['MODELING_OPERATION_CONFLICT','ONTOLOGY_OPERATION_CONFLICT'].includes(e.code)){const before=clone(this.saved);this.saved.pending=null;
        // A definite refusal created no warehouse; let the user fix its name or
        // re-read the record revision. Unknown outcomes keep the original request.
        if(['onboarding-save','onboarding-create'].includes(p.action))this.saved.creation=null;
        const invalidPreview=p.action==='conversation-onboarding-publish'&&['MODELING_ONBOARDING_STALE','MODELING_REVIEW_REQUIRED'].includes(e.code);
        if(invalidPreview)this.saved.preview=null;
        try{this.persist();}catch(saveError){this.saved=before;throw saveError;}
        if(invalidPreview){this.state.confirmed=false;this.state.page='chat';}}
      e.dialogueAction=p.action;throw e;
    }finally{this.inFlight=null;}
    const before=clone(this.saved),page=this.state.page;
    try{this.accept(p,result);this.saved.pending=null;this.persist();}catch(e){this.saved=before;this.state.page=page;throw e;}
    return result;
  }
  accept(p,r){
    if(p.action==='onboarding-save'){if(!r.resource_id||!Number.isSafeInteger(r.revision))throw fail('SEMANTICA_INVALID_RESPONSE');this.saved.creation.record={id:r.resource_id,revision:r.revision};}
    else if(p.action==='onboarding-create'){if(!r.warehouse?.id||r.warehouse.state!=='active')throw fail('SEMANTICA_INVALID_RESPONSE');this.saved.warehouse=r.warehouse;this.saved.setupMode='new';this.saved.creation=null;this.saved.name=r.warehouse.name;this.state.page='chat';}
    else if(p.action==='conversation-create'){if(!r.resource_id)throw fail('SEMANTICA_INVALID_RESPONSE');this.rememberComposer();this.saved.conversationId=r.resource_id;this.saved.activeTurn=null;this.saved.preview=null;this.restoreComposer();this.state.snapshot=null;this.state.turns=[];this.state.confirmed=false;this.state.page='chat';this.saved.publication=null;this.saved.entryPending=false;}
    else if(['conversation-onboarding-send','conversation-onboarding-start'].includes(p.action)){
      if(r.conversation_id!==p.input.conversationId||!r.resource_id||!['generating','succeeded','failed','stale'].includes(r.status)||r.publication_performed===true)throw fail('SEMANTICA_INVALID_RESPONSE');
      this.saved.activeTurn=r.status==='generating'?{conversationId:p.input.conversationId,turnId:r.resource_id}:null;
      if(p.action==='conversation-onboarding-send'){
        if(this.saved.input===(p.composer?.input??p.input.content??'')){this.saved.input='';this.saved.inputMode='answer';this.saved.inputQuestionId=null;}
        if(JSON.stringify(this.saved.questionActions)===JSON.stringify(p.composer?.questionActions??p.input.questionActions??[]))this.saved.questionActions=[];
      }
      this.saved.preview=null;this.state.confirmed=false;this.state.page='chat';
    }else if(p.action==='conversation-onboarding-preview'){
      if(r.conversation_id!==p.input.conversationId||r.status!=='previewed'||r.draft_revision!==p.input.revision||r.draft_digest!==p.input.draftDigest||!/^[a-f0-9]{64}$/.test(r.preview_digest||'')||!r.resource_id||r.publication_performed!==false||!r.scope||!Array.isArray(r.schema?.entity_types)||!Array.isArray(r.schema?.relation_types))throw fail('SEMANTICA_INVALID_RESPONSE');
      this.saved.preview=r;this.state.confirmed=false;this.state.page='review';
    }else if(p.action==='conversation-onboarding-publish'){
      if(r.conversation_id!==p.input.conversationId||r.status!=='published'||r.resource_id!==p.input.previewId||!r.ontology_id||r.publication_performed!==true||r.extraction_started!==false)throw fail('SEMANTICA_INVALID_RESPONSE');
      this.saved.publication=r;this.saved.entryPending=true;this.saved.preview=null;this.state.confirmed=false;this.state.page='chat';
    }
  }
  create(){return this.run(async()=>{
    if(!this.state.loaded||this.saved.pending)throw fail('MODELING_REQUEST_PENDING');
    if(this.saved.warehouse)return;
    const name=this.saved.name.trim();if([...name].length<2||[...name].length>30)throw fail('MODELING_INVALID_REQUEST');
    const list=await this.authorize();if(list.some(w=>w.state!=='deleted'&&w.name.normalize('NFKC').trim().toLowerCase()===name.normalize('NFKC').toLowerCase()))throw fail('WAREHOUSE_NAME_CONFLICT');
    const root=await this.read('onboarding-read');
    if(!Number.isSafeInteger(root?.revision)||root.revision<0||!root.id&&root.revision!==0)throw fail('SEMANTICA_INVALID_RESPONSE');
    this.saved.creation||={name,purpose:this.saved.purpose||'',operationId:this.uuid(),record:null};
    this.persist();
    await this.continueCreation(root);
  });}
  async continueCreation(){const c=this.saved.creation;
    if(c){if(!c.record){const root=await this.read('onboarding-read');if(!Number.isSafeInteger(root.revision)||root.revision<0)throw fail('SEMANTICA_INVALID_RESPONSE');
      // The compatibility record identifies the creator; its global answers
      // are neither a new warehouse's scope nor disposable form state.
      if(root.id){c.record={id:root.id,revision:root.revision};this.persist();}
      else{
        if(root.revision!==0)throw fail('SEMANTICA_INVALID_RESPONSE');
        await this.write('onboarding-save',{body:{operation_id:this.uuid(),expected_revision:0,answers:{},status:'in_progress'}});
      }}
      await this.write('onboarding-create',{onboardingId:this.saved.creation.record.id,body:{operation_id:c.operationId,expected_revision:this.saved.creation.record.revision,name:c.name,purpose:c.purpose||''}});
    }
    if(this.saved.warehouse&&!this.saved.conversationId){
      this.restoreSession(await this.listSessions());
      if(!this.saved.conversationId)await this.createSession();
    }
    if(this.saved.conversationId){await this.snapshot();await this.maybeStart();}
  }
  async maybeStart(){const s=this.state.snapshot;
    // Only the first visit to a pristine server conversation may start a model.
    // Refresh, failed attempts, unknown outcomes and unfinished user input never do.
    if(!this.state.loaded||!s?.can_start||this.generating||this.saved.pending||this.unsent||this.saved.openingAttempts.includes(this.saved.conversationId)||s.turns.items.length||s.turns.has_more)return;
    if(this.saved.setupMode==='update'&&!this.currentQuestion)return;
    await this.startCurrent();
  }
  start(){return this.run(()=>this.startCurrent());}
  async startCurrent(){
    if(!this.state.loaded||this.saved.pending)throw fail('MODELING_REQUEST_PENDING');
    if(this.unsent)throw fail('MODELING_UNSENT_ANSWER');
    const seen=this.state.snapshot?.draft_digest;await this.authorize();await this.snapshot();
    if(this.generating)throw fail('MODELING_ONBOARDING_BUSY');
    if(!this.state.snapshot.can_start)throw fail('MODELING_ONBOARDING_ALREADY_STARTED');
    if(seen!==this.state.snapshot.draft_digest)throw fail('MODELING_ONBOARDING_STALE');
    if(!this.saved.openingAttempts.includes(this.saved.conversationId))this.saved.openingAttempts.push(this.saved.conversationId);
    this.persist();await this.write('conversation-onboarding-start',{...this.ids(),operationId:this.uuid(),revision:this.state.snapshot.draft.revision,draftDigest:seen});await this.snapshot();
  }
  async snapshot(offset=0){const ids=this.ids(),sequence=++this.readSequence;const r=await this.read('conversation-onboarding-get',{...ids,offset,limit:20});
    if(sequence!==this.readSequence||ids.conversationId!==this.saved.conversationId)return;
    if(!validSnapshot(r)||r.conversation_id!==ids.conversationId)throw fail('SEMANTICA_INVALID_RESPONSE');
    this.state.snapshot=r;this.state.turns=offset?[...this.state.turns.filter(t=>!r.turns.items.some(n=>n.resource_id===t.resource_id)),...r.turns.items]:r.turns.items;
    const baseId=r.draft.base_ontology_id;
    if(this.saved.setupMode==='update'&&baseId&&(this.state.baseRule?.id!==baseId||!this.state.baseRule?.schema||r.status==='stale'||r.status==='published')){
      this.state.baseRule={id:baseId,version:null};
      this.state.currentRuleVersion=null;
      try{
        const versions=await this.read('conversation-ontologies',{warehouseId:ids.warehouseId});
        if(sequence===this.readSequence&&ids.conversationId===this.saved.conversationId){
          const base=versions.items?.find(item=>item.id===baseId);
          const version=base?.version_number;
          if(base?.schema)this.state.baseRule.schema=base.schema;
          const active=versions.items?.find(item=>item.status==='published');
          if(Number.isSafeInteger(version))this.state.baseRule.version=version;
          if(Number.isSafeInteger(active?.version_number))this.state.currentRuleVersion=active.version_number;
        }
      }catch(error){
        if([401,403].includes(error.status)||error.code==='HOST_SESSION_EXPIRED')throw error;
        // Older boxes may not return version metadata for historical drafts.
      }
      if(sequence!==this.readSequence||ids.conversationId!==this.saved.conversationId)return;
    }
    // A known generating receipt must survive a failed follow-up GET. Clear it
    // only when an authoritative snapshot says idle or contains its final turn.
    if(this.saved.activeTurn&&('active_turn_id' in r&&!r.active_turn_id||r.turns.items.some(t=>t.resource_id===this.saved.activeTurn.turnId&&t.status!=='generating'))){this.saved.activeTurn=null;this.persist();}
    const preview=this.saved.preview;
    if(preview&&(
      preview.conversation_id!==r.conversation_id||
      preview.draft_digest!==r.draft_digest||
      JSON.stringify(preview.scope)!==JSON.stringify(r.draft.scope)||
      JSON.stringify(preview.schema)!==JSON.stringify(r.draft.schema)||
      preview.question_states&&r.draft.question_states&&JSON.stringify(preview.question_states)!==JSON.stringify(r.draft.question_states)||
      this.saved.setupMode!=='update'&&r.draft.ontology_proposed===false||
      ['published','stale'].includes(r.status)||this.generating
    )){
      this.saved.preview=null;this.state.confirmed=false;this.state.page='chat';this.persist();
    }
    if(this.state.readFailure){this.state.error='';this.state.errorCode='';this.state.readFailure=false;}
    this.state.pollError=false;
  }
  refresh(){if(this.restoreBlocked)return this.load();return this.run(async()=>{
    await this.authorize();
    if(this.saved.warehouse&&!this.saved.conversationId)this.restoreSession(await this.listSessions());
    if(this.saved.conversationId)await this.snapshot();
    this.state.loaded=true;
  });}
  more(){return this.run(async()=>{const t=this.state.snapshot?.turns;if(t?.has_more)await this.snapshot(t.next_offset);});}
  setInput(value){if(value&&this.saved.inputMode==='answer'&&!this.saved.inputQuestionId){this.saved.inputQuestionId=this.inputQuestion?.question_id||null;if(!this.saved.inputQuestionId)this.saved.inputMode='free';}this.saved.input=value;try{this.persist();}catch(e){this.error(e);this.emit();}}
  setInputMode(mode){if(!this.editable||!['answer','free'].includes(mode))return;const q=this.currentQuestion;if(mode==='answer'&&q?.question_id)return this.answerQuestion(q.question_id);this.saved.inputMode='free';this.saved.inputQuestionId=null;try{this.persist();}catch(e){this.error(e);}this.emit();}
  deferQuestion(){
    const question=this.currentQuestion;
    if(!this.editable||this.unsent||this.saved.setupMode!=='update'||!question?.question_id)return;
    this.saved.deferredQuestionId=question.question_id;
    this.setInputMode('free');
  }
  answerQuestion(id,value){if(!this.editable)return;const q=this.questions.find(q=>q.question_id===id);if(!q)return;
    if(this.saved.deferredQuestionId===id)this.saved.deferredQuestionId=null;
    this.saved.inputMode='answer';this.saved.inputQuestionId=id;this.saved.questionActions=this.saved.questionActions.filter(a=>a.question_id!==id);this.saved.input=value??this.saved.input;
    this.state.confirmed=false;try{this.persist();}catch(e){this.error(e);}this.emit();
  }
  stageQuestion(id,action,answer){if(!this.editable)return;try{
    const q=this.questions.find(q=>q.question_id===id);if(!q)throw fail('MODELING_ONBOARDING_QUESTION_STALE');
    const old=this.saved.questionActions.find(a=>a.question_id===id),rest=this.saved.questionActions.filter(a=>a.question_id!==id);
    if(rest.length>=2)throw fail('MODELING_QUESTION_ACTION_LIMIT');
    const value={question_id:id,action,...(action==='answer'?{answer:answer??old?.answer??q.answer??''}:{})};validateQuestionActions([value],{draft:true});
    this.saved.questionActions=[...rest,value];this.saved.inputMode='free';this.saved.inputQuestionId=null;this.state.confirmed=false;this.persist();
  }catch(e){this.error(e);}this.emit();}
  setQuestionAnswer(id,value){if(!this.editable)return;const a=this.saved.questionActions.find(a=>a.question_id===id&&a.action==='answer');if(a){a.answer=value;this.state.confirmed=false;try{this.persist();}catch(e){this.error(e);this.emit();}}}
  removeQuestion(id){if(!this.editable)return;this.saved.questionActions=this.saved.questionActions.filter(a=>a.question_id!==id);try{this.persist();}catch(e){this.error(e);}this.emit();}
  restoreReply(id){if(!this.editable)return;try{const t=this.state.turns.find(t=>t.resource_id===id&&t.status==='failed'&&t.kind!=='opening');if(!t)return;
    const actions=questionActionsFromReceipt(t.question_actions||[]);if(actions.some(a=>!this.questions.some(q=>q.question_id===a.question_id)))throw fail('MODELING_ONBOARDING_QUESTION_STALE');
    this.saved.questionActions=actions;this.saved.input=t.content||'';this.saved.inputMode='free';this.saved.inputQuestionId=null;this.state.confirmed=false;this.persist();
  }catch(e){this.error(e);}this.emit();}
  applyTemplate(template){
    const unavailable=onboardingUnavailable(this.state.errorCode);
    if(this.restoreBlocked||!this.state.loaded&&!unavailable||this.state.busy||this.saved.creation||this.saved.pending||this.saved.warehouse)return;
    const blank=template?.name===''&&template?.purpose==='';
    if(!blank&&(typeof template?.name!=='string'||[...template.name].length<2||[...template.name].length>30||typeof template.purpose!=='string'||[...template.purpose].length>16000))return;
    const before=clone(this.saved);this.saved.name=template.name;this.saved.purpose=template.purpose;
    try{this.persist();if(!unavailable){this.state.error='';this.state.errorCode='';}}catch(e){this.saved=before;this.error(e);}this.emit();
  }
  setName(value){if(this.restoreBlocked||this.saved.creation||this.saved.pending||this.saved.warehouse)return;this.saved.name=value;try{this.persist();}catch(e){this.error(e);this.emit();}}
  setPurpose(value){if(this.restoreBlocked||this.saved.creation||this.saved.pending||this.saved.warehouse)return;this.saved.purpose=value;try{this.persist();}catch(e){this.error(e);this.emit();}}
  sendComposer(){return this.send({answerQuestionId:this.inputQuestion?.question_id||null});}
  send({answerQuestionId=null}={}){return this.run(async()=>{
    if(!this.state.loaded||this.saved.pending)throw fail('MODELING_REQUEST_PENDING');
    const raw=answerQuestionId?'':this.saved.input;
    const content=this.saved.setupMode==='update'?
      [scopeOnlyInstruction,raw].filter(Boolean).join('\n'):
      raw;
    const questionActions=clone(this.saved.questionActions),seen=this.state.snapshot?.draft_digest;
    if(answerQuestionId){if(questionActions.some(a=>a.question_id===answerQuestionId))throw fail('MODELING_ONBOARDING_QUESTION_STALE');questionActions.push({question_id:answerQuestionId,action:'answer',answer:this.saved.input});validateQuestionActions(questionActions);}
    await this.authorize();await this.snapshot();
    if(this.generating)throw fail('MODELING_ONBOARDING_BUSY');
    if(['published','stale'].includes(this.state.snapshot.status)||seen!==this.state.snapshot.draft_digest)throw fail('MODELING_ONBOARDING_STALE');
    if(questionActions.some(a=>!this.questions.some(q=>q.question_id===a.question_id)))throw fail('MODELING_ONBOARDING_QUESTION_STALE');
    if(answerQuestionId&&!this.questions.some(q=>q.question_id===answerQuestionId&&['pending','answered','skipped','uncertain','deferred'].includes(q.status)))throw fail('MODELING_ONBOARDING_QUESTION_STALE');
    await this.write('conversation-onboarding-send',{...this.ids(),operationId:this.uuid(),revision:this.state.snapshot.draft.revision,draftDigest:seen,content,...(questionActions.length?{questionActions}:{})});await this.snapshot();
  });}
  preview(){return this.run(async()=>{
    if(!this.state.loaded||this.saved.pending)throw fail('MODELING_REQUEST_PENDING');
    if(this.unsent)throw fail('MODELING_UNSENT_ANSWER');
    const seen=this.state.snapshot?.draft_digest;await this.authorize();await this.snapshot();
    const snapshot=this.state.snapshot;
    if(seen!==snapshot.draft_digest||snapshot.status==='stale')throw fail('MODELING_ONBOARDING_STALE');
    if(this.generating)throw fail('MODELING_ONBOARDING_BUSY');
    if(!snapshot.can_preview||this.saved.setupMode!=='update'&&snapshot.draft.ontology_proposed===false)throw fail('MODELING_ONBOARDING_NOT_READY');
    const title=this.saved.setupMode==='update'?'范围校准':'初始本体';
    await this.write('conversation-onboarding-preview',{...this.ids(),operationId:this.uuid(),revision:this.state.snapshot.draft.revision,draftDigest:seen,name:(this.saved.warehouse.name+' · '+title).slice(0,120)});
  });}
  publish(){return this.run(async()=>{
    if(!this.state.loaded||this.saved.pending||!this.saved.preview||!this.state.confirmed)throw fail('MODELING_CONFIRMATION_REQUIRED');
    if(this.unsent)throw fail('MODELING_UNSENT_ANSWER');
    const p=clone(this.saved.preview);await this.authorize();await this.snapshot();
    if(!this.saved.preview||!this.state.confirmed||this.generating||this.state.snapshot.draft_digest!==p.draft_digest)throw fail('MODELING_ONBOARDING_STALE');
    await this.write('conversation-onboarding-publish',{...this.ids(),operationId:this.uuid(),previewId:p.resource_id,previewDigest:p.preview_digest,confirmed:true});await this.afterPublication();
  });}
  recover(){return this.run(async()=>{
    await this.authorize();const p=this.saved.pending;
    if(p?.action==='conversation-onboarding-publish'&&this.saved.setupMode==='update'){
      await this.snapshot();
      const publication=this.state.snapshot?.publication;
      if(publication?.resource_id===p.input.previewId){
        this.accept(p,publication);
        this.saved.pending=null;
        this.persist();
        return;
      }
      if(!this.scopePublicationAllowed){
        this.saved.pending=null;
        this.persist();
        if(this.state.snapshot?.status!=='published')throw fail('MODELING_SCOPE_RULE_CHANGE');
        return;
      }
    }
    if(p){await this.write(p.action,p.input);if(p.action==='conversation-onboarding-publish'){await this.afterPublication();return;}}
    if(this.saved.creation||this.saved.warehouse&&!this.saved.conversationId)await this.continueCreation();else if(this.saved.conversationId)await this.snapshot();
    this.state.loaded=true;await this.maybeStart();
  });}
  newSession(){return this.run(async()=>{if(!this.state.loaded||this.saved.pending||this.generating)throw fail('MODELING_REQUEST_PENDING');await this.authorize();await this.createSession();await this.snapshot();await this.maybeStart();});}
  chooseSession(id){return this.run(async()=>{if(this.saved.pending||this.generating)throw fail('MODELING_REQUEST_PENDING');if(id===this.saved.conversationId)return;await this.authorize();await this.listSessions();if(!this.state.sessions.some(s=>s.id===id))throw fail('MODELING_RESOURCE_NOT_FOUND');this.rememberComposer();this.saved.conversationId=id;this.saved.activeTurn=null;this.saved.preview=null;this.saved.publication=null;this.saved.entryPending=false;this.restoreComposer();this.state.confirmed=false;this.state.page='chat';this.persist();await this.snapshot();await this.maybeStart();});}
  async afterPublication(){
    if(this.saved.setupMode==='update')await this.snapshot();
    else await this.finishPublication(true);
  }
  async finishPublication(requireOwn){
    try { await this.enterCurrent(requireOwn); }
    catch(error){
      if(this.saved.publication&&error.code!=='MODELING_PUBLICATION_REPLACED'&&error.code!=='HOST_SESSION_EXPIRED')
        throw fail('MODELING_PUBLISHED_ENTRY_FAILED');
      throw error;
    }
  }
  enter(){return this.run(()=>this.finishPublication(false));}
  async enterCurrent(requireOwn){await this.authorize();await this.snapshot();const s=this.state.snapshot;if(this.saved.pending||s.status!=='published')throw fail('MODELING_CONFIRMATION_REQUIRED');
    const rules=await this.read('conversation-ontologies',{warehouseId:this.saved.warehouse.id});const active=rules.items?.find(r=>r.status==='published');
    if(!active)throw fail('SEMANTICA_INVALID_RESPONSE');if(requireOwn&&(!s.publication_effective||active.id!==s.publication?.ontology_id))throw fail('MODELING_PUBLICATION_REPLACED');
    await this.onEnter(this.saved.warehouse,{ontology:active,publication:s.publication,view:this.saved.setupMode==='update'?'ontology':'conversation'});
  }
  async poll(){if(!this.live||!this.state.loaded||this.state.pollError||this.polling||!this.saved.conversationId||!this.generating)return;
    const ids=this.ids();this.polling=true;try{const turnId=this.state.snapshot?.active_turn_id||this.saved.activeTurn?.turnId||this.state.turns.find(t=>t.status==='generating')?.resource_id;
      if(turnId)await this.read('conversation-onboarding-turn',{...ids,turnId});
      if(ids.conversationId!==this.saved.conversationId)return;
      await this.snapshot();this.emit();
    }catch(e){if(ids.conversationId===this.saved.conversationId){this.error(e);this.state.pollError=true;this.emit();}}finally{this.polling=false;}}
  dispose(){this.live=false;this.readSequence++;this.state.snapshot=null;this.state.turns=[];this.state.confirmed=false;}
}
