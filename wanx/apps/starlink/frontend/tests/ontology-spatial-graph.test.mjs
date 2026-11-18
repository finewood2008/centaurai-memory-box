import test from 'node:test';
import assert from 'node:assert/strict';
import {ontologySpatialGraph} from '../src/ontologySpatialGraph.ts';

test('spatial ontology layout preserves type identities and both relation directions without changing definitions',()=>{
  const nodes=[{id:'PRODUCT',label:'产品',type:'PRODUCT'},{id:'FEATURE',label:'功能',type:'FEATURE'},{id:'ISOLATED',label:'独立类型',type:'ISOLATED'}];
  const links=[{source:'PRODUCT',target:'FEATURE',relations:[{id:'HAS_FEATURE',label:'具有功能'}],reverseRelations:[{id:'BELONGS_TO',label:'属于产品'}]}];
  const before=structuredClone({nodes,links});
  for(const n of nodes)Object.freeze(n);
  const result=ontologySpatialGraph(nodes,links);
  assert.deepEqual({nodes,links},before);
  assert.deepEqual(new Set(result.nodes.map(n=>n.id)),new Set(nodes.map(n=>n.id)));
  assert.deepEqual(result.edges,[{id:'["PRODUCT","FEATURE"]',s:'PRODUCT',t:'FEATURE'}]);
  assert.ok(result.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
  assert.equal(result.nodes.find(n=>n.id==='ISOLATED').degree,0);
  const focused=ontologySpatialGraph(nodes,links,'FEATURE').nodes.find(n=>n.id==='FEATURE');
  assert.equal(focused.x,460);assert.equal(focused.y,280);
  assert.deepEqual(ontologySpatialGraph([],[]),{nodes:[],edges:[]});
});

test('a densely connected ontology keeps distinct readable positions and every connection',()=>{
  const nodes=Array.from({length:17},(_,i)=>({id:'TYPE_'+i,label:'类型'+i,type:'TYPE_'+i}));
  const links=nodes.flatMap((source,i)=>nodes.slice(i+1).map(target=>({source:source.id,target:target.id,relations:[{id:'R',label:'关联'}]})));
  const result=ontologySpatialGraph(nodes,links);
  assert.equal(result.edges.length,136);
  assert.equal(result.nodes.length,17);
  for(const a of result.nodes)for(const b of result.nodes)if(a.id!==b.id)
    assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>70,'dense connections must not pull types into an overlapping cluster');
});
