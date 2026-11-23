import {documentDate, duplicatePairs, graphAliases, graphTimeline, graphTools, importDate, mergeNeighborhood,
  publicationDate, readGraphNotes, ruleAssessment, safeCamera, shortestGraphPath} from './graph-exploration.mjs';

export function createGraphExploration({state, pick, esc, call, readReply, present, motion, redraw, selectEdge, notice, typeDisplay}) {
  const inventory = new Set(Object.keys(graphTools));
  const types = () => state.graphOntology?.schema?.entity_types || [];
  const enabled = () => state.ready && state.warehouseId && !state.invalid && !state.preview &&
    state.identity?.dataScope === 'personal';
  const storageKey = () => enabled() && JSON.stringify(['xingtu.graph-exploration.v1',
    state.identity.boxId, state.identity.user.id, state.warehouseId]);
  const emptyState = () => ({active:'', type:'', from:'', to:'', selectedPair:'', source:'', dateMode:'graph',
    day:'', details:false, parents:new Map(), expanded:new Map(), expanding:false, relationType:'', neighborType:'', revision:0});
  let view = emptyState(), pendingCamera;
  const reset = () => { view = emptyState(); pendingCamera = undefined; };
  const resetExpansion = () => { view.parents.clear(); view.expanded.clear(); };
  const nodes = () => new Map(state.graph.nodes.map(node => [node.id, node]));
  const facts = () => new Map(state.graph.edges.map(edge => [edge.id, edge]));
  const sources = () => new Map(state.documents.map(item => [item.id,item]));
  const relationText = (edge, lookup = nodes()) =>
    `${lookup.get(edge.s)?.name || '实体'} → ${edge.label} → ${lookup.get(edge.t)?.name || '实体'}`;
  const note = () => readGraphNotes(localStorage, storageKey());
  function write(value) {
    const key = storageKey();
    if (!key) throw new Error('当前数据仓不可用');
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { throw Object.assign(new Error('本机无法保存此记录'), {publicMessage:'本机无法保存此记录'}); }
  }
  const section = (title, body) => `<section class="detail-section"><div class="section-caption"><span>${title}</span></div>${body}</section>`;
  const small = message => `<p class="detail-empty">${esc(message)}</p>`;
  const button = (action, label, id = '', extra = '') =>
    `<button type="button" class="btn btn-secondary graph-explore-button" data-explore="${action}" data-value="${esc(id)}" ${extra}>${esc(label)}</button>`;
  const factList = (edges, lookup) => edges.map(edge =>
    `<button type="button" class="fact-btn" data-explore="fact" data-value="${esc(edge.id)}"><span class="fact-text">${esc(relationText(edge, lookup))}</span></button>`).join('');

  function typeRules(type) {
    const rules = state.graphOntology?.schema?.relation_types || [];
    return rules.flatMap(rule => {
      const rows = [];
      if (rule.source_types?.includes(type)) for (const target of rule.target_types || []) rows.push({source:type, target, rule});
      if (rule.target_types?.includes(type)) for (const source of rule.source_types || []) {
        if (source !== type) rows.push({source, target:type, rule});
      }
      return rows;
    });
  }
  function selectType(type) {
    if (!enabled()) return;
    view.type = type === 'all' ? '' : type;
    view.relationType = '';
    view.active = '';
    view.details = Boolean(view.type);
    state.selectedNode = state.selectedEdge = null;
    state.detailsDismissed = false;
    redraw();
  }
  function activate(tool) {
    if (!enabled() || !inventory.has(tool)) return;
    view.active = view.active === tool && view.details ? '' : tool;
    view.type = '';
    view.relationType = '';
    view.details = Boolean(view.active);
    state.detailsDismissed = false;
    if (view.active === 'path' && !view.from && state.selectedNode) view.from = state.selectedNode;
    if (view.active === 'time' && !view.day && !graphTimeline(state.graph,view.dateMode,sources()).days.length)
      view.dateMode = ['graph','source','import'].find(mode => graphTimeline(state.graph,mode,sources()).days.length) || 'graph';
    redraw();
  }
  function close() {
    view.details = false;
    view.active = '';
    if (view.type) view.type = '';
    view.relationType = '';
  }
  function menu() {
    const menu = pick('#graph-explore-menu');
    menu.hidden = !enabled();
    if (!enabled()) return;
    const choices = pick('#graph-explore-choices');
    if (!choices.childElementCount) choices.innerHTML = Object.entries(graphTools)
      .map(([id,label]) => button('activate',label,id)).join('');
    for (const item of choices.querySelectorAll('button')) item.setAttribute('aria-pressed',String(item.dataset.value === view.active));
  }
  function setPathNode(id, end) {
    if (!nodes().has(id)) return;
    view.active = 'path';
    view.details = true;
    if (end) view.to = id;
    else { view.from = id; view.to = ''; }
    state.detailsDismissed = false;
    redraw();
  }
  function takePathNode(id, shift) {
    if (!enabled() || !shift) return false;
    setPathNode(id, view.active === 'path' && Boolean(view.from) && !view.to);
    return true;
  }
  function sourceChoice(id) {
    if (!id) return;
    view.active = 'source';
    view.source = id;
    view.details = true;
    state.detailsDismissed = false;
    redraw();
  }
  function relsForSource(graph, id) {
    return graph.edges.filter(edge => edge.evidence.some(item => item.document_id === id));
  }
  function appearance(graph) {
    const lookup = new Map(graph.nodes.map(node => [node.id, node]));
    const markedNodes = new Set(), markedEdges = new Set(), omitted = new Set(), omittedNodes = new Set();
    const edgeClasses = new Map(), nodeClasses = new Map();
    const pair = view.active === 'duplicates' ? duplicatePairs(graph.nodes, note().decisions).find(pair => pair.id === view.selectedPair) : null;
    let highlight = false, path = [];
    function mark(edges) {
      for (const edge of edges) {
        markedEdges.add(edge.id);
        markedNodes.add(edge.s); markedNodes.add(edge.t);
      }
    }
    if (view.type) {
      highlight = true;
      for (const node of graph.nodes) if (node.type === view.type) markedNodes.add(node.id);
      const selectedRule = view.relationType ? JSON.parse(view.relationType) : null;
      const matching = selectedRule ? graph.edges.filter(edge => edge.relation_type === selectedRule[1] &&
        lookup.get(edge.s)?.type === selectedRule[0] && lookup.get(edge.t)?.type === selectedRule[2]) :
        graph.edges.filter(edge => markedNodes.has(edge.s) || markedNodes.has(edge.t));
      mark(matching);
    }
    if (view.active === 'path') {
      path = shortestGraphPath(graph, view.from, view.to);
      for (const id of [view.from, view.to]) if (lookup.has(id)) markedNodes.add(id);
      mark(path);
      for (const edge of path) edgeClasses.set(edge.id, 'explore-path');
      highlight = Boolean(path.length || view.from);
    }
    if (view.active === 'source' && view.source) {
      highlight = true;
      mark(relsForSource(graph, view.source));
    }
    if (view.active === 'audit') {
      const known = new Set(types().map(type => type.name));
      for (const node of graph.nodes) if (known.size && !known.has(node.type)) nodeClasses.set(node.id,'explore-missing-type');
      for (const edge of graph.edges) {
        const {status} = ruleAssessment(edge, lookup, state.graphOntology);
        if (['historical','flagged','unmatched'].includes(status)) edgeClasses.set(edge.id,`explore-${status}`);
      }
    }
    if (pair) {
      highlight = true;
      markedNodes.add(pair.a.id); markedNodes.add(pair.b.id);
    }
    if (view.active === 'time' && view.day) {
      const {dates} = graphTimeline(graph, view.dateMode, sources());
      for (const [id, value] of dates) {
        if (!value || value > view.day) omitted.add(id);
        else if (value === view.day) edgeClasses.set(id, 'explore-time-new');
      }
      const shown = new Set(graph.edges.filter(edge => !omitted.has(edge.id)).flatMap(edge => [edge.s,edge.t]));
      for (const node of graph.nodes) if (!shown.has(node.id)) omittedNodes.add(node.id);
    }
    const queued = new Set(note().review.map(item => item.id));
    return {highlight, markedNodes, markedEdges, omitted, omittedNodes, edgeClasses, nodeClasses, path, pair, queued};
  }

  function renderLayer(graph, look = appearance(graph)) {
    if (!enabled() || !view.details) return '';
    const lookup = new Map(graph.nodes.map(node => [node.id, node])), loaded = facts();
    if (!view.active && view.type) {
      const definition = types().find(item => item.name === view.type);
      const members = graph.nodes.filter(node => node.type === view.type);
      const rules = typeRules(view.type);
      return section(esc(typeDisplay(view.type).label), (definition?.definition ? small(definition.definition) : '') +
        small(members.length ? `图上有 ${members.length} 个此类型实例` : '本次未加载此类型实例') +
        (definition ? rules.map(({source,target,rule}) => button('rule',
          `${typeDisplay(source).label} → ${rule.label || rule.name} → ${typeDisplay(target).label}`,
          JSON.stringify([source,rule.name,target]))).join('') || small('当前本体未定义此类型的关系。') :
          small(state.graphOntology?.schema ? '当前发布本体未定义此类型。' : '已发布本体暂不可用。')));
    }
    if (view.active === 'audit') {
      const differences = graph.edges.filter(edge => look.edgeClasses.has(edge.id));
      const historical = differences.filter(edge => look.edgeClasses.get(edge.id)==='explore-historical').length;
      const flagged = differences.filter(edge => look.edgeClasses.get(edge.id)==='explore-flagged').length;
      return section('规则校验', state.graphOntology?.schema ? small(`当前已加载 ${graph.edges.length} 条关系 · 待核对 ${flagged} · 历史版本 ${historical} · 版本未知 ${differences.length-flagged-historical} · 未匹配类型 ${look.nodeClasses.size}`) +
        factList(differences,lookup) : small('当前已发布本体暂不可用。'));
    }
    if (view.active === 'path') {
      const options = (selected) => '<option value="">选择实例</option>' + graph.nodes.map(node =>
        `<option value="${esc(node.id)}"${node.id === selected ? ' selected' : ''}>${esc(node.name)} · ${esc(typeDisplay(node.type).label)}</option>`).join('');
      return section('两点路径', `<div class="graph-explore-fields">
        <label>起点<select data-explore-change="from">${options(view.from)}</select></label>
        <label>终点<select data-explore-change="to">${options(view.to)}</select></label></div>` +
        (look.path.length ? small(`${look.path.length} 跳 · 保留每条事实的原始方向`) + factList(look.path,lookup) :
          small(view.from && view.from === view.to ? '请选择两个不同的实例。' :
            view.from && view.to ? '当前可见、已加载的关系里未找到路径。' : '选择两个实例，或按住 Shift 依次点图中两个实例。')));
    }
    if (view.active === 'time') {
      const {days, unknown} = graphTimeline(graph, view.dateMode, sources());
      return section('时间回放', `<div class="graph-explore-fields"><label>时间依据<select data-explore-change="dateMode">${[['graph','事实入图时间'],['source','资料日期'],['import','资料导入时间']].map(([value,label]) =>
        `<option value="${value}"${view.dateMode === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        ${days.length ? `<label>${view.day ? '显示截至 ' + esc(view.day) : '全部已加载关系'}<input type="range" min="0" max="${days.length}" value="${view.day ? Math.max(0,days.indexOf(view.day)) : days.length}" data-explore-change="day"></label>` : ''}</div>` +
        small(days.length ? `当前已加载范围 · ${unknown} 条时间未知${view.day ? '，回放时已收起' : ''}` : '盒子未返回可用于此时间口径的日期，请选择另一种时间依据。') +
        (view.day ? button('time-reset','恢复当前全图') : ''));
    }
    if (view.active === 'source') {
      const docs = sources();
      const available = [...new Set(graph.edges.flatMap(edge => edge.evidence.map(item => item.document_id)).filter(Boolean))];
      const evidence = relsForSource(graph,view.source), material = docs.get(view.source);
      const dates = [...new Set(evidence.map(publicationDate).filter(Boolean))].sort();
      const counts = new Map();
      for (const edge of evidence) counts.set(edge.label, (counts.get(edge.label) || 0) + 1);
      const options = '<option value="">选择来源</option>' + available.map(id =>
        `<option value="${esc(id)}"${id === view.source ? ' selected' : ''}>${esc(docs.get(id)?.original_name || '来源材料 · ' + id.slice(0,8))}</option>`).join('');
      return section('来源透镜', `<div class="graph-explore-fields"><label>资料<select data-explore-change="source">${options}</select></label></div>` +
        (view.source ? small(`当前已加载关系 ${evidence.length} 条 · 资料日期 ${documentDate(material) || '未知'} · 导入时间 ${importDate(material) || '未知'} · 事实入图时间 ${dates.length ? [...new Set([dates[0],dates.at(-1)])].join(' 至 ') : '未知'}`) +
          small([...counts].map(([label,count]) => `${label} ${count} 条`).join(' · ')) +
          factList(evidence,lookup) : small('选择一份资料，高亮引用它的已记录关系。')));
    }
    if (view.active === 'duplicates') {
      const candidates = duplicatePairs(graph.nodes,note().decisions), pair = look.pair;
      const factsFor = id => graph.edges.filter(edge => edge.s === id || edge.t === id);
      return section('疑似同一实体', pair ? small(pair.sameType ? '类型相同，可对照关系。' : '类型不同，可能只是同名。') +
        [pair.a,pair.b].map(node => `<div class="source-card"><strong>${esc(node.name)} · ${esc(typeDisplay(node.type).label)}</strong>
          ${small('别名 · ' + (graphAliases(node).join('、') || '暂无'))}${factList(factsFor(node.id),lookup) || small('当前未加载直接关系。')}</div>`).join('') +
        small(pair.decision === 'same' ? '本机记录：同一实体' : pair.decision === 'different' ? '本机记录：不同实体' : '待判断') +
        button('duplicate-same','标为同一实体',pair.id) + button('duplicate-different','标为不同实体',pair.id) + button('duplicate-clear','返回候选')
        : small(`当前已加载范围 · ${candidates.length} 组候选`) + candidates.slice(0,80).map(pair =>
          button('duplicate-pick',`${pair.a.name} / ${pair.b.name}${pair.decision ? ' · 已核对' : ''}`,pair.id)).join('') +
        (candidates.length > 80 ? small('当前显示前 80 组，可筛选实体类型缩小范围。') : ''));
    }
    if (view.active === 'review') {
      const review = note().review;
      return section('待核清单', review.length ? button('review-export','导出待核清单') + review.map(item =>
        `<div class="source-card"><strong>${esc(loaded.has(item.id) ? relationText(loaded.get(item.id)) : '当前未加载的关系')}</strong>${small(item.reason)}
        ${small(`标记时规则版本 ${item.ontologyVersion || '未知'}`)}${loaded.has(item.id) ? button('saved-fact','回到关系',item.id) : ''}
        ${button('review-remove','移出清单',item.id)}</div>`).join('') : small('从一条关系的详情加入待核，之后可以集中查看。'));
    }
    if (view.active === 'bookmarks') {
      const items = note().bookmarks;
      return section('视角书签', `<form id="graph-bookmark-form" class="graph-explore-fields"><label>书签名<input name="label" maxlength="70" required></label>
        <label>备注<input name="note" maxlength="280"></label><button type="submit" class="btn btn-secondary">保存当前视角</button></form>
        <label class="graph-bookmark-import">打开视角文件<input type="file" accept=".json,application/json" data-explore-change="bookmark-file"></label>` +
        items.map(item => `<div class="source-card"><strong>${esc(item.label)}</strong>${item.note ? small(item.note) : ''}
          ${button('bookmark-open','恢复视角',item.id)}${button('bookmark-export','导出视角',item.id)}${button('bookmark-remove','删除书签',item.id)}</div>`).join(''));
    }
    return '';
  }
  function nodeControls(node) {
    if (!enabled() || !node) return '';
    const count = state.graph.edges.filter(edge => edge.s === node.id || edge.t === node.id).length;
    const read = view.expanded.get(JSON.stringify([node.id,expansionKind(node)]));
    const known = read?.total ?? (Number.isSafeInteger(node.total_relationship_count) && node.total_relationship_count >= count ? node.total_relationship_count : null);
    const canRead = read?.limit !== 500 && (known == null || known > count);
    const kinds = [...new Map(typeRules(node.type).map(({rule}) => [rule.name,rule.label || rule.name]))];
    return `<div class="graph-explore-node-controls">${button('path-start','设为路径起点',node.id)}
      ${kinds.length ? `<label class="graph-explore-fields">展开范围<select data-explore-change="neighborType">
        <option value="">全部关系类型</option>${kinds.map(([key,label]) => `<option value="${esc(key)}"${key === view.neighborType ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>` : ''}
      ${button('expand',view.expanding ? '正在读取一跳关联…' : '展开一跳',node.id,view.expanding || !canRead ? 'disabled' : '')}
      <small>${count} 条已加载${known != null ? ` / 共 ${known} 条` : ' · 总数未知'}${read?.added === 0 ? ' · 本次未返回更多关系' : ''}</small></div>`;
  }
  function edgeControls(edge) {
    if (!enabled() || !edge) return '';
    const lookup = nodes(), {rule,label} = ruleAssessment(edge,lookup,state.graphOntology);
    const version = state.graphOntology?.version_number;
    const direction = rule ? `${typeDisplay(lookup.get(edge.s)?.type).label} → ${rule.label || rule.name} → ${typeDisplay(lookup.get(edge.t)?.type).label}` : label;
    const exists = note().review.some(item => item.id === edge.id);
    return section('已发布本体规则', small(direction + (version != null ? ` · v${version}` : '')) +
      (exists ? button('activate','查看待核清单','review') : `<form id="graph-review-form" class="graph-explore-fields">
        <label>待核原因<input name="reason" maxlength="280" placeholder="可选"></label>
        <button type="submit" class="btn btn-secondary">加入待核</button></form>`));
  }
  function boundary(node, count) {
    const recorded = view.expanded.get(JSON.stringify([node.id,'']))?.total ?? node.total_relationship_count;
    return Number.isSafeInteger(recorded) && recorded > count;
  }
  function expansionKind(node) {
    return typeRules(node.type).some(({rule})=>rule.name === view.neighborType) ? view.neighborType : '';
  }
  function exportJson(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url; link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  function snapshot() {
    return {camera:motion.camera(), mode:state.mode, query:pick('#graph-query').value, type:state.type,
      selectedNode:state.selectedNode, selectedEdge:state.selectedEdge, labelType:view.type, active:view.active,
      from:view.from,to:view.to,source:view.source,dateMode:view.dateMode,day:view.day, selectedPair:view.selectedPair,
      graphOverview:state.graphOverview,showIsolated:state.showIsolated, relationType:view.relationType};
  }
  function restore(item) {
    const available = nodes(), loaded = facts();
    pendingCamera = safeCamera(item.camera);
    state.type = [...available.values()].some(node => node.type === item.type) ? item.type : 'all';
    pick('#graph-query').value = typeof item.query === 'string' ? item.query.slice(0,150) : '';
    state.selectedNode = available.has(item.selectedNode) ? item.selectedNode : null;
    state.selectedEdge = loaded.has(item.selectedEdge) ? item.selectedEdge : null;
    state.graphOverview = item.graphOverview !== false;
    state.showIsolated = item.showIsolated === true;
    view.type = typeof item.labelType === 'string' && types().some(type => type.name === item.labelType) ? item.labelType : '';
    view.active = inventory.has(item.active) ? item.active : '';
    for (const key of ['from','to','source','day','selectedPair']) view[key] = typeof item[key] === 'string' ? item[key].slice(0,300) : '';
    view.dateMode = ['source','import'].includes(item.dateMode) ? item.dateMode : 'graph';
    view.relationType = typeRules(view.type).some(({source,target,rule}) => JSON.stringify([source,rule.name,target]) === item.relationType)
      ? item.relationType : '';
    view.details = Boolean(view.active || view.type);
    state.detailsDismissed = false;
    if (item.mode === 'graph' || item.mode === 'list') pick(`[data-mode="${item.mode}"]`).click();
    redraw();
  }
  function applyCamera() {
    if (pendingCamera && motion.restoreCamera(pendingCamera)) pendingCamera = undefined;
  }
  async function expand(id) {
    if (!enabled() || view.expanding || !nodes().has(id)) return;
    const generation = state.generation, previousView = view, kind = expansionKind(nodes().get(id));
    const scope = JSON.stringify([id,kind]);
    view.expanding = true;
    redraw();
    try {
      const limit = Math.min(500,(view.expanded.get(scope)?.limit || 60) * 2);
      const query = new URLSearchParams({limit:String(limit),entity_id:id});
      const raw = readReply(await call('workbench-request',{url:'/api/owner/graph?' + query,method:'GET'}));
      if (generation !== state.generation || view !== previousView || !enabled()) return;
      if (!Array.isArray(raw?.nodes) || !Array.isArray(raw?.edges)) throw new Error('图谱响应无效');
      const addition = present(raw);
      if (!addition.nodes.some(node => node.id === id)) throw Object.assign(new Error('关联实体已变化'),{publicMessage:'关联实体已变化，请重新读取星图。'});
      if (kind) addition.edges = addition.edges.filter(edge => edge.relation_type === kind);
      const count = state.graph.edges.length;
      state.graph = mergeNeighborhood(state.graph, addition, id, view.parents);
      const loaded = state.graph.edges.filter(edge => edge.s === id || edge.t === id).length;
      const total = Number.isSafeInteger(raw.total_relationships) && raw.total_relationships >= loaded ? raw.total_relationships : null;
      view.expanded.set(scope,{total,limit,added:state.graph.edges.length-count});
      view.revision++;
    } finally {
      if (generation === state.generation && view === previousView) { view.expanding = false; redraw(); }
    }
  }
  async function handle(action,id) {
    if (!enabled()) return;
    if (action === 'activate') {
      pick('#graph-explore-menu').open = false;
      if (id === 'bookmarks' && view.active !== 'bookmarks') view.bookmarkDraft = snapshot();
      activate(id);
      return;
    }
    if (action === 'expand') return expand(id);
    if (action === 'path-start') return setPathNode(id,false);
    if (action === 'source') return sourceChoice(id);
    if (action === 'fact') return selectEdge(id);
    if (action === 'saved-fact') {
      state.type = 'all'; state.graphOverview = false; state.showIsolated = true;
      pick('#graph-query').value = '';
      selectEdge(id); redraw();
      return;
    }
    if (action === 'type') return selectType(id);
    if (action === 'rule') view.relationType = view.relationType === id ? '' : id;
    if (action === 'time-reset') view.day = '';
    if (action === 'duplicate-pick') view.selectedPair = id;
    if (action === 'duplicate-clear') view.selectedPair = '';
    const saved = note();
    if (action === 'duplicate-same' || action === 'duplicate-different') {
      saved.decisions[id] = action.slice(10);
      write(saved);
    }
    if (action === 'review-remove') { saved.review = saved.review.filter(item => item.id !== id); write(saved); }
    if (action === 'review-export') return exportJson('星图待核清单.json',saved.review.map(item => ({
      ...item, relation:facts().has(item.id) ? relationText(facts().get(item.id)) : null})));
    const bookmark = saved.bookmarks.find(item => item.id === id);
    if (action === 'bookmark-open' && bookmark) return restore(bookmark);
    if (action === 'bookmark-export' && bookmark) return exportJson('星图视角.json',{version:1,warehouse:state.warehouseId, view:bookmark});
    if (action === 'bookmark-remove') { saved.bookmarks = saved.bookmarks.filter(item => item.id !== id); write(saved); }
    redraw();
  }
  function bind() {
    const root = pick('#view-graph');
    root.addEventListener('click',event => {
      const target = event.target.closest('[data-explore]');
      if (target) void handle(target.dataset.explore,target.dataset.value).catch(notice);
    });
    root.addEventListener('change',event => {
      const key = event.target.dataset.exploreChange;
      if (!enabled() || !key) return;
      const value = event.target.value;
      if (key === 'bookmark-file') {
        const generation = state.generation, file = event.target.files?.[0];
        if (!file || file.size > 24000) return;
        void file.text().then(text => {
          const item = JSON.parse(text);
          if (generation !== state.generation || !enabled()) return;
          if (item.version !== 1 || item.warehouse !== state.warehouseId || !item.view || !safeCamera(item.view.camera))
            throw Object.assign(new Error('视角文件不可用'),{publicMessage:'此视角文件不适用于当前仓库。'});
          restore(item.view);
        }).catch(notice);
        return;
      }
      if (key === 'day') view.day = graphTimeline(currentGraph,view.dateMode,sources()).days[Number(value)] || '';
      else view[key] = value;
      if (key === 'dateMode') view.day = '';
      redraw();
    });
    root.addEventListener('submit',event => {
      if (!['graph-bookmark-form','graph-review-form'].includes(event.target.id)) return;
      event.preventDefault();
      if (!enabled()) return;
      try {
        const fields = new FormData(event.target), saved = note();
        if (event.target.id === 'graph-bookmark-form') {
          const item = {...view.bookmarkDraft, id:crypto.randomUUID(), label:fields.get('label').trim(), note:fields.get('note').trim()};
          if (!item.label || !item.camera) throw Object.assign(new Error('无法保存视角'),{publicMessage:'请填写书签名称并切到 3D 视图。'});
          saved.bookmarks.push(item);
        } else if (facts().has(state.selectedEdge) && !saved.review.some(item => item.id === state.selectedEdge)) {
          saved.review.push({id:state.selectedEdge,reason:fields.get('reason').trim(),
            ontologyVersion:state.graphOntology?.version_number ?? null, addedAt:new Date().toISOString()});
        }
        write(saved); redraw();
      } catch (error) { notice(error); }
    });
  }
  let currentGraph;
  function layer(graph, appearance) {
    currentGraph = graph;
    return renderLayer(graph,appearance);
  }
  return {enabled, types, reset, resetExpansion, appearance, layer, nodeControls, edgeControls, bind, close, menu, boundary,
    expanded: id => [...view.expanded.keys()].some(key => JSON.parse(key)[0] === id),
    takePathNode, applyCamera, get keepsOverview() {return enabled() && Boolean(view.active || view.type);},
    get parents() {return view.parents;}, get revision() {return view.revision;}, get type() {return view.type;}};
}
