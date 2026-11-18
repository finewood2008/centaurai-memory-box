import test from 'node:test';
import assert from 'node:assert/strict';
import {createGraphPresentation,presentGraph,DEFAULT_GRAPH_COLOR} from '../ui/graph-presentation.mjs';
import {selectGraph} from '../ui/graph.js';
const schema={entity_types:[{name:'POSITION',label:'研发岗位'},{name:'TECH_SOLUTION',label:'技术方案'},{name:'ORG',label:'协作组织'}],relation_types:[{name:'USES',label:'采用方案'}]};
const raw={nodes:[{id:'a',entity_type:'POSITION',canonical_name:'工程师'},{id:'b',entity_type:'TECH_SOLUTION',canonical_name:'分层设计'},{id:'c',entity_type:'CUSTOM_UNKNOWN',canonical_name:'未定义实体'}],edges:[{id:'r',subject_entity_id:'a',object_entity_id:'b',relation_type:'USES',properties_json:'{"n":1}',evidence:[{excerpt:'原文'}]}]};
test('custom API types remain exact through presentation, layout input and filtering',()=>{
  const before=structuredClone(raw),graph=presentGraph(raw,createGraphPresentation(schema));
  assert.deepEqual(graph.nodes.map(n=>n.type),['POSITION','TECH_SOLUTION','CUSTOM_UNKNOWN']);
  assert.deepEqual(graph.nodes.map(n=>n.entity_type),raw.nodes.map(n=>n.entity_type));
  assert.equal(selectGraph(graph,{type:'POSITION'}).nodes[0].id,'a');
  assert.equal(selectGraph(graph,{type:'CONCEPT'}).nodes.length,0);
  assert.equal(graph.edges[0].relation_type,'USES');assert.equal(graph.edges[0].label,'采用方案');
  assert.deepEqual(raw,before);assert.deepEqual(graph.edges[0].evidence,raw.edges[0].evidence);
});
test('warehouse ontology labels override generic meanings, including built-in codes',()=>{
  const p=createGraphPresentation(schema);assert.equal(p.entity('ORG').label,'协作组织');assert.equal(p.entity('POSITION').label,'研发岗位');
  assert.equal(p.relation('USES'),'采用方案');assert.notEqual(p.entity('POSITION').color,DEFAULT_GRAPH_COLOR);
});
test('undefined types use the exact code and neutral color, never a generic classification',()=>{
  const p=createGraphPresentation(schema);
  for(const code of ['CUSTOM_UNKNOWN','CONCEPT','__proto__','constructor','skill']){
    assert.equal(p.entity(code).label,code);assert.equal(p.entity(code).color,DEFAULT_GRAPH_COLOR);assert.equal(p.relation(code),code);
  }
  assert.equal(createGraphPresentation().entity('ORG').label,'ORG');
});
test('ontology refresh/warehouse switch resolves new names without changing instances or reusing old mappings',()=>{
  const first=createGraphPresentation(schema),second=createGraphPresentation({entity_types:[{name:'POSITION',label:'岗位乙'}],relation_types:[{name:'USES',label:'关系乙'}]});
  assert.equal(second.entity('POSITION').label,'岗位乙');assert.equal(second.entity('ORG').label,'ORG');
  assert.equal(presentGraph(raw,second).edges[0].label,'关系乙');assert.equal(first.entity('POSITION').label,'研发岗位');
  assert.equal(first.entity('POSITION').color,second.entity('POSITION').color);
});
test('missing labels fall back to the original code and missing type is not invented',()=>{
  const p=createGraphPresentation({entity_types:[{name:'CUSTOM',label:' '}],relation_types:[{name:'REL'}]});
  assert.equal(p.entity('CUSTOM').label,'CUSTOM');assert.equal(p.relation('REL'),'REL');
  const graph=presentGraph({nodes:[{id:'x',canonical_name:'无类型'}],edges:[]},p);
  assert.equal(graph.nodes[0].type,undefined);assert.equal('entity_type' in graph.nodes[0],false);
});
