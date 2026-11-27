export function overviewHTML({warehouse, goal, canEditGoal, ontology, documents, setup, pending, esc, date}) {
  if (!warehouse) return '<div class="empty">请从「我的项目」选择或新建一张星图。</div>';
  const goalText = goal === undefined ? '正在读取星图目标…' : goal === null ? '暂时无法读取星图目标。' : goal || '尚未填写目标。';
  const counts = [['资料', warehouse.document_count], ['实体', warehouse.entity_count], ['关系', warehouse.relation_count]];
  const metrics = counts.map(([label, count]) => `<div><dt>${label}</dt><dd>${esc(count ?? '—')}</dd></div>`).join('');
  const recent = [...documents].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 4);
  const documentRows = recent.map(document => `<li><button type="button" class="text-link" data-overview-document="${esc(document.id)}">${esc(document.original_name)}</button>${document.created_at ? `<time class="muted">${esc(date(document.created_at))}</time>` : ''}</li>`).join('');
  const work = setup ? '<p>完成首份资料的导入和核对，就可以打开星图。</p><button type="button" class="btn btn-primary" data-action="first-starlink-resume">继续建立星图</button>'
    : pending?.length ? `<p>${pending.length} 份已加载资料待核对。</p><ul class="overview-documents">${pending.slice(0, 4).map(item => `<li><button type="button" class="text-link" data-overview-document="${esc(item.document_id)}">${esc(item.document.original_name)}</button></li>`).join('')}</ul>`
    : `<p class="muted">${pending ? '最近加载的资料没有待核对项。' : '可在资料库查看待核对的资料。'}</p>`;
  return `<div class="starlink-overview">
    <section class="overview-goal"><header><h2>星图目标</h2><div class="overview-goal-actions">
      ${canEditGoal ? `<button type="button" class="text-link" data-action="edit-warehouse-goal">${goal === '' ? '填写目标' : '编辑目标'}</button>` : ''}
      <button type="button" class="text-link" data-view="ontology">查看本体</button></div></header>
      <p>${esc(goalText)}</p></section>
    <section><header><h2>当前快照</h2><button type="button" class="text-link" data-view="graph">打开星图</button></header>
      <dl class="overview-numbers">${metrics}</dl>
      ${ontology ? `<p class="muted">本体 v${esc(ontology.version_number)} · ${esc(ontology.name)}</p>` : ''}</section>
    <section><header><h2>待处理</h2><button type="button" class="text-link" data-view="tasks">处理任务${warehouse.active_jobs ? ` · ${esc(warehouse.active_jobs)}` : ''}</button></header>${work}</section>
    <section class="overview-goal"><header><h2>最近导入</h2><button type="button" class="text-link" data-view="conversation">打开资料库</button></header>
      ${documentRows ? `<ul class="overview-documents">${documentRows}</ul>` : '<p class="muted">导入资料后，会在这里显示最近材料。</p>'}</section>
  </div>`;
}

function entityProperties(entity, definition, esc) {
  let properties = entity.properties ?? entity.properties_json;
  if (typeof properties === 'string') {
    try { properties = JSON.parse(properties); } catch { properties = null; }
  }
  const labels = new Map((definition?.properties || []).map(property => [property.name, property.label || property.name]));
  return Object.entries(properties && typeof properties === 'object' && !Array.isArray(properties) ? properties : {})
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `<div><dt>${esc(labels.get(key) || key)}</dt><dd>${esc(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`).join('');
}

export function knowledgeHTML({graph, selected, query, schema, presentation, esc, documentName}) {
  const entities = [...graph.nodes].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const nodes = new Map(entities.map(node => [node.id, node]));
  const label = node => presentation.entity(node.type).label;
  const needle = query.trim().toLocaleLowerCase();
  const matches = entities.filter(node => `${node.name} ${label(node)}`.toLocaleLowerCase().includes(needle));
  const entity = nodes.get(selected) || matches[0];
  const list = matches.map(node => `<button type="button" class="knowledge-item" data-entity-page="${esc(node.id)}"${node.id === entity?.id ? ' aria-current="true"' : ''}><span class="type-dot" style="--type-color:${presentation.entity(node.type).color}"></span><span>${esc(node.name)}</span><small>${esc(label(node))}</small></button>`).join('');
  if (!entity) {
    const message = entities.length ? '没有匹配的实体。' : '导入资料并形成知识后，将在这里显示实体页。';
    return {list: list || `<div class="empty">${message}</div>`, reader: `<div class="empty">${message}</div>`};
  }
  const definition = (schema?.entity_types ?? []).find(type => type.name === entity.type);
  const properties = entityProperties(entity, definition, esc);
  const relations = graph.edges.filter(edge => edge.s === entity.id || edge.t === entity.id);
  const facts = relations.map(edge => `<button type="button" class="fact-btn" data-edge="${esc(edge.id)}"><span class="fact-text">${esc(nodes.get(edge.s)?.name)} <span class="fact-relation">→ ${esc(edge.label)} →</span> ${esc(nodes.get(edge.t)?.name)}<small>${edge.evidence.length} 个来源片段</small></span></button>`).join('');
  const uniqueEvidence = new Map();
  for (const edge of relations) edge.evidence.forEach((source, index) => {
    if (!source.document_id) return;
    const key = JSON.stringify([source.document_id, source.document_version_id || source.version_id, source.segment_id, source.locator_json ?? source.locator, source.excerpt]);
    if (!uniqueEvidence.has(key)) uniqueEvidence.set(key, {source, edge, index});
  });
  const sources = [...uniqueEvidence.values()].map(({source, edge, index}) => `<li><button type="button" class="text-link" data-source="${esc(source.document_id)}" data-edge-source="${esc(edge.id)}" data-evidence-index="${index}">${esc(documentName(source.document_id))}</button>${source.excerpt ? `<p>${esc(source.excerpt)}</p>` : ''}</li>`).join('');
  const reader = `<header><div><span class="knowledge-type">${esc(label(entity))}</span><h2>${esc(entity.name)}</h2></div><button type="button" class="btn btn-secondary" data-entity-in-graph="${esc(entity.id)}">在星图中查看</button></header>
    <section class="knowledge-section"><h3>属性</h3>${properties ? `<dl>${properties}</dl>` : '<p class="muted">暂无已记录的属性。</p>'}</section>
    <section class="knowledge-section"><header><h3>相关关系</h3><span class="muted">${relations.length} 条</span></header>${facts || '<p class="muted">暂无已入图的关系。</p>'}</section>
    <section class="knowledge-section"><h3>关系中的原文依据</h3>${sources ? `<ul class="knowledge-evidence">${sources}</ul>` : '<p class="muted">暂无可追溯的关系来源。</p>'}</section>`;
  return {list: list || '<div class="empty">没有匹配的实体。</div>', reader};
}
