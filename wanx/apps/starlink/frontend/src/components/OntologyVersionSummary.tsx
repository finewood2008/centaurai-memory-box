import type {OntologyDefinition} from '../ontology';

export default function OntologyVersionSummary({schema}:{schema:OntologyDefinition}) {
  const label=(name:string)=>schema.entity_types.find(item=>item.name===name)?.label||name;
  if(!schema.relation_types.length)return <p>当前版本未定义关系</p>;
  return <ul className="ontology-version-relations">{schema.relation_types.map(relation=><li key={relation.name}
    title={`${relation.source_types.join('/')} → ${relation.name} → ${relation.target_types.join('/')}`}>
    {relation.source_types.map(label).join('、')} → {relation.label||relation.name} → {relation.target_types.map(label).join('、')}
  </li>)}</ul>;
}
