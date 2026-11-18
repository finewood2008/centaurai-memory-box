import {useEffect,useMemo,useState} from 'react';
import {requestJson} from '../request';
import {endpoint,ErrorNotice,Pager,useRead} from './releaseUi';
import PointLineGraph,{type NetworkLink} from './PointLineGraph';
import type {Material,Item,Page,Detail} from './KnowledgeReleases';
type RecordItem={document:string;documentName:string;item:Item};
function Evidence({workspace,release,record}:{workspace:string;release:string;record:RecordItem}) {
  const [offset,setOffset]=useState(0);
  const result=useRead<Page<{excerpt:string;locator:unknown}>>(endpoint(workspace,`/${encodeURIComponent(release)}/documents/${encodeURIComponent(record.document)}/items/${encodeURIComponent(record.item.id)}/sources`,{offset}));
  return <section><h4>{record.documentName}</h4><pre className="release-text">{JSON.stringify(record.item.payload,null,2)}</pre><ErrorNotice message={result.error} retry={result.reload}/>
    {result.value?.items.map((item,index)=><blockquote key={index}>{item.excerpt}<small>来源位置：{JSON.stringify(item.locator)}</small></blockquote>)}
    {result.value&&<Pager offset={offset} total={result.value.total} move={setOffset}/>}</section>;
}
export default function ReleaseGraph({workspace,release}:{workspace:string;release:string}) {
  const [materials,setMaterials]=useState<Material[]>([]),[filter,setFilter]=useState(''),[records,setRecords]=useState<RecordItem[]>([]);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[progress,setProgress]=useState('');
  const [selected,setSelected]=useState<string>(),[source,setSource]=useState<RecordItem>();
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setRecords([]);setSelected(undefined);setSource(undefined);setProgress('');
    const read=<T,>(path:string,query:Record<string,string|number>={})=>requestJson<T>(endpoint(workspace,path,query),{signal:controller.signal,cache:'no-store',redirect:'error'},20000);
    void (async()=>{
      const documents:Material[]=[];let offset=0,total=1;
      while(offset<total){
        const page=await read<Detail>(`/${encodeURIComponent(release)}`,{offset,limit:50});total=page.document_count;
        documents.push(...page.items);if(!page.items.length&&offset<total)throw Error('版本材料分页不完整，请重试。');offset+=page.items.length;
      }
      if(controller.signal.aborted)return;setMaterials(documents);
      if(filter&&!documents.some(item=>!item.unavailable&&item.document_id===filter))throw Error('所选材料已不可用，请选择其他材料。');
      const usable=documents.filter(item=>!item.unavailable&&item.document_id&&(!filter||item.document_id===filter));
      const result:RecordItem[]=[];
      for(const [index,document] of usable.entries()){
        if(controller.signal.aborted)return;
        setProgress(`正在读取材料 ${index+1}/${usable.length}：${document.document_name}`);
        for(const kind of ['entity','relation']){
          let itemOffset=0,itemTotal=1;
          while(itemOffset<itemTotal){
            const page=await read<Page<Item>>(`/${encodeURIComponent(release)}/documents/${encodeURIComponent(document.document_id!)}/items`,{kind,offset:itemOffset,limit:50});
            itemTotal=page.total;
            if(result.length+page.items.length>3000)throw Error('当前范围超过 3000 条历史实体与关系，请限定材料后查看；未展示不完整图谱。');
            result.push(...page.items.map(item=>({document:document.document_id!,documentName:document.document_name||document.document_id!,item})));
            if(!page.items.length&&itemOffset<itemTotal)throw Error('历史知识分页不完整，请重试。');itemOffset+=page.items.length;
          }
        }
      }
      if(!controller.signal.aborted)setRecords(result);
    })().catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'历史图谱读取失败');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[workspace,release,filter,retry]);
  const {nodes,links,items,missing}=useMemo(()=>{
    const items=new Map<string,RecordItem[]>(),entities=new Map<string,RecordItem>();
    for(const record of records){const id=`${record.item.kind}:${record.item.id}`;if(!items.has(id))items.set(id,[]);items.get(id)!.push(record);if(record.item.kind==='entity'&&!entities.has(record.item.id))entities.set(record.item.id,record);}
    const connections=new Map<string,NetworkLink>();let missing=0;
    for(const [id,refs] of items){const item=refs[0].item;if(item.kind!=='relation')continue;
      const source=item.payload.source_candidate_key!,target=item.payload.target_candidate_key!;
      if(!entities.has(source)||!entities.has(target)){missing++;continue;}
      const key=JSON.stringify([source,target]);if(!connections.has(key))connections.set(key,{source:`entity:${source}`,target:`entity:${target}`,relations:[]});
      connections.get(key)!.relations.push({id,label:item.payload.type});
    }
    return {nodes:[...entities.values()].map(record=>({id:`entity:${record.item.id}`,label:record.item.payload.name||record.item.id,type:record.item.payload.type})),links:[...connections.values()],items,missing};
  },[records]);
  const refs=selected?items.get(selected):undefined;
  const select=(id:string)=>{setSelected(id);setSource(undefined);};
  return <section className="release-graph" aria-label="发布版本历史图谱">
    <label className="release-graph-filter">限定材料<select aria-label="历史图谱材料范围" value={filter} onChange={event=>setFilter(event.target.value)}><option value="">此版本全部可用材料</option>{materials.filter(item=>!item.unavailable&&item.document_id).map(item=><option key={item.document_id} value={item.document_id}>{item.document_name}</option>)}</select></label>
    <p className="release-help">只读展示该版本保存的实体、关系和来源；不会切换当前检索或知识网络。</p>
    {!!materials.filter(item=>item.unavailable).length&&<p>有 {materials.filter(item=>item.unavailable).length} 份历史材料已删除或不可用，内容不予展示。</p>}
    <ErrorNotice message={error} retry={()=>setRetry(n=>n+1)}/>
    {loading?<p role="status">{progress||'正在读取历史图谱…'}</p>:!error&&<>
      <p>{nodes.length} 个实体 · {[...items.values()].filter(ref=>ref[0].item.kind==='relation').length} 条关系</p>
      {!!missing&&<p role="alert">{missing} 条关系缺少此版本的有效端点，未绘制连线，可从材料列表核对。</p>}
      <PointLineGraph nodes={nodes} links={links} selectedNode={selected?.startsWith('entity:')?selected:undefined} selectedRelation={selected?.startsWith('relation:')?selected:undefined} onNode={select} onRelation={select}/>
      {refs&&<div className="release-graph-selection"><h3>{refs[0].item.payload.name||refs[0].item.payload.type}</h3><p>历史来源材料（{refs.length}）</p>{refs.map(record=><button type="button" key={record.document} onClick={()=>setSource(record)}>{record.documentName} · {record.item.source_count} 条来源</button>)}
        {source&&<Evidence key={`${source.document}:${source.item.id}`} workspace={workspace} release={release} record={source}/>}</div>}
    </>}
  </section>;
}
