export const graphTools = {
  audit: '规则校验', path: '两点路径', time: '时间回放', source: '来源透镜',
  duplicates: '重名核对', review: '待核清单', bookmarks: '视角书签',
};

export function ruleAssessment(edge, nodes, ontology) {
  if (!ontology?.schema) return {status: 'unavailable', label: '已发布本体暂不可用'};
  const source = nodes.get(edge.s)?.type, target = nodes.get(edge.t)?.type;
  const rule = (ontology.schema.relation_types || []).find(item => item.name === edge.relation_type);
  const matches = rule?.source_types?.includes(source) && rule?.target_types?.includes(target);
  if (matches) return {status: 'matches', rule, label: '符合当前已发布规则'};
  const recorded = edge.ontology_version_id;
  const historical = recorded && ontology.id && recorded !== ontology.id;
  const current = recorded && ontology.id && recorded === ontology.id;
  return historical ? {status: 'historical', label: '按另一版本本体入图，当前规则无匹配'} :
    current ? {status: 'flagged', label: '当前版本无对应规则，请核对'} :
      {status: 'unmatched', label: '当前规则无匹配，入图时本体版本未知'};
}

export function shortestGraphPath(graph, from, to) {
  if (!from || !to || from === to) return [];
  const neighbors = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    neighbors.get(edge.s)?.push([edge.t, edge]);
    neighbors.get(edge.t)?.push([edge.s, edge]);
  }
  const previous = new Map([[from, null]]), queue = [from];
  for (let i = 0; i < queue.length && !previous.has(to); i++) {
    const id = queue[i];
    for (const [next, edge] of neighbors.get(id) || []) {
      if (previous.has(next)) continue;
      previous.set(next, {id, edge});
      queue.push(next);
    }
  }
  if (!previous.has(to)) return [];
  const path = [];
  for (let id = to; id !== from;) {
    const step = previous.get(id);
    path.unshift(step.edge);
    id = step.id;
  }
  return path;
}

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) && Number.isFinite(Date.parse(value))
    ? value.slice(0, 10) : '';
}

export const documentDate = doc => date(doc?.document_date || doc?.source_date);
export const publicationDate = edge => date(edge.ingested_at || edge.published_at || edge.first_published_at);
export const importDate = doc => date(doc?.imported_at || doc?.created_at);

export function factDate(edge, mode, docs) {
  if (mode === 'graph') return publicationDate(edge);
  const read = mode === 'import' ? importDate : documentDate;
  return edge.evidence.map(record => read(docs.get(record.document_id))).filter(Boolean).sort()[0] || '';
}

export function graphTimeline(graph, mode, docs) {
  const dates = new Map(graph.edges.map(edge => [edge.id, factDate(edge, mode, docs)]));
  return {dates, days: [...new Set([...dates.values()].filter(Boolean))].sort(),
    unknown: [...dates.values()].filter(value => !value).length};
}

export function graphAliases(node) {
  let aliases = node.aliases;
  if (!Array.isArray(aliases)) {
    try { aliases = JSON.parse(node.aliases_json || '[]'); }
    catch { aliases = []; }
  }
  return Array.isArray(aliases) ? [...new Set(aliases.filter(value => typeof value === 'string' && value.trim()))] : [];
}

function entityNames(node) {
  return [node.name, ...graphAliases(node)].filter(value => typeof value === 'string')
    .map(value => value.normalize('NFKC').toLocaleLowerCase().replace(/[（(][^）)]*[）)]/g, '').replace(/[\p{P}\s]/gu, ''))
    .filter(value => value.length >= 2);
}

export const duplicateKey = (a, b) => JSON.stringify([a, b].sort());
export function duplicatePairs(nodes, decisions = {}) {
  const occurrences = new Map(), pairs = new Map();
  for (const node of nodes) for (const name of new Set(entityNames(node))) {
    const matches = occurrences.get(name) || [];
    for (const other of matches) {
      const id = duplicateKey(node.id, other.id);
      if (!pairs.has(id)) pairs.set(id, {id, a: other, b: node, sameType: other.type === node.type, decision: decisions[id]});
    }
    matches.push(node);
    occurrences.set(name, matches);
  }
  return [...pairs.values()].sort((a, b) => Number(b.sameType) - Number(a.sameType));
}

export function mergeNeighborhood(base, addition, center, parents) {
  const incoming = new Map(addition.nodes.map(node => [node.id, node]));
  const nodes = new Map(base.nodes.map(node => [node.id, node]));
  const edges = new Map(base.edges.map(edge => [edge.id, edge]));
  for (const edge of addition.edges) {
    if ((edge.s !== center && edge.t !== center) || !incoming.has(edge.s) || !incoming.has(edge.t)) continue;
    for (const id of [edge.s, edge.t]) {
      if (!nodes.has(id)) parents.set(id, center);
      nodes.set(id, incoming.get(id));
    }
    edges.set(edge.id, edge);
  }
  return {nodes: [...nodes.values()], edges: [...edges.values()]};
}

export function safeCamera(value) {
  if (!value || !['yaw','pitch','zoom','panX','panY'].every(key => Number.isFinite(value[key]))) return null;
  return {yaw: value.yaw % (Math.PI * 2), pitch: Math.max(-.66, Math.min(.66, value.pitch)),
    zoom: Math.max(.25, Math.min(4, value.zoom)), panX: Math.max(-8000, Math.min(8000, value.panX)),
    panY: Math.max(-8000, Math.min(8000, value.panY))};
}

export function readGraphNotes(storage, key) {
  try {
    const saved = key && JSON.parse(storage.getItem(key) || 'null');
    return {review: Array.isArray(saved?.review) ? saved.review : [], bookmarks: Array.isArray(saved?.bookmarks) ? saved.bookmarks : [],
      decisions: saved?.decisions && typeof saved.decisions === 'object' ? saved.decisions : {}};
  } catch { return {review: [], bookmarks: [], decisions: {}}; }
}
