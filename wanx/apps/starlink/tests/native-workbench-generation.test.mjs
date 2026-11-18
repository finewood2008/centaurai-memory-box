import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbenchHost} from '../ui/native-workbench.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

for(const page of ['import','dialogue'])test(`detailed review from ${page} preserves its return path and guards unsaved changes`,async()=>{
  const source=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function openConversationReview('),source.indexOf('function bindConversationEvents('));
  const calls=[],listeners={};let canLeave=true;
  const dialog={setAttribute(){},addEventListener:(event,fn)=>listeners[event]=fn,
    querySelector:()=>({addEventListener:(event,fn)=>listeners[event]=fn}),showModal(){},close(){calls.push('close');},remove(){}};
  const flow={state:{materialPage:page,importDocumentId:'doc',selectedIntent:'old',detail:{document_id:'doc'}},
    saved:{materialContinuations:{old:{editExisting:true}}},changes:{record:{},clear(){},async openDraft(){calls.push('dialogue-draft');}},
    async refresh(){calls.push('refresh');},importer:{async refresh(){calls.push('material-refresh');}}};
  const context=vm.createContext({state:{ready:true,warehouseId:'w'},conversationFlow:flow,$:()=>null,
    document:{createElement:()=>dialog,body:{append(){}}},workbench:{canLeave:()=>canLeave,reset(){},openMaterial:id=>{calls.push(id);return true;}}});
  await vm.runInContext(fn+"\nopenConversationReview('doc')",context);
  assert.deepEqual(calls,['doc']);
  if(page==='import'){assert.match(dialog.innerHTML,/返回资料管理/);assert.doesNotMatch(dialog.innerHTML,/继续对话|返回材料对话/);}
  else assert.match(dialog.innerHTML,/返回材料对话/);
  canLeave=false;listeners.click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['doc']);
  canLeave=true;listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,page==='import'?['doc','close','refresh','material-refresh']:['doc','close','refresh','dialogue-draft']);
});

test('returning to a cached graph page and material deletion both refresh its data',()=>{
  let frame,refreshes=0;globalThis.window={};
  globalThis.document={baseURI:'http://synthetic.invalid/ui/index.html',createElement:()=>({contentWindow:{},setAttribute(){},remove(){}})};
  const host=createWorkbenchHost({warehouse:()=> 'w',container:()=>({replaceChildren:value=>frame=value}),onView(){},onImport(){},call(){}});
  host.show('ontology');window.starlinkWorkbench.register(frame.contentWindow,{view:'ontology',navigate:()=>true,refreshGraph:()=>refreshes++});
  host.show('ontology');assert.equal(refreshes,1);host.invalidateGraph();assert.equal(refreshes,2);
  host.reset();host.invalidateGraph();assert.equal(refreshes,2);
});

test('material handoff waits for trusted registration and opens only the requested document',()=>{
  let frame;const opened=[];
  globalThis.window={};globalThis.document={baseURI:'http://synthetic.invalid/ui/index.html',createElement:()=>({contentWindow:{},setAttribute(){},remove(){}})};
  const host=createWorkbenchHost({warehouse:()=> 'w',container:()=>({replaceChildren:value=>frame=value}),onView(){},onImport(){},call(){}});
  assert.equal(host.openMaterial('document'),true);
  window.starlinkWorkbench.register({}, {openMaterial:id=>opened.push(id)});assert.deepEqual(opened,[]);
  window.starlinkWorkbench.register(frame.contentWindow,{openMaterial:id=>{opened.push(id);return true;},view:'materials'});
  assert.deepEqual(opened,['document']);
  assert.equal(host.openMaterial('../forged'),false);
  host.reset();host.show('ontology');
  window.starlinkWorkbench.register(frame.contentWindow,{view:'ontology',navigate(){},openMaterial:id=>opened.push(id)});
  assert.deepEqual(opened,['document']);
});

test('an ontology citation opens the exact version only from the current warehouse frame', () => {
  let frame, selected = 'warehouse';
  const opened = [];
  globalThis.window = {};
  globalThis.document = {baseURI:'http://synthetic.invalid/ui/index.html',createElement:()=>({contentWindow:{},setAttribute(){},remove(){}})};
  const host = createWorkbenchHost({warehouse:()=>selected,container:()=>({replaceChildren:value=>frame=value}),
    onSource:(...args)=>opened.push(args)});
  host.show('ontology','suggestions');
  const name = frame.contentWindow;
  window.starlinkWorkbench.openSource({}, 'doc', 'version');
  window.starlinkWorkbench.openSource(name, 'doc', '../latest');
  window.starlinkWorkbench.openSource(name, 'doc', 'quoted-version');
  selected = 'different';
  window.starlinkWorkbench.openSource(name, 'doc', 'version');
  assert.deepEqual(opened,[['doc','quoted-version']]);
});

test('the published-rule impact list passes only its chosen material from the current warehouse', () => {
  let frame, selected = 'warehouse';
  const opened = [];
  globalThis.window = {};
  globalThis.document = {baseURI:'http://synthetic.invalid/ui/index.html',createElement:()=>({contentWindow:{},setAttribute(){},remove(){}})};
  const host = createWorkbenchHost({warehouse:()=>selected,container:()=>({replaceChildren:value=>frame=value}),
    onImport:documentId=>opened.push(documentId)});
  host.show('ontology');
  const source = frame.contentWindow;
  window.starlinkWorkbench.importMaterials({}, 'different-document');
  window.starlinkWorkbench.importMaterials(source, '../different-document');
  window.starlinkWorkbench.importMaterials(source, 'chosen-document');
  window.starlinkWorkbench.importMaterials(source);
  selected = 'another-warehouse';
  window.starlinkWorkbench.importMaterials(source, 'document');
  assert.deepEqual(opened,['chosen-document',undefined]);
});

test('current extraction target survives iframe registration, is validated and clears on reset',()=>{
  let frame;const opened=[];
  globalThis.window={};globalThis.document={baseURI:'http://synthetic.invalid/ui/index.html',createElement:()=>({contentWindow:{},setAttribute(){},remove(){}})};
  const host=createWorkbenchHost({warehouse:()=> 'w',container:()=>({replaceChildren:value=>frame=value}),onView(){},onImport(){},call(){}});
  assert.equal(host.openMaterial('doc','current-extraction'),true);
  window.starlinkWorkbench.register(frame.contentWindow,{view:'materials',openMaterial:(...args)=>opened.push(args)});
  assert.deepEqual(opened,[['doc','current-extraction']]);assert.equal(host.openMaterial('doc','forged'),false);
  host.reset();host.openMaterial('another');window.starlinkWorkbench.register(frame.contentWindow,{view:'materials',openMaterial:(...args)=>opened.push(args)});
  assert.deepEqual(opened.at(-1),['another',undefined]);
});

for(const switchWarehouse of [false,true])test(`late workbench reply is rejected after ${switchWarehouse?'warehouse switch':'unmount'}`,async()=>{
  let selected='warehouse-old',frame,finish;
  globalThis.window={};
  globalThis.document={baseURI:'http://synthetic.invalid/ui/index.html',createElement:()=>({contentWindow:{},setAttribute(){},remove(){}})};
  const controller=createWorkbenchHost({warehouse:()=>selected,container:()=>({replaceChildren:value=>{frame=value;}}),onView(){},onImport(){},
    call:async(_action,input)=>input.warehouseId==='warehouse-old'&&input.url==='/api/jobs'
      ? new Promise(resolve=>{finish=resolve;})
      : {ok:false,code:'SEMANTICA_RESOURCE_FORBIDDEN',message:'new warehouse error requires review',status:403},
  });
  controller.show('ontology');
  const parent=window.starlinkWorkbench;
  const old=parent.request(frame.contentWindow,{url:'/api/jobs'});
  controller.reset();if(switchWarehouse)selected='warehouse-new';controller.show('ontology');
  let newError;
  try{await parent.request(frame.contentWindow,{url:'/api/settings/status'});}catch(error){newError=error;}
  finish({ok:true,value:{items:[]}});
  await assert.rejects(old,{code:'WAREHOUSE_CHANGED'});
  assert.equal(newError.code,'SEMANTICA_RESOURCE_FORBIDDEN');
  assert.equal(newError.message,'new warehouse error requires review');
});
