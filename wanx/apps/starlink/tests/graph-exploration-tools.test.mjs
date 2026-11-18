import assert from 'node:assert/strict';
import test from 'node:test';
import {duplicatePairs, graphTimeline, mergeNeighborhood, readGraphNotes,
  ruleAssessment, safeCamera, shortestGraphPath} from '../ui/graph-exploration.mjs';

const nodes = [{id:'p',name:'产品甲',type:'PRODUCT'}, {id:'t',name:'技术乙',type:'TECH'},
  {id:'o',name:'某组织',type:'ORG'}, {id:'x',name:'技术 乙（旧译）',type:'TECH',aliases_json:'["乙技术"]'}];
const ontology = {id:'v2',schema:{relation_types:[{name:'USES',source_types:['PRODUCT'],target_types:['TECH']}]}};
const uses = {id:'a',s:'p',t:'t',relation_type:'USES',evidence:[{document_id:'d'}],published_at:'2026-03-20T08:00:00Z'};
const link = {id:'b',s:'o',t:'t',relation_type:'OWNS',evidence:[]};

test('rule review distinguishes current mismatches, unknown provenance and historical versions', () => {
  const lookup = new Map(nodes.map(node=>[node.id,node]));
  assert.equal(ruleAssessment(uses,lookup,ontology).status,'matches');
  assert.equal(ruleAssessment(link,lookup,ontology).status,'unmatched');
  assert.equal(ruleAssessment({...link,ontology_version_id:'v1'},lookup,ontology).status,'historical');
  assert.equal(ruleAssessment({...uses,s:'t',t:'p',ontology_version_id:'v2'},lookup,ontology).status,'flagged');
  assert.equal(ruleAssessment(link,lookup,null).status,'unavailable');
});

test('shortest visible path retains stored edge directions and supports disconnected endpoints', () => {
  const graph = {nodes,edges:[uses,link]};
  assert.deepEqual(shortestGraphPath(graph,'p','o'),[uses,link]);
  assert.deepEqual(shortestGraphPath(graph,'o','p'),[link,uses]);
  assert.deepEqual(shortestGraphPath(graph,'p','x'),[]);
});

test('replay keeps source date, import date and fact publication date separate', () => {
  const docs = new Map([['d',{document_date:'2025-12-31',created_at:'2026-03-01T08:00:00Z'}]]);
  const graph = {nodes,edges:[uses,link]};
  assert.deepEqual(graphTimeline(graph,'graph',docs).days,['2026-03-20']);
  assert.deepEqual(graphTimeline(graph,'import',docs).days,['2026-03-01']);
  assert.deepEqual(graphTimeline(graph,'source',docs).days,['2025-12-31']);
  assert.equal(graphTimeline(graph,'graph',docs).unknown,1);
});

test('entity suggestions preserve both IDs and normalize whitespace and qualifiers', () => {
  const [pair] = duplicatePairs(nodes);
  assert.deepEqual([pair.a.id,pair.b.id],['t','x']);
  assert.equal(duplicatePairs(nodes,{[pair.id]:'different'})[0].decision,'different');
});

test('neighborhood merge is idempotent and attaches only one-hop facts', () => {
  const base = {nodes:nodes.slice(0,2),edges:[uses]};
  const parents = new Map(), addition = {nodes,edges:[uses,link,{...link,id:'outside',s:'o',t:'x'}]};
  const updated = mergeNeighborhood(base,addition,'t',parents);
  assert.deepEqual(updated.nodes.map(node=>node.id),['p','t','o']);
  assert.deepEqual(updated.edges.map(edge=>edge.id),['a','b']);
  assert.deepEqual([...parents],[['o','t']]);
  assert.deepEqual(mergeNeighborhood(updated,addition,'t',parents),updated);
});

test('local notes are isolated by scope and imported cameras are clamped', () => {
  const storage = new Map([['warehouse-a',JSON.stringify({review:[{id:'a'}]})]]);
  const read = key => readGraphNotes({getItem:id=>storage.get(id)},key);
  assert.equal(read('warehouse-a').review.length,1);
  assert.deepEqual(read('warehouse-b').review,[]);
  assert.equal(safeCamera({yaw:0,pitch:0,zoom:99,panX:0,panY:0}).zoom,4);
  assert.equal(safeCamera({yaw:NaN,pitch:0,zoom:1,panX:0,panY:0}),null);
});
