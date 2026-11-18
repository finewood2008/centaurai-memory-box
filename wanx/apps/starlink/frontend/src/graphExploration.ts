import {nodeId,edgeId,type GraphNode,type GraphEdge} from './graph.ts';
import {graphUrl,type GraphResult} from './graphTransport.ts';

type Read=<T>(url:string,options?:RequestInit,timeoutMs?:number)=>Promise<T>;
export type Neighborhood=GraphResult&{limited:boolean;requests:number};

// The registered Bridge route provides one neighborhood per request. Expand
// breadth-first with bounded work; never invent unsupported depth/page queries.
export async function readNeighborhood(read:Read,workspace:string,owner:boolean,root:string,hops:number,signal:AbortSignal):Promise<Neighborhood>{
  if(![1,2,3].includes(hops))throw new Error('关联层数应为 1–3 跳');
  const nodes=new Map<string,GraphNode>(),edges=new Map<string,GraphEdge>(),visited=new Set<string>();
  let frontier=[root],requests=0,limited=false;
  for(let depth=0;depth<hops&&frontier.length;depth++){
    const next=new Set<string>();
    const pending=frontier.filter(id=>!visited.has(id));
    const budget=24-requests;if(pending.length>budget)limited=true;
    const chosen=pending.slice(0,budget);
    for(let offset=0;offset<chosen.length;offset+=3){
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      const batch=chosen.slice(offset,offset+3);
      const results=await Promise.allSettled(batch.map(id=>read<GraphResult>(graphUrl(workspace,owner,id,500,true),{signal},20000)));
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      for(let index=0;index<results.length;index++){
        const result=results[index];if(result.status==='rejected')throw result.reason;
        const id=batch[index],graph=result.value;requests++;visited.add(id);
        if(!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))throw new Error('图谱响应无效');
        if(id===root&&!graph.nodes.some(n=>nodeId(n)===root))throw new Error('实例或来源已变化，请刷新知识视图');
        if(graph.nodes.length>=500||graph.edges.length>=500)limited=true;
        const delivered=new Map(graph.nodes.map(n=>[nodeId(n),n]));
        if(delivered.has(id)&&!nodes.has(id)&&nodes.size<500)nodes.set(id,delivered.get(id)!);
        for(const edge of graph.edges){
          const a=edge.subject_entity_id,b=edge.object_entity_id;
          if(a!==id&&b!==id)continue;
          if(!delivered.has(a)||!delivered.has(b))continue;
          const missing=[...new Set([a,b])].filter(key=>!nodes.has(key));
          if(nodes.size+missing.length>500||!edges.has(edgeId(edge))&&edges.size>=1000){limited=true;continue;}
          for(const key of [a,b])nodes.set(key,delivered.get(key)!);
          edges.set(edgeId(edge),edge);next.add(a===id?b:a);
        }
      }
    }
    frontier=[...next].filter(id=>!visited.has(id));
    if(requests>=24){if(depth+1<hops&&frontier.length)limited=true;break;}
  }
  return {nodes:[...nodes.values()],edges:[...edges.values()],limited,requests};
}

export function instancePage(nodes:GraphNode[],type:string,page:number,size=5){
  const unique=[...new Map(nodes.filter(n=>n.entity_type===type).map(n=>[nodeId(n),n])).values()];
  const pages=Math.max(1,Math.ceil(unique.length/size)),current=Math.min(Math.max(0,page),pages-1);
  return {items:unique.slice(current*size,(current+1)*size),total:unique.length,pages,page:current};
}

export function instanceLinks(edges:GraphEdge[],labels:Record<string,string>={}){
  const links=new Map<string,{source:string;target:string;relations:{id:string;label:string}[]}>();
  for(const edge of edges){
    const key=JSON.stringify([edge.subject_entity_id,edge.object_entity_id]);
    if(!links.has(key))links.set(key,{source:edge.subject_entity_id,target:edge.object_entity_id,relations:[]});
    links.get(key)!.relations.push({id:edgeId(edge),label:labels[edge.relation_type]||edge.relation_type});
  }
  return [...links.values()];
}
