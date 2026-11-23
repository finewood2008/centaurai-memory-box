import {proposalView} from './onboarding-result.mjs';
import {proposalFailure,currentRuleReview,ruleProposalId} from './onboarding-state.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function suggestionResultHTML(s,{button,onModels,unavailableModel}){
  const p=s.proposal,view=proposalView(p),{valid}=view;
  const items=valid?view.suggestions:[],entities=items.filter(i=>i.kind==='entity'),relations=items.filter(i=>i.kind==='relation'),properties=items.filter(i=>i.kind==='property');
  const title=view.canAdopt?'初始本体已准备好':valid&&view.outcome==='no_changes'?'可以沿用当前本体':p?.status==='generating'?'正在生成初始本体':'初始本体尚未就绪';
  const failure=proposalFailure(p);
  const modelIssue=failure&&unavailableModel;
  const answers=s.context?.answers||s.answers,ruleName=s.context?.ontology_name||'当前生效规则';
  const busy=s.busy||!!s.pending;
  const name=n=>entities.find(e=>e.name===n)?.label||n;
  const evidence=item=>`${item.reason?`<p class="ob-suggestion-reason">理由：${esc(item.reason)}</p>`:''}${item.quote?`<p class="ob-suggestion-evidence">依据：${esc(item.quote)}</p>`:''}`;
  const card=(item)=>{
    const attributes=[...item.properties,...properties.filter(p=>p.owner_kind===item.kind&&p.owner_name===item.name)];
    return `<article class="ob-suggestion-card" role="listitem"><div class="ob-suggestion-card-title"><h3>${esc(item.label)}</h3><span>${item.kind==='entity'?'类型':'关系'}</span></div>
      ${item.kind==='relation'?`<div class="ob-suggestion-direction"><span>${esc(item.source_types.map(name).join('、')||'端点待核对')}</span><span aria-label="指向">→</span><span>${esc(item.target_types.map(name).join('、')||'端点待核对')}</span></div>`:''}
      <p class="ob-suggestion-definition">${esc(item.definition||'定义内容待核对')}</p>
      ${attributes.length?`<div class="ob-suggestion-attributes"><span>建议记录的属性</span><p>${esc([...new Set(attributes.map(a=>a.label))].join('、'))}</p></div>`:''}
      ${evidence(item)}${item.reuseOnly?'<p class="ob-suggestion-evidence">建议复用已有定义</p>':''}</article>`;
  };
  const status=view.canAdopt?'待核对 · 未发布':valid&&view.outcome==='no_changes'?'无需新增':p?.status==='generating'?'生成中':'尚未就绪';
  const review=currentRuleReview(s.context,p);
  const rulesButton=ruleProposalId(s.context,p)?button('rules',review?.id?'继续核对本体':'核对本体',busy,true):'';
  const canRegenerate=!review?.id&&!review?.draft&&!review?.publication;
  const generationButton=s.pending||(!s.needsReview&&(canRegenerate||!valid))
    ?button('generate',s.busy?'正在处理…':s.pending?'恢复原请求':p?'重新生成初始本体':'生成初始本体',s.busy||!s.context||p?.status==='generating',!valid):'';
  return `<div class="ob-page-title ob-result-heading"><div><h1>${title}</h1><p>先查看建议如何组织你的资料，再进入“核对本体”调整并确认发布。</p></div><span>当前生效本体 <strong>${esc(ruleName)}</strong></span></div>
    <section class="ob-created-banner" role="status"><span class="ob-created-icon" aria-hidden="true">✓</span><div><strong>${esc(s.warehouse.name)} · 星图已创建</strong><p>建仓目标和已填写的信息已保存。</p></div></section>
    <div class="ob-suggestion-layout"><section class="ob-form-card ob-suggestion-main"><div class="ob-suggestion-panel-title"><h2>初始本体建议</h2><span class="ob-review-status">${status}</span><small>${entities.length} 个类型 · ${relations.length} 种关系${properties.length?` · ${properties.length} 项属性`:''}</small></div>
      <p class="ob-muted">本体定义知识仓记录哪些类型、属性，以及类型之间允许建立的关系。建议尚未发布。</p>
      ${modelIssue?`<p class="ob-error" role="alert">当前星图的处理模型${modelIssue.name?`「${esc(modelIssue.name)}」`:' '}${esc(modelIssue.status)}，暂时无法生成初始本体。</p>`
        :failure?`<p class="ob-error" role="alert">${esc(failure)}</p>`:''}
      ${failure&&onModels?button('models','打开当前星图的模型设置',busy):''}
      ${p?.status==='succeeded'&&!valid?'<p class="ob-error" role="alert">分析结果不完整或状态与内容不一致，请重试生成或修改建仓信息。</p>':''}
      ${valid&&view.empty&&view.outcome==='needs_clarification'?'<p class="ob-error" role="alert">当前生成服务只返回了问题，没有可核对的本体。无需反复回答澄清问题；请先使用当前规则，或联系 Semantica 团队更新初始化生成策略。</p>':''}
      ${entities.length?`<section class="ob-suggestion-section"><h3>建议关注的类型 <small>定义 · 属性 · 理由 · 依据</small></h3><div class="ob-candidates ob-entity-cards" role="list">${entities.map(card).join('')}</div></section>`:''}
      ${relations.length?`<section class="ob-suggestion-section"><h3>建议允许的关系 <small>箭头表示关系方向，不表示已抽取事实</small></h3><div class="ob-candidates ob-relation-cards" role="list">${relations.map(card).join('')}</div></section>`:''}
      ${properties.length?`<section class="ob-suggestion-section"><h3>建议记录的属性</h3><div class="ob-property-suggestions" role="list">${properties.map(item=>`<article role="listitem"><div><strong>${esc(item.label)}</strong><small>${esc(name(item.owner_name))} · ${item.owner_kind==='relation'?'关系属性':'实体属性'}</small></div><p>${esc(item.definition)}</p>${evidence(item)}</article>`).join('')}</div></section>`:''}
      ${!items.length&&!failure?`<div class="ob-suggestion-empty">${p?.status==='generating'?'正在准备初始本体建议…':view.outcome==='no_changes'?'当前规则已覆盖这些用途，可直接进入知识仓。':'尚未取得可采用的候选。知识仓与填写的信息已保留。'}</div>`:''}
      ${view.explanation?`<details class="ob-model-explanation"><summary>查看建模说明${view.rejected?`（已排除 ${view.rejected} 条输出）`:''}</summary><p>${esc(view.explanation)}</p></details>`:''}
      <p class="ob-suggestion-footnote">以上内容是待核对的结构建议。确认发布后才会用于后续材料处理。</p>
    </section><aside class="ob-suggestion-sidebar"><section class="ob-form-card"><div class="ob-suggestion-panel-title"><h2>建议使用的信息</h2><span>已确认 · 已保存</span></div>
      <p class="ob-answer-role">${esc([answers?.industry,answers?.occupation].filter(Boolean).join(' · '))}</p>
      <dl class="ob-sidebar-answers">${[['service_objects','服务对象'],['focus_objects','关注对象']].filter(([key])=>s.context?.warehouse_scope?.[key]?.length).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(s.context.warehouse_scope[key].join('、'))}</dd></div>`).join('')}</dl>
      <dl class="ob-sidebar-answers">${[['material_types','主要资料'],['purpose','用途与目标'],['questions','希望回答的问题']].filter(([key])=>answers?.[key]).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(answers[key])}</dd></div>`).join('')}</dl>
      ${view.summaries.length?`<details class="ob-model-explanation"><summary>模型对回答的理解</summary>${view.summaries.map(item=>`<p>${esc(item.text)}</p>${item.quote?`<blockquote>依据：${esc(item.quote)}</blockquote>`:''}`).join('')}</details>`:''}
      ${Number.isSafeInteger(s.warehouse.document_count)?`<p class="ob-muted">仓内材料 ${s.warehouse.document_count} 份</p>`:''}
    </section><section class="ob-form-card"><h2>当前生效与待确认</h2><div class="ob-rule-status-row"><span>${esc(ruleName)}</span><b>当前生效</b></div><div class="ob-rule-status-row"><span>本次初始本体建议</span><b class="pending">${status}</b></div><p class="ob-muted">进入“核对本体”后，可修改、复用或排除建议。确认发布后，新结构才生效。</p></section>
    <section class="ob-material-entry"><h2>也可先进入对话整理</h2><p>使用当前生效规则上传材料、整理目标。初始化建议仍然保留，可稍后继续核对。</p>${button('enter-created','先进入材料页',s.busy)}</section></aside></div>
    <div class="ob-footer ob-suggestion-actions">${button('refresh','读取进度',s.busy)}${s.needsReview?button('reconsider','使用当前建仓信息重新生成',s.busy||!s.context):''}${rulesButton}${generationButton}</div>`;
}
