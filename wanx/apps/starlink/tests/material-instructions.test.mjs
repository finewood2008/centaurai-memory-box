import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {conversationRequest,conversationActions} from '../shared/conversation-contract.mjs';
import {instructionActions} from '../shared/conversation-instruction-contract.mjs';
import {SemanticaService} from '../shell/service.mjs';
import {instructionPanel} from '../ui/material-instructions-view.mjs';
import {nextConversationStep} from '../ui/conversation-next.mjs';
const clone=structuredClone,hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const editor={session:'s'.repeat(30),generation:'1'};
const base={warehouseId:'w',conversationId:'c',operationId:'op'};
test('all seven instruction routes are finite, strict and preserve Host authority and confirmation',async()=>{
  assert.equal(instructionActions.size,7);const sent=[];
  const service=new SemanticaService({host:{context:async()=>({boxId:'b',user:{id:1},dataScope:'personal'}),onSessionInvalidated:()=>()=>{},request:async(path,options)=>{sent.push({path,...options});return new Response('{}');}}});
  const scoped={intentId:'i',draftId:'draft',selectedItemIds:['fact'],allowedScopes:['question','facts'],editor};
  const cases={context:scoped,interpret:{...scoped,contextDigest:hash('context'),instruction:'这个是产品名称'},list:{intentId:'i'},read:{planId:'p'},prepare:{planId:'p',revision:1},confirm:{planId:'p',revision:1,stepDigest:hash('step'),confirmed:true},abandon:{planId:'p',revision:1}};
  for(const [kind,options] of Object.entries(cases)){
    const action='conversation-instruction-'+kind;assert.ok(conversationActions.has(action));
    const input={...base,...options},request=conversationRequest(action,input);await service.call(action,input);
    assert.equal(sent.at(-1).path,'/api/semantica'+request.path);assert.deepEqual(sent.at(-1).body,request.body);
    assert.equal(request.body._native_operation_id,'op');assert.equal(request.body.operation_id,['interpret','prepare','confirm','abandon'].includes(kind)?'op':undefined);
    assert.throws(()=>conversationRequest(action,{...input,workspace_id:'injected'}));
  }
  for(const override of [{confirmed:false},{stepDigest:null},{stepDigest:'A'.repeat(64)},{revision:0}])assert.throws(()=>conversationRequest('conversation-instruction-confirm',{...base,...cases.confirm,...override}));
  for(const override of [{editor:undefined},{selectedItemIds:['fact','fact']},{selectedItemIds:Array.from({length:21},(_,i)=>'f'+i)},{allowedScopes:['goal']},{allowedScopes:[]},{instruction:'x'.repeat(4001)}])assert.throws(()=>conversationRequest('conversation-instruction-interpret',{...base,...cases.interpret,...override}));
});
function fixture(storage=new Map(),database=null){
  let sequence=0;const calls=[],receipts=new Map();
  const db=database||{revision:1,item:{id:'fact',kind:'entity',payload:{name:'.bkn声明文件',type:'FEATURE',properties:{}},evidence:[]},plans:{},mode:'ready',applied:0,published:0};
  const flow=new ConversationFlow({warehouseId:'w',identity:{user:{id:1}},storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},uuid:()=>`op-${++sequence}`,call:async(action,input)=>{
    conversationRequest(action,input);calls.push({action,input:clone(input)});
    const kind=action.replace('conversation-instruction-','');let result;
    if(action.startsWith('conversation-instruction-')){
      if(kind==='context')return {context_digest:hash([db.revision,input.selectedItemIds,input.allowedScopes]),business_mutation_performed:false};
      if(kind==='read')return clone(db.plans[input.planId]);
      if(kind==='list')return {items:Object.values(db.plans).map(clone)};
      if(receipts.has(input.operationId))return clone(receipts.get(input.operationId));
      if(kind==='interpret'){
        const id='p'+Object.keys(db.plans).length,step={id:'1',kind:'change',scope:'facts',status:'pending',instruction:input.instruction,depends_on:[],requires_confirmation:true};
        result=db.plans[id]={resource_id:id,conversation_id:'c',revision:1,status:db.mode,instruction:input.instruction,context_digest:input.contextDigest,context:{draft_id:input.draftId,selected_item_ids:input.selectedItemIds},steps:db.mode==='ready'?[step]:[],next_step_id:db.mode==='ready'?'1':null,interpretation:{summary:'建议将选中条目从功能模块调整为产品',questions:db.mode==='needs_clarification'?['你说的是哪一类产品？']:[]}};
        if(db.compound){result.steps.push({id:'2',kind:'extract',scope:'current_material',mode:'dialogue',status:'pending',depends_on:['1'],requires_confirmation:true});}
      }else{
        const plan=db.plans[input.planId];assert.equal(input.revision,plan.revision);
        const step=plan.steps.find(s=>!['completed','abandoned'].includes(s.status));
        if(kind==='prepare'){
          step.status=db.block?'blocked':'prepared';step.step_digest=hash([plan.resource_id,plan.revision,db.revision]);
          step.preview=step.kind==='change'?{id:'child-'+plan.resource_id,status:db.block?'needs_clarification':'prepared',can_apply:!db.block,result:{summary:'仅修正所选条目的分类',questions:db.block?['请补充产品的业务含义']:[],changes:db.block?[]:[{scope:'facts',item_id:'fact',before:clone(db.item),after:{...clone(db.item),payload:{...clone(db.item.payload),type:'PRODUCT'}},reason:'根据用户对当前条目的说明'}]}}:{can_confirm:true,publication_policy:'review_required'};
          if(db.block)plan.status='blocked';result=plan;
        }else if(kind==='confirm'){
          assert.equal(input.stepDigest,step.step_digest);assert.equal(input.confirmed,true);assert.equal(step.status,'prepared');
          step.status='completed';step.receipt=step.kind==='change'?{status:'applied',active_intent_id:'i',draft_id:'draft',draft_revision:++db.revision,publication_performed:false,extraction_started:false}:{receipt:{document_id:'doc',transition_id:'transition'},current:{is_current:true,stage:'queued'}};
          if(step.kind==='change'){db.item.payload.type='PRODUCT';db.applied++;}
          plan.revision++;plan.context_digest=hash([db.revision,plan.context.selected_item_ids,['question','facts']]);
          plan.next_step_id=plan.steps.find(s=>s.status!=='completed')?.id||null;plan.status=plan.next_step_id?'ready':'completed';
          result={resource_id:plan.resource_id,revision:plan.revision,step_id:step.id,receipt:clone(step.receipt)};
        }else if(kind==='abandon'){
          plan.steps.forEach(s=>{if(s.status!=='completed')s.status='abandoned';});plan.status='abandoned';plan.revision++;result={resource_id:plan.resource_id,revision:plan.revision,status:'abandoned'};
        }
      }
      receipts.set(input.operationId,clone(result));
      if(db.lose===kind){db.lose=null;throw Object.assign(Error('lost'),{code:'SEMANTICA_CONNECTION_FAILED',status:0});}
      return clone(result);
    }
    if(action==='conversation-change-draft')return {id:'draft',revision:db.revision,status:'editing',counts:{entity:1,relation:0}};
    if(action==='conversation-change-items')return {items:[clone(db.item)],revision:db.revision,total:1,offset:0};
    if(action==='conversation-change-context')return {context_digest:hash('legacy'),recent_proposals:db.childInContext?[{id:'child-p0'}]:[],schema:flow.state.ontology.schema};
    if(action==='conversation-change-preview')return {revision:db.revision,items:db.applied?[{scope:'facts',item_id:'fact',after:clone(db.item)}]:[],total:db.applied?1:0,issues:[],ready_for_confirmation:true};
    if(action==='conversation-change-publish'){db.published++;return {draft_id:'draft',status:'submitted'};}
    throw Error('Unexpected '+action);
  }});
  flow.saved.conversationId='c';Object.assign(flow.state,{loaded:true,selectedIntent:'i',detail:{id:'i',document_id:'doc',document_version_id:'v',source_status:'available',status:'awaiting_review',execution:{status:'succeeded'},goal:{goal:'整理产品知识'}},overview:{id:'c',revision:1},ontology:{id:'o',schema:{entity_types:[{name:'FEATURE',label:'功能模块'},{name:'PRODUCT',label:'产品'}]}}});
  flow.snapshot=async()=>{};flow.changes.bind();flow.changes.owner={documentId:'doc',draftId:'draft',editor};
  flow.changes.record.draftId='draft';flow.changes.state.summary={id:'draft',revision:db.revision,status:'editing',counts:{entity:1,relation:0}};
  flow.changes.state.items={items:[clone(db.item)],revision:db.revision};flow.changes.state.selected=['fact'];
  return {flow,db,calls,storage};
}
test('a selected declarative utterance produces a scoped preview, then explicit application and separate publication',async()=>{
  const h=fixture(),{flow:f,db}=h;f.state.input='这个是产品名称';await f.submitInput();assert.equal(f.state.error,'');
  const interpreted=h.calls.find(c=>c.action==='conversation-instruction-interpret');
  assert.equal(interpreted.input.instruction,'这个是产品名称');assert.deepEqual(interpreted.input.selectedItemIds,['fact']);assert.equal(interpreted.input.draftId,'draft');
  assert.equal(db.applied,0);assert.equal(db.published,0);assert.equal(db.item.payload.type,'FEATURE');assert.equal(nextConversationStep(f),'instruction');
  const html=instructionPanel(f);assert.match(html,/功能模块/);assert.match(html,/产品/);assert.match(html,/确认应用到草稿/);assert.doesNotMatch(html,/data-cv="change-apply"/);
  await f.changes.preview();assert.equal(f.state.errorCode,'MODELING_CHANGE_REVIEW_REQUIRED');
  f.state.input='下一步';await f.submitInput();assert.equal(db.applied,0);assert.equal(db.published,0);
  f.state.input='确认应用到草稿';await f.submitInput();assert.equal(f.state.error,'');assert.equal(db.applied,1);assert.equal(db.item.payload.type,'PRODUCT');assert.equal(db.published,0);assert.equal(f.instructions.open,false);assert.equal(f.changes.state.summary.revision,2);
  await f.changes.preview();assert.equal(f.changes.state.preview.total,1);assert.equal(db.published,0);
  await f.changes.publish();assert.equal(db.published,0);f.changes.state.publishConfirmed=true;
  // Stop immediately after publication acceptance; task completion is a separate read.
  f.changes.loadDraft=async()=>{};await f.changes.publish();assert.equal(f.state.error,'');assert.equal(db.published,1);
  assert.doesNotMatch([...h.storage.values()].join(''),/ssssssssssssssssssss|_native_editor/);
});
test('clarification links the original plan and original item context; no business write occurs',async()=>{
  const h=fixture(),f=h.flow;h.db.mode='needs_clarification';f.state.input='这个是产品名称';await f.submitInput();
  const original=f.instructions.plan.resource_id;assert.match(instructionPanel(f),/你说的是哪一类产品/);
  h.db.mode='ready';f.state.input='这是我们公司的产品，请归到产品分类';await f.submitInput();assert.equal(f.state.error,'');
  const calls=h.calls.filter(c=>c.action==='conversation-instruction-interpret');assert.equal(calls[1].input.clarificationPlanId,original);assert.deepEqual(calls[1].input.selectedItemIds,['fact']);assert.equal(h.db.applied,0);
});
test('refining a prepared suggestion abandons only pending work and combines context before another preview',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();const id=f.instructions.plan.resource_id;
  f.state.input='名称先不改，只修改分类';await f.submitInput();assert.equal(f.state.error,'');assert.equal(h.db.plans[id].status,'abandoned');
  assert.match(h.calls.filter(c=>c.action==='conversation-instruction-interpret').at(-1).input.instruction,/这个是产品名称.*\n|这个是产品名称/);
  assert.match(h.calls.filter(c=>c.action==='conversation-instruction-interpret').at(-1).input.instruction,/名称先不改/);assert.equal(h.db.applied,0);assert.equal(h.db.revision,1);
});
test('lost confirm response recovers the exact operation once and never publishes',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();h.db.lose='confirm';await f.instructions.confirm();
  assert.equal(h.db.applied,1);assert.ok(f.changes.record.pending);const pending=clone(f.changes.pending);
  await f.changes.recover();assert.equal(f.state.error,'');assert.equal(h.db.applied,1);assert.equal(f.changes.record.pending,undefined);assert.equal(h.db.published,0);
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-instruction-confirm').map(c=>c.input),[pending.input,pending.input]);
});
test('restart recovers an accepted private step from its receipt rather than replaying under a new editor',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();h.db.lose='confirm';await f.instructions.confirm();
  const r=fixture(h.storage,h.db),g=r.flow;g.changes.owner.editor={session:'new-session-'.padEnd(30,'x'),generation:'2'};
  await g.changes.recover();assert.equal(g.state.error,'');assert.equal(h.db.applied,1);assert.equal(r.calls.some(c=>c.action==='conversation-instruction-confirm'),false);assert.equal(g.changes.record.pending,undefined);
});
test('publication, child proposal apply and a second submit are blocked by an unresolved original write',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';h.db.lose='interpret';await f.submitInput();
  const original=clone(f.changes.record.pending);assert.ok(original);f.state.input='改成文档';await f.submitInput();
  assert.deepEqual(f.changes.record.pending,original);assert.equal(f.state.input,'改成文档');
  await f.changes.recover();assert.equal(f.state.error,'');await f.instructions.prepare();
  await f.changes.apply('child-p0');assert.equal(f.state.errorCode,'MODELING_CHANGE_REVIEW_REQUIRED');assert.equal(h.db.applied,0);
  await f.instructions.abandon();assert.equal(f.state.error,'');assert.equal(h.db.applied,0);assert.equal(f.instructions.open,false);
});
test('context changes revoke confirmation and retain the user request instead of overwriting newer facts',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();
  h.db.plans.p0.steps[0].step_digest=hash('changed');await f.instructions.confirm();assert.equal(f.state.errorCode,'INSTRUCTION_PLAN_STALE');assert.equal(h.db.applied,0);
  h.db.revision++;f.state.input='名称先不改';await f.submitInput();assert.equal(f.state.errorCode,'CORRECTION_REVISION_CONFLICT');assert.equal(f.state.input,'名称先不改');assert.equal(h.db.plans.p0.status,'ready');
});
test('an unchanged draft of the same published version cannot be republished as a successful chat edit',async()=>{
  const h=fixture(),f=h.flow;f.state.dialogueWorkflow={document_id:'doc',document_version_id:'v',publication:{id:'run',status:'published',document_version_id:'v'}};
  await f.changes.preview();assert.equal(f.state.error,'');assert.equal(f.changes.state.preview.unchanged_published,true);assert.equal(f.changes.state.preview.ready_for_confirmation,false);
  f.changes.state.publishConfirmed=true;await f.changes.publish();assert.equal(h.db.published,0);
  f.state.dialogueWorkflow=null;await f.changes.preview();assert.equal(f.changes.state.preview.ready_for_confirmation,true,'first publication remains available');
});
test('a multi-step plan never prepares or confirms the next write without another explicit action',async()=>{
  const h=fixture(),f=h.flow;h.db.compound=true;f.state.input='调整条目后继续处理';await f.submitInput();await f.instructions.confirm();assert.equal(f.state.error,'');
  assert.equal(f.instructions.open,true);assert.equal(f.instructions.step.status,'pending');assert.equal(h.calls.filter(c=>c.action==='conversation-instruction-prepare').length,1);
  await f.instructions.prepare();assert.equal(f.instructions.step.status,'prepared');assert.match(instructionPanel(f),/确认开始抽取/);assert.equal(h.calls.filter(c=>c.action==='conversation-instruction-confirm').length,1);
});
test('blocked and unsupported interpretations show their questions without partially applying anything',async()=>{
  for(const mode of ['blocked','unsupported']){
    const h=fixture(),f=h.flow;if(mode==='blocked')h.db.block=true;else h.db.mode='unsupported';
    f.state.input='调整这个内容';await f.submitInput();assert.equal(f.state.error,'');assert.equal(f.instructions.plan.status,mode);assert.equal(h.db.applied,0);assert.equal(h.db.published,0);assert.doesNotMatch(instructionPanel(f),/data-cv="instruction-confirm"/);
  }
});
test('a private recovery after restart first explicitly restores the lease, then reads the accepted receipt',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();h.db.lose='confirm';await f.instructions.confirm();
  const r=fixture(h.storage,h.db),g=r.flow;g.changes.owner=null;g.changes.resetView();const raw=g.call;
  g.call=async(action,input)=>{
    if(action==='conversation-editor-session')return {editor_session:'new-session-'.padEnd(30,'x')};
    if(action==='conversation-editor-leases')return {items:[{draft_id:'draft',revision:h.db.revision,status:'editing',legacy_unowned:false}]};
    if(action==='conversation-editor-claim')return {draft_id:'draft',revision:h.db.revision,lease_generation:2};
    return raw(action,input);
  };
  await g.changes.recover();assert.equal(g.state.errorCode,'MODELING_CHANGE_RECOVERY_REQUIRED');assert.ok(g.changes.record.pending);
  await g.changes.openDraft();assert.equal(g.state.error,'');assert.equal(g.changes.state.leases.length,1);
  await g.changes.claim('draft');assert.equal(g.state.error,'');assert.equal(g.changes.editor().generation,'2');assert.ok(g.changes.record.pending);
  await g.changes.recover();assert.equal(g.state.error,'');assert.equal(h.db.applied,1);assert.equal(g.changes.record.pending,undefined);assert.equal(r.calls.some(c=>c.action==='conversation-instruction-confirm'),false);
});
test('reopened pending previews do not become legacy apply buttons and cancel preserves the saved draft',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();f.changes.suspend();
  assert.equal(f.instructions.plan,undefined);assert.equal(f.instructions.open,true);assert.match(instructionPanel(f),/恢复草稿编辑/);
  f.changes.owner={documentId:'doc',draftId:'draft',editor};await f.changes.loadDraft();await f.instructions.refresh();h.db.childInContext=true;await f.changes.context();
  assert.deepEqual(f.changes.state.proposals,[]);await f.instructions.abandon();assert.equal(f.state.error,'');assert.equal(h.db.revision,1);assert.equal(f.instructions.open,false);assert.equal(f.changes.record.draftId,'draft');
});
test('changed source binding and unrelated past publication do not authorize processing on the wrong baseline',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';f.snapshot=async()=>{f.state.detail.document_version_id='new-version';};
  await f.submitInput();assert.equal(f.state.errorCode,'MODELING_SNAPSHOT_CHANGED');assert.equal(h.calls.some(c=>c.action==='conversation-instruction-interpret'),false);assert.equal(f.state.input,'这个是产品名称');
  f.state.dialogueWorkflow={document_id:'doc',document_version_id:'new-version',publication:{id:'old',status:'published',document_version_id:'v'}};
  await f.changes.preview();assert.equal(f.changes.state.preview.unchanged_published,false);assert.equal(f.changes.state.preview.ready_for_confirmation,true);
  f.state.dialogueWorkflow.publication.document_version_id='new-version';f.changes.state.summary.ontology_status='draft';
  const load=f.changes.loadDraft.bind(f.changes);f.changes.loadDraft=async()=>{await load();f.changes.state.summary.ontology_status='draft';};
  await f.changes.preview();assert.equal(f.changes.state.preview.ready_for_confirmation,true,'a bound rule draft still needs publication even with zero fact differences');
});
test('questions stay read-only and a semantic question handoff preserves the exact utterance',async()=>{
  const h=fixture(),f=h.flow;let asked=null;f.send=async()=>{asked=f.state.input;};
  f.state.input='为什么分类为功能模块？';await f.submitInput();assert.equal(asked,'为什么分类为功能模块？');assert.equal(h.calls.length,0);
  h.db.mode='handoff';f.write=async(action,input)=>{assert.equal(action,'conversation-send');asked=input.content;};f.state.input='介绍一下这个产品';await f.instructions.submit();
  assert.equal(f.state.error,'');assert.equal(asked,'介绍一下这个产品');assert.equal(f.instructions.open,false);assert.equal(h.db.applied,0);
});
test('changing the selected objects after preview stops confirmation of the previous objects',async()=>{
  const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();f.changes.state.selected=['other'];
  await f.instructions.confirm();assert.equal(f.state.errorCode,'INSTRUCTION_PLAN_STALE');assert.equal(h.db.applied,0);assert.equal(h.calls.some(c=>c.action==='conversation-instruction-confirm'),false);
});
test('a replacement step requires separate impact acknowledgement and never treats acceptance as publication',async()=>{
  const h=fixture(),f=h.flow;h.db.compound=true;f.state.input='调整内容';await f.submitInput();await f.instructions.confirm();await f.instructions.prepare();
  h.db.plans.p0.steps[1].preview.replacement={requires_acknowledgement:true,acknowledgement_digest:hash('impact'),draft_count:1,preserves_history:true};
  h.db.plans.p0.steps[1].step_digest=hash('replacement-step');await f.instructions.refresh();assert.match(instructionPanel(f),/cv-instruction-ack/);
  await f.instructions.confirm();assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_ACK_REQUIRED');assert.equal(h.calls.filter(c=>c.action==='conversation-instruction-confirm').length,1);
  f.changes.state.instructionAcknowledged=true;await f.instructions.confirm();assert.equal(f.state.error,'');assert.equal(h.calls.filter(c=>c.action==='conversation-instruction-confirm').at(-1).input.replacementAcknowledgement,hash('impact'));assert.equal(h.db.published,0);assert.match(f.state.inputNotice,/任务已提交，尚未完成/);
});
test('a prepared step cannot confirm a rejected or conflicted child proposal, including a reread race',async()=>{
  for(const stage of ['shown','reread']){
    const h=fixture(),f=h.flow;f.state.input='这个是产品名称';await f.submitInput();
    const preview=stage==='shown'?f.instructions.step.preview:h.db.plans.p0.steps[0].preview;
    preview.can_apply=false;preview.status='failed';preview.result.conflicts=[{message:'分类与关联关系冲突'}];
    await f.instructions.confirm();assert.equal(f.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');assert.equal(h.db.applied,0);assert.equal(h.calls.some(c=>c.action==='conversation-instruction-confirm'),false);
    assert.doesNotMatch(instructionPanel(f),/data-cv="instruction-confirm"/);
  }
});
