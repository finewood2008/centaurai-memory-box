// Display metadata never changes the entity/relation type supplied by the API.
export const DEFAULT_GRAPH_COLOR = '#7b8490';
const palette = ['#a65d43', '#587f71', '#af873f', '#627e92', '#8b708c', '#897961'];
const typeColor = code => {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return palette[hash % palette.length];
};
export function createGraphPresentation(schema) {
  const definitions = key => new Map((Array.isArray(schema?.[key]) ? schema[key] : [])
    .filter(d => typeof d?.name === 'string' && d.name.length)
    .map(d => [d.name, d]));
  const entities = definitions('entity_types'), relations = definitions('relation_types');
  const label = (map, code) => {
    const definition = map.get(code);
    return typeof definition?.label === 'string' && definition.label.trim() ? definition.label : String(code ?? '未标注类型');
  };
  return {
    entity(code) {
      const name = label(entities, code);
      return {label: name, symbol: [...name][0] || '?', color: entities.has(code) ? typeColor(code) : DEFAULT_GRAPH_COLOR};
    },
    relation(code) {return label(relations, code);},
  };
}

export function presentGraph(raw, presentation = createGraphPresentation()) {
  const nodes = (raw.nodes || []).map(n => ({...n,
    id: String(n.entity_id || n.id), name: String(n.canonical_name || n.name || '未命名实体'), type: n.entity_type,
  }));
  const ids = new Set(nodes.map(n => n.id));
  const edges = (raw.edges || []).map(e => ({...e,
    id: String(e.fact_id || e.id), s: String(e.subject_entity_id), t: String(e.object_entity_id),
    label: presentation.relation(e.relation_type), evidence: e.evidence || [],
  })).filter(e => ids.has(e.s) && ids.has(e.t));
  return {nodes, edges};
}

// A connection is a drawing of an entity pair. Each fact keeps its own direction and evidence.
export function graphConnections(edges) {
  const pairs = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.s, edge.t].sort());
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(edge);
  }
  return [...pairs.values()].map(relations => {
    const edge = relations.find(relation => relation.relation_type === 'HAS_SECTION') || relations[0];
    const bidirectional = edge.s !== edge.t && relations.some(relation => relation.s === edge.t);
    return {...edge, relations, bidirectional};
  });
}
