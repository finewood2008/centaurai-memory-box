// Source review followed by explicit goal preparation; never starts extraction.
import {retainedMaterialResults} from './conversation-progress.mjs';
import {goalDialogueContent} from './material-goal-dialogue.mjs';
import {materialResultContext} from './material-state.mjs';
const fail=code=>Object.assign(Error(code),{code});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class ConversationIntake{
  constructor(flow){this.f=flow;this.staged=null;this.source=null;this.range=null;this.page=0;this.pageSize=5;}
  get record(){return this.f.saved.intakeReviews?.[this.f.state.selectedIntent];}
  get unavailable(){const d=this.f.state.detail;return !!this.record&&!!d&&(['cancelled','stale'].includes(d.status)&&!retainedMaterialResults(d)||d.status==='failed'&&!d.execution||!!d.document_version_id&&d.source_status!=='available');}
  get sourceReviewed(){
    const d=this.f.state.detail;
    // A server-linked draft resumes at review even when this device has no
    // intake marker. Explicit body editing still owns the source review screen.
    const resumeDraft=!this.f.state.reviewingSource&&!this.hasEdits&&d?.source_status==='available'&&!!d.document_version_id&&!!d.review?.draft_id&&!['stale','cancelled'].includes(d.status);
    return resumeDraft||!this.f.state.reviewingSource&&!this.hasEdits&&d?.source_status==='available'&&materialResultContext(this.f)||retainedMaterialResults(d)||!this.unavailable&&this.record?.stage==='goal'&&this.record.versionId===d?.document_version_id;
  }
  get goalStage(){const c=this.f.changes,newGoal=!!c.record.previousIntent&&c.record.changeTarget==='goal';return !!this.record&&(!materialResultContext(this.f)||newGoal)&&this.sourceReviewed&&!this.f.state.detail?.execution&&!this.f.state.detail?.review?.draft_id&&!c.record.draftId&&!c.state.summary&&!c.state.leases.length&&this.f.state.openMaterialEditor!==this.f.state.selectedIntent;}
  get hasEdits(){return !!this.source?.segments.some(s=>this.record?.edits?.[s.id]!==undefined&&this.record.edits[s.id]!==s.text);}
  get editLocked(){const f=this.f;return f.state.busy||!f.state.loaded||!!f.saved.pending||!!f.saved.materialDeletion||!!f.reviewPending||!!f.claimPending||!!f.releasePending||!!f.changes.record.pending||!!f.changes.claimRequest;}
  get needsMore(){if(!this.f.state.reviewingSource&&this.sourceReviewed&&this.record?.goalTurnId)return false;const s=this.source;return !!s&&Number.isSafeInteger(s.document.segment_count)&&(s.segments.length<s.document.segment_count||s.segments.some(v=>v.text_truncated));}
  stageFile(){return this.f.run(async()=>{
    await this.f.ready();if(this.f.saved.upload||this.f.saved.intakeSubmission)throw fail('MODELING_REQUEST_PENDING');
    const files=await this.f.read('select-files',{multiple:false,selectionMode:'conversation'});
    if(!files.length)return;
    if(files.length!==1){await this.f.read('release-files',{handles:files.map(f=>f.handle)});throw fail('MODELING_SINGLE_FILE_REQUIRED');}
    if(this.staged?.handle===files[0].handle)return;
    await this.release();this.staged={kind:'file',handle:files[0].handle,name:files[0].name};
  });}
  stageSelectedFile(file){return this.f.run(async()=>{
    await this.f.ready();if(this.f.saved.upload||this.f.saved.intakeSubmission)throw fail('MODELING_REQUEST_PENDING');
    if(typeof file?.handle!=='string'||!file.handle||typeof file?.name!=='string'||!file.name)throw fail('SEMANTICA_INVALID_RESPONSE');
    if(this.staged?.handle===file.handle)return;
    await this.release();this.staged={kind:'file',handle:file.handle,name:file.name};
  });}
  stageDocument(id){return this.f.run(async()=>{
    await this.f.ready();if(this.f.saved.upload||this.f.saved.intakeSubmission)throw fail('MODELING_REQUEST_PENDING');
    const d=this.f.state.documents.find(d=>d.id===id);if(!d)throw fail('MODELING_RESOURCE_NOT_FOUND');
    await this.release();this.staged={kind:'document',documentId:id,name:d.original_name||id};this.f.state.documents=[];
  });}
  async release(){if(this.staged?.handle)await this.f.read('release-files',{handles:[this.staged.handle]});this.staged=null;}
  remove(){return this.f.run(()=>this.release());}
  async submit({isolated=true,note:providedNote,newRound=null}={}){
    // Linking an existing material is navigation to its session, not another
    // chat sharing the same document. Server inventory covers unloaded pages.
    if(!newRound&&isolated&&this.staged?.kind==='document'&&!this.f.saved.intakeSubmission){
      let existing;
      await this.f.run(async()=>{const w=await this.f.read('conversation-material-workflow',{documentId:this.staged.documentId});existing=w.conversations?.find(c=>c.conversation_status==='active');});
      if(this.f.state.error)return;
      if(existing){await this.release();await this.f.selectMaterial(existing.conversation_id,existing.intent_id);
        if(!this.f.state.error&&providedNote?.trim()){this.f.state.input=providedNote.trim();this.f.state.inputNotice='已恢复这份材料的原对话，补充说明已放入输入框，请确认后发送。';this.f.saveMaterialComposer();this.f.emit();}return;}
    }
    await this.f.run(async()=>{
    await this.f.ready();if(this.f.saved.upload)throw fail('MODELING_REQUEST_PENDING');
    if(!this.f.saved.intakeSubmission){
      if(!this.staged)return;
      const note=(providedNote??this.f.state.input).trim();if(Array.from(note).length>8000)throw fail('MODELING_INVALID_REQUEST');
      this.f.saved.intakeSubmission={...this.staged,note,newRound,conversationId:this.f.saved.conversationId,needsConversation:!!newRound||isolated&&(this.f.state.intents.length>0||this.f.state.messages.length>0||this.f.state.overview?.status!=='active')};
      try{this.f.persist();}catch(e){this.f.saved.intakeSubmission=null;throw e;}
      this.staged=null;this.f.state.librarySelection=null;this.f.state.importDocumentId=null;this.f.importer.view=null;delete this.f.saved.libraryDocumentId;this.f.persist();if(providedNote===undefined)this.f.state.input='';
    }
    if(this.f.saved.intakeSubmission.newRound)await this.f.rounds.validate(this.f.saved.intakeSubmission.newRound);
    if(this.f.saved.intakeSubmission.needsConversation){
      this.f.rememberMaterialComposer();
      await this.f.write('conversation-create',{scenario:'material'},'intake-create');
      await this.f.list();await this.f.snapshot();
    }
    const item=this.f.saved.intakeSubmission;
    if(item.kind==='file'){
      this.f.saved.upload={...item,intake:true};this.f.saved.intakeSubmission=null;this.f.persist();this.f.emit();
      await this.f.continueUploads();
    }else{
      if(item.newRound)await this.f.rounds.validate(item.newRound);
      await this.f.write('conversation-intent-create',{conversationId:item.conversationId,revision:this.f.state.overview.revision,documentId:item.documentId},'intake-link');
    }
    await this.f.snapshot();await this.f.list();await this.f.readMaterialIndex();
  });
    if(!this.f.state.error&&!this.f.saved.pending)await this.f.rounds.finish();
  }
  register(id,item){
    this.f.state.librarySelection=null;
    this.f.saved.intakeReviews={...this.f.saved.intakeReviews,[id]:{name:item.name,note:item.note||'',conversationId:item.conversationId}};
    this.f.saved.autoRead[id]=this.f.state.materialPage!=='import';this.f.state.selectedIntent=id;
    this.f.rounds.register(id,item);
  }
  async sync(){
    const r=this.record,d=this.f.state.detail;
    if(this.f.state.reviewingSource&&this.source?.document.id===d?.document_id){
      if(d.source_status!=='available'||this.source.version.id!==d.document_version_id){
        const fresh=await this.f.read('document',{id:d.document_id});
        if(!fresh.version?.id)throw fail('MODELING_SOURCE_NOT_READY');
        if(fresh.version.id!==this.source.version.id){r.previousDraft={versionId:r.versionId,edits:r.edits};r.edits={};r.versionId=fresh.version.id;r.confirmed=false;this.source=fresh;this.range=null;this.page=0;this.f.persist();}
      }
      return;
    }
    if(!r||!d?.document_version_id||d.source_status!=='available'||['parsing','cancelled','stale','failed'].includes(d.status)){this.source=null;return;}
    if(this.sourceReviewed&&r.goalTurnId){this.restoreGoal();return;}
    if(r.versionId===d.document_version_id&&this.source?.version?.id===d.document_version_id&&this.source.document.id===d.document_id){this.restoreGoal();return;}
    const value=await this.f.read('document',{id:d.document_id});
    if(value.version?.id!==d.document_version_id||!Array.isArray(value.segments))throw fail('MODELING_SNAPSHOT_CHANGED');
    this.source=value;this.range=null;this.page=0;
    if(r.versionId!==value.version.id){
      if(r.versionId)r.previousDraft={versionId:r.versionId,edits:r.edits,confirmed:r.confirmed};
      r.versionId=value.version.id;r.edits={};r.confirmed=false;r.stage='source';delete r.goalDraft;delete r.goalTurnId;this.f.persist();
    }
    this.restoreGoal();
  }
  more(){return this.f.run(()=>this.loadMore());}
  async loadMore(){
    const old=this.source;if(!old)return;
    if(old.segments.length>=old.document.segment_count)return this.fillTruncated();
    const value=await this.f.read('document',{id:old.document.id,offset:old.segments.length});
    if(value.version?.id!==old.version.id){this.source=null;this.range=null;throw fail('MODELING_SNAPSHOT_CHANGED');}
    if(!value.segments?.length)throw fail('SEMANTICA_INVALID_RESPONSE');
    const ids=new Set(old.segments.map(s=>s.id));
    if(value.segments.some(s=>ids.has(s.id)))throw fail('SEMANTICA_INVALID_RESPONSE');
    this.source={...old,segments:[...old.segments,...value.segments]};
  }
  async fillTruncated(){
    const s=this.source;if(!s?.segments.some(v=>v.text_truncated))return;
    const r=this.range??={cursor:0,parts:{}};
    const value=await this.f.read('workbench-request',{method:'GET',url:'/api/documents/'+encodeURIComponent(s.document.id)+'/text?'+new URLSearchParams({version_id:s.version.id,start:String(r.cursor),end:String(r.cursor+65536)})});
    if(value.version_id!==s.version.id||value.document_id!==s.document.id){this.source=null;this.range=null;throw fail('MODELING_SNAPSHOT_CHANGED');}
    const chars=Array.from(value.text||'');
    if(value.start!==r.cursor||!Number.isSafeInteger(value.end)||value.end<=r.cursor||value.end-value.start!==chars.length||!Array.isArray(value.locators))throw fail('SEMANTICA_INVALID_RESPONSE');
    for(const loc of value.locators){
      const segment=s.segments.find(v=>v.id===loc.segment_id&&v.text_truncated);if(!segment)continue;
      if(!Number.isSafeInteger(loc.start)||!Number.isSafeInteger(loc.end)||loc.start<0||loc.end<=loc.start)throw fail('SEMANTICA_INVALID_RESPONSE');
      const a=Math.max(value.start,loc.start),b=Math.min(value.end,loc.end);
      const part=r.parts[segment.id]??={cursor:loc.start,text:''};
      if(a!==part.cursor||b<=a)throw fail('SEMANTICA_INVALID_RESPONSE');
      part.text+=chars.slice(a-value.start,b-value.start).join('');part.cursor=b;
      if(b===loc.end){segment.text=part.text;segment.text_truncated=false;delete r.parts[segment.id];}
    }
    r.cursor=value.end;
    if(value.end>=value.total_chars&&s.segments.some(v=>v.text_truncated))throw fail('SEMANTICA_INVALID_RESPONSE');
  }
  get complete(){const s=this.source;return !!s?.version&&Number.isSafeInteger(s.document.segment_count)&&s.document.segment_count>0&&s.segments.length===s.document.segment_count&&!s.segments.some(v=>v.text_truncated);}
  changePage(delta){this.page=Math.max(0,Math.min(Math.ceil((this.source?.segments.length||0)/this.pageSize)-1,this.page+delta));this.f.emit();}
  changePageSize(value){if(![5,10].includes(value))return;const offset=this.page*this.pageSize;this.pageSize=value;this.page=Math.floor(offset/value);this.f.emit();}
  edit(id,text){
    if(!this.source?.segments.some(s=>s.id===id&&!s.text_truncated)||this.editLocked)return;
    const r=this.record;r.edits={...r.edits,[id]:text};r.confirmed=false;
    try{this.f.persist();}catch(e){this.f.state.error='修改暂未保存，请检查本机存储空间。';this.f.emit();}
  }
  async confirm(advance=false){await this.f.run(async()=>{
    const version=this.source?.version?.id;await this.f.ready();
    if(!this.complete||this.source?.version.id!==version)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(!this.source.segments.some(s=>(this.record.edits?.[s.id]??s.text).trim()))throw fail('MODELING_INVALID_REQUEST');
    if(this.hasEdits){
      await this.f.write('conversation-source-save',{documentId:this.source.document.id,documentVersionId:version,segments:this.source.segments.map(s=>({id:s.id,text:this.record.edits?.[s.id]??s.text}))});
      this.f.state.inputNotice='正文已保存到服务端。后续抽取将使用校对后的正文。';
      this.f.invalidateContext();
    }
    this.record.confirmed=true;this.f.persist();
    });
    if(advance&&!this.f.state.error&&!this.hasEdits){
      if(this.f.agent.record.sourceSaved){await this.f.agent.dialogue();if(this.f.state.error)return;}
      this.f.state.reviewingSource=false;await this.startGoal();
    }}
  startGoal(useOriginal=false){return this.f.run(async()=>{
    const version=this.source?.version?.id;await this.f.ready();
    if(!this.complete||version!==this.source?.version?.id)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(this.hasEdits)throw fail('MODELING_SOURCE_SAVE_REQUIRED');
    if(['queued','running','generating'].includes(this.f.state.turn?.status)){this.f.state.readWaiting=true;return;}
    const r=this.record;if(this.goalStage&&r.goalTurnId)return;
    const prompt=r.note?'请根据当前材料“'+r.name+'”协助明确整理目标，概括可整理的信息，必要时提出不超过两个问题；暂不抽取或发布。我的关注点和补充说明：\n'+r.note:null;
    // The user's accepted note has priority over optional framing. Never trim it
    // or split a single initial read into multiple model requests.
    const content=prompt&&Array.from(prompt).length>8000?r.note:prompt;
    if(content&&Array.from(content).length>8000)throw fail('MODELING_INVALID_REQUEST');
    r.stage='goal';r.confirmed=true;r.usingOriginal=this.hasEdits;r.goalNeedsConfirmation=true;this.f.persist();
    if(this.f.saved.analyzed[this.f.state.detail.id+':'+version]){r.goalTurnId=this.f.state.turn?.id;await this.f.snapshot();return;}
    if(content)await this.f.initialRead('conversation-send',{conversationId:this.f.saved.conversationId,revision:this.f.state.overview.revision,content},'intake-goal-turn');
    else await this.f.initialRead('conversation-analyze',{conversationId:this.f.saved.conversationId,intentId:this.f.state.detail.id,documentVersionId:version},'intake-goal-turn');
    await this.f.snapshot();
  });}
  discuss(){return this.f.run(async()=>{
    const input=this.f.state.input;if(!input.trim())return;
    const content=goalDialogueContent(input);
    if(Array.from(content).length>8000)throw fail('MODELING_INVALID_REQUEST');
    await this.f.ready();if(this.unavailable)throw fail('MODELING_MATERIAL_UNAVAILABLE');if(!this.goalStage)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(['queued','running','generating'].includes(this.f.state.turn?.status))throw fail('MODELING_TURN_BUSY');
    await this.f.write('conversation-send',{conversationId:this.f.saved.conversationId,revision:this.f.state.overview.revision,content},'intake-goal-turn');await this.f.snapshot();
  });}
  saveGoalDraft(){if(!this.goalStage)return;this.record.goalDraft={goal:this.f.state.goal,instructions:this.f.state.instructions};this.record.goalNeedsConfirmation=true;this.record.goalReplyPending=false;try{this.f.rememberMaterialComposer();}catch{this.f.state.error='目标草稿暂未保存，请检查本机存储空间。';this.f.emit();}}
  restoreGoal(){
    const r=this.record;if(!this.goalStage)return;
    if(!this.f.state.goalDirty&&r.goalDraft)Object.assign(this.f.state,r.goalDraft,{goalDirty:true});
    if(!this.f.state.instructions&&!this.f.state.detail?.goal?.goal&&!Object.hasOwn(r.goalDraft||{},'instructions'))this.f.state.instructions=r.note||'';
  }
  note(){return this.f.run(async()=>{
    if(this.unavailable)throw fail('MODELING_MATERIAL_UNAVAILABLE');
    if(!this.record||!this.f.state.input.trim())return;
    if(Array.from(this.f.state.input).length>8000)throw fail('MODELING_INVALID_REQUEST');
    this.record.note=this.f.state.input.trim();this.f.persist();this.f.state.input='';
  });}
  clear(){this.staged=null;this.source=null;this.range=null;this.page=0;}
}

export function intakeCard(flow){
  const i=flow.intake;if(!i)return '';const r=i.record,d=flow.state.detail,s=i.source;
  const submitting=flow.saved.intakeSubmission||(flow.saved.upload?.intake?flow.saved.upload:null);
  if(!r&&!submitting)return '';
  if((i.sourceReviewed||retainedMaterialResults(d))&&!submitting&&!flow.state.reviewingSource)return '';
  let body='';
  if(submitting||!s&&!i.unavailable)body='<progress aria-label="材料解析进度"></progress><p role="status">'+(submitting?'正在提交材料…':'正在解析正文…')+'</p><p>解析完成后将在这里展示正文供核对，尚未开始知识抽取。</p>';
  else if(!s)body=`<p role="alert">${d?.status==='cancelled'?'本次材料处理已停止。':d?.status==='failed'?'本次材料处理失败。':'材料未能完成解析或来源已变化。'}请重新读取状态，或选择其他材料。</p><button type="button" class="btn btn-secondary" data-cv="refresh">重新读取状态</button>`;
  else{
    const total=s.document.segment_count,complete=i.complete,start=i.page*i.pageSize;
    body=`<p class="cv-source-meta">解析完成 · 正文版本 ${esc(s.version.version_number??'—')} · 已加载 ${s.segments.length} / ${esc(total??'未知')} 个片段</p>
      <p class="cv-source-hint">点击正文可修改；保存后形成服务端正文版本，后续抽取使用保存后的正文。</p>
      ${r.previousDraft?'<p role="status">原文版本已变化，请重新核对。旧版本的修改记录仍保存在本机，未自动套用到新正文。</p>':''}
      <div class="cv-source-review" aria-label="分页正文">${s.segments.slice(start,start+i.pageSize).map((v,n)=>`<textarea id="cv-source-${esc(v.id)}" aria-label="正文段落 ${start+n+1}" class="${v.kind==='heading'?'cv-source-heading':''}" data-intake-segment="${esc(v.id)}" rows="1" ${!complete||i.editLocked||v.text_truncated?'disabled':''}>${esc(r.edits?.[v.id]??v.text)}</textarea>`).join('')||'<p>未获取到正文。</p>'}</div>
      <div class="cv-source-pagination"><label>每页 <select id="cv-source-page-size"><option value="5" ${i.pageSize===5?'selected':''}>5 条</option><option value="10" ${i.pageSize===10?'selected':''}>10 条</option></select></label><span>第 ${i.page+1} / ${Math.max(1,Math.ceil((total||s.segments.length)/i.pageSize))} 页</span><button type="button" class="btn btn-secondary" data-cv="intake-prev" ${i.page===0?'disabled':''}>上一页</button><button type="button" class="btn btn-secondary" data-cv="intake-next" ${start+i.pageSize>=s.segments.length?'disabled':''}>下一页</button></div>
      ${s.segments.length<total?'<p role="status">正在自动加载后续正文；这不是内容截断。</p>':s.segments.some(v=>v.text_truncated)?'<p role="status">接口返回了部分长段落，正在按版本补齐完整正文。</p>':''}
      ${!complete&&flow.state.error?'<button type="button" class="btn btn-secondary" data-cv="intake-more">重试读取正文</button>':''}
      <p data-intake-edits ${i.hasEdits?'':'hidden'}>正文修改尚未保存，保存后才能用于抽取。</p>
      <button type="button" class="btn btn-secondary" data-cv="intake-save" ${!complete||i.editLocked||!i.hasEdits?'disabled':''}>保存正文</button>
      <button type="button" class="btn btn-primary" data-cv="intake-confirm" ${!complete||i.editLocked?'disabled':''}>${i.hasEdits?'保存并进入下一步':'确认正文，进入下一步'}</button>
      <button type="button" class="btn btn-secondary" data-cv="material-auto-from-source" ${!complete||i.editLocked?'disabled':''}>${i.hasEdits?'保存正文并准备自动抽取':'使用当前正文，自动抽取'}</button>
      <p class="muted">进入下一步可通过对话明确目标；自动抽取使用当前本体规则，先展示处理计划和发布方式，确认后才开始。</p>
      ${r.confirmed?'<p data-intake-confirmed role="status">正文已核对，尚未启动新的抽取。</p>':''}`;
  }
  const shown=submitting||r;
  return `<div class="cv-conversation-actions cv-intake" data-next-step="source-review"><article class="cv-message cv-assistant cv-action-message"><header><strong>资料整理</strong><span>第 1 步 · 材料解析</span></header><div class="cv-action-body"><h3>${esc(shown?.name)}</h3>${shown?.note?`<p class="cv-intake-note">补充说明：${esc(shown.note)}</p>`:''}${body}</div></article></div>`;
}
