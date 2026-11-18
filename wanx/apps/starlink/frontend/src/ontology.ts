export type OntologyProperty = { name: string; label: string; required: boolean; definition?:string };
export type EntityDefinition = { name: string; label: string; properties: OntologyProperty[]; definition?:string; classification_boundary?:string };
export type RelationDefinition = EntityDefinition & { source_types: string[]; target_types: string[] };
export type OntologyDefinition = { entity_types: EntityDefinition[]; relation_types: RelationDefinition[] };

export function sameOntologyType(left?: EntityDefinition, right?: EntityDefinition): boolean {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
    return value;
  }
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export function renameEntity(schema: OntologyDefinition, index: number, name: string): OntologyDefinition {
  const previous = schema.entity_types[index].name;
  const unique = schema.entity_types.filter(item => item.name === previous).length === 1;
  return {
    entity_types: schema.entity_types.map((item, i) => i === index ? { ...item, name } : item),
    relation_types: schema.relation_types.map(item => ({ ...item,
      source_types: item.source_types.map(value => unique && value === previous ? name : value),
      target_types: item.target_types.map(value => unique && value === previous ? name : value),
    })),
  };
}

export function ontologyIssues(schema: OntologyDefinition): string[] {
  const issues: string[] = [];
  if (!schema.entity_types.length || schema.entity_types.length > 100) issues.push('需要配置 1–100 个实体类型。');
  if (schema.relation_types.length > 200) issues.push('关系类型最多 200 个。');
  const entities = new Set(schema.entity_types.map(item => item.name));
  for (const [kind, items] of [['实体', schema.entity_types], ['关系', schema.relation_types]] as const) {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const owner = `${kind} ${index + 1}`;
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(item.name) || seen.has(item.name)) {
        issues.push(`${owner}：标识须以英文字母开头，仅含大写字母、数字、下划线，且同类中不重复。`);
      }
      seen.add(item.name);
      const properties = new Set<string>();
      if (item.properties.length > 50) issues.push(`${owner}：属性最多 50 个。`);
      item.properties.forEach(property => {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(property.name) || properties.has(property.name)) {
          issues.push(`${owner}：属性标识须以英文字母开头，仅含字母、数字、下划线，且不重复。`);
        }
        properties.add(property.name);
      });
    });
  }
  schema.relation_types.forEach((item, index) => {
    for (const [label, values] of [['起点', item.source_types], ['终点', item.target_types]] as const) {
      if (!values.length || values.some(value => !value || !entities.has(value))) {
        issues.push(`关系 ${index + 1}：${label}至少选择一个有效实体类型。`);
      }
    }
  });
  return issues;
}
