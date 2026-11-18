import { ontologyIssues, type OntologyDefinition } from './ontology.ts';

export type OntologySuggestion = {
  id: string; kind: 'entity' | 'relation' | 'property'; name: string; label: string; reason: string;
  definition?: string;
  owner_kind?: 'entity' | 'relation'; owner_name?: string; source_types?: string[]; target_types?: string[];
  comparison: 'existing' | 'new'; similar_to: Array<{ name: string; label: string; direction?: 'same' | 'compatible' | 'reversed' | 'different' }>;
  reuse_target?: string; allow_new_type?: boolean; policy_note?: string; existing_gap?: string; business_need?: string;
  evidence: { document_id: string; version_id: string; document_name: string; segment_id: string; quote: string };
  additional_evidence?: Array<{document_id:string;version_id:string;document_name:string;segment_id:string;quote:string}>;
};
export type SuggestionPreview = {
  id: string; base_ontology_id: string; expires_at: number; suggestions: OntologySuggestion[]; rejected_count: number;
  documents: Array<{ id: string; version_id: string; name: string; sampled_segments: number; total_segments: number; truncated: boolean }>;
};
export type TypeMappings = { entity: Record<string, string>; relation: Record<string, string> };
export type OntologyTypeChange = { kind: 'entity' | 'relation'; previous: string; next: string | null };
export const removedReuseTarget = '__removed__';

export function updateReuseTarget(target: string, kind: OntologySuggestion['kind'], changes: OntologyTypeChange[]): string {
  return changes.reduce((current, change) => change.kind === kind && change.previous === current
    ? change.next ?? removedReuseTarget : current, target);
}

export function currentDirection(proposal: OntologySuggestion, existing: OntologyDefinition['relation_types'][number],
  schema: OntologyDefinition, mappings: TypeMappings): 'same' | 'compatible' | 'reversed' | 'different' | 'missing' {
  const source = [...new Set((proposal.source_types ?? []).map(name => mappings.entity[name] ?? name))];
  const target = [...new Set((proposal.target_types ?? []).map(name => mappings.entity[name] ?? name))];
  const known = new Set(schema.entity_types.map(item => item.name));
  if (!source.length || !target.length || [...source, ...target].some(name => !known.has(name))) return 'missing';
  const subset = (a: string[], b: string[]) => a.every(name => b.includes(name));
  if (subset(source, existing.source_types) && subset(target, existing.target_types)) {
    return subset(existing.source_types, source) && subset(existing.target_types, target) ? 'same' : 'compatible';
  }
  return subset(source, existing.target_types) && subset(target, existing.source_types) ? 'reversed' : 'different';
}

export function newOntologyOperationId(): string {
  // getRandomValues is also available on native LAN HTTP pages.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// A deleted target remains a tombstone: adding the same spelling later must
// not silently attach old proposals to a different business type.
export function updateTypeMappings(mappings: TypeMappings, changes: OntologyTypeChange[]): TypeMappings {
  const next = structuredClone(mappings);
  for (const change of changes) {
    const aliases = next[change.kind];
    for (const key of Object.keys(aliases)) {
      if (aliases[key] === change.previous) aliases[key] = change.next ?? '';
    }
    if (!Object.hasOwn(aliases, change.previous)) aliases[change.previous] = change.next ?? '';
  }
  return next;
}

export function adoptSuggestion(schema: OntologyDefinition, proposal: OntologySuggestion, mappings: TypeMappings,
  name: string, label: string, mergeTarget?: string): { schema: OntologyDefinition; mappings: TypeMappings } {
  const next = structuredClone(schema), aliases = structuredClone(mappings);
  const definition = proposal.definition?.trim();
  const description = definition ? { definition } : {};
  if (proposal.kind !== 'property') {
    const kind = proposal.kind;
    const definitions = kind === 'entity' ? next.entity_types : next.relation_types;
    if (mergeTarget) {
      if (!definitions.some(item => item.name === mergeTarget)) throw Error('合并目标已不存在，请重新选择。');
      aliases[kind][proposal.name] = mergeTarget;
      return { schema: next, mappings: aliases };
    }
    if (proposal.allow_new_type === false) throw Error('此建议不支持直接新增类型，请核对并复用已有类型，或忽略建议。');
    name = name.trim().toUpperCase();
    if (definitions.some(item => item.name === name)) throw Error('同名类型已存在，请选择复用/合并，或修改建议标识。');
    if (kind === 'entity') next.entity_types.push({ name, label, properties: [], ...description });
    else next.relation_types.push({ name, label, properties: [], ...description,
      source_types: [...new Set((proposal.source_types ?? []).map(value => aliases.entity[value] ?? value))],
      target_types: [...new Set((proposal.target_types ?? []).map(value => aliases.entity[value] ?? value))] });
    aliases[kind][proposal.name] = name;
  } else {
    if (!proposal.owner_kind || !proposal.owner_name) throw Error('属性缺少所属类型。');
    const owner = aliases[proposal.owner_kind][proposal.owner_name] ?? proposal.owner_name;
    const ownerType = (proposal.owner_kind === 'entity' ? next.entity_types : next.relation_types).find(item => item.name === owner);
    if (!ownerType) throw Error(`请先采纳或合并所属类型 ${owner}。`);
    name = name.trim();
    if (ownerType.properties.some(item => item.name === name)) throw Error('该属性已存在，请忽略建议或修改属性标识。');
    ownerType.properties.push({ name, label, required: false, ...description });
  }
  const issues = ontologyIssues(next);
  if (issues.length) throw Error(issues[0] + ' 请先采纳所需实体类型，或合并到已有类型。');
  return { schema: next, mappings: aliases };
}
