import { starxiaotuTermMarker } from './term-help.mjs';
import {materialProgress,planCurrent,publicationCurrent,extractionProgress,candidatesReady,retainedMaterialResults} from './conversation-progress.mjs';
import {ontologyDefinitionsHTML} from './onboarding-ontology-view.mjs';
import {candidateHTML,mergeHTML,factsHTML} from './conversation-view.mjs';
import {visibleMaterialIntents} from './material-continuation.mjs';
import {currentMaterialWorkflow,materialWorkflowLabel,publishedMaterial} from './material-state.mjs';
import {extractionFailuresHTML} from './extraction-diagnostics.mjs';
import {materialAutomaticNoCandidates} from './material-agent.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const btn=(action,label,off=false,id='')=>`<button type="button" class="btn btn-secondary" data-cv="${action}" data-id="${esc(id)}" ${off?'disabled':''}>${label}</button>`;
const locked=f=>f.state.busy||!f.state.loaded||!!f.saved.pending||!!f.reviewPending||!!f.claimPending||!!f.releasePending;
const states={awaiting_source:'等待上传',awaiting_upload:'等待上传',parsing:'解析中',awaiting_goal:'待确认目标',ready_for_confirmation:'待核对本体和计划',queued:'抽取排队中',running:'正在抽取',awaiting_review:'待核对材料知识',failed:'处理失败',cancelled:'已停止',stale:'来源已变化'};
export function materialStatusHTML(flow){
  const s=flow?.state,d=s?.detail,changes=flow?.changes,progress=materialProgress(d,s?.knowledge);
  const materials=flow?visibleMaterialIntents(flow,s.intents):[];
  const publication=changes?.state.publication||d?.outcome?.publication;
  const pendingPublication={queued:'等待发布',running:'正在发布',failed:'发布失败',cancelled:'发布已取消'}[publication?.status];
  const newIntent=changes?.record.previousIntent&&!d?.review?.draft_id;
  const automatic=flow?.agent?.current?.current;
  const automaticLabel=automatic?.is_current?(materialAutomaticNoCandidates(automatic)?'本次无可发布候选':automatic.stage==='published'&&automatic.publication_performed!==true?'发布状态待确认':{queued:'自动抽取排队中',running:'正在自动抽取',publishing:'正在自动发布',published:'自动抽取已发布',awaiting_review:'抽取完成，待核对',failed:'自动处理失败',cancelled:'自动处理已停止'}[automatic.stage]):null;
  const status=automaticLabel||(['cancelled','stale'].includes(d?.status)&&!retainedMaterialResults(d)?states[d.status]:d?.document_version_id&&d.source_status!=='available'?'来源已变化':flow?.intake?.record&&!flow.intake.sourceReviewed&&!retainedMaterialResults(d)?(flow.intake.unavailable?(states[d?.status]&&['failed','stale','cancelled'].includes(d?.status)?states[d.status]:'来源已变化'):flow.intake.source?(flow.intake.record.confirmed?'正文已核对':'解析完成，待核对正文'):'正在解析正文'):changes?.record.pending?'请求结果待恢复':pendingPublication||
    (changes?.state.summary?.status==='discarded'||!changes?.state.summary&&d?.review?.status==='discarded'?'草稿已放弃':newIntent&&states[d?.status]?states[d.status]:changes?.state.summary?.status==='editing'?'草稿待核对':progress.published?'已发布并读取生效知识':publicationCurrent(d)?'待读取生效知识':retainedMaterialResults(d)?'已停止抽取，已有结果可继续核对':changes?.record.draftId&&flow.saved.materialContinuations?.[d?.id]?.mode==='draft'?'继续核对已有草稿':states[d?.status]||'等待上传材料'));
  const otherStatus=i=>{const r=flow?.saved.intakeReviews?.[i.id];return r&&['awaiting_goal','ready_for_confirmation'].includes(i.status)?r.stage==='goal'?(i.status==='ready_for_confirmation'&&!r.goalNeedsConfirmation?'目标已确认':'明确整理目标'):r.confirmed?'正文已核对':'待核对正文':i.publication_effective?'服务端已发布':states[i.status]||i.status;};
  return `<section class="cv-stage-materials" aria-label="材料处理状态"><div class="cv-material-status" role="status"><span>当前材料：${esc(s?.intents.find(i=>i.id===s.selectedIntent)?.original_name||'尚未选择')}</span><strong>${esc(materialWorkflowLabel(currentMaterialWorkflow(flow))||status)}</strong></div>
    ${materials.length>1?`<div class="cv-material-switcher" aria-label="切换材料">${materials.map(i=>btn('intent',esc((i.original_name||'待上传材料')+' · '+(i.id===s.selectedIntent?status:otherStatus(i))),locked(flow),i.id)).join('')}</div>`:''}</section>`;
}
export function ontologyStage(flow){
  const s=flow.state,d=s.detail,o=s.ontology,p=s.plan,off=locked(flow);
  return `<section class="cv-stage-panel">
    ${!p&&d?.goal?.goal?`<p role="status">整理目标已由服务端确认保存，尚未开始抽取。</p><h3>${esc(d.goal.goal)}</h3><p>${esc(d.goal.instructions||'未设置其他关注或排除内容')}</p>`:''}
    ${!d?.execution?btn('stage-1','开始前调整整理目标',off):''}
    ${o?`<p>适用本体：${esc(o.name)} · 生效版本 ${esc(o.version_number)}</p><details data-cv-disclosure="plan-definitions"><summary>查看实体类型、关系与属性</summary>${ontologyDefinitionsHTML(o.schema,'cv-rule')}</details>`:'<p role="alert">尚未读取到当前生效本体，请先核对并发布规则。</p>'}
    <div class="conversation-toolbar">${!p?btn('plan','沿用当前本体，读取计划',off||!o||d?.status!=='ready_for_confirmation'||s.goalDirty):''}${btn('ontology','前往本体修改',off)}</div>
    <p>当前类型不适合整理目标时，可以先让助手建议名称和含义，核对后再应用；适合时直接沿用当前本体。</p>${btn('change-suggest','根据目标建议类型与关系',off||!d?.document_version_id||d.source_status!=='available'||['queued','running','cancelled','stale'].includes(d.status))}
    <p>仅处理当前材料；规则变更不会自动重抽历史材料。</p>
    ${s.goalDirty?`<div class="cv-notice">目标卡还有未确认的修改，请先核对目标。${btn('stage-1','查看目标确认卡',off)}</div>`:''}
    ${d?.status!=='ready_for_confirmation'?`<div class="cv-notice">${d?.execution?'本次计划已提交，可查看抽取进度和材料知识。':'请先明确确认当前材料目标。规则变化后需重新确认目标。'}${btn(d?.execution?'stage-3':'stage-1',d?.execution?'查看材料处理':'查看目标确认卡',off)}</div>`:''}
    ${p?`<section class="cv-plan"><h3>本次材料处理计划${starxiaotuTermMarker('extraction-plan')}</h3><dl><dt>材料</dt><dd>${esc(s.intents.find(i=>i.id===d?.id)?.original_name||'当前材料')}</dd><dt>正文版本</dt><dd>${esc(p.document_version_id)}</dd><dt>目标</dt><dd>${esc(p.goal?.goal)}</dd><dt>补充说明</dt><dd>${esc(p.goal?.instructions||'无')}</dd><dt>适用本体${starxiaotuTermMarker('active-ontology')}</dt><dd>${esc(o?.name)} · v${esc(o?.version_number)}</dd><dt>抽取模型</dt><dd>${esc(p.processing?.extraction?.name||p.processing?.extraction?.model||'服务端确认的模型')}</dd></dl>
    <p>只抽取上述材料的候选，结果需再核对并确认发布。已有生效知识继续保留。</p>${btn('confirm-plan','确认计划，开始抽取',off||s.goalDirty||s.acceptedOntology!==p.ontology_id||!planCurrent(p,s.overview,d,o))}</section>`:''}
    ${btn('refresh','重新读取规则与进度',s.busy)}</section>`;
}
export function knowledgeStage(flow){
  const s=flow.state,d=s.detail,e=d?.execution,p=d?.outcome?.publication,off=locked(flow),progress=materialProgress(d,s.knowledge);
  const w=currentMaterialWorkflow(flow),baseline=s.dialogueKnowledge;
  if(publishedMaterial(w)&&w.stage!=='awaiting_review'&&flow.changes.state.summary?.status!=='editing'&&w.document_version_id===d?.document_version_id){
    const facts=baseline?.run?.id===w.publication.id?(baseline.candidates||[]).filter(item=>item.status==='published'):null;
    const page=Math.max(0,Math.min(s.baselinePage||0,Math.ceil((facts?.length||0)/20)-1));
    return `<section class="cv-published"><h3>当前已发布知识</h3><p>可以直接提问。需要修改时再开始编辑；已有发布结果在新修改发布前继续有效。</p>${btn('material-edit-existing','开始修改已有知识',off)}${btn('import-close-dialogue','返回材料处理',off)}
      ${facts?`<p>共 ${facts.length} 项知识</p>${factsHTML(facts.slice(page*20,(page+1)*20),facts,s.ontology?.schema)||'<p>当前发布结果没有知识条目。</p>'}${btn('baseline-prev','上一页',off||page===0)}<span> ${page+1} / ${Math.max(1,Math.ceil(facts.length/20))} </span>${btn('baseline-next','下一页',off||(page+1)*20>=facts.length)}`:'<p>正在读取当前生效结果，请读取最新进度。</p>'}</section>`;
  }
  const publishedFacts=progress.published?s.knowledge.candidates.filter(i=>i.status==='published'):[];
  if(['queued','running'].includes(d?.status)||['queued','running'].includes(e?.status)){
    const {completed:done,total,known,remaining,percent}=extractionProgress(e?.progress);
    const queued=e?.status==='queued'||d?.status==='queued';
    return `<section class="cv-stage-panel cv-processing" role="status"><p>${queued?'任务已排队，等待开始抽取。':known&&remaining===0?'批次已处理完，正在等待服务端确认抽取结果。':'正在抽取材料内容。'}</p>
      <div class="cv-progress-summary"><strong>${known?`已完成 ${done} / ${total} 个批次`:`${done!==null?`已完成 ${done} 个批次`:'等待批次进度'} · 总数待确定`}</strong><span>${known?`${percent}%`:'处理中'}</span></div>
      <progress aria-label="${known?'材料抽取批次进度':'抽取处理中，总批次数待确定'}" ${known?`max="${total}" value="${done}" aria-valuetext="已完成 ${done} / ${total} 个批次，${percent}%，剩余 ${remaining} 个批次"`:''}></progress>
      <p>${known?`剩余 ${remaining} 个批次${remaining===0?'；任务尚未完成，请等待结果就绪。':'。'}`:'服务端尚未返回有效的总批次数，暂无法计算剩余批次和百分比。'}</p><small>进度自动更新；抽取完成后再显示候选核对操作。</small></section>`;
  }
  return `<section class="cv-stage-panel"><h2>核对材料知识</h2><p>这里核对“文件实际说了什么”。抽取候选、合入草稿、保存草稿均不等于已发布。</p>
    ${!e?`<p>尚未收到本材料的抽取任务回执。</p>${btn('stage-2','核对本体与计划',off)}`:`<p role="status">抽取状态：${esc({queued:'已排队',running:'正在抽取',awaiting_review:'候选已就绪，待核对',succeeded:'候选已就绪',failed:'抽取失败',cancelled:'已取消'}[e.status]||e.status)} · ${esc(e.progress?.completed_units??0)} / ${esc(e.progress?.total_units??'待确定')} 单元</p>
      ${d.status==='failed'?btn('intent-retry','重试失败抽取',off):''}${candidatesReady(d)&&!s.candidates?btn('candidates','读取抽取候选',off):''}`}
    ${extractionFailuresHTML(s.dialogueFailureJob)}${candidateHTML(flow)}${mergeHTML(flow)}
    ${d?.status==='awaiting_review'?`<section class="cv-result-rules"><h3>本体建议与类型复用</h3><p>本轮候选依据已确认的本体抽取。自动生成的本体建议可在资料库核对。</p><details data-cv-disclosure="result-rules"><summary>查看当前生效的实体、关系与属性</summary>${ontologyDefinitionsHTML(s.ontology?.schema||{},'cv-result-schema')}</details><p>规则发布后不会自动重新抽取本材料或历史材料。</p></section>`:''}
    ${s.recoverable?.length?`<section class="cv-notice"><h3>选择已有草稿合并</h3><p>已有修改将保留。恢复会让其他编辑页面失去编辑权，请先保存该页面的修改。认领后先预览差异，不会直接合并或发布。</p>${s.recoverable.map(r=>`<div><p>草稿修订 ${esc(r.revision)} · ${esc(r.updated_at||'')}${r.legacy_unowned?' · 历史作者未知':''}</p>${!r.legacy_unowned&&r.status==='editing'?btn('claim-review','恢复此草稿并预览合并',off,r.draft_id):btn('advanced-review','进入编辑器核对草稿归属和发布进度',off,d.document_id)}</div>`).join('')}</section>`:''}
    ${/^(CORRECTION_|MODELING_REVIEW_)/.test(s.errorCode||'')&&d?.document_id?btn('advanced-review','进入材料编辑器恢复草稿',off,d.document_id):''}
    ${d?.review?.draft_id?`<div class="cv-notice"><h3>完整材料草稿</h3><p>${progress.published?'本轮发布已完成，可查看完整草稿及发布记录。后续修改需再次核对并确认。':'在本页读取完整草稿，选中事实后通过对话修改或排除，核对原文与全部变更，再明确确认发布。本轮未涉及的旧知识继续保留。'}</p>${btn('open-review',progress.published?'查看完整草稿和发布记录':'在本页核对草稿并确认发布',off,d.document_id)}</div>`:''}
    ${p?`<p role="status">本轮知识发布：${esc(progress.published?'发布成功，已读取当前生效知识':publicationCurrent(d)?'服务端已发布，等待读取生效知识':({queued:'等待发布',running:'正在发布',failed:'发布失败，请在草稿页恢复原提交',cancelled:'发布取消',succeeded:'本次发布结果已被替代'}[p.status]||p.status))}</p>`:''}
    ${progress.published?`<section class="cv-published"><h3>当前生效的材料知识 · ${publishedFacts.length} 项</h3>${factsHTML(publishedFacts,publishedFacts,flow.state.ontology?.schema)||'<p>本次发布没有保留事实条目。</p>'}${flow.changes?.state.summary?.status==='submitted'&&flow.changes?.state.publication?.status==='succeeded'?btn('change-new-draft','基于已发布知识继续修改',off):''}</section>`:''}
    ${p||progress.published?btn('refresh','读取发布与生效结果',s.busy):e?btn('refresh','重新读取抽取结果',s.busy):''}</section>`;
}
