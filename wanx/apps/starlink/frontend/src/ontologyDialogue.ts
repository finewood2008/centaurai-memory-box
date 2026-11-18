import {sameOntologyType,type OntologyDefinition} from './ontology.ts';

export type RuleSelection = {kind:'entity'|'relation'; type_kind:'entity'|'relation'; type_name:string};
export type DialogueTarget = {scope:'rules'; selection?:RuleSelection; label?:string} | {scope:'facts'; id?:string; kind?:'entity'|'relation'; label?:string};
export type RuleTurn = {resource_id:string; status:string; instruction?:string; answer?:string; summary?:string; questions?:string[]; message?:string; error_code?:string};
export type RuleProposal = {resource_id:string; proposal_digest:string; expected_revision:number; draft_digest:string;
  status:'proposed'|'clarification_required'|'applied'|'stale'; summary:string; questions:string[]; schema:OntologyDefinition; dependencies:string[]};
export type RuleState = {conversation_id:string; initialized:boolean; status:string; current_ontology_id?:string; base_ontology_id?:string;
  proposal?:RuleProposal|null;
  publication_effective?:boolean; has_changes?:boolean; execution_id?:string|null;
  active_turn_id?:string|null; can_preview?:boolean; draft_digest?:string;
  draft?:{revision:number; name:string; schema:OntologyDefinition; questions:string[]}; history?:{items:RuleTurn[]; has_more:boolean; next_offset:number}};
export type RulePreview = {resource_id:string; preview_digest:string; draft_digest:string; draft_revision:number;
  impact:{valid:boolean; offset:number; total:number; has_more:boolean; items:{document_id:string; name:string; certainty:string; reasons:string[]; protected:boolean; active_task_count:number}[]}};
type Read = <T>(url:string,options?:RequestInit,timeoutMs?:number)=>Promise<T>;
type Pending = {url:string; body:Record<string,unknown>; kind:'create'|'initialize'|'proposal'|'apply'|'preview'|'execute';submittedText?:string};
type Settlement = {kind:'proposal'|'apply'|'execute';resourceId:string;revision:number;proposalId?:string};
function validSchema(value:OntologyDefinition):boolean {
  const strings=(items:unknown):items is string[]=>Array.isArray(items)&&items.every(item=>typeof item==='string');
  return !!value&&(['entity_types','relation_types'] as const).every(key=>Array.isArray(value[key])&&value[key].every(item=>
    !!item&&typeof item.name==='string'&&typeof item.label==='string'&&Array.isArray(item.properties)&&item.properties.every(p=>!!p&&typeof p.name==='string'&&typeof p.label==='string'&&typeof p.required==='boolean')&&
    (key!=='relation_types'||strings((item as {source_types?:unknown}).source_types)&&strings((item as {target_types?:unknown}).target_types))));
}
export const nextInstruction = (value:string) => /^(下一步|继续|进入下一步)[。！!\s]*$/.test(value.trim());
export const applyInstruction = (value:string) => /^(确认应用到草稿|确认应用|按这个建议修改|按建议修改|采用建议|确认)[。！!\s]*$/.test(value.trim());
export const publishInstruction = (value:string) => /^(发布|确认发布|确认发布规则|核对并发布|查看发布预览|我已核对[，,\s]*确认发布)[。！!\s]*$/.test(value.trim());
export function dialogueError(reason:unknown):string {
  const e=reason as {code?:string;status?:number;message?:string};
  const messages:Record<string,string>={
    MODELING_RESOURCE_NOT_FOUND:'会话或目标不存在，或当前账号无权访问，请刷新并核对当前数据仓与账号。',
    MODELING_SCENARIO_MISMATCH:'当前会话不属于本体规则调整，请重新打开本体助手。',
    MODELING_ONTOLOGY_EDIT_STALE:'草稿或生效本体已变化，请读取最新状态后核对冲突。',
    MODELING_PROPOSAL_STALE:'建议或草稿已变化，请读取最新状态并重新核对建议。',
    MODELING_IMPACT_STALE:'材料或规则已变化，请重新读取状态、预览影响并确认。',
    MODELING_ONTOLOGY_EDIT_BUSY:'助手正在生成，请读取进度并等待当前轮次完成。',
    MODELING_ONTOLOGY_EDIT_PROPOSAL_PENDING:'请先核对当前建议并确认应用到草稿，再核对发布。',
    MODELING_ONTOLOGY_EDIT_CLARIFICATION_REQUIRED:'请先回答当前建议中的待确认问题，再继续核对。',
    MODELING_ONTOLOGY_EDIT_NO_CHANGES:'本次内容没有实际变化，无需应用或发布；可以继续描述调整要求。',
    MODELING_CONTEXT_BUDGET:'当前规则与对话超过模型上下文预算。草稿保留，请管理员核对本体模型配置后重试。',
  };
  if(e?.code&&messages[e.code])return messages[e.code];
  if(['SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_UPGRADE_REQUIRED'].includes(e?.code||'')||!e?.code&&[404,405,501].includes(e?.status||0))return '当前服务未接受本体建议或确认应用请求，请核对接口路径与已部署版本。已有草稿保留，不会使用直接写入草稿的旧接口。';
  return e?.message||'请求未完成，请读取最新状态或恢复原请求。';
}

/** One warehouse rule-edit round. Never uses a material conversation or fact mutation. */
export class OntologyDialogue {
  read:Read; notify:()=>void; baseId:string; current?:RuleState; preview?:RulePreview;
  pending?:Pending; busy=false; error=''; note=''; conversationId='';
  settling?:Settlement;
  needsRefresh=false;
  opened=false; historyState?:RuleState;
  baselineSchema?:OntologyDefinition;
  acceptedInput?:{operationId:string;instruction:string};
  rounds:{id:string;created_at:string}[]=[]; listOffset=0; more=false;
  constructor(read:Read,baseId:string,notify:()=>void,baseline?:OntologyDefinition){this.read=read;this.baseId=baseId;this.notify=notify;this.baselineSchema=baseline;}
  hasChanges(){
    if(typeof this.current?.has_changes==='boolean')return this.current.has_changes;
    const draft=this.current?.draft?.schema,baseline=this.baselineSchema;
    if(!draft||!baseline)return undefined;
    return (['entity_types','relation_types'] as const).some(key=>baseline[key].length!==draft[key].length||baseline[key].some(item=>!sameOntologyType(item,draft[key].find(other=>other.name===item.name))));
  }
  get proposal(){return this.current?.proposal;}
  get awaitingProposal(){return !!this.proposal&&['proposed','clarification_required','stale'].includes(this.proposal.status);}
  path(suffix=''){return `/api/conversations/${encodeURIComponent(this.conversationId)}/ontology-edit${suffix}`;}
  async run(action:()=>Promise<void>){
    if(this.busy)return;
    this.busy=true;this.error='';this.notify();
    try{await action();}catch(reason){this.error=dialogueError(reason);}
    finally{this.busy=false;this.notify();}
  }
  async list(more=false){await this.run(async()=>{
    const page=await this.read<{items:{id:string;scenario:string;created_at:string}[];has_more:boolean;next_offset:number}>(`/api/conversations?workspace_id=default&offset=${more?this.listOffset:0}&limit=50`);
    this.rounds=[...(more?this.rounds:[]),...page.items.filter(item=>item.scenario==='change')];this.more=page.has_more;this.listOffset=page.next_offset;
  });}
  // Server scope is bound by the host. Never cache private rounds under a global browser key.
  async open(){await this.run(async()=>{
    if(this.opened)return;
    let offset=0;this.rounds=[];
    for(;;){
      const page=await this.read<{items:{id:string;scenario:string;created_at:string}[];has_more:boolean;next_offset:number}>(`/api/conversations?workspace_id=default&offset=${offset}&limit=50`);
      this.rounds.push(...page.items.filter(item=>item.scenario==='change'));this.more=page.has_more;this.listOffset=page.next_offset;
      for(const round of page.items.filter(item=>item.scenario==='change')){
        const state=await this.read<RuleState>(`/api/conversations/${encodeURIComponent(round.id)}/ontology-edit`);
        if(state.conversation_id!==round.id)throw new Error('会话绑定不一致。');
        if(['editing','stale','uninitialized'].includes(state.status)){
          this.conversationId=round.id;await this.refreshState(state);this.opened=true;
          if(this.current?.status==='editing'&&!this.current.active_turn_id&&!this.needsRefresh&&!['failed','stale'].includes(this.current.history?.items[0]?.status||'')){
            if(this.awaitingProposal)this.note='已恢复待确认建议，尚未应用到草稿。';
            else if(this.hasChanges()===true)this.note='已恢复未发布修改。';
          }
          return;
        }
      }
      if(!page.has_more)break;
      if(page.next_offset<=offset)throw new Error('历史分页异常，请稍后重试。');
      offset=page.next_offset;
    }
    if(!this.pending&&!this.settling){
      this.conversationId='';this.current=undefined;this.preview=undefined;this.note='';this.needsRefresh=false;
    }
    this.opened=true;
  });}
  async readHistory(id:string){await this.run(async()=>{
    const state=await this.read<RuleState>(`/api/conversations/${encodeURIComponent(id)}/ontology-edit`);
    if(state.conversation_id!==id)throw new Error('历史记录绑定不一致。');
    this.historyState=state;
  });}
  async refreshState(snapshot?:RuleState){
    try{
      const value=snapshot??await this.read<RuleState>(this.path());
      if(value.conversation_id!==this.conversationId)throw new Error('会话绑定不一致，请重新进入本体对话。');
      const proposal=value.proposal;
      if(value.draft&&(!validSchema(value.draft.schema)||!Array.isArray(value.draft.questions)||value.draft.questions.some(q=>typeof q!=='string')))throw new Error('草稿回执不完整，请读取最新状态。');
      if(proposal&&(!/^[A-Za-z0-9_-]{1,120}$/.test(proposal.resource_id)||!/^[a-f0-9]{64}$/.test(proposal.proposal_digest)||!/^[a-f0-9]{64}$/.test(proposal.draft_digest)||!Number.isSafeInteger(proposal.expected_revision)||proposal.expected_revision<0||!['proposed','clarification_required','applied','stale'].includes(proposal.status)||typeof proposal.summary!=='string'||!Array.isArray(proposal.questions)||proposal.questions.some(q=>typeof q!=='string')||!Array.isArray(proposal.dependencies)||proposal.dependencies.some(item=>typeof item!=='string')||!validSchema(proposal.schema)))throw new Error('修改建议回执不完整，请读取最新状态；暂不能应用或发布。');
      this.current=value;this.needsRefresh=false;
      if(this.settling){
        const expected=this.settling,terminal=value.history?.items.find(item=>item.resource_id===expected.resourceId&&['failed','stale'].includes(item.status));
        const completed=value.history?.items.some(item=>item.resource_id===expected.resourceId&&['succeeded','applied','proposed','clarification_required'].includes(item.status));
        const ready=expected.kind==='execute'?value.status==='published'&&value.execution_id===expected.resourceId:
          expected.kind==='proposal'?(!!proposal&&proposal.resource_id===expected.resourceId||completed):
          !!value.draft&&value.draft.revision>expected.revision&&(completed||!!proposal&&proposal.resource_id===expected.proposalId&&proposal.status==='applied');
        if(ready||terminal)this.settling=undefined;
        else this.needsRefresh=true;
      }
      if(value.draft&&(value.status==='published'||value.draft.revision===0))this.baselineSchema=structuredClone(value.draft.schema);
      if(this.preview&&(this.needsRefresh||value.status!=='editing'||value.active_turn_id||this.awaitingProposal||value.can_preview===false||value.draft?.questions.length||value.draft?.revision!==this.preview.draft_revision||value.draft_digest!==this.preview.draft_digest))this.preview=undefined;
      if(value.status==='published'||value.status==='stale')this.note='';
      else if(value.active_turn_id)this.note='助手正在生成，草稿尚未发布。';
      else {
        const latest=value.history?.items[0];
        if(latest?.status==='failed'||latest?.status==='stale')this.note=dialogueError({code:latest.error_code,message:latest.message||'本轮未应用，原草稿保留。请调整要求后重新发送。'});
        else if(this.awaitingProposal)this.note='建议尚未写入草稿，可继续调整或确认应用。';
        else if(value.draft?.questions.length)this.note='请回答待确认问题，再核对本轮草稿。';
        else if(['succeeded','applied'].includes(latest?.status||'')&&this.hasChanges())this.note='本轮已保存为待发布草稿，请核对差异。';
        else this.note='';
      }
      if(this.settling)this.note=value.active_turn_id?'助手正在生成建议，尚未写入草稿。':'请求已收到回执，正在等待最新状态同步；请读取最新状态，不要重复提交。';
    }catch(reason){this.needsRefresh=true;this.preview=undefined;throw reason;}
  }
  async refresh(){await this.run(async()=>{if(this.conversationId){await this.refreshState();this.opened=true;}});}
  async select(id:string){await this.run(async()=>{
    if(this.pending)throw new Error('请先恢复结果未知的原请求。');
    this.conversationId=id;this.current=undefined;this.preview=undefined;this.note='';this.needsRefresh=true;await this.refreshState();
  });}
  async write(kind:Pending['kind'],url:string,body:Record<string,unknown>,submittedText?:string){
    if(this.pending)throw new Error('请先恢复结果未知的原请求。');
    this.pending={kind,url,body:{...body,operation_id:crypto.randomUUID()},submittedText};this.notify();await this.deliver();
  }
  async deliver(){
    const pending=this.pending!;
    let value:Record<string,unknown>;
    try{value=await this.read<Record<string,unknown>>(pending.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.body)},pending.kind==='proposal'?285000:45000);}
    catch(reason){const {status,code}=reason as {status?:number;code?:string};if(status&&status>=400&&status<500&&![408,429].includes(status)||['SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_UPGRADE_REQUIRED','INVALID_RESOURCE'].includes(code||''))this.pending=undefined;if(status===409||status===403||status===404){this.preview=undefined;this.needsRefresh=true;}throw reason;}
    // A malformed success is also uncertain: keep the original operation identity.
    if(!value||typeof value.resource_id!=='string')throw new Error('接口回执无效，请恢复原请求，勿重复提交。');
    const allowed=pending.kind==='apply'?['succeeded','applied','failed','stale']:['succeeded','generating','proposed','clarification_required','applied','failed','stale'];
    if(['proposal','apply'].includes(pending.kind)&&!allowed.includes(String(value.status)))throw new Error('接口回执缺少正确的处理状态，请恢复原请求。');
    if(pending.kind==='execute'&&value.status!=='completed')throw new Error('发布回执未确认完成，请恢复原请求，暂不重复发布。');
    if(['proposal','apply'].includes(pending.kind)&&!['failed','stale'].includes(String(value.status)))this.settling={kind:pending.kind as Settlement['kind'],resourceId:value.resource_id,revision:Number(pending.body.expected_revision),proposalId:pending.kind==='apply'?pending.url.split('/').at(-2):undefined};
    if(pending.kind==='create'){
      this.conversationId=value.resource_id;this.current=undefined;this.preview=undefined;
    }else if(pending.kind==='preview'){
      const p=value as unknown as RulePreview;
      if(!p.preview_digest||!p.impact||!Array.isArray(p.impact.items))throw new Error('影响预览回执不完整，暂不能发布。');
      this.preview=p;
    }else if(pending.kind==='proposal'){
      this.preview=undefined;
      if(['succeeded','generating','proposed','clarification_required','applied'].includes(String(value.status)))this.acceptedInput={operationId:String(pending.body.operation_id),instruction:String(pending.body.instruction)};
      this.note=String(value.message||'建议尚未写入草稿，请核对后确认。');
    }else if(pending.kind==='apply'){
      this.preview=undefined;this.note='应用请求已返回，正在核对草稿。';
      if(['succeeded','applied'].includes(String(value.status))&&pending.submittedText)this.acceptedInput={operationId:String(pending.body.operation_id),instruction:pending.submittedText};
    }else if(pending.kind==='execute'){
      this.settling={kind:'execute',resourceId:value.resource_id,revision:this.current?.draft?.revision??0};
      this.preview=undefined;this.note='发布请求已返回，正在核对最新状态。';
    }
    this.pending=undefined;
    this.needsRefresh=true;
    await this.refreshState();
    if(['proposal','apply'].includes(pending.kind)&&['failed','stale'].includes(String(value.status)))throw Object.assign(new Error(String(value.message||'本次操作未完成，原草稿保留。')),{code:value.error_code});
  }
  async retry(){await this.run(async()=>{if(this.pending)await this.deliver();});}
  async startCurrent(){
    if(this.pending)throw new Error('请先恢复结果未知的原请求。');
    if(this.settling)throw new Error('请先读取最新状态，确认上次请求结果。');
    this.note='';await this.write('create','/api/conversations',{workspace_id:'default',scenario:'change'});
    if(this.current?.current_ontology_id)this.baseId=this.current.current_ontology_id;
    await this.initializeCurrent();
  }
  async start(){await this.run(()=>this.startCurrent());}
  async initializeCurrent(){
    if(this.needsRefresh)throw new Error('请先读取最新状态，再开始规则调整。');
    if(!this.current||this.current.initialized)throw new Error('请先读取当前会话状态。');
    if(!this.current.current_ontology_id)throw new Error('缺少当前生效本体，请读取最新状态后继续。');
    // An uninitialized conversation has no draft to overwrite. Use its fresh server baseline,
    // including when recovering an interrupted creation after another version was published.
    this.baseId=this.current.current_ontology_id;
    await this.write('initialize',this.path('/initialize'),{base_ontology_id:this.baseId,name:'知识助手规则草稿'});
  }
  async initialize(){await this.run(()=>this.initializeCurrent());}
  revision(){
    if(this.needsRefresh)throw new Error('当前显示的是上次读取结果，请先读取最新状态再继续。');
    const c=this.current;
    if(!c?.draft||c.status!=='editing'||c.active_turn_id||!c.draft_digest)throw new Error('当前没有可继续的草稿，请先描述修改要求；若正在生成或存在版本冲突，请读取最新状态。');
    return {expected_revision:c.draft.revision,draft_digest:c.draft_digest};
  }
  async send(instruction:string,selected:RuleSelection[]=[]){await this.run(async()=>{
    if(!instruction.trim()||instruction.length>8000)throw new Error('请输入 1–8000 字调整要求。');
    if(this.pending)throw new Error('请先恢复结果未知的原请求。');
    if(this.needsRefresh)throw new Error('请先读取最新状态，再继续修改。');
    if(applyInstruction(instruction)){await this.applyCurrent(instruction);return;}
    if(nextInstruction(instruction)||publishInstruction(instruction)){
      if(this.awaitingProposal)throw new Error('请先核对建议并明确确认应用到草稿。“下一步”不会代替确认。');
      if(this.preview){this.note='请核对影响摘要并勾选确认，再点击“确认发布规则”。';return;}
      await this.prepareCurrent();return;
    }
    if(!this.current||this.current.status==='published')await this.startCurrent();
    else if(!this.current.initialized)await this.initializeCurrent();
    const revision=this.revision();
    for(const item of selected)if(!this.current!.draft!.schema[`${item.type_kind}_types`].some(type=>type.name===item.type_name))throw new Error('所选类型已删除或改名，请清除目标后重新描述。');
    const proposal=this.awaitingProposal&&this.proposal?.status!=='stale'&&this.proposal?.expected_revision===revision.expected_revision&&this.proposal?.draft_digest===revision.draft_digest?this.proposal:undefined;
    this.preview=undefined;await this.write('proposal',this.path('/proposals'),{...revision,instruction,selected,
      ...(proposal?{proposal_id:proposal.resource_id,proposal_digest:proposal.proposal_digest}:{})});
  });}
  async applyCurrent(submittedText?:string){
    const revision=this.revision(),p=this.proposal;
    if(!p||p.status!=='proposed'||p.questions.length||p.expected_revision!==revision.expected_revision||p.draft_digest!==revision.draft_digest)throw new Error('当前没有可确认的完整建议，请先补充说明或重新生成建议。');
    await this.write('apply',this.path(`/proposals/${encodeURIComponent(p.resource_id)}/apply`),{...revision,proposal_digest:p.proposal_digest,confirmed:true},submittedText);
  }
  async apply(){await this.run(()=>this.applyCurrent());}
  async prepareCurrent(offset=0){
    const revision=this.revision();
    if(this.awaitingProposal)throw new Error('请先明确确认应用建议到草稿，再核对发布。');
    if(!this.current!.draft!.revision)throw new Error('尚无已确认的草稿修改，请先描述需求并确认应用建议。');
    if(this.hasChanges()===false)throw new Error('草稿与生效本体没有差异，无需发布。');
    if(this.current!.can_preview===false)throw new Error('当前服务端状态暂不允许预览，请读取最新状态并按提示继续。');
    if(this.current!.draft!.questions.length)throw new Error('请先回答助手列出的待确认问题，再进入发布预览。');
    this.preview=undefined;await this.write('preview',this.path('/preview'),{...revision,offset,limit:20});
  }
  async prepare(offset=0){await this.run(()=>this.prepareCurrent(offset));}
  async publish(confirmed:boolean){await this.run(async()=>{
    const revision=this.revision(),p=this.preview;
    if(!confirmed||this.awaitingProposal||this.current!.can_preview===false||this.current!.draft!.questions.length||!p?.impact.valid||p.draft_digest!==revision.draft_digest||p.draft_revision!==revision.expected_revision)throw new Error('请重新预览并明确确认发布范围。');
    await this.write('execute',this.path('/execute'),{preview_id:p.resource_id,preview_digest:p.preview_digest,confirmed:true,mode:'publish_only'});
  });}
}
