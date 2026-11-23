import {ontologyChangesHTML, ontologyDefinitionsHTML, ontologyGraphHTML} from './onboarding-ontology-view.mjs';
import {scopeChangesHTML, scopeUnresolvedHTML} from './onboarding-scope-workspace.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[c]);

export function reviewVersionHTML(version) {
  return `<div class="od-review-version" aria-label="版本变化"><span>${Number.isSafeInteger(version)?'现行 v'+version:'现行规则'}</span><span aria-hidden="true">→</span><strong>待发布草稿</strong></div>`;
}

function groupedChanges(changes, schema, version) {
  if (!Array.isArray(changes)) return '<p class="wp-muted">当前盒端暂未提供差异明细。请展开完整规则核对。</p>';
  if (!changes.length) return `<p class="od-unchanged-rules"><strong>0 项改动</strong> · 沿用现行${Number.isSafeInteger(version)?' v'+version+' 规则':'规则'}</p>`;
  const groups = [
    ['added', '+', '新增', changes.filter(c => !c.before && c.after)],
    ['changed', '≈', '修改', changes.filter(c => c.before && c.after)],
    ['removed', '−', '停用', changes.filter(c => c.before && !c.after)],
  ];
  return groups.filter(([, , , entries]) => entries.length).map(([kind, sign, title, entries]) => {
    const entities = entries.filter(c => c.kind === 'entity_types').length;
    const relations = entries.length - entities;
    const quick = entries.slice(0,4).map(c => `<span>${escape((c.after || c.before).label || c.name)}</span>`).join('');
    return `<details class="od-change-group" data-kind="${kind}" id="od-review-${kind}" open>
      <summary><span class="od-change-sign" aria-hidden="true">${sign}</span><strong>${title} ${entries.length} 项</strong><small>${entities} 个实体 · ${relations} 个关系</small></summary>
      <div class="od-change-group-body">
        <div class="od-change-quick">${quick}${entries.length>4?`<small>另有 ${entries.length-4} 项</small>`:''}</div>
        <details><summary>核对${title}明细</summary>${ontologyChangesHTML(entries,schema)}</details>
      </div>
    </details>`;
  }).join('');
}

export function reviewChecklistHTML({snapshot,preview,version,scopeEdit='',showDraft='',actions,notice='',scopeOnly=false,deferredQuestionId=null}) {
  const questions = (preview.question_states || preview.questions || []).filter(q =>
    !q.status || ['pending','deferred','skipped','uncertain'].includes(q.status));
  const items = (preview.scope.uncertain_items || []).filter(item => !questions.some(q => q.text === item));
  const count = questions.length + items.length;
  return `<div class="od-final-review">
    <div class="od-review-columns">
      <section aria-label="范围变化">
        <header class="od-checklist-heading"><h2>范围变化</h2>${scopeEdit}</header>
        ${scopeChangesHTML(snapshot,preview)}
        <details class="od-review-pending" id="od-review-pending">
          <summary>${count ? count+' 项待确认' : '暂无待确认项'}</summary>
          <div class="od-unresolved">${scopeUnresolvedHTML(questions,items,deferredQuestionId)}</div>
        </details>
      </section>
      <section aria-label="规则差异">
        <header class="od-checklist-heading"><h2>规则差异</h2>${showDraft}</header>
        ${scopeOnly?groupedChanges([],{},version):groupedChanges(preview.changes,preview.schema,version)}
        ${!scopeOnly? `<details class="od-review-all-rules" id="od-review-definitions"><summary>查看完整规则与关系图</summary>
          ${ontologyGraphHTML(preview.schema,preview.changes||[],'od-review-graph')}${ontologyDefinitionsHTML(preview.schema,'od-review-graph')}
        </details>`:''}
      </section>
    </div>
    <p class="od-review-impact"><strong>发布后</strong> ${scopeOnly?'本仓适用范围将更新，现行规则继续生效。':'新资料按本次核对的规则整理。'} 已有资料可另行重抽取。</p>
    ${notice?`<p class="wp-muted od-review-notice">${notice}</p>`:''}
    <div class="od-review-footer">${actions}</div>
  </div>`;
}
