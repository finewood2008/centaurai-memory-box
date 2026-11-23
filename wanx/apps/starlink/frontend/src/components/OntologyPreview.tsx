import {useState} from 'react';
import type {OntologyDefinition,EntityDefinition,RelationDefinition} from '../ontology';
import OntologyRelationGraph from './OntologyRelationGraph';

/** Read-only full snapshot; suggestions stay separate from the confirmed draft. */
export default function OntologyPreview({schema,statusLabel}:{schema:OntologyDefinition;statusLabel:string}) {
  const [selected,select]=useState<{kind:'entity'|'relation';name:string}>({kind:'entity',name:''});
  const chosen=schema[`${selected.kind}_types`].find(item=>item.name===selected.name);
  const label=(name:string)=>schema.entity_types.find(item=>item.name===name)?.label||name;
  function itemView(item:EntityDefinition|RelationDefinition) {
    return <article key={item.name}>
      <strong>{item.label||item.name}</strong><small className="muted">{item.name}</small>
      {'source_types' in item&&<p className="assistant-relation-direction">{item.source_types.map(label).join('、')} → {item.label||item.name} → {item.target_types.map(label).join('、')}</p>}
      {item.definition&&<p>{item.definition}</p>}
      {item.classification_boundary&&<p><span className="muted">分类边界：</span>{item.classification_boundary}</p>}
      {!!item.properties.length&&<ul aria-label={`${item.label||item.name}的属性`}>{item.properties.map(property=><li key={property.name}>
        {property.label||property.name} <small className="muted">{property.name} · {property.required?'必填':'选填'}</small>
        {property.definition&&<span>：{property.definition}</span>}
      </li>)}</ul>}
    </article>;
  }
  return <div className="assistant-published-preview" aria-label={`${statusLabel}内容`}>
    <OntologyRelationGraph schema={schema} selected={selected} select={select} statusLabel={statusLabel} compact/>
    {chosen&&<div aria-label="选中类型详情">{itemView(chosen)}</div>}
    <details className="assistant-definition-list"><summary>实体、关系与属性</summary>
    <section><h4>实体类型</h4>{schema.entity_types.length?schema.entity_types.map(itemView):<p className="muted">暂无实体类型</p>}</section>
    <section><h4>关系类型</h4>{schema.relation_types.length?schema.relation_types.map(itemView):<p className="muted">暂无关系类型</p>}</section>
    </details>
  </div>;
}
