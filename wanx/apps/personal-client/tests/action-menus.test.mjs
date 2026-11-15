import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../local-ui/renderer/action-menus.js',import.meta.url),'utf8');
function setup(){
 const handlers={},menus=[];
 const document={activeElement:null,querySelectorAll:()=>menus.filter(m=>m.open),addEventListener:(type,fn)=>{handlers[type]=fn;}};
 vm.runInNewContext(source,{document});
 const menu=()=>{const m={open:true,summary:{focus(){document.activeElement=this;}},items:[],querySelector:()=>m.summary,querySelectorAll:()=>m.items};menus.push(m);return m;};
 return{handlers,document,menu};
}
test('menu action closes before delegation without cancelling or duplicating the action',()=>{
 const h=setup(),a=h.menu(),b=h.menu();let cancelled=0;
 h.handlers.click({target:{closest:s=>s.startsWith('details')?a:s.startsWith('button')?{}:null},preventDefault(){cancelled++;}});
 assert.equal(a.open,false);assert.equal(b.open,false);assert.equal(cancelled,0);
});
test('Escape closes the menu and restores focus without clearing the file selection',()=>{
 const h=setup(),m=h.menu();let prevented=0,stopped=0;
 h.handlers.keydown({key:'Escape',preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}});
 assert.equal(m.open,false);assert.equal(h.document.activeElement,m.summary);assert.equal(prevented,1);assert.equal(stopped,1);
});
test('arrow navigation opens the disclosure but preserves native select interaction',()=>{
 const h=setup(),m=h.menu();m.open=false;m.items=[{focus(){h.document.activeElement=this;}}];
 h.handlers.keydown({key:'ArrowDown',target:{closest:s=>s.startsWith('details')?m:null},preventDefault(){}});
 assert.equal(m.open,true);assert.equal(h.document.activeElement,m.items[0]);
 let prevented=0;h.handlers.keydown({key:'ArrowDown',target:{closest:s=>s.startsWith('details')?m:{}},preventDefault(){prevented++;}});
 assert.equal(prevented,0);
});
