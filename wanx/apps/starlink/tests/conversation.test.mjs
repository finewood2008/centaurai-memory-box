import test from 'node:test';
import assert from 'node:assert/strict';
import {materialProgress,knowledgeCurrent,extractionProgress} from '../ui/conversation-progress.mjs';
import {materialStatusHTML,ontologyStage,knowledgeStage} from '../ui/conversation-stages.mjs';
import {ConversationFlow,currentReply,messageReply} from '../ui/conversation-state.mjs';
import {conversationThread,conversationGoal,conversationTime,editorRecoveryHTML,conversationTimeline} from '../ui/conversation-view.mjs';
import {conversationInputRoute,nextConversationStep} from '../ui/conversation-next.mjs';
import {conversationHTML} from '../ui/conversation.js';
import {materialListHTML} from '../ui/material-workspace.mjs';
import {goalDialogueText} from '../ui/material-goal-dialogue.mjs';
test('an unfinished import explains the inaccessible warehouse and links to its management page',()=>{
  const html=conversationHTML({id:'warehouse',state:'import_failed'});
  assert.match(html,/迁入未完成/);
  assert.match(html,/data-view="data"/);
  assert.doesNotMatch(html,/请先选择一座可用的知识仓/);
});
test('conversation time labels omit malformed values instead of leaking raw IDs or ISO strings',()=>{
  assert.equal(conversationTime('invalid'),'');assert.equal(conversationTime(null),'');
  assert.match(conversationTime('2026-11-06T10:24:00Z'),/^\d{2}:\d{2}$/);
  assert.doesNotMatch(conversationTime('2026-11-06T10:24:00Z',true),/T|Z|00\+00/);
});
const clone=structuredClone;
test('an old modification classification does not remain as an unwritten-draft notice after editing starts',async()=>{
  const h=await preparedIntakeGoal(),f=h.flow;
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'请补充业务含义',modification_intent:{kind:'ambiguous'}}};
  await f.refresh();
  assert.match(conversationThread(f),/当前仍在明确材料整理目标/);
  f.changes.state.summary={id:'draft',status:'editing',revision:1};
  assert.doesNotMatch(conversationThread(f),/助手识别到了修改意图|尚未写入草稿|当前仍在明确材料整理目标/);
  f.changes.state.summary=null;f.intake.record.goalTurnId='another-turn';
  assert.doesNotMatch(conversationThread(f),/当前仍在明确材料整理目标/);
});
test('confirmation text at the initial goal stage never becomes goal dialogue',async()=>{
  const h=await preparedIntakeGoal();const before=h.calls.length;
  h.flow.state.input='确认发布';await h.flow.submitInput();
  assert.equal(h.calls.length,before);assert.match(h.flow.state.inputNotice,/确认按钮/);assert.equal(h.flow.state.input,'确认发布');
});
test('operation plus context at the goal stage is preserved without sending a goal or starting extraction',async()=>{
  const h=await preparedIntakeGoal();const before=h.calls.length;
  for(const text of ['下一步，整理供应链','重新抽取，供应链相关内容','删除甲公司']){
    h.flow.state.input=text;await h.flow.submitInput();assert.equal(h.calls.length,before);assert.equal(h.flow.state.input,text);
    assert.match(h.flow.state.inputNotice,/多个操作|明确修改对象/);
  }
});
test('a new fact edit on a published material can enter editing despite a cached submitted draft',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');const f=h.flow;
  f.state.dialogueWorkflow={document_id:'doc',document_version_id:f.state.detail.document_version_id,stage:'published',publication:{id:'run',status:'published',document_version_id:f.state.detail.document_version_id}};
  f.changes.state.summary={id:'old',status:'submitted',revision:1};let opened=0;
  f.changes.editMaterial=async()=>{opened++;};f.state.input='修改这个实体的名称';await f.submitInput();
  assert.equal(opened,1);assert.equal(f.state.input,'修改这个实体的名称');assert.match(f.state.inputNotice,/修改要求已保留/);
});
test('a pending proposal request keeps its original composer target when another change is sent',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');const f=h.flow;
  f.changes.setTarget('rules');f.state.composerContext='rules';f.changes.record.pending={action:'conversation-change-generate',input:{operationId:'original'}};
  f.state.input='修改整理目标为供应链';await assert.doesNotReject(()=>f.submitInput());
  assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');assert.equal(f.changes.record.changeTarget,'rules');
  assert.equal(f.state.composerContext,'rules');assert.equal(f.changes.record.pending.input.operationId,'original');
  assert.equal(f.state.input,'修改整理目标为供应链');
});
function fixture(storage=new Map(),actor=1){
  let sequence=0,current=true;
  const calls=[],receipts=new Map();
  const db={conversation:null,messages:[],intents:[],turn:null,lose:null,refuse:null,uploads:0,stamp:'base',revision:1};
  const overview=()=>({...db.conversation,revision:db.revision,input_generation:db.messages.length,source_stamp:db.stamp,
    latest_turn:db.turn,active_attachment_count:db.intents.length,limits:{attachments:5,message_chars:8000}});
  const call=async(action,input)=>{
    calls.push({action,input:clone(input)});
    if(action==='conversation-ontologies')return {items:[{id:db.ontologyId||'ontology',name:'合同规则',version_number:2,status:'published',schema:{entity_types:[],relation_types:[]}}]};
    if(action==='conversation-published-run')return clone(db.knowledge);
    if(action==='select-files')return db.files||[{handle:'file',name:'材料.txt'}];
    if(action==='release-files')return {released:true};
    if(action==='document')return clone(db.sourceSegments?{document:{id:'doc',segment_count:db.sourceSegments.length},version:{id:'version',version_number:1},segments:db.sourceSegments.slice(input.offset||0,(input.offset||0)+100)}:db.source||{document:{id:'doc',segment_count:1},version:{id:'version',version_number:1},segments:[{id:'segment',text:'解析出的正文。'}]});
    if(action==='workbench-request'&&db.fullText){
      const url=new URL(input.url,'http://fixture'),start=Number(url.searchParams.get('start')),end=Math.min(Number(url.searchParams.get('end')),Array.from(db.fullText).length);
      return {document_id:'doc',version_id:db.rangeVersion||'version',start,end,total_chars:Array.from(db.fullText).length,text:Array.from(db.fullText).slice(start,end).join(''),locators:[{segment_id:'segment',start:0,end:Array.from(db.fullText).length}]};
    }
    if(action==='documents')return {items:[{id:'doc',original_name:'原材料'}],total:1};
    if(action==='conversation-material-workflow')return db.workflow||{document_id:'doc',document:{id:'doc'},conversations:db.intents.filter(i=>i.document_id==='doc').map(i=>({intent_id:i.id,conversation_id:'conversation',conversation_status:'active'}))};
    if(action==='conversation-list')return {items:db.conversation?[db.conversation]:[],has_more:false,next_offset:1};
    if(action==='conversation-get')return overview();
    if(action==='conversation-messages')return {items:clone(db.messages),has_more:false,next_sequence:db.messages.length};
    if(action==='conversation-intents')return {items:clone(db.intents),has_more:false,next_offset:db.intents.length};
    if(action==='conversation-intent')return clone(db.intents.find(i=>i.id===input.intentId));
    if(action==='conversation-turn')return clone(db.turn);
    if(action==='conversation-plan')return {intent_id:'intent',revision:db.intents[0].revision,conversation_revision:db.revision,
      document_version_id:'version',ontology_id:db.ontologyId||'ontology',publication_policy:'review_required',plan_digest:'a'.repeat(64),goal:db.intents[0].goal,processing:{extraction:{name:'synthetic'}}};
    if(action==='conversation-candidates')return {execution_id:db.intents[0].execution?.id,items:[{kind:'entity',payload:{name:'<药品>'},evidence:[]}],offset:input.offset,total:1};
    if(action==='conversation-change-draft')return {id:input.draftId,revision:db.draftRevision||1,status:db.draftStatus||'editing',counts:{entity:1,relation:0},document_version_id:'version'};
    if(action==='conversation-change-items')return {revision:db.draftRevision||1,items:[{id:'fact',kind:'entity',payload:{name:'甲公司',type:'ORG'},evidence:[{segment_id:'segment',excerpt:'甲公司签订合同'}]}],offset:0,total:1};
    if(action==='conversation-change-context')return {context_digest:'a'.repeat(64),ontology_id:'ontology',base_ontology_id:'ontology',recent_proposals:[],schema:{entity_types:[],relation_types:[]}};
    if(action==='conversation-editor-session')return {editor_session:'s'.repeat(30)};
    if(action==='conversation-editor-leases')return {items:clone(db.leases||[])};
    if(action==='conversation-review-plan')return {plan_digest:'b'.repeat(64),draft_id:input.draftId||null,draft_revision:input.draftId?4:0,removed_count:0,
      counts:{add:1,reuse:0,defer:1},decisions:[],offset:0,total:0};
    if(action==='upload'&&db.invalidFile)throw Object.assign(Error(),{code:db.invalidFile});
    if(db.refuse===action)throw Object.assign(Error(),{code:'MODELING_PLAN_CHANGED',status:409});
    const operation=input.operationId||'upload';let value=receipts.get(operation);
    if(!value){
      if(action==='conversation-create'){db.conversation={id:'conversation',status:'active'};value={resource_id:'conversation',conversation:overview()};}
      else if(action==='conversation-send'){db.messages.push({role:'user',content:input.content,sequence:db.messages.length+1});db.revision++;
        db.turn={id:'turn',status:'queued',input_generation:db.messages.length};value={turn_id:'turn',status:'queued'};}
      else if(action==='conversation-intent-create'){db.intents.push({id:'intent',revision:1,status:input.documentId?'awaiting_goal':'awaiting_upload',source_status:'available',document_id:input.documentId||null,document_version_id:input.documentId?'version':null});db.revision++;value={resource_id:'intent',revision:1,conversation_revision:db.revision};}
      else if(action==='upload'){assert.equal(input.intentId,'intent');assert.equal(input.conversationId,'conversation');assert.equal(input.expectedIntentRevision,1);
        db.uploads++;Object.assign(db.intents[0],{document_id:'doc',document_version_id:'version',status:'awaiting_goal',revision:2});db.stamp='uploaded';value={document:{id:'doc'}};}
      else if(action==='conversation-cancel'){Object.assign(db.intents.find(i=>i.id===input.intentId),{status:'cancelled',revision:2});value={resource_id:input.intentId,revision:2};}
      else if(action==='conversation-analyze'){db.turn={id:'read',status:'queued',input_generation:db.messages.length};value={turn_id:'read',status:'queued'};}
      else if(action==='conversation-source-save'){
        db.source={document:{id:'doc',segment_count:input.segments.length},version:{id:'corrected-version'},segments:clone(input.segments)};
        value=clone(db.source);
      }
      else if(action==='conversation-goal'){Object.assign(db.intents[0],{status:'ready_for_confirmation',revision:3,goal:{goal:input.goal,instructions:input.instructions}});db.revision++;db.stamp='goal';value={resource_id:'intent',revision:3};}
      else if(action==='conversation-confirm'){assert.equal(input.planDigest,'a'.repeat(64));db.intents[0].status='queued';db.intents[0].execution={id:'execution',status:'queued'};value={job_id:'extract',status:'queued'};}
      else if(action==='conversation-review'){db.intents[0].review={draft_id:'draft',status:'editing'};value={draft_id:'draft',draft_revision:1,lease_generation:1};}
      else if(action==='conversation-editor-claim')value={draft_id:input.draftId,revision:input.revision,status:'editing',lease_generation:3};
      else if(action==='conversation-editor-release')value={released:true};
      else throw Error('Unexpected '+action);
      receipts.set(operation,clone(value));
    }
    if(db.lose===action){db.lose=null;throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED',status:0});}
    return clone(value);
  };
  const make=()=>new ConversationFlow({call,warehouseId:'warehouse',identity:{boxId:'box',user:{id:actor},dataScope:'personal'},
    storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},isCurrent:()=>current,uuid:()=>`operation-${++sequence}`});
  return {db,calls,make,flow:make(),storage,call,invalidate:()=>current=false};
}
test('stopped completed extraction stays in the original intent through candidate review, merge and draft recovery',async()=>{
  const h=fixture(),f=h.flow;await f.load();await f.listDocuments();await f.link('doc');
  Object.assign(h.db.intents[0],{status:'cancelled',execution:{id:'execution',status:'awaiting_review'}});
  f.saved.intakeReviews={intent:{versionId:'version',stage:'source'}};
  await f.refresh();assert.equal(f.state.error,'');assert.equal(nextConversationStep(f),'candidates');
  assert.equal(f.state.candidates.total,1);assert.equal(f.intake.unavailable,false);
  assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,f),/data-cv="review"/);
  assert.doesNotMatch(conversationHTML({id:'warehouse',state:'active'},null,null,true,f),/data-cv="material-restart"/);
  await f.showCandidateGraph();assert.equal(f.state.error,'');assert.equal(f.state.candidateGraph.total,1);
  await f.review();assert.equal(f.state.error,'');assert.equal(nextConversationStep(f),'merge');
  await f.merge(false);assert.equal(f.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');
  await f.merge(true);assert.equal(f.state.error,'');assert.equal(nextConversationStep(f),'draft');
  assert.equal(f.state.selectedIntent,'intent');assert.equal(f.changes.state.summary.id,'draft');
  assert.ok(f.changes.state.context);assert.equal(h.calls.filter(c=>c.action==='conversation-intent-create').length,1);
  assert.equal(h.calls.some(c=>['conversation-confirm','conversation-change-publish'].includes(c.action)),false);
  h.db.leases=[{draft_id:'draft',revision:1,status:'editing'}];
  const restored=h.make();await restored.load();await restored.changes.openDraft();
  assert.equal(restored.changes.state.leases.length,1);assert.equal(restored.changes.owner.draftId,undefined);
  await restored.changes.claim('draft');assert.equal(restored.state.error,'');assert.ok(restored.changes.state.context);
});

test('stopped candidates still reject source invalidation and revisions changed during a read',async()=>{
  const h=fixture(),f=h.flow;await f.load();await f.listDocuments();await f.link('doc');
  Object.assign(h.db.intents[0],{status:'cancelled',execution:{id:'execution',status:'awaiting_review'}});
  await f.refresh();const d=f.state.detail;
  for(const patch of [{source_status:'unavailable'},{status:'stale'},{execution:{id:'execution',status:'cancelled'}},{invalid_reason:'ontology_changed'}]){
    f.state.detail={...d,...patch};await assert.rejects(()=>f.readCandidates(),e=>e.code==='MODELING_CANDIDATES_NOT_READY');
  }
  f.state.detail=d;h.db.intents[0].revision++;
  await assert.rejects(()=>f.readCandidates(),e=>e.code==='MODELING_SNAPSHOT_CHANGED');
  assert.equal(f.state.candidates,null);
});

test('discarded merged draft is restored as discarded without showing a publication spinner or claiming a lease',async()=>{
  const h=fixture(),f=h.flow;await f.load();await f.listDocuments();await f.link('doc');
  Object.assign(h.db.intents[0],{status:'awaiting_review',execution:{id:'execution',status:'awaiting_review'},review:{draft_id:'draft',status:'discarded'}});
  h.db.draftStatus='discarded';await f.refresh();assert.equal(nextConversationStep(f),'discarded');
  const html=conversationHTML({id:'warehouse',state:'active'},null,null,true,f);
  assert.match(html,/草稿已放弃/);assert.match(html,/打开草稿编辑器，重新创建/);assert.doesNotMatch(html,/正在发布材料知识/);
  await f.changes.openDraft();assert.equal(f.state.error,'');assert.equal(f.changes.state.summary.status,'discarded');
  assert.equal(nextConversationStep(f),'discarded');
  assert.equal(h.calls.some(c=>['conversation-editor-claim','conversation-change-publication','conversation-change-publish'].includes(c.action)),false);
});

test('new conversation is created once and reload recovers without a model call',async()=>{
  const f=fixture();await f.flow.load();f.flow=f.make();await f.flow.load();
  assert.equal(f.calls.filter(c=>c.action==='conversation-create').length,1);
  assert.equal(f.calls.filter(c=>c.action==='conversation-analyze').length,0);
  assert.equal(f.flow.state.loaded,true);
});
test('goal confirmation waits for an active answer even on legacy or restarted intents without intake records',async()=>{
  const h=fixture();await h.flow.load();await h.flow.listDocuments();await h.flow.link('doc');
  h.db.turn={id:'answer',status:'running'};await h.flow.refresh();h.flow.state.goal='新的目标';
  assert.match(conversationGoal(h.flow),/type="submit"[^>]*disabled/);
  await h.flow.goal();assert.equal(h.flow.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');
  assert.equal(h.calls.some(c=>c.action==='conversation-goal'),false);
});
test('stopped and unavailable material status takes precedence over a retained editable draft',async()=>{
  const h=fixture();await h.flow.load();await h.flow.listDocuments();await h.flow.link('doc');
  h.flow.changes.record.draftId='draft';h.flow.changes.state.summary={status:'editing'};
  h.flow.state.detail.status='cancelled';assert.match(materialStatusHTML(h.flow),/<strong>已停止<\/strong>/);
  h.flow.state.detail.status='awaiting_goal';h.flow.state.detail.source_status='unavailable';
  assert.match(materialStatusHTML(h.flow),/<strong>来源已变化<\/strong>/);
});

test('intake stages only one attachment; send starts parsing and never starts later stages',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();
  assert.equal(h.flow.intake.staged.name,'材料.txt');assert.equal(h.db.uploads,0);
  assert.equal(h.calls.some(c=>c.action==='conversation-intent-create'),false);
  assert.equal(h.calls.find(c=>c.action==='select-files').input.multiple,false);
  h.flow.state.input='请保留表格文字';await h.flow.submitInput();
  assert.equal(h.db.uploads,1);assert.equal(h.flow.intake.record.note,'请保留表格文字');
  assert.equal(nextConversationStep(h.flow),'source-review');
  await h.flow.tick();await h.flow.changes.tick();
  assert.equal(h.calls.some(c=>c.action==='conversation-analyze'),true);
  assert.equal(h.calls.some(c=>['conversation-goal','conversation-confirm','correct','conversation-change-generate'].includes(c.action)),false);
  const html=conversationHTML({id:'warehouse',state:'active',name:'仓'},null,null,true,h.flow);
  assert.match(html,/第 1 步 · 材料解析/);assert.match(html,/解析出的正文/);
  assert.doesNotMatch(html,/id="cv-goal-form"|data-cv="confirm-plan"|data-cv="analyze"/);
});

test('shared import dialog can hand a WANX Space selection to the conversation without restarting extraction',async()=>{
  const h=fixture();await h.flow.load();
  await h.flow.intake.stageSelectedFile({handle:'space-contract',name:'万象合同.txt'});
  assert.equal(h.calls.some(c=>c.action==='select-files'),false);
  await h.flow.intake.submit({isolated:true,note:'核对付款期限'});
  assert.equal(h.calls.find(c=>c.action==='upload').input.handle,'space-contract');
  assert.equal(h.flow.intake.record.note,'核对付款期限');
  assert.equal(h.calls.some(c=>['conversation-goal','conversation-confirm'].includes(c.action)),false);
});

test('a rejected file leaves the intake ready to cancel and never retries its invalid bytes',async()=>{
  const h=fixture();await h.flow.load();
  h.db.invalidFile='SEMANTICA_FILE_CONTENT_MISMATCH';
  await h.flow.intake.stageSelectedFile({handle:'broken',name:'损坏材料.docx'});
  await h.flow.intake.submit({isolated:true,note:'核对交付'});
  assert.equal(h.flow.saved.pending,null);
  assert.equal(h.flow.saved.upload.replacementError,h.db.invalidFile);
  assert.match(h.flow.state.error,/损坏/);
  const before=h.calls.filter(c=>c.action==='upload').length;
  await h.flow.resumeUpload();
  assert.equal(h.calls.filter(c=>c.action==='upload').length,before);
  await h.flow.abandonUpload();
  assert.equal(h.flow.saved.upload,null);
  assert.equal(h.db.intents[0].status,'cancelled');
  assert.equal(h.db.uploads,0);
  await h.flow.intake.stageSelectedFile({handle:'replacement',name:'可用材料.docx'});
  assert.equal(h.flow.intake.staged.handle,'replacement');
});

test('cancelling staged selection has no upload; multi-file selection is rejected',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();await h.flow.intake.remove();
  assert.equal(h.flow.intake.staged,null);assert.equal(h.db.uploads,0);
  h.db.files=[{handle:'one',name:'one.txt'},{handle:'two',name:'two.txt'}];await h.flow.intake.stageFile();
  assert.equal(h.flow.state.errorCode,'MODELING_SINGLE_FILE_REQUIRED');assert.equal(h.flow.intake.staged,null);
  assert.equal(h.calls.some(c=>c.action==='conversation-intent-create'),false);
});

test('staged association waits for send and lost response preserves original attachment and note',async()=>{
  const h=fixture();await h.flow.load();await h.flow.listDocuments();await h.flow.intake.stageDocument('doc');
  assert.equal(h.db.intents.length,0);h.flow.state.input='这是一份已有材料';h.db.lose='conversation-intent-create';
  await h.flow.submitInput();const pending=clone(h.flow.saved.pending);
  h.flow=h.make();await h.flow.load();await h.flow.retryPending();
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-intent-create').at(-1).input,pending.input);
  assert.equal(h.db.intents.length,1);assert.equal(h.db.uploads,0);assert.equal(h.flow.intake.record.note,'这是一份已有材料');
  await h.flow.tick();assert.equal(h.calls.some(c=>c.action==='conversation-analyze'),true);
});

test('lost upload restores source review; saving persists a version-bound server correction',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();h.db.lose='upload';
  await Promise.all([h.flow.submitInput(),h.flow.submitInput()]);
  assert.equal(h.db.uploads,1);h.flow=h.make();await h.flow.load();await h.flow.retryPending();
  h.flow.intake.edit('segment','校对后的文字');await h.flow.intake.confirm();assert.equal(h.flow.intake.record.confirmed,true);
  assert.equal(h.db.source.segments[0].text,'校对后的文字');assert.equal(h.flow.intake.record.versionId,'corrected-version');
  assert.deepEqual(h.calls.find(c=>c.action==='conversation-source-save').input.segments,[{id:'segment',text:'校对后的文字'}]);
  h.flow.state.reviewingSource=false;
  h.db.intents[0].document_version_id='new-version';h.db.source={document:{id:'doc',segment_count:1},version:{id:'new-version'},segments:[{id:'new-segment',text:'更新的原文'}]};
  await h.flow.intake.confirm();assert.equal(h.flow.intake.record.confirmed,false);assert.equal(h.flow.state.errorCode,'MODELING_SNAPSHOT_CHANGED');
  assert.equal(h.calls.some(c=>c.action==='correct'||c.action==='conversation-confirm'),false);
});

test('parsing polls automatically then displays source; partial or truncated text cannot be confirmed',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();
  Object.assign(h.db.intents[0],{status:'parsing',document_version_id:null});await h.flow.refresh();
  let html=conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.match(html,/正在解析正文/);assert.doesNotMatch(html,/data-cv="intake-confirm"/);
  Object.assign(h.db.intents[0],{status:'awaiting_goal',document_version_id:'version'});
  h.db.source={document:{id:'doc',segment_count:2},version:{id:'version'},segments:[{id:'segment',text:'部分正文'}]};
  await h.flow.tick();assert.equal(h.flow.intake.complete,false);await h.flow.intake.confirm();assert.equal(h.flow.intake.record.confirmed,false);
  h.flow.intake.source.segments.push({id:'second',text:'截断',text_truncated:true});assert.equal(h.flow.intake.complete,false);
});

test('linking the same document again initializes a separate version-bound source review',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();
  h.flow.intake.edit('segment','第一轮修改');await h.flow.intake.confirm();
  h.flow.intake.register('another',{name:'同一材料',conversationId:'conversation'});
  h.flow.state.reviewingSource=false;h.flow.state.detail={...h.flow.state.detail,id:'another',document_version_id:'corrected-version'};await h.flow.intake.sync();
  assert.equal(h.flow.intake.record.versionId,'corrected-version');assert.deepEqual(h.flow.intake.record.edits,{});
  assert.equal(h.flow.intake.record.confirmed,false);assert.equal(h.flow.intake.source.segments[0].text,'第一轮修改');
});

test('source pages load automatically while UI shows five or ten rows and preserves off-page edits',async()=>{
  const h=fixture();h.db.sourceSegments=Array.from({length:205},(_,n)=>({id:'s'+n,text:'第 '+n+' 段'}));
  await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();
  assert.equal(h.flow.intake.source.segments.length,100);assert.equal(h.flow.intake.complete,false);
  const emitted=[];h.flow.onChange=s=>emitted.push(s.busy);
  await h.flow.tick();assert.equal(h.flow.intake.source.segments.length,205);assert.equal(h.flow.intake.complete,true);assert.equal(emitted.at(-1),false);
  const html=()=>conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.equal((html().match(/data-intake-segment=/g)||[]).length,5);
  h.flow.intake.edit('s0','第一页的修改');h.flow.intake.changePage(1);assert.doesNotMatch(html(),/id="cv-source-s0"/);
  h.flow.intake.changePageSize(10);assert.equal((html().match(/data-intake-segment=/g)||[]).length,10);
  assert.match(html(),/第一页的修改/);assert.equal(h.flow.intake.hasEdits,true);
  assert.equal(h.calls.some(c=>c.action==='conversation-analyze'),false);
});

test('truncated source is filled from immutable text ranges with Unicode offsets',async()=>{
  const h=fixture();h.db.fullText='😀正文'.repeat(22000);
  h.db.source={document:{id:'doc',segment_count:1},version:{id:'version'},segments:[{id:'segment',text:'😀',text_truncated:true,full_text_chars:66000}]};
  await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();await h.flow.tick();
  assert.equal(h.flow.intake.complete,true);assert.equal(h.flow.intake.source.segments[0].text,h.db.fullText);
  assert.equal(h.calls.filter(c=>c.action==='workbench-request').length,2);
  assert.equal(h.calls.some(c=>c.action==='correct'),false);
});

test('a changed source version during pagination discards the old page cache instead of concatenating versions',async()=>{
  const h=fixture();h.db.source={document:{id:'doc',segment_count:101},version:{id:'version'},segments:[{id:'segment',text:'旧版本'}]};
  await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();
  h.db.source.version.id='version-new';await h.flow.tick();
  assert.equal(h.flow.intake.source,null);assert.equal(h.flow.state.errorCode,'MODELING_SNAPSHOT_CHANGED');
  h.db.intents[0].document_version_id='version-new';h.db.source.document.segment_count=1;await h.flow.tick();
  assert.equal(h.flow.intake.source.version.id,'version-new');assert.equal(h.flow.intake.record.confirmed,false);
});

test('source confirmation opens goal dialogue, saves exclusions only on explicit server confirmation',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();await h.flow.intake.confirm(true);
  assert.equal(h.flow.intake.goalStage,true);assert.equal(h.calls.filter(c=>c.action==='conversation-analyze').length,1);
  const html=()=>conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.doesNotMatch(html(),/id="cv-goal-form"/);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'需要整理哪类信息？',goal_summary:'整理合同信息',questions:['是否关注付款条款？']}};
  await h.flow.refresh();assert.equal(h.flow.state.goal,'整理合同信息');
  h.flow.state.input='只关注付款条件，不需要抽取签署地点';await h.flow.submitInput();
  assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'||c.action==='conversation-goal'),false);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'已调整',goal_summary:'整理付款条件'}};
  await h.flow.refresh();assert.equal(h.flow.state.goal,'整理付款条件');
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'整理付款条件');assert.equal(h.flow.state.instructions,'');
  h.flow.state.instructions='不需要抽取签署地点';h.flow.intake.saveGoalDraft();
  await h.flow.goal();assert.equal(h.flow.state.error,'');
  assert.match(h.calls.find(c=>c.action==='conversation-goal').input.instructions,/不需要抽取签署地点/);
  assert.match(html(),/整理目标已由服务端确认保存/);assert.match(html(),/data-cv="plan"/);assert.doesNotMatch(html(),/data-cv="confirm-plan"/);
  assert.equal(h.calls.some(c=>c.action==='conversation-confirm'),false);
});

test('first dialogue refresh reads publication before considering a historical goal summary',async()=>{
  const h=fixture(),f=h.flow;await f.load();await f.intake.stageFile();await f.submitInput();await f.intake.confirm(true);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'old',goal_summary:'must not become a new goal'}};
  h.db.workflow={document_id:'doc',document_version_id:'version',stage:'published',publication:{id:'run',status:'published',document_version_id:'version'}};
  h.db.knowledge={run:{id:'run',document_id:'doc',document_version_id:'version',status:'published'},candidates:[]};
  f.state.materialPage='dialogue';f.state.dialogueWorkflow=null;
  await f.refresh();assert.equal(f.state.error,'');
  assert.equal(f.state.goal,'');assert.equal(f.state.goalDirty,false);assert.equal(f.intake.goalStage,false);
  assert.notEqual(f.intake.record.goalDraft?.goal,'must not become a new goal');
});

test('unsaved source cannot be bypassed; lost initial reading restores the original request',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();
  h.flow.intake.edit('segment','未保存修改');
  await h.flow.intake.startGoal();assert.equal(h.flow.state.errorCode,'MODELING_SOURCE_SAVE_REQUIRED');
  await h.flow.intake.startGoal(true);assert.equal(h.flow.state.errorCode,'MODELING_SOURCE_SAVE_REQUIRED');
  h.flow.intake.edit('segment','解析出的正文。');
  h.db.lose='conversation-analyze';await h.flow.intake.startGoal();const request=clone(h.flow.saved.pending);
  h.flow=h.make();await h.flow.load();await h.flow.retryPending();
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-analyze').at(-1).input,request.input);
  assert.equal(h.flow.intake.record.usingOriginal,false);assert.equal(h.flow.intake.record.goalTurnId,'read');
  assert.equal(h.calls.some(c=>c.action==='correct'||c.action==='conversation-confirm'),false);
});

test('manual goal drafts survive refresh even when a current model suggestion is present',async()=>{
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();await h.flow.submitInput();await h.flow.intake.confirm(true);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'建议',goal_summary:'模型建议'}};
  await h.flow.refresh();h.flow.state.goal='用户自行填写的目标';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'用户自行填写的目标');
});

async function preparedIntakeGoal(note=''){
  const h=fixture();await h.flow.load();await h.flow.intake.stageFile();h.flow.state.input=note;await h.flow.submitInput();await h.flow.intake.confirm(true);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'已初读',goal_summary:'整理付款条件'}};
  await h.flow.refresh();return h;
}

test('goal dialogue renders a summary, preserves user wording, and next requests a missing summary before execution',async()=>{
  const h=await preparedIntakeGoal();const page=()=>conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.doesNotMatch(page(),/id="cv-goal"|id="cv-instructions"|data-cv="goal-edit"/);
  h.flow.state.input='对供应链相关的内容';await h.flow.submitInput();
  const sent=h.calls.filter(c=>c.action==='conversation-send').at(-1).input.content;
  assert.match(sent,/当前处于抽取前的目标澄清阶段/);assert.equal(goalDialogueText(sent),'对供应链相关的内容');
  assert.equal(h.flow.state.input,'');assert.match(conversationTimeline(h.flow),/对供应链相关的内容/);
  assert.doesNotMatch(conversationTimeline(h.flow),/【材料目标澄清】/);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'请补充',goal_summary:'',modification_intent:{kind:'ambiguous'}}};
  await h.flow.refresh();assert.equal(h.flow.intake.record.goalReplyPending,true);
  await h.flow.goal();assert.equal(h.flow.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');
  h.flow.state.input='下一步';await h.flow.submitInput();
  assert.equal(goalDialogueText(h.calls.filter(c=>c.action==='conversation-send').at(-1).input.content),'下一步');
  assert.equal(h.calls.some(c=>c.action==='conversation-confirm'||c.action==='conversation-goal'),false);
  h.db.turn={...h.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'已整理目标',goal_summary:'整理供应链相关实体与关系，不抽取地点'}};
  await h.flow.refresh();assert.equal(h.flow.state.goal,'整理供应链相关实体与关系，不抽取地点');assert.equal(h.flow.intake.record.goalReplyPending,false);
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'整理供应链相关实体与关系，不抽取地点');
  await h.flow.goal();assert.equal(h.flow.state.error,'');assert.equal(h.calls.filter(c=>c.action==='conversation-goal').at(-1).input.goal,'整理供应链相关实体与关系，不抽取地点');
  assert.equal(h.calls.some(c=>c.action==='conversation-confirm'),false);
});

test('historical goal replies cannot replace the displayed summary after a follow-up',async()=>{
  const h=await preparedIntakeGoal();h.flow.state.input='重点关注供应链';await h.flow.submitInput();
  h.db.turn={...h.db.turn,status:'succeeded',is_current:false,applicable_to_current:false,content_status:'historical',reply:{goal_summary:'失效目标'}};
  await h.flow.refresh();assert.notEqual(h.flow.state.goal,'失效目标');assert.equal(h.flow.intake.record.goalReplyPending,true);
});

test('retrying a failed or stale rule suggestion honors explicit change mode before goal dialogue',async()=>{
  for(const status of ['failed','stale']){
    const h=await preparedIntakeGoal();await h.flow.goal();
    h.flow.changes.state.proposals=[{id:'old',status,instruction:'补充合同类型'}];h.flow.changes.record.lastProposal='old';
    const beforeGoal=clone(h.flow.state.detail.goal),sent=h.calls.filter(c=>c.action==='conversation-send').length;
    const original=h.flow.call;const requests=[];
    h.flow.call=async(action,input)=>{
      if(action==='conversation-change-context')return {context_digest:'a'.repeat(64),recent_proposals:[],ontology_id:'ontology',base_ontology_id:'ontology'};
      if(action==='conversation-change-generate'){requests.push(clone(input));return {id:'new',status:'generating'};}
      return original(action,input);
    };
    // These fields are set by the "补充要求后重新生成" button.
    h.flow.changes.setTarget('rules');h.flow.state.composerContext='rules';
    h.flow.state.messageMode='change';h.flow.state.input='补充合同类型，优先复用组织';await h.flow.submitInput();
    assert.equal(h.flow.state.error,'');assert.equal(requests.length,1);assert.match(requests[0].instruction,/^请调整当前材料适用的本体规则：补充合同类型，优先复用组织/);assert.deepEqual(requests[0].allowedScopes,['rules']);
    assert.equal(h.calls.filter(c=>c.action==='conversation-send').length,sent);assert.deepEqual(h.flow.state.detail.goal,beforeGoal);
    assert.equal(h.flow.intake.record.goalNeedsConfirmation,false);assert.equal(h.flow.state.input,'');
  }
});

test('a rejected foreground edit cannot stop an active extraction from reaching results',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();await h.flow.preview();await h.flow.confirmPlan();
  h.flow.state.input='修改合同类型';await h.flow.submitInput();
  assert.match(h.flow.state.inputNotice,/明确修改对象/);assert.equal(h.flow.state.errorCode,'');
  const before=h.calls.length;
  Object.assign(h.db.intents[0],{status:'awaiting_review',execution:{id:'execution',status:'awaiting_review'}});
  await h.flow.tick();assert.ok(h.calls.length>before);assert.equal(h.flow.state.detail.status,'awaiting_review');assert.ok(h.flow.state.candidates);
  assert.equal(h.flow.state.input,'修改合同类型');assert.equal(h.calls.filter(c=>c.action==='conversation-confirm').length,1);
  assert.equal(h.calls.some(c=>c.action==='conversation-change-generate'),false);
});

test('background authorization failures and pending writes still block automatic reads',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();await h.flow.preview();h.db.lose='conversation-confirm';await h.flow.confirmPlan();
  let count=h.calls.length;await h.flow.tick();assert.equal(h.calls.length,count);await h.flow.retryPending();
  const original=h.flow.call;h.flow.call=async(action,input)=>{if(action==='conversation-get')throw Object.assign(Error('denied'),{status:403,code:'MODELING_RESOURCE_NOT_FOUND'});return original(action,input);};
  await h.flow.tick();assert.equal(h.flow.state.loaded,false);assert.equal(h.flow.state.detail,null);
  count=h.calls.length;await h.flow.tick();assert.equal(h.calls.length,count);
});

test('rule publication restores the last confirmed goal as a draft across reload and requires reconfirmation',async()=>{
  const h=await preparedIntakeGoal();h.flow.state.goal='用户调整后的付款目标';h.flow.state.instructions='不抽取姓名';await h.flow.goal();
  h.db.ontologyId='new-ontology';Object.assign(h.db.intents[0],{status:'awaiting_goal',invalid_reason:'ontology_changed',revision:4});delete h.db.intents[0].goal;
  h.db.turn={...h.db.turn,is_current:false,content_status:'stale'};
  h.flow=h.make();await h.flow.load();
  assert.equal(h.flow.state.goal,'用户调整后的付款目标');assert.equal(h.flow.state.instructions,'不抽取姓名');assert.equal(h.flow.state.goalDirty,true);
  assert.equal(h.flow.intake.record.goalNeedsConfirmation,true);assert.match(h.flow.state.goalReviewNotice,/本体规则已更新/);
  await h.flow.preview();assert.equal(h.calls.filter(c=>c.action==='conversation-plan').length,0);
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'用户调整后的付款目标');assert.equal(h.flow.state.instructions,'不抽取姓名');
  await h.flow.goal();await h.flow.preview();assert.equal(h.flow.state.error,'');assert.equal(h.flow.state.plan.ontology_id,'new-ontology');
  assert.equal(h.calls.some(c=>c.action==='conversation-confirm'),false);
});

test('restoring an invalidated goal preserves newer drafts, including deliberately cleared instructions',async()=>{
  const h=await preparedIntakeGoal();h.flow.state.goal='旧目标';h.flow.state.instructions='不抽取姓名';await h.flow.goal();
  h.flow.state.goal='尚未提交的新目标';h.flow.state.instructions='';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  h.db.ontologyId='new-ontology';Object.assign(h.db.intents[0],{status:'awaiting_goal',invalid_reason:'ontology_changed',revision:4});delete h.db.intents[0].goal;
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'尚未提交的新目标');assert.equal(h.flow.state.instructions,'');
  // Goals from a previous source version must not be restored onto new text.
  h.db.intents[0].document_version_id='new-version';h.db.source={document:{id:'doc',segment_count:1},version:{id:'new-version'},segments:[{id:'new',text:'新正文'}]};
  h.db.turn=null;h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'');assert.equal(h.flow.state.instructions,'');
  assert.equal(h.flow.intake.record.goalDraft,undefined);assert.equal(nextConversationStep(h.flow),'source-review');
});

test('a recovered goal receipt retains its exact text if rules changed before the snapshot was read',async()=>{
  const h=await preparedIntakeGoal();h.flow.state.goal='原请求中的完整目标';h.flow.state.instructions='排除姓名';h.db.lose='conversation-goal';
  await h.flow.goal();const request=clone(h.flow.saved.pending);
  h.db.ontologyId='new-ontology';Object.assign(h.db.intents[0],{status:'awaiting_goal',invalid_reason:'ontology_changed',revision:4});delete h.db.intents[0].goal;
  h.db.turn={...h.db.turn,is_current:false,content_status:'stale'};h.flow=h.make();await h.flow.load();await h.flow.retryPending();
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-goal').at(-1).input,request.input);
  assert.equal(h.flow.state.goal,'原请求中的完整目标');assert.equal(h.flow.state.instructions,'排除姓名');assert.equal(h.flow.state.goalDirty,true);
  assert.equal(h.flow.saved.pending,null);assert.equal(h.flow.state.plan,null);
});

test('reviewed intake continues inline from confirmed goal through a bound plan to live extraction and results',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();
  const html=()=>conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.equal(nextConversationStep(h.flow),'plan');assert.match(html(),/沿用当前本体，读取计划/);
  await h.flow.preview();assert.match(html(),/正文版本/);assert.match(html(),/确认计划，开始抽取/);
  assert.equal(h.calls.some(c=>c.action==='conversation-confirm'),false);
  await h.flow.goStage(1);assert.match(html(),/id="cv-goal-form"/);
  h.flow.state.instructions='只关注付款';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  await h.flow.confirmPlan();assert.equal(h.calls.some(c=>c.action==='conversation-confirm'),false);
  await h.flow.goal();await h.flow.preview();await h.flow.confirmPlan();assert.equal(h.flow.state.error,'');
  assert.equal(nextConversationStep(h.flow),'extracting');assert.match(materialStatusHTML(h.flow),/抽取排队中/);
  assert.doesNotMatch(html(),/data-cv="candidates"|data-cv="change-suggest"|id="cv-goal-form"/);
  h.flow=h.make();await h.flow.load();assert.equal(nextConversationStep(h.flow),'extracting');
  Object.assign(h.db.intents[0],{status:'running',execution:{id:'execution',status:'running',progress:{completed_units:2,total_units:5}}});
  await h.flow.tick();assert.match(html(),/已完成 2 \/ 5/);
  Object.assign(h.db.intents[0],{status:'awaiting_review',execution:{id:'execution',status:'awaiting_review',progress:{completed_units:5,total_units:5}}});
  await h.flow.tick();assert.equal(nextConversationStep(h.flow),'candidates');assert.equal(h.flow.state.error,'');
  assert.match(html(),/第 5 步/);assert.match(html(),/&lt;药品&gt;/);assert.match(html(),/本体建议与类型复用/);
  assert.equal(h.calls.filter(c=>c.action==='conversation-candidates').length,1);
  const count=h.calls.length;await h.flow.tick();await h.flow.changes.tick();assert.equal(h.calls.length,count);
  assert.equal(h.calls.some(c=>/conversation-(?:review|change-generate|change-publish)$/.test(c.action)),false);
});

test('intake extraction with a lost response replays the exact confirmation after reload',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();await h.flow.preview();
  h.db.lose='conversation-confirm';await h.flow.confirmPlan();const pending=clone(h.flow.saved.pending);
  assert.equal(nextConversationStep(h.flow),'recovery');
  h.flow=h.make();await h.flow.load();await h.flow.retryPending();
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-confirm').at(-1).input,pending.input);
  assert.equal(nextConversationStep(h.flow),'extracting');assert.equal(h.calls.filter(c=>c.action==='conversation-plan').length,1);
});

test('initial results enter editable drafts only after merge confirmation, then selected facts produce unapplied proposals',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();await h.flow.preview();await h.flow.confirmPlan();
  Object.assign(h.db.intents[0],{status:'awaiting_review',execution:{id:'execution',status:'awaiting_review'}});await h.flow.tick();
  h.flow.state.input='排除甲公司这条事实';await h.flow.submitInput();
  assert.equal(nextConversationStep(h.flow),'merge');assert.equal(h.flow.state.input,'排除甲公司这条事实');
  assert.equal(h.calls.some(c=>c.action==='conversation-review'||c.action==='conversation-change-generate'),false);
  await h.flow.merge(true);assert.equal(h.flow.state.error,'');assert.equal(h.flow.changes.state.summary.id,'draft');
  assert.equal(h.calls.some(c=>c.action==='conversation-editor-release'||c.action==='conversation-editor-claim'),false);
  assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow),/批量修正或排除已选事实/);
  h.flow.state.composerContext='facts';await h.flow.submitInput();assert.match(h.flow.state.inputNotice,/先选中/);
  const raw=h.flow.call;let proposal=null;const mutations=[];
  h.flow.call=async(action,input)=>{
    if(action==='conversation-change-context')return {...await raw(action,input),recent_proposals:proposal?[{id:proposal.id}]:[]};
    if(action==='conversation-change-read')return clone(proposal);
    if(action==='conversation-change-generate'){
      assert.deepEqual(input.selectedItemIds,['fact']);assert.equal(input.draftId,'draft');assert.equal(input.editor.generation,'1');
      mutations.push(action);proposal={id:'p',status:'prepared',can_apply:true,proposal_digest:'c'.repeat(64),instruction:input.instruction,result:{changes:[{scope:'facts',item_id:'fact',before:{name:'甲公司'},after:null}]}};return clone(proposal);
    }
    if(action==='conversation-change-apply'){
      mutations.push(action);h.db.draftRevision=2;proposal.status='applied';return {status:'applied',draft_id:'draft',draft_revision:2,active_intent_id:'intent',publication_performed:false,extraction_started:false};
    }
    return raw(action,input);
  };
  h.flow.changes.select('fact',true);await h.flow.changes.generate(h.flow.state.input);assert.equal(h.flow.state.error,'');
  assert.deepEqual(mutations,['conversation-change-generate']);assert.equal(h.flow.changes.state.summary.revision,1);
  assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow),/第 7 步 · 核对差异/);
  h.flow.changes.defer('p');assert.equal(nextConversationStep(h.flow),'draft');await h.flow.changes.apply('p');assert.equal(mutations.length,1);
  h.flow.state.input='请排除选中的事实';h.flow.state.composerContext='facts';await h.flow.changes.generate(h.flow.state.input);
  // A new server proposal has a new ID, even when the requested edit is similar.
  proposal.id='p2';h.flow.changes.state.proposals=[clone(proposal)];h.flow.changes.record.lastProposal='p2';
  await h.flow.changes.apply('p2');assert.equal(h.flow.state.error,'');assert.equal(h.flow.changes.state.summary.revision,2);
  assert.equal(mutations.filter(v=>v==='conversation-change-apply').length,1);
  assert.equal(h.calls.some(c=>/conversation-change-(?:publish|rule-publish)$/.test(c.action)),false);
  assert.doesNotMatch([...h.storage.values()].join(''),/ssssssssssssssssssss|editor_session/);
});

test('failed intake extraction remains recoverable instead of returning to source review or goal confirmation',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();await h.flow.preview();await h.flow.confirmPlan();
  Object.assign(h.db.intents[0],{status:'failed',execution:{id:'execution',status:'failed'}});
  await h.flow.tick();assert.equal(h.flow.intake.unavailable,false);assert.equal(nextConversationStep(h.flow),'candidates');
  const html=conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.match(html,/data-cv="intent-retry"/);assert.doesNotMatch(html,/data-cv="intake-confirm"|id="cv-goal-form"/);
});

test('candidate reads reject a response belonging to another extraction',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();await h.flow.preview();await h.flow.confirmPlan();
  Object.assign(h.db.intents[0],{status:'awaiting_review',execution:{id:'execution',status:'awaiting_review'}});
  const original=h.flow.call;h.flow.call=async(action,input)=>{const value=await original(action,input);return action==='conversation-candidates'?{...value,execution_id:'older-execution'}:value;};
  await h.flow.tick();assert.equal(h.flow.state.errorCode,'MODELING_SNAPSHOT_CHANGED');assert.equal(h.flow.state.candidates,null);
});

test('a goal receipt preserves newer edits, including exclusions, through reload and subsequent confirmation',async()=>{
  const h=await preparedIntakeGoal();h.flow.state.goal='已提交目标';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  let release,arrived;const reached=new Promise(r=>arrived=r),wait=new Promise(r=>release=r),call=h.flow.call;
  h.flow.call=async(a,i)=>{const value=await call(a,i);if(a==='conversation-goal'){arrived();await wait;}return value;};
  const saving=h.flow.goal();await reached;
  h.flow.state.goal='等待回执时新写的目标';h.flow.state.instructions='不抽取签署地点';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  release();await saving;
  assert.equal(h.flow.state.goal,'等待回执时新写的目标');assert.equal(h.flow.intake.record.goalNeedsConfirmation,true);
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'等待回执时新写的目标');assert.equal(h.flow.state.instructions,'不抽取签署地点');
  assert.doesNotMatch(conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow),/整理目标已由服务端确认保存/);
  await h.flow.goal();assert.equal(h.flow.state.error,'');assert.equal(h.db.intents[0].goal.goal,'等待回执时新写的目标');
  assert.equal(h.flow.intake.record.goalDraft,undefined);assert.equal(h.flow.intake.record.goalNeedsConfirmation,false);
});
test('assistant goal and dialogue exclusions replace older composer caches before lost-goal recovery',async()=>{
  const h=await preparedIntakeGoal();
  h.flow.state.goal='旧建议';h.flow.state.instructions='';h.flow.state.input='关注付款与违约，不抽取签署地点';h.flow.saveMaterialComposer();
  await h.flow.intake.discuss();h.db.turn.status='succeeded';await h.flow.refresh();
  assert.equal(h.flow.state.instructions,'');
  h.flow.state.goal='新建议';h.flow.state.instructions='不抽取签署地点';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  h.db.lose='conversation-goal';await h.flow.goal();assert.ok(h.flow.saved.pending);
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'新建议');assert.match(h.flow.state.instructions,/不抽取签署地点/);
  await h.flow.retryPending();assert.equal(h.flow.state.error,'');assert.equal(h.flow.state.goalDirty,false);
  assert.equal(nextConversationStep(h.flow),'plan');
  h.flow=h.make();await h.flow.load();assert.equal(nextConversationStep(h.flow),'plan');
});

test('recovering a lost older goal response does not delete a later local draft',async()=>{
  const h=await preparedIntakeGoal();h.flow.state.goal='第一次提交';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  h.db.lose='conversation-goal';await h.flow.goal();const original=clone(h.flow.saved.pending.input);
  h.flow.state.goal='第二次修改';h.flow.state.instructions='';h.flow.intake.saveGoalDraft();
  h.flow=h.make();await h.flow.load();await h.flow.retryPending();
  assert.deepEqual(h.calls.filter(c=>c.action==='conversation-goal').at(-1).input,original);
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.goal,'第二次修改');assert.equal(h.flow.intake.record.goalNeedsConfirmation,true);
  assert.equal(h.db.intents[0].goal.goal,'第一次提交');
});

test('intentionally empty instructions are preserved through refresh, reload and server confirmation',async()=>{
  const h=await preparedIntakeGoal('不抽取签署地点');assert.equal(h.flow.state.instructions,'不抽取签署地点');
  h.flow.state.instructions='';h.flow.state.goalDirty=true;h.flow.intake.saveGoalDraft();
  await h.flow.refresh();assert.equal(h.flow.state.instructions,'');
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.instructions,'');
  await h.flow.goal();assert.equal(h.calls.find(c=>c.action==='conversation-goal').input.instructions,'');
  h.flow=h.make();await h.flow.load();assert.equal(h.flow.state.instructions,'');
});

test('cancelled, failed and stale intake materials cannot show active confirmation or send more goal turns',async()=>{
  for(const status of ['cancelled','failed','stale']){
    const h=await preparedIntakeGoal();await h.flow.goal();
    h.db.intents[0].status=status;h.db.intents[0].revision++;await h.flow.refresh();
    assert.equal(h.flow.intake.goalStage,false);assert.equal(nextConversationStep(h.flow),'stopped');
    const html=conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
    assert.doesNotMatch(html,/整理目标已由服务端确认保存|data-cv="intake-edit-goal"/);
    assert.match(html,/<textarea id="cv-message"[^>]*disabled/);
    h.flow.state.input='再整理一下';const writes=h.calls.filter(c=>c.action==='conversation-send').length;
    await h.flow.submitInput();assert.equal(h.flow.state.errorCode,'MODELING_MATERIAL_UNAVAILABLE');
    await h.flow.intake.discuss();await h.flow.turnAction('retry');
    assert.equal(h.calls.filter(c=>c.action==='conversation-send').length,writes);
    assert.equal(h.calls.some(c=>c.action==='conversation-turn-retry'),false);
    await h.flow.intake.stageFile();assert.ok(h.flow.intake.staged);
    assert.doesNotMatch(conversationThread(h.flow),/<textarea id="cv-message"[^>]*disabled/);
  }
});

test('unavailable source blocks goal preparation even when the intent status has not yet changed',async()=>{
  const h=await preparedIntakeGoal();await h.flow.goal();h.db.intents[0].source_status='document_version_changed';await h.flow.refresh();
  assert.equal(h.flow.intake.goalStage,false);const html=conversationHTML({id:'warehouse',state:'active'},null,null,true,h.flow);
  assert.doesNotMatch(html,/整理目标已由服务端确认保存|正在解析正文/);assert.match(html,/来源已变化/);
});

test('8000-codepoint upload notes enter goal preparation without truncation or duplicate model calls',async()=>{
  for(const note of ['a'.repeat(8000),'😀'.repeat(8000)]){
    const h=fixture();await h.flow.load();await h.flow.intake.stageFile();h.flow.state.input=note;await h.flow.submitInput();assert.equal(h.flow.state.error,'');
    await h.flow.intake.confirm(true);assert.equal(h.flow.state.error,'');assert.equal(h.flow.intake.goalStage,true);
    const sends=h.calls.filter(c=>c.action==='conversation-send');assert.equal(sends.length,1);assert.equal(sends[0].input.content,note);
    assert.equal(h.calls.some(c=>c.action==='conversation-analyze'||c.action==='conversation-confirm'),false);
  }
});

test('idle conversations do not poll or rerender; active work polls quietly and stops after completion',async()=>{
  const h=fixture();await h.flow.load();let rendered=0;h.flow.onChange=()=>rendered++;
  let count=h.calls.length;await h.flow.tick();await h.flow.changes.tick();
  assert.equal(h.calls.length,count);assert.equal(rendered,0);
  h.db.turn={id:'turn',status:'queued',input_generation:0};await h.flow.refresh();rendered=0;count=h.calls.length;
  await h.flow.tick();assert.ok(h.calls.length>count);assert.equal(rendered,0);assert.equal(h.flow.state.busy,false);
  h.db.turn.status='succeeded';await h.flow.tick();assert.equal(rendered,1);
  count=h.calls.length;await h.flow.tick();assert.equal(h.calls.length,count);assert.equal(rendered,1);
});

test('a user action waits for a silent refresh instead of being dropped',async()=>{
  const h=fixture();await h.flow.load();let resume,started=false;
  const background=h.flow.run(()=>new Promise(resolve=>{resume=resolve;}),{background:true});
  const action=h.flow.run(async()=>{started=true;});
  assert.equal(started,false);resume();await background;await action;assert.equal(started,true);
});

test('publication polling also follows the selected detail when the attachment list omits publication status',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');h.flow.saved.autoRead={};
  h.db.intents[0].status='awaiting_review';await h.flow.snapshot();
  h.flow.state.detail.outcome={publication:{status:'running'}};
  const count=h.calls.length;await h.flow.tick();assert.ok(h.calls.length>count);
});

test('transient progress read failure reconnects and updates batches without resubmitting extraction',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');h.flow.saved.autoRead={};
  h.db.intents[0].status='running';h.db.intents[0].execution={id:'e',status:'running',progress:{completed_units:0,total_units:null}};
  await h.flow.refresh();let failOnce=true;const call=h.flow.call;
  h.flow.call=async(action,input)=>{if(action==='conversation-intent'&&failOnce){failOnce=false;throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED',status:0});}return call(action,input);};
  await h.flow.tick();assert.equal(h.flow.state.progressRetryable,true);
  h.db.intents[0].execution.progress.completed_units=2;await h.flow.tick();
  assert.equal(h.flow.state.error,'');assert.equal(h.flow.state.detail.execution.progress.completed_units,2);
  assert.match(knowledgeStage(h.flow),/已完成 2 个批次/);assert.doesNotMatch(knowledgeStage(h.flow),/<button|核对材料知识/);
  h.db.intents[0].status='awaiting_review';h.db.intents[0].execution.status='succeeded';await h.flow.tick();
  assert.match(knowledgeStage(h.flow),/读取抽取候选/);
  const count=h.calls.length;await h.flow.tick();assert.equal(h.calls.length,count);
  assert.equal(h.calls.some(c=>c.action==='conversation-confirm'||c.action==='conversation-retry'),false);
});

test('running extraction hides stale candidates and drafts, even when inspecting an older card',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');
  h.flow.state.detail.status='running';h.flow.state.detail.execution={id:'e',status:'running'};
  h.flow.state.detail.review={draft_id:'old'};h.flow.changes.record.draftId='old';h.flow.state.inspectCard='plan';
  assert.equal(nextConversationStep(h.flow),'extracting');
  assert.doesNotMatch(knowledgeStage(h.flow),/<button|完整材料草稿|读取发布/);
  const html=conversationHTML({id:'warehouse',state:'active',name:'仓'},null,null,true,h.flow);
  assert.match(html,/data-next-step="extracting"/);assert.doesNotMatch(html,/id="cv-inline-rules"/);
});
test('lost creation response replays original operation after reload',async()=>{
  const f=fixture();f.db.lose='conversation-create';await f.flow.load();const pending=clone(f.flow.saved.pending);
  f.flow=f.make();await f.flow.load();await f.flow.retryPending();
  assert.deepEqual(f.calls.filter(c=>c.action==='conversation-create').at(-1).input,pending.input);
  assert.equal(f.flow.state.overview.id,'conversation');assert.equal(f.flow.saved.pending,null);
});
test('double send and response loss retain immutable message and revision',async()=>{
  const f=fixture();await f.flow.load();f.flow.state.input='记录合同';f.db.lose='conversation-send';
  await Promise.all([f.flow.send(),f.flow.send()]);assert.equal(f.db.messages.length,1);
  const input=clone(f.flow.saved.pending.input);f.flow=f.make();await f.flow.load();f.flow.state.input='不得替换原消息';
  await f.flow.retryPending();assert.deepEqual(f.calls.filter(c=>c.action==='conversation-send').at(-1).input,input);
  assert.equal(f.db.messages.length,1);assert.equal(f.flow.saved.pending,null);
});
test('bound upload recovers a lost commit and initial read never confirms extraction',async()=>{
  const f=fixture();await f.flow.load();f.db.lose='upload';await f.flow.attachFiles();const original=clone(f.flow.saved.pending);
  f.flow=f.make();await f.flow.load();await f.flow.retryPending();
  assert.deepEqual(f.calls.filter(c=>c.action==='upload').at(-1).input,original.input);assert.equal(f.db.uploads,1);
  await f.flow.tick();assert.equal(f.calls.filter(c=>c.action==='conversation-analyze').length,1);
  await f.flow.tick();assert.equal(f.calls.filter(c=>c.action==='conversation-analyze').length,1);
  assert.equal(f.calls.some(c=>['conversation-goal','conversation-confirm','conversation-review'].includes(c.action)),false);
});
test('goal confirmation and extraction are two distinct explicit actions; stale plan never silently changes',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.state.goal='提取药品';f.flow.state.instructions='以正文为准';f.flow.state.goalDirty=true;
  await f.flow.goal();assert.equal(f.db.intents[0].status,'ready_for_confirmation');assert.equal(f.flow.state.plan,null);assert.equal(f.flow.state.stage,2);await f.flow.preview();assert.ok(f.flow.state.plan);
  assert.equal(f.calls.some(c=>c.action==='conversation-confirm'),false);
  f.db.refuse='conversation-confirm';await f.flow.confirmPlan();assert.match(f.flow.state.error,/变化/);
  const sent=f.calls.filter(c=>c.action==='conversation-confirm').at(-1).input;
  assert.equal(sent.planDigest,'a'.repeat(64));assert.equal(f.flow.saved.pending,null);
});
test('merge needs explicit conflict acknowledgement and does not publish; editor secrets are not stored',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');await f.flow.review();
  await f.flow.merge(false);assert.equal(f.calls.some(c=>c.action==='conversation-review'),false);
  await f.flow.merge(true);assert.equal(f.flow.state.error,'');assert.equal(f.flow.changes.state.summary.id,'draft');
  assert.equal(f.calls.some(c=>/publish|submit/.test(c.action)),false);
  assert.equal(f.calls.some(c=>c.action==='conversation-editor-release'||c.action==='conversation-editor-claim'),false);
  assert.doesNotMatch([...f.storage.values()].join(''),/ssssssssssssssssssss|_native_editor|editor_session/);
});
test('superseded reads cannot update a new account or warehouse',async()=>{
  const f=fixture();await f.flow.load();let finish;
  f.flow.call=async()=>new Promise(resolve=>finish=resolve);
  const pending=f.flow.refresh();f.invalidate();finish({items:[],has_more:false});await pending;
  assert.equal(f.flow.state.error,'');
  const other=fixture(f.storage,2);await other.flow.load();
  assert.equal(other.calls.filter(c=>c.action==='conversation-create').length,1);
});
test('failed/superseded replies cannot seed current goals; untrusted message text stays escaped',async()=>{
  const overview={input_generation:3};
  for(const turn of [{status:'failed'},{status:'succeeded',is_current:false},{status:'succeeded',is_current:true,content_status:'stale',input_generation:3}])assert.equal(currentReply(turn,overview),null);
  assert.match(messageReply({role:'assistant',content_status:'removed',content:'secret'}).answer,/来源已失效/);
  const f=fixture();await f.flow.load();f.flow.state.messages=[{role:'user',content:'<img onerror=x>'},{role:'assistant',content_status:'available',content:JSON.stringify({answer:'<script>x</script>'})}];
  assert.doesNotMatch(conversationThread(f.flow),/<img|<script/);
  assert.match(conversationGoal(f.flow),/先上传或关联/);
});

test('only explicitly applicable current replies can offer goal actions, including legacy responses',async()=>{
  const overview={input_generation:4},reply={answer:'当前建议',goal_summary:'当前目标',ready_for_confirmation:true};
  const valid={status:'succeeded',is_current:true,content_status:'available',applicable_to_current:true,input_generation:4,reply};
  assert.equal(currentReply(valid,overview),reply);
  for(const change of [{applicable_to_current:undefined},{applicable_to_current:false},{applicable_to_current:'true'},
    {is_current:false},{is_historical:true},{content_status:'historical'},{content_status:'source_changed'},{input_generation:3}]){
    assert.equal(currentReply({...valid,...change},overview),null);
  }
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.state.turn={...valid,content_status:'historical'};f.flow.state.overview.input_generation=4;
  f.flow.state.goal='用户正在编辑的目标';f.flow.useSuggestedGoal();
  assert.equal(f.flow.state.goal,'用户正在编辑的目标');
  assert.doesNotMatch(conversationGoal(f.flow),/data-cv="use-goal"/);
});

test('historical messages retain answers and questions in sequence order regardless of timestamps',async()=>{
  const f=fixture();await f.flow.load();
  const assistant=(sequence,content_status,is_historical,answer)=>({role:'assistant',sequence,content_status,is_historical,invalid_reason:'goal_changed',applicable_to_current:false,
    created_at:sequence===2?'2026-11-09T10:02:00Z':'2026-11-09T10:01:00Z',content:JSON.stringify({answer,questions:['旧追问'],goal_summary:'旧目标',ready_for_confirmation:false})});
  f.flow.state.messages=[assistant(4,'historical',false,'第二轮正文'),assistant(2,'available',true,'第一轮正文 <旧值>'),{role:'user',sequence:1,content:'第一个问题',created_at:'2026-11-09T10:03:00Z'}];
  const html=conversationTimeline(f.flow);
  assert.ok(html.indexOf('第一个问题')<html.indexOf('第一轮正文'));
  assert.ok(html.indexOf('第一轮正文')<html.indexOf('第二轮正文'));
  assert.equal((html.match(/基于旧上下文，仅供参考/g)||[]).length,2);
  assert.match(html,/整理目标已变化/);assert.match(html,/旧追问/);assert.match(html,/&lt;旧值&gt;/);
  assert.doesNotMatch(html,/data-cv="(?:use-goal|confirm-plan|change-publish)"/);
});

test('saving a goal reloads both historical replies and reopening cannot revive their suggestions',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.db.messages=[{role:'user',sequence:1,content:'第一问'},
    {role:'assistant',sequence:2,content_status:'available',applicable_to_current:true,content:JSON.stringify({answer:'第一答'})},
    {role:'user',sequence:3,content:'第二问'},
    {role:'assistant',sequence:4,content_status:'available',applicable_to_current:true,content:JSON.stringify({answer:'第二答',goal_summary:'旧建议',ready_for_confirmation:true})}];
  f.db.turn={id:'turn-2',status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',input_generation:4,reply:JSON.parse(f.db.messages[3].content)};
  await f.flow.refresh();f.flow.state.goal='用户确认的新目标';
  const call=f.flow.call;
  f.flow.call=async(action,input)=>{const result=await call(action,input);if(action==='conversation-goal'){
    for(const m of f.db.messages.filter(m=>m.role==='assistant'))Object.assign(m,{content_status:'historical',is_historical:true,applicable_to_current:false,invalid_reason:'goal_changed'});
    Object.assign(f.db.turn,{status:'stale',is_current:false,is_historical:true,applicable_to_current:false,content_status:'historical',invalid_reason:'goal_changed'});
  }return result;};
  await f.flow.goal();assert.equal(f.flow.state.error,'');
  assert.equal(f.flow.state.messages.filter(m=>m.content_status==='historical').length,2);
  f.flow=f.make();await f.flow.load();await f.flow.tick();
  const html=conversationThread(f.flow);
  assert.match(html,/第一答/);assert.match(html,/第二答/);assert.match(html,/历史回复，仅供参考/);
  assert.equal(f.flow.state.goal,'用户确认的新目标');assert.equal(f.flow.state.plan,null);
  assert.doesNotMatch(html,/data-cv="use-goal"/);
  assert.equal(f.calls.some(c=>['conversation-analyze','conversation-send','conversation-confirm','conversation-change-publish'].includes(c.action)),false);
});

test('source stamp changes reread existing messages even without a new sequence or revision',async()=>{
  const f=fixture();await f.flow.load();
  f.db.messages=[{role:'assistant',sequence:1,content_status:'available',content:JSON.stringify({answer:'保留的原答复'})}];
  await f.flow.refresh();const revision=f.db.revision;
  f.db.stamp='purpose-updated';Object.assign(f.db.messages[0],{content_status:'historical',is_historical:true,applicable_to_current:false,invalid_reason:'purpose_changed'});
  await f.flow.refresh();assert.equal(f.db.revision,revision);
  assert.match(conversationTimeline(f.flow),/知识仓用途已变化/);
  assert.match(conversationTimeline(f.flow),/保留的原答复/);
});

test('message pagination restarts when source stamp changes so old and new history states are not mixed',async()=>{
  const f=fixture();await f.flow.load();
  f.db.messages=[{role:'user',sequence:1,content:'一'},
    {role:'assistant',sequence:2,content_status:'available',content:JSON.stringify({answer:'第一答'})},
    {role:'user',sequence:3,content:'二'},
    {role:'assistant',sequence:4,content_status:'available',content:JSON.stringify({answer:'第二答'})}];
  const call=f.flow.call,cursors=[];let changed=false;
  f.flow.call=async(action,input)=>{
    if(action!=='conversation-messages')return call(action,input);
    cursors.push(input.afterSequence);
    if(input.afterSequence===2&&!changed){changed=true;f.db.stamp='rules-changed';
      for(const m of f.db.messages.filter(m=>m.role==='assistant'))Object.assign(m,{content_status:'historical',is_historical:true,applicable_to_current:false,invalid_reason:'ontology_changed'});}
    const items=clone(f.db.messages.filter(m=>m.sequence>input.afterSequence).slice(0,2));
    return {items,has_more:items.at(-1).sequence<4,next_sequence:items.at(-1).sequence};
  };
  await f.flow.refresh();assert.equal(f.flow.state.error,'');
  assert.deepEqual(cursors,[0,2,0,2]);
  assert.deepEqual(f.flow.state.messages.map(m=>m.sequence),[1,2,3,4]);
  assert.equal(f.flow.state.messages.filter(m=>m.content_status==='historical').length,2);
  assert.equal(f.flow.state.overview.source_stamp,'rules-changed');
});

test('source removal replaces cached reply bodies even if a later snapshot read fails',async()=>{
  const f=fixture();await f.flow.load();
  f.db.messages=[{id:'message',role:'assistant',sequence:1,content_status:'historical',content:JSON.stringify({answer:'不得残留的旧正文',questions:['旧问题']})}];
  f.db.turn={id:'turn',status:'stale',is_current:false,content_status:'historical',reply:{answer:'不得残留的旧正文'}};
  await f.flow.refresh();
  Object.assign(f.db.messages[0],{content_status:'source_unavailable',is_historical:false,applicable_to_current:false,content:JSON.stringify({answer:'材料已不可访问，请重新选择。'})});
  f.db.turn={...f.db.turn,content_status:'source_unavailable'};delete f.db.turn.reply;
  const call=f.flow.call;f.flow.call=async(action,input)=>{if(action==='conversation-intents')throw Object.assign(Error(),{status:503});return call(action,input);};
  await f.flow.refresh();
  assert.doesNotMatch(JSON.stringify(f.flow.state.messages),/不得残留的旧正文|旧问题/);
  assert.equal(f.flow.state.turn.reply,undefined);
  assert.match(conversationTimeline(f.flow),/材料已不可访问/);
  f.flow.call=call;f.flow=f.make();await f.flow.load();
  assert.doesNotMatch(conversationThread(f.flow),/不得残留的旧正文|旧问题/);
});

test('source changed notices override historical flags and expose no cached suggestion fields',()=>{
  const notice=messageReply({role:'assistant',content_status:'source_changed',is_historical:true,
    content:JSON.stringify({answer:'正文版本已更新。',goal_summary:'不得沿用',questions:['不得沿用'],coverage:[{document_id:'old'}]})});
  assert.deepEqual(notice,{answer:'正文版本已更新。'});
  for(const content of ['未清理的旧原文',JSON.stringify({goal_summary:'未清理的旧原文'})]){
    assert.doesNotMatch(messageReply({role:'assistant',content_status:'source_unavailable',content}).answer,/未清理的旧原文/);
  }
});

test('a known context change revokes old proposals and publication confirmation before a failed refresh',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.changes.state.proposals=[{id:'old',status:'prepared',can_apply:true,result:{changes:[{scope:'facts',before:null,after:{name:'旧提案'}}]}}];
  f.flow.changes.state.context={context_digest:'old'};
  f.flow.changes.state.preview={revision:1,ready_for_confirmation:true};f.flow.changes.state.publishConfirmed=true;f.flow.changes.state.ruleConfirmed=true;
  f.flow.state.turn={status:'succeeded',is_current:true,content_status:'available',applicable_to_current:true,input_generation:0,reply:{answer:'旧回复',goal_summary:'旧建议'}};
  const call=f.flow.call;f.db.stamp='changed-rules';
  f.flow.call=async(action,input)=>{if(action==='conversation-messages')throw Object.assign(Error(),{status:503});return call(action,input);};
  await f.flow.refresh();
  assert.equal(f.flow.changes.state.preview,null);assert.equal(f.flow.changes.state.publishConfirmed,false);assert.equal(f.flow.changes.state.ruleConfirmed,false);
  assert.deepEqual(f.flow.changes.state.proposals,[]);assert.equal(currentReply(f.flow.state.turn,f.flow.state.overview),null);
  assert.doesNotMatch(conversationThread(f.flow),/旧提案|data-cv="use-goal"/);
});

test('live source removal clears proposal and draft bodies without requiring a page reload',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.db.messages=[{id:'m',sequence:1,role:'assistant',content_status:'available',content:JSON.stringify({answer:'受限正文'})}];
  await f.flow.refresh();
  f.flow.changes.state.proposals=[{id:'old',status:'prepared',can_apply:true,instruction:'受限正文',result:{changes:[]}}];
  f.flow.changes.state.items={items:[{payload:{name:'受限正文'}}]};f.flow.changes.state.source={text:'受限正文'};
  f.flow.changes.state.summary={id:'draft',status:'editing'};f.flow.changes.owner={draftId:'draft'};
  Object.assign(f.db.messages[0],{content_status:'source_unavailable',content:JSON.stringify({answer:'来源不可用'})});
  const call=f.flow.call;f.flow.call=async(action,input)=>{if(action==='conversation-intents')throw Object.assign(Error(),{status:503});return call(action,input);};
  await f.flow.refresh();
  assert.doesNotMatch(JSON.stringify(f.flow.changes.state),/受限正文/);
  assert.equal(f.flow.changes.owner,null);assert.equal(f.flow.intake.source,null);
  assert.doesNotMatch(conversationTimeline(f.flow),/受限正文/);
});

test('historical metadata revokes suggestion actions even if the rest of the snapshot fails',async()=>{
  const f=fixture();await f.flow.load();
  f.db.messages=[{id:'m',sequence:1,role:'assistant',content_status:'available',content:JSON.stringify({answer:'保留旧回复',goal_summary:'旧建议'})}];
  f.db.turn={id:'t',status:'succeeded',is_current:true,content_status:'available',applicable_to_current:true,input_generation:1,reply:JSON.parse(f.db.messages[0].content)};
  await f.flow.refresh();Object.assign(f.db.messages[0],{content_status:'historical',is_historical:true,applicable_to_current:false});
  const call=f.flow.call;f.flow.call=async(action,input)=>{if(action==='conversation-intents')throw Object.assign(Error(),{status:503});return call(action,input);};
  await f.flow.refresh();
  assert.match(conversationTimeline(f.flow),/保留旧回复/);assert.match(conversationTimeline(f.flow),/基于旧上下文/);
  assert.equal(currentReply(f.flow.state.turn,f.flow.state.overview),null);
});

test('initial reading conflict follows the existing turn and retries only after completion',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  const call=f.flow.call;let rejected=false;
  f.flow.call=async(action,input)=>{
    if(action==='conversation-analyze'&&!rejected){rejected=true;f.calls.push({action,input:clone(input)});
      f.db.turn={id:'original-question',status:'running',input_generation:0};
      throw Object.assign(Error(),{code:'MODELING_TURN_BUSY',status:409});}
    return call(action,input);
  };
  await f.flow.analyze();
  assert.equal(f.flow.saved.pending,null);assert.equal(f.flow.state.error,'');assert.equal(f.flow.state.turn.id,'original-question');
  assert.equal(f.flow.state.turn.status,'running');assert.equal(f.flow.state.readWaiting,true);
  assert.match(conversationThread(f.flow),/当前问答完成后可继续读取材料/);
  await f.flow.tick();await f.flow.analyze();
  assert.equal(f.calls.filter(c=>c.action==='conversation-analyze').length,1);
  f.db.turn={...f.db.turn,status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',reply:{answer:'原问答正常完成'}};
  await f.flow.tick();assert.equal(f.flow.state.turn.status,'succeeded');
  assert.equal(f.calls.filter(c=>c.action==='conversation-analyze').length,1);
  await f.flow.analyze();
  const reads=f.calls.filter(c=>c.action==='conversation-analyze');assert.equal(reads.length,2);
  assert.notEqual(reads[0].input.operationId,reads[1].input.operationId);
  assert.equal(f.flow.state.readWaiting,false);
  assert.equal(f.calls.some(c=>['conversation-send','conversation-turn-cancel','conversation-turn-retry'].includes(c.action)),false);
});

test('first goal reading conflict does not create duplicate messages or fail the original turn',async()=>{
  const f=fixture();await f.flow.load();await f.flow.intake.stageFile();await f.flow.submitInput();await f.flow.intake.confirm();
  const call=f.flow.call;
  f.flow.call=async(action,input)=>{if(action==='conversation-analyze'){
    f.db.turn={id:'existing',status:'queued',input_generation:0};
    throw Object.assign(Error(),{code:'MODELING_TURN_BUSY',status:409});}return call(action,input);};
  await f.flow.intake.startGoal();assert.equal(f.flow.saved.pending,null);assert.equal(f.flow.intake.record.goalTurnId,undefined);
  assert.equal(f.flow.state.turn.id,'existing');assert.equal(f.flow.state.error,'');
  await f.flow.tick();assert.equal(f.flow.state.turn.status,'queued');
  assert.equal(f.calls.some(c=>['conversation-send','conversation-turn-cancel','conversation-turn-retry'].includes(c.action)),false);
});
test('navigation is not completion; a suggestion or unconfirmed goal cannot confirm a plan',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  await f.flow.goStage(3);assert.deepEqual(materialProgress(f.flow.state.detail),{goal:false,execution:false,published:false,stage:1});
  assert.doesNotMatch(materialStatusHTML(f.flow),/✓/);
  await f.flow.confirmPlan();assert.equal(f.calls.some(c=>c.action==='conversation-confirm'),false);
  f.flow.state.goal='付款安排';await f.flow.goal();assert.equal(materialProgress(f.flow.state.detail).goal,true);
  assert.match(ontologyStage(f.flow),/沿用当前本体/);assert.equal(f.flow.state.plan,null);
  await f.flow.preview();f.flow.state.goalDirty=true;await f.flow.confirmPlan();
  assert.equal(f.calls.some(c=>c.action==='conversation-confirm'),false);
});
test('lost extraction response recovers the same request after reload, without rerunning goal or plan',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');f.flow.state.goal='付款安排';await f.flow.goal();await f.flow.preview();
  f.db.lose='conversation-confirm';await f.flow.confirmPlan();const p=clone(f.flow.saved.pending);
  f.flow=f.make();await f.flow.load();assert.equal(f.flow.state.stage,3);await f.flow.retryPending();
  assert.deepEqual(f.calls.filter(c=>c.action==='conversation-confirm').at(-1).input,p.input);
  assert.equal(f.calls.filter(c=>c.action==='conversation-plan').length,1);
  assert.equal(materialProgress(f.flow.state.detail).published,false);
});
test('published ontology change clears old plan; merely opening rules does not submit work',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');f.flow.state.goal='付款安排';await f.flow.goal();await f.flow.preview();
  f.db.ontologyId='new-ontology';Object.assign(f.db.intents[0],{status:'awaiting_goal',revision:4,goal:null});
  await f.flow.refresh();assert.equal(f.flow.state.plan,null);assert.equal(f.flow.state.acceptedOntology,null);
  assert.equal(materialProgress(f.flow.state.detail).goal,false);await f.flow.goStage(2);
  assert.match(ontologyStage(f.flow),/重新确认目标/);
  assert.equal(f.calls.some(c=>c.action==='conversation-confirm'),false);
  f.flow.state.goal='付款安排';await f.flow.goal();await f.flow.preview();assert.equal(f.flow.state.plan.ontology_id,'new-ontology');
});
test('goal confirmation refuses a newer server revision instead of silently overwriting it',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');f.flow.state.goal='本页目标';f.db.revision++;
  await f.flow.goal();assert.equal(f.calls.some(c=>c.action==='conversation-goal'),false);assert.match(f.flow.state.error,/变化/);
});
test('selected attachment persists across refresh and restores its own goal and receipt',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.db.intents.push({id:'second',revision:1,document_id:'second-doc',document_version_id:'second-version',source_status:'available',status:'awaiting_goal'});
  await f.flow.refresh();await f.flow.chooseIntent('second');f.flow=f.make();await f.flow.load();
  assert.equal(f.flow.state.selectedIntent,'second');assert.equal(f.flow.state.goal,'');assert.equal(f.flow.state.stage,1);
  assert.equal(f.flow.state.plan,null);assert.equal(f.flow.state.knowledge,null);
});
test('publication completion requires matching effective run read, not submission or old results',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  Object.assign(f.db.intents[0],{status:'awaiting_review',goal:{goal:'付款安排'},execution:{id:'execution',status:'succeeded'},
    review:{draft_id:'draft',status:'submitted'},outcome:{current_run_id:'old',publication:{status:'running',run_status:'pending',effective:false,run_id:'new'}}});
  await f.flow.refresh();assert.equal(materialProgress(f.flow.state.detail,f.flow.state.knowledge).published,false);
  assert.equal(f.calls.some(c=>c.action==='conversation-published-run'),false);
  Object.assign(f.db.intents[0].outcome,{current_run_id:'new',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'new'}});
  f.db.knowledge={run:{id:'new',status:'published',document_id:'doc',document_version_id:'version'},candidates:[{kind:'entity',status:'published',payload:{name:'甲公司',type:'ORG'},evidence:[{excerpt:'甲公司签订合同 A'}]},
    ...['pending','approved','rejected','invalid'].map(status=>({kind:'entity',status,payload:{name:'未生效条目'+status,type:'ORG'},evidence:[]}))]};
  await f.flow.refresh();assert.equal(materialProgress(f.flow.state.detail,f.flow.state.knowledge).published,true);
  assert.match(knowledgeStage(f.flow),/已读取当前生效知识/);assert.match(knowledgeStage(f.flow),/甲公司签订合同 A/);
  assert.match(knowledgeStage(f.flow),/当前生效的材料知识 · 1 项/);assert.doesNotMatch(knowledgeStage(f.flow),/未生效条目|本次发布没有保留事实条目/);
  const thread=conversationThread(f.flow);
  assert.match(thread,/<span>已发布并读取生效知识<\/span>/);
  assert.match(thread,/<small>已发布并读取生效知识<\/small>/);
  const publishedItems=f.flow.state.knowledge.candidates;f.flow.state.knowledge.candidates=[];
  assert.match(knowledgeStage(f.flow),/当前生效的材料知识 · 0 项/);
  assert.match(knowledgeStage(f.flow),/本次发布没有保留事实条目/);
  f.flow.state.knowledge.candidates=publishedItems;
  f.flow.state.intents.push({id:'other',original_name:'另一个材料',status:'awaiting_review'});
  assert.match(conversationThread(f.flow),/另一个材料 <small>抽取完成，待核对<\/small>/);
  assert.equal(knowledgeCurrent(f.flow.state.detail,{...f.db.knowledge,run:{...f.db.knowledge.run,document_id:'another'}}),false);
  f.db.intents[0].outcome.current_run_id='replacement';f.db.intents[0].outcome.publication.effective=false;
  await f.flow.refresh();assert.equal(f.flow.state.knowledge,null);assert.equal(materialProgress(f.flow.state.detail).published,false);
});
test('a lost merge response reloads the server draft instead of merging again',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');await f.flow.review();
  f.db.lose='conversation-review';await f.flow.merge(true);assert.ok(f.flow.reviewPending);
  f.flow=f.make();await f.flow.load();await f.flow.review();
  assert.equal(f.flow.state.openDraft,'doc');assert.equal(f.calls.filter(c=>c.action==='conversation-review').length,1);
});
test('a publication receipt alone cannot complete the stage when effective knowledge read fails',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  Object.assign(f.db.intents[0],{status:'awaiting_review',goal:{goal:'付款安排'},execution:{id:'execution',status:'succeeded'},
    outcome:{current_run_id:'published',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'published'}}});
  const call=f.flow.call;f.flow.call=(action,input)=>action==='conversation-published-run'?Promise.reject(Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED'})):call(action,input);
  await f.flow.refresh();assert.equal(materialProgress(f.flow.state.detail,f.flow.state.knowledge).published,false);
  assert.match(materialStatusHTML(f.flow),/待读取生效知识/);
  assert.equal(f.calls.some(c=>/submit|publish/.test(c.action)),false);
});
test('automatically selecting a newly linked attachment clears the previous unsaved goal and source stamp',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.state.goal='只属于第一份合同';f.flow.state.instructions='不得带到附件二';f.flow.state.goalDirty=true;f.flow.state.suggestedGoalStamp='old-source';
  f.db.intents.push({id:'second',revision:1,document_id:'doc-two',document_version_id:'v-two',source_status:'available',status:'awaiting_goal'});
  f.flow.apply({kind:'link'},{resource_id:'second'});await f.flow.refresh();
  assert.equal(f.flow.state.selectedIntent,'second');assert.equal(f.flow.state.goal,'');assert.equal(f.flow.state.instructions,'');
  assert.equal(f.flow.state.suggestedGoalStamp,null);assert.equal(f.flow.state.stage,1);
});
test('typing while message or goal submission is in flight is not erased by the earlier receipt',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');const call=f.flow.call;
  f.flow.state.input='先发送这句';f.flow.call=async(action,input)=>{
    if(action==='conversation-send')f.flow.state.input='请求期间继续写的内容';return call(action,input);
  };
  await f.flow.send();assert.equal(f.flow.state.input,'请求期间继续写的内容');
  f.db.turn.status='succeeded';
  f.flow.state.goal='付款';f.flow.state.instructions='';f.flow.state.goalDirty=true;f.flow.state.suggestedGoalStamp=f.db.stamp;
  f.flow.call=async(action,input)=>{
    if(action==='conversation-goal'){f.flow.state.goal='付款及违约';f.flow.state.instructions='新补充';}return call(action,input);
  };
  await f.flow.goal();assert.equal(f.flow.state.goal,'付款及违约');assert.equal(f.flow.state.instructions,'新补充');
  assert.equal(f.flow.state.goalDirty,true);assert.equal(f.flow.state.detail.goal.goal,'付款');
});
test('refresh after a lost merge cannot strand the immutable retry when the material revision changes',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');await f.flow.review();
  f.db.lose='conversation-review';await f.flow.merge(true);const original=clone(f.flow.reviewPending.input);
  f.db.intents[0].revision++;await f.flow.refresh();assert.equal(f.flow.state.merge,null);
  assert.match(editorRecoveryHTML(f.flow),/恢复原合并请求/);
  await f.flow.merge(false);assert.deepEqual(f.calls.filter(c=>c.action==='conversation-review').at(-1).input,{...original,warehouseId:'warehouse'});
  assert.equal(f.flow.changes.state.summary.id,'draft');assert.equal(f.flow.reviewPending,null);
});
test('existing owned draft is explicitly claimed before merge and lost claim replays the original envelope',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.db.leases=[{draft_id:'existing',revision:4,status:'editing',suspended:true,legacy_unowned:false}];
  await f.flow.review();assert.equal(f.flow.state.merge,null);assert.equal(f.calls.some(c=>c.action==='conversation-editor-claim'),false);
  assert.match(knowledgeStage(f.flow),/恢复此草稿并预览合并/);
  f.db.lose='conversation-editor-claim';await f.flow.claimReview('existing');const original=clone(f.flow.claimPending);
  await f.flow.chooseIntent('another');assert.equal(f.flow.state.selectedIntent,'intent');
  await f.flow.claimReview('ignored');assert.deepEqual(f.calls.filter(c=>c.action==='conversation-editor-claim').at(-1).input,{...original,warehouseId:'warehouse'});
  const preview=f.calls.filter(c=>c.action==='conversation-review-plan').at(-1).input;
  assert.equal(preview.draftId,'existing');assert.equal(preview.editor.generation,'3');assert.equal(preview.editor.session,'s'.repeat(30));
  assert.equal(f.calls.some(c=>c.action==='conversation-review'),false);
  assert.doesNotMatch([...f.storage.values()].join(''),/ssssssssssss|editor_session|claimPending/);
});
test('legacy or submitted drafts cannot be silently claimed from the merge page',async()=>{
  for(const draft of [{legacy_unowned:true,status:'editing'},{legacy_unowned:false,status:'submitted'}]){
    const f=fixture();await f.flow.load();await f.flow.link('doc');f.db.leases=[{draft_id:'old',revision:1,...draft}];
    await f.flow.review();await f.flow.claimReview('old');assert.equal(f.calls.some(c=>c.action==='conversation-editor-claim'),false);
    assert.match(knowledgeStage(f.flow),/进入编辑器核对草稿归属和发布进度/);
  }
});
test('lost access clears recoverable draft metadata, goal inputs and in-memory editor credentials',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');f.db.leases=[{draft_id:'private',revision:1,status:'editing'}];
  await f.flow.review();f.flow.state.goal='私有目标';f.flow.state.input='私有对话';
  f.flow.call=async()=>{throw Object.assign(Error(),{code:'MODELING_RESOURCE_NOT_FOUND',status:403});};
  await f.flow.refresh();assert.equal(f.flow.state.loaded,false);assert.equal(f.flow.state.recoverable,null);
  assert.equal(f.flow.state.goal,'');assert.equal(f.flow.state.input,'');assert.equal(f.flow.reviewEditor,null);
  assert.doesNotMatch(knowledgeStage(f.flow),/private|私有目标/);
});

test('conversation renders only the next receipt-driven card and keeps inspections separate',async()=>{
  const f=fixture();await f.flow.load();assert.equal(nextConversationStep(f.flow),'upload');
  await f.flow.link('doc');assert.equal(nextConversationStep(f.flow),'goal');
  const page=()=>conversationHTML({id:'warehouse',state:'active',name:'验收仓'},null,null,true,f.flow);
  assert.match(page(),/data-next-step="goal"/);assert.doesNotMatch(page(),/id="cv-inline-rules"|cv-publication-preview|class="cv-change-panel"/);
  f.flow.state.goal='关注付款';f.flow.state.goalDirty=true;await f.flow.goal();
  assert.equal(nextConversationStep(f.flow),'plan');assert.doesNotMatch(page(),/id="cv-goal-form"|cv-publication-preview/);
  await f.flow.preview();await f.flow.confirmPlan();assert.equal(nextConversationStep(f.flow),'extracting');
  f.db.intents[0].status='awaiting_review';f.db.intents[0].execution.status='succeeded';await f.flow.refresh();
  assert.equal(nextConversationStep(f.flow),'candidates');
  f.flow.changes.record.draftId='draft';assert.equal(nextConversationStep(f.flow),'draft');
  f.flow.changes.state.summary={id:'draft',status:'editing'};f.flow.changes.state.preview={ready_for_confirmation:true};
  assert.equal(nextConversationStep(f.flow),'publication');
  f.flow.changes.record.pending={action:'conversation-change-publish'};assert.equal(nextConversationStep(f.flow),'recovery');
});

test('a changed goal reviews a new plan and merges new candidates before returning to its retained draft',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');
  const c=h.flow.changes;c.record.previousIntent='historical-intent';c.record.draftId='draft';c.persist();
  c.owner={documentId:'doc',draftId:'draft',editor:{session:'s'.repeat(30),generation:'3'}};
  await c.loadDraft();
  assert.equal(nextConversationStep(h.flow),'goal');
  h.flow.state.goal='调整后的目标';await h.flow.goal();assert.equal(nextConversationStep(h.flow),'plan');
  assert.match(conversationHTML({id:'warehouse',state:'active',name:'验收仓'},null,null,true,h.flow),/沿用当前本体，读取计划/);
  assert.match(materialStatusHTML(h.flow),/待核对本体和计划/);
  await h.flow.preview();await h.flow.confirmPlan();assert.equal(nextConversationStep(h.flow),'extracting');
  h.db.intents[0].status='failed';h.db.intents[0].execution.status='failed';await h.flow.refresh();
  assert.equal(nextConversationStep(h.flow),'candidates');
  assert.match(conversationHTML({id:'warehouse',state:'active',name:'验收仓'},null,null,true,h.flow),/重试失败抽取/);
  h.db.intents[0].status='awaiting_review';h.db.intents[0].execution.status='succeeded';await h.flow.refresh();
  assert.equal(nextConversationStep(h.flow),'candidates');
  const restored=h.make();await restored.load();assert.equal(nextConversationStep(restored),'candidates');
  const calls=h.calls.length;h.flow.state.input='排除新结果中的错误事实';await h.flow.submitInput();assert.equal(h.flow.state.error,'');
  assert.equal(h.flow.state.input,'排除新结果中的错误事实');
  assert.equal(nextConversationStep(h.flow),'merge');
  const request=h.calls.slice(calls).find(c=>c.action==='conversation-review-plan');
  assert.equal(request.input.draftId,'draft');assert.equal(request.input.editor.generation,'3');
  assert.equal(h.calls.slice(calls).some(c=>/editor-session|editor-claim|conversation-review$/.test(c.action)),false);
  await h.flow.merge(false);assert.equal(h.calls.some(c=>c.action==='conversation-review'),false);
  await h.flow.merge(true);assert.equal(h.flow.state.error,'');assert.equal(nextConversationStep(h.flow),'draft');
  assert.equal(h.calls.some(c=>c.action.includes('publish')),false);
});

test('a pending proposal pauses later cards; deferring it persists without applying or publishing',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.changes.state.proposals=[{id:'p',status:'prepared',can_apply:true,result:{changes:[{scope:'goal'}]}}];
  f.flow.changes.record.lastProposal='p';assert.equal(nextConversationStep(f.flow),'proposal');
  f.flow.changes.record.deferredProposal='p';f.flow.changes.persist();assert.equal(nextConversationStep(f.flow),'goal');
  const restored=f.make();await restored.load();assert.equal(restored.changes.record.deferredProposal,'p');
  assert.equal(f.calls.some(c=>/apply|publish|confirm/.test(c.action)),false);
});

test('server draft resumes without a local source review marker and a proposal cannot be hidden by an old inspected card',async()=>{
  const h=fixture();await h.flow.load();await h.flow.link('doc');const f=h.flow;
  Object.assign(f.state.detail,{status:'awaiting_review',review:{draft_id:'draft'}});
  f.saved.intakeReviews={[f.state.selectedIntent]:{versionId:'version',stage:'source'}};
  assert.equal(f.intake.sourceReviewed,true);assert.equal(nextConversationStep(f),'draft');
  let html=conversationHTML({id:'warehouse',state:'active'},null,null,true,f);
  assert.match(html,/继续核对材料/);assert.doesNotMatch(html,/cv-source-review/);
  f.changes.state.summary={id:'draft',revision:1,status:'editing',counts:{entity:1,relation:0}};
  f.changes.state.items={items:[{id:'e',kind:'entity',payload:{name:'待修改实体'},evidence:[]}],offset:0,total:1,revision:1};
  f.changes.state.proposals=[{id:'p',status:'needs_clarification',result:{questions:['确认范围？']}}];
  f.state.inspectCard='draft';
  html=conversationHTML({id:'warehouse',state:'active'},null,null,true,f);
  assert.match(html,/等待你的补充说明/);assert.match(html,/待修改实体/);assert.match(html,/data-cv="change-answer"/);
  f.state.reviewingSource=true;assert.equal(f.intake.sourceReviewed,false);
  f.state.reviewingSource=false;f.state.detail.source_status='source_changed';assert.equal(f.intake.sourceReviewed,false);
});

test('natural-language routing never treats conversation as extraction or publication authorization',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  for(const text of ['只关注付款条件，不需要签署地点','把采购方和供应方合并为当事人','我的目标是整理合同义务'])assert.equal(conversationInputRoute(text,f.flow),'change');
  for(const text of ['为什么需要修改本体？','总结合同','不要修改任何内容','是否保留签署地点'])assert.equal(conversationInputRoute(text,f.flow),'question');
  const count=f.calls.length;f.flow.state.input='确认发布';await f.flow.submitInput();
  assert.equal(f.calls.length,count);assert.match(f.flow.state.inputNotice,/确认按钮/);
  let proposal=null;f.flow.changes.generate=async value=>{proposal=value;};
  f.flow.state.input='把采购方和供应方合并为当事人';await f.flow.submitInput();
  assert.equal(proposal,null);assert.match(f.flow.state.inputNotice,/明确修改对象/);assert.equal(f.calls.length,count);
  f.flow.state.composerContext='goal';f.flow.state.input='付款与截止日期';await f.flow.submitInput();
  assert.equal(proposal,'请调整当前材料的整理目标：付款与截止日期');
});

test('current assistant goal fills an unconfirmed card without writing or replacing user edits',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.db.turn={id:'turn',status:'succeeded',is_current:true,applicable_to_current:true,content_status:'available',input_generation:0,reply:{answer:'初步阅读完成',goal_summary:'提取付款义务'}};
  await f.flow.refresh();assert.equal(f.flow.state.goal,'提取付款义务');assert.equal(f.flow.state.goalDirty,true);
  assert.equal(f.calls.some(c=>c.action==='conversation-goal'),false);
  f.flow.state.goal='只关注逾期付款';await f.flow.refresh();assert.equal(f.flow.state.goal,'只关注逾期付款');
});

test('natural-language double submit preserves the active request and newer input',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.state.input='改为付款安排';f.flow.state.busy=true;
  let generated=0;f.flow.changes.generate=async()=>{generated++;};
  await f.flow.submitInput();assert.equal(generated,0);assert.equal(f.flow.state.input,'改为付款安排');
});

test('replies and change proposals share timestamp order rather than separate histories',async()=>{
  const f=fixture();await f.flow.load();
  f.flow.state.messages=[{role:'user',created_at:'2026-11-07T10:00:00Z',content:'先阅读合同'},{role:'user',created_at:'2026-11-07T10:02:00Z',content:'继续提问付款期限'}];
  f.flow.changes.state.proposals=[{id:'p',status:'applied',created_at:'2026-11-07T10:01:00Z',instruction:'中间调整付款安排'}];
  const html=conversationTimeline(f.flow);
  assert.ok(html.indexOf('先阅读合同')<html.indexOf('中间调整付款安排'));
  assert.ok(html.indexOf('中间调整付款安排')<html.indexOf('继续提问付款期限'));
});

test('switching materials retains each unsent message and never restores a goal onto a different source version',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.db.intents.push({id:'other',revision:1,status:'awaiting_goal',source_status:'available',document_id:'other-doc',document_version_id:'other-version'});
  Object.assign(f.flow.state,{input:'第一份的修改要求',goal:'第一份待确认目标',instructions:'保留关注点',goalDirty:true});
  await f.flow.chooseIntent('other');assert.equal(f.flow.state.input,'');assert.notEqual(f.flow.state.goal,'第一份待确认目标');
  f.flow.state.input='第二份的要求';await f.flow.chooseIntent('intent');
  assert.equal(f.flow.state.input,'第一份的修改要求');assert.equal(f.flow.state.goal,'第一份待确认目标');assert.equal(f.flow.state.goalDirty,true);
  await f.flow.chooseIntent('other');assert.equal(f.flow.state.input,'第二份的要求');
  f.db.intents[0].document_version_id='replacement-version';await f.flow.chooseIntent('intent');assert.notEqual(f.flow.state.goal,'第一份待确认目标');
});

test('loss of authorization clears the material directory as well as the active conversation',async()=>{
  const f=fixture();await f.flow.load();f.flow.state.materialIndex={old:[{id:'private',original_name:'不可再访问的材料'}]};
  await f.flow.run(()=>{throw Object.assign(Error(),{status:403,code:'FORBIDDEN'});});
  assert.equal(f.flow.state.loaded,false);assert.deepEqual(f.flow.state.materialIndex,{});assert.doesNotMatch(materialListHTML(f.flow),/不可再访问/);
});

test('a cancelled material with an old publication does not block staging a new file',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  Object.assign(f.db.intents[0],{status:'cancelled',outcome:{current_run_id:'old-run',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'old-run'}}});
  await f.flow.refresh();assert.equal(f.flow.state.error,'');await f.flow.intake.stageFile();
  assert.equal(f.flow.intake.staged.name,'材料.txt');assert.equal(f.calls.some(c=>c.action==='conversation-published-run'),false);
});

test('reselecting the active material keeps the current unsent edits and approved plan',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');
  f.flow.saved.materialComposers={'conversation:intent':{input:'已经发送的旧内容',goal:'旧目标',goalDirty:true,versionId:'version'}};
  Object.assign(f.flow.state,{input:'新的未发送内容',goal:'正在编辑的目标',goalDirty:true,plan:{plan_digest:'keep'},acceptedOntology:'ontology'});
  const reads=f.calls.length;await f.flow.chooseIntent('intent');await f.flow.selectMaterial('conversation','intent');
  assert.equal(f.flow.state.input,'新的未发送内容');assert.equal(f.flow.state.goal,'正在编辑的目标');assert.equal(f.flow.state.goalDirty,true);
  assert.deepEqual(f.flow.state.plan,{plan_digest:'keep'});assert.equal(f.flow.state.acceptedOntology,'ontology');assert.equal(f.calls.length,reads);
});

test('selecting a material in a different conversation loads the requested material in one locked transition',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');const original=f.flow.call;
  const targets=[{id:'first',revision:1,status:'awaiting_goal',source_status:'available',document_id:'first-doc',document_version_id:'first-version'},
    {id:'target',revision:1,status:'awaiting_goal',source_status:'available',document_id:'target-doc',document_version_id:'target-version'}];
  const reads=[],settled=[];f.flow.onChange=s=>{if(!s.busy)settled.push(s.selectedIntent);};
  f.flow.call=async(action,input)=>{
    if(input.conversationId==='other-session'){
      if(action==='conversation-get')return {id:'other-session',status:'active',revision:1,input_generation:0,source_stamp:'other'};
      if(action==='conversation-messages')return {items:[],has_more:false,next_sequence:0};
      if(action==='conversation-intents')return {items:targets,has_more:false,next_offset:2};
      if(action==='conversation-intent'){reads.push(input.intentId);return targets.find(i=>i.id===input.intentId);}
    }return original(action,input);
  };
  await f.flow.selectMaterial('other-session','target');assert.equal(f.flow.state.error,'');assert.deepEqual(reads,['target']);assert.deepEqual(settled,['target']);
});

test('failed durable intake save keeps the selected file and permits correcting the note before retry',async()=>{
  const f=fixture();await f.flow.load();await f.flow.intake.stageFile();const persist=f.flow.persist.bind(f.flow);
  f.flow.persist=()=>{if(f.flow.saved.intakeSubmission)throw Object.assign(Error(),{code:'MODELING_LOCAL_SAVE_FAILED'});persist();};
  await f.flow.intake.submit({isolated:true,note:'第一次填写'});
  assert.equal(f.flow.saved.intakeSubmission,null);assert.equal(f.flow.intake.staged.name,'材料.txt');assert.equal(f.db.uploads,0);
  f.flow.persist=persist;await f.flow.intake.submit({isolated:true,note:'修正后的说明'});
  assert.equal(f.flow.state.error,'');assert.equal(f.flow.intake.record.note,'修正后的说明');assert.equal(f.db.uploads,1);
});

test('an old publication receipt does not label a stopped material as published in the directory',async()=>{
  const f=fixture();await f.flow.load();f.flow.state.intents=[{id:'stopped',status:'cancelled',original_name:'已停止的材料',publication_effective:true}];
  assert.match(materialListHTML(f.flow),/已停止/);assert.doesNotMatch(materialListHTML(f.flow),/服务端已发布/);
});

test('failed material switching cannot leave old facts under a new selection and refresh restores the target composer',async()=>{
  const f=fixture();await f.flow.load();await f.flow.link('doc');const call=f.flow.call;
  f.db.intents.push({id:'target',revision:1,status:'awaiting_goal',source_status:'available',document_id:'target-doc',document_version_id:'target-version'});
  f.flow.saved.materialComposers={'conversation:target':{input:'目标材料未发送的说明',goal:'目标材料的草稿',instructions:'范围',goalDirty:true,versionId:'target-version'}};
  f.flow.call=async(action,input)=>{if(action==='conversation-intent'&&input.intentId==='target')throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED',status:503});return call(action,input);};
  await f.flow.chooseIntent('target');assert.equal(f.flow.state.loaded,false);assert.equal(f.flow.state.detail,null);assert.deepEqual(f.flow.state.messages,[]);assert.equal(f.flow.state.progressRetryable,false);
  f.flow.call=call;await f.flow.refresh();assert.equal(f.flow.state.loaded,true);assert.equal(f.flow.state.detail.id,'target');assert.equal(f.flow.state.input,'目标材料未发送的说明');assert.equal(f.flow.state.goal,'目标材料的草稿');
});

test('background progress preserves a foreground rejection until the user acts again',async()=>{
  const f=fixture();await f.flow.load();await f.flow.run(()=>{throw Object.assign(Error(),{code:'MODELING_CONFIRMATION_REQUIRED'});});
  const message=f.flow.state.error;assert.ok(message);await f.flow.run(()=>f.flow.snapshot(),{background:true});
  assert.equal(f.flow.state.error,message);assert.equal(f.flow.state.errorCode,'MODELING_CONFIRMATION_REQUIRED');
  await f.flow.refresh();assert.equal(f.flow.state.error,'');
});

test('extraction progress reports remaining batches and percentage only for consistent server counts',()=>{
  assert.deepEqual(extractionProgress({completed_units:2,total_units:10}),{completed:2,total:10,known:true,remaining:8,percent:20});
  assert.equal(extractionProgress({completed_units:999,total_units:1000}).percent,99);
  for(const counts of [{completed_units:2,total_units:null},{completed_units:2,total_units:1},{completed_units:0,total_units:0},{completed_units:NaN,total_units:10},{completed_units:2,total_units:Infinity},{total_units:10}]){
    const value=extractionProgress(counts);assert.equal(value.known,false);assert.equal(value.percent,null);assert.equal(value.remaining,null);
  }
});

test('running extraction distinguishes unknown totals from completed batches awaiting a result receipt',()=>{
  const f=fixture();f.flow.state.detail={status:'running',execution:{status:'running',progress:{completed_units:2,total_units:null}}};
  let html=knowledgeStage(f.flow);assert.match(html,/已完成 2 个批次/);assert.match(html,/总数待确定/);assert.doesNotMatch(html,/<progress[^>]*\bvalue=|[0-9]+%/);
  f.flow.state.detail.execution.progress.total_units=5;html=knowledgeStage(f.flow);assert.match(html,/已完成 2 \/ 5 个批次/);assert.match(html,/40%/);assert.match(html,/剩余 3 个批次/);
  f.flow.state.detail.execution.progress.completed_units=5;html=knowledgeStage(f.flow);assert.match(html,/100%/);assert.match(html,/任务尚未完成/);assert.doesNotMatch(html,/data-cv="(?:candidates|change-publish)"/);
});
