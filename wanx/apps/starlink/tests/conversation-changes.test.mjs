import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationChanges} from '../ui/conversation-changes.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';
import {changeHistory,changesPanel,proposalPanel,ruleSuggestionsHTML} from '../ui/conversation-changes-view.mjs';
import {ruleSuggestionInstruction,ruleStageHint} from '../ui/material-rule-guidance.mjs';
import {SemanticaService} from '../shell/service.mjs';
import {knowledgeCurrent} from '../ui/conversation-progress.mjs';
import {nextConversationStep} from '../ui/conversation-next.mjs';
import {knowledgeStage} from '../ui/conversation-stages.mjs';
const digest='a'.repeat(64),proposalDigest='b'.repeat(64),editor={session:'s'.repeat(30),generation:'1'};
const common={warehouseId:'w',conversationId:'c',intentId:'i',operationId:'op'};
test('inline validation exclusion previews unique facts with their relations before an explicit draft save',async()=>{
  const h=fixture(),c=h.c;c.owner={documentId:'doc',draftId:'draft',editor};await c.loadDraft();
  const shown={revision:1,issue_count:2,total:1,items:[{item_id:'fact',after:{name:'甲公司'}}],issues:[{item_id:'fact',severity:'error'},{item_id:'fact',severity:'warning'}]};
  c.state.preview=shown;const read=h.flow.read.bind(h.flow);
  h.flow.read=async(action,input)=>{
    if(action==='conversation-change-preview')return structuredClone(shown);
    if(action==='conversation-change-items'&&input.kind==='relation')return {items:[{id:'relation',kind:'relation',payload:{type:'LINK',source_candidate_key:'fact',target_candidate_key:'other'}}],total:1,offset:0,revision:h.db.revision};
    if(action==='conversation-change-save'){h.calls.push({action,input});h.db.revision++;return {draft_id:'draft',revision:h.db.revision,status:'editing'};}
    return read(action,input);
  };
  const text='移除这两条有问题的条目';h.flow.state.input=text;
  await c.adjustIssues({exclude:true,all:true,count:2,input:text});assert.equal(h.flow.state.error,null);
  assert.deepEqual(c.state.exclusion.ids,['fact','relation']);assert.equal(c.state.exclusion.relatedCount,1);assert.equal(h.flow.state.input,'');
  assert.equal(h.calls.some(c=>/change-(generate|save|apply|publish)/.test(c.action)),false);
  await c.applyExclusion();assert.equal(h.flow.state.error,null);
  const request=h.calls.find(c=>c.action==='conversation-change-save').input;
  assert.deepEqual(request.removeIds,['fact','relation']);assert.equal(request.confirmed,true);assert.equal(request.revision,1);
  assert.equal(c.state.exclusion,null);assert.equal(c.state.summary.revision,2);
  assert.equal(h.calls.some(c=>/change-(generate|apply|publish)/.test(c.action)),false);
});
test('changed draft or validation results stop inline exclusion and preserve the user input',async()=>{
  for(const change of ['revision','issues']){
    const h=fixture(),c=h.c;c.owner={documentId:'doc',draftId:'draft',editor};await c.loadDraft();
    c.state.preview={revision:1,issues:[{item_id:'fact',severity:'error'}]};h.flow.state.input='移除这些有问题的条目';
    if(change==='revision')h.db.revision++;
    else{const read=h.flow.read.bind(h.flow);h.flow.read=async(action,input)=>action==='conversation-change-preview'?{revision:1,issues:[]}:read(action,input);}
    await c.adjustIssues({exclude:true,all:true,input:h.flow.state.input});assert.ok(h.flow.state.error);
    assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);assert.equal(h.flow.state.input,'移除这些有问题的条目');
  }
});

test('finite fact removal requires explicit consent, a current revision and private editor context',()=>{
  const input={warehouseId:'w',documentId:'doc',draftId:'draft',operationId:'remove',revision:1,removeIds:['fact'],confirmed:true,editor};
  const request=conversationRequest('conversation-change-save',input);
  assert.match(request.path,/corrections\/draft\/save$/);assert.deepEqual(request.body.remove_ids,['fact']);assert.deepEqual(request.body.upserts,[]);
  assert.equal(request.body.expected_revision,1);assert.equal(request.body.operation_id,'remove');
  for(const altered of [{confirmed:false},{editor:undefined},{removeIds:['fact','fact']},{removeIds:[]},{revision:0},{upserts:[{}]}]){
    assert.throws(()=>conversationRequest('conversation-change-save',{...input,...altered}),{code:'MODELING_INVALID_REQUEST'});
  }
});

test('validation suggestion includes scoped problems and only generates a reviewable model proposal',async()=>{
  const h=fixture(),c=h.c;c.owner={documentId:'doc',draftId:'draft',editor};await c.loadDraft();
  const shown={revision:1,issue_count:1,total:0,items:[],issues:[{item_id:'fact',severity:'warning',message:'来源可能包含计划'}]};c.state.preview=shown;
  const read=h.flow.read.bind(h.flow);h.flow.read=async(action,input)=>action==='conversation-change-preview'?structuredClone(shown):read(action,input);
  await c.adjustIssues({suggest:true,all:true});assert.equal(h.flow.state.error,null);
  const request=h.calls.find(call=>call.action==='conversation-change-generate').input;
  assert.deepEqual(request.selectedItemIds,['fact']);assert.deepEqual(request.allowedScopes,['facts']);
  assert.match(request.instruction,/来源可能包含计划/);assert.match(request.instruction,/不要补造属性或证据/);
  assert.equal(h.calls.some(call=>/change-(save|apply|publish)$/.test(call.action)),false);assert.equal(h.db.revision,1);
});

test('suggesting too many validation facts refuses before generating or changing the draft',async()=>{
  const h=fixture(),c=h.c;c.state.preview={revision:1,issue_count:9,issues:Array.from({length:9},(_,i)=>({item_id:'f'+i,severity:'warning'}))};
  await c.adjustIssues({suggest:true,all:true});assert.equal(h.flow.state.error.code,'MODELING_VALIDATION_SUGGESTION_TOO_LARGE');assert.equal(h.calls.length,0);
});

test('fact suggestion followups carry the visible unapplied suggestion and refuse a changed context',async()=>{
  for(const stale of [false,true]){
    const h=fixture(),c=h.c;c.owner={documentId:'doc',draftId:'draft',editor};await c.loadDraft();c.setTarget('facts');
    c.state.selected=['fact'];c.state.context={context_digest:stale?'c'.repeat(64):digest};
    c.state.proposals=[{id:'previous',status:'prepared',instruction:'根据这些警告建议调整',result:{summary:'建议移除无依据的关系',changes:[{scope:'facts',item_id:'fact',after:null}]}}];
    await c.generate('第一条保留，补充说明为什么需要调整');
    if(stale){assert.equal(h.flow.state.error.code,'MODELING_CHANGE_STALE');assert.equal(h.calls.some(x=>x.action==='conversation-change-generate'),false);}
    else{assert.equal(h.flow.state.error,null);const request=h.calls.find(x=>x.action==='conversation-change-generate').input;assert.match(request.instruction,/此前待确认建议/);assert.match(request.instruction,/建议移除无依据的关系/);assert.match(request.instruction,/第一条保留/);assert.deepEqual(request.selectedItemIds,['fact']);}
    assert.equal(h.calls.some(x=>/change-(save|apply|publish)$/.test(x.action)),false);
  }
});

test('answering the first fact clarification can establish its selected context without an old digest',async()=>{
  const h=fixture(),c=h.c;c.owner={documentId:'doc',draftId:'draft',editor};await c.loadDraft();c.setTarget('facts');c.state.selected=['fact'];
  c.state.proposals=[{id:'clarification',status:'needs_clarification',instruction:'修正选中的事实',result:{questions:['是否保留名称？'],changes:[]}}];
  await c.generate('保留原名称');assert.equal(h.flow.state.error,null);
  const request=h.calls.find(call=>call.action==='conversation-change-generate').input;assert.match(request.instruction,/是否保留名称/);assert.match(request.instruction,/保留原名称/);
  const html=changeHistory(h.flow,c.state.proposals,true);assert.doesNotMatch(html,/校验修正上下文|此前待确认建议/);
});

test('unknown removal save replays the exact operation once and never needs a model context',async()=>{
  const h=fixture(),c=h.c;c.owner={documentId:'doc',draftId:'draft',editor};await c.loadDraft();
  c.state.exclusion={documentId:'doc',draftId:'draft',scope:c.scopeKey,revision:1,ids:['fact'],items:[]};
  const read=h.flow.read.bind(h.flow);let saves=0,failed=false;
  h.flow.read=async(action,input)=>{
    if(action==='conversation-change-save'){
      h.calls.push({action,input:structuredClone(input)});
      if(!saves){saves++;h.db.revision=2;failed=true;throw Error('response lost');}
      return {draft_id:'draft',revision:2,status:'editing'};
    }
    return read(action,input);
  };
  await c.applyExclusion();assert.equal(failed,true);assert.ok(c.record.pending);
  await c.recover();assert.equal(h.flow.state.error,null);assert.equal(c.record.pending,undefined);assert.equal(saves,1);
  const writes=h.calls.filter(call=>call.action==='conversation-change-save');assert.deepEqual(writes[0].input,writes[1].input);
  assert.equal(h.calls.some(call=>call.action==='conversation-change-context'),false);
});
test('current clarification takes precedence over an older published rule hint',()=>{
  const flow={changes:{record:{lastProposal:'new',proposalTargets:{new:'rules'},rulesPublished:{ontologyId:'old'}},state:{proposals:[{id:'new',status:'needs_clarification'}]}}};
  assert.match(ruleStageHint(flow),/补充业务含义/);assert.doesNotMatch(ruleStageHint(flow),/本体已发布/);
});
test('declared allowed scopes are bounded and sent identically on context and generation',async()=>{
  const h=fixture();h.c.setTarget('rules');await h.c.generate('新增专利类型');assert.equal(h.flow.state.error,null);
  for(const call of h.calls.filter(c=>['conversation-change-context','conversation-change-generate'].includes(c.action))){
    assert.deepEqual(call.input.allowedScopes,['rules']);assert.deepEqual(conversationRequest(call.action,{...call.input,warehouseId:'w'}).body.allowed_scopes,['rules']);
  }
  for(const allowedScopes of [[],['rules','rules'],['extract'],null])assert.throws(()=>conversationRequest('conversation-change-context',{...common,allowedScopes}));
  assert.equal(conversationRequest('conversation-change-context',common).body.allowed_scopes,undefined);
});
test('rule suggestions preserve current clarification constraints and remain unapplied',async()=>{
  const h=fixture();h.c.setTarget('rules');await h.c.context();
  h.c.record.proposalTargets={old:'rules'};h.c.record.lastProposal='old';
  h.c.state.proposals=[{id:'old',status:'needs_clarification',instruction:ruleSuggestionInstruction('新增PATENT，本轮不加属性和关系'),result:{questions:['请补充标签与定义']}}];
  assert.match(proposalPanel(h.flow),/助手先建议名称与含义/);
  h.flow.state.input='同时包括申请中和已授权成果';await h.c.suggestRules('old');assert.equal(h.flow.state.error,null);
  const input=h.calls.find(c=>c.action==='conversation-change-generate').input;
  assert.match(input.instruction,/不加属性和关系/);assert.match(input.instruction,/同时包括申请中和已授权成果/);
  assert.match(input.instruction,/主动建议中文标签/);assert.equal(input.instruction.split('【本体建议约定】').length,2);
  assert.equal(h.calls.some(c=>c.action==='conversation-change-apply'),false);
  assert.doesNotMatch(changeHistory(h.flow),/【本体建议约定】/);
});
test('rule cards describe labels, definitions and relation ends without treating suggestions as extracted facts',()=>{
  const html=ruleSuggestionsHTML({result:{schema:{entity_types:[{name:'PATENT',label:'专利'}]},changes:[{scope:'rules',kind:'relation_types',name:'PRODUCES',before:null,after:{label:'产出',definition:'项目产出研发成果',source_types:['PROJECT'],target_types:['PATENT'],properties:[]}}]}});
  assert.match(html,/产出 · PRODUCES/);assert.match(html,/PROJECT → 专利/);assert.match(html,/不表示材料中已经抽取到/);assert.match(html,/属性：无/);
});
test('rule followups stop if the displayed context changes and preserve the answer',async()=>{
  for(const viaButton of [false,true]){
    const h=fixture();h.c.setTarget('rules');await h.c.context();
    h.c.record.proposalTargets={old:'rules'};h.c.record.lastProposal='old';
    h.c.state.proposals=[{id:'old',status:'needs_clarification',instruction:ruleSuggestionInstruction('新增专利，不加属性')}];
    const read=h.flow.read.bind(h.flow);
    h.flow.read=async(action,input)=>{const value=await read(action,input);return action==='conversation-change-context'?{...value,context_digest:'c'.repeat(64)}:value;};
    h.flow.state.input='包含申请中的成果';
    if(viaButton)await h.c.suggestRules('old');else await h.c.generate();
    assert.equal(h.flow.state.error.code,'MODELING_CHANGE_STALE');assert.equal(h.flow.state.input,'包含申请中的成果');
    assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);
  }
});
test('guided generation recovery clears only the submitted composer and keeps the original wire request',async()=>{
  for(const edited of [false,true]){
    const h=fixture();h.c.setTarget('rules');h.flow.state.input='新增专利，不加属性';
    h.flow.saved.materialComposers={'c:i':{input:h.flow.state.input}};
    h.db.lose='conversation-change-generate';await h.c.generate('请调整本体：'+h.flow.state.input,{composerInput:h.flow.state.input});
    const original=structuredClone(h.c.record.pending.input);assert.ok(original.instruction.includes('【本体建议约定】'));
    assert.equal(original.composerInput,undefined);
    if(edited){h.flow.state.input='新的补充';h.flow.saved.materialComposers['c:i'].input='新的补充';}
    const restored=h.create();await restored.recover();assert.equal(h.flow.state.error,null);
    assert.deepEqual(h.calls.filter(c=>c.action==='conversation-change-generate').at(-1).input,original);
    assert.equal(h.flow.state.input,edited?'新的补充':'');assert.equal(h.flow.saved.materialComposers['c:i'].input,edited?'新的补充':'');
  }
});
test('independent stale context errors do not reopen a private fact draft',async()=>{
  const {flow,c,calls}=fixture();c.owner={documentId:'doc',draftId:'old',editor};c.state.summary={id:'old',status:'editing',revision:1};
  c.setTarget('rules');const original=flow.read.bind(flow);
  flow.read=async(action,input)=>{if(action==='conversation-change-context')throw Object.assign(Error('stale'),{code:'MODELING_CHANGE_STALE',status:409});return original(action,input);};
  await c.generate('新增产品类型');assert.equal(flow.state.error.code,'MODELING_CHANGE_STALE');
  assert.equal(calls.some(call=>call.action==='conversation-change-draft'),false);
});
test('independent proposals remain actionable alongside discarded drafts and omit old editor credentials',async()=>{
  const {flow,c,calls}=fixture();c.owner={documentId:'doc',draftId:'old',editor};c.state.summary={id:'old',status:'discarded',revision:1};
  c.setTarget('rules');await c.generate('新增产品类型');assert.equal(flow.state.error,null);
  assert.equal(nextConversationStep(flow),'proposal');
  await c.context();await c.apply('p');assert.equal(flow.state.error,null);
  assert.equal(nextConversationStep(flow),'rules');assert.match(changesPanel(flow,'rules'),/确认发布本体规则/);
  for(const call of calls.filter(call=>['conversation-change-read','conversation-change-apply'].includes(call.action)))assert.equal(call.input.editor,undefined);
});
test('switching targets refuses unresolved mutations before changing scope or claim confirmation',()=>{
  const {flow,c}=fixture();c.setTarget('rules');c.state.claimConfirmation={draftId:'old'};
  for(const field of ['pending','reviewPending','claimPending','releasePending']){
    const holder=field==='pending'?flow.saved:flow;holder[field]={operationId:'original'};
    assert.throws(()=>c.setTarget('goal'),{code:'MODELING_REQUEST_PENDING'});
    assert.equal(c.record.changeTarget,'rules');assert.deepEqual(c.state.claimConfirmation,{draftId:'old'});delete holder[field];
  }
  c.setTarget('goal');assert.equal(c.state.claimConfirmation,null);
});
test('returning from independent rules retains the unapplied fact proposal and blocks publication preview',async()=>{
  const {flow,c,calls}=fixture();c.state.summary={id:'draft',revision:1,status:'editing'};
  c.state.proposals=[{id:'fact-proposal',status:'prepared',can_apply:true,result:{changes:[{scope:'facts'}]}}];
  c.record.proposalTargets={'fact-proposal':'facts'};c.record.lastProposal='fact-proposal';
  c.setTarget('rules');await c.context();await c.generate('新增产品类型');assert.equal(flow.state.error,null);
  c.setTarget('facts');assert.equal(nextConversationStep(flow),'proposal');
  await c.preview();assert.equal(flow.state.error.code,'MODELING_CHANGE_REVIEW_REQUIRED');
  assert.equal(calls.some(call=>call.action==='conversation-change-preview'),false);
});
test('published baseline is displayed despite a cached submitted draft without an old intent execution',()=>{
  const {flow,c}=fixture();c.state.summary={id:'old-draft',status:'submitted',revision:1};
  flow.state.dialogueWorkflow={document_id:'doc',document_version_id:'v',stage:'published',publication:{id:'run',status:'published',document_version_id:'v'}};
  flow.state.dialogueKnowledge={run:{id:'run'},candidates:[{kind:'entity',status:'published',payload:{name:'已发布产品',type:'PRODUCT'},evidence:[]}]};
  assert.equal(nextConversationStep(flow),'published');
  const html=knowledgeStage(flow);assert.match(html,/当前已发布知识/);assert.match(html,/已发布产品/);assert.doesNotMatch(html,/尚未收到本材料的抽取任务回执/);
});
test('rule proposals bypass submitted fact drafts and can publish independent rules with scope checks',async()=>{
  const {flow,c,calls}=fixture();
  c.state.summary={id:'old-draft',status:'submitted',stale_reason:'OLD_VERSION',revision:4};c.record.draftId='old-draft';
  c.state.leases=[{draft_id:'old-draft'}];c.state.selected=['old-fact'];
  c.setTarget('rules');await c.generate('新增产品类型');assert.equal(flow.state.error,null);
  for(const call of calls.filter(c=>['conversation-change-context','conversation-change-generate'].includes(c.action))){
    assert.equal(call.input.draftId,undefined);assert.equal(call.input.editor,undefined);assert.deepEqual(call.input.selectedItemIds,[]);
  }
  assert.equal(calls.some(c=>c.action==='conversation-change-draft'),false);
  assert.equal(nextConversationStep(flow),'proposal');
  assert.match(changeHistory(flow),/data-cv="change-apply"/);
  await c.apply('p');assert.equal(flow.state.error,null);assert.equal(nextConversationStep(flow),'rules');
  const html=changesPanel(flow,'rules');assert.match(html,/确认发布本体规则/);assert.doesNotMatch(html,/继续修改已保存的内容/);
  c.state.ruleConfirmed=true;await c.publishRules();assert.equal(flow.state.error,null);
  assert.equal(calls.filter(c=>c.action==='conversation-change-rule-publish').length,1);
  assert.equal(c.state.summary.id,'old-draft');assert.equal(c.state.summary.status,'submitted');
});
test('goal generation does not require claiming another editor fact draft and refuses cross-scope proposals',async()=>{
  const {flow,c,calls}=fixture();c.record.draftId='unclaimed';c.state.leases=[{draft_id:'unclaimed'}];
  c.setTarget('goal');await c.generate('只整理供应链内容');assert.equal(flow.state.error,null);
  assert.equal(nextConversationStep(flow),'proposal');
  assert.doesNotMatch(changeHistory(flow),/data-cv="change-apply"/);assert.match(changeHistory(flow),/超出本轮范围/);
  await c.apply('p');assert.equal(flow.state.error.code,'MODELING_CHANGE_SCOPE_MISMATCH');
  assert.equal(calls.some(c=>c.action==='conversation-change-apply'||c.action==='conversation-editor-claim'),false);
});
test('proposal target persists on restart and returning to facts restores lease requirements',async()=>{
  const h=fixture(),{c,flow}=h;c.record.draftId='unclaimed';c.setTarget('rules');await c.generate('新增产品类型');
  const restored=h.create();assert.equal(restored.independent,true);await restored.context();assert.equal(nextConversationStep(flow),'proposal');
  restored.setTarget('facts');await restored.context();assert.equal(restored.state.needsDraft,true);assert.equal(nextConversationStep(flow),'draft');
  assert.equal(restored.record.proposalTargets.p,'rules');
});
test('independent rule request recovery and polling never reopen the unrelated submitted fact draft',async()=>{
  const h=fixture(),{flow,c}=h;c.owner={documentId:'doc',draftId:'old-draft',editor};
  c.state.summary={id:'old-draft',status:'submitted',revision:4};c.record.draftId='old-draft';c.setTarget('rules');
  h.db.lose='conversation-change-generate';await c.generate('新增产品类型');assert.ok(c.record.pending);
  await c.recover();assert.equal(flow.state.error,null);assert.equal(c.record.pending,undefined);
  c.state.proposals[0].status='generating';await c.tick();assert.equal(flow.state.error,null);
  assert.equal(h.calls.some(call=>['conversation-change-draft','conversation-change-heartbeat'].includes(call.action)),false);
  assert.equal(h.calls.filter(call=>call.action==='conversation-change-generate').length,2);
  assert.equal(nextConversationStep(flow),'proposal');
});
test('independent context does not read another editor private fact proposal from history',async()=>{
  const h=fixture(),{flow,c}=h;const original=flow.read.bind(flow);
  flow.read=async(action,input)=>{
    if(action==='conversation-change-context')return {...await original(action,input),recent_proposals:[{id:'private-fact-proposal'}]};
    if(action==='conversation-change-read')assert.fail('unrelated private proposal must not be read');
    return original(action,input);
  };
  c.setTarget('rules');await c.generate('新增产品类型');assert.equal(flow.state.error,null);
  assert.equal(nextConversationStep(flow),'proposal');
});
test('change transport accepts only registered bounded fields and keeps private reads out of URLs',async()=>{
  const cases=[['context',{...common,proposalOffset:10}],['generate',{...common,contextDigest:digest,instruction:'修改名称'}],
    ['read',{...common,proposalId:'p',editor}],['apply',{...common,proposalId:'p',proposalDigest,confirmed:true,editor}],
    ['items',{warehouseId:'w',documentId:'doc',draftId:'draft',operationId:'op',editor,revision:2,offset:20,limit:20,kind:'entity'}],
    ['publish',{warehouseId:'w',documentId:'doc',draftId:'draft',operationId:'op',editor,revision:2,confirmed:true}]];
  const requests=[];
  const service=new SemanticaService({host:{context:async()=>({boxId:'box',user:{id:1},dataScope:'personal'}),onSessionInvalidated:()=>()=>{},
    request:async(path,options)=>{requests.push({path,...options});return new Response('{}');}}});
  for(const [kind,input] of cases){const action='conversation-change-'+kind,r=conversationRequest(action,input);
    await service.call(action,input);assert.equal(requests.at(-1).path,'/api/semantica'+r.path);assert.deepEqual(requests.at(-1).body,r.body);
    assert.equal(r.path.includes(editor.session),false);assert.throws(()=>conversationRequest(action,{...input,actor:'foreign'}));
  }
  const generation=conversationRequest('conversation-change-generate',cases[1][1]);assert.equal(generation.timeoutMs,300000);
  assert.equal(generation.body.operation_id,generation.body._native_operation_id);
  assert.equal(conversationRequest('conversation-change-context',common).body.operation_id,undefined);
  assert.throws(()=>conversationRequest('conversation-change-generate',{...cases[1][1],instruction:'😀'.repeat(4001)}));
  assert.throws(()=>conversationRequest('conversation-change-context',{...common,draftId:'draft',selectedItemIds:['a']}));
  assert.throws(()=>conversationRequest('conversation-change-context',{...common,draftId:'draft',editor,selectedItemIds:Array.from({length:21},(_,i)=>'id'+i)}));
  assert.throws(()=>conversationRequest('conversation-change-apply',{...cases[3][1],confirmed:false}));
});
function fixture(storage=new Map()){
  let sequence=0;const calls=[],receipts=new Map(),db={lose:null,status:'prepared',nextIntent:'i',revision:1,published:false};
  const proposal=()=>({id:'p',status:db.status,can_apply:db.status==='prepared',instruction:'<合并类型>',proposal_digest:proposalDigest,
    result:{summary:'保留具体实体',questions:[],changes:[{scope:'rules',name:'PARTY',before:null,after:{label:'当事人'}}],coverage:{sampled_segments:2,total_segments:8,partial:true}}});
  const flow={key:'scoped-account-warehouse',warehouseId:'w',saved:{conversationId:'c',autoRead:{},analyzed:{}},
    state:{selectedIntent:'i',detail:{id:'i',document_id:'doc',document_version_id:'v',source_status:'available'},loaded:true,input:'<合并类型>',intents:[]},
    storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},uuid:()=>`op-${++sequence}`,check(){if(db.disposed)throw Error('WAREHOUSE_CHANGED');},emit(){},
    async ready(){if(this.changes?.record.pending)throw Error('PENDING');},async snapshot(){this.state.detail.id=this.state.selectedIntent;},
    async run(fn){if(this.state.busy)return;this.state.busy=true;this.state.error=null;try{await fn();}catch(e){this.state.error=e;}finally{this.state.busy=false;}},
    async read(action,input){this.check();calls.push({action,input:structuredClone(input)});let result;
      if(action==='conversation-change-context')return {context_digest:digest,ontology_id:input.ontologyDraftId||'base',base_ontology_id:'base',schema:{entity_types:[],relation_types:[]},recent_proposals:db.generated?[{id:'p'}]:[],proposal_next_offset:1,proposal_has_more:false};
      if(action==='conversation-change-read')return {...proposal(),...(db.application?{application:db.application}:{})};
      if(action==='conversation-ontologies')return {items:[{id:'rules',status:db.published?'published':'draft'}]};
      if(action==='conversation-change-draft')return {id:input.draftId,revision:db.revision,status:db.submitted?'submitted':'editing',counts:{entity:1,relation:0}};
      if(action==='conversation-change-items')return {items:[{id:'fact',kind:'entity',payload:{name:'甲公司'},evidence:[]}],total:1,offset:0,revision:db.revision};
      if(action==='conversation-change-preview')return {items:[],total:0,revision:db.revision,issues:[],ready_for_confirmation:true};
      if(action==='conversation-change-publication')return {status:db.publication||'running',effective:db.publication==='succeeded'};
      if(receipts.has(input.operationId))return structuredClone(receipts.get(input.operationId));
      if(action==='conversation-change-generate'){db.generated=true;result=proposal();}
      else if(action==='conversation-change-apply'){db.status='applied';result=db.application={status:'applied',active_intent_id:db.nextIntent,ontology_draft_id:'rules',...(db.applyDraft?{draft_id:db.applyDraft,draft_revision:++db.revision}:{}),publication_performed:false,extraction_started:false};}
      else if(action==='conversation-change-publish'){db.submitted=true;result={draft_id:'draft',status:'submitted',revision:++db.revision};}
      else if(action==='conversation-change-rule-publish'){db.published=true;result={id:'rules',status:'published'};}
      else if(action==='conversation-change-publish-retry'){db.publication='queued';result={draft_id:input.draftId,revision:db.revision,status:'submitted'};}
      else if(action==='conversation-change-draft-create'){db.submitted=false;db.revision=1;result={draft_id:'next-draft',revision:1,status:'editing',lease_generation:1};}
      else throw Error('Unexpected '+action);
      receipts.set(input.operationId,structuredClone(result));if(db.lose===action){db.lose=null;throw Object.assign(Error('lost'),{status:0});}return result;
    }};
  const create=()=>{flow.changes=new ConversationChanges(flow);flow.changes.bind();return flow.changes;};
  return {flow,c:create(),create,db,calls,storage};
}

test('discard uses the confirmed revision, refuses newer edits and unresolved extraction results',async()=>{
  const h=fixture(),{flow,c}=h;const baseRead=flow.read.bind(flow);let discarded=0,opened=0,pendingResults=false;
  c.owner={documentId:'doc',draftId:'draft',editor};c.record.draftId='draft';await c.loadDraft();
  flow.read=async(action,input)=>{
    if(action==='conversation-material-workflow')return {document_id:'doc',stage:pendingResults?'awaiting_review':'draft',tasks:[]};
    if(action==='conversation-change-discard'){discarded++;return {draft_id:'draft',revision:input.revision+1,status:'discarded'};}
    return baseRead(action,input);
  };
  flow.importer={select:async()=>{},automatic:async()=>opened++};
  c.prepareDiscard();h.db.revision++;await c.discardForAutomatic();assert.equal(flow.state.error.code,'CORRECTION_REVISION_CONFLICT');assert.equal(discarded,0);
  await c.loadDraft();c.prepareDiscard();pendingResults=true;await c.discardForAutomatic();assert.equal(flow.state.error.code,'MATERIAL_REEXTRACTION_REVIEW_REQUIRED');assert.equal(discarded,0);
  pendingResults=false;await c.discardForAutomatic();assert.equal(discarded,1);assert.equal(opened,1);assert.equal(c.owner,null);assert.equal(c.record.draftId,undefined);
});

test('unclaimed historical draft exposes the existing explicit ownership review without claiming automatically',()=>{
  const h=fixture();h.c.state.leases=[{draft_id:'legacy',revision:1,status:'editing',legacy_unowned:true}];
  const html=changesPanel(h.flow);
  assert.match(html,/data-cv="advanced-review"[^>]*>核对并认领历史草稿/);
  assert.doesNotMatch(html,/data-cv="change-claim"/);
  assert.equal(h.calls.length,0);
});
test('restart recovers a completed discard from private terminal state without replaying under a new session',async()=>{
  const h=fixture(),{flow,c}=h;let opened=0,readDraft=0;
  c.record.draftId='draft';c.record.pending={action:'conversation-change-discard',hadEditor:true,input:{warehouseId:'w',documentId:'doc',draftId:'draft',revision:1,confirmed:true,operationId:'original'}};c.persist();
  const recovered=h.create();
  flow.read=async(action,input)=>{
    if(action==='conversation-editor-session')return {editor_session:'n'.repeat(30)};
    if(action==='conversation-change-draft'){readDraft++;assert.equal(input.editor.session,'n'.repeat(30));return {id:'draft',status:'discarded',revision:2};}
    assert.fail('must not write or open change context: '+action);
  };
  flow.importer={select:async id=>assert.equal(id,'doc'),automatic:async()=>opened++};
  await recovered.recover();assert.equal(flow.state.error,null);assert.equal(readDraft,1);assert.equal(opened,1);
  assert.equal(recovered.record.pending,undefined);assert.equal(recovered.record.draftId,undefined);assert.equal(recovered.owner,null);
});

test('discard recovery never accepts a different terminal revision as the pending operation',async()=>{
  const h=fixture(),{flow,c}=h;
  c.record.pending={action:'conversation-change-discard',hadEditor:true,input:{warehouseId:'w',documentId:'doc',draftId:'draft',revision:1,confirmed:true,operationId:'original'}};
  flow.read=async(action)=>action==='conversation-editor-session'?{editor_session:'n'.repeat(30)}:action==='conversation-change-draft'?{id:'draft',status:'discarded',revision:5}:assert.fail(action);
  await c.recover();assert.equal(flow.state.error.code,'MODELING_CHANGE_RECOVERY_REQUIRED');assert.ok(c.record.pending);
});

test('published material starts an editable revision in the same workspace without publishing or taking another lease',async()=>{
  const h=fixture(),{c,flow}=h,read=flow.read.bind(flow);
  c.owner={documentId:'doc',editor:{session:'s'.repeat(30),generation:'0'}};
  let leases=[];
  flow.read=async(action,input)=>action==='conversation-material-workflow'?{document_id:'doc',document_version_id:'v',tasks:[],publication:{id:'published'}}:action==='conversation-editor-leases'?{items:leases}:read(action,input);
  await c.editMaterial();assert.equal(flow.state.error,null);assert.equal(c.state.summary.status,'editing');
  assert.equal(c.record.draftId,'next-draft');assert.equal(flow.state.inspectCard,'draft');
  assert.equal(h.calls.some(v=>v.action==='conversation-change-publish'),false);
  c.owner.draftId=null;c.resetView();leases=[{draft_id:'another',status:'editing',revision:3}];
  const before=h.calls.length;await c.editMaterial();
  assert.equal(c.state.leases[0].draft_id,'another');assert.equal(c.state.summary,null);
  assert.equal(h.calls.length,before);assert.match(changesPanel(flow,'draft'),/在此继续修改/);
});

test('stopped completed execution keeps exact merged draft editing and explicit publication available',async()=>{
  const h=fixture(),{c,flow}=h;
  Object.assign(flow.state.detail,{status:'cancelled',execution:{id:'e',status:'awaiting_review'},review:{draft_id:'draft'}});
  c.owner={documentId:'doc',draftId:'draft',editor:{session:'s'.repeat(30),generation:'1'}};
  c.record.draftId='draft';await c.loadDraft();await c.context();assert.ok(c.state.context);
  await c.preview();assert.equal(flow.state.error,null);assert.equal(c.state.preview.ready_for_confirmation,true);
  await c.publish();assert.equal(flow.state.error.code,'MODELING_CONFIRMATION_REQUIRED');
  c.state.publishConfirmed=true;await c.publish();assert.equal(flow.state.error,null);
  assert.equal(c.state.publication.status,'running');assert.equal(c.state.summary.status,'submitted');
  flow.intake={record:{},sourceReviewed:false};h.db.publication='failed';
  await c.tick();assert.equal(c.state.publication.status,'failed');
  assert.equal(h.calls.filter(v=>v.action==='conversation-change-publish').length,1);
  assert.equal(h.calls.some(v=>v.action==='conversation-intent-create'),false);
});

test('automatic review candidates open the in-workspace result editor instead of an empty published-baseline draft',async()=>{
  const h=fixture();h.flow.read=async()=>({document_id:'doc',document_version_id:'v',tasks:[],stage:'awaiting_review'});
  await h.c.editMaterial();assert.equal(h.flow.state.error,null);
  assert.equal(h.flow.state.openDetailedEditor,'doc');assert.equal(h.c.state.summary,null);assert.equal(h.calls.length,0);
});

test('stopped context exception is limited to the server-linked merged draft',async()=>{
  const h=fixture(),{c,flow}=h;
  Object.assign(flow.state.detail,{status:'cancelled',execution:{id:'e',status:'awaiting_review'},review:{draft_id:'original'}});
  c.owner={documentId:'doc',draftId:'other',editor:{session:'s'.repeat(30),generation:'1'}};
  c.state.summary={id:'other',status:'editing'};await c.context();
  assert.equal(c.state.context,null);assert.equal(h.calls.length,0);
});

test('discarded summary cannot masquerade as a pending publication even with receipt view selected',()=>{
  const h=fixture();h.c.state.summary={id:'draft',status:'discarded'};
  const html=changesPanel(h.flow,'receipt');
  assert.match(html,/草稿已放弃/);assert.match(html,/data-cv="advanced-review"/);
  assert.doesNotMatch(html,/<progress|确认发布|正在发布材料知识/);
  h.c.state.proposals=[{id:'old',status:'prepared',can_apply:true,result:{changes:[{scope:'facts',after:{name:'old'}}]}}];
  assert.doesNotMatch(changeHistory(h.flow),/data-cv="change-apply"/);
});

test('publication blockage has an actionable explanation without a misleading confirmation checkbox',async()=>{
  const h=fixture();h.c.state.summary={id:'draft',revision:1,status:'editing',counts:{entity:1,relation:0}};
  h.c.state.preview={revision:1,ready_for_confirmation:false,items:[],total:0,issue_count:120,issues:[{message:'缺少必填属性 <title>',severity:'error'}]};
  h.c.state.publishConfirmed=true;
  const html=changesPanel(h.flow,'publication');
  assert.match(html,/暂不能发布：草稿校验未通过/);assert.match(html,/返回草稿处理问题/);
  assert.match(html,/材料未提及的属性不要补造/);assert.match(html,/120 项/);assert.match(html,/当前接口返回前 1 项/);
  assert.match(html,/&lt;title&gt;/);assert.doesNotMatch(html,/id="cv-publish-confirmed"/);
  await h.c.publish();assert.equal(h.flow.state.error.code,'MODELING_CONFIRMATION_REQUIRED');
  assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
  h.c.state.preview.ready_for_confirmation='false';await h.c.publish();
  assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
  h.c.state.preview.ready_for_confirmation=true;h.c.state.publishConfirmed=false;
  const ready=changesPanel(h.flow,'publication');assert.match(ready,/id="cv-publish-confirmed"/);assert.doesNotMatch(ready,/class="cv-publication-blocked"/);
});

test('missing property notices allow explicit confirmation only when the server permits publication',async()=>{
  const h=fixture();h.c.state.summary={id:'draft',revision:1,status:'editing',counts:{entity:1,relation:0}};
  h.c.state.preview={revision:1,ready_for_confirmation:true,items:[],total:0,issues:[{code:'MATERIAL_PROPERTY_UNMENTIONED',severity:'info',message:'本材料尚未提供属性 <name>，保持空缺，不阻止发布'}]};
  const html=changesPanel(h.flow,'publication');
  assert.match(html,/属性可留空/);assert.match(html,/&lt;name&gt;/);assert.match(html,/id="cv-publish-confirmed"/);
  assert.doesNotMatch(html,/class="cv-publication-blocked"/);
  await h.c.publish();assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
  h.c.state.preview.ready_for_confirmation=false;h.c.state.publishConfirmed=true;
  await h.c.publish();assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
});

test('failed preview reread revokes an earlier checked publication even at the same draft revision',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor:{session:'s'.repeat(30),generation:'1'}};
  h.c.state.summary={id:'draft',revision:1,status:'editing',counts:{entity:1,relation:0}};
  h.c.state.preview={revision:1,ready_for_confirmation:true,items:[],total:0,issues:[]};h.c.state.publishConfirmed=true;
  const read=h.flow.read;h.flow.read=async(action,input)=>{if(action==='conversation-change-draft')throw Object.assign(Error('disconnected'),{status:503});return read.call(h.flow,action,input);};
  await h.c.preview();assert.equal(h.c.state.preview,null);assert.equal(h.c.state.publishConfirmed,false);
  await h.c.publish();assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
});
test('changed draft header revokes old publication and evidence even if item loading fails',async()=>{
  for(const changed of [{revision:2},{status:'submitted'},{stale_reason:'source_changed'}]){
    const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};
    h.c.state.summary={id:'draft',revision:1,status:'editing',counts:{entity:1,relation:0}};
    h.c.state.preview={revision:1,ready_for_confirmation:true};h.c.state.publishConfirmed=true;
    h.c.state.items={items:[{id:'old'}]};h.c.state.source={text:'旧依据'};h.c.state.selected=['old'];
    const read=h.flow.read;h.flow.read=async(action,input)=>{
      if(action==='conversation-change-draft')return {...h.c.state.summary,...changed};
      if(action==='conversation-change-items')throw Object.assign(Error('offline'),{status:503});
      return read.call(h.flow,action,input);
    };
    await h.c.page(0);assert.equal(h.c.state.preview,null);assert.equal(h.c.state.publishConfirmed,false);
    assert.equal(h.c.state.items,null);assert.equal(h.c.state.source,null);assert.deepEqual(h.c.state.selected,[]);
    await h.c.publish();assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
  }
});
test('draft item pages from another revision are rejected',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};const read=h.flow.read;
  h.flow.read=async(action,input)=>action==='conversation-change-items'?{items:[],revision:0}:read.call(h.flow,action,input);
  await h.c.page(0);assert.equal(h.flow.state.error.code,'CORRECTION_REVISION_CONFLICT');assert.equal(h.c.state.items,null);
});
test('bulk selection replaces other pages, clears locally and never confirms or publishes facts',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();
  h.c.state.items={revision:1,offset:20,total:45,items:Array.from({length:20},(_,n)=>({id:'page-'+n,kind:'entity',payload:{name:'实例'+n},evidence:[]}))};
  h.c.state.selected=['other-page'];h.c.state.context={context_digest:digest};
  const before=h.calls.length;const html=changesPanel(h.flow,'draft');
  assert.match(html,/无需逐条勾选确认/);assert.match(html,/其他页已选 1 项/);assert.match(html,/全选本页/);
  h.c.selectPage();assert.equal(h.c.state.selected.length,20);assert.equal(h.c.state.selected.includes('other-page'),false);assert.equal(h.c.state.context,null);
  h.c.selectPage();assert.equal(h.c.state.selected.length,20);
  h.c.clearSelection();assert.deepEqual(h.c.state.selected,[]);assert.equal(h.calls.length,before);
  for(const blocked of ['busy','pending','submitted','revision']){
    h.flow.state.busy=blocked==='busy';h.flow.saved.pending=blocked==='pending'?{}:null;
    h.c.state.summary.status=blocked==='submitted'?'submitted':'editing';h.c.state.items.revision=blocked==='revision'?0:1;
    h.c.selectPage();assert.deepEqual(h.c.state.selected,[]);
  }
});
test('whole-draft preview reads all differences with no selections and still requires explicit publication',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();
  const read=h.flow.read,offsets=[];
  h.flow.read=async(action,input)=>{
    if(action==='conversation-change-preview'){
      offsets.push(input.offset);assert.equal(input.selectedItemIds,undefined);
      return {revision:1,ready_for_confirmation:true,total:65,items:Array.from({length:Math.min(50,65-input.offset)},(_,n)=>({item_id:String(n+input.offset)})),issues:[]};
    }
    return read.call(h.flow,action,input);
  };
  h.flow.state.inspectCard='draft';
  assert.deepEqual(h.c.state.selected,[]);await h.c.preview();assert.equal(h.flow.state.error,null);assert.equal(h.flow.state.inspectCard,null);
  assert.deepEqual(offsets,[0,50]);assert.equal(h.c.state.preview.items.length,65);assert.equal(h.c.state.publishConfirmed,false);
  await h.c.publish();assert.equal(h.calls.some(c=>c.action==='conversation-change-publish'),false);
});

test('stale restored drafts retain facts but offer recovery instead of editing or whole confirmation',async()=>{
  for(const reason of ['MODELING_REVIEW_INVALIDATED','STALE_DOCUMENT_VERSION','CORRECTION_BASE_CHANGED','ONTOLOGY_TARGET_CHANGED']){
    const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};
    const read=h.flow.read;h.flow.read=async(action,input)=>{
      const result=await read.call(h.flow,action,input);
      return action==='conversation-change-draft'?{...result,stale_reason:reason}:result;
    };
    await h.c.loadDraft();await h.c.context();
    assert.equal(h.calls.some(c=>c.action==='conversation-change-context'),false);
    h.c.selectPage();h.c.select('fact',true);assert.deepEqual(h.c.state.selected,[]);
    h.c.state.proposals=[{id:'old',status:'prepared',can_apply:true,result:{changes:[{}]}}];
    assert.equal(nextConversationStep(h.flow),'draft');
    const html=changesPanel(h.flow,'draft');
    assert.match(html,/原草稿已保留/);assert.match(html,/处理草稿版本变化/);assert.match(html,/甲公司/);
    assert.doesNotMatch(html,/data-cv="change-preview"|无需逐条勾选确认/);
    assert.match(html,/data-cv-item="fact"[^>]*disabled/);
    assert.doesNotMatch(changeHistory(h.flow),/data-cv="change-apply"/);
    await h.c.preview();await h.c.generate();await h.c.apply('old');
    h.c.state.preview={revision:1,ready_for_confirmation:true};h.c.state.publishConfirmed=true;await h.c.publish();
    assert.equal(h.flow.state.error.code,'MODELING_DRAFT_STALE');
    assert.equal(h.calls.some(c=>/conversation-change-(preview|generate|apply|publish)$/.test(c.action)),false);
  }
});

test('context and preview races surface draft invalidation without retaining old confirmation',async()=>{
  for(const stage of ['context','preview']){
    const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();
    const read=h.flow.read;let invalid=false;
    h.flow.read=async(action,input)=>{
      if(action==='conversation-change-'+stage){
        invalid=true;
        if(stage==='context')throw Object.assign(Error('stale'),{code:'MODELING_CHANGE_STALE',status:409});
        return {revision:1,stale_reason:'MODELING_REVIEW_INVALIDATED',items:[],total:0,ready_for_confirmation:false};
      }
      const result=await read.call(h.flow,action,input);
      return invalid&&action==='conversation-change-draft'?{...result,stale_reason:'MODELING_REVIEW_INVALIDATED'}:result;
    };
    h.c.state.preview={revision:1,ready_for_confirmation:true};h.c.state.publishConfirmed=true;
    h.c.state.selected=['fact'];
    if(stage==='context')await h.c.context();else await h.c.preview();
    assert.equal(h.c.state.summary.stale_reason,'MODELING_REVIEW_INVALIDATED');
    assert.equal(h.c.state.preview,null);assert.equal(h.c.state.publishConfirmed,false);assert.deepEqual(h.c.state.selected,[]);
    assert.match(changesPanel(h.flow,'draft'),/合入草稿的抽取结果已失效/);
  }
});

test('a lost proposal response replays the exact original request after reload, never an ordinary message',async()=>{
  const h=fixture();h.db.lose='conversation-change-generate';await h.c.generate();const original=h.calls.find(c=>c.action.endsWith('-generate')).input;
  h.c=h.create();h.flow.state.input='不能替换原要求';await h.c.recover();
  assert.deepEqual(h.calls.filter(c=>c.action.endsWith('-generate')).at(-1).input,original);assert.equal(h.c.record.pending,undefined);
  assert.equal(h.calls.some(c=>c.action==='conversation-send'),false);assert.equal(h.db.status,'prepared');
});

test('initial reading never starts an unsolicited second model request',async()=>{
  const h=fixture();h.flow.state.input='';h.flow.state.detail.status='ready_for_confirmation';
  h.flow.saved.autoRead.i=true;h.flow.saved.analyzed['i:v']=true;h.flow.state.turn={status:'succeeded'};
  await h.c.tick();await h.c.tick();
  assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);
  assert.equal(h.flow.state.error,null);
});

test('reviewed intake resumes existing suggestions after reload without generating another one',async()=>{
  const h=fixture();h.flow.intake={record:{stage:'goal'},sourceReviewed:true};h.flow.state.detail.status='awaiting_review';
  h.c.record.lastProposal='p';h.c.persist();h.db.generated=true;h.db.status='generating';
  await h.c.tick();assert.equal(h.c.state.proposals[0].status,'generating');
  h.db.status='prepared';await h.c.tick();assert.equal(h.c.state.proposals[0].status,'prepared');
  assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);
});

test('publication in progress exposes no follow-up actions; failed receipts retain recovery',()=>{
  const h=fixture();h.c.state.summary={id:'draft',status:'submitted',revision:2,counts:{entity:1,relation:0}};
  h.c.state.publication={status:'running'};
  assert.doesNotMatch(changesPanel(h.flow,'receipt'),/<button/);
  h.c.state.publication={status:'failed'};
  assert.match(changesPanel(h.flow,'receipt'),/change-retry-publication/);
});
test('apply checks current digest, updates only drafts and moves to returned active intent',async()=>{
  const h=fixture();await h.c.generate();h.db.status='stale';await h.c.apply('p');assert.equal(h.calls.some(c=>c.action.endsWith('-apply')),false);
  h.db.status='prepared';await h.c.refresh();h.db.nextIntent='new-intent';await h.c.apply('p');
  assert.equal(h.flow.state.selectedIntent,'new-intent');assert.equal(h.c.record.previousIntent,'i');assert.equal(h.c.record.ontologyDraftId,'rules');
  assert.equal(h.calls.some(c=>/publish|confirm$/.test(c.action)),false);
});
test('fact selection uses real IDs and private editor credentials never enter persisted recovery records',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();h.c.select('invented',true);assert.deepEqual(h.c.state.selected,[]);
  h.c.select('fact',true);h.db.lose='conversation-change-generate';await h.c.generate();
  const input=h.calls.find(c=>c.action.endsWith('-generate')).input;assert.deepEqual(input.selectedItemIds,['fact']);assert.deepEqual(input.editor,editor);
  assert.equal([...h.storage.values()].join('').includes(editor.session),false);
  h.c=h.create();await h.c.recover();assert.equal(h.calls.filter(c=>c.action.endsWith('-generate')).length,1);
  assert.equal(h.flow.state.error.code,'MODELING_CHANGE_RECOVERY_REQUIRED');
  const renewed={session:'r'.repeat(30),generation:'2'};
  h.c.owner={documentId:'doc',draftId:'draft',editor:renewed};await h.c.recover();
  assert.deepEqual(h.calls.filter(c=>c.action.endsWith('-generate')).at(-1).input,{...input,editor:renewed});
  assert.equal(h.c.record.pending,undefined);assert.equal([...h.storage.values()].join('').includes(renewed.session),false);
});

test('deferred and superseded proposals cannot be applied from history',async()=>{
  const h=fixture();await h.c.generate();const before=h.calls.length;
  h.c.defer('p');assert.equal(h.calls.length,before);assert.equal(h.c.record.deferredProposal,'p');
  assert.doesNotMatch(changeHistory(h.flow),/data-cv="change-apply"/);
  await h.c.apply('p');assert.equal(h.calls.some(c=>c.action==='conversation-change-apply'),false);
  delete h.c.record.deferredProposal;h.c.state.proposals.unshift({id:'new',status:'prepared',can_apply:true,result:{changes:[{scope:'rules'}]}});h.c.record.lastProposal='new';
  await h.c.apply('p');assert.equal(h.calls.some(c=>c.action==='conversation-change-apply'),false);
});

test('applying a changed goal keeps the document editing lease on the returned new intent',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor:structuredClone(editor)};h.c.record.draftId='draft';
  await h.c.loadDraft();h.c.select('fact',true);await h.c.generate();h.db.applyDraft='draft';h.db.nextIntent='new-intent';
  await h.c.apply('p');assert.equal(h.flow.state.error,null);assert.equal(h.flow.state.selectedIntent,'new-intent');
  assert.deepEqual(h.c.editor(),editor);assert.equal(h.c.state.summary.revision,2);assert.equal(h.c.record.draftId,'draft');
  assert.equal(h.c.record.application.status,'applied');assert.equal(h.c.record.previousIntent,'i');
  assert.equal(h.c.saved.scopes[JSON.stringify(['c','i'])].pending,undefined);
  h.flow.state.selectedIntent='i';h.c=h.create();
  assert.equal(h.c.record.pending,undefined,'returning to the original intent must not restore a completed apply');
  assert.equal(h.calls.some(c=>/publish|confirm$|editor-claim|editor-release/.test(c.action)),false);
  assert.doesNotMatch([...h.storage.values()].join(''),/ssssssssssssssssssss/);
});

test('a local receipt save failure restores the original intent, editor and proposal before replay',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor:structuredClone(editor)};h.c.record.draftId='draft';
  await h.c.loadDraft();h.c.select('fact',true);await h.c.generate();
  h.db.applyDraft='draft';h.db.nextIntent='new-intent';
  const scope=h.c.scope,save=h.flow.storage.setItem;let writes=0;
  h.flow.state.goalDirty=true;h.flow.state.plan={id:'original-plan'};
  h.flow.storage.setItem=(k,v)=>{if(++writes===2)throw Error('quota');save(k,v);};
  await h.c.apply('p');
  assert.equal(h.flow.state.error.code,'MODELING_LOCAL_SAVE_FAILED');
  assert.equal(h.c.scope,scope);assert.equal(h.flow.state.selectedIntent,'i');
  assert.equal(h.c.state.summary.revision,1);assert.deepEqual(h.c.state.selected,['fact']);
  assert.equal(h.flow.state.goalDirty,true);assert.deepEqual(h.flow.state.plan,{id:'original-plan'});
  assert.deepEqual(h.c.editor(),editor);assert.ok(h.c.record.pending);assert.ok(h.c.pending);
  const original=h.calls.find(c=>c.action==='conversation-change-apply').input;
  await h.c.recover();assert.equal(h.flow.state.error,null);
  assert.equal(h.flow.state.selectedIntent,'new-intent');assert.equal(h.c.state.summary.revision,2);
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-change-apply').at(-1).input,original);
  assert.equal(h.db.revision,2,'recovery must not apply the changes twice');
  assert.equal(h.c.saved.scopes[scope].pending,undefined);assert.equal(h.c.record.pending,undefined);
  assert.doesNotMatch([...h.storage.values()].join(''),/ssssssssssssssssssss/);
});

test('reopening an expired in-memory lease offers explicit recovery instead of retrying stale credentials',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};h.c.record.draftId='draft';await h.c.loadDraft();
  const original=h.flow.read;h.flow.read=async(action,input)=>{
    if(action==='conversation-change-draft')throw Object.assign(Error('expired'),{code:'CORRECTION_LEASE_EXPIRED',status:409});
    if(action==='conversation-editor-session')return {editor_session:'n'.repeat(30)};
    if(action==='conversation-editor-leases')return {items:[{draft_id:'draft',revision:1,status:'editing',legacy_unowned:false}]};
    return original(action,input);
  };
  await h.c.openDraft();assert.equal(h.flow.state.error,null);assert.equal(h.c.state.summary,null);
  assert.equal(h.c.state.leases[0].draft_id,'draft');assert.equal(h.c.owner.editor.session,'n'.repeat(30));
  assert.equal(h.calls.some(c=>c.action==='conversation-editor-claim'),false);
});
test('publication requires server preview and separate confirmation; a submitted task is not published',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();await h.c.publish();assert.equal(h.db.submitted,undefined);
  await h.c.preview();await h.c.publish();assert.equal(h.db.submitted,undefined);
  h.c.state.publishConfirmed=true;await h.c.publish();assert.equal(h.db.submitted,true);assert.equal(h.c.state.publication.effective,false);
});
test('proposal UI escapes instructions, reports sampling and never treats clarification as applicable',async()=>{
  const h=fixture();await h.c.generate();const html=changeHistory(h.flow);assert.ok(html.includes('&lt;合并类型&gt;'));assert.ok(html.includes('仅覆盖部分片段'));assert.ok(html.includes('change-apply'));
  h.c.state.proposals[0].status='needs_clarification';assert.equal(changeHistory(h.flow).includes('data-cv="change-apply"'),false);
});

test('clarification retains the draft and provides a clear answer or return action',async()=>{
  const h=fixture(),{c,flow}=h;c.owner={documentId:'doc',draftId:'draft',editor};
  await c.loadDraft();await c.generate('排除选中事实');
  c.state.proposals[0].status='needs_clarification';c.state.proposals[0].result.questions=['请确认修改范围'];
  const html=proposalPanel(flow)+changesPanel(flow,'proposal-context');
  assert.match(html,/等待你的补充说明/);assert.match(html,/请确认修改范围/);assert.match(html,/甲公司/);
  assert.match(html,/data-cv="change-answer"/);assert.match(html,/data-cv="change-defer"/);
  assert.doesNotMatch(html,/data-cv="change-apply"|>通过对话调整</);
  assert.match(html,/data-cv="change-preview"[^>]*disabled/);
  await c.preview();assert.equal(flow.state.error.code,'MODELING_CHANGE_REVIEW_REQUIRED');
  c.defer('p');await c.preview();assert.equal(flow.state.error,null);
});

test('reopened draft is actionable before a remembered proposal and never silently claims ownership',()=>{
  const {c,flow,calls}=fixture();flow.state.detail.review={draft_id:'draft'};
  c.state.proposals=[{id:'old',status:'prepared',can_apply:true,result:{changes:[{}]}}];
  assert.equal(nextConversationStep(flow),'draft');
  assert.match(changesPanel(flow,'draft'),/data-cv="change-open-draft"/);
  assert.match(changesPanel(flow,'draft'),/继续核对材料/);
  assert.equal(calls.length,0);
  c.state.leases=[{draft_id:'draft',status:'editing',revision:1}];
  assert.match(changesPanel(flow,'draft'),/data-cv="change-claim"/);
  assert.doesNotMatch(changesPanel(flow,'draft'),/data-cv="change-open-draft"/);
});

test('lost publication response is recovered with the original operation and never submitted twice',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();await h.c.preview();h.c.state.publishConfirmed=true;
  h.db.lose='conversation-change-publish';await h.c.publish();const original=h.calls.find(c=>c.action==='conversation-change-publish').input;
  assert.ok(h.c.record.pending);h.c=h.create();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.recover();
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-change-publish').at(-1).input,original);
  assert.equal(h.db.revision,2);assert.equal(h.c.state.summary.status,'submitted');assert.equal(h.c.state.publication.effective,false);
  const generated=h.calls.filter(c=>c.action==='conversation-change-generate').length;await h.c.generate('new change');
  assert.equal(h.calls.filter(c=>c.action==='conversation-change-generate').length,generated);
});

test('retry publication accepts submitted receipt and further edits use a fresh draft from published knowledge',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor:structuredClone(editor)};h.db.submitted=true;h.db.publication='failed';
  await h.c.loadDraft();await h.c.retryPublication();assert.equal(h.flow.state.error,null);assert.equal(h.c.state.publication.status,'queued');assert.equal(h.c.state.publication.effective,false);
  await h.c.newDraft();assert.equal(h.calls.some(c=>c.action==='conversation-change-draft-create'),false);
  h.db.publication='succeeded';await h.c.loadDraft();await h.c.newDraft();
  assert.equal(h.flow.state.error,null);assert.equal(h.c.state.summary.id,'next-draft');assert.equal(h.c.record.draftId,'next-draft');assert.equal(h.c.state.publication,null);
});

test('storage failure never bypasses durable request saving or unlocks a committed operation',async()=>{
  const h=fixture(),save=h.flow.storage.setItem;let fail=true;
  h.flow.storage.setItem=(k,v)=>{if(fail)throw Error('quota');save(k,v);};
  await h.c.generate();const operation=h.c.record.pending.input.operationId;await h.c.recover();
  assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);
  fail=false;await h.c.recover();assert.equal(h.calls.find(c=>c.action==='conversation-change-generate').input.operationId,operation);
  let writes=0;h.flow.storage.setItem=(k,v)=>{if(++writes===2)throw Error('quota');save(k,v);};
  await h.c.generate('second');const pending=structuredClone(h.c.record.pending);
  assert.equal(h.flow.state.error.code,'MODELING_LOCAL_SAVE_FAILED');assert.ok(h.c.pending);
  await h.c.recover();assert.deepEqual(h.calls.filter(c=>c.action==='conversation-change-generate').at(-1).input,pending.input);
  assert.equal(h.c.record.pending,undefined);
});

test('a changed draft stops generation instead of silently clearing the selected fact scope',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();h.c.select('fact',true);
  h.c.state.source={text:'old evidence'};h.db.revision++;
  await h.c.generate('change selected fact');
  assert.equal(h.flow.state.error.code,'MODELING_CHANGE_STALE');assert.equal(h.c.state.source,null);
  assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);
  assert.equal(h.flow.state.input,'<合并类型>');
});

test('restoring an extracting material does not request an uneditable change context or stop polling',async()=>{
  const h=fixture();h.flow.state.detail.status='running';await h.c.tick();
  assert.ok(!h.flow.state.error);assert.equal(h.calls.length,0);
  h.flow.state.detail.status='awaiting_review';await h.c.tick();
  assert.ok(h.calls.some(c=>c.action==='conversation-change-context'));
});

test('unavailable historical proposals cannot break an authorized current context or retain old content',async()=>{
  const h=fixture();await h.c.generate();const read=h.flow.read;
  h.flow.read=async(action,input)=>{if(action==='conversation-change-read')throw Object.assign(Error('retired'),{status:404,code:'MODELING_RESOURCE_NOT_FOUND'});return read.call(h.flow,action,input);};
  await h.c.refresh();assert.equal(h.flow.state.error,null);assert.equal(h.c.state.proposals[0].status,'unavailable');assert.equal(h.c.state.proposals[0].result,undefined);
  assert.ok(h.c.state.context);assert.equal(changeHistory(h.flow).includes('data-cv="change-apply"'),false);
});

test('goal changes preserve access to the material draft under the new intent',async()=>{
  const h=fixture();h.c.applied({active_intent_id:'new',draft_id:'draft',ontology_draft_id:'rules'},'i');h.c.bind();
  assert.equal(h.c.record.draftId,'draft');await h.c.context();assert.equal(h.c.state.needsDraft,true);
  assert.ok(changesPanel(h.flow).includes('data-cv="change-open-draft"'));assert.equal(h.calls.length,0);
});

test('switching to another draft of the same revision invalidates the old publication preview',async()=>{
  const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};await h.c.loadDraft();await h.c.preview();h.c.state.publishConfirmed=true;
  h.c.owner.draftId='other';await h.c.loadDraft();assert.equal(h.c.state.preview,null);assert.equal(h.c.state.publishConfirmed,false);
});

test('later correction publication reads the effective run and rejects a race with another publication',async()=>{
  for(const race of [false,true]){
    const h=fixture();h.c.owner={documentId:'doc',draftId:'draft',editor};h.db.submitted=true;
    const detail={...h.flow.state.detail,status:'awaiting_review',outcome:{current_run_id:'new-run',publication:{run_id:'old-run',status:'succeeded',effective:false}}};
    const publication={id:'submission',status:'succeeded',effective:true,run_status:'published',document_version_id:'v'};
    const read=h.flow.read;let intents=0;
    h.flow.read=async(action,input)=>{
      if(action==='conversation-change-draft')return {id:'draft',document_version_id:'v',revision:1,status:'submitted',counts:{entity:1,relation:0}};
      if(action==='conversation-change-publication')return publication;
      if(action==='conversation-intent'){intents++;return race&&intents>1?{...detail,outcome:{...detail.outcome,current_run_id:'other-run'}}:detail;}
      if(action==='conversation-published-run')return {run:{id:'new-run',status:'published',document_id:'doc',document_version_id:'v'},candidates:[]};
      return read.call(h.flow,action,input);
    };
    if(race){await assert.rejects(h.c.loadDraft(),{code:'MODELING_SNAPSHOT_CHANGED'});assert.equal(h.flow.state.knowledge,undefined);}
    else {await h.c.loadDraft();assert.equal(knowledgeCurrent(detail,h.flow.state.knowledge),true);
      assert.equal(knowledgeCurrent({...detail,outcome:{current_run_id:'other-run'}},h.flow.state.knowledge),false);}
  }
});

test('a rule draft already published elsewhere is cleared before reading the new context',async()=>{
  const h=fixture();h.c.record.ontologyDraftId='rules';h.flow.state.ontology={id:'rules',status:'published'};
  await h.c.context();assert.equal(h.calls.find(c=>c.action==='conversation-change-context').input.ontologyDraftId,undefined);
  assert.equal(h.c.record.ontologyDraftId,undefined);
});

test('a different pending mutation cannot be replayed under a new action',async()=>{
  const h=fixture();h.db.lose='conversation-change-generate';await h.c.generate();const count=h.calls.length;
  await assert.rejects(h.c.request('rule-publish',{ontologyId:'rules'}),{code:'MODELING_REQUEST_PENDING'});
  assert.equal(h.calls.length,count);
});
