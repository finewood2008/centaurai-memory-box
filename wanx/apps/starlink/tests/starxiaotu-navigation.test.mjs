import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
const navigation = source.slice(source.indexOf('async function navigateStarxiaotu('),source.indexOf("document.addEventListener('click',event=>{"));
function fixture(mode, canLeave = true) {
  const state = {ready:true,warehouseId:'warehouse',generation:1,view:'graph',mode};
  const context = vm.createContext({state,workbench:{canLeave:()=>canLeave},
    setView:view=>{state.view=view;},
    $:selector=>({click(){state.mode=selector.includes('"list"')?'list':'graph';}}),
  });
  vm.runInContext(navigation,context);
  return {state,navigate:target=>context.navigateStarxiaotu(target)};
}

test('opening the graph from the data-list guide selects the graph view',async()=>{
  const f=fixture('list');
  assert.equal(await f.navigate({view:'graph'}),true);
  assert.equal(f.state.mode,'graph');
});

test('opening the data list selects list mode and retains its warehouse',async()=>{
  const f=fixture('graph');
  assert.equal(await f.navigate({view:'data'}),true);
  assert.equal(f.state.mode,'list');
  assert.equal(f.state.warehouseId,'warehouse');
});

test('an unsaved editor still prevents guide navigation from changing the page or mode',async()=>{
  const f=fixture('list',false);
  assert.equal(await f.navigate({view:'graph'}),false);
  assert.equal(f.state.mode,'list');
});
