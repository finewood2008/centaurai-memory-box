import {createGraphPresentation} from './graph-presentation.mjs';
import {currentReply,messageReply,conversationError,historicalReply} from './conversation-state.mjs';
import {changeHistory} from './conversation-changes-view.mjs';
import {knowledgeCurrent,publicationCurrent} from './conversation-progress.mjs';
import {currentCandidateGraph,candidateNetworkHTML} from './conversation-candidate-graph.mjs';
import {visibleMaterialIntents} from './material-continuation.mjs';
import {goalDialogueText} from './material-goal-dialogue.mjs';
import {nextConversationStep} from './conversation-next.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(action,label,off=false,id='')=>`<button type="button" class="btn btn-secondary" data-cv="${action}" ${id?`data-id="${esc(id)}"`:''} ${off?'disabled':''}>${label}</button>`;
const statuses={active:'进行中',archived:'已归档',awaiting_upload:'等待上传',parsing:'正在解析',awaiting_goal:'待确认目标',ready_for_confirmation:'待确认抽取计划',queued:'已入队',running:'处理中',awaiting_review:'抽取完成，待核对',failed:'处理失败',cancelled:'已停止',stale:'来源已变化',published:'已发布',submitted:'发布处理中',succeeded:'已完成'};
const status=v=>statuses[v]||v||'尚未处理';
export function materialReplySuggestions(flow){
  if(!flow?.intake.goalStage||nextConversationStep(flow)!=='goal'||flow.state.busy||flow.saved.pending||flow.state.messageMode==='question')return [];
  const reply=currentReply(flow.state.turn,flow.state.overview);
  const goal=flow.intake.record?.goalTurnId===flow.state.turn?.id?reply?.goal_summary?.trim():'';
  return goal?[goal]:['我希望整理材料中的主要对象和关系','重点关注……，不需要抽取……'];
}
function materialReplySuggestionsHTML(flow){
  if(flow.state.materialPage!=='dialogue')return '';
  const suggestions=materialReplySuggestions(flow);if(!suggestions.length)return '';
  return `<section class="mw-reply-suggestions" aria-label="回答建议"><small>可以这样回答 · 点击填入，修改后发送</small>${suggestions.map((text,index)=>`<button type="button" data-cv="reply-suggestion" data-id="${index}"><span>${esc(text)}</span><span aria-hidden="true">›</span></button>`).join('')}</section>`;
}
export function editorRecoveryHTML(flow){return `${flow.reviewPending?`<div class="cv-notice">候选合并结果尚未确认，恢复时保留原操作号和合并内容。${button('merge','恢复原合并请求',flow.state.busy)}</div>`:''}
  ${flow.claimPending?`<div class="cv-notice">草稿认领结果尚未确认。${button('claim-review','恢复原认领请求',flow.state.busy)}</div>`:''}`;}
export function conversationTime(value,full=false){
  if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  return new Intl.DateTimeFormat('zh-CN',full?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}:{hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
function replyHTML(reply){return `<p>${esc(reply.answer)}</p>${reply.questions?.length?`<ol>${reply.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ol>`:''}
  ${reply.coverage?.length?`<div class="cv-reading-coverage"><strong>初步阅读，尚未正式抽取</strong>${reply.coverage.map(c=>`<p>${c.partial?'仅覆盖部分片段，不能视为通读全文。':'已读取本轮提供的片段。'} 已读 ${esc(c.read_segments??c.sampled_segments??'—')} / ${esc(c.total_segments??'—')} 段。</p>`).join('')}</div>`:''}`;}
function historyHTML(message){
  if(!historicalReply(message))return '';
  const reason={goal_changed:'整理目标已变化',purpose_changed:'知识仓用途已变化',ontology_changed:'本体规则已变化',scope_changed:'整理范围已变化',newer_input:'已有后续输入',retried:'本轮已有重试'}[message.invalid_reason];
  return `<p class="cv-history-notice">基于旧上下文，仅供参考${reason?' · '+reason:''}</p>`;
}
export function conversationTimeline(flow){
  // Sequence is authoritative even when timestamps are equal or out of order.
  const messages=[...flow.state.messages].sort((a,b)=>Number.isSafeInteger(a.sequence)&&Number.isSafeInteger(b.sequence)?a.sequence-b.sequence:0);
  const entries=messages.map(value=>({kind:'message',value}));
  const proposals=[...(flow.changes?.state.proposals||[])].reverse().sort((a,b)=>(Date.parse(a.created_at)||0)-(Date.parse(b.created_at)||0));
  for(const value of proposals){
    const at=entries.findIndex(e=>Date.parse(e.value.created_at)>Date.parse(value.created_at));
    entries.splice(at<0?entries.length:at,0,{kind:'proposal',value});
  }
  return entries.map(({kind,value:m})=>kind==='proposal'?changeHistory(flow,[m],false,false):`<article class="cv-message ${m.role==='user'?'cv-user':'cv-assistant'}"><header>${m.role==='user'?'':'<span class="cv-assistant-icon" aria-hidden="true">✧</span>'}<strong>${m.role==='user'?'你':'整理助手'}</strong><time>${esc(conversationTime(m.created_at))}</time></header><div class="cv-message-body">${m.role==='user'?`<p>${esc(goalDialogueText(m.content))}</p>`:historyHTML(m)+replyHTML(messageReply(m))}</div></article>`).join('')+(flow.changes?.state.more?button('change-more','更早的修改提案',flow.state.busy):'');
}
export function conversationThread(flow,background='',actions=''){
  if(!flow)return '<div class="conversation-empty"><p role="status">正在准备会话…</p></div>';
  const s=flow.state,pending=flow.saved.pending,blocked=s.busy||!s.loaded||!!pending||!!flow.saved.roundOpening||!!flow.reviewPending||!!flow.claimPending||!!flow.releasePending||!!flow.changes?.record.pending,turn=s.turn;
  const running=['queued','running','generating'].includes(turn?.status),reply=currentReply(turn,s.overview);
  const material=s.detail,materials=visibleMaterialIntents(flow,s.intents);
  const editingPrompt=s.composerContext==='facts'?'说明如何修正或排除选中事实，并指出原文依据…':s.composerContext==='rules'?'例如：将采购方与供应方合并为当事人，调整定义或属性…':s.composerContext==='goal'?'说明新的整理目标、关注点和不需要抽取的内容…':material?.execution||flow.changes.record.draftId?'提出修改要求或阅读问题；修正事实前请先选中对应条目…':'选择一份材料，可补充说明，点击发送后开始解析…';
  const intake=flow.intake.record&&!flow.intake.sourceReviewed||flow.intake.staged||flow.saved.upload?.intake||flow.saved.intakeSubmission;
  const unavailable=!!flow.saved.emptyMaterialWorkspace&&!flow.intake.staged||flow.intake.unavailable&&!flow.intake.staged&&!flow.saved.intakeSubmission&&!flow.agent?.record.sourceSaved&&!flow.agent?.current?.current?.is_current;
  const attachmentStatus=i=>{
    if(i.id===s.selectedIntent){
      if(knowledgeCurrent(material,s.knowledge))return '已发布并读取生效知识';
      if(publicationCurrent(material))return '已发布，待读取生效知识';
    }else if(i.publication_effective)return '服务端已发布';
    const r=flow.saved.intakeReviews?.[i.id];if(!r||!['awaiting_goal','ready_for_confirmation'].includes(i.status))return status(i.status);
    return r.stage==='goal'?(i.status==='ready_for_confirmation'&&!r.goalNeedsConfirmation?'目标已确认':'明确整理目标'):r.confirmed?'正文已核对':'待核对正文';
  };
  return `${['dialogue','import'].includes(s.materialPage)?`<div class="conversation-session mw-round-label"><span>${flow.saved.dialogueRounds?.[flow.saved.conversationId]?'本轮对话':'材料对话'}</span>${button('round-history','历史对话（只读）',s.busy)}</div>`:`<details class="conversation-session" data-cv-disclosure="session"><summary>会话管理 <span>${s.conversations.length} 个会话</span></summary><div class="conversation-toolbar"><label>会话 <select id="cv-session" ${blocked||flow.saved.upload?'disabled':''}><option value="">选择会话</option>${s.conversations.map(c=>`<option value="${esc(c.id)}" ${c.id===flow.saved.conversationId?'selected':''}>${esc(c.title||conversationTime(c.created_at,true)||'材料会话')} · ${status(c.status)}</option>`).join('')}</select></label>
    ${button('new','新对话',blocked||!!flow.saved.upload)}${button('refresh','读取进度',s.busy)}${s.hasMore?button('more','更多会话',s.busy):''}</div></details>`}
    ${s.error?`<div class="cv-error" role="alert">${esc(s.error)}</div>`:''}
    ${s.readWaiting?`<p class="cv-notice" role="status">${running?'当前问答完成后可继续读取材料。':'当前问答已结束，可点击初步阅读材料继续。'}</p>`:''}
    ${pending?`<div class="cv-notice">上次请求结果尚未确认，恢复时保留原操作号和原内容。${button('retry-pending','恢复原请求',s.busy)}</div>`:''}
    ${flow.saved.intakeSubmission&&!pending?`<div class="cv-notice">材料尚未提交完成。${button('intake-submit','继续提交材料',s.busy)}</div>`:''}
    ${flow.saved.upload&&!pending?`<div class="cv-notice">待完成附件：${esc(flow.saved.upload.name)} ${button('resume-upload','继续上传',s.busy)}${button('abandon-upload','取消未完成上传',s.busy)}</div>`:''}
    ${flow.releasePending?`<div class="cv-notice">候选已合入草稿，正在结束本页编辑会话。${button('release','恢复交接',s.busy)}</div>`:''}
    ${editorRecoveryHTML(flow)}
    <div class="conversation-messages" aria-live="polite">${background?`<section class="cv-background"><span aria-hidden="true">▧</span><div><small>建仓信息 · 已保存</small><p>${esc(background)}</p></div></section>`:''}${s.messages.length||flow.changes?.state.proposals.length?conversationTimeline(flow):
    (material?'':'<div class="conversation-empty"><span aria-hidden="true">✧</span><h2>从第一份材料开始</h2><p>上传或关联材料，再通过对话明确整理目标。</p></div>')}
    ${turn?`<div class="cv-turn" role="status">本轮问答：${historicalReply(turn)?'历史回复，仅供参考':status(turn.status)}${turn.status==='failed'?` · ${esc(conversationError({code:turn.error_code}))}`:''}
    ${running?button('turn-cancel','停止本轮回复',blocked):!unavailable&&['failed','cancelled'].includes(turn.status)?button('turn-retry','重试本轮问答',blocked):''}</div>`:''}${materialReplySuggestionsHTML(flow)}${actions}</div>
    ${s.documents.length?`<section class="cv-documents"><h3>选择当前仓的材料</h3>${s.documents.map(d=>button('link',d.original_name||d.id,blocked,d.id)).join('')}${s.documentMore?button('documents-more','更多材料',blocked):''}${button('documents-close','收起',s.busy)}</section>`:''}
    <details class="cv-materials" data-cv-disclosure="materials"><summary>${intake?'会话材料':'本次材料'} <small>${s.overview?.active_attachment_count??0}${intake?'':' / '+(s.overview?.limits?.attachments??'—')}</small><span>查看处理操作</span></summary>
    <p>${intake?'本次仅解析正文并核对。关联已有材料不会停止它原有的任务。':'新上传材料先解析；初步阅读不等于全文抽取，抽取与发布均需另行确认。关联已有材料不会停止其原有任务。'}</p>
    ${materials.map(i=>`<button type="button" class="cv-material ${i.id===s.selectedIntent?'selected':''}" data-cv="intent" data-id="${esc(i.id)}" ${blocked?'disabled':''}><strong>${esc(i.original_name||'待上传材料')}</strong><span>${attachmentStatus(i)}</span></button>`).join('')}
    ${material?`<div class="cv-material-actions">${flow.intake.record?'':button('analyze','初步阅读材料',blocked||!material.document_version_id||material.source_status!=='available'||running)}
    ${material.status==='failed'&&material.execution?button('intent-retry','重试抽取',blocked):''}
    ${!['cancelled','stale'].includes(material.status)?button('intent-cancel','停止本次处理',blocked):''}
    ${material.status==='awaiting_review'?button('candidates','查看抽取候选',blocked):''}
    ${material.review?.draft_id?button('open-review','打开材料核对草稿',blocked,material.document_id):''}</div>
    ${material.execution?`<p>抽取：${status(material.execution.status)} · ${material.execution.progress?.completed_units??0} / ${material.execution.progress?.total_units??'待确定'} 单元${material.execution.error_code?' · '+esc(conversationError({code:material.execution.error_code})):''}</p>`:''}
    ${material.outcome?.publication?`<p>知识发布：${status(material.outcome.publication.status)}${material.outcome.publication.effective?' · 当前生效':''}</p>`:''}`:''}
    </details>
    ${reply?.modification_intent&&reply.modification_intent.kind!=='none'&&flow.intake.goalStage&&flow.intake.record?.goalTurnId===turn?.id&&nextConversationStep(flow)==='goal'?'<section class="cv-notice"><p>当前仍在明确材料整理目标。可直接说明希望整理哪些内容，或发送“下一步”让助手根据已有对话整理目标摘要。</p></section>':''}
    <form id="cv-message-form" class="conversation-composer">${materials.length?`<div class="cv-attachment-strip">${materials.map(i=>`<button type="button" data-cv="intent" data-id="${esc(i.id)}" ${blocked?'disabled':''}><span aria-hidden="true">▤</span> ${esc(i.original_name||'待上传材料')} <small>${attachmentStatus(i)}</small></button>`).join('')}</div>`:''}
    ${flow.intake.staged?`<div class="cv-staged-material"><span>▤ ${esc(flow.intake.staged.name)} <small>待发送 · ${flow.intake.staged.kind==='file'?'本地文件':'已有材料'}</small></span>${button('intake-remove','移除',blocked)}</div>`:''}
    ${s.materialPage==='dialogue'&&!s.composerContext?`<div class="mw-composer-step"><span aria-hidden="true">◇</span> 当前步骤：${esc({goal:'整理目标',plan:'核对抽取计划','source-review':'核对正文',parsing:'解析材料',reading:'阅读材料',extracting:'抽取中',candidates:'核对抽取结果',draft:'对话修改',publication:'确认发布',receipt:'发布处理中',published:'已发布',proposal:'核对修改建议',rules:'发布本体','rules-ready':'核对抽取目标与计划',recovery:'恢复当前请求',stopped:'恢复材料处理'}[nextConversationStep(flow)]||'材料处理')}</div>`:''}
    ${s.composerContext?`<div class="cv-composer-context"><span>正在调整：${esc({goal:'整理目标',rules:'本体规则',facts:'选中的材料事实',proposal:'当前修改建议'}[s.composerContext]||'当前内容')}</span>${button('adjust-cancel','取消调整',blocked)}</div>`:''}
    ${s.inputNotice?`<p class="cv-input-notice" role="status">${esc(s.inputNotice)}</p>`:''}
    ${s.inputRouting==='clarify'?`<div class="conversation-toolbar" aria-label="选择修改对象">${[['rules','仓库本体规则'],['goal','本材料整理目标'],['facts','材料实体与关系']].map(([id,title])=>button('adjust',title,blocked,id)).join('')}${button('material-source','核对正文',blocked)}</div>`:''}
    <label for="cv-message" class="cv-composer-label">与材料助手对话</label><textarea id="cv-message" rows="2" ${!s.loaded||pending||unavailable?'disabled':''} placeholder="${unavailable?'请选择可用材料后继续。':flow.changes.record.changeTarget==='rules'?'描述业务含义即可，例如：专利包括申请中和已授权成果，不加属性。也可以点击“助手先建议名称与含义”。':s.composerContext?editingPrompt:'可以提问、说明抽取目的，或输入“下一步”“重新抽取”“对话调整”…'}">${esc(s.input)}</textarea>
    ${intake?'':`<details class="cv-input-options" data-cv-disclosure="input-options"><summary>发送方式：${s.messageMode==='question'?'仅提问':s.messageMode==='change'?'修改预览':'自动识别'}</summary><label class="cv-message-mode">本轮操作 <select id="cv-message-mode" ${blocked?'disabled':''}><option value="auto" ${!s.messageMode||s.messageMode==='auto'?'selected':''}>自动识别提问与调整</option><option value="question" ${s.messageMode==='question'?'selected':''}>仅阅读与问答</option><option value="change" ${s.messageMode==='change'?'selected':''}>生成修改预览</option></select></label></details>`}
    <div class="cv-composer-actions">${button('upload','＋ 选择材料',blocked||!!flow.saved.upload||!!flow.saved.intakeSubmission)}${button('documents','关联已有材料',blocked||!!flow.saved.upload||!!flow.saved.intakeSubmission)}<span>在线模型会接收对话与材料片段</span><button type="submit" class="btn btn-primary" ${blocked||running||flow.saved.upload||unavailable?'disabled':''}>↑ 发送</button></div></form>`;
}
export function conversationGoal(flow,currentRules=''){
  if(!flow)return '<section><h2>本次材料的整理目标</h2><p>正在恢复会话。</p></section>';
  const s=flow.state,d=s.detail,blocked=s.busy||!s.loaded||!!flow.saved.pending||!!flow.reviewPending||!!flow.claimPending||!!flow.releasePending||['queued','running','generating'].includes(s.turn?.status);
  const intake=flow.intake?.goalStage;
  const waiting=!!flow.intake?.record?.goalReplyPending;
  return `<section class="cv-goal-card">${d?`
    <form id="cv-goal-form">${s.goalReviewNotice?`<p role="status">${esc(s.goalReviewNotice)}</p>`:''}
    <h3>整理目标摘要${waiting&&s.goal?'（待更新）':''}</h3>
    ${s.goal?`<div class="cv-goal-summary"><p>${esc(s.goal)}</p></div>${s.instructions?`<p class="cv-goal-instructions">关注与排除范围：${esc(s.instructions)}</p>`:''}<small>${waiting?'请先完成本轮目标澄清，再确认最新摘要':s.goalDirty||!d.goal?.goal?'建议待确认，尚未开始抽取':'当前已确认目标'}</small>`:'<p role="status">请在右侧对话中说明整理目的，助手会在这里汇总目标与关注范围。</p>'}
    <p>需要调整时直接在右侧说明。核对目标摘要后，确认进入抽取计划核对。</p><div class="cv-card-actions"><button type="submit" class="btn btn-primary" ${blocked||waiting||!s.goal?.trim()||!d.document_version_id||d.source_status!=='available'||['cancelled','stale','queued','running','awaiting_review'].includes(d.status)?'disabled':''}>确认目标，进入下一步</button></div></form>
    ${!intake&&d.status==='ready_for_confirmation'?button('stage-2','核对本体与抽取计划',blocked):''}`:'<p>先上传或关联材料，再分别确认每份材料的目标。</p>'}${currentRules}</section>`;
}
export function factsHTML(items=[],context=items,schema){const presentation=createGraphPresentation(schema),type=i=>i.kind==='relation'?presentation.relation(i.payload?.type):presentation.entity(i.payload?.type).label;const names=new Map(context.filter(i=>i.kind==='entity'&&i.candidate_key).map(i=>[i.candidate_key,i.payload?.name||i.candidate_key]));return items.map(i=>`<article class="cv-fact"><h4>${esc(i.payload?.name||type(i)||i.kind)}</h4><p>${esc(i.kind==='relation'?'关系':'实体')} · ${esc(type(i))}</p>
    ${i.kind==='relation'?`<p>${esc(names.get(i.payload?.source_candidate_key)||i.payload?.source_candidate_key)} → ${esc(names.get(i.payload?.target_candidate_key)||i.payload?.target_candidate_key)}</p>`:''}
    <dl>${Object.entries(i.payload?.properties||{}).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(typeof v==='object'?JSON.stringify(v):v)}</dd>`).join('')}</dl>
    ${(i.evidence||[]).map(e=>`<blockquote>${esc(e.excerpt||'未提供原文摘录')}<small>${esc(e.locator?.page_number!=null?'第 '+e.locator.page_number+' 页':e.locator?.page!=null?'第 '+e.locator.page+' 页':e.segment_id||'原文依据')}</small></blockquote>`).join('')||'<p>未提供原文依据，需核对后补充或排除。</p>'}</article>`).join('');}
export function candidateHTML(flow){const {candidates:p,busy,detail}=flow.state;if(!p)return '';
  const network=currentCandidateGraph(flow),graph=flow.state.candidateView==='graph'&&network;
  const selected=graph&&network.selected!==null?network.items[Number(network.selected)]:null;
  return `<section class="cv-candidates"><h3>本轮抽取候选 · ${p.total??0} 项</h3><p>${detail?.review?.draft_id?'本轮候选已合入核对草稿。此处保留抽取记录，实际发布内容以核对后的完整草稿为准。':'候选尚未发布。先核对合并差异，再在完整草稿中修改、排除或复用，并核对原文依据。'}</p>
  <div class="cv-candidate-tabs" role="group" aria-label="候选结果展示方式"><button type="button" class="btn btn-secondary" data-cv="candidate-graph" aria-pressed="${!!graph}" ${busy?'disabled':''}>候选图谱</button><button type="button" class="btn btn-secondary" data-cv="candidate-list" aria-pressed="${!graph}" ${busy?'disabled':''}>候选列表</button></div>
  ${flow.state.candidateGraphLoading?'<p role="status">正在读取候选实体与关系，完成后展示图谱…</p>':''}
  ${graph?`${candidateNetworkHTML(network,flow.state.ontology?.schema)}<section class="cv-network-detail" aria-label="选中候选的属性与原文依据">${selected?`<h4>候选详情 · 未发布</h4>${factsHTML([selected],network.items,flow.state.ontology?.schema)}`:'<p>点击图中的实体或关系，在这里查看属性与原文依据。</p>'}</section>`:factsHTML(p.items,p.items,flow.state.ontology?.schema)}
  ${p.total===0?'<p>本次没有抽取到候选。可以查看本体与目标范围，再决定是否调整；这不代表材料没有信息。</p>':''}
  ${graph?'':`<p>当前显示 ${p.items.length?`${p.offset+1}–${p.offset+p.items.length}`:'0'} / ${p.total} 项</p>${button('candidates-prev','上一页',busy||!p.offset)}${button('candidates-next','下一页',busy||p.offset+p.items.length>=p.total)}`}
  ${detail?.review?.draft_id?button('open-review','继续核对已有草稿',busy,detail.document_id):`${button('begin-edit','对话修改',busy||!!flow.saved.pending)}${button('review','无问题，核对并保存草稿',busy||!!flow.saved.pending)}`}</section>`;
}
export function mergeHTML(flow){const m=flow.state.merge;if(!m)return '';const p=m.plan,off=flow.state.busy||!!flow.saved.pending;
  return `<section class="cv-merge"><h3>核对候选合入草稿的差异</h3><p>确认后保存初始草稿，并在本对话展开内容；需要修改时选中事实再发送要求。</p><p>新增 ${p.counts.add} · 复用 ${p.counts.reuse} · 暂不合入 ${p.counts.defer} · 移除 ${p.removed_count}</p>
  ${p.decisions.map(d=>`<details><summary>${esc(d.candidate?.payload?.name||d.candidate?.payload?.type||d.candidate?.kind)} · ${esc({add:'新增',reuse:'复用',defer:'暂不合入'}[d.action]||d.action)}</summary><h4>本轮候选与依据</h4>${factsHTML(d.candidate?[d.candidate]:[])}${d.existing?.length?`<h4>保留的已有内容</h4>${factsHTML(d.existing)}`:''}${d.target?`<h4>保存后的草稿内容</h4>${factsHTML([d.target])}`:''}${d.action==='defer'?'<p>该候选暂不合入，已有内容保持保留。</p>':''}</details>`).join('')}
  ${button('merge-prev','上一页',off||!p.offset)}${button('merge-next','下一页',off||p.offset+p.decisions.length>=p.total)}
  ${p.counts.defer?`<label><input id="cv-keep-existing" type="checkbox" ${m.keepExisting?'checked':''}>保留已有内容，冲突候选暂不合入</label>`:''}
  <p>这里只保存草稿，尚未发布，也不会重抽材料。</p>${button('merge',flow.reviewPending?'恢复原合并请求':'确认保存草稿，继续核对',off)}${button('merge-close','暂不保存，返回结果',off||!!flow.reviewPending)}</section>`;
}
