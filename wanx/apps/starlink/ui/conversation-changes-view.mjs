import {ontologyDefinitionsHTML} from './onboarding-ontology-view.mjs';
import {conversationError} from './conversation-state.mjs';
import {latestChange,nextConversationStep} from './conversation-next.mjs';
import {groupPublicationIssues,publicationIssueAdvice} from '../shared/publication-validation.mjs';
import {pendingExtractionReview} from './material-state.mjs';
import {ruleUserInstruction,ruleStageHint} from './material-rule-guidance.mjs';
import {pendingValidationIssues,validationUserInstruction} from './material-validation-selection.mjs';
import {factCardHTML,factDiffHTML,factSchema,factContext,factType,visibleFactItems} from './material-fact-cards.mjs';
import {evidenceHelpHTML} from './material-evidence-view.mjs';
import {referenceUserInstruction} from './material-evidence.mjs';
import {changeConflictsHTML,hasChangeConflicts} from './material-change-conflicts.mjs';
export const changeUserInstruction=value=>referenceUserInstruction(validationUserInstruction(ruleUserInstruction(value)));
const userInstruction=changeUserInstruction;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const btn=(action,label,off=false,id='')=>`<button type="button" class="btn btn-secondary" data-cv="change-${action}" data-id="${esc(id)}" ${off?'disabled':''}>${label}</button>`;
const label={prepared:'待确认修改',applied:'草稿或目标已更新',generating:'正在生成提案',needs_clarification:'需要补充说明',no_changes:'无需修改',stale:'提案已失效',failed:'生成失败',unavailable:'历史提案当前不可读取'};
const names={goal:'目标',rules:'本体规则',facts:'材料事实',name:'标识／名称',label:'显示名称',definition:'定义',type:'类型',properties:'属性',instructions:'补充说明',source_types:'起点类型',target_types:'终点类型',required:'必填',item_id:'事实标识',payload:'事实内容',evidence:'原文依据',excerpt:'摘录',segment_id:'片段',review_note:'核对说明'};
export function ruleSuggestionsHTML(proposal){
  const changes=(proposal.result?.changes||[]).filter(c=>c.scope==='rules');
  const labels=new Map((proposal.result?.schema?.entity_types||[]).map(t=>[t.name,t.label||t.name]));
  return `<section class="cv-rule-suggestions"><h3>建议的名称与含义</h3><p>以下为待确认的分类规则，不表示材料中已经抽取到这些事实。</p>${changes.map(c=>{
    const type=c.after||c.before||{},relation=c.kind==='relation_types';
    return `<article class="cv-change-diff"><h4>${esc(type.label||c.name)}${c.name?' · '+esc(c.name):''}</h4><p>${c.after==null?'建议移除':c.before==null?'建议新增':'建议调整'}${relation?'关系类型':'实体类型'}</p><p>含义：${esc(type.definition||'暂未提供，请用业务语言补充或让助手提出建议。')}</p>${relation?`<p>关系方向：${esc((type.source_types||[]).map(v=>labels.get(v)||v).join('、')||'待明确')} → ${esc((type.target_types||[]).map(v=>labels.get(v)||v).join('、')||'待明确')}</p>`:''}<p>属性：${esc((type.properties||[]).map(v=>v.label||v.name).join('、')||'无')}</p></article>`;
  }).join('')}</section>`;
}
export function changeValue(value){
  if(value==null)return '<span class="muted">无</span>';
  if(Array.isArray(value))return value.length?`<ul>${value.map(v=>`<li>${changeValue(v)}</li>`).join('')}</ul>`:'<span class="muted">无</span>';
  if(typeof value==='object')return `<dl>${Object.entries(value).map(([k,v])=>`<dt>${esc(names[k]||k)}</dt><dd>${changeValue(v)}</dd>`).join('')}</dl>`;
  return esc(typeof value==='boolean'?(value?'是':'否'):value);
}
export function changesDiff(changes=[],flow,status='建议 · 未应用'){return changes.map((c,index)=>c.scope==='facts'||c.item_id&&['entity','relation'].includes((c.after||c.before)?.kind)?factDiffHTML(c,{schema:factSchema(flow),context:factContext(flow),status,documentId:flow?.state.detail?.document_id,documentVersionId:flow?.state.detail?.document_version_id}):`<article class="cv-change-diff"><h4>${esc(names[c.scope]||c.kind||'修改')} · ${esc(c.name||c.item_id||index+1)}</h4><div class="cv-before-after"><div><small>修改前</small>${changeValue(c.before)}</div><div><small>修改后</small>${changeValue(c.after)}</div></div></article>`).join('');}
export function publicationIssuesHTML(preview,off=false,selected=[]){
  const issues=Array.isArray(preview?.issues)?preview.issues:[],groups=groupPublicationIssues(issues);
  const total=Number.isSafeInteger(preview?.issue_count)?preview.issue_count:issues.length,partial=total>issues.length;
  const labels={error:'阻塞错误',warning:'待核对警告',reviewed:'已核对警告',info:'可忽略提示'};
  return `<section class="cv-publication-issues" aria-label="发布校验结果"><h4>发布校验结果 · ${total} 项提示</h4>
    <p>${Object.entries(labels).map(([key,label])=>`${label} ${partial?'已载入 ':''}${groups[key].reduce((sum,g)=>sum+g.count,0)} 项`).join(' · ')}</p>
    <p>材料未提及的属性不要补造，属性可留空，不阻止发布。警告可核对原文后填写说明；错误需要修正或排除。</p>
    ${Object.entries(labels).map(([key,label])=>groups[key].length?`<details ${['error','warning'].includes(key)?'open':''} data-cv-disclosure="validation-${esc(preview.revision)}-${key}"><summary>${label} · ${groups[key].length} 条事实</summary>${groups[key].map(group=>{
      const item=preview.issue_items?.find(c=>c.id===group.itemId)||preview.items?.find(c=>c.item_id===group.itemId)?.after;
      const advice=[...new Set(group.issues.map(publicationIssueAdvice).filter(Boolean))];
      return `<article class="cv-validation-fact"><strong>${esc(item?.display_name||item?.payload?.name||item?.payload?.type||'事实 '+group.itemId)}</strong><ul>${group.issues.map(issue=>`<li>${esc(issue.message||issue.code)}</li>`).join('')}</ul>${advice.length?`<div class="cv-validation-advice"><strong>处理建议</strong>${advice.map(text=>`<p>${esc(text)}</p>`).join('')}</div>`:''}</article>`;
    }).join('')}</details>`:'').join('')}
    ${partial?`<p>当前接口返回前 ${issues.length} 项提示；打开校验编辑器读取完整条目后可查看全部分类。</p>`:''}
    <section class="cv-validation-selection"><h4>在本页处理问题条目</h4><p>同一事实可能有多条提示，以下按事实去重。勾选后可对话修正或生成移除预览。</p>
    ${[...new Set(pendingValidationIssues(preview).map(i=>i.item_id).filter(Boolean))].map(id=>{const item=preview.issue_items?.find(i=>i.id===id)||preview.items?.find(i=>i.item_id===id)?.after;return `<label class="cv-validation-item"><input type="checkbox" data-cv-issue="${esc(id)}" ${selected.includes(id)?'checked':''} ${off?'disabled':''}> ${esc(item?.display_name||item?.payload?.name||item?.payload?.type||item?.name||item?.type||id)} <small>· ${esc(id)}</small></label>`;}).join('')}
    <div class="conversation-toolbar">${btn('issues-suggest','生成修正建议',off||!pendingValidationIssues(preview).length)}${btn('issues-adjust','对话修正选中条目',off||!selected.length)}${btn('issues-exclude','移除选中条目（预览）',off||!selected.length)}</div><p>生成建议针对已勾选的条目；未勾选时针对当前完整问题列表，每次最多 8 条事实。建议须确认应用到草稿，再整份核对发布；证据不足时会继续询问。</p><p>也可以直接发送“移除这些有问题的条目”。生成预览后确认应用，再点击“整份核对，进入发布预览”重新校验；不会直接发布。</p></section>
    <details><summary>更多编辑操作</summary><button type="button" class="btn btn-secondary" data-cv="advanced-review" ${off?'disabled':''}>打开完整校验编辑器</button></details>
  </section>`;
}
export function changeHistory(flow,proposals=flow.changes.state.proposals,showMore=true,interactive=true){
  const c=flow.changes,s=c.state,off=flow.state.busy||!!c.record.pending;
  const working=!interactive||['extracting','reading','parsing','receipt','discarded'].includes(nextConversationStep(flow));
  const latest=latestChange(flow),isCurrent=p=>p.id===latest?.id&&['prepared','generating','needs_clarification','failed','stale'].includes(p.status)&&p.id!==c.record.deferredProposal;
  return `<section class="cv-change-history" aria-label="对话修改提案">${[...proposals].reverse().map(p=>`<details class="cv-message cv-assistant ${isCurrent(p)?'cv-proposal-current':''}" data-cv-disclosure="change-message-${esc(p.id)}-${esc(p.status)}-${isCurrent(p)?'current':'history'}" ${isCurrent(p)?'open':''}><summary>资料整理 · ${esc(label[p.status]||p.status)}${p.instruction?' · '+esc(userInstruction(p.instruction).slice(0,48)):''}</summary><div class="cv-message-body"><p class="cv-change-instruction">${esc(userInstruction(p.instruction))}</p><p>${esc(p.result?.summary||'')}</p>
    ${p.error_code?`<p role="alert">${esc(conversationError({code:p.error_code}))}</p>`:''}
    ${!['stale','unavailable'].includes(p.status)?changeConflictsHTML(p.result,flow):''}
    ${p.result?.coverage?`<p class="cv-reading-coverage">本轮读取 ${esc(p.result.coverage.sampled_segments)} / ${esc(p.result.coverage.total_segments)} 段。${p.result.coverage.partial?'仅覆盖部分片段，不能视为通读全文。':''}</p>`:''}
    ${p.result?.questions?.length?`<ol>${p.result.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ol><p>${c.record.changeTarget==='rules'?'你可以描述业务含义，例如“专利同时包含申请中和已授权的成果，不加属性”。也可以让助手先建议，再确认或修改。':'可以直接在下方补充说明，我会继续生成修改预览。'}</p>${isCurrent(p)&&interactive?evidenceHelpHTML(flow,{questions:true}):''}`:''}
    ${isCurrent(p)&&c.record.changeTarget==='rules'&&p.status==='needs_clarification'?btn('suggest-labels','助手先建议名称与含义',off,p.id):''}
    ${isCurrent(p)&&c.record.changeTarget==='rules'&&p.status==='prepared'?ruleSuggestionsHTML(p)+btn('answer','修改建议的含义',off,p.id):''}
    ${isCurrent(p)&&p.status==='prepared'?'<h3>第 7 步 · 核对差异，确认应用</h3><p>可继续描述要调整的建议。核对后回复“确认应用到草稿”或点击下方按钮；确认仅保存修改，发布需另行核对确认。</p>':''}
    ${p.result?.changes?.length?`<details data-cv-disclosure="proposal-${esc(p.id)}" ${p.status==='prepared'?'open':''}><summary>核对修改差异 · ${p.result.changes.length} 项</summary>${changesDiff(p.result.changes,flow,p.status==='applied'?'已应用 · 以当前草稿为准':'建议 · 未应用')}</details>`:''}
    ${p.status==='prepared'&&p.result?.schema?`<section><h4>本体建议 · 复用与新增</h4><p>以下仅为待核对建议，尚未替换当前规则。</p>${Object.keys(p.result.type_mapping||{}).length?`<table><thead><tr><th>原类型</th><th>复用或合并到</th></tr></thead><tbody>${Object.entries(p.result.type_mapping).map(([from,to])=>`<tr><td>${esc(from)}</td><td>${esc(to)}</td></tr>`).join('')}</tbody></table>`:''}${(p.result.changes||[]).filter(c=>c.scope==='rules').map(c=>`<p>${c.before==null?'建议新增':c.after==null?'建议移除':'建议修改'}：${esc(c.name||c.kind||'规则')}（见上方差异）</p>`).join('')}<details><summary>完整目标结构与类型对应</summary>${ontologyDefinitionsHTML(p.result.schema,'cv-proposed-schema')}</details></section>`:''}
    ${isCurrent(p)&&p.status==='prepared'&&c.proposalAllowed?.(p)===false?'<p role="alert">建议包含超出本轮范围的修改，暂不能应用。请重新明确修改对象并生成建议。</p>':''}
    ${!working&&(c.independent||!s.summary?.stale_reason)&&isCurrent(p)&&p.status==='prepared'&&p.can_apply===true&&p.result?.changes?.length&&!hasChangeConflicts(p.result)&&c.proposalAllowed?.(p)!==false?btn('apply','确认应用，保存修改',off,p.id):''}
    ${!working&&isCurrent(p)&&['failed','stale'].includes(p.status)?btn('revise','修改要求后重试',off,p.id):''}
    ${!working&&isCurrent(p)&&p.status!=='generating'?btn('defer','取消本轮建议，返回材料',off,p.id):''}
    ${p.status==='applied'?'<p role="status">已收到服务端应用回执，修改已保存；尚未发布，也未启动抽取。可以继续对话调整。</p>':''}
    ${p.result?.reextract?.recommended?'<p>这次修改建议重新抽取当前材料，尚未开始抽取；新增属性不代表已抽出属性值。</p>':''}
    ${p.result?.validation?.remaining_error_count?`<p>草稿仍有 ${esc(p.result.validation.remaining_error_count)} 个校验问题，需处理后再发布。</p>`:''}
  </div></details>`).join('')}${showMore&&s.more?btn('more','更早的修改提案',off):''}</section>`;
}
export function proposalPanel(flow){
  const p=latestChange(flow),c=flow.changes,off=flow.state.busy||!!flow.saved.pending||!!c.record.pending;
  if(!p||p.id===c.record.deferredProposal)return '';
  const generating=p.status==='generating';
  return `<section class="mw-proposal-review" aria-label="本轮修改建议"><h3>${esc(label[p.status]||'本轮修改建议')}</h3>
    ${generating?'<progress aria-label="正在生成修改建议"></progress><p role="status">正在生成修改预览；下方保留当前材料结果。</p>':p.status==='needs_clarification'?'<p role="status">等待你的补充说明，请直接在右侧回答下面的问题。后台没有在执行修改。</p>':'<p>核对本轮修改范围与差异；确认应用只保存修改，不会发布或重新抽取。</p>'}
    ${changeHistory(flow,[p],false)}
    ${!p.result?.questions?.length?evidenceHelpHTML(flow):''}
    ${!generating&&p.status==='needs_clarification'?`<button class="btn btn-secondary" data-cv="change-answer" data-id="${esc(p.id)}" ${off?'disabled':''}>${c.record.changeTarget==='rules'?'我来补充业务含义':'回答待确认问题'}</button>`:''}
  </section>`;
}
export function changesPanel(flow,mode='all'){
  const c=flow.changes,s=c.state,d=flow.state.detail,off=flow.state.busy||!!c.record.pending;
  if(s.exclusion){const p=s.exclusion;return `<section class="cv-change-panel cv-exclusion-preview" aria-label="问题条目移除预览"><h3>核对移除条目 · ${p.ids.length} 条事实</h3><p>将从当前草稿中排除下列条目。${p.relatedCount?`包含 ${p.relatedCount} 条关联关系，避免删除实体后留下无效关系。`:''}确认后仅保存草稿，发布前已有知识继续生效。</p><ul>${p.items.map(item=>`<li>${esc(item.kind==='relation'?'关系':'实体')} · ${esc(item.display_name||item.payload?.name||item.payload?.type||item.id)}</li>`).join('')}</ul>${btn('exclusion-apply','确认移除并保存草稿',off)}${btn('exclusion-cancel','取消移除',off)}</section>`;}
  if(mode==='rules-ready')return `<section class="cv-rule-continuation"><h3>本体已发布，尚未开始抽取</h3><p>下一步核对本材料的整理目标和抽取计划；已有发布知识继续有效。</p>${btn('continue-extraction','核对抽取目标与计划',off)}<p>此入口使用对话抽取流程。目标需再次核对，不会切换成忽略聊天目标的自动抽取。</p></section>`;
  if(c.independent&&['all','rules','proposal-context'].includes(mode))return `<section class="cv-change-panel"><h3>${c.record.changeTarget==='rules'?'调整仓库本体规则':'调整本材料整理目标'}</h3><p>${c.record.changeTarget==='rules'?'本体发布后用于后续处理，其他材料不会自动重新抽取。':'目标应用后进入本材料的新一轮计划核对，已有发布结果继续有效。'}</p>
    ${c.record.changeTarget==='rules'?`<p role="status">${esc(ruleStageHint(flow))}</p><p>建议名称与含义 → 确认应用 → 发布本体 → 核对目标与抽取计划</p>`:''}
    ${s.context?.schema?`<details data-cv-disclosure="independent-schema" ${c.record.ontologyDraftId?'open':''}><summary>${c.record.ontologyDraftId?'待发布本体草稿':'当前适用本体'}</summary>${ontologyDefinitionsHTML(s.context.schema,'cv-independent-schema')}</details>`:''}
    ${c.record.ontologyDraftId?`<p>请核对完整本体后确认发布。发布后如需更新材料结果，请另行确认抽取。</p><label><input id="cv-rule-confirmed" type="checkbox" ${s.ruleConfirmed?'checked':''} ${off?'disabled':''}>我已核对完整结构，确认发布本体规则</label>${btn('publish-rules','确认发布本体规则',off||!s.ruleConfirmed||s.context?.ontology_id!==c.record.ontologyDraftId)}`:''}
    ${btn('refresh','读取最新修改上下文',off)}<button type="button" class="btn btn-secondary" data-cv="adjust" data-id="facts" ${off?'disabled':''}>转到材料事实调整</button></section>`;
  const canConfirm=s.preview?.ready_for_confirmation===true,issues=Array.isArray(s.preview?.issues)?s.preview.issues:[];
  const issueCount=Number.isSafeInteger(s.preview?.issue_count)&&s.preview.issue_count>=issues.length?s.preview.issue_count:issues.length;
  const publication=s.publication||d?.outcome?.publication;
  if(mode==='discarded'||s.summary?.status==='discarded')return `<section class="cv-change-panel" role="status"><h3>草稿已放弃</h3><p>这份草稿未提交发布，已发布知识不受影响。可在草稿编辑器中重新创建草稿并核对。</p><button type="button" class="btn btn-secondary" data-cv="advanced-review" ${off?'disabled':''}>打开草稿编辑器，重新创建</button></section>`;
  if(mode==='receipt'&&(!publication||['queued','running','submitted'].includes(publication.status))){
    return '<section class="cv-change-panel cv-processing" role="status"><p>正在发布材料知识，尚未收到生效回执。</p><progress aria-label="知识发布进度"></progress><small>进度自动更新，发布完成后展示生效结果。</small></section>';
  }
  const schema=s.context?.schema;
  const proposed=s.proposals.find(p=>p.status==='prepared'&&p.can_apply===true&&p.result?.changes?.length);
  const showItems=['all','draft','proposal-context'].includes(mode),showRules=['all','rules'].includes(mode)||mode==='proposal-context'&&!s.summary;
  const pendingProposal=nextConversationStep(flow)==='proposal';
  const pageItems=s.items?.items||[],pageIds=new Set(pageItems.map(i=>i.id));
  const visible=visibleFactItems(s,factSchema(flow)),types=[...new Set(pageItems.map(i=>i.payload?.type).filter(Boolean))];
  const selectedElsewhere=s.selected.filter(id=>!pageIds.has(id)).length;
  const stale=s.summary?.status==='editing'&&!!s.summary.stale_reason;
  return `<section class="cv-change-panel">
    ${flow.state.autoSwitch?`<section class="cv-notice"><h3>切换为自动抽取</h3><p>当前材料有待核对内容。可以继续修改；如决定重新抽取，请先明确放弃本轮草稿。已发布知识继续有效。正文与本体的当前版本将在抽取预览中重新核对。</p><button class="btn btn-secondary" data-cv="auto-switch-cancel" ${off?'disabled':''}>保留草稿，继续修改</button>${s.summary?.status==='editing'&&!pendingExtractionReview(flow)?btn('discard-prepare','放弃草稿，重新抽取',off):'<p>请先通过下方入口读取或接管现有草稿，再核对放弃范围。尚未合入草稿的候选需先核对，当前服务不支持直接跳过待核对结果。</p>'}</section>`:''}
    ${s.discardPrompt?`<section class="cv-notice" role="alert"><h3>确认放弃本轮草稿？</h3><p>将放弃修订 ${esc(s.discardPrompt.revision)} 的整份未发布草稿。已发布知识不受影响；关联的本体规则草稿不会自动删除。之后只生成抽取计划，不会立即开始抽取。</p>${btn('discard-confirm','确认放弃草稿，核对抽取计划',off)}${btn('discard-cancel','保留草稿',off)}</section>`:''}
    ${c.record.pending?`<div class="cv-notice">修改请求结果尚未确认，请恢复原请求。${c.record.pending.action?.startsWith('conversation-instruction-')&&c.record.pending.hadEditor&&!c.owner?.draftId?btn('open-draft','先恢复草稿编辑权',flow.state.busy):''}${btn('recover','恢复原修改请求',flow.state.busy)}</div>`:''}
    ${c.record.previousIntent?`<p>目标修改后已切换到新的材料意图，原抽取结果仍保留。</p><button class="btn btn-secondary" data-cv="intent" data-id="${esc(c.record.previousIntent)}" ${off?'disabled':''}>查看原意图与提案历史</button>`:''}
    ${mode==='all'?`${btn('refresh','刷新修改上下文',flow.state.busy)}${btn('suggest','生成材料结构建议',off||!d?.document_version_id||d.source_status!=='available')}`:''}
    ${showRules&&schema?`<details data-cv-disclosure="change-schema" open><summary>${c.record.ontologyDraftId?'待确认结构草稿':'本次材料适用结构'}</summary>${ontologyDefinitionsHTML(schema,'cv-change-schema')}</details>`:''}
    ${mode==='all'&&proposed?`<details open><summary>本轮待应用提案</summary>${changesDiff(proposed.result.changes,flow)}</details>`:''}
    ${showRules&&c.record.ontologyDraftId&&!s.summary?`<div class="cv-rule-publish"><p>类型和属性仍为草稿，发布规则后才能按新规则确认抽取计划。</p><button class="btn btn-secondary" data-cv="adjust" data-id="rules" ${off?'disabled':''}>通过对话调整规则</button><label><input id="cv-rule-confirmed" type="checkbox" ${s.ruleConfirmed?'checked':''} ${off?'disabled':''}>我已核对完整结构，确认发布本体规则</label>${btn('publish-rules','确认发布本体规则',off||!s.ruleConfirmed||!schema)}</div>`:''}
    ${(d?.review?.draft_id||c.record.draftId)&&!s.summary&&!s.leases.length?`<p>这份材料有尚未发布的修改。继续核对后，可在当前页面修改实体、关系和证据。</p>${btn('open-draft','继续核对材料',off)}`:''}
    ${s.leases.length?`<div class="cv-notice"><h3>继续修改已保存的内容</h3><p>选择后由当前对话接管编辑。其他页面将停止编辑这份内容，请先保存其他页面的修改。尚未发布的修改会保留。</p>${s.leases.map(l=>`<p>修订 ${esc(l.revision)} · ${esc(l.status==='editing'?'待确认修改':l.status)} ${!l.legacy_unowned&&l.status==='editing'?btn('claim','在此继续修改',flow.state.busy,l.draft_id):'请在详细编辑中核对归属或发布状态'}</p>`).join('')}${s.leases.some(l=>l.legacy_unowned)?`<button class="btn btn-secondary" data-cv="advanced-review" ${off?'disabled':''}>核对并认领历史草稿</button>`:''}</div>`:''}
    ${s.summary?`<div class="cv-change-facts"><h3>完整材料草稿 · 修订 ${esc(s.summary.revision)}</h3><p>实体 ${esc(s.summary.counts.entity)} · 关系 ${esc(s.summary.counts.relation)} · ${esc({editing:'未发布草稿',submitted:'已提交发布',cancelled:'已取消'}[s.summary.status]||s.summary.status)}</p>
      ${stale?`<div class="cv-draft-stale cv-notice" role="status"><strong>原草稿已保留，需先处理版本变化</strong><p>${esc(conversationError({code:s.summary.stale_reason}))}</p><p>这与是否逐项勾选无关。处理完成后返回本页读取最新状态，再整份核对。</p>${btn('refresh','重新读取草稿状态',off)}<button type="button" class="btn btn-secondary" data-cv="advanced-review" ${off?'disabled':''}>处理草稿版本变化</button></div>`:''}
      ${s.summary.status==='editing'&&!stale?'<details class="cv-fact-help" data-cv-disclosure="fact-editing-help"><summary>调整目标、本体与发布说明</summary><p role="status">当前内容已保存到服务端草稿，尚未发布。继续提出修改要求会先生成提案，核对差异后再确认应用。</p>':''}
      ${showItems&&s.summary.status==='editing'&&!stale?`<div class="conversation-toolbar"><button class="btn btn-secondary" data-cv="adjust" data-id="rules" ${off?'disabled':''}>合并类型／调整定义和属性</button><button class="btn btn-secondary" data-cv="adjust" data-id="goal" ${off?'disabled':''}>修改整理目标</button></div><p>类型合并不会合并具体实体；修改目标或规则不会自动重新抽取。</p>`:''}
      ${s.summary.status==='editing'&&!stale?'</details>':''}
      ${showItems?`${!stale?`<p class="cv-batch-hint">选中条目后，在右侧描述调整要求。已选 ${s.selected.length} / 20 项${selectedElsewhere?`（其他页已选 ${selectedElsewhere} 项）`:''}。</p><details class="cv-fact-help"><summary>批量选择说明</summary><p>无需逐条勾选确认。没有修改时，直接点击右侧“整份核对，进入发布预览”；勾选仅用于批量修正或排除事实。每次修改最多 20 项，整份草稿核对不受此限制。</p></details>
      <div class="conversation-toolbar">${btn('select-page','全选本页',!!c.selectionLocked||!visible.length||s.items?.revision!==s.summary.revision||visible.length>20)}${btn('clear-selection','清空选择',!!c.selectionLocked||!s.selected.length)}<button class="btn btn-secondary" data-cv="adjust" data-id="facts" ${c.selectionLocked||!s.selected.length?'disabled':''}>批量修正或排除已选事实</button></div>
      ${selectedElsewhere?'<p class="muted">“全选本页”会替换其他页的选择；已有事实不会因此改变。</p>':''}`:''}
      ${btn('entities','实体',off)}${btn('relations','关系',off)}
      <form id="cv-fact-filter" class="cv-fact-filter"><label>搜索本页<input id="cv-fact-keyword" type="search" maxlength="200" value="${esc(s.factFilter?.keyword||'')}" placeholder="名称、属性或分类" ${off?'disabled':''}></label><label>本页分类<select id="cv-fact-type" ${off?'disabled':''}><option value="">全部分类</option>${types.map(type=>`<option value="${esc(type)}" ${s.factFilter?.type===type?'selected':''}>${esc(factType(pageItems.find(i=>i.payload.type===type),factSchema(flow)))}</option>`).join('')}</select></label><button type="submit" class="btn btn-secondary" ${off?'disabled':''}>筛选</button>${btn('filter-clear','清除筛选',off)}</form><p class="cv-fact-count">本页显示 ${visible.length} / ${pageItems.length} 项 · 当前${s.kind==='relation'?'关系':'实体'}共 ${s.items?.total??0} 项。全选本页仅选择当前筛选结果。</p>
      ${visible.map(i=>factCardHTML(i,{schema:factSchema(flow),context:factContext(flow),selectable:true,selected:s.selected.includes(i.id),disabled:!!c.selectionLocked,selectionDisabled:!!c.selectionLocked||!s.selected.includes(i.id)&&s.selected.length>=20,adjustable:!pendingProposal,status:s.summary.status==='editing'?'草稿 · 未发布':s.summary.status==='submitted'?'已提交发布':'请核对草稿状态',source:s.source,sourceFor:s.sourceFor})).join('')||'<p class="cv-fact-empty">本页没有符合筛选条件的条目。</p>'}
      ${btn('items-prev','上一页',off||!s.items?.offset)}${btn('items-next','下一页',off||!s.items||s.items.offset+s.items.items.length>=s.items.total)}
      ${s.summary.status==='editing'&&!stale?`${pendingProposal?'<p>请先确认应用或取消本轮建议，再核对整份材料的发布变更。</p>':''}${btn('preview','整份核对，进入发布预览',off||pendingProposal)}`:''}`:''}
      ${s.preview&&!stale?`<section class="cv-publication-preview"><h3>本次发布变更 · ${s.preview.total} 项</h3>${changesDiff(s.preview.items,flow,'草稿 · 尚未发布')}
      ${s.preview.unchanged_published?'<p role="status">当前草稿与已发布内容一致，没有可发布的修改。请先生成建议并确认应用到草稿。</p>':''}
      ${issues.length?publicationIssuesHTML(s.preview,off,s.issueSelection||[]):''}
      <p>发布范围仅为当前材料。若草稿绑定了规则修改，将同时发布规则；其他材料不会自动重抽。</p>
      ${canConfirm?`${btn('edit-draft','返回草稿继续调整',off)}<label><input id="cv-publish-confirmed" type="checkbox" ${s.publishConfirmed?'checked':''} ${off?'disabled':''}>我已核对完整差异和原文依据，确认发布</label>`:
      s.preview.unchanged_published?`<div class="cv-publication-blocked" role="status"><strong>当前没有新的发布变更</strong>${btn('edit-draft','返回草稿继续调整',off)}</div>`:`<div class="cv-publication-blocked" role="status"><strong>暂不能发布：草稿校验未通过</strong><p>${issueCount?`服务端返回 ${issueCount} 项校验提示（包含不阻止发布的信息），分类见左侧发布校验结果。`:'服务端尚未允许确认发布，请返回草稿核对内容后重新预览。'}</p><p>可在本页勾选问题条目，通过对话修正或生成移除预览；确认应用后重新核对。错误须修正或排除，属性可留空，无需补造。</p>${btn('edit-draft','返回草稿处理问题',off)}</div>`}
      ${btn('publish','确认发布本篇知识',off||!s.publishConfirmed||!canConfirm)}</section>`:''}
      ${s.publication?`<p role="status">发布回执：${esc(s.publication.status)}${s.publication.effective?' · 服务端已生效，正在核对当前知识':''}${s.publication.error_message?' · '+esc(s.publication.error_message):''}</p>`:''}
      ${['failed','cancelled'].includes(s.publication?.status)?btn('retry-publication','重试原发布任务',off):''}
      ${s.publication?.status==='succeeded'?btn('new-draft','基于已发布知识继续修改',off):''}
    </div>`:''}
    ${d?.document_id?`<details data-cv-disclosure="advanced-editor"><summary>手动修改实体、关系、证据与本体</summary><button type="button" class="btn btn-secondary" data-cv="advanced-review" ${off?'disabled':''}>在工作台内详细编辑</button></details>`:''}
  </section>`;
}
