import {warehouseMaterialEntries} from './material-library.mjs';
import {materialListHTML} from './material-workspace.mjs';
import {materialAutomaticCard,materialAutomaticPublished,materialProcessingActive,materialReviewPending,materialRecoveryHTML} from './material-agent.mjs';
import {materialHistoryButton,materialHistoryHTML} from './material-history.mjs';
import {materialRoundsHTML} from './material-rounds.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=code=>Object.assign(Error(code),{code});
export function materialIndexState(value,id,version){
  const covered=value?.document_coverage?.find(d=>d.document_id===id&&d.version_id===version);
  if(value?.embedding_configured===true&&value.compatible===true&&value.fresh===true&&covered?.indexed===true)return 'ready';
  if(value?.embedding_configured===false)return 'unconfigured';
  if(value?.items?.some(i=>i.status==='building'&&['queued','running'].includes(i.job_status)))return 'building';
  if(!value||!Array.isArray(value.document_coverage))return 'unknown';
  return 'pending';
}
export function materialPreparationIndex(view){
  const p=view?.workflow?.preparation,version=view?.source?.version?.id;
  if(!p)return materialIndexState(view?.index,view?.documentId,version);
  if(!version||!p.indexing||p.indexing.document_version_id!==version)return 'unknown';
  if(p.ready===true&&p.indexing.status==='ready')return 'ready';
  return {queued:'queued',running:'building',failed:'failed',cancelled:'cancelled',blocked:'blocked',stale:'stale',not_started:'not_started'}[p.indexing.status]||'unknown';
}
export class MaterialImport {
  constructor(flow){this.f=flow;this.view=null;this.lastRead=0;this.refreshing=false;this.lastRefresh=null;}
  get blocked(){const f=this.f;return !f.state.loaded||!!(f.intake.staged||f.saved.pending||f.saved.upload||f.saved.intakeSubmission||f.saved.roundOpening||f.saved.materialDeletion||f.changes.pending||f.changes.record.pending||f.changes.claimRequest||f.reviewPending||f.claimPending||f.releasePending);}
  get confirmed(){
    const v=this.view;if(!v?.source.version?.id)return false;
    const preparation=v.workflow.preparation,review=preparation?.source_review;
    // A server exemption satisfies the review gate without a local marker.
    // Local reviews are only a compatibility path for servers without preparation.
    if(preparation)return review?.status==='not_required'||review?.status==='confirmed'&&review.confirmed_version_id===v.source.version.id;
    return this.f.saved.importReviews?.[v.documentId]===v.source.version.id;
  }
  get complete(){const v=this.view;return !!v&&this.confirmed&&v.workflow.document.status==='ready'&&materialPreparationIndex(v)==='ready';}
  apply(p,value){
    if(!['conversation-source-confirm','conversation-index-retry'].includes(p.action))return;
    const r=value?.receipt;
    if(!r||r.document_id!==p.input.documentId||r.document_version_id!==p.input.documentVersionId||r.operation_id!==p.input.operationId||!r.confirmation_id||r.extraction_started!==false||r.publication_performed!==false)throw fail('SEMANTICA_INVALID_RESPONSE');
    this.f.saved.importReviews={...this.f.saved.importReviews,[r.document_id]:r.document_version_id};
  }
  async read(id,offset=0){
    this.f.state.importDocumentId=id;
    if(this.view?.documentId!==id){this.view=null;this.f.state.librarySelection=null;}
    if(this.view?.documentId===id)this.view.index=null;
    const f=this.f,source=await f.read('document',{id,offset}),workflow=await f.read('conversation-material-workflow',{documentId:id});
    if(source.document?.id!==id||workflow.document_id!==id||workflow.document?.id!==id||!Array.isArray(source.segments)||source.version?.id&&source.version.id!==workflow.document_version_id)throw fail('MODELING_SNAPSHOT_CHANGED');
    let index=null,indexError=false;
    try{if(!workflow.preparation)index=await f.read('workbench-request',{method:'GET',url:'/api/search/indexes'});}
    catch(e){if([401,403].includes(e.status))throw e;indexError=true;}
    const previous=this.view?.documentId===id&&this.view.source.version?.id===source.version?.id?this.view:null;
    this.view={documentId:id,source,workflow,index,indexError,offset,pageSize:previous?.pageSize||source.segments.length||100,textWindow:previous?.textWindow};this.lastRead=Date.now();
    f.state.librarySelection={document:{...workflow.document,workflow},links:[]};
    const row=f.state.warehouseMaterials?.find(d=>d.id===id);if(row)Object.assign(row,f.state.librarySelection.document);
    f.saved.libraryDocumentId=id;f.persist();
  }
  select(id){return this.f.run(async()=>{
    const f=this.f;if(this.blocked)throw fail('MODELING_REQUEST_PENDING');
    f.rounds.clear();
    if(f.history?.view?.documentId!==id)f.history?.clear();
    f.changes.state.claimConfirmation=null;
    f.state.autoSwitch=false;f.state.materialSwitchProposal=null;
    f.rememberMaterialComposer();this.view=null;f.state.librarySelection=null;f.state.materialPage='import';f.state.materialOperation=null;
    await this.read(id);await f.agent.sync();
  });}
  async first(){const rows=warehouseMaterialEntries(this.f);if(rows.length)await this.select(rows[0].document.id);}
  async exitDialogue(){
    const f=this.f,id=f.agent.documentId;
    if(f.state.busy||!id)return;
    await this.select(id);
    if(!f.state.error&&this.view?.documentId===id&&f.state.materialPage==='import'){
      f.state.dialogueExitNotice={documentId:id,message:'已退出对话模式。已保存的草稿和修改建议会保留，未发送的输入保存在本机；退出不会自动发布，也不会停止已提交的服务端任务。需要继续时，选择“对话调整”或“继续核对草稿”。'};
      f.emit();
    }
  }
  async refresh(){
    if(this.refreshing||this.f.state.busy&&!this.f.backgroundDone)return;
    const f=this.f,id=f.state.importDocumentId;
    this.refreshing=true;this.lastRefresh=null;f.emit();
    try{
      if(!f.state.loaded){await f.refresh();if(!f.state.loaded||f.state.error)return;}
      if(id)await this.select(id);else await this.first();
      if(!f.state.error&&this.view&&f.state.loaded)this.lastRefresh={documentId:this.view.documentId,at:Date.now()};
    }finally{this.refreshing=false;if(f.live&&f.isCurrent())f.emit();}
  }
  page(delta){const v=this.view;if(!v||this.blocked)return;return this.f.run(()=>this.read(v.documentId,Math.max(0,v.offset+delta*v.pageSize)));}
  text(start=0){return this.f.run(async()=>{
    const v=this.view;if(this.blocked||!v?.source.version?.id)return;
    if(!Number.isSafeInteger(start)||start<0)throw fail('SEMANTICA_INVALID_RESPONSE');
    const text=await this.f.read('workbench-request',{method:'GET',url:'/api/documents/'+encodeURIComponent(v.documentId)+'/text?'+new URLSearchParams({version_id:v.source.version.id,start:String(start),end:String(start+65536)})});
    if(text.document_id!==v.documentId||text.version_id!==v.source.version.id||this.view!==v||text.start!==start||typeof text.text!=='string'||!Number.isSafeInteger(text.end)||!Number.isSafeInteger(text.total_chars))throw fail('MODELING_SOURCE_CHANGED');
    if(text.end<start||text.end>text.total_chars||text.end-start>65536||text.end===start&&start<text.total_chars||Array.from(text.text).length!==text.end-start)throw fail('SEMANTICA_INVALID_RESPONSE');
    v.textWindow=text;
  });}
  confirm(){return this.f.run(async()=>{
    if(this.blocked)throw fail('MODELING_REQUEST_PENDING');
    const shown=this.view;if(!shown?.source.version?.id)throw fail('MODELING_SOURCE_NOT_READY');
    await this.read(shown.documentId,shown.offset);
    if(this.view.source.version?.id!==shown.source.version.id)throw fail('MODELING_SOURCE_CHANGED');
    if(this.view.workflow.document.status!=='ready')throw fail('MODELING_SOURCE_NOT_READY');
    if(this.view.workflow.preparation){
      await this.f.write('conversation-source-confirm',{documentId:shown.documentId,documentVersionId:shown.source.version.id,confirmed:true});
      await this.read(shown.documentId,shown.offset);return;
    }
    // Compatibility with older workflows that do not advertise preparation.
    // Never treat this local marker as a server confirmation on newer services.
    const previous=this.f.saved.importReviews;
    this.f.saved.importReviews={...previous,[shown.documentId]:shown.source.version.id};
    try{this.f.persist();}catch(error){this.f.saved.importReviews=previous;throw error;}
  });}
  retryIndex(){return this.f.run(async()=>{
    if(this.blocked)throw fail('MODELING_REQUEST_PENDING');
    const shown=this.view;if(!shown?.source.version?.id)throw fail('MODELING_SOURCE_NOT_READY');
    const confirmation=shown.workflow.preparation?.source_review?.confirmation_id;
    await this.read(shown.documentId,shown.offset);
    const p=this.view.workflow.preparation;
    if(this.view.source.version?.id!==shown.source.version.id)throw fail('SOURCE_VERSION_CONFLICT');
    if(!this.confirmed||!confirmation||p?.source_review.confirmation_id!==confirmation)throw fail('SOURCE_CONFIRMATION_STALE');
    if(!p.indexing.retryable)return;
    await this.f.write('conversation-index-retry',{documentId:shown.documentId,documentVersionId:shown.source.version.id,confirmationId:confirmation});
    await this.read(shown.documentId,shown.offset);
  });}
  async refreshReady(allowResults=false){
    const available=()=>{const c=this.f.agent.current;return this.complete||allowResults&&!!this.view?.source.version?.id&&(materialReviewPending(this.f,this.view.workflow)||this.confirmed&&c?.current?.is_current===true&&c.receipt?.document_version_id===this.view.source.version.id&&['awaiting_review','published'].includes(c.current.stage));};
    if(this.blocked||!available())return false;const id=this.view.documentId;let refreshed=false;await this.f.run(async()=>{await this.read(id,this.view.offset);refreshed=true;});return refreshed&&!this.f.state.error&&!this.blocked&&this.view?.documentId===id&&available();
  }
  async automatic(){
    if(!await this.refreshReady())return;
    if(materialProcessingActive(this.f))return this.f.run(async()=>{throw fail('MODELING_MATERIAL_BUSY');});
    await this.f.agent.prepareAutomatic();
  }
  switchAutomatic(){return this.automatic();}
  async review(openEditor){
    if(!await this.refreshReady(true))return;
    const f=this.f,w=this.view.workflow;
    if(materialProcessingActive(f,w))return f.run(async()=>{throw fail('MODELING_MATERIAL_BUSY');});
    if(!materialReviewPending(f,w))return;
    const linked=w.conversations?.some(c=>c.conversation_status==='active'&&!f.saved.resumedIntents?.[c.intent_id]);
    // Automatically extracted results may have no dialogue session. Review
    // them with the existing in-page editor instead of creating a blocked chat.
    if(!linked)return openEditor(this.view.documentId);
    return this.dialogue();
  }
  dialogue(){return this.f.rounds.enter();}
  async tick(){
    const f=this.f;if(f.state.busy||this.blocked||Date.now()-this.lastRead<3000)return;
    const id=f.state.importDocumentId;if(!id)return;
    await f.run(async()=>{await this.read(id,this.view?.offset||0);await f.agent.sync();},{background:true});
  }
}
function currentImportOperation(f,v){
  const c=f.agent.current;
  return c?.current?.is_current===true&&c.receipt?.document_id===v.documentId&&
    c.receipt.document_version_id===v.source.version?.id?c:null;
}
function importStepsHTML(f,v,off){
  const index=materialPreparationIndex(v),preparation=v.workflow.preparation;
  const reviewExempt=preparation?.source_review?.status==='not_required';
  const ready=v.workflow.document.status==='ready'&&!!v.source.version?.id;
  const confirmed=f.importer.confirmed,complete=f.importer.complete;
  const completeText=reviewExempt?'当前正文与索引可用。请选择知识整理方式。':'正文已核对，当前版本索引可用。请选择知识整理方式。';
  const processing=materialProcessingActive(f,v.workflow),processingOff=off||processing;
  const automaticAllowed=v.workflow.actions?.prepare_automatic?.allowed===true;
  const reviewPending=materialReviewPending(f,v.workflow),draft=!!v.workflow.draft||v.workflow.stage==='draft';
  const recovery=complete||reviewPending?materialRecoveryHTML(f,v.workflow):'';
  const published=v.workflow.publication?.status==='published'&&v.workflow.publication.document_version_id===v.source.version?.id;
  const reviewCard=`<div class="mw-import-complete"><div><h3>${processing?'材料正在处理中':published?'已有发布结果 · 有待核对修改':draft?'草稿待核对':'抽取结果待核对'}</h3><p>${processing?'请等待当前任务完成后继续核对。':published?'当前正文已有发布结果。服务端同时返回了待核对修改，请核对其范围；已有发布结果不会因此撤回。':draft?'这份材料有尚未发布的草稿。继续核对实体、关系和证据，再确认发布。':'已有抽取结果可继续核对；也可预览自动抽取，由服务端检查本次处理影响。'}</p></div><div class="mw-import-actions"><button class="btn btn-primary" data-cv="import-review" ${processingOff?'disabled':''}>${draft?'继续核对草稿':'继续核对抽取结果'}</button><button class="btn btn-secondary" data-cv="import-auto-switch" ${processingOff||!complete||!automaticAllowed?'disabled':''}>自动抽取</button></div></div>`;
  const failed=['failed','cancelled'].includes(v.workflow.document.status);
  const operation=currentImportOperation(f,v),stage=operation?.current.stage;
  const extracting=['queued','running','publishing'].includes(stage);
  const extractionDone=['publishing','awaiting_review','published'].includes(stage);
  const interrupted=['failed','cancelled','stale'].includes(stage);
  const publishedNow=materialAutomaticPublished(operation?.current);
  const items=operation?[
    {title:'正文与索引',hint:'沿用当前正文版本',state:complete?'done':'waiting',status:complete?'已就绪':'待确认'},
    {title:interrupted?'本轮知识处理':'抽取知识',hint:interrupted?'查看处理记录与恢复操作':'按当前规则抽取',state:extractionDone?'done':interrupted?'failed':extracting?'active':'waiting',status:extractionDone?'已完成':({queued:'排队中',running:'进行中',failed:'处理失败',cancelled:'已停止',stale:'已失效'}[stage]||'待确认')},
    {title:stage==='awaiting_review'?'核对并发布':'发布知识',hint:stage==='awaiting_review'?'核对结果后确认发布':'以本轮发布回执为准',state:publishedNow?'done':['publishing','awaiting_review'].includes(stage)?'active':'waiting',status:publishedNow?'已发布':({publishing:'进行中',awaiting_review:'待核对',published:'待确认'}[stage]||'未开始')},
  ]:[
    {title:'解析材料',hint:'识别文本与结构',state:ready?'done':failed?'failed':'active',status:ready?'已完成':failed?'未完成':'进行中'},
    {title:'核对正文',hint:reviewExempt?'沿用当前正文版本':'检查并确认内容',state:confirmed?'done':ready?'active':'waiting',status:reviewExempt?'无需重复确认':confirmed?'已完成':ready?'待确认':'待处理'},
    {title:'建立索引',hint:'生成检索引用',state:index==='ready'?'done':['building','queued'].includes(index)?'active':['failed','blocked','cancelled'].includes(index)?'failed':'waiting',status:{ready:'已完成',building:'进行中',queued:'排队中',failed:'失败',blocked:'受阻',cancelled:'已停止',stale:'待更新',unconfigured:'待配置',not_started:'未开始'}[index]||'待就绪'},
  ];
  const indexText={ready:'当前正文索引已就绪',building:'服务端正在建立索引',queued:'索引任务正在排队',pending:'等待当前正文索引就绪',unknown:'暂未确认当前正文的索引状态',unconfigured:'服务端尚未配置向量模型，无法完成索引',not_started:'索引任务尚未启动',failed:'索引建立失败',blocked:'索引建立受阻',cancelled:'索引任务已停止',stale:'索引需要更新'}[index];
  const progress=preparation?.indexing,known=Number.isSafeInteger(progress?.total_units)&&progress.total_units>0&&Number.isSafeInteger(progress.completed_units)&&progress.completed_units>=0;
  const indexProgress=['building','queued'].includes(index)?`<progress aria-label="索引建立进度" ${known?`max="${progress.total_units}" value="${Math.min(progress.completed_units,progress.total_units)}"`:''}></progress>${known?`<small>已完成 ${progress.completed_units} / ${progress.total_units} 单元</small>`:''}`:'';
  const retry=confirmed&&progress?.retryable?`<button class="btn btn-secondary" data-cv="import-index-retry" ${off?'disabled':''}>重试建立索引</button>`:'';
  return `<section class="mw-import-process" aria-label="材料处理流程"><header><strong>${operation?'本次自动抽取流程':'材料处理流程'}</strong><span>以最近读取的服务端状态为准</span></header>
    <ol class="mw-import-steps">${items.map((item,n)=>`<li class="is-${item.state}" ${item.state==='active'?'aria-current="step"':''}><span class="mw-step-number" aria-hidden="true">${item.state==='done'?'✓':n+1}</span><div><strong>${item.title}</strong><small>${item.hint}</small></div><span class="mw-step-status">${item.status}</span></li>`).join('')}</ol>
    ${extracting&&!f.agent.record.preview?`<div class="mw-import-task-progress" role="status">${materialAutomaticCard(f)}</div>`:''}
    ${f.agent.record.preview&&(!reviewPending||complete)?`<div class="mw-import-confirmation">${materialAutomaticCard(f)}</div>`:recovery?recovery:reviewPending?reviewCard:complete?`<div class="mw-import-complete"><span class="mw-complete-icon" aria-hidden="true">${processing?'…':'✓'}</span><div><h3>${processing?'材料正在处理中':'材料处理完成'}</h3><p>${processing?'当前任务完成或停止后，可再次选择自动抽取或对话调整。':completeText}</p></div><div class="mw-import-actions"><button class="btn btn-primary" data-cv="import-auto" ${processingOff||!automaticAllowed?'disabled':''}>自动抽取</button><button class="btn btn-secondary" data-cv="import-dialogue" ${processingOff?'disabled':''}>对话调整</button></div></div>`:
    `<div class="mw-import-pending"><div><strong>${failed?'材料解析未完成':!ready?'正在处理材料':!confirmed?'请核对下方正文并确认':indexText}</strong><p>${failed?'请在处理记录中查看原因及可恢复操作。':!ready?'解析完成后将在下方显示正文片段。':!confirmed?preparation?'确认后服务端保存正文确认并安排索引任务。':'确认当前正文后，再选择后续处理方式。':progress?.error?esc(progress.error.detail||progress.error.code):index==='not_started'?'尚未收到索引任务，请读取最新进度或查看处理记录。':'索引进度以服务端任务回执为准。'}</p>${indexProgress}</div>${ready&&!confirmed?`<button class="btn btn-primary" data-cv="import-confirm" ${off?'disabled':''}>${preparation?'确认正文并建立索引':'确认正文'}</button>`:retry}</div>`}
    <p class="mw-import-limit">${!automaticAllowed&&v.workflow.actions?.prepare_automatic?.reason?`${esc(v.workflow.actions.prepare_automatic.reason)}。`:""}${preparation?`${reviewExempt?'当前正文无需重复确认':confirmed?'当前版本已在服务端确认':'当前正文尚未完成确认'} · ${indexText}。`:`${confirmed?'当前版本已核对':'正文核对记录保存在本机'} · ${indexText}。索引由服务端自动维护，可能在正文确认前开始。`}</p>
  </section>`;
}
function importSourceHTML(v,off,confirmed){
  const total=v.source.document.segment_count;
  const count=Number.isSafeInteger(total)&&total>=0?`${total} 个内容片段`:'正文片段数量待确认';
  return `<section class="mw-import-source"><header><div><small>解析结果</small><h3>材料正文</h3><p>${count}，${confirmed?'可查看当前版本正文':'请核对内容后确认正文'}。</p></div></header>
    ${v.textWindow?`<div class="mw-full-text"><p>${esc(v.textWindow.text)}</p></div><div class="mw-source-pagination"><small>${v.textWindow.start}–${v.textWindow.end} / ${v.textWindow.total_chars} 字符</small><button class="btn btn-secondary" data-cv="import-text-prev" ${off||!v.textWindow.start?'disabled':''}>上一段正文</button><button class="btn btn-secondary" data-cv="import-text-next" ${off||v.textWindow.end>=v.textWindow.total_chars?'disabled':''}>下一段正文</button></div>`:
    `<div class="mw-source-segments">${v.source.segments.map((s,n)=>`<article><span class="mw-segment-number">${String(v.offset+n+1).padStart(2,'0')}</span><div><small>正文片段</small><p>${esc(s.text)}</p>${s.text_truncated?`<small>此长段落仅显示部分内容。</small><button class="btn btn-secondary" data-cv="import-text" ${off?'disabled':''}>读取完整正文</button>`:''}</div></article>`).join('')||'<p class="mw-source-empty">正文尚未准备好。</p>'}</div>
    <div class="mw-source-pagination"><small>${v.source.segments.length?`显示 ${v.offset+1}–${v.offset+v.source.segments.length} 个片段`:''}</small><button class="btn btn-secondary" data-cv="import-prev" ${off||!v.offset?'disabled':''}>上一页</button><button class="btn btn-secondary" data-cv="import-next" ${off||!v.source.segments.length||v.offset+v.source.segments.length>=(total||0)?'disabled':''}>下一页</button></div>`}
  </section>`;
}
export function materialImportHTML(f,welcome){
  const v=f.importer?.view,off=f.state.busy||f.importer?.blocked;
  const refreshed=f.importer.lastRefresh;
  const feedback=f.importer.refreshing?'正在读取材料最新进度…':refreshed?.documentId===v?.documentId&&refreshed?`已读取最新进度（${new Date(refreshed.at).toLocaleTimeString('zh-CN')}）。` : '';
  const errors=f.state.error?`<p class="cv-error" role="alert">${esc(f.state.error)}</p>`:'';
  return `<div class="material-workspace mw-import-layout"><aside class="mw-library" aria-label="材料列表">${materialListHTML(f)}</aside><section class="mw-review" aria-label="导入材料与正文"><header><div class="mw-import-file"><span aria-hidden="true">▤</span><div><small>当前材料</small><h2>${esc(v?.workflow.document.original_name||(f.state.importDocumentId?'读取当前材料':'从第一份材料开始'))}</h2></div></div><div class="mw-material-tools">${materialHistoryButton(f)}<button class="btn btn-secondary" data-warehouse-id="${esc(f.warehouseId)}" data-warehouse-view="tasks">处理记录</button>${v?`<button class="btn btn-secondary" data-cv="material-delete" ${off?'disabled':''}>删除材料</button>`:''}</div></header><div class="mw-review-content">
    ${feedback?`<p class="mw-refresh-feedback" role="status">${esc(feedback)}</p>`:''}${errors}${f.state.deletionNotice?`<p role="status">${esc(f.state.deletionNotice)}</p>`:''}${f.saved.pending?'<p>上次操作结果尚未确认。</p><button class="btn btn-secondary" data-cv="retry-pending">恢复原请求</button>':''}${f.saved.upload&&!f.saved.pending?'<p>材料上传尚未完成。</p><button class="btn btn-secondary" data-cv="resume-upload">继续上传</button>':''}${f.saved.intakeSubmission&&!f.saved.pending?'<p>材料导入尚未完成。</p><button class="btn btn-secondary" data-cv="import-resume">继续导入</button>':''}
    ${v&&f.state.dialogueExitNotice?.documentId===v.documentId?`<p class="cv-notice" role="status">${esc(f.state.dialogueExitNotice.message)}</p>`:''}${materialRoundsHTML(f)}
    ${v?`${importStepsHTML(f,v,off)}${materialHistoryHTML(f)}${f.agent.record.preview||materialReviewPending(f,v.workflow)||['queued','running','publishing'].includes(currentImportOperation(f,v)?.current.stage)?'':materialAutomaticCard(f)}${importSourceHTML(v,off,f.importer.confirmed)}`:f.state.importDocumentId?'<p role="status">当前材料尚未读取成功，请从材料列表重新选择当前材料，或选择其他材料。</p>':f.state.loaded&&!f.saved.pending&&!f.saved.upload&&!f.saved.intakeSubmission?welcome:'<p role="status">正在读取材料或提交导入…</p>'}
  </div></section></div>`;
}
