import {reuseOptions,dependencyWarnings,reviewedSchema,ruleMessage} from './onboarding-rules.mjs';
import {ontologyGraphHTML,ontologyChangesHTML,ontologyDefinitionsHTML} from './onboarding-ontology-view.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function ruleReuseOptionsHTML(workbench,choices,item) {
  const options=reuseOptions(workbench.base_ontology.schema,workbench.proposal.result.suggestions||[],choices,item);
  const choice=choices[item.id],raw=choice?.target?.trim()||'';
  const selected=item.kind==='property'?raw:raw.toUpperCase();
  return `<option value="">请选择已有定义</option>${selected&&!options.some(o=>o.name===selected)?`<option value="${esc(selected)}" selected disabled>${esc(selected)}（目标不可用，请重新选择）</option>`:''}${options.map(o=>`<option value="${esc(o.name)}" ${o.name===selected?'selected':''}>${esc(o.label)}（${esc(o.name)}）</option>`).join('')}`;
}
export function rulePreviewHTML(review) {
  const s=review.state,w=s.workbench,d=s.draft;
  const blocked=s.busy||!s.loaded||!!s.pending;
  let schema,issue='';
  const prepared=!!d&&!s.editing;
  try {schema=prepared?d.schema:reviewedSchema(w.base_ontology.schema,w.proposal.result.suggestions||[],s.choices).schema;}
  catch(error){issue=ruleMessage(error);}
  return `<h2>${prepared?'待发布本体':'本体预览'}</h2><p class="ob-muted" role="status">${prepared?'已按当前修改完成校验。核对右侧完整规则后，可在此确认发布。':'左侧修改会同步显示在此处。确认发布前，请先校验并保存当前修改。'}</p>
    ${issue?`<p class="ob-error" role="alert">${esc(issue)}</p>`:ontologyGraphHTML(schema,prepared?d.changes:[])}
    <div class="ob-rule-confirm-actions">
      <button class="ob-button" data-rule="save" ${blocked||!!issue?'disabled':''}>${prepared?'重新校验当前本体':'校验并更新本体'}</button>
      <label class="ob-publish-check"><input type="checkbox" data-rule-confirm ${s.confirmed?'checked':''} ${blocked||!prepared?'disabled':''}/> 我已核对完整本体，确认将其设为本仓生效规则</label>
      <button class="ob-button ob-primary" data-rule="publish" ${blocked||!prepared||!s.confirmed?'disabled':''}>统一确认并进入材料页</button>
    </div>
    ${schema?`<details class="ob-full-definitions"><summary>完整${prepared?'待发布':''}规则</summary>${ontologyDefinitionsHTML(schema,'ob-draft')}</details>`:''}
    ${prepared?`<details class="ob-review-changes"><summary>本次规则变更 · ${(d.changes||[]).length} 项</summary>${ontologyChangesHTML(d.changes,d.schema)}</details>`:''}`;
}
export function ruleReviewHTML(review) {
  const s=review.state, disabled=s.busy?'disabled':'', blocked=s.busy||!s.loaded||!!s.pending;
  const button=(action,label,off=false)=>`<button class="ob-button" data-rule="${action}" ${off?'disabled':''}>${label}</button>`;
  const w=s.workbench, p=s.publication;
  const items=w?.proposal?.result?.suggestions||[];
  const warnings=w?.base_ontology?dependencyWarnings(w.base_ontology.schema,items,s.choices):{};
  return `<div class="ob-page-title"><h1>${p?'本体规则已确认发布':'核对并采用本体建议'}</h1><p>在左侧修改或排除建议，在右侧核对完整本体，校验后统一确认。发布只更新规则，不会自动重新抽取已有材料。</p></div>
    ${s.error?`<div class="ob-error" role="alert">${esc(s.error)}</div>`:''}
    ${s.busy?'<p role="status">正在处理，请稍候…</p>':''}
    ${p?`<section class="ob-form-card"><h2>${esc(p.name)} · 版本 ${esc(p.version_number)}</h2><p>${p.changed?'规则已发布。':'已确认沿用已有规则。'}</p><p>进入知识仓后可查看当前生效的实体类型与关系。</p></section>`:s.loaded&&w?`
      <div class="ob-rule-review-layout"><section class="ob-form-card ob-rule-editor"><h2>检查初始本体</h2><p>${w.proposal.result.suggestions?.length?'有效建议已默认采用；同名定义默认复用。你只需修改不合适的内容，或排除不需要的建议。未保存的修改刷新后需重新核对。':'本次没有新增候选建议。请核对下方当前规则，保存并确认后可沿用，不会凭空生成新的类型。'}</p>
        <div class="ob-rule-list" role="list" aria-label="本体建议核对列表">${(w.proposal.result.suggestions||[]).map(item=>{
          const c=s.choices[item.id]||{action:'',target:item.name,label:item.label};
          const field=(key,label,value)=>`<label>${label}<input data-rule-id="${esc(item.id)}" data-rule-field="${key}" value="${esc(value)}" ${blocked?'disabled':''}/></label>`;
          const options=reuseOptions(w.base_ontology.schema,items,s.choices,item);
          const reuse=c.action==='reuse'||item.allow_new_type===false;
          const target=reuse?`<label>复用已有定义<select data-rule-id="${esc(item.id)}" data-rule-field="target" ${blocked?'disabled':''}>${ruleReuseOptionsHTML(w,s.choices,item)}</select></label><p data-rule-reuse-empty="${esc(item.id)}" ${options.length?'hidden':''}>暂无可复用的定义，请先采用所属类型或排除此建议。</p>`:field('target','新增定义标识',c.target);
          return `<article class="ob-rule-item" role="listitem" data-rule-item="${esc(item.id)}"><div class="ob-rule-description"><div class="ob-list-title"><span class="ob-kind-label">${{entity:'实体类型',relation:'关系类型',property:'属性'}[item.kind]}</span><h3>${esc(item.label)}</h3><small>${esc(item.name)}</small></div><p>${esc(item.definition)}</p>
          <p data-rule-dependency="${esc(item.id)}" role="status" ${warnings[item.id]?'':'hidden'}>${esc(warnings[item.id]||'')}</p>
          ${s.errorSuggestionId===item.id?`<p class="ob-error" role="alert">${esc(s.error)}</p>`:''}
          ${item.kind==='relation'?`<p>方向：${esc((item.source_types||[]).join('、'))} → ${esc((item.target_types||[]).join('、'))}</p>`:''}
          ${item.kind==='property'?`<p>属性归属：${esc(item.owner_kind)} / ${esc(item.owner_name)}</p>`:''}
          <details class="ob-rule-evidence"><summary>查看建议依据</summary><p>理由：${esc(item.reason)}</p><blockquote>回答依据：${esc(item.evidence?.quote)}</blockquote>${item.policy_note?`<p>${esc(item.policy_note)}</p>`:''}</details></div><div class="ob-rule-controls">
          <label>核对结果 <select data-rule-id="${esc(item.id)}" data-rule-field="action" ${blocked?'disabled':''}>
          ${[['','请修正此建议'],...(item.allow_new_type===false?[]:[['add','采用为新增定义']]),['reuse','复用已有定义'],['ignore','排除此建议']].map(([v,l])=>`<option value="${v}" ${c.action===v?'selected':''}>${l}</option>`).join('')}</select></label>
          ${c.action==='ignore'?'':target}${c.action==='add'?field('label','新增定义名称',c.label):''}</div></article>`;
        }).join('')}</div>
        <details class="ob-current-definitions"><summary>查看当前生效规则（复用目标）</summary>${ontologyDefinitionsHTML(w.base_ontology.schema,'ob-current')}</details>
      </section><aside class="ob-form-card ob-rule-preview" aria-label="完整本体预览">${rulePreviewHTML(review)}</aside></div>`:''}
    <div class="ob-footer">${button('back','返回建议',s.busy)}${button('refresh','重新读取进度',s.busy)}
    ${s.pending?button('retry','恢复原请求',s.busy||!s.loaded):''}
    ${p?'<button class="ob-button ob-primary" data-ob="enter-created" '+disabled+'>进入知识仓整理材料</button>':''}</div>`;
}
