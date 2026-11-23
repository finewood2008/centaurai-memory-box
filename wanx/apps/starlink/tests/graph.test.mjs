import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceNodes,selectGraph,layoutGraph,edgeGeometry} from '../ui/graph.js';

const node=(id,name=id,type='CONCEPT')=>({id,name,type});
const edge=(id,s,t,excerpt='材料中的明确陈述')=>({id,s,t,evidence:[{document_id:'doc',excerpt}]});
const graph={nodes:[node('owner','嘉木','PERSON'),node('app','知君','PRODUCT'),node('code','C21','DOCUMENT'),node('box','C100','PRODUCT'),node('other','另外的项目')],edges:[edge('a','owner','app'),edge('b','code','owner','- C21 ｜ 嘉木在本次对话中的原话'),edge('c','owner','box'),edge('d','app','other')]};

test('isolated nodes are hidden by default and can be shown without changing facts or type filtering',()=>{
  const input={nodes:[...graph.nodes,node('alone','独立记录','PERSON'),node('loop','自关联','PERSON'),node('dangling','缺少端点','PERSON')],
    edges:[...graph.edges,edge('self','loop','loop'),edge('missing','dangling','absent')]};
  const before=structuredClone(input);
  assert.deepEqual(selectGraph(input,{type:'PERSON'}).nodes.map(n=>n.id),['owner','loop']);
  assert.deepEqual(selectGraph(input,{type:'PERSON',showIsolated:true}).nodes.map(n=>n.id),['owner','alone','loop','dangling']);
  assert.equal(selectGraph(input,{query:'独立记录'}).nodes.length,0);
  assert.equal(selectGraph(input,{query:'独立记录',showIsolated:true}).nodes[0].id,'alone');
  assert.equal(selectGraph(input,{showIsolated:true}).edges.some(e=>e.id==='missing'),false);
  assert.deepEqual(input,before);
});

test('overview folds only evidenced source reference labels and keeps the source graph intact',()=>{
  const before=JSON.stringify(graph);
  assert.deepEqual([...referenceNodes(graph)],['code']);
  const overview=selectGraph(graph);
  assert.equal(overview.nodes.length,4);
  assert.equal(overview.edges.length,3);
  assert.ok(overview.nodes.some(n=>n.name==='C100'));
  assert.equal(JSON.stringify(graph),before);
  assert.equal(selectGraph(graph,{overview:false}).nodes.length,5);
});

test('search reveals a folded reference with its real neighboring entity and evidence',()=>{
  const result=selectGraph(graph,{query:'C21'});
  assert.deepEqual(result.nodes.map(n=>n.id),['owner','code']);
  assert.equal(result.edges[0],graph.edges[1]);
  assert.equal(selectGraph(graph,{query:'不存在'}).nodes.length,0);
  assert.deepEqual(selectGraph(graph,{focus:'code'}).nodes.map(n=>n.id),['owner','code']);
});

test('the same source reference under another extracted type is folded consistently',()=>{
  const duplicate={nodes:[...graph.nodes,node('alias','C21','CONCEPT')],edges:[...graph.edges,edge('alias-edge','alias','app','这里引用了相同条目') ]};
  assert.deepEqual([...referenceNodes(duplicate)],['code','alias']);
  assert.ok(!selectGraph(duplicate).nodes.some(n=>n.id==='alias'));
  assert.equal(selectGraph(duplicate,{overview:false}).nodes.length,6);
});

test('focus contains exactly one hop, excludes unrelated facts, and still respects type and overview',()=>{
  const focused=selectGraph({...graph,edges:[...graph.edges,edge('peer','app','box')]},{focus:'owner'});
  assert.deepEqual(focused.nodes.map(n=>n.id),['owner','app','box']);
  assert.deepEqual(focused.edges.map(e=>e.id),['a','c']);
  assert.equal(selectGraph(graph,{focus:'owner',overview:false}).nodes.length,4);
  assert.deepEqual(selectGraph(graph,{type:'PRODUCT'}).nodes.map(n=>n.id),['app','box']);
});

test('a dense hub lays out deterministically without the old fixed-wall pileup or overlapping labels',()=>{
  const input={nodes:[node('hub','中心实体','PERSON'),...Array.from({length:36},(_,i)=>node('n'+i,'知识主题'+i))],edges:Array.from({length:36},(_,i)=>edge('e'+i,'hub','n'+i))};
  const result=layoutGraph(input);
  const reversed=layoutGraph({...input,nodes:[...input.nodes].reverse(),edges:[...input.edges].reverse()});
  for (const n of result.nodes) {
    const other=reversed.nodes.find(v=>v.id===n.id);
    assert.ok(Number.isFinite(n.x)&&Number.isFinite(n.y));
    assert.ok(Math.abs(n.x-other.x)<1e-6&&Math.abs(n.y-other.y)<1e-6);
  }
  const many=layoutGraph({nodes:[node('hub','中心实体'),...Array.from({length:112},(_,i)=>node('n'+i,'知识主题'+i))],edges:Array.from({length:112},(_,i)=>edge('e'+i,'hub','n'+i))});
  const width=g=>Math.max(...g.nodes.map(n=>n.x))-Math.min(...g.nodes.map(n=>n.x));
  assert.ok(width(many)>800 && width(many)>width(result));
  for(let i=0;i<result.nodes.length;i++) for(let j=i+1;j<result.nodes.length;j++) {
    const a=result.nodes[i],b=result.nodes[j];
    const half=n=>Math.max(n.r,n.labelWidth/2);
    const horizontal=Math.abs(a.x-b.x)<half(a)+half(b);
    const vertical=a.y-a.r < b.y+b.r+20+(b.lines.length-1)*15 && b.y-b.r < a.y+a.r+20+(a.lines.length-1)*15;
    assert.ok(!(horizontal&&vertical),`label collision: ${a.id}/${b.id}`);
  }
});

test('empty, disconnected and self-referencing graphs remain finite and retain every fact',()=>{
  assert.deepEqual(layoutGraph({nodes:[],edges:[]}).nodes,[]);
  const g=layoutGraph({nodes:[node('a','单独的实体'),node('b','一段比较长的中文知识名称需要分行呈现')],edges:[edge('self','a','a')]});
  assert.equal(g.nodes.length,2);
  assert.equal(g.edges.length,1);
  assert.ok(g.nodes.every(n=>Number.isFinite(n.x)&&n.lines.length<=2));
  const loop=edgeGeometry(g.nodes[0],g.nodes[0]);
  assert.match(loop.d,/C/);
  assert.ok(Number.isFinite(loop.x)&&Number.isFinite(loop.y));
});

test('edge paths end outside node circles and parallel relations have distinct readable paths',()=>{
  const a={id:'a',x:0,y:0,r:20},b={id:'b',x:180,y:90,r:24};
  const one=edgeGeometry(a,b,0,2),two=edgeGeometry(a,b,1,2);
  assert.notEqual(one.d,two.d);
  assert.ok(one.angle>=-90&&one.angle<=90);
  assert.ok(two.angle>=-90&&two.angle<=90);
  const values=one.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(Math.hypot(values[0]-a.x,values[1]-a.y)>a.r);
  assert.ok(Math.hypot(values[4]-b.x,values[5]-b.y)>b.r);
});
