import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {unfinishedRound,materialRoundsHTML} from '../ui/material-rounds.mjs';
import {materialImportHTML} from '../ui/material-import.mjs';

function fixture(){
  const store=new Map(),calls=[],receipts=new Map();
  const old={id:'old',status:'active',scenario:'material',revision:1,source_stamp:'old',input_generation:1};
  const sessions=[old],intents=[{id:'old-intent',conversation_id:'old',document_id:'doc',document_version_id:'v',source_status:'available',status:'awaiting_goal',revision:1,goal:{goal:'旧目标'}}];
  const messages={old:[{id:'message',role:'user',content:'旧意图：排除全部公司 <script>',sequence:1}]};
  const db={version:'v',draft:null,published:true,lose:null,tasks:[],capability:true};
  const workflow=()=>({document_id:'doc',document:{id:'doc',status:'ready',original_name:'材料'},document_version_id:db.version,label:'已发布',stage:db.draft?'draft':db.published?'published':'source_ready',draft:db.draft,publication:db.published?{id:'run',status:'published',document_version_id:db.version}:null,tasks:db.tasks,conversations:intents.toReversed().map(i=>({conversation_id:i.conversation_id,intent_id:i.id,status:i.status,document_version_id:i.document_version_id,conversation_status:'active'})),actions:{start_dialogue:{allowed:false},prepare_dialogue:{allowed:db.capability}},preparation:{source_review:{status:'confirmed',confirmed_version_id:db.version},indexing:{status:'ready',document_version_id:db.version},ready:true}});
  const call=async(action,input)=>{
    calls.push({action,input:structuredClone(input)});
    if(action==='conversation-list')return {items:structuredClone(sessions),has_more:false};
    if(action==='conversation-get')return structuredClone(sessions.find(c=>c.id===input.conversationId));
    if(action==='conversation-intents')return {items:structuredClone(intents.filter(i=>i.conversation_id===input.conversationId)),has_more:false};
    if(action==='conversation-intent'){
      if(db.failNextIntent){db.failNextIntent=false;throw Object.assign(Error('offline'),{code:'SEMANTICA_CONNECTION_FAILED'});}
      return structuredClone(intents.find(i=>i.id===input.intentId&&i.conversation_id===input.conversationId));
    }
    if(action==='conversation-messages')return {items:structuredClone(messages[input.conversationId]||[]),has_more:false};
    if(action==='conversation-ontologies')return {items:[{id:'rules',status:'published',schema:{entity_types:[],relation_types:[]}}]};
    if(action==='conversation-material-workflow')return workflow();
    if(action==='conversation-material-workflows')return {items:[workflow()],total:1};
    if(action==='document')return {document:{id:'doc',segment_count:1},version:{id:db.version},segments:[{id:'s',text:'当前正文'}]};
    if(action==='conversation-published-run')return {run:{id:'run',status:'published',document_id:'doc',document_version_id:db.version},candidates:[]};
    if(action==='conversation-change-context')return {context_digest:'a'.repeat(64),recent_proposals:[]};
    if(action==='conversation-editor-session')return {editor_session:'s'.repeat(30)};
    if(action==='conversation-editor-leases')return {items:db.draft?[{draft_id:'draft',status:'editing',revision:2}]:[]};
    const key=input.operationId;
    if(receipts.has(key))return structuredClone(receipts.get(key));
    let result;
    if(action==='conversation-create'){
      const c={...old,id:'round-'+sessions.length,source_stamp:'fresh',input_generation:0};sessions.push(c);messages[c.id]=[];result={resource_id:c.id};if(db.changeOnCreate)db.version='changed';
    }else if(action==='conversation-intent-create'){
      const c=sessions.find(c=>c.id===input.conversationId);assert.equal(input.revision,c.revision);
      const i={id:'intent-'+intents.length,conversation_id:c.id,document_id:input.documentId,document_version_id:db.version,source_status:'available',status:'awaiting_goal',revision:1};intents.push(i);c.revision++;result={resource_id:i.id,revision:1};
      if(db.denyAfterLink)db.capability=false;
      if(db.failAfterLink)db.failNextIntent=true;
    }else throw Error('Unexpected '+action);
    receipts.set(key,structuredClone(result));
    if(db.lose===action){db.lose=null;throw Object.assign(Error('offline'),{code:'SEMANTICA_CONNECTION_FAILED'});}
    return result;
  };
  const make=()=>new ConversationFlow({warehouseId:'w',identity:{boxId:'b',user:{id:1}},storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},call});
  const f=make();
  const run=f.run.bind(f);f.run=(fn,options)=>run(async()=>{try{return await fn();}catch(e){db.lastError=e.stack;throw e;}},options);
  const init=async()=>{f.state.materialPage='import';await f.load();await f.materials();await f.importer.first();assert.equal(f.state.error,'');};
  return {f,db,calls,sessions,intents,messages,workflow,make,init};
}

test('published material starts a genuinely new conversation without old messages, goal, proposal or confirmation',async()=>{
  const h=fixture(),{f}=h;await h.init();
  f.state.input='旧的未发送文本';f.state.goal='旧的本机目标';f.state.goalDirty=true;
  f.changes.record.lastProposal='old-proposal';f.changes.state.publishConfirmed=true;
  await f.importer.dialogue();assert.equal(f.state.error,'');
  assert.notEqual(f.saved.conversationId,'old');assert.equal(h.sessions.length,2);assert.equal(h.intents.length,2);
  assert.deepEqual(f.state.messages,[]);assert.equal(f.state.goal,'');assert.equal(f.state.input,'');
  assert.equal(f.changes.record.lastProposal,undefined);assert.ok(!f.changes.state.publishConfirmed);
  assert.equal(f.state.materialPage,'dialogue');assert.equal(f.saved.dialogueRounds[f.saved.conversationId].status,'open');
  assert.equal(h.calls.some(c=>/generate|claim|publish$|analyze|send|confirm$/.test(c.action)),false);
  assert.equal(f.saved.materialComposers['old:old-intent'].input,'旧的未发送文本');
});

test('unpublished round keeps next-step goal processing and clears only an unsubmitted automatic preview on entry',async()=>{
  const h=fixture(),{f}=h;h.db.published=false;await h.init();f.saved.materialOperations={doc:{preview:{preview_id:'old-preview'}}};
  await f.importer.dialogue();assert.equal(f.rounds.choice.previous.conversation_id,'old');
  await f.rounds.start();assert.equal(f.state.error,'',h.db.lastError);assert.equal(f.state.materialPage,'dialogue');
  assert.equal(f.agent.record.preview,undefined);assert.equal(f.intake.goalStage,true);
  f.state.goal='本轮研发信息';let goals=0,plans=0;f.goal=async()=>goals++;f.preview=async()=>plans++;
  f.state.input='下一步';await f.submitInput();assert.equal(goals,1);assert.equal(plans,1);
});

test('resuming an unfinished draft removes an unrelated automatic preview before showing draft actions',async()=>{
  const h=fixture(),{f}=h;h.db.draft={status:'editing',revision:2};await h.init();
  f.saved.materialOperations={doc:{preview:{document_id:'doc',preview_id:'pending',snapshot:{document_version_id:'v'}}}};
  await f.importer.dialogue();await f.rounds.resume();assert.equal(f.state.error,'');
  assert.equal(f.state.materialPage,'dialogue');assert.equal(f.agent.record.preview,undefined);
  assert.equal(f.changes.state.leases[0].draft_id,'draft');assert.equal(h.sessions.length,1);
});

for(const action of ['conversation-create','conversation-intent-create'])test('lost '+action+' response is recovered with one conversation and one intent after restart',async()=>{
  const h=fixture();await h.init();h.db.lose=action;await h.f.importer.dialogue();
  assert.equal(h.f.saved.pending.action,action);const original=structuredClone(h.f.saved.pending.input);
  const f=h.make();f.state.materialPage='import';await f.load();await f.retryPending();
  assert.equal(f.state.error,'');assert.equal(f.saved.pending,null);assert.equal(h.sessions.length,2);assert.equal(h.intents.length,2);
  assert.equal(f.state.materialPage,'dialogue');assert.deepEqual(f.state.messages,[]);
  assert.deepEqual(h.calls.filter(c=>c.action===action).at(-1).input,original);
});

test('exit offers continuation; continuing preserves the same round while a new round preserves material draft without claiming it',async()=>{
  const h=fixture(),{f}=h;await h.init();await f.importer.dialogue();const id=f.saved.conversationId;
  f.state.input='本轮尚未发送';await f.importer.exitDialogue();await f.importer.dialogue();
  assert.equal(f.rounds.choice.previous.conversation_id,id);assert.equal(h.sessions.length,2);
  await f.rounds.resume();assert.equal(f.state.error,'');assert.equal(f.saved.conversationId,id);assert.equal(f.state.input,'本轮尚未发送');
  await f.importer.exitDialogue();h.db.draft={status:'editing',revision:2,source_current:true};await f.importer.dialogue();
  assert.match(materialImportHTML(f,''),/保留草稿，开始新一轮/);
  await f.rounds.start();assert.equal(f.state.error,'');assert.notEqual(f.saved.conversationId,id);
  assert.equal(h.db.draft.revision,2);assert.equal(f.changes.state.leases[0].draft_id,'draft');
  assert.equal(h.calls.some(c=>/editor-claim|change-apply|change-discard|change-publish/.test(c.action)),false);
});

test('history is escaped read-only data and never replaces the active messages or intent',async()=>{
  const h=fixture(),{f}=h;await h.init();await f.importer.dialogue();
  const id=f.saved.conversationId,intent=f.state.selectedIntent;await f.rounds.openHistory();const count=h.calls.length;
  await f.rounds.viewHistory('old');assert.equal(f.state.error,'');
  assert.equal(f.saved.conversationId,id);assert.equal(f.state.selectedIntent,intent);assert.deepEqual(f.state.messages,[]);
  assert.match(materialRoundsHTML(f),/旧意图/);assert.match(materialRoundsHTML(f),/&lt;script&gt;/);
  assert.deepEqual(h.calls.slice(count).map(c=>c.action),['conversation-intents','conversation-messages']);
});

test('source changes, active jobs, explicit capability denial and pending mutations cannot open a fresh round',async()=>{
  for(const variant of ['version','tasks','capability','pending']){
    const h=fixture(),{f}=h;h.db.draft={status:'editing'};await h.init();await f.importer.dialogue();
    if(variant==='version')h.db.version='new';
    if(variant==='tasks')h.db.tasks=[{status:'running'}];
    if(variant==='capability')h.db.capability=false;
    if(variant==='pending')f.saved.pending={action:'conversation-send',input:{operationId:'original'}};
    await f.rounds.start();assert.equal(h.sessions.length,1);assert.equal(h.intents.length,1);
  }
});

test('published baseline is not completion of a new round; actual completion removes the continue choice',async()=>{
  const h=fixture(),{f}=h;await h.init();await f.importer.dialogue();
  assert.ok(unfinishedRound(f,h.workflow()));
  f.state.detail.outcome={current_run_id:'run',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'run'}};
  f.changes.state.summary={id:'draft',revision:2,status:'submitted'};f.changes.state.publication={status:'succeeded'};f.rounds.sync();
  assert.ok(unfinishedRound(f,h.workflow()));
  f.state.detail.outcome={current_run_id:'new-run',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'new-run'}};f.rounds.sync();
  assert.equal(unfinishedRound(f,h.workflow()),null);
  f.rounds.touch('conversation-change-generate');f.rounds.sync();
  assert.equal(f.saved.dialogueRounds[f.saved.conversationId].status,'open');
  f.rounds.retire('doc');assert.equal(unfinishedRound(f,h.workflow()),null);
  h.db.published=false;assert.equal(unfinishedRound(f,h.workflow()),null);
});

test('resuming independent rule work keeps its original scope and does not open a fact lease',async()=>{
  const h=fixture(),{f}=h;await h.init();await f.importer.dialogue();f.changes.setTarget('rules');
  await f.importer.exitDialogue();h.db.draft={status:'editing',revision:2};await f.importer.dialogue();
  const before=h.calls.length;await f.rounds.resume();assert.equal(f.state.error,'');
  assert.equal(f.changes.record.changeTarget,'rules');
  assert.equal(h.calls.slice(before).some(c=>/editor-session|editor-leases|editor-claim/.test(c.action)),false);
});

test('a source change between creation and association stops linking and can return safely to the material',async()=>{
  const h=fixture(),{f}=h;await h.init();h.db.changeOnCreate=true;
  await f.importer.dialogue();assert.equal(f.state.errorCode,'MODELING_SNAPSHOT_CHANGED');
  assert.equal(h.sessions.length,2);assert.equal(h.intents.length,1);assert.ok(f.saved.intakeSubmission.newRound);
  await f.rounds.abandonOpening();assert.equal(f.state.error,'');assert.equal(f.saved.intakeSubmission,undefined);
  assert.equal(f.state.materialPage,'import');assert.equal(f.importer.view.source.version.id,'changed');
  assert.equal(h.calls.some(c=>/discard|publish|claim/.test(c.action)),false);
});

test('an accepted association can finish even when creating further rounds is no longer allowed',async()=>{
  const h=fixture(),{f}=h;await h.init();h.db.denyAfterLink=true;
  await f.importer.dialogue();assert.equal(f.state.error,'');assert.equal(f.state.materialPage,'dialogue');
  assert.equal(f.saved.roundOpening,undefined);assert.equal(h.sessions.length,2);assert.equal(h.intents.length,2);
});

test('failure after linking preserves the opening and blocks another round or navigation until recovery',async()=>{
  const h=fixture(),{f}=h;await h.init();h.db.failAfterLink=true;await f.importer.dialogue();
  assert.equal(f.saved.pending,null);assert.ok(f.saved.roundOpening);assert.equal(f.importer.blocked,true);
  const opening=structuredClone(f.saved.roundOpening),count=h.calls.length;
  await f.importer.select('another');await f.selectMaterial('old','old-intent');
  await f.create();assert.equal(h.calls.length,count);assert.deepEqual(f.saved.roundOpening,opening);
  f.state.loaded=false;
  await f.rounds.finish();assert.equal(f.state.error,'');assert.equal(f.state.materialPage,'dialogue');assert.equal(f.saved.roundOpening,undefined);
  assert.equal(f.state.loaded,true);
  assert.equal(h.sessions.length,2);assert.equal(h.intents.length,2);
});

test('workflow order cannot hide a valid continuation behind an obsolete intent in the same conversation',async()=>{
  const h=fixture(),{f}=h;await h.init();h.db.published=false;
  const w=h.workflow(),valid=w.conversations[0];
  w.conversations=[{...valid,intent_id:'obsolete',document_version_id:'old',status:'stale'},valid];
  assert.equal(unfinishedRound(f,w).intent_id,valid.intent_id);
  w.conversations=[{...valid,intent_id:'cancelled',status:'cancelled'},valid];
  assert.equal(unfinishedRound(f,w).intent_id,valid.intent_id);
  f.saved.dialogueRounds={old:{status:'open',intentId:valid.intent_id}};
  w.conversations=[{...valid,intent_id:'other-valid'},valid];
  assert.equal(unfinishedRound(f,w).intent_id,valid.intent_id);
});

test('resume revalidates source and selected intent after navigation instead of silently editing a different material',async()=>{
  for(const changed of ['version','intent']){
    const h=fixture(),{f}=h;h.db.draft={status:'editing'};await h.init();await f.importer.dialogue();
    const original=f.selectMaterial.bind(f),count=h.calls.length;
    f.selectMaterial=async(...args)=>{
      await original(...args);
      if(changed==='version')h.db.version='changed';
      else h.intents.splice(0,1,{...h.intents[0],id:'different',document_id:'another-document'});
    };
    await f.rounds.resume();assert.equal(f.state.errorCode,'MODELING_SNAPSHOT_CHANGED');
    assert.equal(f.state.materialPage,'import');assert.doesNotMatch(f.state.inputNotice,/已继续上轮/);
    assert.equal(h.calls.slice(count).some(c=>/change-context|editor-claim|change-generate/.test(c.action)),false);
  }
});

test('draft and run receipts for the same previous publication do not complete a newly reopened round',async()=>{
  const h=fixture(),{f}=h;await h.init();await f.importer.dialogue();
  f.state.detail.outcome={current_run_id:'run',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'run'}};
  f.changes.state.summary={id:'draft',revision:2,status:'submitted'};f.changes.state.publication={status:'succeeded'};
  f.rounds.sync();assert.equal(f.saved.dialogueRounds[f.saved.conversationId].status,'open');
  f.rounds.touch('conversation-change-generate');f.changes.resetView();f.rounds.sync();
  assert.equal(f.saved.dialogueRounds[f.saved.conversationId].status,'open');
  f.state.detail.outcome={current_run_id:'new-run',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'new-run'}};
  f.rounds.sync();assert.equal(f.saved.dialogueRounds[f.saved.conversationId].status,'completed');
});

test('returning from an incomplete opening preserves recovery markers when local persistence fails',async()=>{
  const h=fixture(),{f}=h;await h.init();h.db.failAfterLink=true;await f.importer.dialogue();
  const opening=structuredClone(f.saved.roundOpening),save=f.storage.setItem;
  f.storage.setItem=()=>{throw Error('disk full');};
  await f.rounds.abandonOpening();assert.deepEqual(f.saved.roundOpening,opening);
  assert.equal(f.state.errorCode,'MODELING_LOCAL_SAVE_FAILED');
  f.storage.setItem=save;await f.rounds.abandonOpening();assert.equal(f.state.error,'');
  assert.equal(f.saved.roundOpening,undefined);assert.equal(f.state.materialPage,'import');
});

test('old saved rounds without receipt metadata still recognize their starting published baseline',async()=>{
  const h=fixture(),{f}=h;await h.init();await f.importer.dialogue();
  const round=f.saved.dialogueRounds[f.saved.conversationId];delete round.completedReceipts;
  f.state.detail.outcome={current_run_id:'run',publication:{status:'succeeded',run_status:'published',effective:true,run_id:'run'}};
  f.rounds.sync();assert.equal(round.status,'open');
});

test('read-only server history overrides local open rounds and pending material drafts',async()=>{
  const h=fixture(),{f}=h;await h.init();
  const w=h.workflow();w.stage='awaiting_review';w.draft={status:'editing'};
  w.conversations[0].round_read_only=true;w.conversations[0].execution_status='awaiting_review';
  f.saved.dialogueRounds={old:{status:'open',intentId:'old-intent'}};
  assert.equal(unfinishedRound(f,w),null);
});

test('material review alone cannot reopen completed chats or empty automatic links',async()=>{
  const h=fixture(),{f}=h;await h.init();
  for(const published of [false,true]){
    h.db.published=published;
    const w=h.workflow();w.stage='awaiting_review';w.conversations[0].status='completed';
    assert.equal(unfinishedRound(f,w),null);
    w.processing_mode='automatic';w.conversations[0].status='awaiting_goal';
    assert.equal(unfinishedRound(f,w),null);
    w.conversations[0].execution_status='awaiting_review';
    assert.equal(unfinishedRound(f,w).intent_id,'old-intent');
  }
});

test('a remembered empty intent cannot hide a real pending execution in the same conversation',async()=>{
  const h=fixture(),{f}=h;await h.init();const w=h.workflow(),empty=w.conversations[0];
  w.stage='awaiting_review';w.processing_mode='dialogue';
  const review={...empty,intent_id:'review-intent',status:'awaiting_review',execution_status:'awaiting_review'};
  w.conversations=[empty,review];f.saved.selection={old:empty.intent_id};
  assert.equal(unfinishedRound(f,w)?.intent_id,review.intent_id);
  f.saved.dialogueRounds={old:{status:'open',intentId:empty.intent_id}};
  assert.equal(unfinishedRound(f,w)?.intent_id,review.intent_id);
});

test('first explicit dialogue after an empty material-management startup creates exactly one round',async()=>{
  const h=fixture(),{f}=h;h.sessions.length=0;h.intents.length=0;await h.init();
  assert.equal(h.sessions.length,0);assert.equal(h.intents.length,0);
  await f.importer.dialogue();assert.equal(f.state.error,'',h.db.lastError);
  assert.equal(h.sessions.length,1);assert.equal(h.intents.length,1);assert.equal(f.state.materialPage,'dialogue');
});

test('resuming a round rechecks read-only status after loading the final dialogue workflow',async()=>{
  const h=fixture(),{f}=h;h.db.draft={status:'editing'};await h.init();await f.importer.dialogue();
  const sync=f.agent.syncDialogue.bind(f.agent);
  f.agent.syncDialogue=async()=>{await sync();f.state.dialogueWorkflow.conversations=f.state.dialogueWorkflow.conversations.map(l=>({...l,round_read_only:true}));};
  const before=h.calls.length;await f.rounds.resume();
  assert.equal(f.state.errorCode,'MODELING_SNAPSHOT_CHANGED');assert.equal(f.state.materialPage,'import');
  assert.equal(h.calls.slice(before).some(c=>['conversation-change-context','conversation-editor-claim'].includes(c.action)),false);
});

test('an interrupted round opening cannot recover a conversation that became read-only',async()=>{
  const h=fixture(),{f}=h;await h.init();h.db.failAfterLink=true;await f.importer.dialogue();
  assert.ok(f.saved.roundOpening);const read=f.read.bind(f);
  f.read=async(action,input)=>{
    const value=await read(action,input);
    return action==='conversation-material-workflow'?{...value,conversations:value.conversations.map(l=>({...l,round_read_only:true}))}:value;
  };
  await f.rounds.finish();assert.equal(f.state.errorCode,'MODELING_SNAPSHOT_CHANGED');
  assert.equal(f.state.materialPage,'import');assert.ok(f.saved.roundOpening);
});

test('explicit dialogue entry with automatic candidates and only history starts a fresh round',async()=>{
  const h=fixture(),{f}=h;await h.init();
  const read=f.read.bind(f);f.read=async(action,input)=>{
    const value=await read(action,input);
    if(action==='conversation-material-workflow')return {...value,processing_mode:'automatic',stage:'awaiting_review',
      conversations:value.conversations.map(l=>({...l,round_read_only:l.conversation_id==='old'}))};
    return value;
  };
  await f.importer.dialogue();assert.equal(f.state.error,'');assert.equal(f.state.materialPage,'dialogue');
  assert.equal(h.sessions.length,2);assert.equal(h.intents.length,2);assert.equal(f.rounds.choice,null);
  assert.equal(h.calls.some(c=>/generate|publish$|analyze|send|confirm$/.test(c.action)),false);
  assert.equal(h.db.published,true);
});

test('continuation after exit discards old editor credentials and requires reading available drafts again',async()=>{
  const h=fixture(),{f}=h;h.db.draft={status:'editing',revision:2};await h.init();await f.importer.dialogue();await f.rounds.resume();
  f.changes.record.draftId='draft';f.changes.owner={documentId:'doc',draftId:'draft',editor:{session:'expired-session-'.repeat(2),generation:'1'}};
  f.changes.state.summary={id:'draft',revision:1,status:'editing'};f.changes.state.preview={revision:1};f.changes.state.publishConfirmed=true;
  await f.importer.exitDialogue();assert.equal(f.changes.owner,null);
  await f.importer.dialogue();const count=h.calls.length;await f.rounds.resume();assert.equal(f.state.error,'');
  assert.equal(f.state.materialPage,'dialogue');assert.equal(f.changes.state.preview,null);assert.ok(!f.changes.state.publishConfirmed);
  assert.equal(h.calls.slice(count).some(c=>c.input.editor?.session.startsWith('expired-session')),false);
  assert.equal(h.calls.slice(count).some(c=>c.action==='conversation-editor-claim'),false);
  assert.equal(f.changes.state.leases[0].draft_id,'draft');
});
