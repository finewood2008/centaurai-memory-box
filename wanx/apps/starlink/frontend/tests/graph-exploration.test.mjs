import test from 'node:test';
import assert from 'node:assert/strict';
import {readNeighborhood,instancePage,instanceLinks} from '../src/graphExploration.ts';
import {withoutIsolatedNodes} from '../src/graph.ts';
const nodes=['a','b','c','d'].map(id=>({id,canonical_name:id,entity_type:'TYPE',properties_json:'{"属性":"值"}'}));
const edges=['ab','bc','cd'].map((id,i)=>({id,subject_entity_id:nodes[i].id,object_entity_id:nodes[i+1].id,relation_type:'REL',evidence:[]}));
test('graph isolation filtering keeps connected and self-related nodes, ignores dangling relationships and preserves source data',()=>{
  const input=[...nodes,{entity_id:'alone',canonical_name:'独立实体',entity_type:'TYPE'}, {entity_id:'self',canonical_name:'自关联',entity_type:'TYPE'}];
  const relations=[...edges,{id:'loop',subject_entity_id:'self',object_entity_id:'self',relation_type:'REL',evidence:[]}, {id:'bad',subject_entity_id:'alone',object_entity_id:'missing',relation_type:'REL',evidence:[]}];
  const snapshot=structuredClone({input,relations});
  assert.deepEqual(withoutIsolatedNodes(input,relations).map(n=>n.entity_id||n.id),['a','b','c','d','self']);
  assert.deepEqual(withoutIsolatedNodes(input,[]),[]);assert.deepEqual({input,relations},snapshot);
});
function reader(calls){return async(url,options)=>{
  const u=new URL(url,'https://fixture');assert.equal(u.pathname,'/api/owner/graph');assert.deepEqual([...u.searchParams.keys()],['workspace_id','limit','entity_id']);
  assert.ok(options.signal);const id=u.searchParams.get('entity_id');calls.push(id);const selected=edges.filter(e=>[e.subject_entity_id,e.object_entity_id].includes(id));
  const ids=new Set([id,...selected.flatMap(e=>[e.subject_entity_id,e.object_entity_id])]);
  return {nodes:nodes.filter(n=>ids.has(n.id)),edges:selected};
};}
test('one to three hops use the registered one-hop endpoint and keep genuine directed connections',async()=>{
  for(const hops of [1,2,3]){
    const calls=[],result=await readNeighborhood(reader(calls),'warehouse',true,'a',hops,new AbortController().signal);
    assert.deepEqual(result.nodes.map(n=>n.id),nodes.slice(0,hops+1).map(n=>n.id));assert.equal(result.edges.length,hops);
    assert.equal(new Set(calls).size,calls.length);assert.equal(result.limited,false);
  }
});
test('source removal or a failed layer rejects partial results instead of presenting a complete neighborhood',async()=>{
  await assert.rejects(readNeighborhood(async()=>({nodes:[],edges:[]}),'w',true,'a',1,new AbortController().signal),/来源已变化/);
  const read=reader([]);await assert.rejects(readNeighborhood(async(url,options)=>url.includes('entity_id=b')?Promise.reject(Error('offline')):read(url,options),'w',true,'a',3,new AbortController().signal),/offline/);
});
test('cancellation and graph fanout have bounded requests',async()=>{
  const controller=new AbortController();controller.abort();let count=0;
  await assert.rejects(readNeighborhood(async()=>{count++;return {nodes,edges};},'w',true,'a',3,controller.signal),{name:'AbortError'});assert.equal(count,0);
  const many=[nodes[0],...Array.from({length:60},(_,i)=>({id:'n'+i,canonical_name:'N',entity_type:'TYPE'}))];
  const connections=many.slice(1).map(n=>({id:n.id,subject_entity_id:'a',object_entity_id:n.id,relation_type:'REL',evidence:[]}));
  const result=await readNeighborhood(async()=>{count++;return {nodes:many,edges:connections};},'w',true,'a',3,new AbortController().signal);
  assert.ok(count<=24);assert.equal(result.limited,true);
});
test('type instances paginate only matching unique published nodes and clamp page after filtering',()=>{
  const many=Array.from({length:12},(_,i)=>({id:String(i),canonical_name:String(i),entity_type:i<11?'TYPE':'OTHER'}));
  const result=instancePage([...many,many[0]],'TYPE',1);assert.equal(result.total,11);assert.equal(result.pages,3);assert.deepEqual(result.items.map(n=>n.id),['5','6','7','8','9']);
  assert.equal(instancePage(many,'OTHER',2).page,0);assert.equal(instancePage(many,'EMPTY',2).total,0);
});
test('parallel and self relationships retain their identities',()=>{
  const result=instanceLinks([...edges,{...edges[0],id:'second'},{...edges[0],id:'self',object_entity_id:'a'}],{REL:'关联'});
  assert.equal(result.length,4);assert.equal(result[0].relations.length,2);assert.equal(result[0].relations[1].id,'second');assert.equal(result.at(-1).target,'a');
});
