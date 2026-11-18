import test from 'node:test';
import assert from 'node:assert/strict';
import {graphUrl,readGraphSources} from '../src/graphTransport.ts';
import {graphProperties} from '../src/graph.ts';

const edge={id:'fact',subject_entity_id:'a',object_entity_id:'b',relation_type:'USES',evidence:[]};
test('Bridge graph uses the registered owner route with only supported query fields',()=>{
  const url=new URL(graphUrl('default',true,'a'),'http://fixture');
  assert.equal(url.pathname,'/api/owner/graph');assert.equal(url.searchParams.get('entity_id'),'a');
  assert.equal(url.searchParams.get('limit'),'120');assert.equal(url.searchParams.has('summary'),false);
  assert.equal(new URL(graphUrl('default',false),'http://fixture').searchParams.get('summary'),'true');
});
test('Bridge source selection rereads current owner evidence and relationship attributes',async()=>{
  const signal=new AbortController().signal;
  const result=await readGraphSources(async(url,options)=>{
    assert.equal(url,graphUrl('default',true,'a',500));assert.equal(options.signal,signal);
    return {nodes:[],edges:[{...edge,properties_json:'{"时间":"2026"}',evidence:[{id:'source',excerpt:'当前依据'}]}]};
  },'default',true,edge,0,signal);
  assert.equal(result.items[0].excerpt,'当前依据');assert.equal(result.edge.properties_json,'{"时间":"2026"}');assert.equal(result.next_offset,null);
});
test('deleted sources do not fall back to cached text',async()=>{
  await assert.rejects(readGraphSources(async()=>({nodes:[],edges:[]}),'default',true,{...edge,evidence:[{excerpt:'旧正文'}]},0,new AbortController().signal),/关系或来源已变化/);
});
test('standalone graph retains paginated evidence and cancellation',async()=>{
  const signal=new AbortController().signal;
  await readGraphSources(async(url,options)=>{
    assert.equal(url,'/api/graph/relations/fact/sources?workspace_id=default&offset=50');assert.equal(options.signal,signal);
    return {items:[],total:0,next_offset:null};
  },'default',false,edge,50,signal);
});
test('properties preserve empty, boolean, numeric and structured values without treating arrays as objects',()=>{
  assert.deepEqual(graphProperties('{"count":0,"active":false,"missing":null,"tags":["a"]}'),[['count','0'],['active','false'],['missing','未提供'],['tags','["a"]']]);
  for(const value of ['broken','null','[]','"text"'])assert.deepEqual(graphProperties(value),[]);
});
