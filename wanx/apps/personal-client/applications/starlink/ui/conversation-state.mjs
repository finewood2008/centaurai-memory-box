import {materialAccessLost} from './native-workbench.js';
import {identityKey} from '../shared/onboarding-contract.mjs';
import {conversationRequest,uploadBinding} from '../shared/conversation-contract.mjs';
import {materialProgress,publicationCurrent,knowledgeCurrent,planCurrent,candidatesReady,materialSourceUsable,retainedMaterialResults} from './conversation-progress.mjs';
import {ConversationChanges} from './conversation-changes.mjs';
import {MaterialInstructions} from './material-instructions.mjs';
import {MaterialEvidence} from './material-evidence.mjs';
import {conversationInputRoute,nextConversationStep,materialQuestion,latestChange} from './conversation-next.mjs';
import {materialIntent,changeTargets} from './material-intent.mjs';
import {validationExclusionRequest,validationSuggestionRequest} from './material-validation-selection.mjs';
import {ConversationIntake} from './conversation-intake.mjs';
import {currentCandidateGraph,readCandidateNetwork} from './conversation-candidate-graph.mjs';
import {applyMaterialContinuation,restoreMaterialContinuation} from './material-continuation.mjs';
import {readWarehouseMaterials,refreshWarehouseMaterial,materialSourceRemoved} from './material-library.mjs';
import {MaterialAgent,materialCommand} from './material-agent.mjs';
import {goalDialogueText} from './material-goal-dialogue.mjs';
import {MaterialImport} from './material-import.mjs';
import {MaterialHistory} from './material-history.mjs';
import {MaterialRounds} from './material-rounds.mjs';
import {currentMaterialWorkflow,publishedMaterial,materialResultContext} from './material-state.mjs';
const copy=v=>structuredClone(v);
const fail=code=>Object.assign(Error(code),{code,status:0});
const active=v=>['queued','running','generating'].includes(v?.status);
export function conversationError(error){
  const code=error?.code||'';
  const messages={
    SEMANTICA_OPERATION_NOT_ALLOWED:'当前 WANX 服务尚未支持此操作，请更新并重启 WANX 后端后重试。材料列表已保留。',
    SEMANTICA_UPGRADE_REQUIRED:'当前服务接口版本不兼容，请更新服务后重试。材料列表已保留。',
    MODELING_ROUND_UPGRADE_REQUIRED:'当前服务尚未提供新一轮对话的关联能力，请升级 Semantica 和 Bridge；可以继续上轮对话。',
    MATERIAL_REEXTRACTION_REVIEW_REQUIRED:'这份草稿对应的抽取结果仍待核对，当前服务不支持直接放弃整轮结果再抽取。草稿已保留，请继续核对；该切换能力需服务端补齐。',
    MODELING_SINGLE_FILE_REQUIRED:'每次只能选择一份材料，请重新选择。',
    MODELING_SOURCE_SAVE_REQUIRED:'正文有尚未保存的修改，请先保存正文，再开始抽取或对话调整。',
    MODELING_LOCAL_SOURCE_ONLY:'正文修改目前只保存在本机。请明确选择使用服务端原文继续，避免按不同正文处理。',
    MODELING_MATERIAL_UNAVAILABLE:'本次材料处理已停止、失败或来源已失效，请选择可用材料后继续。',
    INVALID_RESOURCE:'当前操作参数未被桌面接口接受，尚未提交处理。请重新打开资料管理后重试；若仍失败，请核对 Starlink 与 Bridge 的接口版本。',
    MODELING_INVALID_REQUEST:'当前操作的条目选择或参数不符合接口要求，尚未完成处理。请重新核对选中条目后重试。',
    CORRECTION_ITEM_NOT_FOUND:'所选条目已不属于当前草稿，请重新读取校验结果并选择条目。',
    MODELING_EXCLUSION_TOO_LARGE:'选中条目及其关联关系超过一次保存的 100 项上限。请先分批移除关联关系，再处理实体。草稿尚未修改。',
    MODELING_VALIDATION_SUGGESTION_TOO_LARGE:'每次最多为 8 条问题事实生成修正建议。请勾选需要处理的条目并分批生成。',
    MODELING_MATERIAL_BUSY:'材料有任务正在执行，请等待任务完成或停止后，再重新预览抽取。',
    MODELING_CONTEXT_BUDGET:'本轮对话超出模型上下文预算。请精简内容，或新建会话继续。',
    MODELING_ATTACHMENT_LIMIT:'本会话的材料数量已达到上限，请取消不再使用的材料意图或新建会话。',
    MODELING_TURN_BUSY:'当前问答完成后可继续读取材料。',
    MODELING_SOURCE_NOT_READY:'材料正文尚未就绪，请等待解析完成。',
    MODELING_LOCAL_SAVE_FAILED:'未能保存本机恢复记录，请释放存储空间后重试。',
    MODELING_RESOURCE_NOT_FOUND:'会话或材料已删除，或当前账号无权访问，请重新选择。',
    MODELING_SNAPSHOT_CHANGED:'材料或会话刚刚变化，请重新读取后核对。',
    MODELING_REVIEW_PLAN_CHANGED:'候选合并计划已变化，请重新预览并确认。',
    MODELING_REVIEW_ALREADY_MERGED:'本批候选已合入草稿，请打开材料核对页继续。',
    SEMANTICA_FILE_SELECTION_EXPIRED:'文件选择已失效。请取消未完成的上传位置，再重新选择文件；已提交的材料可从本会话恢复。',
    MODELING_CONFIRMATION_REQUIRED:'请先核对并确认本次材料目标和处理计划。',
    MODELING_REQUEST_PENDING:'上次请求结果尚未确认，请先恢复原请求。',
    MATERIAL_PROCESSING_PREVIEW_EXPIRED:'抽取预览已过期（有效期 5 分钟），请重新预览并确认；材料无需重新上传。',
    MATERIAL_PROCESSING_PREVIEW_STALE:'材料、规则或处理配置已变化，请重新预览后再确认抽取。',
    MATERIAL_PROCESSING_PREVIEW_CONSUMED:'这份预览已经提交，请读取进度恢复原任务，不要重复开始抽取。',
    MATERIAL_PROCESSING_OPERATION_CONFLICT:'原操作号与提交内容不一致，请恢复原请求，或读取处理记录核对。',
    MATERIAL_PROCESSING_ACK_REQUIRED:'请核对本次自动处理的替换影响，再点击确认开始；若摘要缺失，请重新预览。',
    MATERIAL_PROCESSING_GENERATION_STALE:'本次处理已被新的处理轮次替代，请读取最新状态；旧任务不能覆盖当前材料。',
    MATERIAL_REVIEW_REQUIRED:'当前内容受到人工成果保护：未认领的历史草稿请先确认归属，他人私有草稿须由原用户处理；候选已被人工调整时，请继续核对或重新预览自动处理并确认影响，不能直接重试旧任务。',
    MATERIAL_SOURCE_NOT_READY:'材料正文尚未准备好，请读取进度后再继续。',
    SOURCE_CONFIRMATION_REQUIRED:'请先核对并确认当前版本正文，索引就绪后重新预览自动处理。',
    MODELING_INVALID_REQUEST:'请检查填写内容、当前修订及操作参数。',
    MODELING_ONTOLOGY_REQUIRED:'请先读取并核对当前生效本体，沿用规则后再确认处理计划。',
    MODELING_CHANGE_STALE:'目标、规则或草稿已变化，请读取最新状态，核对草稿及提案后继续。',
    MODELING_DRAFT_STALE:'草稿的正文、规则或基础知识已变化。原草稿已保留，请查看草稿中的原因并进入详细材料编辑器处理后继续。',
    CORRECTION_BASE_CHANGED:'已发布知识在此草稿创建后发生变化。请进入详细材料编辑器核对修改记录和当前结果，再处理旧草稿。',
    STALE_DOCUMENT_VERSION:'材料正文版本已更新。请进入详细材料编辑器，将草稿转到当前正文并重新核对来源。',
    ONTOLOGY_TARGET_CHANGED:'本体规则已更新。请进入详细材料编辑器，核对并切换到当前发布规则。',
    MODELING_REVIEW_INVALIDATED:'合入草稿的抽取结果已失效，可能与抽取停止或规则变化有关。请进入详细材料编辑器核对已有内容和来源后处理。',
    MODELING_CHANGE_BUSY:'已有修改提案正在生成，请读取原提案进度。',
    MODELING_CHANGE_INVALID:'修改范围、关系依赖或原文依据不成立，请缩小选择或补充说明。',
    MODELING_CHANGE_CONTEXT_TOO_LARGE:'所选事实或规则超过模型上下文预算，请减少选择或分批修改。',
    MODELING_CHANGE_SCOPE_MISMATCH:'建议包含超出本轮范围的修改，请明确修改对象后重新生成，尚未应用。',
    MODELING_CHANGE_REVIEW_REQUIRED:'请先确认应用或取消本轮修改建议，再核对整份材料的发布变更。',
    INSTRUCTION_PLAN_STALE:'本轮建议的材料、选择或版本已经变化。请取消旧建议后，基于当前内容重新描述要求；已有草稿保留。',
    INSTRUCTION_PLAN_STEP_BLOCKED:'这一步尚不能应用，请核对建议中的问题并补充说明。草稿尚未因此修改。',
    INSTRUCTION_PLAN_INVALID_OUTPUT:'助手未能生成可用的操作计划。请保留原要求，读取本轮建议或重新说明。',
    INSTRUCTION_PLAN_MODEL_FAILED:'识别服务暂未完成，请恢复本轮原请求或稍后重试。',
    INSTRUCTION_PLAN_TIMEOUT:'识别超时，请先恢复原请求确认结果，再继续操作。',
    SOURCE_VERSION_CONFLICT:'正文版本已变化，请重新核对当前正文后确认。',
    SOURCE_NOT_READY:'正文尚未解析完成，请读取最新进度后再确认。',
    SOURCE_CONFIRMATION_STALE:'当前正文的服务端确认已失效，请重新确认正文。',
    SOURCE_OPERATION_CONFLICT:'确认操作与原请求不一致，请读取最新进度后再继续。',
    MODELING_RELATED_SELECTION_TOO_LARGE:'实体及关联关系合计超过本次对话修改的 20 项上限。请减少选中的实体；单个实体仍超过上限时，需要后端支持扩大关联修改范围。当前草稿未修改。',
    MODELING_CHANGE_INVALID_OUTPUT:'模型返回的修改结构无效，本轮未写入草稿。可明确重试生成。',
    MODEL_INVALID_OUTPUT:'模型输出被截断或格式无效，本轮不能应用。请明确重试或缩小修改范围。',
    MODELING_CHANGE_TIMEOUT:'修改提案生成超时，请先恢复原请求或读取原提案。',
    MODELING_CHANGE_MODEL_FAILED:'修改提案模型调用失败，草稿未更新。请检查模型配置后重试。',
    MODELING_CHANGE_RECOVERY_REQUIRED:'原请求涉及私有草稿编辑权。请先恢复草稿并读取提案回执；不会自动换操作号重复处理。',
  };
  if(messages[code])return messages[code];
  if(/CORRECTION_/.test(code))return '材料草稿或编辑权已变化。请在本页读取完整草稿并明确恢复；仍无法处理时使用详细材料编辑器。';
  if(/(?:REVISION|SOURCE|ONTOLOGY|MODEL|GOAL|PLAN|BASE)_CHANGED|STALE/.test(code))return '材料、规则或配置已变化，请重新读取、核对目标与计划后再确认。';
  if(/MODEL_|LLM_NOT_CONFIGURED/.test(code))return '模型调用未完成，请检查“模型与处理”中的模型配置和授权后重试。';
  if(/HOST_SESSION|AUTH|FORBIDDEN/.test(code))return '当前会话或访问权限已失效，请重新登录。';
  return '操作未完成，请读取最新进度。结果未知的提交请恢复原请求。';
}
export function currentReply(turn,overview){
  return turn?.status==='succeeded'&&turn.is_current===true&&turn.content_status==='available'&&
    turn.applicable_to_current===true&&turn.is_historical!==true&&
    turn.input_generation===overview?.input_generation?turn.reply:null;
}
export function sourceReplyUnavailable(value){return ['source_unavailable','source_changed'].includes(value?.content_status);}
export function historicalReply(value){return !sourceReplyUnavailable(value)&&(value?.content_status==='historical'||value?.is_historical===true);}
export function messageReply(message){
  if(message.role!=='assistant')return null;
  if(sourceReplyUnavailable(message)){
    // The server replaces inaccessible content with a source-free notice. Keep
    // only that notice, never cached questions, coverage or suggested actions.
    try{const value=JSON.parse(message.content);if(typeof value?.answer==='string')return {answer:value.answer};}catch{}
    return {answer:'这条答复的来源已失效，请重新读取材料并提问。'};
  }
  if(message.content_status!=='available'&&!historicalReply(message))return {answer:'这条答复的来源已失效，请重新读取材料并提问。'};
  try{const value=JSON.parse(message.content);return value&&typeof value.answer==='string'?value:{answer:'答复格式暂不可展示。'};}catch{return {answer:'答复格式暂不可展示。'};}
}
export class ConversationFlow{
  constructor({call,storage,identity,warehouseId,isCurrent=()=>true,onChange=()=>{},uuid=()=>crypto.randomUUID()}){
    Object.assign(this,{call,storage,identity,warehouseId,isCurrent,onChange,uuid});this.live=true;
    this.key='starlink.conversation.v1.'+identityKey(identity)+'.'+warehouseId;
    this.saved={conversationId:null,pending:null,upload:null,autoRead:{},analyzed:{}};
    this.state={loaded:false,busy:false,error:'',conversations:[],hasMore:false,nextOffset:0,overview:null,messages:[],turn:null,
      intents:[],selectedIntent:null,detail:null,plan:null,candidates:null,merge:null,input:'',goal:'',instructions:'',goalDirty:false,documents:[],
      stage:1,ontology:null,acceptedOntology:null,knowledge:null,materialIndex:{}};
    this.changes=new ConversationChanges(this);
    this.instructions=new MaterialInstructions(this);
    this.evidence=new MaterialEvidence(this);
    this.intake=new ConversationIntake(this);
    this.agent=new MaterialAgent(this);
    this.importer=new MaterialImport(this);
    this.history=new MaterialHistory(this);
    this.rounds=new MaterialRounds(this);
  }
  check(){if(!this.live||!this.isCurrent())throw fail('WAREHOUSE_CHANGED');}
  emit(){if(this.live&&this.isCurrent())this.onChange(this.state);}
  persist(){this.check();try{this.storage.setItem(this.key,JSON.stringify(this.saved));}catch{throw fail('MODELING_LOCAL_SAVE_FAILED');}}
  restore(){try{const value=JSON.parse(this.storage.getItem(this.key)||'null');
    if(value&&typeof value==='object'){
      if(value.pending){if(value.pending.action==='upload'){
        if(value.pending.input?.warehouseId!==this.warehouseId||!uploadBinding(value.pending.input)||typeof value.pending.input.handle!=='string')throw Error();
      }else if(!conversationRequest(value.pending.action,value.pending.input)||value.pending.input.editor)throw Error();}
      this.saved={...this.saved,...value};
      if(this.saved.pending?.input?.warehouseId!==undefined&&this.saved.pending.input.warehouseId!==this.warehouseId)throw Error();
    }
  }catch{this.saved={conversationId:null,pending:null,upload:null,autoRead:{},analyzed:{}};}}
  invalidateContext(sourceUnavailable=false){
    Object.assign(this.state,{plan:null,acceptedOntology:null,candidates:null,candidateGraph:null,merge:null});
    Object.assign(this.changes.state,{context:null,proposals:[],preview:null,publishConfirmed:false,ruleConfirmed:false,source:null});
    if(sourceUnavailable){
      this.changes.resetView();this.changes.owner=null;this.reviewEditor=null;
      this.state.knowledge=null;this.state.recoverable=null;this.intake.source=null;this.intake.range=null;
    }
  }
  async read(action,input={}){this.check();const result=await this.call(action,{...input,warehouseId:this.warehouseId});this.check();
    if(action==='conversation-intents'&&Array.isArray(result.items)){
      // Upgrade recovery for deletions made before sessions were detached.
      // Only a complete, nonempty page containing deleted materials qualifies.
      if(input.conversationId&&(input.offset||0)===0&&!result.has_more&&result.items.length&&result.items.every(i=>i.document_id&&this.saved.deletedDocuments?.[i.document_id])){
        this.saved.deletedMaterialConversations={...this.saved.deletedMaterialConversations,[input.conversationId]:true};this.persist();
      }
      result.items=result.items.filter(i=>!this.saved.deletedDocuments?.[i.document_id]);
    }
    if(action==='conversation-get'&&input.conversationId===this.saved.conversationId&&this.state.overview&&
      this.state.overview.source_stamp!==result.source_stamp){
      // Revoke old controls as soon as a dependency change is known, even if
      // a subsequent message/rules read fails before the snapshot can commit.
      this.invalidateContext();
      if(this.state.turn)this.state.turn={...this.state.turn,is_current:false,applicable_to_current:false};
    }
    // Redaction must also replace an already displayed reply if a later read in
    // this snapshot fails. Never retain a previously cached body on removal.
    if(action==='conversation-messages'&&Array.isArray(result.items)){
      result.items=result.items.map(m=>m.role==='assistant'&&sourceReplyUnavailable(m)?{...m,content:JSON.stringify(messageReply(m)),applicable_to_current:false}:m);
      if(input.conversationId===this.saved.conversationId){
        const restricted=result.items.filter(m=>m.role==='assistant'&&(sourceReplyUnavailable(m)||historicalReply(m)||m.applicable_to_current===false));
        const same=(a,b)=>Number.isSafeInteger(a.sequence)&&a.sequence===b.sequence||a.id&&a.id===b.id;
        const removed=restricted.filter(m=>sourceReplyUnavailable(m));
        const newlyRemoved=removed.some(m=>!this.state.messages.some(old=>same(m,old)&&sourceReplyUnavailable(old)));
        this.state.messages=this.state.messages.map(m=>restricted.find(r=>same(r,m))||m);
        // Messages do not expose their turn IDs. Invalidate the cached detail
        // until it is read again, instead of guessing a source-to-turn mapping.
        if(restricted.length&&this.state.turn)this.state.turn={...this.state.turn,...(removed.length?{reply:undefined}:{}),is_current:false,applicable_to_current:false};
        if(newlyRemoved)this.invalidateContext(true);
      }
    }
    if(action==='conversation-turn'&&sourceReplyUnavailable(result)){
      delete result.reply;
      if(input.conversationId===this.saved.conversationId&&this.state.turn?.id===input.turnId)this.state.turn=result;
    }
    return result;}
  async run(fn,{background=false,allowDeletion=false}={}){
    if(!this.live||!this.isCurrent())return;
    if(this.saved.materialDeletion&&!allowDeletion){if(!background){this.state.error='删除结果尚未确认，请先恢复删除请求。';this.emit();}return;}
    if(this.state.busy){if(!background&&this.backgroundDone){await this.backgroundDone;return this.run(fn,{allowDeletion});}return;}
    let finishBackground;
    if(background)this.backgroundDone=new Promise(resolve=>{finishBackground=resolve;});
    const before=background?JSON.stringify([this.state,this.changes.state,this.importer?.view]):null;
    this.state.busy=true;
    // A successful progress read does not resolve a rejected foreground action.
    if(!background||this.state.errorFromBackground){this.state.error='';this.state.errorCode='';}
    this.state.progressRetryable=false;if(!background)this.emit();
    try{await fn();}catch(e){if(this.live&&this.isCurrent()){
      this.state.error=conversationError(e);this.state.errorCode=e.code;this.state.errorFromBackground=background;
      const safeToRead=this.state.loaded&&!this.saved.pending&&!this.reviewPending&&!this.claimPending&&!this.releasePending&&!this.changes.record.pending&&!this.changes.claimRequest;
      this.state.progressRetryable=safeToRead&&([408,429].includes(e.status)||e.status>=500||background&&e.code==='MODELING_SNAPSHOT_CHANGED'||/^SEMANTICA_(CONNECTION|TIMEOUT|INVALID_RESPONSE)/.test(e.code||''));
      if(this.state.progressRetryable)this.state.error='暂时未能读取最新进度，正在自动重连；不会重复提交任务。';
      this.state.plan=null;this.state.acceptedOntology=null;
      if(materialAccessLost(e)){this.state.loaded=false;this.state.importDocumentId=null;this.clearView();this.state.materialIndex={};this.state.warehouseMaterials=[];this.changes.clear();this.reviewPending=null;this.claimPending=null;this.releasePending=null;}
    }}finally{this.state.busy=false;if(background){this.backgroundDone=null;finishBackground();}if(!background||before!==JSON.stringify([this.state,this.changes.state,this.importer?.view]))this.emit();}}
  async list(append=false){let offset=append?this.state.nextOffset:0;
    for(let page=0;page<200;page++){
      const value=await this.read('conversation-list',{offset,limit:20});
      if(!Array.isArray(value.items))throw fail('SEMANTICA_INVALID_RESPONSE');
      const items=value.items.filter(c=>(!c.scenario||c.scenario==='material')&&!this.saved.deletedMaterialConversations?.[c.id]);
      if(value.has_more&&(!Number.isSafeInteger(value.next_offset)||value.next_offset<=offset))throw fail('SEMANTICA_INVALID_RESPONSE');
      if(items.length||!value.has_more){this.state.conversations=append?[...this.state.conversations,...items]:items;
        this.state.hasMore=value.has_more;this.state.nextOffset=value.next_offset;return;}
      offset=value.next_offset;
    }throw fail('MODELING_MESSAGE_LIMIT');}
  load(){return this.run(async()=>{this.restore();await this.list();
    if(this.saved.conversationId&&!this.state.conversations.some(c=>c.id===this.saved.conversationId)){
      const cached=await this.read('conversation-get',{conversationId:this.saved.conversationId});
      if(cached.scenario==='onboarding'){
        if(this.saved.pending||this.saved.upload)throw fail('MODELING_SCENARIO_MISMATCH');
        this.saved.conversationId=null;this.clearView();this.persist();
      }
    }
    if(!this.saved.conversationId&&!this.saved.pending&&!this.saved.emptyMaterialWorkspace){
      this.saved.conversationId=this.state.conversations.find(c=>c.status==='active')?.id||this.state.conversations[0]?.id||null;
      if(!this.saved.conversationId&&this.state.materialPage!=='import')await this.write('conversation-create',{scenario:'material'},'create');
    }
    await this.snapshot();if(this.saved.conversationId)this.restoreMaterialComposer();this.state.loaded=true;
  });}
  async all(action,input,sequence=false){let offset=0,items=[];
    for(let page=0;page<200;page++){
      const value=await this.read(action,{...input,[sequence?'afterSequence':'offset']:offset,limit:50});
      if(!Array.isArray(value.items))throw fail('SEMANTICA_INVALID_RESPONSE');items.push(...value.items);
      if(!value.has_more)return items;
      const next=sequence?value.next_sequence:value.next_offset;
      if(!Number.isSafeInteger(next)||next<=offset)throw fail('SEMANTICA_INVALID_RESPONSE');offset=next;
    }throw fail('MODELING_MESSAGE_LIMIT');}
  async snapshot(){
    const conversationId=this.saved.conversationId;if(!conversationId){
      this.state.ontology=null;this.state.ontologyError=false;
      try{const rules=await this.read('conversation-ontologies');if(!Array.isArray(rules.items))throw fail('SEMANTICA_INVALID_RESPONSE');this.state.ontology=rules.items.find(o=>o.status==='published')||null;}
      catch(error){this.check();if([401,403,404].includes(error.status))throw error;this.state.ontologyError=true;}
      return;
    }
    for(let attempt=0;attempt<3;attempt++){
      const first=await this.read('conversation-get',{conversationId});
      if(first.scenario&&first.scenario!=='material')throw fail('MODELING_SCENARIO_MISMATCH');
      const messages=await this.all('conversation-messages',{conversationId},true);
      messages.sort((a,b)=>Number.isSafeInteger(a.sequence)&&Number.isSafeInteger(b.sequence)?a.sequence-b.sequence:0);
      const intents=await this.all('conversation-intents',{conversationId});
      if(this.saved.deletedMaterialConversations?.[conversationId]){
        this.saved.conversationId=null;this.saved.emptyMaterialWorkspace=true;
        this.clearView();this.state.conversations=this.state.conversations.filter(c=>c.id!==conversationId);this.persist();await this.snapshot();return;
      }
      const turn=first.latest_turn?.id?await this.read('conversation-turn',{conversationId,turnId:first.latest_turn.id}):null;
      let wanted=this.state.selectedIntent||this.saved.selection?.[conversationId];
      // A goal proposal can commit before the follow-up snapshot succeeds.
      // Recover its persisted handoff on entry, while explicit history navigation
      // (selectedIntent already set) remains on the requested old intent.
      if(!this.state.selectedIntent){
        const visited=new Set();
        while(wanted&&!visited.has(wanted)){
          visited.add(wanted);
          const receipt=this.changes.saved.scopes[JSON.stringify([conversationId,wanted])]?.application;
          const next=receipt?.status==='applied'&&receipt.active_intent_id;
          if(!next||next===wanted||visited.has(next)||!intents.some(i=>i.id===next))break;
          wanted=next;
        }
      }
      const availableIntents=intents.filter(i=>!materialSourceRemoved(i));
      const selected=availableIntents.some(i=>i.id===wanted)?wanted:availableIntents[0]?.id||null;
      const detail=selected?await this.read('conversation-intent',{conversationId,intentId:selected}):null;
      const rules=await this.read('conversation-ontologies');
      if(!Array.isArray(rules.items))throw fail('SEMANTICA_INVALID_RESPONSE');
      const ontology=rules.items.find(o=>o.status==='published')||null;
      const last=await this.read('conversation-get',{conversationId});
      if(first.revision!==last.revision||first.source_stamp!==last.source_stamp||first.input_generation!==last.input_generation||first.latest_turn?.id!==last.latest_turn?.id)continue;
      // Keep the last server-confirmed goal when publishing rules invalidates
      // its applicability. It is restored as a draft, never as confirmation.
      const previousDetail=this.state.detail;
      const confirmed=detail?.goal?.goal?detail:previousDetail?.id===detail?.id&&previousDetail?.document_version_id===detail?.document_version_id?previousDetail:null;
      if(confirmed?.goal?.goal&&confirmed.document_version_id&&(detail?.goal?.goal||this.saved.confirmedGoals?.[confirmed.id]?.versionId!==confirmed.document_version_id)){
        this.saved.confirmedGoals={...this.saved.confirmedGoals,[confirmed.id]:{conversationId,versionId:confirmed.document_version_id,goal:confirmed.goal.goal,instructions:confirmed.goal.instructions||''}};
      }
      if(this.state.overview?.source_stamp!==last.source_stamp||this.state.overview?.revision!==last.revision||this.state.detail?.revision!==detail?.revision||this.state.detail?.document_version_id!==detail?.document_version_id||this.state.detail?.execution?.id!==detail?.execution?.id||this.state.detail?.source_status!==detail?.source_status){this.state.plan=null;this.state.candidates=null;this.state.merge=null;}
      if(this.state.suggestedGoalStamp&&this.state.suggestedGoalStamp!==last.source_stamp){this.state.suggestedGoalStamp=null;this.state.goalReviewNotice='来源或目标已变化。已保留你的输入，请重新核对后确认。';}
      const changedMaterial=selected!==(this.state.detail?.id||null);
      if(changedMaterial||this.state.detail?.status!==detail?.status)this.state.inspectCard=null;
      if(changedMaterial){this.state.reviewingSource=false;this.state.materialOperation=null;this.state.composerContext=null;this.state.messageMode='auto';this.state.inputNotice='';this.state.inputRouting=null;this.state.goalEditing=false;}
      if(changedMaterial){this.state.goalDirty=false;this.state.suggestedGoalStamp=null;this.state.plan=null;this.state.candidates=null;this.state.merge=null;this.state.acceptedOntology=null;this.state.recoverable=null;this.state.goalReviewNotice='';this.reviewEditor=null;}
      const progress=materialProgress(detail),previous=materialProgress(this.state.detail);
      if(changedMaterial||progress.stage!==previous.stage)this.state.stage=progress.stage;
      if(this.state.ontology?.id!==ontology?.id){this.state.acceptedOntology=null;this.state.plan=null;}
      this.state.ontology=ontology;this.state.ontologyError=false;
      if(!knowledgeCurrent(detail,this.state.knowledge))this.state.knowledge=null;
      Object.assign(this.state,{overview:last,messages,intents,turn,selectedIntent:selected,detail});
      if(this.state.candidateGraph&&!currentCandidateGraph(this))this.state.candidateGraph=null;
      this.changes.bind();
      this.saved.selection={...this.saved.selection,[conversationId]:selected};
      if(!this.state.goalDirty){this.state.goal=detail?.goal?.goal||'';this.state.instructions=detail?.goal?.instructions||'';}
      restoreMaterialContinuation(this);
      const remembered=this.saved.confirmedGoals?.[selected];
      if(!this.state.goalDirty&&!this.intake.record?.goalDraft&&detail?.status==='awaiting_goal'&&detail.invalid_reason==='ontology_changed'&&detail.source_status==='available'&&remembered?.conversationId===conversationId&&remembered.versionId===detail.document_version_id){
        Object.assign(this.state,{goal:remembered.goal,instructions:remembered.instructions,goalDirty:true,suggestedGoalStamp:null,
          goalReviewNotice:'本体规则已更新。已保留先前确认的目标和补充说明，请重新核对并确认，再读取处理计划。'});
        this.intake.saveGoalDraft();
      }
      // Resolve publication/draft state before interpreting a reply as a goal.
      if(this.state.materialPage==='dialogue')await this.agent.syncDialogue();
      const suggestion=currentReply(turn,last);
      const goalRecord=this.intake.record;
      const goalReply=this.intake.goalStage&&goalRecord.goalTurnId===turn?.id;
      const goalReceipt=JSON.stringify([turn?.id,turn?.input_generation,suggestion?.goal_summary]);
      if(goalReply&&suggestion?.goal_summary?.trim()&&goalRecord.goalSummaryReceipt!==goalReceipt&&
        (intents.length===1||suggestion.coverage?.some(c=>c.document_id===detail?.document_id||c.document_version_id===detail?.document_version_id))){
        this.state.goal=suggestion.goal_summary.trim();this.state.goalDirty=true;this.state.suggestedGoalStamp=last.source_stamp;this.state.goalReviewNotice='';
        if(goalRecord.goalReplyFullSummary)this.state.instructions='';
        else if(!this.state.instructions&&!detail?.goal?.goal&&!Object.hasOwn(goalRecord.goalDraft||{},'instructions'))this.state.instructions=goalRecord.note||'';
        goalRecord.goalSummaryReceipt=goalReceipt;this.intake.saveGoalDraft();
      }else if(!materialResultContext(this)&&!detail?.goal?.goal&&!this.state.goalDirty&&!goalRecord?.goalDraft&&suggestion?.goal_summary&&(!goalRecord||goalReply)&&
        (intents.length===1||suggestion.coverage?.some(c=>c.document_id===detail?.document_id))){
        this.state.goal=suggestion.goal_summary;this.state.goalDirty=true;this.state.suggestedGoalStamp=last.source_stamp;
      }
      this.rounds.sync();this.persist();
      if(publicationCurrent(detail)&&materialSourceUsable(detail)&&!this.state.knowledge)await this.readPublished();
      await this.intake.sync();
      await this.agent.sync();
      if((this.intake.sourceReviewed||retainedMaterialResults(detail))&&candidatesReady(detail)&&!detail.review?.draft_id&&!this.state.candidates)await this.readCandidates();
      return;
    }
    this.state.plan=null;this.state.merge=null;this.state.messages=[];this.state.turn=null;throw fail('MODELING_SNAPSHOT_CHANGED');
  }
  async readMaterialIndex(){
    this.state.materialIndexError=false;
    try{await readWarehouseMaterials(this);}catch(e){this.check();if([401,403].includes(e.status))throw e;this.state.warehouseMaterialError=true;}
    if(!this.state.hasMore){const available=new Set(this.state.conversations.map(c=>c.id));for(const id of Object.keys(this.state.materialIndex))if(!available.has(id)&&id!==this.saved.conversationId)delete this.state.materialIndex[id];}
    for(const c of this.state.conversations){
      if(c.id===this.saved.conversationId){this.state.materialIndex[c.id]=copy(this.state.intents);continue;}
      try{this.state.materialIndex[c.id]=await this.all('conversation-intents',{conversationId:c.id});}
      catch(e){this.check();if([401,403].includes(e.status))throw e;if(e.status===404)delete this.state.materialIndex[c.id];else this.state.materialIndexError=true;}
    }
  }
  materials(more=false){return this.run(async()=>{if(more)await this.list(true);await this.readMaterialIndex();});}
  rememberMaterialComposer(){if(!this.saved.conversationId)return;const s=this.state;
    this.evidence?.syncInput();
    this.saved.materialComposers={...this.saved.materialComposers,[this.saved.conversationId+':'+(s.selectedIntent||'')]:{input:s.input,goal:s.goal,instructions:s.instructions,goalDirty:s.goalDirty,versionId:s.detail?.document_version_id,messageMode:s.messageMode,composerContext:s.composerContext,sourceFragment:this.evidence?.composerFragment()}};this.persist();
  }
  saveMaterialComposer(){try{this.rememberMaterialComposer();}catch{this.state.error='输入暂未保存，请检查本机存储空间。';this.emit();}}
  restoreMaterialComposer(){const s=this.state,c=this.saved.materialComposers?.[this.saved.conversationId+':'+(s.selectedIntent||'')];if(!c)return;
    if(s.detail&&(s.detail.source_status!=='available'||c.versionId!==s.detail.document_version_id))return;
    Object.assign(s,{input:c.input||'',messageMode:c.messageMode||'auto',composerContext:c.composerContext||null});
    if(c.goalDirty&&c.versionId===s.detail?.document_version_id)Object.assign(s,{goal:c.goal,instructions:c.instructions,goalDirty:true});
  }
  selectMaterial(conversationId,intentId=null){return this.run(async()=>{
    if(this.saved.deletedMaterialConversations?.[conversationId])throw fail('MODELING_MATERIAL_UNAVAILABLE');
    if(this.intake.staged||this.saved.intakeSubmission||this.saved.roundOpening||this.saved.pending||this.saved.upload||this.reviewPending||this.claimPending||this.releasePending||this.changes.record.pending||this.changes.claimRequest)throw fail('MODELING_REQUEST_PENDING');
    const newSession=conversationId!==this.saved.conversationId;
    delete this.saved.libraryDocumentId;this.persist();
    // Clicking the active row must not restore an older composer or discard a plan.
    if(!newSession&&this.state.loaded&&(!intentId||intentId===this.state.selectedIntent)){this.state.librarySelection=null;return;}
    this.state.librarySelection=null;
    this.rememberMaterialComposer();this.state.materialIndex[this.saved.conversationId]=copy(this.state.intents);
    this.saved.conversationId=conversationId;delete this.saved.emptyMaterialWorkspace;this.clearView();this.state.loaded=false;
    if(intentId)this.state.selectedIntent=intentId;
    this.persist();await this.snapshot();this.restoreMaterialComposer();this.state.stage=materialProgress(this.state.detail).stage;this.state.loaded=true;
  });}
  refresh(){return this.run(async()=>{const restoring=!this.state.loaded;await this.list();await this.snapshot();if(restoring)this.restoreMaterialComposer();this.state.loaded=true;await this.readMaterialIndex();});}
  more(){return this.run(()=>this.list(true));}
  select(conversationId){return this.selectMaterial(conversationId);}
  clearView(){this.rounds?.clear();this.history?.clear();if(this.importer)this.importer.view=null;this.state.openMaterialEditor=false;this.state.openDetailedEditor=false;this.intake.clear();this.changes.clear();this.reviewEditor=null;Object.assign(this.state,{dialogueWorkflow:null,dialogueKnowledge:null,dialogueFailureJob:null,baselinePage:0,automaticResultPage:0,autoSwitch:false,materialSwitchProposal:null,materialOperation:null,librarySelection:null,overview:null,messages:[],turn:null,intents:[],detail:null,selectedIntent:null,plan:null,candidates:null,merge:null,input:'',goal:'',instructions:'',goalDirty:false,suggestedGoalStamp:null,goalReviewNotice:'',recoverable:null,stage:1,ontology:null,acceptedOntology:null,knowledge:null,inspectCard:null,composerContext:null,inputNotice:'',inputRouting:null,goalEditing:false,messageMode:'auto',readWaiting:false});}
  create(){return this.run(async()=>{if(this.intake.staged||this.saved.intakeSubmission||this.saved.pending||this.saved.upload||this.reviewPending||this.claimPending||this.releasePending||this.changes.record.pending||this.changes.claimRequest)throw fail('MODELING_REQUEST_PENDING');
    await this.write('conversation-create',{scenario:'material'},'create');this.clearView();await this.list();await this.snapshot();this.state.loaded=true;});}
  apply(p,result){
    this.agent.apply(p,result);
    this.importer.apply(p,result);
    if(p.kind==='material-continue')applyMaterialContinuation(this,p,result);
    if(['conversation-analyze','conversation-send','conversation-goal'].includes(p.action)||p.kind==='intake-goal-turn')this.state.readWaiting=false;
    if(p.kind==='intake-create'){if(!result.resource_id)throw fail('SEMANTICA_INVALID_RESPONSE');if(this.saved.conversationId)this.state.materialIndex[this.saved.conversationId]=copy(this.state.intents);this.saved.conversationId=result.resource_id;delete this.saved.emptyMaterialWorkspace;this.saved.intakeSubmission.conversationId=result.resource_id;this.saved.intakeSubmission.needsConversation=false;this.clearView();}
    if(p.kind==='create'){if(!result.resource_id)throw fail('SEMANTICA_INVALID_RESPONSE');this.saved.conversationId=result.resource_id;delete this.saved.emptyMaterialWorkspace;}
    if(p.kind==='upload-intent'){
      if(!result.resource_id||!Number.isSafeInteger(result.revision))throw fail('SEMANTICA_INVALID_RESPONSE');
      this.saved.upload={...this.saved.upload,intentId:result.resource_id,revision:result.revision};
      this.saved.autoRead[result.resource_id]=true;this.state.selectedIntent=result.resource_id;
      if(this.saved.upload.intake)this.intake.register(result.resource_id,this.saved.upload);
    }
    if(p.kind==='intake-link'){
      if(!result.resource_id)throw fail('SEMANTICA_INVALID_RESPONSE');
      this.state.importDocumentId=p.input.documentId;
      this.intake.register(result.resource_id,this.saved.intakeSubmission);this.saved.intakeSubmission=null;
    }
    if(p.kind==='link'){if(!result.resource_id)throw fail('SEMANTICA_INVALID_RESPONSE');this.saved.autoRead[result.resource_id]=true;this.state.selectedIntent=result.resource_id;}
    if(p.kind==='upload'){if(!result.document?.id)throw fail('SEMANTICA_INVALID_RESPONSE');this.state.importDocumentId=result.document.id;this.state.selectedIntent=p.input.intentId;this.saved.upload=null;}
    if(p.kind==='intake-goal-turn'||p.action==='conversation-turn-retry'&&this.intake.goalStage){
      const r=this.saved.intakeReviews?.[p.intakeId||this.state.selectedIntent];
      if(r){r.goalTurnId=result.turn_id;r.goalNeedsConfirmation=true;if(p.action==='conversation-send'){r.goalReplyPending=true;r.goalReplyFullSummary=goalDialogueText(p.input.content)!==p.input.content;}}
    }
    if(p.action==='conversation-goal'){
      if(p.goalVersionId)this.saved.confirmedGoals={...this.saved.confirmedGoals,[p.input.intentId]:{conversationId:p.input.conversationId,versionId:p.goalVersionId,goal:p.input.goal,instructions:p.input.instructions||''}};
      const r=this.saved.intakeReviews?.[p.input.intentId];if(r){
        const draft=r.goalDraft;
        const newer=draft&&(draft.goal!==p.input.goal||(draft.instructions??'')!==(p.input.instructions??''));
        r.goalNeedsConfirmation=!!newer;
        if(!newer)delete r.goalDraft;
        else if(this.state.selectedIntent===p.input.intentId)this.state.goalReviewNotice='先前提交的目标已保存；你随后填写的修改仍是草稿，需要再次确认。';
      }
    }
    if(p.action==='conversation-send'&&this.state.input===goalDialogueText(p.input.content)){this.state.input='';this.changes.state.evidenceReference=null;}
    const composer=this.saved.materialComposers?.[p.input.conversationId+':'+(p.composerIntentId||p.input.intentId||'')];
    if(composer&&p.action==='conversation-send'&&composer.input===goalDialogueText(p.input.content)){composer.input='';delete composer.sourceFragment;}
    if(composer&&p.action==='conversation-goal'&&composer.goal===p.input.goal&&composer.instructions===(p.input.instructions||''))composer.goalDirty=false;
    if(p.action==='conversation-goal'&&this.state.goal===p.input.goal&&this.state.instructions===(p.input.instructions||'')){
      this.state.goalDirty=false;this.state.suggestedGoalStamp=null;this.state.goalReviewNotice='';
    }
  }
  async write(action,input={},kind='write'){
    if(this.saved.roundOpening&&!this.saved.pending)throw fail('MODELING_REQUEST_PENDING');
    if(!this.saved.pending){
      const body={...input,warehouseId:this.warehouseId,...(action==='upload'?{}:{operationId:this.uuid()})};
      if(action!=='upload')conversationRequest(action,body);
      this.saved.pending={action,input:body,kind,...(action==='conversation-send'?{composerIntentId:this.state.selectedIntent}:{}),...(kind==='intake-goal-turn'?{intakeId:this.state.selectedIntent}:{}),...(action==='conversation-goal'?{goalVersionId:this.state.detail?.document_version_id}:{})};
    }else if(this.saved.pending.action!==action)throw fail('MODELING_REQUEST_PENDING');
    this.rounds.touch(action);this.persist();const p=copy(this.saved.pending);
    let result;
    try{result=await this.read(p.action,p.input);}catch(e){
      if(p.action==='upload'&&e.code==='SEMANTICA_FILE_SELECTION_EXPIRED'){
        const intent=await this.read('conversation-intent',{conversationId:p.input.conversationId,intentId:p.input.intentId});
        this.saved.pending=null;
        if(intent.document_id)this.saved.upload=null;
        this.persist();if(intent.document_id)return {document:{id:intent.document_id}};
      }
      // Only explicit precondition refusals end this attempt; network/5xx retain the exact envelope.
      if([400,401,403,404,409,422].includes(e.status)){
        this.saved.pending=null;
        if(p.action==='conversation-processing-confirm'&&['MATERIAL_PROCESSING_PREVIEW_EXPIRED','MATERIAL_PROCESSING_PREVIEW_STALE','MATERIAL_PROCESSING_PREVIEW_CONSUMED'].includes(e.code)){
          const record=this.saved.materialOperations?.[p.input.documentId];if(record?.preview?.preview_id===p.input.previewId)record.previewError=e.code;
        }
        this.persist();
      }
      throw e;
    }
    const before=copy(this.saved);this.apply(p,result);this.saved.pending=null;
    try{this.persist();}catch(e){this.saved=before;throw e;}return result;
  }
  async retryPending(){await this.run(async()=>{const p=this.saved.pending;if(!p)return;
    if(p.input.editor){throw fail('CORRECTION_LEASE_EXPIRED');}
    if(p.action==='conversation-analyze'||p.kind==='intake-goal-turn')await this.initialRead(p.action,p.input,p.kind);
    else await this.write(p.action,p.input,p.kind);
    await this.continueUploads();await this.snapshot();this.state.loaded=true;
    if(['conversation-source-confirm','conversation-index-retry'].includes(p.action)&&this.state.materialPage==='import')await this.importer.read(p.input.documentId);
  });
    if(!this.state.error&&!this.saved.pending){
      if(this.saved.intakeSubmission?.newRound)await this.intake.submit();
      else await this.rounds.finish();
    }
  }
  async ready(){if(this.saved.roundOpening||this.saved.pending||this.reviewPending||this.claimPending||this.releasePending||this.changes.pending||this.changes.record.pending||this.changes.claimRequest)throw fail('MODELING_REQUEST_PENDING');if(!this.state.loaded)throw fail('MODELING_SNAPSHOT_CHANGED');await this.snapshot();}
  async submitInput(){
    if(this.state.busy){if(this.backgroundDone){await this.backgroundDone;return this.submitInput();}return;}
    if(this.intake.staged||this.saved.intakeSubmission)return this.intake.submit();
    if(this.saved.emptyMaterialWorkspace){this.state.inputNotice='请先上传或选择材料，再开始新的对话。';this.emit();return;}
    this.evidence.syncInput();
    // The selected source is data. Question/edit vocabulary inside that quote
    // must not select a different UI operation from the user's own request.
    const routingText=this.evidence.displayedReference?this.evidence.withoutReference(this.state.input):this.state.input;
    if(this.evidence.displayedReference&&!routingText.trim()){
      this.state.inputNotice='请补充你想了解或调整的内容。只引用原文不会执行其中的要求。';this.emit();return;
    }
    const command=this.state.messageMode==='question'?null:materialCommand(this.state.input);
    if(command&&this.instructions.open){
      if(command==='apply-change'&&this.instructions.plan?.status==='ready'&&this.instructions.step?.kind==='change'&&this.instructions.step.status==='prepared'){
        const text=this.state.input;await this.instructions.confirm();
        if(!this.state.error&&this.state.input===text){this.state.input='';this.saveMaterialComposer();this.emit();}return;
      }
      this.state.inputNotice='请先核对或取消当前建议；“下一步”不会直接应用修改、启动抽取或发布。';this.emit();return;
    }
    if(command)return this.agent.command(command);
    if(this.intake.unavailable){
      if(this.agent.record.sourceSaved||this.agent.current?.current?.is_current){
        const text=this.state.input;await this.agent.dialogue();
        if(!this.state.error){this.state.input=text;return this.send();}return;
      }
      return this.run(async()=>{throw fail('MODELING_MATERIAL_UNAVAILABLE');});
    }
    if(this.state.messageMode==='question'||materialQuestion(routingText)){this.state.inputRouting=null;this.state.inputNotice='';return this.send();}
    if(validationSuggestionRequest(routingText))return this.changes.adjustIssues({suggest:true,all:!this.changes.state.issueSelection?.length,input:this.state.input});
    const issueRequest=validationExclusionRequest(routingText);
    if(issueRequest)return this.changes.adjustIssues({exclude:true,all:!issueRequest.selected,count:issueRequest.count,input:this.state.input});
    if(conversationInputRoute(routingText,this)==='confirmation'){
      this.state.inputNotice='请核对当前操作卡片后点击确认按钮；这条消息不会直接开始抽取或发布。';this.emit();return;
    }
    const previous=latestChange(this),intent=materialIntent(routingText,{
      context:this.state.composerContext,
      clarification:(previous?.status==='needs_clarification'||previous?.status==='prepared'&&this.changes.record.changeTarget==='facts')&&previous.id!==this.changes.record.deferredProposal?this.changes.record.proposalTargets?.[previous.id]||this.changes.record.changeTarget||'facts':null,
      goalStage:this.intake.goalStage,selected:!!this.changes.state.selected.length
    });
    // Free text in the material review workspace is interpreted by Semantica,
    // including statements without an edit verb (e.g. “这个是产品名称”).
    // Explicit questions and the initial source/goal dialogue retain their paths.
    const legacyPending=previous&&previous.id!==this.changes.record.deferredProposal&&['prepared','needs_clarification','generating'].includes(previous.status);
    const reviewingFacts=this.changes.state.summary?.status==='editing';
    const reviewingMaterial=reviewingFacts||!!this.state.detail?.execution||publishedMaterial(currentMaterialWorkflow(this));
    const factsNeedEntry=intent.kind==='change'&&intent.target==='facts'&&(!reviewingFacts||!this.changes.state.selected.length);
    const processing=['queued','running'].includes(this.state.detail?.status)||['queued','running','generating'].includes(this.state.turn?.status);
    if(this.instructions.open&&!processing)return this.instructions.submit(['goal','rules'].includes(intent.target)?intent.target:null);
    if(!legacyPending&&!factsNeedEntry&&!processing&&!['source','goal','rules'].includes(intent.target)&&!['goal','rules'].includes(this.state.composerContext)&&this.state.detail?.document_version_id&&(reviewingMaterial||this.instructions.open)&&(!this.intake.record||this.intake.sourceReviewed&&!this.intake.goalStage||this.instructions.open)){
      return this.instructions.submit(['goal','rules'].includes(intent.target)?intent.target:['goal','rules'].includes(this.state.composerContext)?this.state.composerContext:null);
    }
    if(['clarify','compound','scope'].includes(intent.kind)){
      this.state.inputNotice=intent.kind==='scope'?'本页只能调整当前材料或当前仓库本体，不能直接执行跨材料或跨仓操作。请明确当前范围，原话已保留，本轮尚未执行。':intent.kind==='compound'?'这条要求包含多个操作。请先单独确认修改：目标调整后发送“下一步”，按新目标核对对话抽取计划；本体调整需发布后再重新预览抽取。自动抽取不会沿用聊天目标。原话已保留，本轮尚未执行。':'请明确修改对象：仓库本体规则、本材料整理目标、实体关系或正文。原话已保留，选择范围后可继续补充并发送。';
      this.state.inputRouting=intent.kind;this.emit();return;
    }
    this.state.inputRouting=null;
    if(intent.kind==='change'&&intent.target==='source'){
      const original=this.state.input;await this.agent.command('source');this.state.input=original;
      if(!this.state.error&&this.state.reviewingSource)this.state.inputNotice='已打开正文核对。请在正文中修改并保存；这条要求不会被当作抽取目标。';this.saveMaterialComposer();this.emit();return;
    }
    if(intent.kind==='change'){
      // Do not alter the composer or target of an unresolved original request.
      try{this.changes.setTarget(intent.target);}catch(error){return this.run(async()=>{throw error;});}
      this.state.composerContext=intent.target;
    }
    if(this.intake.record){
      if(this.intake.goalStage&&this.state.messageMode!=='change'&&!['rules','facts','proposal'].includes(this.state.composerContext)&&!['proposal','rules'].includes(nextConversationStep(this))){
        return this.intake.discuss();
      }
      if(!this.intake.sourceReviewed)return this.send();
    }
    const content=this.state.input,route=intent.kind==='change'?'change':'question';
    this.state.inspectCard=null;this.state.inputNotice='';
    if(route==='change'){
      if(publishedMaterial(currentMaterialWorkflow(this))&&this.changes.state.summary?.status!=='editing'&&!['goal','rules'].includes(this.state.composerContext)){
        this.state.inputNotice='修改要求已保留。请先选择要修改的事实，再发送生成差异；已有发布知识继续有效。';
        await this.changes.editMaterial();return;
      }
      if(!this.changes.independent&&(this.changes.record.draftId||this.state.detail?.review?.draft_id)&&!this.changes.state.summary){
        this.state.inputNotice='修改要求已保留。请先继续核对这份材料；如需接管编辑，请在当前页面确认后再次发送。';
        await this.changes.openDraft();return;
      }
      if(candidatesReady(this.state.detail)&&(!this.changes.state.summary||this.changes.record.previousIntent&&!this.state.detail.review?.draft_id)&&!['rules','goal','proposal'].includes(this.state.composerContext)){
        this.state.inputNotice='修改要求已保留。请先核对候选合入草稿的差异；确认后选中要修改的事实，再发送本轮要求。';
        await this.beginEdit();return;
      }
      if(this.state.composerContext==='facts'&&!this.changes.state.selected.length){this.state.inputNotice='请先选中要修正或排除的事实，再发送修改要求。';this.emit();return;}
      const context={goal:'请调整当前材料的整理目标：',rules:'请调整当前材料适用的本体规则：',facts:'请调整选中的材料事实：'}[this.state.composerContext]||'';
      this.state.inputNotice=`本轮范围：${changeTargets[this.state.composerContext]||'当前修改建议'}。先生成修改预览，确认应用后才保存；不会自动发布或抽取。`;
      await this.changes.generate(context+content,{composerInput:content});
      if(!this.state.error&&!this.changes.record.pending){if(this.state.input===content)this.state.input='';this.state.composerContext=null;this.state.messageMode='auto';this.saveMaterialComposer();this.emit();}
    }else await this.send();
  }
  send(){return this.run(async()=>{const content=this.state.input;await this.ready();
    if(active(this.state.turn))throw fail('MODELING_TURN_BUSY');
    await this.write('conversation-send',{conversationId:this.saved.conversationId,revision:this.state.overview.revision,content});await this.snapshot();});}
  turnAction(action){return this.run(async()=>{await this.ready();
    if(action==='retry'&&this.intake.unavailable)throw fail('MODELING_MATERIAL_UNAVAILABLE');
    await this.write('conversation-turn-'+action,{conversationId:this.saved.conversationId,turnId:this.state.turn.id,revision:this.state.overview.revision});await this.snapshot();});}
  chooseIntent(id){return this.selectMaterial(this.saved.conversationId,id);}
  attachFiles(){return this.run(async()=>{await this.ready();if(this.saved.upload)throw fail('MODELING_REQUEST_PENDING');
    const files=await this.read('select-files');
    this.saved.uploadQueue=files.map(file=>({handle:file.handle,name:file.name,conversationId:this.saved.conversationId}));this.persist();
    await this.continueUploads();
  });}
  async continueUploads(){while(this.saved.upload||this.saved.uploadQueue?.length){
    if(!this.saved.upload){this.saved.upload=this.saved.uploadQueue.shift();this.persist();}
    await this.continueUpload();await this.snapshot();
  }}
  async continueUpload(){
    const upload=this.saved.upload;if(!upload)return;
    if(!upload.intentId){await this.snapshot();await this.write('conversation-intent-create',{
      conversationId:upload.conversationId,revision:this.state.overview.revision},'upload-intent');}
    const current=this.saved.upload;
    await this.write('upload',{handle:current.handle,conversationId:current.conversationId,intentId:current.intentId,expectedIntentRevision:current.revision},'upload');
  }
  resumeUpload(){return this.run(async()=>{if(this.saved.pending)throw fail('MODELING_REQUEST_PENDING');await this.continueUploads();await this.snapshot();});}
  abandonUpload(){return this.run(async()=>{
    if(this.saved.pending)throw fail('MODELING_REQUEST_PENDING');const upload=this.saved.upload;if(!upload)return;
    if(upload.intentId){const detail=await this.read('conversation-intent',{conversationId:upload.conversationId,intentId:upload.intentId});
      if(detail.document_id){this.saved.upload=null;this.persist();await this.snapshot();return;}
      await this.write('conversation-cancel',{conversationId:upload.conversationId,intentId:upload.intentId,revision:detail.revision});}
    this.saved.upload=null;this.saved.uploadQueue=[];this.persist();await this.snapshot();
  });}
  listDocuments(offset=0){return this.run(async()=>{const value=await this.read('documents',{limit:50,offset});
    this.state.documents=offset?[...this.state.documents,...value.items]:value.items;this.state.documentOffset=offset+value.items.length;this.state.documentMore=this.state.documentOffset<value.total;});}
  link(documentId){return this.run(async()=>{await this.ready();
    await this.write('conversation-intent-create',{conversationId:this.saved.conversationId,revision:this.state.overview.revision,documentId},'link');
    this.state.documents=[];await this.snapshot();});}
  async initialRead(action,input,kind='write'){
    if(active(this.state.turn)&&!this.saved.pending){this.state.readWaiting=true;return false;}
    try{await this.write(action,input,kind);return true;}
    catch(e){
      if(e.status!==409||e.code!=='MODELING_TURN_BUSY')throw e;
      // This is a rejected *new* read, not a failure of the active turn. The
      // caller refreshes its receipt and the normal progress loop follows it.
      this.state.readWaiting=true;return false;
    }
  }
  async analyzeIntent(detail){const key=detail.id+':'+detail.document_version_id;
    this.saved.analyzed[key]=true;this.persist();
    const accepted=await this.initialRead('conversation-analyze',{conversationId:this.saved.conversationId,intentId:detail.id,documentVersionId:detail.document_version_id});
    if(!accepted){delete this.saved.analyzed[key];this.saved.autoRead[detail.id]=false;this.persist();}
    await this.snapshot();}
  analyze(){return this.run(async()=>{await this.ready();await this.analyzeIntent(this.state.detail);});}
  async tick(){if(!this.live||!this.isCurrent()||!this.state.loaded||this.state.busy||this.state.error&&this.state.errorFromBackground&&!this.state.progressRetryable||this.saved.pending||this.reviewPending||this.claimPending||this.releasePending||this.changes.record.pending||this.changes.claimRequest)return;
    if(this.state.librarySelection){
      if(Date.now()-(this.state.libraryPolledAt||0)<5000)return;
      this.state.libraryPolledAt=Date.now();
      await this.run(async()=>{await refreshWarehouseMaterial(this);await this.agent.sync();},{background:true});return;
    }
    if(this.intake.needsMore){
      await this.run(async()=>{for(let n=0;n<4&&this.intake.needsMore;n++){await this.intake.loadMore();this.emit();}},{background:true});
      if(!this.state.error&&this.intake.complete&&this.intake.goalStage&&!this.intake.record.goalTurnId&&this.saved.autoRead[this.state.selectedIntent])await this.intake.startGoal();
      this.emit();return;
    }
    const reading=!this.state.input.trim()&&!this.state.goalDirty&&!this.saved.upload&&this.state.intents.some(i=>this.saved.autoRead[i.id]&&i.status==='awaiting_goal'&&i.document_version_id&&!this.saved.analyzed[i.id+':'+i.document_version_id]);
    const automatic=this.agent.record.transitionId&&(!this.agent.current||this.agent.current.current?.is_current===true&&['queued','running','publishing'].includes(this.agent.current.current?.stage));
    const processing=automatic||active(this.state.turn)||[...this.state.intents,this.state.detail].filter(Boolean).some(i=>['parsing','queued','running'].includes(i.status)||active(i.execution)||active(i.outcome?.publication));
    if(!reading&&!processing&&!this.state.progressRetryable)return;
    await this.run(async()=>{await this.snapshot();
      if(this.state.input.trim()||active(this.state.turn)||this.state.goalDirty||this.saved.upload)return;
      const item=this.state.intents.find(i=>this.saved.autoRead[i.id]&&i.status==='awaiting_goal'&&i.document_version_id&&!this.saved.analyzed[i.id+':'+i.document_version_id]);
      if(item)await this.analyzeIntent(item);
    },{background:true});}
  goal(){return this.run(async()=>{const goal=this.state.goal,instructions=this.state.instructions,stamp=this.state.suggestedGoalStamp;
    const displayed={id:this.state.detail?.id,revision:this.state.detail?.revision,conversation:this.state.overview?.revision};
    await this.ready();const d=this.state.detail;
    if(active(this.state.turn)||this.intake.record&&(!this.intake.goalStage||this.intake.record.goalReplyPending))throw fail('MODELING_CONFIRMATION_REQUIRED');
    if(d?.id!==displayed.id||d.revision!==displayed.revision||this.state.overview.revision!==displayed.conversation)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(stamp&&stamp!==this.state.overview.source_stamp)throw fail('MODELING_SOURCE_CHANGED');
    if(this.state.goal===goal&&this.state.instructions===instructions)this.intake.saveGoalDraft();
    await this.write('conversation-goal',{conversationId:this.saved.conversationId,intentId:d.id,revision:d.revision,
      conversationRevision:this.state.overview.revision,goal,instructions,confirmed:true});await this.snapshot();
    this.state.stage=2;this.state.inspectCard=null;this.state.goalEditing=false;this.state.acceptedOntology=null;this.state.plan=null;});}
  goStage(stage){return this.run(async()=>{await this.ready();this.state.stage=stage;this.state.inspectCard={1:'goal',2:'plan',3:'candidates'}[stage];});}
  preview(){return this.run(async()=>{const displayed=this.state.ontology?.id;await this.ready();
    if(this.state.goalDirty||this.intake.record?.goalNeedsConfirmation||active(this.state.turn))throw fail('MODELING_CONFIRMATION_REQUIRED');
    if(!displayed||this.state.ontology?.id!==displayed)throw fail('MODELING_ONTOLOGY_CHANGED');
    const plan=await this.read('conversation-plan',{conversationId:this.saved.conversationId,intentId:this.state.detail.id});
    if(!planCurrent(plan,this.state.overview,this.state.detail,this.state.ontology))throw fail('MODELING_PLAN_CHANGED');
    this.state.acceptedOntology=displayed;this.state.plan=plan;this.state.stage=2;this.state.inspectCard=null;});}
  confirmPlan(){return this.run(async()=>{const plan=this.state.plan;if(!plan)throw fail('MODELING_PLAN_CHANGED');
    if(this.state.goalDirty||this.intake.record?.goalNeedsConfirmation||active(this.state.turn)||this.state.acceptedOntology!==plan.ontology_id||!planCurrent(plan,this.state.overview,this.state.detail,this.state.ontology))throw fail('MODELING_ONTOLOGY_REQUIRED');
    // Submit exactly the plan displayed and explicitly confirmed; never silently replace its digest.
    await this.write('conversation-confirm',{conversationId:this.saved.conversationId,intentId:plan.intent_id,revision:plan.revision,
      conversationRevision:plan.conversation_revision,planDigest:plan.plan_digest,confirmed:true});this.state.plan=null;await this.snapshot();this.state.stage=3;});}
  async readPublished(){
    const d=this.state.detail;if(!publicationCurrent(d))return;
    const value=await this.read('conversation-published-run',{runId:d.outcome.current_run_id});
    const latest=await this.read('conversation-intent',{conversationId:this.saved.conversationId,intentId:d.id});
    this.state.detail=latest;
    if(!knowledgeCurrent(latest,value)){this.state.knowledge=null;throw fail('MODELING_SNAPSHOT_CHANGED');}
    this.state.knowledge=value;
  }
  intentAction(action){return this.run(async()=>{await this.ready();const d=this.state.detail;
    await this.write('conversation-'+action,{conversationId:this.saved.conversationId,intentId:d.id,revision:d.revision});await this.snapshot();});}
  async readCandidates(offset=0){
    const d=this.state.detail,conversationId=this.saved.conversationId;
    if(!candidatesReady(d))throw fail('MODELING_CANDIDATES_NOT_READY');
    const value=await this.read('conversation-candidates',{conversationId,intentId:d.id,offset,limit:20});
    const latest=await this.read('conversation-intent',{conversationId,intentId:d.id});
    if(!candidatesReady(latest)||latest.revision!==d.revision||latest.document_version_id!==d.document_version_id||latest.execution?.id!==d.execution?.id||value.execution_id!==d.execution?.id){this.state.candidates=null;throw fail('MODELING_SNAPSHOT_CHANGED');}
    this.state.candidates=value;
  }
  candidates(offset=0){return this.run(async()=>{await this.ready();await this.readCandidates(offset);});}
  showCandidateGraph(){return this.run(async()=>{
    await this.ready();
    if(!currentCandidateGraph(this)){
      this.state.candidateGraphLoading=true;this.emit();
      try{this.state.candidateGraph=await readCandidateNetwork(this);}finally{this.state.candidateGraphLoading=false;}
    }
    this.state.candidateView='graph';
  });}
  useSuggestedGoal(){if(this.intake.goalStage&&this.state.turn?.id!==this.intake.record.goalTurnId)return;const reply=currentReply(this.state.turn,this.state.overview);if(reply?.goal_summary){this.state.goal=reply.goal_summary;this.state.goalDirty=true;this.state.suggestedGoalStamp=this.state.overview.source_stamp;this.intake.saveGoalDraft();this.emit();}}
  async reviewPreview(){await this.ready();const d=this.state.detail;
    if(d.review?.draft_id){this.state.openDraft=d.document_id;return;}
    const owned=this.changes.owner;
    if(owned?.documentId===d.document_id&&owned.draftId===this.changes.state.summary?.id&&this.changes.state.summary?.status==='editing')this.reviewEditor=copy(owned);
    if(!this.reviewEditor||this.reviewEditor.documentId!==d.document_id){
      this.reviewEditor={documentId:d.document_id,operationId:this.uuid()};
    }
    const owner=this.reviewEditor;
    if(!owner.editor){const session=await this.read('conversation-editor-session',{documentId:d.document_id,operationId:owner.operationId});owner.editor={session:session.editor_session,generation:'1'};}
    if(!owner.draftId){
      const leases=await this.read('conversation-editor-leases',{documentId:d.document_id,operationId:this.uuid(),editor:owner.editor});
      if(leases.items.length){this.state.recoverable=leases.items;return;}
    }
    await this.previewMerge(d,owner);
  }
  async previewMerge(d,owner){
    const editor=owner.editor;
    const input={conversationId:this.saved.conversationId,intentId:d.id,operationId:this.uuid(),editor,offset:0,limit:20,...(owner.draftId?{draftId:owner.draftId}:{})};
    const plan=await this.read('conversation-review-plan',input);
    if(plan.removed_count!==0)throw fail('MODELING_REVIEW_PLAN_CHANGED');
    this.state.merge={plan,editor,revision:d.revision,documentId:d.document_id,intentId:d.id};
  }
  review(){return this.run(()=>this.reviewPreview());}
  beginEdit(){const d=this.state.detail;
    if(candidatesReady(d)&&!d.review?.draft_id)return this.review();
    return d?.review?.draft_id||this.changes.record.draftId?this.changes.openDraft():this.review();}
  claimReview(draftId){return this.run(async()=>{
    if(!this.claimPending){
      await this.ready();const draft=this.state.recoverable?.find(d=>d.draft_id===draftId),owner=this.reviewEditor;
      if(!owner?.editor||!draft||draft.legacy_unowned||draft.status!=='editing')throw fail('CORRECTION_LEASE_CHANGED');
      this.claimPending={documentId:owner.documentId,draftId,revision:draft.revision,editor:copy(owner.editor),operationId:this.uuid()};
    }
    const p=this.claimPending;
    let receipt;
    try{receipt=await this.read('conversation-editor-claim',p);}catch(e){if([400,401,403,404,409,422].includes(e.status))this.claimPending=null;throw e;}
    this.reviewEditor={...this.reviewEditor,documentId:p.documentId,draftId:p.draftId,editor:{session:p.editor.session,generation:String(receipt.lease_generation)}};
    this.claimPending=null;this.state.recoverable=null;
    await this.previewMerge(this.state.detail,this.reviewEditor);
  });}
  reviewPage(offset){return this.run(async()=>{const m=this.state.merge;if(!m)return;
    const plan=await this.read('conversation-review-plan',{conversationId:this.saved.conversationId,intentId:m.intentId,
      operationId:this.uuid(),editor:m.editor,draftId:m.plan.draft_id,offset,limit:20});
    if(plan.plan_digest!==m.plan.plan_digest||plan.removed_count!==0){this.state.merge=null;throw fail('MODELING_REVIEW_PLAN_CHANGED');}m.plan=plan;});}
  merge(keepExisting){return this.run(async()=>{
    const m=this.reviewPending?.context||this.state.merge;if(!m)throw fail('MODELING_REVIEW_PLAN_CHANGED');
    if(!this.reviewPending&&m.plan.counts.defer&&!keepExisting)throw fail('MODELING_CONFIRMATION_REQUIRED');
    const input={conversationId:this.saved.conversationId,intentId:m.intentId,revision:m.revision,editor:m.editor,
      planDigest:m.plan.plan_digest,draftId:m.plan.draft_id,confirmed:true,...(m.plan.counts.defer?{deferredPolicy:'keep_existing'}:{})};
    // Editor sessions stay in memory. Reload recovers the server draft and explicitly claims it in the existing editor.
    if(!this.reviewPending)this.reviewPending={input:{...input,operationId:this.uuid()},context:copy(m)};
    let result;
    try{result=await this.read('conversation-review',this.reviewPending.input);}catch(e){
      if([400,401,403,404,409,422].includes(e.status)){this.reviewPending=null;this.state.merge=null;}throw e;
    }
    this.changes.adoptMergedDraft(result,m);this.reviewPending=null;this.reviewEditor=null;this.state.merge=null;this.state.inspectCard=null;
    await this.snapshot();await this.changes.loadDraft();await this.changes.context();
  });}
  async releaseEditor(){if(!this.releasePending)return;const p=this.releasePending;
    await this.read('conversation-editor-release',p);this.releasePending=null;this.state.openDraft=p.documentId;this.state.merge=null;}
  release(){return this.run(()=>this.releaseEditor());}
  dispose(){this.live=false;this.history.clear();this.changes.clear();this.claimPending=null;this.reviewEditor=null;this.reviewPending=null;this.releasePending=null;this.state.messages=[];this.state.merge=null;this.state.detail=null;}
}
