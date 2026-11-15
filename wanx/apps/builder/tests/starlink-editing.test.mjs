import test from 'node:test';
import assert from 'node:assert/strict';
import {retainGraphInput,createGraphComposition} from '../integration/team-client/starlink/editing.mjs';

test('Chinese composition defers DOM replacement until confirmed and discards stale scope input',()=>{
  let context='account/warehouse';
  const composing=createGraphComposition(()=>context);
  const form={dataset:{dataForm:'search',dataContext:context}};
  const input={isConnected:true,name:'query',value:'buhuo',closest:()=>form};
  composing.start(input);assert.equal(composing.active(),true);
  input.value='补货';assert.deepEqual(composing.end(input),{name:'query',value:'补货'});assert.equal(composing.active(),false);
  composing.start(input);context='other-account/warehouse';assert.equal(composing.active(),false);assert.equal(composing.end(input),null);
  context=form.dataset.dataContext;composing.start(input);input.isConnected=false;assert.equal(composing.active(),false);assert.equal(composing.end(input),null);
});

function fixture(kind='search') {
  const form={dataset:{dataForm:kind,dataContext:'account-a/box-a/warehouse-a'}};
  const nextForm={dataset:{...form.dataset}};
  const calls=[];
  const input={name:kind==='search'?'query':'graphQuery',value:'库存缺口',selectionStart:1,selectionEnd:3,selectionDirection:'backward',
    closest:()=>form,focus:options=>calls.push(['focus',options]),setSelectionRange:(...range)=>calls.push(['selection',...range])};
  const next={closest:()=>nextForm,replaceWith:value=>calls.push(['replace',value])};
  const root={contains:value=>value===input,querySelector:()=>next};
  return {input,nextForm,root,calls,document:{activeElement:input}};
}

test('shell refresh retains the search input node, value and selection in the same warehouse',()=>{
  for(const kind of ['search','graph-search']){
    const f=fixture(kind),restore=retainGraphInput(f.root,f.document);
    restore();assert.equal(f.calls[0][1],f.input);assert.equal(f.input.value,'库存缺口');
    assert.deepEqual(f.calls[1],['focus',{preventScroll:true}]);assert.deepEqual(f.calls[2],['selection',1,3,'backward']);
  }
});

test('switching account or warehouse, closing search, or focus outside the page never restores stale input',()=>{
  for(const scenario of ['scope','closed','outside']){
    const f=fixture();if(scenario==='outside')f.root.contains=()=>false;
    const restore=retainGraphInput(f.root,f.document);
    if(scenario==='scope')f.nextForm.dataset.dataContext='other-account/other-warehouse';
    if(scenario==='closed')f.root.querySelector=()=>null;
    restore();assert.deepEqual(f.calls,[]);
  }
});
