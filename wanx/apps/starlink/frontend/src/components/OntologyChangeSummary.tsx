import {sameOntologyType, type EntityDefinition, type OntologyDefinition, type RelationDefinition} from '../ontology';

export default function OntologyChangeSummary({before,after,expanded=false,suggestion=false}:{before?:OntologyDefinition;after:OntologyDefinition;expanded?:boolean;suggestion?:boolean}) {
  const changes: {kind:string;name:string;before?:EntityDefinition;after?:EntityDefinition}[]=[];
  for(const key of ['entity_types','relation_types'] as const){
    const previous=new Map((before?.[key]??[]).map(item=>[item.name,item]));
    const next=new Map(after[key].map(item=>[item.name,item]));
    for(const name of new Set([...previous.keys(),...next.keys()]))if(!sameOntologyType(previous.get(name),next.get(name)))changes.push({kind:key==='entity_types'?'实体类型':'关系类型',name,before:previous.get(name),after:next.get(name)});
  }
  function describe(item:EntityDefinition|undefined,schema:OntologyDefinition|undefined){
    if(!item)return '无此定义';
    const relation=item as RelationDefinition;
    const label=(name:string)=>schema?.entity_types.find(t=>t.name===name)?.label||name;
    return `${item.label||item.name}（${item.name}）${relation.source_types?`；${relation.source_types.map(label).join('、')} → ${item.label||item.name} → ${relation.target_types.map(label).join('、')}`:''}；定义：${item.definition||'未填写'}；分类边界：${item.classification_boundary||'未填写'}；属性：${item.properties.map(p=>`${p.label||p.name}（${p.name}，${p.required?'必填':'选填'}${p.definition?`，${p.definition}`:''}）`).join('、')||'无'}`;
  }
  return <details className="ontology-change-summary" open={expanded||undefined}><summary>{suggestion?'建议修改（尚未应用）':'与当前生效定义对比'}：{changes.length} 项改动</summary>
    {!changes.length&&<p>类型定义没有变化。</p>}
    {changes.map(change=><article key={change.kind+change.name}><strong>{!change.before?'新增':!change.after?'删除':'修改'}{change.kind} · {change.after?.label||change.before?.label||change.name}（{change.name}）</strong><p>{suggestion?'修改前':'当前生效'}：{describe(change.before,before)}</p><p>{suggestion?'建议修改后':'待发布'}：{describe(change.after,after)}</p></article>)}
    <p className="ontology-hint">此处核对规则变化。历史材料的更新范围在发布后另行确认。</p>
  </details>;
}
