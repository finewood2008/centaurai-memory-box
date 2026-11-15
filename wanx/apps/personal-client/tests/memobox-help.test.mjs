import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const window={};
for(const name of ['memobox-help-content.js','help.js'])vm.runInNewContext(await readFile(new URL('../local-ui/renderer/'+name,import.meta.url),'utf8'),{window});
const help=window.memoboxHelpContent;
test('MemoBox keeps product-owned help when the common FAQ returns WanX content',async()=>{
 const calls=[];
 const view=window.createHelpView({changed(){},request:async(action,input)=>{
  calls.push({action,input});
  return action==='help.faq'?{data:{version:'other-line',categories:[{id:1,name:'万象',items:[{id:2,question:'登录万象',answer:'另一产品的答案'}]}]}}:{};
 }});
 view.visible(true);await view.refresh();
 assert.match(view.render(),/怎样批量添加标签和说明/);
 assert.doesNotMatch(view.render(),/万象|WANX|另一产品的答案/i);
 view.action('help-feedback-open',{id:'files-annotations'});
 view.input('content','批量标注的帮助需要补充说明');
 await view.action('help-feedback-submit');
 const input=calls.find(c=>c.action==='help.feedback').input;
 assert.equal(input.itemId,null,'local FAQ IDs must never be sent as platform item IDs');
 assert.equal(input.categoryId,null);
});
test('bundled help remains readable offline and can accept a product-scoped update',async()=>{
 let offline=true;
 const view=window.createHelpView({changed(){},request:async()=>{
  if(offline)throw Object.assign(new Error(),{code:'ACCOUNT_NETWORK_ERROR'});
  return {data:{product:'memobox',version:'new',categories:[{id:10,name:'设备',items:[{id:11,question:'新增记忆盒子帮助',answer:'产品专属答案'}]}]},etag:'"new"'};
 }});
 view.visible(true);await view.refresh();
 assert.match(view.render(),/记忆盒子内置帮助/);assert.doesNotMatch(view.render(),/帮助服务暂时不可用/);
 offline=false;await view.refresh();assert.match(view.render(),/产品专属答案/);assert.doesNotMatch(view.render(),/内置帮助/);
});
test('all bundled help has stable IDs and uses the MemoBox product voice',()=>{
 const ids=new Set();
 for(const category of help.categories)for(const item of category.items){assert.ok(!ids.has(item.id));ids.add(item.id);assert.ok(item.answer.length>10);assert.doesNotMatch(item.question+item.answer,/万象|\bwanx\b/i);}
 assert.ok(ids.size>=20);
});
