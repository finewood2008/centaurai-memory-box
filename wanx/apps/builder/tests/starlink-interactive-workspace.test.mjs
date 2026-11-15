import test from 'node:test';import assert from 'node:assert/strict';import {createMaterialBrowser} from '../integration/team-client/starlink/materials.mjs';import {stepForces} from '../integration/team-client/starlink/motion.mjs';import {validatedCorrection} from '../integration/team-client/starlink/correction.mjs';
import {describeConstellations,layoutConstellations,selectGraph} from '../integration/team-client/starlink/graph.mjs';

test('constellations use supported facts, count sources once, and keep cross-group evidence', () => {
  const nodes = [...'abcdefg'].map(id => ({id, name:id}));
  const edges = ['ab','bc','ac','de','ef','df','cd','ag','cg'].map(([s,t],i) => ({
    id:String(i), s,t, paused:i===7, evidence:i===8?[]:[{document_id:'one'},{document_id:'one'},{document_id:i===0?'two':'one'}],
  }));
  const graph = {nodes, edges};
  const original = JSON.stringify(graph);
  const {constellations,membership,counts} = describeConstellations(graph);
  assert.deepEqual(counts.get('a'),{relations:2,sources:2});
  assert.deepEqual(counts.get('c'),{relations:3,sources:1});
  assert.deepEqual(counts.get('g'),{relations:0,sources:0});
  assert.equal(membership.get('a'),membership.get('c'));
  assert.notEqual(membership.get('c'),membership.get('d'));
  assert.equal(membership.get('g'),'ungrouped');
  assert.deepEqual(constellations.map(group => group.name),['c','d','未归组实体']);
  assert.deepEqual(describeConstellations({nodes:[...nodes].reverse(),edges:[...edges].reverse()}).membership,membership);
  const overview = layoutConstellations(selectGraph(graph),constellations);
  assert.equal(overview.anchors.length,3);
  assert.ok(overview.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.equal(overview.edges.find(e => e.id==='6'),edges[6]);
  const members = constellations.find(group => group.id===membership.get('a')).members;
  assert.deepEqual(selectGraph(graph,{members}).nodes.map(n=>n.id),['a','b','c']);
  assert.equal(JSON.stringify(graph),original);
});
const id='11111111-1111-4111-8111-111111111111',version='22222222-2222-4222-8222-222222222222',segment='33333333-3333-4333-8333-333333333333',operation='44444444-4444-4444-8444-444444444444';
test('motion changes only coordinates, holds dragged node and keeps evidence unchanged',()=>{const ns=[{id:'a',x:0,y:0,r:20,labelWidth:80,homeX:0,homeY:0},{id:'b',x:400,y:0,r:20,labelWidth:80,homeX:400,homeY:0}],edges=[{id:'e',s:'a',t:'b',evidence:[{excerpt:'真实陈述的合成替身'}]}],before=JSON.stringify(edges);for(let i=0;i<200;i++)stepForces(ns,edges,'a',.5);assert.equal(ns[0].x,0);assert.ok(ns[1].x<400);assert.ok(ns.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));assert.equal(JSON.stringify(edges),before)});
test('correction payload permits only finite warehouse/version/segment writes',()=>{const v={warehouseId:id,id,versionId:version,operationId:operation,segments:[{id:segment,text:'校对内容'}]};assert.deepEqual(validatedCorrection(v),v);for(const change of [{url:'https://example.com'},{warehouseId:'other'},{segments:[{id:segment,text:'x'},{id:segment,text:'y'}]},{segments:[{id:segment,text:'x',source_locator:{}}]}])assert.throws(()=>validatedCorrection({...v,...change}))});
test('edit retries frozen same operation and preserves exact source IDs/version',async()=>{let ctx={scope:'account-device',warehouseId:id},attempts=[],fail=true;const browser=createMaterialBrowser({getContext:()=>ctx,changed(){},call:async(action,input)=>{if(action==='document')return {document:{original_name:'合成.txt',segment_count:2},version:{id:version},segments:[{id:segment,text:'原正文'},{id:operation,text:'保持原样的第二片段'}]};if(action==='document-text')return {version_id:version,text:'原正文',start:0,end:3,total_chars:3};if(action==='correct'){attempts.push(structuredClone(input));if(fail){fail=false;throw Error('response lost')}return {version:{id:operation}}}throw Error(action)}});await browser.action('material-open',{id});await browser.action('material-edit',{});browser.input('materialSegment_'+segment,'修改正文');await browser.action('material-save',{});assert.equal(browser.hasDrafts(),true);browser.input('materialSegment_'+segment,'不能改写未知操作');await browser.action('material-save',{});assert.deepEqual(attempts[0],attempts[1]);assert.equal(attempts[0].versionId,version);assert.deepEqual(attempts[0].segments,[{id:segment,text:'修改正文'},{id:operation,text:'保持原样的第二片段'}]);assert.equal(browser.hasDrafts(),false)});
test('late material text cannot appear in another account or warehouse',async()=>{let resolve,ctx={scope:'a',warehouseId:id};const browser=createMaterialBrowser({getContext:()=>ctx,changed(){},call:async action=>action==='document'?{document:{original_name:'旧资料'},version:{id:version}}:new Promise(r=>resolve=r)});const pending=browser.action('material-open',{id});await new Promise(r=>setTimeout(r,0));ctx={scope:'b',warehouseId:operation};resolve({version_id:version,text:'不得出现在新仓',end:8,total_chars:8});await pending;assert.doesNotMatch(browser.render({documents:[],total:0,offset:0}),/不得出现在新仓|旧资料/)});
test('truncated source never becomes an editable partial replacement',async()=>{const browser=createMaterialBrowser({getContext:()=>({scope:'a',warehouseId:id}),changed(){},call:async action=>action==='document'?{document:{segment_count:2},version:{id:version},segments:[{id:segment,text:'仅一部分',text_truncated:true}]}:{version_id:version,text:'仅一部分',end:4,total_chars:10}});await browser.action('material-open',{id});await browser.action('material-edit',{});assert.equal(browser.hasDrafts(),false);assert.match(browser.render({documents:[],total:0,offset:0}),/正文未完整提供/) });
