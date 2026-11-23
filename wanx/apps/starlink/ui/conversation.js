import {starxiaotuWorkflowHeader} from './starxiaotu.mjs';
import {ontologyGraphHTML,ontologyDefinitionsHTML} from './onboarding-ontology-view.mjs';
import {currentRuleReview} from './onboarding-state.mjs';
import {unresolvedQuestions,savedReviewQuestions} from './onboarding-notes.mjs';
import {conversationThread,conversationGoal,mergeHTML} from './conversation-view.mjs';
import {materialStatusHTML,ontologyStage,knowledgeStage} from './conversation-stages.mjs';
import {materialRoundsHTML,materialRoundHistoryButton} from './material-rounds.mjs';
import {changesPanel,proposalPanel} from './conversation-changes-view.mjs';
import {latestChange,nextConversationStep} from './conversation-next.mjs';
import {intakeCard} from './conversation-intake.mjs';
import {materialListHTML,materialLibraryHTML} from './material-workspace.mjs';
import {canDeleteMaterial} from './material-deletion.mjs';
import {stoppedMaterialCard} from './material-continuation.mjs';
import {materialAgentTools,materialAutomaticCard,materialAgentFeedback,currentDraftClaim} from './material-agent.mjs';
import {materialImportHTML} from './material-import.mjs';
import {materialResultContext} from './material-state.mjs';
import {ruleStageHint} from './material-rule-guidance.mjs';
import {instructionPanel} from './material-instructions-view.mjs';
import {evidencePickerHTML} from './material-evidence-view.mjs';
import {hasChangeConflicts,changeConflictNotice} from './material-change-conflicts.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Use warehouse-owned server receipts, rather than a single browser-wide onboarding draft.
export async function readConversationOnboarding({call,warehouseId,isCurrent,storage,identity}) {
  const check=()=>{if(!isCurrent())throw new Error('WAREHOUSE_CHANGED');};
  check();
  const context=await call('onboarding-context',{warehouseId});check();
  if(!context || typeof context!=='object')throw new Error('SEMANTICA_INVALID_RESPONSE');
  const proposal=context.proposal?.id
    ? await call('onboarding-suggestion',{warehouseId,suggestionId:context.proposal.id}) : null;
  check();
  if(context.proposal?.id && proposal?.id!==context.proposal.id)throw new Error('SEMANTICA_INVALID_RESPONSE');
  const review=currentRuleReview(context,proposal),publication=review?.publication||null;
  const questions=unresolvedQuestions(context,proposal,publication,
    publication?savedReviewQuestions(storage,identity,warehouseId,review.proposal_id):[]);
  return {proposal,publication,questions,answers:context.answers||{},ontologyName:context.ontology_name||''};
}

function welcomeHTML(flow){
  const s=flow?.state,o=s?.ontology,schema=o?.schema;
  const graph=s?.ontologyError?'<p role="status">当前本体读取失败，请点击顶部“读取进度”重试。</p>':!s?.loaded?'<p role="status">正在读取当前星图的本体…</p>':!o?'<p>当前星图尚无已发布本体。</p>':!schema?.entity_types?.length?'<p>当前本体尚未定义实体类型。</p>':ontologyGraphHTML(schema,[],'mw-current',{label:'当前星图的整理规则'});
  return `<section class="mw-welcome"><h2>当前星图的整理规则</h2>${o?`<div class="mw-ontology-meta"><span>${esc(o.name)}${Number.isSafeInteger(o.version_number)?` · v${o.version_number}`:''} · 当前生效</span><span>${schema?.entity_types?.length??0} 个实体类型 · ${schema?.relation_types?.length??0} 个关系类型</span></div>`:''}<div class="mw-ontology-layout"><div class="mw-ontology-graph">${graph}</div>
    ${schema?.entity_types?.length?`<aside class="mw-ontology-definitions" aria-label="本体类型、关系与属性列表">${ontologyDefinitionsHTML(schema,'mw-current')}</aside>`:''}</div>
    </section>`;
}

// Action cards belong to the conversation; the sidebar only summarizes server state.
function conversationActions(flow) {
  if(!flow)return '';
  if(flow.instructions?.open&&!flow.changes.record.pending)return `<div class="cv-conversation-actions" data-next-step="instruction">${instructionPanel(flow)}</div>`;
  if(flow.state.reviewingSource)return intakeCard(flow);
  const automatic=materialAutomaticCard(flow);if(automatic)return automatic;
  const stopped=stoppedMaterialCard(flow);if(stopped)return stopped;
  const intake=intakeCard(flow);if(intake)return intake;
  if(flow.intake.goalStage&&(['goal','reading'].includes(nextConversationStep(flow))||flow.state.inspectCard==='goal')){
    const s=flow.state,r=flow.intake.record,d=s.detail;
    const working=['queued','running','generating'].includes(s.turn?.status);
    const confirmed=!!d?.goal?.goal&&!s.goalDirty&&!r.goalNeedsConfirmation&&s.inspectCard!=='goal';
    const body=flow.saved.pending?'<p>本轮请求结果尚未确认，请通过上方入口恢复原请求。</p>':working?'<progress aria-label="正在明确整理目标"></progress><p role="status">正在初步阅读材料、整理本轮答复，完成后展示目标建议与必要追问。</p>':confirmed?`<p role="status">整理目标已由服务端确认保存，尚未开始抽取。</p><h3>${esc(d.goal.goal)}</h3><p>${esc(d.goal.instructions||'未设置其他关注或排除内容')}</p><button type="button" class="btn btn-secondary" data-cv="intake-edit-goal">调整整理目标</button>`:conversationGoal(flow);
    return `<div class="cv-conversation-actions cv-goal-preparation" data-next-step="goal"><article class="cv-message cv-assistant cv-action-message"><header><strong>资料整理</strong><span>第 2 步 · 明确整理目标</span></header><div class="cv-action-body">${r.usingOriginal?'<p>本轮依据服务端原文；本机正文修改尚未应用。</p>':''}${!r.goalTurnId&&!flow.saved.pending&&!working?'<button type="button" class="btn btn-secondary" data-cv="intake-start-goal">初读材料，建议整理目标</button>':''}${body}</div></article></div>`;
  }
  const s=flow.state,d=s.detail,next=nextConversationStep(flow),staleDraft=!flow.changes.independent&&flow.changes.state.summary?.status==='editing'&&!!flow.changes.state.summary.stale_reason;
  const step=['recovery','extracting','parsing','reading','receipt','merge','discarded','proposal','rules-ready'].includes(next)?next:staleDraft?'draft':s.inspectCard||next;
  const titles={goal:'目标卡片',plan:'抽取计划',rules:'规则修改预览',draft:'核对材料草稿',publication:'发布草稿',receipt:'发布回执',published:'发布回执',candidates:'核对抽取结果',extracting:'抽取进度',parsing:'正在解析材料',stopped:'材料处理已暂停',recovery:'恢复当前操作'};
  titles.plan='第 4 步 · 核对计划，初步抽取';titles.extracting='第 4 步 · 初步抽取';titles.candidates='第 5 步 · 查看初步结果';
  titles.merge='第 7 步 · 核对并保存初始草稿';titles.draft='第 6 步 · 对话修改';
  titles.discarded='草稿已放弃';titles['rules-ready']='本体已发布';
  const hints={goal:'根据材料和对话明确本次目标。你可以直接修改，也可以在下方告诉我需要怎样调整。',plan:'目标已确认。核对当前材料和适用规则后，再明确开始抽取。',rules:'修改已写入规则草稿。可以继续通过对话调整，确认发布后才会用于抽取。',draft:'先核对事实及原文。选中需要修改的事实，在下方描述修改要求。',publication:'请核对本次完整变更。确认后提交发布，收到生效回执才算完成。',receipt:'发布请求已提交，以下状态以服务端回执为准。',published:'已读取当前生效知识，可以继续提问或另行修改。'};
  let body='';
  if(flow.changes.state.summary?.status==='editing'&&flow.changes.state.summary.stale_reason){
    titles.draft='核对草稿版本变化';hints.draft='原草稿已保留。请先处理下方版本变化，再继续修改和整份核对。';
  }
  titles.reading='初步阅读';
  if(step==='goal')body=conversationGoal(flow);
  else if(step==='merge')body=mergeHTML(flow);
  else if(step==='plan')body=`<div id="cv-inline-rules">${ontologyStage(flow)}</div>`;
  else if(step==='proposal'){
    titles.proposal='核对本轮修改';
    body=proposalPanel(flow)+changesPanel(flow,'proposal-context');
    if(!flow.changes.state.summary&&!flow.changes.record.draftId&&!d?.review?.draft_id&&d?.execution)body+=knowledgeStage(flow);
  }
  else if(['rules','rules-ready','draft','publication','receipt','discarded'].includes(step))body=changesPanel(flow,step);
  else if(['candidates','extracting','published'].includes(step))body=`<div id="cv-inline-knowledge">${knowledgeStage(flow)}</div>`;
  else if(step==='recovery')body=flow.changes.record.pending||flow.changes.claimRequest?changesPanel(flow,'recovery'):'<p>上次请求结果尚未确认，请使用上方的恢复入口继续原请求。</p>';
  else if(step==='parsing')body='<p role="status">正文正在准备。解析完成后先初步阅读，再确定目标；尚未开始正式抽取。</p>';
  else if(step==='reading')body='<p role="status">正在阅读材料并整理本轮回复，完成后再展示建议和下一步操作。</p>';
  else if(step==='stopped')body='<p>当前处理已停止或来源已变化，请选择可用材料后继续。</p>';
  if(!body)return '';
  if(flow.intake.record?.usingOriginal)body='<p>本轮依据服务端原文；本机正文修改尚未应用。</p>'+body;
  return `<div class="cv-conversation-actions" data-next-step="${esc(step)}" aria-label="当前材料操作卡片"><article class="cv-message cv-assistant cv-action-message"><header><span class="cv-assistant-icon" aria-hidden="true">✧</span><strong>资料整理</strong><span>${esc(s.intents.find(i=>i.id===d?.id)?.original_name||'当前会话')}</span></header>${hints[step]?`<p class="cv-action-intro">${hints[step]}</p>`:''}<div class="cv-action-body"><div class="cv-card-heading"><strong>${titles[step]||'当前操作'}</strong><small>${['extracting','parsing','reading','receipt'].includes(step)?'处理中':step==='published'?'已生效':'待核对'}</small></div>${body}</div>${s.inspectCard&&step===s.inspectCard?'<button class="btn btn-secondary" data-cv="next-action">返回当前待办</button>':''}</article></div>`;
}

function conversationSummary(flow,currentRules) {
  const s=flow.state,d=s.detail;
  if(materialResultContext(flow))return `<section><h3>本次材料</h3><p>可以直接提问或修改已有知识，无需重新填写抽取目标。修改抽取范围或重新抽取时，另行核对目的和计划。</p>${currentRules}</section>`;
  if(flow.intake.record&&!flow.intake.sourceReviewed||flow.intake.staged||flow.saved.upload?.intake||flow.saved.intakeSubmission)return `<section><h2>材料解析与正文核对</h2><p>每次发送一份材料，可附带补充说明；正文自动加载并连续展示。</p><p>目标需明确确认。确认后保存到服务端，不自动抽取或发布。</p></section>`;
  return `<section class="cv-context-summary"><h2>工作区摘要</h2><small>当前材料</small><p>${esc(s.intents.find(i=>i.id===d?.id)?.original_name||'尚未选择材料')}</p>
    <h3>已确认的整理目标</h3><p>${esc(d?.goal?.goal||'尚未确认，请在对话中核对目标卡片。')}</p>${d?.goal?.instructions?`<p>${esc(d.goal.instructions)}</p>`:''}
    ${d?'<button class="btn btn-secondary" data-cv="stage-1">查看目标</button>':''}${currentRules}<h3>执行范围</h3><p>确认仅针对当前材料。聊天先形成建议；抽取和发布仍需在卡片中确认。</p></section>
    <section class="cv-source-summary"><h2>原文依据</h2>${flow.changes.state.source?`<p>${esc(flow.changes.state.source.text)}</p>`:d?.review?.draft_id?'<p>核对事实时点击“查看原文”，在这里查看对应材料片段。</p>':'<p>初步结果会逐项展示服务端返回的原文摘录与定位；未提供依据的候选需继续核对。</p>'}</section>`;
}

export function conversationHTML(warehouse,publication=null,onboarding=null,allowReview=true,flow=null,building=false) {
  if(flow?.readerOnly)return materialReaderHTML(warehouse,allowReview,flow);
  if(warehouse?.state==='import_failed') return '<div class="empty"><h2>这张星图尚未完成迁入</h2><p>迁入流程尚未全部完成，暂时无法读取材料与知识。星图卡片上的数量表示已写入的数据，不能表示迁入成功。</p><button class="btn btn-secondary" data-view="data">到数据管理查看失败原因</button></div>';
  if(!warehouse || warehouse.state!=='active') return '<div class="empty">请先选择一张可用的星图。</div>';
  if(allowReview&&flow?.state.materialPage==='import')return materialImportHTML(flow,welcomeHTML(flow));
  if(allowReview&&flow?.state.librarySelection)return materialLibraryHTML(flow);
  if(onboarding && !onboarding.loading && !onboarding.error)publication=onboarding.publication;
  const effective=flow?.state.ontology;
  const model=effective?.name||(flow?.state.loaded?'尚无已发布规则':'正在读取当前生效规则');
  const version=Number.isSafeInteger(effective?.version_number)?`生效版本：${effective.version_number}`:'';
  const currentRules=`<div class="cv-effective-rules"><h3>当前本体规则</h3>${effective?'<span class="conversation-status">已发布 · 当前生效</span>':''}<strong>${esc(model)}</strong>${version?`<p>${version}</p>`:''}<p>材料处理使用当前生效规则；修改后须确认发布。</p><button class="btn btn-secondary" data-cv="stage-2">查看当前本体</button></div>`;
  const answers=onboarding?.answers||{},background=[answers.industry,answers.occupation,answers.material_types,answers.purpose,answers.questions].filter(v=>typeof v==='string'&&v.trim()).join('；');
  if(!allowReview)return '<div class="empty">当前通道尚不支持材料工作台，请使用已接入的 Bridge 桌面会话。</div>';
  const name=flow?.state.intents.find(i=>i.id===flow.state.selectedIntent)?.original_name;
  const actions=conversationActions(flow);
  const proposal=latestChange(flow);
  const pendingProposal=flow?.state.detail&&!actions?`<section class="mw-proposal-status"><h3>对话修改</h3>${proposal?.status==='generating'?'<progress aria-label="正在生成修改建议"></progress><p>正在根据你的要求生成修改建议，完成后展示差异供核对。</p>':'<p>请核对本轮修改建议。可在右侧继续补充要求，或明确确认应用；应用修改不会自动发布。</p>'}</section>`:'';
  const currentStep=nextConversationStep(flow);
  const claim=currentDraftClaim(flow);
  const actionHint=hasChangeConflicts(flow?.instructions?.open?flow.instructions.step?.preview?.result:proposal?.result)?changeConflictNotice:flow?.instructions?.open?(flow.instructions.plan?.interpretation?.summary||'请核对本轮建议。确认后才保存修改，发布需另行确认。'):claim?claim.notice:flow?.changes.record.changeTarget==='rules'&&['proposal','rules','rules-ready'].includes(currentStep)?ruleStageHint(flow):currentStep==='proposal'?(proposal?.status==='needs_clarification'?'请直接回答上方问题；也可以取消本轮建议，返回材料继续核对。':proposal?.status==='generating'?'正在生成修改预览，完成后可核对并确认应用。':'请核对中间的修改差异，确认应用后再继续核对发布。'):currentStep==='draft'?'可继续修改当前材料；没有其他修改时，核对整份材料并进入发布预览。':actions?'在中间核对后继续；也可以直接提问，或发送“下一步”“重新抽取”“对话调整”。':pendingProposal?'本轮修改的答复与确认操作在上方助手消息中，差异展示在左侧工作区。':'先添加一份材料，我会引导你逐步完成整理。';
  const sourceStep=building&&['candidates','merge','draft','publication'].includes(currentStep);
  const detail=flow?.state.detail;
  const original=flow?.intake.source?.version?.id===detail?.document_version_id?flow?.intake.source:null;
  const context=flow?.changes.state.source;
  const evidence=flow?.state.candidates?.items.find(item=>item.kind==='relation'&&item.evidence?.some(e=>e.excerpt))?.evidence?.find(e=>e.excerpt);
  const source=sourceStep?`<aside class="starlink-setup-source" aria-label="原文与候选对照"><h2>原文对照</h2>
    ${context?.text?`<blockquote>${esc(context.text)}</blockquote>`:evidence?.excerpt?`<blockquote>${esc(evidence.excerpt)}</blockquote>`:
    original?`<blockquote>${esc(original.segments[0]?.text?.slice(0,1100))}</blockquote>`:'<p>点候选中的原文依据，可以核对对应的片段。</p>'}</aside>`:'';
  return `<div class="material-workspace${building?(sourceStep?' starlink-first-review':' starlink-first-material'):''}">${building?source:`<aside class="mw-library" aria-label="材料列表">${materialListHTML(flow)}</aside>`}
    <section class="mw-review" aria-label="材料核对工作区"><header><div><small>当前材料</small><h2>${esc(name||'从第一份材料开始')}</h2></div><div class="mw-material-tools">${materialRoundHistoryButton(flow)}<button class="btn btn-secondary" data-cv="refresh" ${!flow||flow.state.busy?'disabled':''}>读取进度</button>${flow?.state.detail?.document_id?`<button class="btn btn-secondary" data-cv="material-delete" ${canDeleteMaterial(flow)?'':'disabled'}>删除材料</button>`:''}</div></header>
      ${flow?.state.deletionNotice?`<p class="mw-delete-notice" role="status">${esc(flow.state.deletionNotice)}</p>`:''}
      ${materialStatusHTML(flow)}<div class="mw-review-content">${materialRoundsHTML(flow)}${materialAgentTools(flow)}${evidencePickerHTML(flow)}${actions||pendingProposal||welcomeHTML(flow)}
      ${flow?.state.detail?`<details class="mw-reference" data-cv-disclosure="material-reference"><summary>目标与适用规则</summary>${background?`<section class="cv-background"><div><small>星图目标 · 已保存</small><p>${esc(background)}</p></div></section>`:''}${conversationSummary(flow,currentRules)}</details>`:''}
      </div></section>
    <section class="conversation-thread mw-assistant" aria-label="整理资料">
      ${starxiaotuWorkflowHeader('整理资料', name || (flow?.state.busy ? '正在处理本轮请求' : ''), flow?.state.materialPage==='dialogue'?`<button class="btn btn-secondary mw-close-chat" data-cv="import-close-dialogue" ${flow.state.busy||flow.importer.blocked?'disabled':''}>返回资料</button>`:'')}
      <div data-sx-task-body>${conversationThread(flow,'',materialAgentFeedback(flow)+`<section class="mw-confirm-card"><strong>当前操作</strong><p>${actionHint}</p><div class="mw-confirm-actions"><p class="mw-no-action">处理进度和待核对内容会随服务端回执更新。</p></div></section>`)}</div>
      </section></div>`;
}

export function materialReaderHTML(warehouse,allowReview,flow){
  if(warehouse?.state==='import_failed')return conversationHTML(warehouse);
  if(warehouse?.state!=='active')return '<div class="empty">请先选择一张可用的星图。</div>';
  if(!allowReview)return '<div class="empty">当前通道尚不支持资料库。</div>';
  if(!flow)return '<p role="status">正在读取资料库…</p>';
  const hasMaterials=flow.state.warehouseMaterials?.length || flow.state.warehouseMaterialTotal>0;
  const welcome=flow.state.warehouseMaterialError?'<p role="status">资料列表暂不可读，请重新读取。</p>':hasMaterials
    ? '<p>从左侧选择一份资料，查看正文和处理进度。</p>'
    : '<section class="mw-welcome"><h3>导入第一份资料</h3><p>导入后可在这里核对正文，并用当前生效的本体整理知识。</p><button type="button" class="btn btn-primary" data-action="import">导入资料</button></section>';
  return materialImportHTML(flow,welcome);
}
