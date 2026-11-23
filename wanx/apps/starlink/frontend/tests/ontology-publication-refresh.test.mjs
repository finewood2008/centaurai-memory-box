import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {ontologyDraftName} from '../src/ontology.ts';

// Exercise the page's real refresh callback, including its existing draft guards.
const source=await readFile(new URL('../src/main.tsx',import.meta.url),'utf8');
const start=source.indexOf('  const load = useCallback(',source.indexOf('function OntologyView('));
const end=source.indexOf('\n  useEffect(',start);
assert(start>=0&&end>start);
const schema=(...names)=>({entity_types:names.map(name=>({name,label:name,properties:[]})),relation_types:[]});
const v1={id:'v1',status:'published',name:'one',schema:schema('PERSON')};
const v2={id:'v2',status:'published',name:'two',schema:schema('PERSON','PATENT')};
function harness(){
  let response={items:[structuredClone(v1)]},read=async()=>structuredClone(response);
  const state={loaded:false,items:[],definition:null,name:'',saved:'',created:'old',createdId:undefined,resets:0};
  const context=vm.createContext({JSON,structuredClone,ontologyDraftName,workspaceId:'default',starterOntology:schema(),useCallback:fn=>fn,
    loadSequence:{current:0},initialized:{current:false},editorBaselineId:{current:undefined},editorState:{current:{dirty:false,createdVersionId:undefined}},
    requestJson:()=>read(),setItems:v=>state.items=v,setDefinition:v=>state.definition=v,setName:v=>state.name=v,
    setSavedConfiguration:v=>state.saved=v,setLoaded:v=>state.loaded=v,setCreatedConfiguration:v=>state.created=v,
    setCreatedVersionId:v=>{state.createdId=v;context.editorState.current.createdVersionId=v;},
    setPageSelection(){},setPageApplied(){},setEditRequest(){},clearSuggestions:()=>state.resets++,
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(start,end))+'\nglobalThis.reload=load;',context);
  return {state,context,setResponse:v=>response=v,setRead:v=>read=v};
}
test('a newer published version rebases clean manual edits so a later save preserves the newly published type',async()=>{
  const h=harness();await h.context.reload();h.setResponse({items:[v2]});await h.context.reload();
  assert.equal(h.state.items[0].id,'v2');assert.equal(h.context.editorBaselineId.current,'v2');
  assert.deepEqual(h.state.definition,v2.schema);assert.equal(h.state.created,null);
  assert.equal(JSON.stringify({name:h.state.name,definition:h.state.definition}),h.state.saved);
  h.state.definition.entity_types[0].label='Updated person';
  assert.deepEqual(h.state.definition.entity_types.map(t=>t.name),['PERSON','PATENT']);
});
test('refresh preserves a selected independent draft even when the published baseline advances',async()=>{
  const h=harness();await h.context.reload();
  const draft={id:'private',status:'draft',name:'private',schema:schema('PROJECT')};
  h.state.definition=structuredClone(draft.schema);h.context.editorState.current.createdVersionId=draft.id;
  h.setResponse({items:[v2,draft]});await h.context.reload();
  assert.deepEqual(h.state.definition,draft.schema);assert.equal(h.context.editorState.current.createdVersionId,'private');assert.equal(h.state.resets,0);
});
test('dirty edits made during an in-flight refresh are not overwritten',async()=>{
  const h=harness();await h.context.reload();let resolve;
  h.setRead(()=>new Promise(r=>resolve=r));const pending=h.context.reload();
  h.context.editorState.current.dirty=true;h.state.definition=schema('LOCAL');
  resolve({items:[v2]});await pending;
  assert.deepEqual(h.state.definition,schema('LOCAL'));assert.equal(h.state.resets,0);
});
test('late ontology list cannot undo a newer refreshed publication',async()=>{
  const h=harness();await h.context.reload();let resolve;
  h.setRead(()=>new Promise(r=>resolve=r));const old=h.context.reload();
  h.setRead(async()=>({items:[v2]}));await h.context.reload();resolve({items:[v1]});await old;
  assert.equal(h.state.items[0].id,'v2');assert.deepEqual(h.state.definition,v2.schema);
});
