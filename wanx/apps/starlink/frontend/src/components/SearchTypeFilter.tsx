import { useEffect, useId, useRef, useState } from 'react';
import { requestJson } from '../request';
import type { OntologyDefinition } from '../ontology';

export default function SearchTypeFilter({workspace, value, change}: {workspace:string;value:string[];change:(value:string[])=>void}) {
  const [items,setItems]=useState<Array<{name:string;label:string}>>([]);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,reload]=useState(0);
  const root=useRef<HTMLDetailsElement>(null), id=useId();
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    requestJson<{items:Array<{status:string;version_number:number;schema:OntologyDefinition}>}>(`/api/ontologies?workspace_id=${encodeURIComponent(workspace)}`,{signal:controller.signal},15000)
      .then(result=>{
        if(controller.signal.aborted)return;
        const types=new Map<string,{name:string;label:string}>();
        result.items.filter(item=>item.status==='published'||item.status==='superseded')
          .sort((a,b)=>Number(b.status==='published')-Number(a.status==='published')||b.version_number-a.version_number)
          .forEach(item=>item.schema.entity_types.forEach(type=>{if(!types.has(type.name))types.set(type.name,type);}));
        setItems([...types.values()]);
      }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'类型加载失败');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[workspace,revision]);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target)&&root.current)root.current.open=false;};
    document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);
  },[]);
  const text=value.length ? value.map(name=>items.find(item=>item.name===name)?.label||name).join('、') : '全部实体类型';
  return <div className="search-type-field"><span id={id}>实体类型（可多选）</span>
    <details ref={root} className="search-type-picker" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();root.current!.open=false;root.current?.querySelector('summary')?.focus();}}}>
      <summary aria-labelledby={`${id} ${id}-value`}><span id={`${id}-value`} title={text}>{text}</span><span aria-hidden="true">⌄</span></summary>
      <div className="search-type-options">
        <button type="button" onClick={()=>change([])} disabled={!value.length}>清除选择（不限类型）</button>
        {loading&&<p role="status">正在读取实体类型…</p>}
        {error&&<p role="alert">{error}<button type="button" onClick={()=>reload(n=>n+1)}>重试</button></p>}
        <div className="search-type-list">{items.map(item=><label key={item.name}><input type="checkbox" value={item.name} checked={value.includes(item.name)} onChange={event=>change(event.target.checked?[...value,item.name]:value.filter(name=>name!==item.name))}/><span>{item.label||item.name}<small>{item.name}</small></span></label>)}</div>
        {!loading&&!error&&!items.length&&<p>暂无已发布实体类型，可不限定类型检索。</p>}
        <small>包含当前及历史已发布类型；有对应知识的内容才会命中。</small>
        <button type="button" onClick={()=>{root.current!.open=false;root.current?.querySelector('summary')?.focus();}}>完成</button>
      </div>
    </details>
  </div>;
}
