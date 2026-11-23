const escape = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

const example = {
  title: '产品评审纪要（示例）',
  source: {text:'评审通过了「资料阅读台」需求。产品说明需记录这项决策和对应的评审纪要。'},
  entities: [{name:'资料阅读台',type:'需求'},{name:'产品说明',type:'材料'}],
  relations: [{source:'资料阅读台',predicate:'记录于',target:'产品说明'}],
};

function compare(result, illustrative = false) {
  return `<div class="od-trial-compare">
    <article><h4>${escape(result.title)}</h4><blockquote>${escape(result.source.text)}</blockquote></article>
    <article><h4>${illustrative ? '示例展示' : '候选结果'}</h4>
      ${result.partial_results ? '<p class="wp-muted">候选结果仅覆盖部分内容。</p>' : ''}
      ${!result.entities.length && !result.relations.length ? `<p class="wp-muted">${result.partial_results?'暂未得到可展示的候选，请核对正文后重试。':'这段正文未找到符合草稿的候选。'}</p>` : ''}
      <ul>${result.entities.map(e => `<li>${escape(e.name)} <small>${escape(e.type)}</small></li>`).join('')}
        ${result.relations.map(r => `<li>${escape(r.source)} → ${escape(r.predicate)} → ${escape(r.target)}</li>`).join('')}</ul>
    </article>
  </div>`;
}

export function trialHTML({ready, busy, documents, documentId, result, error, outdated, nextOffset}) {
  const disabled = busy || !ready;
  return `<section class="od-trial" aria-label="试跑一份材料"><h3>试跑一份材料</h3>
    <p class="wp-muted">用选定材料的首段正文试跑草稿，核对模型识别出的实体与关系。结果仅供预览。</p>
    ${documents == null || error && !documents?.length ? `<button type="button" class="btn btn-secondary" data-od="trial-load" ${disabled ? 'disabled' : ''}>选择本仓资料</button>` : ''}
    ${documents?.length ? `<div class="od-trial-actions"><label for="od-trial-document">材料</label><select class="form-input" id="od-trial-document" ${busy ? 'disabled' : ''}>
      <option value="">请选择</option>${documents.map(doc => `<option value="${escape(doc.id)}" ${doc.id === documentId ? 'selected' : ''}>${escape(doc.title)}</option>`).join('')}
      </select><button type="button" class="btn btn-secondary" data-od="trial-run" ${disabled || !documentId ? 'disabled' : ''}>${result ? '重新试跑' : '运行预览'}</button></div>
      <p class="wp-muted">试跑会把这段正文交给本仓配置的抽取模型。</p>` : ''}
    ${nextOffset ? `<button type="button" class="btn btn-secondary" data-od="trial-more" ${disabled ? 'disabled' : ''}>加载更多资料</button>` : ''}
    ${busy ? '<p role="status">正在准备试跑…</p>' : ''}
    ${error ? `<p role="alert">${escape(error)}</p>` : ''}
    ${documents?.length === 0 && !error && !nextOffset ? `<details id="od-trial-example" open><summary>本仓暂无可试跑的正文 · 查看虚构示例</summary>${compare(example, true)}</details>` : ''}
    ${outdated ? '<p class="wp-muted">草稿已调整，可以重新试跑查看结果。</p>' : ''}
    ${result ? compare(result) : ''}
  </section>`;
}
