import {sameOntologyType, type EntityDefinition, type OntologyDefinition, type RelationDefinition} from '../ontology';

function comparable(item?:EntityDefinition) {
  if(!item||!('source_types' in item))return item;
  const relation=item as RelationDefinition;
  return {...relation,source_types:[...relation.source_types].sort(),target_types:[...relation.target_types].sort()};
}

function fields(item?:EntityDefinition, schema?:OntologyDefinition) {
  const values=new Map<string,string>();
  if(!item)return values;
  values.set('名称',item.label||item.name);
  if(item.definition)values.set('定义',item.definition);
  if(item.classification_boundary)values.set('分类边界',item.classification_boundary);
  const relation=item as RelationDefinition;
  if(relation.source_types){
    const labels=(names:string[])=>[...names].sort().map(name=>schema?.entity_types.find(type=>type.name===name)?.label||name).join('、');
    values.set('关系方向',`${labels(relation.source_types)} → ${item.label||item.name} → ${labels(relation.target_types)}`);
  }
  for(const property of item.properties){
    values.set(`属性 · ${property.name}`,[property.label||property.name,property.required?'必填':'选填',property.definition].filter(Boolean).join(' · '));
  }
  return values;
}

export default function OntologyChangeSummary({before,after,expanded=false,suggestion=false,fieldDiff=false}:{before?:OntologyDefinition;after:OntologyDefinition;expanded?:boolean;suggestion?:boolean;fieldDiff?:boolean}) {
  const changes: {kind:string;name:string;before?:EntityDefinition;after?:EntityDefinition}[]=[];
  for(const key of ['entity_types','relation_types'] as const){
    const previous=new Map((before?.[key]??[]).map(item=>[item.name,item]));
    const next=new Map(after[key].map(item=>[item.name,item]));
    for(const name of new Set([...previous.keys(),...next.keys()]))if(!sameOntologyType(comparable(previous.get(name)),comparable(next.get(name))))changes.push({kind:key==='entity_types'?'实体类型':'关系类型',name,before:previous.get(name),after:next.get(name)});
  }
  function describe(item:EntityDefinition|undefined,schema:OntologyDefinition|undefined){
    if(!item)return '无此定义';
    const relation=item as RelationDefinition;
    const label=(name:string)=>schema?.entity_types.find(t=>t.name===name)?.label||name;
    return `${item.label||item.name}（${item.name}）${relation.source_types?`；${relation.source_types.map(label).join('、')} → ${item.label||item.name} → ${relation.target_types.map(label).join('、')}`:''}；定义：${item.definition||'未填写'}；分类边界：${item.classification_boundary||'未填写'}；属性：${item.properties.map(p=>`${p.label||p.name}（${p.name}，${p.required?'必填':'选填'}${p.definition?`，${p.definition}`:''}）`).join('、')||'无'}`;
  }
  return <details className="ontology-change-summary" open={expanded||undefined}><summary>{suggestion?'建议修改（尚未应用）':'与当前生效定义对比'}：{changes.length} 项改动</summary>
    {!changes.length&&<p>类型定义没有变化。</p>}
    {changes.map(change=>{
      const previous=fieldDiff?fields(change.before,before):undefined;
      const next=fieldDiff?fields(change.after,after):undefined;
      const changedFields=[...new Set([...(previous?.keys()||[]),...(next?.keys()||[])])]
        .filter(key=>previous?.get(key)!==next?.get(key));
      return <article key={change.kind+change.name}>
        <strong>{!change.before?'新增':!change.after?'删除':'修改'}{change.kind} · {change.after?.label||change.before?.label||change.name}（{change.name}）</strong>
        {changedFields.length>0&&<dl className="rules-field-changes">
          {changedFields.map(key=><div key={key}>
            <dt>{key}</dt>
            <dd><span>修改前</span>{previous?.get(key)||'—'}</dd>
            <dd><span>{suggestion?'建议修改后':'待发布'}</span>{next?.get(key)||'—'}</dd>
          </div>)}
        </dl>}
        {changedFields.length>0?<details className="rules-definition-source"><summary>查看完整定义</summary><div className="ontology-change-values">
          <p><span>{suggestion?'修改前':'当前生效'}</span>{describe(change.before,before)}</p>
          <p><span>{suggestion?'建议修改后':'待发布'}</span>{describe(change.after,after)}</p>
        </div></details>:<div className="ontology-change-values">
          <p><span>{suggestion?'修改前':'当前生效'}</span>{describe(change.before,before)}</p>
          <p><span>{suggestion?'建议修改后':'待发布'}</span>{describe(change.after,after)}</p>
        </div>}
      </article>;
    })}
    <p className="ontology-hint">此处核对规则变化。历史材料的更新范围在发布后另行确认。</p>
  </details>;
}
