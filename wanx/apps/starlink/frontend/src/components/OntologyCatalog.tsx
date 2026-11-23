import { useId, useMemo, useState } from 'react';
import type { OntologyDefinition, EntityDefinition, RelationDefinition } from '../ontology';
import OntologyRelationGraph from './OntologyRelationGraph';
import StarxiaotuTerm from './StarxiaotuTerm';
import OntologyInstances from './OntologyInstances';

type TypeKind = 'entity' | 'relation';
type CatalogTab = TypeKind | 'graph';
type Selection = { kind: TypeKind; name: string };

const isRelation = (item: EntityDefinition): item is RelationDefinition => 'source_types' in item;

export default function OntologyCatalog({ schema, onAdd, onEdit, disabled = false, active = true }: {
  schema: OntologyDefinition;
  onAdd?: (kind: TypeKind) => void;
  onEdit?: (kind: TypeKind, name: string) => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const [tab, setTab] = useState<CatalogTab>('entity');
  const [query, setQuery] = useState('');
  const [selectedNames, setSelectedNames] = useState<Record<TypeKind, string>>({ entity: '', relation: '' });
  const [graphKind,setGraphKind]=useState<TypeKind>('entity');
  const relationLabels = useMemo(() => Object.fromEntries(schema.relation_types.map(item => [item.name, item.label || item.name])), [schema]);
  const id = useId();

  const graph = tab === 'graph';
  const kind = graph ? graphKind : tab;
  const types = kind === 'entity' ? schema.entity_types : schema.relation_types;
  const typeTitle = kind === 'entity' ? '实体类型' : '关系类型';
  const term = graph ? '' : query.trim().toLocaleLowerCase();
  const results = term ? types.filter(item => [item.name, item.label, item.definition,
    ...item.properties.flatMap(property => [property.name, property.label])].some(value => value?.toLocaleLowerCase().includes(term))) : types;
  const selected = results.find(item => item.name === selectedNames[kind]) ?? results[0];
  const entityLabel = (name: string) => schema.entity_types.find(item => item.name === name)?.label || name;
  function select(next:Selection,openList=false) {
    setSelectedNames(previous=>({...previous,[next.kind]:next.name}));
    setGraphKind(next.kind);
    if(openList){setQuery('');setTab(next.kind);}
  }
  function openTab(next:CatalogTab){
    if(next==='graph'&&selected)select({kind,name:selected.name});
    setTab(next);
  }
  const endpoints=(names:string[])=>names.map((name,index)=><span key={name}>{index>0?'、':''}<button type="button" className="rules-endpoint" onClick={()=>select({kind:'entity',name},true)}>{entityLabel(name)}</button></span>);
  const links=selected&&!isRelation(selected)?schema.relation_types.filter(item=>item.source_types.includes(selected.name)||item.target_types.includes(selected.name)):[];
  function directionGroup(title: string, endpoint: 'source_types' | 'target_types') {
    const related = links.filter(item => item[endpoint].includes(selected!.name));
    return related.length > 0 && <div className="rules-direction-group">
      <h4>{title}</h4>
      <ul>{related.map(item => <li key={item.name}>
        {endpoint === 'source_types' ? <strong>{selected?.label || selected?.name}</strong> : <span>{endpoints(item.source_types)}</span>}
        <span aria-hidden="true">→</span>
        <button type="button" onClick={() => select({kind:'relation',name:item.name},true)}>{item.label || item.name}</button>
        <span aria-hidden="true">→</span>
        {endpoint === 'target_types' ? <strong>{selected?.label || selected?.name}</strong> : <span>{endpoints(item.target_types)}</span>}
      </li>)}</ul>
    </div>;
  }
  const tabs = [
    { id: 'entity', label: '实体类型', count: schema.entity_types.length },
    { id: 'relation', label: '关系类型', count: schema.relation_types.length },
    { id: 'graph', label: '规则关系图' },
  ] as const;

  return <div className="ontology-catalog-view rules-catalog">
    <div className="rules-catalog-toolbar">
      <div className="review-tabs" role="tablist" aria-label="本体类型与关系" onKeyDown={event => {
        const index = tabs.findIndex(item => item.id === tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        openTab(tabs[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {tabs.map(item => <button key={item.id} id={`${id}-${item.id}`} type="button" role="tab"
          aria-selected={tab === item.id} aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => openTab(item.id)}>{item.label}{'count' in item && <span>{item.count}</span>}</button>)}
      </div>
      {!graph && onAdd && <button className="primary" type="button" disabled={disabled || types.length >= (kind === 'entity' ? 100 : 200)}
        onClick={() => onAdd(kind)}>＋ 添加{typeTitle}</button>}
    </div>
    <div className={`ontology-catalog rules-catalog-grid${graph ? ' rules-catalog-graph' : ''}`} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
      <section className="knowledge-card rules-catalog-list" aria-label={graph ? '本体关联图谱' : typeTitle + '列表'}>
        {graph ? <OntologyRelationGraph schema={schema} selected={{ kind, name: selected?.name ?? '' }} select={select} catalogView /> : <>
          <div className="rules-catalog-search">
            <input type="search" aria-label={`搜索${typeTitle}`} placeholder="搜索类型或属性"
              value={query} onChange={event => setQuery(event.target.value)} />
            {term && <small role="status">{results.length} 项匹配</small>}
          </div>
          {results.length ? <ul className="rules-type-list">
            {results.map(item => <li key={item.name}>
              <button type="button" aria-pressed={selected?.name === item.name}
                onClick={() => setSelectedNames(previous => ({ ...previous, [kind]: item.name }))}>
                <strong>{item.label || item.name}</strong>
                {item.properties.length>0&&<small>{item.properties.length} 项属性</small>}
              </button>
            </li>)}
          </ul> : <p className="empty">{term ? `没有匹配的${typeTitle}。` : `当前版本还没有${typeTitle}。`}</p>}
        </>}
      </section>
      {selected && <aside className="knowledge-card catalog-detail rules-catalog-detail" aria-label="类型定义">
        <header>
          <div><span className="rules-detail-kind">{typeTitle}<StarxiaotuTerm name={kind === 'entity' ? 'entity-type' : 'relation-type'} /></span><h2>{selected.label || selected.name}</h2></div>
          <div className="rules-detail-actions">
            {onEdit && <button type="button" disabled={disabled} onClick={() => onEdit(kind, selected.name)} aria-label={`编辑${selected.label || selected.name}`}>手动编辑</button>}
          </div>
        </header>
        {(!graph || kind === 'relation') && <OntologyInstances type={selected.name} kind={kind}
          label={selected.label || selected.name} active={active} relationLabels={relationLabels}/>}
        <details className="rules-definition-source rules-definition" open={graph || undefined}>
          <summary>查看类型定义</summary>
          <p className={selected.definition ? undefined : 'muted'}>{selected.definition || '当前版本尚未填写定义。'}</p>
          {selected.classification_boundary && <section className="rules-type-boundary"><h3>分类边界<StarxiaotuTerm name="classification-boundary" /></h3><p>{selected.classification_boundary}</p></section>}
          {isRelation(selected) && <section className="rules-type-direction"><h3>允许的关系方向<StarxiaotuTerm name="relation-direction" /></h3>
            <p>{endpoints(selected.source_types)}{' → '}<strong>{selected.label || selected.name}</strong>{' → '}{endpoints(selected.target_types)}</p></section>}
          {!!links.length && <section className="rules-related-types"><h3>相关连接规则</h3>
            {directionGroup('作为起点', 'source_types')}
            {directionGroup('作为终点', 'target_types')}
          </section>}
          <section className="rules-properties"><h3>属性<StarxiaotuTerm name="property" /> {selected.properties.length > 0 && <span>{selected.properties.length}</span>}</h3>
            {selected.properties.length ? <dl>
              {selected.properties.map(property => <div key={property.name}><dt>{property.label || property.name}</dt>
                <dd><span className="badge">{property.required ? '必填' : '选填'}</span>{property.definition && <p>{property.definition}</p>}</dd>
              </div>)}
            </dl> : <p className="muted">暂无属性。</p>}
          </section>
          <details className="rules-definition-source"><summary>完整定义与技术标识</summary><pre className="release-text">{JSON.stringify(selected, null, 2)}</pre></details>
        </details>
      </aside>}
    </div>
  </div>;
}
