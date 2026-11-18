import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {materialIndexState,materialImportHTML} from '../ui/material-import.mjs';
import {materialAutomaticCard,materialAgentTools,materialRecoveryHTML} from '../ui/material-agent.mjs';
const index=(version='v')=>({embedding_configured:true,compatible:true,fresh:true,document_coverage:[{document_id:'d',version_id:version,indexed:true}],items:[]});
function fixture(store=new Map()){
  let version='v',failIndex=null,failDocument=null,indexReady=true,textReply=null,workflowExtra={};const calls=[];
  const f=new ConversationFlow({warehouseId:'w',identity:{boxId:'b',user:{id:1}},storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},call:async(action,input)=>{
    calls.push({action,input});
    if(action==='conversation-list')return {items:[],has_more:false};
    if(action==='conversation-ontologies')return {items:[]};
    if(action==='document'){if(failDocument===input.id)throw Object.assign(Error('offline'),{status:503});return {document:{id:input.id,segment_count:1},version:{id:version},segments:[{id:'s',text:'完整正文 <实体>'}]};}
    if(action==='conversation-material-workflow')return {document_id:input.documentId,document:{id:input.documentId,status:'ready',original_name:'资料.txt'},document_version_id:version,tasks:[],conversations:[],actions:{start_dialogue:{allowed:true},prepare_automatic:{allowed:true}},label:'正文已解析',...workflowExtra};
    if(action==='workbench-request'){if(input.url.includes('/text?'))return textReply;if(failIndex)throw failIndex;return {...index(version),fresh:indexReady};}
    throw Error(action);
  }});
  f.state.loaded=true;f.state.materialPage='import';f.state.warehouseMaterials=[{id:'d'},{id:'second'}];
  return {f,calls,store,changeVersion:v=>version=v,failIndex:e=>failIndex=e,failDocument:id=>failDocument=id,indexReady:value=>indexReady=value,textReply:value=>textReply=value,workflow:value=>workflowExtra=value};
}

test('materials page has no dialogue adjustment action in ready, active, review, published or recovery states',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  for(const stage of [null,'queued','running','awaiting_review','published','failed','cancelled','stale']){
    f.state.materialOperation=stage?{documentId:'d',current:{is_current:stage!=='stale',stage},receipt:{document_id:'d',document_version_id:'v'},failureJob:{id:'job',kind:'knowledge_extract',status:'failed'}}:null;
    for(const html of [materialImportHTML(f,''),materialAutomaticCard(f),materialAgentTools(f),materialRecoveryHTML(f)])
      assert.doesNotMatch(html,/data-cv="(?:import|material)-dialogue"/,String(stage));
    const html=materialImportHTML(f,'');
    assert.doesNotMatch(html,/材料历史|mw-material-history|data-cv="(?:material-history|history-[^"]+)"/);assert.doesNotMatch(html,/data-cv="round-history"/);
    assert.match(html,/data-warehouse-view="tasks"/);
    assert.match(html,/data-cv="material-delete"/);
  }
  f.state.materialOperation={documentId:'d',current:{is_current:false,stage:'published'}};
  assert.doesNotMatch(materialImportHTML(f,''),/data-cv="(?:import|material)-dialogue"/);
});

for(const history of ['none','read-only','empty'])for(const published of [false,true])test(`automatic review ignores ${history} conversations with published baseline ${published}, including refresh and restart`,async()=>{
  const workflow={processing_mode:'automatic',stage:'awaiting_review',draft:null,tasks:[],
    publication:published?{id:'old-run',status:'published',document_version_id:'v'}:null,
    conversations:history==='none'?[]:[{conversation_id:'old',intent_id:'old-intent',conversation_status:'active',status:'awaiting_goal',round_read_only:history==='read-only',document_version_id:'v'}]};
  const h=fixture();h.workflow(workflow);await h.f.importer.first();
  const publication=structuredClone(workflow.publication);
  for(const step of ['initial','refresh','restart']){
    const current=step==='restart'?fixture(h.store):h,f=current.f;current.workflow(workflow);
    if(step==='refresh')await f.importer.refresh();
    if(step==='restart')await f.importer.first();
    assert.equal(f.importer.view.workflow.processing_mode,'automatic');
    // Simulate stale UI state left by the former incorrect dialogue entry.
    f.state.dialogueExitNotice={documentId:'d',message:'已退出对话模式'};
    f.rounds.choice={documentId:'d',previous:workflow.conversations[0]};
    let opened=0;await f.importer.review((id,target)=>{assert.equal(id,'d');assert.equal(target,'current-extraction');opened++;});
    assert.equal(opened,1);assert.equal(f.state.error,'');assert.equal(f.state.materialPage,'import');
    assert.equal(f.rounds.choice,null);assert.equal(f.state.dialogueExitNotice,null);
    const html=materialImportHTML(f,'');
    assert.match(html,published?/已发布 · 新抽取结果待核对/:/自动抽取结果待核对/);assert.doesNotMatch(html,/data-cv="(?:import|material)-dialogue"/);
    assert.doesNotMatch(html,/继续上轮，还是开始新一轮|已退出对话模式|有待核对修改/);
    assert.deepEqual(workflow.publication,publication);
    assert.ok(current.calls.every(c=>['document','conversation-material-workflow','workbench-request'].includes(c.action)));
    assert.ok(current.calls.filter(c=>c.action==='workbench-request').every(c=>c.input.method==='GET'));
  }
});

test('automatic reference-bound draft keeps its candidate entry after the workflow leaves awaiting_review',async()=>{
  const h=fixture();h.workflow({processing_mode:'automatic',stage:'draft',draft:{id:'current',status:'editing'},
    automatic_processing:{candidate_result_count:1,modified_draft_count:0},
    conversations:[{conversation_id:'old',intent_id:'old-intent',conversation_status:'active'}]});
  await h.f.importer.first();let opened=0;
  await h.f.importer.review((id,target)=>{assert.equal(id,'d');assert.equal(target,'current-extraction');opened++;});
  assert.equal(opened,1);assert.equal(h.f.rounds.choice,null);
});

test('published material refresh, polling, returning and restarting never prepare or confirm another extraction',async()=>{
  const storage=new Map();
  for(let restart=0;restart<2;restart++){
    const h=fixture(storage),f=h.f;
    h.workflow({processing_mode:'automatic',stage:'published',publication:{id:'published',status:'published',document_version_id:'v'},
      automatic_processing:{candidate_result_count:0,modified_draft_count:0}});
    await f.importer.first();await f.importer.refresh();f.importer.lastRead=0;await f.importer.tick();await f.tick();
    await f.importer.select('second');await f.importer.select('d');
    assert.match(materialImportHTML(f,''),/已发布/);
    assert.ok(h.calls.every(c=>['document','conversation-material-workflow','workbench-request'].includes(c.action)));
    assert.equal(h.calls.some(c=>/processing-(preview|confirm)/.test(c.action)),false);
  }
});

test('a partial publication shows committed counts and opens material correction',async()=>{
  const h=fixture(),f=h.f;
  const publication={id:'published',status:'published',document_version_id:'v',entity_count:2,relation_count:1,
    extraction_quality:{coverage_unconfirmed:true,excluded_candidate_count:3}};
  h.workflow({processing_mode:'automatic',stage:'published',publication,extraction_review:null});
  await f.importer.first();
  const html=materialImportHTML(f,'');
  assert.match(html,/可查询 2 个实体、1 条关系/);
  assert.match(html,/3 个候选未通过核验。抽取可能有遗漏/);
  assert.match(html,/data-cv="import-review"[^>]*>核对已发布知识/);
  const opened=[];
  await f.importer.review((...args)=>opened.push(args));
  assert.deepEqual(opened,[['d',undefined]]);
  assert.ok(h.calls.every(c=>['document','conversation-material-workflow','workbench-request'].includes(c.action)));
  h.workflow({processing_mode:'automatic',stage:'published',publication:{...publication,document_version_id:'old'}});
  await f.importer.read('d');
  assert.doesNotMatch(materialImportHTML(f,''),/核对已发布知识|抽取可能有遗漏/);
});

test('opening and reloading material management without chats never creates a conversation',async()=>{
  const store=new Map();
  for(let attempt=0;attempt<2;attempt++){
    const h=fixture(store),f=h.f;f.state.loaded=false;
    h.workflow({processing_mode:'automatic',stage:'awaiting_review',draft:null,tasks:[]});
    await f.load();assert.equal(f.state.error,'');assert.equal(f.state.loaded,true);
    await f.importer.first();let opened=0;await f.importer.review(()=>opened++);
    assert.equal(opened,1);assert.ok(!f.saved.conversationId);
    assert.ok(h.calls.every(c=>['conversation-list','conversation-ontologies','document','conversation-material-workflow','workbench-request'].includes(c.action)));
  }
});

test('review uses one refreshed workflow and cannot create a new round after results change',async()=>{
  const h=fixture(),f=h.f;
  h.workflow({processing_mode:'dialogue',stage:'awaiting_review',conversations:[{conversation_id:'c',intent_id:'i',conversation_status:'active',execution_status:'awaiting_review'}]});
  await f.importer.first();await f.importer.confirm();
  let reads=0;const read=f.read.bind(f);
  f.read=async(action,input)=>{
    if(action==='conversation-material-workflow'&&++reads>1)h.workflow({processing_mode:'automatic',stage:'published',conversations:[]});
    return read(action,input);
  };
  await f.importer.review(()=>assert.fail('the displayed dialogue result should offer continuation'));
  assert.equal(f.state.error,'');assert.equal(reads,1);assert.equal(f.rounds.choice.previous.intent_id,'i');
  assert.equal(h.calls.some(c=>c.action==='conversation-create'),false);
});

test('automatic result cards offer candidate review without directing the user into dialogue',async()=>{
  const h=fixture(),f=h.f;h.workflow({processing_mode:'automatic',stage:'awaiting_review'});await f.importer.first();
  f.state.materialOperation={documentId:'d',receipt:{document_id:'d',document_version_id:'v'},current:{is_current:true,stage:'awaiting_review'}};
  const html=materialAutomaticCard(f);
  assert.match(html,/自动抽取结果待核对/);assert.match(html,/data-cv="material-review"/);
  assert.doesNotMatch(html,/通过对话调整继续核对|data-cv="material-dialogue"/);
  f.state.materialPage='dialogue';f.state.materialOperation.current.stage='failed';
  const recovery=materialAutomaticCard(f);
  assert.match(recovery,/data-cv="material-review"/);assert.doesNotMatch(recovery,/data-cv="material-dialogue"/);
});

for(const blocked of [false,'pending','unavailable'])test(`automatic card review returns to its material and respects ${blocked||'normal'} state`,async()=>{
  const h=fixture(),f=h.f;h.workflow({processing_mode:'automatic',stage:'awaiting_review'});await f.importer.first();
  f.state.materialPage='dialogue';f.state.librarySelection=null;f.state.importDocumentId=null;
  f.state.detail={id:'i',document_id:'d',document_version_id:'v'};
  if(blocked==='pending')f.saved.pending={action:'conversation-send',input:{operationId:'original'}};
  if(blocked==='unavailable')h.failDocument('d');
  let opened=0;await f.importer.reviewAutomatic(id=>{assert.equal(id,'d');opened++;});
  assert.equal(opened,blocked?0:1);
  if(blocked==='pending')assert.equal(f.saved.pending.input.operationId,'original');
  if(!blocked){assert.equal(f.state.materialPage,'import');assert.equal(f.rounds.choice,null);}
  assert.equal(h.calls.some(c=>/create|confirm|publish|analyze|send/.test(c.action)),false);
});

test('read-only dialogue history never owns the review entry, even with a locally open round',async()=>{
  const h=fixture(),f=h.f;h.workflow({processing_mode:'dialogue',stage:'draft',draft:{status:'editing'},conversations:[{conversation_id:'old',intent_id:'i',conversation_status:'active',round_read_only:true}]});
  f.saved.dialogueRounds={old:{status:'open',intentId:'i'}};await f.importer.first();
  let opened=0;await f.importer.review(()=>opened++);assert.equal(opened,1);assert.equal(f.rounds.choice,null);
});

test('returning to a material clears an obsolete exit notice instead of redisplaying it',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();f.state.dialogueExitNotice={documentId:'d',message:'已退出对话模式'};
  await f.importer.select('second');await f.importer.select('d');assert.equal(f.state.dialogueExitNotice,null);
  await f.importer.exitDialogue();assert.equal(f.state.dialogueExitNotice,null);
});
test('exiting dialogue preserves draft, pending suggestions and composer without writes or cancellation',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();
  f.saved.conversationId='conversation';f.state.selectedIntent='intent';f.state.detail={id:'intent',document_id:'d',document_version_id:'v'};
  f.state.materialPage='dialogue';f.state.librarySelection=null;f.changes.bind();
  f.changes.record.draftId='draft';f.changes.record.lastProposal='proposal';f.changes.persist();
  f.changes.owner={documentId:'d',draftId:'draft',editor:{session:'s'.repeat(30),generation:'1'}};
  f.changes.state.summary={id:'draft',revision:1,status:'editing'};f.changes.state.preview={revision:1};f.changes.state.publishConfirmed=true;f.changes.state.exclusion={ids:['fact']};
  f.state.input='尚未发送的要求';f.state.goal='待确认目标';f.state.goalDirty=true;
  const before=h.calls.length;await f.importer.exitDialogue();assert.equal(f.state.error,'');
  assert.equal(f.state.materialPage,'import');assert.equal(f.changes.record.draftId,'draft');assert.equal(f.changes.record.lastProposal,'proposal');
  assert.equal(f.saved.materialComposers['conversation:intent'].input,'尚未发送的要求');
  assert.equal(f.saved.materialComposers['conversation:intent'].goal,'待确认目标');
  assert.equal(f.changes.owner,null);assert.equal(f.changes.state.summary,null);assert.equal(f.changes.state.preview,null);
  assert.equal(f.changes.state.exclusion,undefined);assert.equal(f.changes.state.publishConfirmed,undefined);
  assert.match(materialImportHTML(f,''),/已退出对话模式/);assert.match(materialImportHTML(f,''),/不会停止已提交的服务端任务/);
  assert.equal(h.calls.slice(before).some(c=>/publish|cancel|discard|create|generate|claim/.test(c.action)),false);
  await f.importer.select('second');assert.doesNotMatch(materialImportHTML(f,''),/已退出对话模式/);
});

test('restoring material selection prefers the last viewed document and safely falls back if it disappeared',async()=>{
  const h=fixture(),f=h.f;f.saved.libraryDocumentId='second';await f.importer.first();assert.equal(f.importer.view.documentId,'second');
  f.saved.deletedDocuments={second:true};await f.importer.first();assert.equal(f.importer.view.documentId,'d');
});
test('an unresolved write prevents exiting dialogue instead of dropping its original request',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();f.state.materialPage='dialogue';
  const pending={action:'conversation-change-apply',input:{operationId:'original'}};f.changes.record.pending=pending;
  await f.importer.exitDialogue();assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');
  assert.equal(f.state.materialPage,'dialogue');assert.deepEqual(f.changes.record.pending,pending);assert.equal(f.state.dialogueExitNotice,null);
});
test('re-extraction replaces preparation-only steps with current task progress and never reuses an old publication',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  h.workflow({stage:'published',publication:{id:'old-run',status:'published',document_version_id:'v'}});await f.importer.read('d');
  const operation={documentId:'d',receipt:{document_id:'d',document_version_id:'v'},current:{is_current:true,stage:'running'},progress:{completed_units:4,total_units:10}};
  f.state.materialOperation=operation;
  const top=()=>materialImportHTML(f,'').match(/<section class="mw-import-process"[\s\S]*?<p class="mw-import-limit"/)[0];
  assert.match(top(),/本次自动抽取流程/);assert.match(top(),/aria-current="step"[^]*?<strong>抽取知识<\/strong>/);
  assert.match(top(),/value="4"/);assert.match(top(),/已完成 4 \/ 10 单元/);assert.match(top(),/发布知识[^]*?未开始/);
  assert.equal((materialImportHTML(f,'').match(/aria-label="自动处理进度"/g)||[]).length,1);
  assert.match(top(),/data-cv="import-auto" disabled/);
  operation.progress.completed_units=7;assert.match(top(),/已完成 7 \/ 10 单元/);
  operation.current.stage='publishing';assert.match(top(),/正在自动发布/);assert.doesNotMatch(top(),/mw-step-status">已发布/);
  operation.current.stage='awaiting_review';assert.match(top(),/核对并发布/);assert.match(top(),/待核对/);
  operation.current.stage='published';assert.doesNotMatch(top(),/mw-step-status">已发布/);
  operation.current.publication_performed=true;assert.match(top(),/mw-step-status">已发布/);
  for(const stage of ['queued','failed','cancelled']){operation.current.stage=stage;assert.doesNotMatch(top(),/mw-step-status">已发布/);}
  operation.current.is_current=false;assert.doesNotMatch(top(),/本次自动抽取流程/);
  operation.current.is_current=true;operation.receipt.document_version_id='old';assert.doesNotMatch(top(),/本次自动抽取流程/);
});

test('existing draft review remains accessible while source and index confirmation block extraction',async()=>{
  const h=fixture(),f=h.f;h.workflow({stage:'draft',draft:{status:'editing',revision:2,source_current:true}});h.indexReady(false);
  await f.importer.first();
  f.saved.materialOperations={d:{preview:{document_id:'d',can_confirm:false,snapshot:{document_version_id:'v'},publication_policy:'review_required',blockers:[{code:'MATERIAL_REVIEW_REQUIRED',detail:'请先核对已有草稿或抽取结果'}]}}};
  const html=materialImportHTML(f,'');
  assert.match(html,/data-cv="import-review" >继续核对草稿/);
  assert.doesNotMatch(html,/data-cv="material-auto-confirm"|data-cv="import-auto"/);
  assert.equal(f.importer.confirmed,false);assert.equal(f.importer.complete,false);
  await f.importer.dialogue();assert.equal(f.rounds.choice.draft,true);
  assert.match(materialImportHTML(f,''),/保留草稿，开始新一轮/);
  assert.equal(h.calls.some(c=>/confirm|generate|create|publish/.test(c.action)),false);
  h.workflow({stage:'processing',draft:{status:'editing'},tasks:[{status:'running'}]});await f.importer.read('d');
  assert.match(materialImportHTML(f,''),/data-cv="import-review" disabled/);
  await f.importer.dialogue();assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
});

test('pending extraction results expose their own review entry',async()=>{
  const h=fixture();h.workflow({stage:'awaiting_review'});await h.f.importer.first();
  assert.match(materialImportHTML(h.f,''),/data-cv="import-review" >继续核对抽取结果/);
  h.workflow({stage:'published',publication:{id:'run'}});await h.f.importer.read('d');
  assert.doesNotMatch(materialImportHTML(h.f,''),/data-cv="import-review"/);
});

test('manual progress refresh shows loading and completion even when state is unchanged, and never claims failure as success',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();
  const read=f.read.bind(f);let release;
  f.read=async(action,input)=>{if(action==='conversation-material-workflow')await new Promise(resolve=>release=resolve);return read(action,input);};
  const pending=f.importer.refresh();assert.equal(f.importer.refreshing,true);
  assert.match(materialImportHTML(f,''),/正在读取材料最新进度/);
  await new Promise(resolve=>setImmediate(resolve));
  release();await pending;assert.equal(f.importer.refreshing,false);
  assert.match(materialImportHTML(f,''),/已读取最新进度/);
  assert.equal(h.calls.some(c=>/confirm|claim|publish|retry/.test(c.action)),false);
  f.read=read;h.failDocument('d');await f.importer.refresh();
  assert.equal(f.importer.lastRefresh,null);assert.doesNotMatch(materialImportHTML(f,''),/已读取最新进度/);assert.ok(f.state.error);
});

test('review resumes an existing conversation or opens in-page review for unlinked automatic results',async()=>{
  const h=fixture(),f=h.f;h.workflow({stage:'awaiting_review'});h.indexReady(false);await f.importer.first();
  let opened=null;
  await f.importer.review(id=>{opened=id;});assert.equal(opened,'d');assert.equal(f.rounds.choice,null);
  h.workflow({stage:'draft',draft:{status:'editing'},conversations:[{conversation_status:'active',intent_id:'i'}]});
  await f.importer.review(()=>assert.fail('must resume conversation'));assert.equal(f.rounds.choice.previous.intent_id,'i');
  h.workflow({stage:'processing',draft:{status:'editing'},tasks:[{status:'running'}]});
  await f.importer.review(()=>assert.fail('busy material'));assert.equal(f.rounds.choice,null);assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
  h.workflow({stage:'published'});await f.importer.review(()=>assert.fail('review no longer pending'));assert.equal(f.rounds.choice,null);
});
test('index readiness is tied to this document and body version, never just workspace freshness',()=>{
  assert.equal(materialIndexState(index(),'d','v'),'ready');
  for(const value of [index('old'),{...index(),fresh:false},{...index(),compatible:false},{...index(),embedding_configured:false},{}])assert.notEqual(materialIndexState(value,'d','v'),'ready');
  assert.notEqual(materialIndexState(index(),'another','v'),'ready');
});
test('entry reads first material body without starting a dialogue or extraction; local confirmation is version bound',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();assert.equal(f.importer.view.documentId,'d');assert.equal(f.importer.complete,false);
  const before=materialImportHTML(f,'<p>本体图谱</p>');assert.match(before,/完整正文 &lt;实体&gt;/);assert.doesNotMatch(before,/mw-assistant|data-cv="import-auto"/);
  await f.importer.confirm();assert.equal(f.importer.complete,true);
  assert.match(materialImportHTML(f,''),/材料处理完成/);assert.doesNotMatch(materialImportHTML(f,''),/data-cv="(?:import|material)-dialogue"/);
  assert.equal(h.calls.some(c=>/create|confirm|analyze|send/.test(c.action)),false);
  h.changeVersion('new');await f.importer.select('d');assert.equal(f.importer.confirmed,false);assert.equal(f.importer.complete,false);
});
test('index service failure removes completion but preserves authorized body; authorization failure clears it',async()=>{
  const h=fixture();await h.f.importer.first();await h.f.importer.confirm();
  h.failIndex(Object.assign(Error('offline'),{status:503}));await h.f.importer.select('d');
  assert.equal(h.f.importer.complete,false);assert.match(materialImportHTML(h.f,''),/暂未确认/);
  h.failIndex(Object.assign(Error('forbidden'),{status:403}));await h.f.importer.select('d');
  assert.equal(h.f.importer.view,null);assert.equal(h.f.state.loaded,false);
});
test('changed source after confirmation cannot open either processing path',async()=>{
  const h=fixture();await h.f.importer.first();await h.f.importer.confirm();h.changeVersion('new');
  let count=0;h.f.agent.prepareAutomatic=async()=>count++;h.f.agent.ensureConversation=async()=>{count++;return true;};
  await h.f.importer.automatic();await h.f.importer.dialogue();assert.equal(count,0);
});

test('existing draft and unapplied suggestions go directly to the server replacement preview',async()=>{
  const h=fixture(),f=h.f;h.workflow({stage:'draft',draft:{status:'editing'},automatic_processing:{requires_acknowledgement:true}});
  await f.importer.first();await f.importer.confirm();
  f.state.detail={document_id:'d'};f.changes.state.proposals=[{id:'shown',status:'prepared'}];
  let prepared=0;f.agent.prepareAutomatic=async()=>prepared++;
  f.importer.dialogue=async()=>assert.fail('must not enter dialogue or discard a draft');
  assert.match(materialImportHTML(f,''),/data-cv="import-auto-switch" >自动抽取/);
  await f.importer.switchAutomatic();assert.equal(prepared,1);
  assert.equal(f.state.autoSwitch,false);assert.equal(f.changes.record.deferredProposal,undefined);
  h.workflow({stage:'draft',draft:{status:'editing'},actions:{prepare_automatic:{allowed:false,reason:'其他用户私有草稿'}}});
  await f.importer.read('d');assert.match(materialImportHTML(f,''),/data-cv="import-auto-switch" disabled/);
  assert.match(materialImportHTML(f,''),/其他用户私有草稿/);
});

test('automatic preview replaces the processing entry, cancel restores it, and existing results use re-extraction wording',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  const preview={document_id:'d',preview_id:'p',can_confirm:true,snapshot:{document_version_id:'v'},publication_policy:'automatic'};
  f.saved.materialOperations={d:{preview}};
  let html=materialImportHTML(f,'');
  assert.equal((html.match(/data-cv="material-auto-confirm"/g)||[]).length,1);
  assert.match(html,/确认开始并自动发布/);assert.doesNotMatch(html,/data-cv="import-auto"|data-cv="import-dialogue"|data-cv="material-dialogue"/);assert.match(html,/data-cv="material-auto-cancel"/);
  preview.snapshot.baseline_run_id='published-run';html=materialImportHTML(f,'');assert.match(html,/确认重新抽取并自动发布/);
  f.agent.cancelPreview();html=materialImportHTML(f,'');assert.match(html,/data-cv="import-auto"/);assert.doesNotMatch(html,/data-cv="(?:import|material)-dialogue"/);assert.doesNotMatch(html,/data-cv="material-auto-confirm"/);
  assert.equal(h.calls.some(c=>c.action==='conversation-processing-confirm'),false);
});

test('changed source disables an old automatic preview and cannot submit its confirmation',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  f.saved.materialOperations={d:{preview:{document_id:'d',can_confirm:true,snapshot:{document_version_id:'old'},publication_policy:'automatic'}}};
  assert.doesNotMatch(materialImportHTML(f,''),/data-cv="material-auto-confirm"/);
  assert.match(materialImportHTML(f,''),/重新预览抽取/);
  await f.agent.confirmAutomatic();assert.equal(f.state.errorCode,'MATERIAL_PROCESSING_PREVIEW_STALE');
  assert.equal(h.calls.some(c=>c.action==='conversation-processing-confirm'),false);
});

test('unfinished dialogue offers a round choice without discarding an unsubmitted automatic preview',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  f.saved.materialOperations={d:{preview:{preview_id:'old-preview'}}};
  h.workflow({conversations:[{conversation_id:'c',intent_id:'i',conversation_status:'active',status:'awaiting_goal'}]});
  await f.importer.dialogue();
  assert.equal(f.state.materialPage,'import');assert.equal(f.agent.record.preview.preview_id,'old-preview');
  assert.equal(f.rounds.choice.previous.conversation_id,'c');
  assert.equal(h.calls.some(c=>c.action==='conversation-create'),false);
});

test('an active automatic operation cannot be discarded by opening dialogue',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  f.saved.materialOperations={d:{transitionId:'running'}};
  f.state.materialOperation={documentId:'d',current:{is_current:true,stage:'running'}};
  let opened=0;f.agent.ensureConversation=async()=>{opened++;return true;};
  await f.importer.dialogue();assert.equal(opened,0);assert.equal(f.agent.record.transitionId,'running');assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
});

test('processing locks the automatic entry and preserves workflow guards, then terminal states restore it',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  let starts=0;f.agent.prepareAutomatic=async()=>starts++;f.agent.ensureConversation=async()=>{starts++;return false;};
  for(const stage of ['queued','running','generating','publishing']){
    f.state.materialOperation={documentId:'d',current:{is_current:true,stage}};
    const html=materialImportHTML(f,'');
    for(const command of ['import-auto'])assert.match(html,new RegExp(`data-cv="${command}" disabled`));
    assert.match(html,/材料正在处理中/);
    await f.importer.automatic();await f.importer.dialogue();assert.equal(starts,0);
    assert.equal(f.state.errorCode,'MODELING_MATERIAL_BUSY');
  }
  for(const stage of ['published','awaiting_review','failed','cancelled']){
    f.state.materialOperation={documentId:'d',current:{is_current:true,stage}};
    const html=materialImportHTML(f,'');
    for(const command of ['import-auto'])assert.match(html,new RegExp(`data-cv="${command}" >`));
  }
  f.state.materialOperation={documentId:'another',current:{is_current:true,stage:'running'}};
  assert.doesNotMatch(materialImportHTML(f,''),/data-cv="import-auto" disabled/);
  f.importer.view.workflow.tasks=[{status:'running'}];
  assert.match(materialImportHTML(f,''),/data-cv="import-auto" disabled/);
  assert.doesNotMatch(materialImportHTML(f,''),/data-cv="(?:import|material)-dialogue"/);
});

test('failed automatic work has one recovery row and preserves retry, repreview and review without a dialogue entry',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  f.state.materialOperation={documentId:'d',current:{is_current:true,stage:'failed'},receipt:{replacement:{}},failureJob:{id:'job',kind:'knowledge_extract',status:'failed'}};
  let html=materialImportHTML(f,'');
  assert.equal((html.match(/class="mw-failure-recovery"/g)||[]).length,1);
  assert.match(html,/data-cv="material-retry-job" >重试原任务/);assert.match(html,/data-cv="import-auto" >重新预览/);
  assert.doesNotMatch(html,/data-cv="(?:import|material)-dialogue"/);assert.match(html,/不会自动恢复编辑/);
  assert.doesNotMatch(html,/材料处理完成|>自动抽取<|重新核对抽取计划/);
  f.state.materialOperation.failureJob.retry_blocked_code='MATERIAL_REVIEW_REQUIRED';
  h.workflow({stage:'draft',draft:{status:'editing'}});await f.importer.read('d');
  html=materialImportHTML(f,'');assert.doesNotMatch(html,/data-cv="material-retry-job"/);
  assert.match(html,/候选已被人工调整/);assert.match(html,/data-cv="import-review" >继续核对/);
  h.indexReady(false);await f.importer.read('d');html=materialImportHTML(f,'');
  assert.match(html,/data-cv="import-auto" disabled/);assert.match(html,/data-cv="import-review" >继续核对/);
});

test('downstream failures and cancelled or superseded transitions never offer original extraction retry',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  f.state.materialOperation={documentId:'d',current:{is_current:true,stage:'failed'},failureJob:{id:'job',kind:'knowledge_extract',status:'succeeded'}};
  let html=materialImportHTML(f,'');assert.match(html,/抽取已完成，后续处理未完成/);assert.doesNotMatch(html,/data-cv="material-retry-job"/);
  f.state.materialOperation.current.stage='cancelled';f.state.materialOperation.failureJob.status='failed';
  html=materialImportHTML(f,'');assert.doesNotMatch(html,/data-cv="material-retry-job"/);assert.match(html,/处理已停止/);
  f.state.materialOperation.current.stage='stale';f.state.materialOperation.current.is_current=false;
  html=materialImportHTML(f,'');assert.doesNotMatch(html,/处理已被替代|data-cv="material-retry-job"/);assert.match(html,/data-cv="import-auto" >自动抽取/);
});

test('a superseded receipt cannot cover the current published material actions after reentry',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  h.workflow({stage:'published',publication:{id:'run',status:'published',document_version_id:'v'}});await f.importer.read('d');
  f.saved.materialOperations={d:{transitionId:'old'}};
  f.state.materialOperation={documentId:'d',receipt:{document_id:'d',document_version_id:'v'},current:{is_current:false,stage:'stale'}};
  let html=materialImportHTML(f,'');assert.doesNotMatch(html,/处理已被替代|mw-failure-recovery/);
  assert.match(html,/data-cv="import-auto" >重新抽取/);assert.doesNotMatch(html,/data-cv="(?:import|material)-dialogue"/);
  assert.equal(f.saved.materialOperations.d.transitionId,'old');
  f.importer.view.workflow.actions.prepare_automatic.allowed=false;
  html=materialImportHTML(f,'');assert.match(html,/data-cv="import-auto" disabled/);
  f.importer.view.workflow.tasks=[{status:'running'}];
  html=materialImportHTML(f,'');assert.doesNotMatch(html,/data-cv="(?:import|material)-dialogue"/);
});

test('a superseded receipt cannot hide preparation or pending draft review',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();h.indexReady(false);
  h.workflow({stage:'draft',draft:{status:'editing'}});await f.importer.read('d');
  f.state.materialOperation={documentId:'d',current:{is_current:false,stage:'stale'}};
  let html=materialImportHTML(f,'');assert.match(html,/data-cv="import-review" >继续核对草稿/);assert.doesNotMatch(html,/处理已被替代/);
  h.workflow({});await f.importer.read('d');html=materialImportHTML(f,'');
  assert.doesNotMatch(html,/data-cv="import-auto"|处理已被替代/);assert.match(html,/等待当前正文索引就绪/);
});

test('index-only background progress emits a render when ready, but unchanged polls do not',async()=>{
  const h=fixture(),f=h.f;h.indexReady(false);await f.importer.first();await f.importer.confirm();
  assert.equal(f.importer.complete,false);let renders=0;f.onChange=()=>renders++;
  h.indexReady(true);f.importer.lastRead=0;await f.importer.tick();
  assert.equal(f.importer.complete,true);assert.equal(renders,1);
  f.importer.lastRead=0;await f.importer.tick();assert.equal(renders,1);
});

test('a failed material switch retries that material, never the previous conversation document',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();f.state.detail={document_id:'d'};
  h.failDocument('second');await f.importer.select('second');
  assert.equal(f.importer.view,null);assert.equal(f.state.librarySelection,null);assert.equal(f.state.importDocumentId,'second');
  assert.doesNotMatch(materialImportHTML(f,'<p>本体图谱</p>'),/本体图谱|data-cv="material-delete"/);
  h.calls.length=0;f.importer.lastRead=0;await f.importer.tick();
  assert.deepEqual(h.calls.filter(c=>c.action==='document').map(c=>c.input.id),['second']);
  h.failDocument(null);f.importer.lastRead=0;await f.importer.tick();assert.equal(f.importer.view.documentId,'second');
});

test('upload result recovery selects its document even when previous conversation detail is stale',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();f.state.detail={document_id:'d'};
  f.apply({kind:'upload',input:{intentId:'new-intent'}},{document:{id:'second'}});
  f.importer.lastRead=0;await f.importer.tick();assert.equal(f.importer.view.documentId,'second');
});

test('pending correction claims block switching and starting either processing path',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();await f.importer.confirm();
  f.changes.claimRequest={operation_id:'claim'};
  let starts=0;f.agent.prepareAutomatic=async()=>starts++;f.agent.ensureConversation=async()=>{starts++;return true;};
  await f.importer.automatic();await f.importer.dialogue();await f.importer.select('second');
  assert.equal(starts,0);assert.equal(f.importer.view.documentId,'d');assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');
});

test('staged uploads block material navigation and remain available to submit',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();f.intake.staged={kind:'file',handle:'selected-file',name:'new.txt'};
  await f.importer.select('second');assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');assert.equal(f.importer.view.documentId,'d');assert.equal(f.intake.staged.handle,'selected-file');
});

test('refresh can reload after authorization state was cleared without a toolbar button',async()=>{
  const h=fixture(),f=h.f;f.state.loaded=false;
  let refreshed=0;f.refresh=async()=>{refreshed++;f.state.loaded=true;};
  assert.doesNotMatch(materialImportHTML(f,''),/data-cv="import-refresh"/);
  await f.importer.refresh();assert.equal(refreshed,1);assert.equal(f.importer.view.documentId,'d');
});

test('long material enters the goal-specific initial reading after remaining source pages load',async()=>{
  const h=fixture(),f=h.f;f.state.selectedIntent='i';f.state.detail={id:'i',document_id:'d',document_version_id:'v',source_status:'available',status:'awaiting_goal'};
  f.saved.intakeReviews={i:{stage:'goal',versionId:'v'}};f.saved.autoRead.i=true;
  f.intake.source={document:{id:'d',segment_count:2},version:{id:'v'},segments:[{id:'one',text:'第一页'}]};
  f.intake.loadMore=async()=>f.intake.source.segments.push({id:'two',text:'第二页'});
  let reads=0;f.intake.startGoal=async()=>{reads++;};
  await f.tick();assert.equal(reads,1);assert.equal(f.intake.complete,true);
});

test('canonical text rejects stalled or mismatched ranges and accepts Unicode code point offsets',async()=>{
  const h=fixture(),f=h.f;await f.importer.first();
  const base={document_id:'d',version_id:'v',start:0,end:2,total_chars:2,text:'字😀'};
  for(const value of [{...base,end:0},{...base,end:3},{...base,text:'字'}]){
    h.textReply(value);await f.importer.text();assert.equal(f.state.errorCode,'SEMANTICA_INVALID_RESPONSE');assert.equal(f.importer.view.textWindow,undefined);
  }
  h.textReply(base);await f.importer.text();assert.deepEqual(f.importer.view.textWindow,base);
});
