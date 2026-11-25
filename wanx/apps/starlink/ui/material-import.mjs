import {logicalSourcesHTML, logicalSourceGroups} from './logical-source-view.mjs';
import { starxiaotuTermMarker } from './term-help.mjs';
import {warehouseMaterialEntries} from './material-library.mjs';
import {materialAccessLost} from './native-workbench.js';
import {materialAnnotationHTML} from './import-annotation.mjs';
import {materialListHTML} from './material-workspace.mjs';
import {materialAutomaticCard,materialAutomaticPublished,materialAutomaticNoCandidates,materialProcessingActive,materialReviewPending,materialRecoveryHTML} from './material-agent.mjs';
import {materialRoundsHTML,unfinishedRound} from './material-rounds.mjs';
import {automaticMaterialReview,materialDraftChanges,materialWorkflowLabel,publishedMaterial,publishedMaterialQuality} from './material-state.mjs';
import {createGraphPresentation} from './graph-presentation.mjs';
import {factSchema} from './material-fact-cards.mjs';
import {candidatesReady} from './conversation-progress.mjs';
import {loadCorrectionSegments} from '../shared/source-correction.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=code=>Object.assign(Error(code),{code});
const readerBatch=12;
function readerKnowledgeTarget(f,v){
  if(!v)return null;
  const w=v.workflow,pending=materialReviewPending(f,w);
  if(pending){
    const round=w.processing_mode==='automatic'?null:unfinishedRound(f,w);
    if(round?.execution_status==='awaiting_review')return {kind:'review',id:round.intent_id,round};
    return {kind:'review',id:w.extraction_review?.run_id};
  }
  if(v.knowledgeOpen&&publishedMaterial(w))return {kind:'published',id:w.publication.id};
  return null;
}
function readerKnowledgeKey(target,v){
  return target?.id?JSON.stringify([target.kind,target.id,v.source.version?.id,v.workflow.draft?.revision]):null;
}
function readerEvidence(item,v){
  return (Array.isArray(item?.evidence)?item.evidence:[]).find(e=>typeof e?.segment_id==='string'&&e.segment_id&&
    (!e.document_id||e.document_id===v.documentId)&&(!e.document_version_id||e.document_version_id===v.source.version?.id));
}
async function readReaderCandidates(f,v,target){
  if(target.round){
    const link=target.round,ids={conversationId:link.conversation_id,intentId:link.intent_id};
    const detail=await f.read('conversation-intent',ids);
    if(!candidatesReady(detail)||detail.document_id!==v.documentId||detail.document_version_id!==v.source.version?.id||
      detail.id!==link.intent_id||!detail.execution?.id)throw fail('MODELING_SNAPSHOT_CHANGED');
    const items=[];
    let more=true;
    while(more){
      const page=await f.read('conversation-candidates',{...ids,offset:items.length,limit:50});
      if(page.execution_id!==detail.execution.id||!Array.isArray(page.items)||page.has_more&&!page.items.length)throw fail('MODELING_SNAPSHOT_CHANGED');
      items.push(...page.items);more=page.has_more;
    }
    const latest=await f.read('conversation-intent',ids);
    if(!candidatesReady(latest)||latest.revision!==detail.revision||latest.execution?.id!==detail.execution.id||
      latest.document_version_id!==detail.document_version_id)throw fail('MODELING_SNAPSHOT_CHANGED');
    return items;
  }
  const data=await f.read('conversation-published-run',{runId:target.id}),run=data?.run;
  if(run?.id!==target.id||run.document_id!==v.documentId||run.document_version_id!==v.source.version?.id||
    run.status!==target.kind||!Array.isArray(data.candidates))throw fail('MODELING_SNAPSHOT_CHANGED');
  return data.candidates;
}
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
  constructor(flow){this.f=flow;this.view=null;this.lastRead=0;this.refreshing=false;this.lastRefresh=null;this.sourceEdit=null;this.sourceNotice='';}
  get blocked(){const f=this.f;return !f.state.loaded||!!(this.sourceEdit||f.intake.staged||f.saved.pending||f.saved.upload||f.saved.intakeSubmission||f.saved.roundOpening||f.saved.materialDeletion||f.changes.pending||f.changes.record.pending||f.changes.claimRequest||f.reviewPending||f.claimPending||f.releasePending);}
  get sourceBlocked(){
    const f=this.f;
    return !f.state.loaded||f.state.busy||this.refreshing||!!(f.intake.staged||f.saved.upload||f.saved.intakeSubmission||f.saved.materialDeletion);
  }
  get confirmed(){
    const v=this.view;if(!v?.source.version?.id)return false;
    const preparation=v.workflow.preparation,review=preparation?.source_review;
    // A server exemption satisfies the review gate without a local marker.
    // Local reviews are only a compatibility path for servers without preparation.
    if(preparation)return review?.status==='not_required'||review?.status==='confirmed'&&review.confirmed_version_id===v.source.version.id;
    return this.f.saved.importReviews?.[v.documentId]===v.source.version.id;
  }
  get complete(){const v=this.view;return !!v&&this.confirmed&&v.workflow.document.status==='ready'&&materialPreparationIndex(v)==='ready';}
  get canProcessSource(){
    const f=this.f,v=this.view;
    const preview=f.agent.record.preview,previewVersion=preview?.snapshot?.document_version_id;
    const pendingPreview=preview&&(!previewVersion||previewVersion===v?.source.version?.id);
    return sourceEditable(v)&&v.workflow.actions?.process_source?.allowed===true&&!v.workflow.publication&&
      !pendingPreview&&!currentImportOperation(f,v)&&!materialReviewPending(f,v.workflow)&&!materialProcessingActive(f,v.workflow);
  }
  startProcessing(){return this.f.run(async()=>{
    const shown=this.view;
    if(this.blocked||!this.canProcessSource)return;
    await this.read(shown.documentId,shown.offset);
    const v=this.view;
    if(v.source.version?.id!==shown.source.version.id||v.workflow.workflow_revision!==shown.workflow.workflow_revision)
      throw fail('MODELING_SOURCE_CHANGED');
    if(!this.canProcessSource)return;
    await this.f.write('conversation-processing-start',{documentId:v.documentId,documentVersionId:v.source.version.id,
      workflowRevision:v.workflow.workflow_revision,confirmed:true});
    await this.read(v.documentId,v.offset);
    await this.f.agent.sync();
  });}
  async editSource(){
    const f=this.f;
    if(f.backgroundDone)await f.backgroundDone;
    if(!f.live||!f.isCurrent())return;
    const v=this.view;
    if(this.sourceEdit||this.sourceBlocked||f.state.materialPage!=='import'||v?.documentId!==f.state.importDocumentId||!sourceEditable(v))return;
    const edit=this.sourceEdit={documentId:v.documentId,versionId:v.source.version.id,offset:v.offset,pageSize:v.pageSize,
      segments:null,edits:new Map(),loading:true,saving:false,write:null,stale:false,error:''};
    this.sourceNotice='';f.emit();
    const current=()=>this.sourceEdit===edit&&this.view===v&&f.live&&f.isCurrent();
    const request=url=>f.read('workbench-request',{method:'GET',url});
    try{
      const detail=await request(`/api/documents/${encodeURIComponent(edit.documentId)}?segment_offset=0&segment_limit=200&block_limit=1`);
      if(!current())return;
      if(detail?.document?.id!==edit.documentId||detail.version?.id!==edit.versionId)throw fail('SOURCE_VERSION_CONFLICT');
      if(!Array.isArray(detail.segments)||detail.document.segment_count!==v.source.document.segment_count)throw fail('SEMANTICA_INVALID_RESPONSE');
      edit.segments=await loadCorrectionSegments(detail,0,current,request);
    }catch(error){
      if(!current())return;
      edit.stale=error.code==='SOURCE_VERSION_CONFLICT';
      edit.error=edit.stale?'材料正文已更新。请取消编辑，核对最新版本后再修改。':
        (error.code?'完整正文读取失败，请取消后重试。':error.message);
    }finally{if(current()){edit.loading=false;f.emit();}}
  }
  changeSource(ordinal,text){
    const edit=this.sourceEdit,segment=edit?.segments?.[ordinal];
    if(!segment||edit.saving||edit.write||edit.stale)return;
    if(text===segment.text)edit.edits.delete(segment.id);
    else edit.edits.set(segment.id,text);
  }
  pageSource(delta){
    const edit=this.sourceEdit;
    if(!edit?.segments||edit.saving)return;
    edit.offset=Math.max(0,Math.min(edit.offset+delta*edit.pageSize,Math.floor((edit.segments.length-1)/edit.pageSize)*edit.pageSize));
    this.f.emit();
  }
  canLeaveSource(){
    const edit=this.sourceEdit;
    return !edit||!edit.saving&&!edit.write&&!edit.edits.size;
  }
  async cancelSource(){
    const edit=this.sourceEdit;
    if(!edit||edit.saving)return;
    this.sourceEdit=null;
    this.f.emit();
    if(edit.stale||edit.write)await this.f.run(()=>this.read(edit.documentId));
    if(edit.write&&this.f.live&&this.f.isCurrent()&&this.view?.documentId===edit.documentId&&!this.sourceEdit){
      this.sourceNotice='上次保存结果未确认，已退出编辑。请核对当前版本。';this.f.emit();
    }
  }
  async saveSource(){
    const f=this.f,edit=this.sourceEdit;
    if(!edit?.segments||edit.saving||edit.stale||!edit.edits.size||this.sourceBlocked)return;
    const operation=currentImportOperation(f,this.view);
    const superseded=operation&&['queued','running','publishing','awaiting_review'].includes(operation.current.stage);
    if(!edit.write){
      const segments=edit.segments.map(segment=>({id:segment.id,text:edit.edits.get(segment.id)??segment.text}));
      if(!segments.some(segment=>segment.text.trim())){
        edit.error='正文至少需要保留一个有内容的片段。';f.emit();return;
      }
      edit.write=JSON.stringify({operation_id:f.uuid(),base_version_id:edit.versionId,segments});
    }
    edit.saving=true;edit.error='';f.emit();
    const current=()=>this.sourceEdit===edit&&f.live&&f.isCurrent();
    try{
      const result=await f.read('workbench-request',{method:'PATCH',
        url:`/api/documents/${encodeURIComponent(edit.documentId)}/content`,body:edit.write});
      if(!current())return;
      if(result?.document?.id!==edit.documentId||!result.version?.id||result.version.id===edit.versionId)
        throw fail('SEMANTICA_INVALID_RESPONSE');
      try{
        await this.read(edit.documentId);
        this.sourceNotice=superseded?'已保存新的星图正文版本。上一轮处理基于旧正文，已失效。':'已保存新的星图正文版本，原文件保持不变。';
      }catch{
        this.sourceNotice='正文版本已保存，刷新失败。请重新读取材料。';
        this.lastRead=0;
      }
      if(current())this.sourceEdit=null;
    }catch(error){
      if(!current())return;
      if([400,401,403,404,409,413,422].includes(error.status)){
        edit.write=null;
        edit.stale=error.status===409;
        edit.error=edit.stale?'材料正文已更新。请取消编辑，核对最新版本后再修改。':
          error.status===413?'修改后的正文超过大小限制。':
          error.status===401||error.status===403?'当前会话没有保存正文的权限。':
          error.code==='SEMANTICA_OPERATION_NOT_ALLOWED'||error.code==='SEMANTICA_UPGRADE_REQUIRED'?'当前盒端接口尚未支持保存正文。':
          '保存被拒绝，请检查正文后再试。';
      }else{
        edit.error='保存结果尚未确认。可以重试同一次保存，或关闭编辑后核对正文。';
      }
    }finally{
      if(f.live&&f.isCurrent()){edit.saving=false;f.emit();}
    }
  }
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
    this.view={...previous,documentId:id,source,workflow,index,indexError,offset,pageSize:previous?.pageSize||source.segments.length||100};this.lastRead=Date.now();
    if(source.version?.id && Date.now()-(previous?.ontologyCheckedAt||0)>=5000){
      const v=this.view;
      v.ontologyCheckedAt=Date.now();
      try{
        const result=await f.read('workbench-request',{method:'GET',url:'/api/ontology-suggestions/materials'});
        v.ontologySuggestion=result?.items?.find(item=>item.document_id===id &&
          (!item.document_version_id || item.document_version_id===source.version.id));
      }catch(error){
        if(materialAccessLost(error))v.ontologySuggestion=undefined;
        if(error.status===404)v.ontologyCheckedAt=Infinity;
      }
    }
    f.rounds.reconcile(workflow);
    if(automaticMaterialReview(workflow))f.state.dialogueExitNotice=null;
    f.state.librarySelection={document:{...workflow.document,workflow},links:[]};
    const row=f.state.warehouseMaterials?.find(d=>d.id===id);if(row)Object.assign(row,f.state.librarySelection.document);
    f.saved.libraryDocumentId=id;f.persist();
    await this.readKnowledge();
  }
  async readKnowledge(retry=false){
    const v=this.view,target=readerKnowledgeTarget(this.f,v),key=readerKnowledgeKey(target,v);
    if(!key||v.knowledge?.key!==key){
      if(v){v.knowledge=null;v.knowledgeLimit=readerBatch;v.knowledgeFilter='all';v.sourceMatch=null;v.sourceNotice='';}
    }else if(!retry)return;
    if(!key)return;
    const loading=v.knowledge={key,status:'loading'};
    this.f.emit();
    try{
      const candidates=await readReaderCandidates(this.f,v,target);
      const items=candidates.filter(i=>i&&['entity','relation'].includes(i.kind)&&
        (target.kind==='review'||i.status==='published'));
      if(this.view?.knowledge===loading)this.view.knowledge={key,status:'ready',items};
    }catch{
      if(this.view?.knowledge===loading)this.view.knowledge={key,status:'error'};
    }
    this.f.emit();
  }
  retryOntologySuggestions(){return this.f.run(async()=>{
    const v=this.view,status=v?.ontologySuggestion;
    if(this.blocked||status?.can_retry!==true||status.status!=='failed'||!status.task_id)return;
    const receipt=await this.f.read('workbench-request',{method:'POST',
      url:`/api/ontology-suggestions/materials/${encodeURIComponent(v.documentId)}/schedule`,
      body:JSON.stringify({task_id:status.task_id})});
    if(receipt?.document_id!==v.documentId||receipt.document_version_id!==v.source.version?.id||
      receipt.task_id!==status.task_id||!['queued','running','completed','failed'].includes(receipt.status))
      throw fail('SEMANTICA_INVALID_RESPONSE');
    if(this.view===v){v.ontologySuggestion=receipt;v.ontologyCheckedAt=Date.now();}
  });}
  async toggleKnowledge(){
    const v=this.view;if(!v||this.f.state.busy||materialReviewPending(this.f,v.workflow))return;
    v.knowledgeOpen=!v.knowledgeOpen;
    await this.readKnowledge();
    this.f.emit();
  }
  filterKnowledge(filter){
    if(!this.view||!['all','entity','relation'].includes(filter))return;
    this.view.knowledgeFilter=filter;this.view.knowledgeLimit=readerBatch;this.f.emit();
  }
  moreKnowledge(){
    if(this.view){this.view.knowledgeLimit+=readerBatch;this.f.emit();}
  }
  locateEvidence(index){return this.f.run(async()=>{
    const v=this.view,k=v?.knowledge;
    if(!v||this.blocked||k?.status!=='ready')return;
    const evidence=readerEvidence(k.items[index],v);
    if(!evidence)return;
    let page=v.source,offset=v.offset;
    const matching=()=>page.segments?.find(s=>s.id===evidence.segment_id);
    if(!matching()){
      // Search by the source's stable segment ID within the verified document version.
      for(offset=0;offset<v.source.document.segment_count;offset+=page.segments.length){
        if(offset===v.offset)page=v.source;
        else page=await this.f.read('document',{id:v.documentId,offset});
        if(this.view!==v||page.document?.id!==v.documentId||page.version?.id!==v.source.version?.id||
          !Array.isArray(page.segments)||!page.segments.length)break;
        if(matching())break;
      }
    }
    if(this.view!==v)return;
    const segment=page.version?.id===v.source.version?.id&&page.document?.id===v.documentId&&matching();
    if(!segment){v.sourceNotice='当前正文版本中找不到这个引用片段。';return;}
    v.source=page;v.offset=offset;v.textWindow=null;v.sourceNotice='';
    v.sourceMatch={id:segment.id,index,request:(v.sourceMatch?.request||0)+1};
  });}
  select(id){return this.f.run(async()=>{
    const f=this.f;if(this.blocked)throw fail('MODELING_REQUEST_PENDING');
    this.sourceNotice='';f.rounds.clear();
    f.state.dialogueExitNotice=null;
    f.changes.state.claimConfirmation=null;
    f.state.autoSwitch=false;f.state.materialSwitchProposal=null;
    if(!f.readerOnly)f.rememberMaterialComposer();
    this.view=null;f.state.librarySelection=null;f.state.materialPage='import';f.state.materialOperation=null;
    await this.read(id);await f.agent.sync();f.changes.suspend();
  });}
  async first(){const rows=warehouseMaterialEntries(this.f),remembered=this.f.saved.libraryDocumentId;
    const selected=rows.find(row=>row.document.id===remembered)||rows[0];if(selected)await this.select(selected.document.id);
  }
  async exitDialogue(){
    const f=this.f,id=f.agent.documentId;
    if(f.state.busy||!id||f.state.materialPage!=='dialogue')return;
    await this.select(id);
    if(!f.state.error&&this.view?.documentId===id&&f.state.materialPage==='import'&&!automaticMaterialReview(this.view.workflow)){
      f.state.dialogueExitNotice={documentId:id,message:'已退出对话模式。已保存到服务端的草稿和修改建议会保留，未发送的输入保存在本机；未确认的预览需重新核对。退出不会自动发布，也不会停止已提交的服务端任务。'};
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
  openCitation({page,excerpt}){
    const v=this.view;
    if(!v||page.document_id!==v.documentId)return;
    if(page.version_id===v.source.version?.id){
      v.textWindow=page;
      v.readerCitation={start:page.start,excerpt};
    }else{
      v.readerHandoffNotice='星图引用使用历史版本。这里显示当前正文；可返回星图打开引用版本。';
    }
    this.f.emit();
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
    const available=()=>{
      if(this.complete)return true;
      if(!allowResults||!this.view?.source.version?.id)return false;
      const {workflow,source}=this.view,c=this.f.agent.current;
      return !!publishedMaterialQuality(workflow)||materialReviewPending(this.f,workflow)||
        this.confirmed&&c?.current?.is_current===true&&c.receipt?.document_version_id===source.version.id&&['awaiting_review','published'].includes(c.current.stage);
    };
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
    const pending=materialReviewPending(f,w),publishedQuality=publishedMaterialQuality(w);
    if(!pending&&!publishedQuality){f.rounds.choice=null;f.emit();return;}
    // The current result's source takes precedence over historical chat links.
    const previous=pending&&w.processing_mode!=='automatic'?unfinishedRound(f,w):null;
    if(!previous||f.readerOnly){
      f.rounds.clear();f.state.dialogueExitNotice=null;
      f.emit();
      const currentCandidates=automaticMaterialReview(w)||f.readerOnly&&!w.draft&&
        (w.extraction_review?.run_id||previous?.execution_status==='awaiting_review');
      return openEditor(this.view.documentId,currentCandidates?'current-extraction':undefined);
    }
    // Offer only the verified continuation. A second dialogue-entry refresh
    // could observe completed work and start a new round from a review click.
    f.rounds.offer(w,previous);
  }
  async reviewAutomatic(openEditor){
    const f=this.f,id=f.agent.documentId||f.agent.current?.receipt?.document_id;
    const unavailable=()=>f.run(async()=>{throw fail('CORRECTION_REVIEW_NOT_READY');});
    if(!id||materialAutomaticNoCandidates(f.agent.current?.current))return unavailable();
    if(f.state.materialPage!=='import'||this.view?.documentId!==id)await this.select(id);
    if(f.state.error)return;
    if(f.state.materialPage!=='import'||this.view?.documentId!==id)return unavailable();
    if(!materialReviewPending(f,this.view.workflow)&&!publishedMaterialQuality(this.view.workflow))return unavailable();
    return this.review(openEditor);
  }
  dialogue(){if(!this.f.readerOnly)return this.f.rounds.enter();}
  async tick(){
    const f=this.f;if(f.state.busy||this.blocked||Date.now()-this.lastRead<3000)return;
    const id=f.state.importDocumentId;if(!id)return;
    await f.run(async()=>{await this.read(id,this.view?.offset||0);await f.agent.sync();},{background:true});
  }
}
function currentImportOperation(f,v){
  const c=f.agent.current;
  return v&&c?.current?.is_current===true&&c.receipt?.document_id===v.documentId&&
    c.receipt.document_version_id===v.source.version?.id?c:null;
}
function importStepsHTML(f,v,off){
  const index=materialPreparationIndex(v),preparation=v.workflow.preparation;
  const reviewExempt=preparation?.source_review?.status==='not_required';
  const ready=v.workflow.document.status==='ready'&&!!v.source.version?.id;
  const confirmed=f.importer.confirmed,complete=f.importer.complete;
  const processing=materialProcessingActive(f,v.workflow),processingOff=off||processing;
  const automaticAllowed=v.workflow.actions?.prepare_automatic?.allowed===true;
  const automaticReview=automaticMaterialReview(v.workflow);
  const reviewPending=materialReviewPending(f,v.workflow),draft=!automaticReview&&(!!v.workflow.draft||v.workflow.stage==='draft');
  const changed=materialDraftChanges(v.workflow);
  const recovery=complete||reviewPending?materialRecoveryHTML(f,v.workflow):'';
  const published=v.workflow.publication?.status==='published'&&v.workflow.publication.document_version_id===v.source.version?.id;
  const quality=!processing&&published?publishedMaterialQuality(v.workflow):null;
  const counts=v.workflow.publication;
  const knownCounts=[counts?.entity_count,counts?.relation_count].every(value=>Number.isSafeInteger(value)&&value>=0);
  const qualityCard=quality?`<div class="mw-import-complete"><div><h3>知识已发布</h3>
    ${knownCounts?`<p>可查询 ${counts.entity_count} 个实体、${counts.relation_count} 条关系。</p>`:''}
    <p>${quality.excluded_candidate_count?`${quality.excluded_candidate_count} 个候选未通过核验。`:''}${quality.coverage_unconfirmed?'抽取可能有遗漏。':''}可对照原文核对和补充。</p></div>
    <div class="mw-import-actions"><button class="btn btn-primary" data-cv="import-review" ${processingOff?'disabled':''}>核对已发布知识</button>
    ${complete?`<button class="btn btn-secondary" data-cv="import-auto" ${processingOff||!automaticAllowed?'disabled':''}>重新抽取</button>`:''}</div></div>`:'';
  const updatingIndex=published&&['building','queued'].includes(index);
  const reason=automaticReview&&v.workflow.extraction_review?.message;
  const reviewCard=`<div class="mw-import-complete"><div><h3>${processing?'材料正在处理中':esc(materialWorkflowLabel(v.workflow)||'抽取结果待核对')}</h3><p>${processing?'请等待当前任务完成后继续核对。':automaticReview?`${published?'原有发布结果仍然有效。':''}本轮自动抽取结果需要人工核对。查看候选并选择加入草稿，保存、核对后确认发布。`:changed===true?`草稿存在实际待发布变更，请核对后确认发布。${published?'原有发布结果仍然有效。':''}`:published?changed===false?'当前已发布结果仍然有效。核对草稿没有实际变更，无需重复抽取或发布。':'当前已发布结果仍然有效。已有核对草稿，是否存在待发布变更请打开核对确认。':draft?'打开草稿核对当前结果；只有实际变更才需要确认发布。':'已有抽取结果可继续核对。'}</p>${reason?`<p>未自动发布原因：${esc(reason)}</p>`:''}</div><div class="mw-import-actions"><button class="btn btn-primary" data-cv="import-review" ${processingOff?'disabled':''}>${automaticReview?'查看抽取候选':draft?'继续核对草稿':'继续核对抽取结果'}</button><button class="btn btn-secondary" data-cv="import-auto-switch" ${processingOff||!complete||!automaticAllowed?'disabled':''}>${published?'重新抽取':'自动抽取'}</button></div></div>`;
  const failed=['failed','cancelled'].includes(v.workflow.document.status);
  const operation=currentImportOperation(f,v),stage=operation?.current.stage;
  const noCandidates=materialAutomaticNoCandidates(operation?.current);
  const waitingIndex=operation?.receipt.waits_for_source_index===true&&stage==='queued'&&!complete;
  const canStart=f.importer.canProcessSource;
  const extracting=['queued','running','publishing'].includes(stage);
  const extractionDone=['publishing','awaiting_review','published'].includes(stage);
  const interrupted=['failed','cancelled','stale'].includes(stage);
  const publishedNow=materialAutomaticPublished(operation?.current);
  const chained=canStart||operation?.receipt.waits_for_source_index===true;
  const indexInterrupted=waitingIndex&&['failed','blocked','cancelled'].includes(index);
  const autoStatus=indexInterrupted?'索引未完成，等待重试':waitingIndex?'等待索引':noCandidates?'无可发布候选':({queued:'等待抽取',running:'正在抽取',publishing:'正在发布',
    awaiting_review:'待核对发布',published:publishedNow?'处理完成':'待确认',failed:'处理失败',cancelled:'已停止',stale:'已失效'}[stage]||'待开始');
  const automaticState=noCandidates?'done':publishedNow?'done':interrupted||indexInterrupted?'failed':
    extracting||stage==='awaiting_review'?'active':'waiting';
  const items=chained?[
    {title:'核对正文',hint:'确认当前正文版本',state:confirmed?'done':'active',status:reviewExempt?'无需重复确认':confirmed?'已确认':'待确认'},
    {title:'自动处理',hint:'依次建立索引、抽取和发布知识',state:automaticState,status:autoStatus},
  ]:operation&&!waitingIndex?[
    {title:'正文与索引',hint:'沿用当前正文版本',state:complete?'done':'waiting',status:complete?'已就绪':'待确认'},
    {title:interrupted?'本轮知识处理':'抽取知识',hint:interrupted?'查看处理记录与恢复操作':'按当前规则抽取',state:extractionDone?'done':interrupted?'failed':extracting?'active':'waiting',status:extractionDone?'已完成':({queued:'排队中',running:'进行中',failed:'处理失败',cancelled:'已停止',stale:'已失效'}[stage]||'待确认')},
    {title:stage==='awaiting_review'&&!noCandidates?'核对并发布':'发布知识',hint:noCandidates?'本轮没有可发布候选':stage==='awaiting_review'?'核对结果后确认发布':'以本轮发布回执为准',state:publishedNow?'done':!noCandidates&&['publishing','awaiting_review'].includes(stage)?'active':'waiting',status:publishedNow?'已发布':noCandidates?'无候选':({publishing:'进行中',awaiting_review:'待核对',published:'待确认'}[stage]||'未开始')},
  ]:[
    {title:'解析材料',hint:'识别文本与结构',state:ready?'done':failed?'failed':'active',status:ready?'已完成':failed?'未完成':'进行中'},
    {title:'核对正文',hint:reviewExempt?'沿用当前正文版本':'检查并确认内容',state:confirmed?'done':ready?'active':'waiting',status:reviewExempt?'无需重复确认':confirmed?'已完成':ready?'待确认':'待处理'},
    {title:updatingIndex?'更新检索索引':'建立索引',hint:updatingIndex?'同步材料变更':'生成检索引用',state:index==='ready'?'done':['building','queued'].includes(index)?'active':['failed','blocked','cancelled'].includes(index)?'failed':'waiting',status:{ready:'已完成',building:'进行中',queued:'排队中',failed:'失败',blocked:'受阻',cancelled:'已停止',stale:'待更新',unconfigured:'待配置',not_started:'未开始'}[index]||'待就绪'},
  ];
  const indexText={ready:'当前正文索引已就绪',building:'服务端正在建立索引',queued:'索引任务正在排队',pending:'等待当前正文索引就绪',unknown:'暂未确认当前正文的索引状态',unconfigured:'服务端尚未配置向量模型，无法完成索引',not_started:'索引任务尚未启动',failed:'索引建立失败',blocked:'索引建立受阻',cancelled:'索引任务已停止',stale:'索引需要更新'}[index];
  const indexStatusText=updatingIndex?index==='queued'?'检索索引更新任务正在排队':'星图检索索引正在更新':indexText;
  const progress=preparation?.indexing,known=Number.isSafeInteger(progress?.total_units)&&progress.total_units>0&&Number.isSafeInteger(progress.completed_units)&&progress.completed_units>=0;
  const indexProgress=['building','queued'].includes(index)?`<progress aria-label="索引建立进度" ${known?`max="${progress.total_units}" value="${Math.min(progress.completed_units,progress.total_units)}"`:''}></progress>${known?`<small>已完成 ${progress.completed_units} / ${progress.total_units} 单元</small>`:''}`:'';
  const retry=confirmed&&progress?.retryable?`<button class="btn btn-secondary" data-cv="import-index-retry" ${off?'disabled':''}>重试建立索引</button>`:'';
  const heading=operation?.receipt.waits_for_source_index?'本次材料处理':operation?'本次自动抽取流程':'材料处理流程';
  const extraction=published||publishedNow||extractionDone||reviewPending?'已完成':
    stage==='failed'?'处理失败':extracting&&!waitingIndex?'抽取中':'未开始';
  const publication=noCandidates?(published?'保留已有知识':'无可发布候选'):published||publishedNow?'已发布':reviewPending||stage==='awaiting_review'?'待核对发布':
    stage==='publishing'?'正在发布':'未发布';
  const status = (title, detail, action='') =>
    `<div class="mw-reader-next"><div><strong>${title}</strong><p>${detail}</p></div>${action}</div>`;
  const button = (command, label, disabled=off) =>
    `<button class="btn btn-primary" data-cv="${command}" ${disabled?'disabled':''}>${label}</button>`;
  let next = '';
  if (waitingIndex || confirmed && ['queued','building','failed','blocked','cancelled'].includes(index)) {
    next = status(indexInterrupted?'索引未完成，等待重试':indexStatusText,
      waitingIndex?'索引就绪后继续抽取知识。':updatingIndex?'已有发布知识保留，本次不会重新抽取当前材料。':'可以继续阅读正文。', retry);
  } else if (f.agent.record.preview && (!reviewPending || complete)) {
    next = `<div class="mw-import-confirmation">${materialAutomaticCard(f)}</div>`;
  } else if (extracting) {
    next = `<div class="mw-import-task-progress" role="status">${materialAutomaticCard(f)}</div>`;
  } else if (recovery) {
    next = recovery;
  } else if (noCandidates) {
    next = materialAutomaticCard(f);
  } else if (reviewPending) {
    next = status('待核对知识','在右侧对照正文核对抽取结果。');
  } else if (canStart) {
    next = status(confirmed?'正文已确认':'待核对正文',
      '确认后建立索引，并按当前规则抽取知识。',
      button('import-process-source',confirmed?'开始自动处理':'确认正文并处理'));
  } else if (processing) {
    next = status('材料正在处理中','可继续阅读正文，并在处理记录查看进度。');
  } else if (quality) {
    next = qualityCard;
  } else if (!ready) {
    next = status(failed?'材料解析未完成':'正在解析材料',failed?'可在处理任务中查看原因和恢复操作。':'解析完成后将显示正文。',
      failed?`<button class="btn btn-secondary" data-warehouse-id="${esc(f.warehouseId)}" data-warehouse-view="tasks">查看处理任务</button>`:'');
  } else if (!confirmed) {
    next = status('待核对正文','请核对解析后的文字。',
      button('import-confirm',preparation?'确认正文并建立索引':'确认正文'));
  } else if (!complete) {
    next = status(indexStatusText,'可以继续阅读正文。',retry);
  } else if (!published) {
    next = status('正文与索引已就绪','可以按当前规则抽取知识。',
      button('import-auto','自动抽取',processingOff||!automaticAllowed));
  }
  return `<section class="mw-import-process" aria-label="材料处理流程">
    ${next}
    <details class="mw-reader-progress" data-cv-disclosure="reader-progress-quiet">
      <summary>处理记录</summary>
      <header><strong>${heading}</strong><span>${Number.isSafeInteger(v.source.version?.version_number)?`正文 v${v.source.version.version_number}`:'以最近读取的服务端状态为准'}</span></header>
      <ol class="mw-import-steps">${items.map((item,n)=>`<li class="is-${item.state}" ${item.state==='active'?'aria-current="step"':''}><span class="mw-step-number" aria-hidden="true">${item.state==='done'?'✓':n+1}</span><div><strong>${item.title}</strong><small>${item.hint}</small></div><span class="mw-step-status">${item.status}</span></li>`).join('')}</ol>
      ${indexProgress}
      <dl class="mw-import-status"><div><dt>建立索引</dt><dd>${indexStatusText}</dd></div><div><dt>抽取知识</dt><dd>${extraction}</dd></div><div><dt>发布知识</dt><dd>${publication}</dd></div></dl>
      <p class="mw-import-limit">${progress?.error?esc(progress.error.detail||progress.error.code):''}${!automaticAllowed&&v.workflow.actions?.prepare_automatic?.reason?esc(v.workflow.actions.prepare_automatic.reason):''}</p>
      ${reviewPending&&!recovery?reviewCard:''}
      ${materialAnnotationHTML(v.source)}
      <button class="text-link mw-reader-task-link" data-warehouse-id="${esc(f.warehouseId)}" data-warehouse-view="tasks">查看处理任务与用量</button>
    </details>
  </section>`;
}
function sourceEditable(v){
  const total=v?.source.document.segment_count;
  return !!(v?.source.version?.id&&v.workflow.document.status==='ready'&&Number.isSafeInteger(total)&&total>0);
}
function sourceEditToolbar(edit){
  return `<div class="mw-source-edit-toolbar"><div class="mw-source-heading"><h3>材料正文</h3><div class="mw-import-actions">
    <button type="button" class="btn btn-secondary" data-cv="import-source-cancel" ${edit.saving?'disabled':''}>${edit.write&&!edit.saving?'关闭编辑':'取消编辑'}</button>
    <button type="button" class="btn btn-primary" data-cv="import-source-save" ${!edit.segments||!edit.edits.size||edit.saving||edit.stale?'disabled':''}>${edit.saving?'保存中…':edit.write?'重试保存':'保存新版本'}</button>
    </div></div><p>保存后生成新的星图正文版本${starxiaotuTermMarker('source-version')}，原文件保持不变。</p>
    ${edit.error?`<p class="cv-error" role="alert">${esc(edit.error)}</p>`:''}</div>`;
}
function sourceEditHTML(edit){
  const {segments,offset,pageSize}=edit,locked=edit.saving||!!edit.write||edit.stale;
  const end=segments&&Math.min(offset+pageSize,segments.length);
  return `<section class="mw-import-source mw-source-edit">
    ${edit.loading?'<p role="status">正在读取完整正文…</p>':''}
    ${segments?`<div class="mw-source-segments">${segments.slice(offset,end).map((segment,index)=>{
      const ordinal=offset+index,number=ordinal+1;
      return `<article><span class="mw-segment-number">${String(number).padStart(2,'0')}</span><div>
        <textarea id="cv-source-edit-${ordinal}" aria-label="正文片段 ${number}" data-inline-source="${ordinal}" rows="3" ${locked?'readonly':''}>\n${esc(edit.edits.get(segment.id)??segment.text)}</textarea></div></article>`;
    }).join('')}</div>
    <div class="mw-source-pagination"><small>显示 ${offset+1}–${end} / ${segments.length} 个片段</small>
      <button type="button" class="btn btn-secondary" data-cv="import-source-prev" ${edit.saving||!offset?'disabled':''}>上一页</button>
      <button type="button" class="btn btn-secondary" data-cv="import-source-next" ${edit.saving||end>=segments.length?'disabled':''}>下一页</button></div>`:''}
  </section>`;
}
function readerParagraph(segment,match){
  const text=String(segment.text||'').replace(/\r\n/g,'\n');
  const tag=segment.kind==='heading'?'h3':'p';
  const quote=match?.excerpt;
  const index=typeof quote==='string'&&quote?text.indexOf(quote):-1;
  if(index>=0&&text.indexOf(quote,index+1)<0){
    return `<${tag}>${esc(text.slice(0,index))}<mark>${esc(quote)}</mark>${esc(text.slice(index+quote.length))}</${tag}>`;
  }
  const heading=text.match(/^(#{1,6}) +([^\n]+)(?:\n+([\s\S]*))?$/);
  if(!heading)return `<${tag}>${esc(text)}</${tag}>`;
  const level=Math.min(heading[1].length+2,6);
  return `<h${level}>${esc(heading[2])}</h${level}>${heading[3]?`<p>${esc(heading[3])}</p>`:''}`;
}
function importSourceHTML(v,off,importer){
  const total=v.source.document.segment_count;
  const count=Number.isSafeInteger(total)&&total>=0?`原文 ${total} 个片段${v.textWindow?'':` · 当前页 ${logicalSourceGroups(v.source.segments).length} 个阅读分组`}`:'正文片段数量待确认';
  const match=v.sourceMatch,evidence=match&&readerEvidence(v.knowledge?.items?.[match.index],v);
  const citation=v.textWindow&&v.readerCitation?.start===v.textWindow.start?v.readerCitation:null;
  return `<section class="mw-import-source mw-reader-source"><header><div class="mw-source-heading"><h3>材料正文</h3>${sourceEditable(v)?`<button type="button" class="btn btn-secondary" data-cv="import-edit-source" ${importer.sourceBlocked?'disabled':''}>编辑正文</button>`:''}</div><span>${count}</span></header>
    ${importer.sourceNotice?`<p role="status">${esc(importer.sourceNotice)}</p>`:''}
    ${v.readerHandoffNotice?`<p class="mw-reader-citation-note" role="status">${esc(v.readerHandoffNotice)}</p>`:''}
    ${v.textWindow?`<div class="mw-full-text" ${citation?`data-reader-match="citation-${citation.start}" tabindex="-1"`:''}>${citation?`<small>星图引用位置 · 正文 v${esc(v.source.version.version_number)}</small>`:''}${readerParagraph(v.textWindow,citation)}</div><div class="mw-source-pagination"><small>${v.textWindow.start}–${v.textWindow.end} / ${v.textWindow.total_chars} 字符</small><button class="btn btn-secondary" data-cv="import-text-prev" ${off||!v.textWindow.start?'disabled':''}>上一段正文</button><button class="btn btn-secondary" data-cv="import-text-next" ${off||v.textWindow.end>=v.textWindow.total_chars?'disabled':''}>下一段正文</button></div>`:
    `<div class="mw-source-segments">${logicalSourcesHTML(v.source.segments, {
      render:s=>readerParagraph(s,evidence&&s.id===match.id?evidence:null),
      attributes:s=>evidence&&s.id===match.id?`data-reader-match="${esc(match.request)}" tabindex="-1"`:'',
      suffix:s=>s.text_truncated?`<small>此长段落仅显示部分内容。</small><button class="btn btn-secondary" data-cv="import-text" ${off?'disabled':''}>读取完整正文</button>`:''
    })||'<p class="mw-source-empty">正文尚未准备好。</p>'}</div>
    ${v.offset||v.source.segments.length<total?`<div class="mw-source-pagination"><small>${v.source.segments.length?`显示 ${v.offset+1}–${v.offset+v.source.segments.length} 个片段`:''}</small><button class="btn btn-secondary" data-cv="import-prev" ${off||!v.offset?'disabled':''}>上一页</button><button class="btn btn-secondary" data-cv="import-next" ${off||!v.source.segments.length||v.offset+v.source.segments.length>=(total||0)?'disabled':''}>下一页</button></div>`:''}`}
  </section>`;
}
function readerKnowledgeHTML(f,v,target,off){
  const k=v.knowledge?.key===readerKnowledgeKey(target,v)?v.knowledge:null;
  const pending=target.kind==='review',items=k?.items||[],filter=v.knowledgeFilter||'all',limit=v.knowledgeLimit||readerBatch;
  const entities=new Map(items.filter(i=>i.kind==='entity').map(i=>[i.candidate_key,i.payload?.name]));
  const entityCount=items.filter(i=>i.kind==='entity').length;
  const visible=items.map((item,index)=>({item,index})).filter(({item})=>filter==='all'||item.kind===filter);
  const presentation=createGraphPresentation(factSchema(f));
  const renderItem=({item,index})=>{
    const p=item.payload||{},relation=item.kind==='relation',e=readerEvidence(item,v);
    const label=relation?presentation.relation(p.type):presentation.entity(p.type).label;
    const endpoint=key=>item.endpoints?.[key]?.name||entities.get(p[key])||'待核对对象';
    return `<article class="mw-knowledge-item" ${v.sourceMatch?.index===index?'data-reader-selected':''}><small>${relation?'关系':'实体'} · ${esc(label)}</small>
      <strong>${relation?`${esc(endpoint('source_candidate_key'))} <span aria-hidden="true">→</span> ${esc(endpoint('target_candidate_key'))}`:esc(p.name||'未命名实体')}</strong>
      ${e?.excerpt?`<blockquote>${esc(e.excerpt)}</blockquote>`:''}
      ${e?`<button class="mw-reader-link" data-cv="import-source-jump" data-index="${index}" ${off?'disabled':''}>定位原文 <span aria-hidden="true">↗</span></button>`:''}</article>`;
  };
  const retry='<button class="mw-reader-link" data-cv="import-knowledge-retry">重新读取</button>';
  const content=k?.status==='ready'?`${items.length?`<div class="mw-knowledge-filters" aria-label="筛选知识条目">${[['all','全部',items.length],['entity','实体',entityCount],['relation','关系',items.length-entityCount]].map(([key,label,count])=>`<button type="button" data-cv="import-knowledge-filter" data-id="${key}" aria-pressed="${filter===key}">${label} ${count}</button>`).join('')}</div>`:''}
    ${visible.slice(0,limit).map(renderItem).join('')||'<p class="mw-knowledge-note">当前没有可预览的条目。</p>'}
    ${visible.length>limit?'<button class="mw-reader-link mw-knowledge-more" data-cv="import-knowledge-more">显示更多</button>':''}`:
    !target.id?'<p class="mw-knowledge-note">打开核对，查看这份资料的草稿和待核对条目。</p>':
    k?.status==='error'?`<p class="mw-knowledge-note" role="status">知识条目暂时无法读取。</p>${retry}`:'<p class="mw-knowledge-note" role="status">正在读取知识条目…</p>';
  return `<aside class="mw-reader-knowledge" aria-label="知识栏"><header><div><h3>${pending?'抽取结果':'已发布知识'}${starxiaotuTermMarker(pending?'candidate':'published-knowledge')}</h3>
    <span class="mw-reader-state ${pending?'is-pending':'is-published'}">${pending?'待核对':'已发布'}</span></div>
    ${pending?`<button class="btn btn-primary" data-cv="import-review" ${off||materialProcessingActive(f,v.workflow)?'disabled':''}>开始核对</button>`:
    '<button class="mw-reader-link" aria-label="关闭知识栏" data-cv="import-knowledge">关闭</button>'}</header>
    <div class="mw-knowledge-content">${v.sourceNotice?`<p class="mw-knowledge-note" role="status">${esc(v.sourceNotice)}</p>`:''}${content}</div></aside>`;
}
function ontologySuggestionHTML(status,off){
  if(!status||status.handled)return '';
  if(['queued','running'].includes(status.status))return '<span class="mw-reader-state" role="status">正在构建本体建议</span>';
  if(status.status==='failed')return `<span class="mw-reader-state" role="status">本体建议生成失败</span>${
    status.can_retry===true? `<button class="btn btn-secondary" data-cv="import-retry-ontology-suggestions" ${off?'disabled':''}>重新生成本体建议</button>` : ''}`;
  if(status.status==='completed'&&Number.isSafeInteger(status.count)&&status.count>0){
    return `<button class="btn btn-secondary" data-cv="import-ontology-suggestions" ${off?'disabled':''}>核对本体建议（${status.count}）</button>`;
  }
  return '';
}

export function materialImportHTML(f,welcome){
  const v=f.importer?.view,off=f.state.busy||f.importer?.blocked,edit=f.importer.sourceEdit;
  const current=v&&currentImportOperation(f,v);
  const result=!current||f.agent.record.preview||materialReviewPending(f,v.workflow)||
    ['queued','running','publishing'].includes(current.current.stage)?'':materialAutomaticCard(f);
  const resultHTML=result&&materialAutomaticPublished(current.current)
    ? `<details class="mw-published-results" data-cv-disclosure="published-${esc(current.receipt.transition_id)}">
        <summary>查看本次发布的知识</summary>${result}</details>`
    : result;
  const refreshed=f.importer.lastRefresh;
  const feedback=f.importer.refreshing?'正在读取材料最新进度…':refreshed?.documentId===v?.documentId&&refreshed?`已读取最新进度（${new Date(refreshed.at).toLocaleTimeString('zh-CN')}）。` : '';
  const loadFailed = !f.state.loaded && !f.state.busy && !!f.state.error;
  const errors = !loadFailed && f.state.error ? `<p class="cv-error" role="alert">${esc(f.state.error)}</p>` : '';
  const canResumeIntake = f.saved.intakeSubmission&&!(f.readerOnly&&f.saved.intakeSubmission.newRound);
  const pendingWork = f.saved.pending || f.saved.upload || f.saved.intakeSubmission || f.saved.roundOpening;
  const emptyTitle = loadFailed ? '资料详情' : f.state.importDocumentId ? '正在读取选中的资料' : '选择资料';
  const emptyReview = loadFailed
    ? `<div class="material-load-failure" role="alert"><strong>资料库读取失败</strong>
      <p>${esc(f.state.error)}</p>${pendingWork?'':'<button class="btn btn-secondary" data-action="reload-materials">重新读取资料库</button>'}</div>`
    : f.state.importDocumentId ? '<p role="status">当前材料尚未读取成功，请从材料列表重新选择当前材料，或选择其他材料。</p>'
    : f.state.loaded && !pendingWork ? welcome : '<p role="status">正在读取材料或提交导入…</p>';
  const target=edit?null:readerKnowledgeTarget(f,v),pending=target?.kind==='review';
  const name=v?.workflow.document.original_name||emptyTitle;
  const published=publishedMaterial(v?.workflow);
  const version=v?.source.version?.version_number;
  const operation=current,active=['queued','running','publishing'].includes(operation?.current.stage);
  const processAttention=!!(v&&(!f.importer.complete||pending||f.agent.record.preview||active||['failed','cancelled'].includes(operation?.current.stage)));
  return `<div class="material-workspace mw-import-layout ${target?'mw-has-knowledge':''}"><aside class="mw-library" aria-label="材料列表">${materialListHTML(f,true)}</aside><section class="mw-review mw-reader" aria-label="阅读台">
    <header class="mw-reader-heading"><div class="mw-reader-file"><div class="mw-reader-location"><span>阅读台</span>${Number.isSafeInteger(version)?`<span>正文 v${version}</span>`:''}${published?`<span class="mw-reader-state is-published">知识已入图</span>`:''}</div><h2 title="${esc(name)}">${esc(name)}</h2></div>
    <div class="mw-reader-tools">${!edit&&v?ontologySuggestionHTML(v.ontologySuggestion,off):''}${!pending&&published?`<button class="btn btn-secondary" id="cv-reader-knowledge" data-cv="import-knowledge" aria-pressed="${!!target}" ${off?'disabled':''}>知识</button>`:''}
    <details class="mw-reader-menu"><summary aria-label="资料操作" title="资料操作">···</summary><div>
    ${published&&!pending&&!processAttention&&f.importer.complete?`<button data-cv="import-auto" ${off||materialProcessingActive(f,v.workflow)||v.workflow.actions?.prepare_automatic?.allowed!==true?'disabled':''}>重新抽取</button>`:''}
    ${f.readerOnly&&v?.workflow.conversations?.length?`<button data-cv="round-history" ${off?'disabled':''}>查看历史记录</button>`:''}
    ${v?`<button class="mw-reader-delete" data-cv="material-delete" ${off?'disabled':''}>删除材料</button>`:''}</div></details></div></header>
    ${edit?sourceEditToolbar(edit):''}<div class="mw-review-content">
    ${edit?sourceEditHTML(edit):`${feedback?`<p class="mw-refresh-feedback" role="status">${esc(feedback)}</p>`:''}${errors}${f.state.deletionNotice?`<p role="status">${esc(f.state.deletionNotice)}</p>`:''}${f.saved.pending?'<p>上次操作结果尚未确认。</p><button class="btn btn-secondary" data-cv="retry-pending">恢复原请求</button>':''}${f.saved.upload&&!f.saved.pending?
      f.saved.upload.replacementError?'<p>请取消这次上传，再选择可打开的文件。</p><button class="btn btn-secondary" data-cv="abandon-upload">取消未完成上传</button>'
      :'<p>材料上传尚未完成。</p><button class="btn btn-secondary" data-cv="resume-upload">继续上传</button>':''}${canResumeIntake&&!f.saved.pending?'<p>材料导入尚未完成。</p><button class="btn btn-secondary" data-cv="import-resume">继续导入</button>':''}
    ${v&&f.state.dialogueExitNotice?.documentId===v.documentId?`<p class="cv-notice" role="status">${esc(f.state.dialogueExitNotice.message)}</p>`:''}${materialRoundsHTML(f)}
    ${v?`${importStepsHTML(f,v,off)}${resultHTML}${importSourceHTML(v,off,f.importer)}`:emptyReview}`}
  </div></section>${target?readerKnowledgeHTML(f,v,target,off):''}</div>`;
}
