import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {memoboxSource,memoboxCopy,memoboxBuildPlugin} from '../tools/memobox-branding.mjs';
test('personal copy transform decodes escaped labels without changing identifiers, paths or dynamic user text',()=>{
 const source='const WANX_HOST_TOKEN="opaque"; const config={"wanx-account":"login",path:"万象记忆库",id:"ai.centuarai.wanx.client"}; const title="\\u4e07\\u8c61\\u661f\\u56fe"; const text=`万象空间：${user.filename}`; const literal=`示例 \\${WANX_EXPERT_READY}`; result={config,title,text,literal,WANX_HOST_TOKEN};';
 const context={user:{filename:'万象研究.txt'},result:null};vm.runInNewContext(memoboxSource(source),context);
 assert.equal(context.result.title,'知识星图');assert.equal(context.result.text,'文件空间：万象研究.txt');
 assert.equal(context.result.config.path,'万象记忆库');assert.equal(context.result.config.id,'ai.centuarai.wanx.client');
 assert.equal(context.result.config['wanx-account'],'login');assert.equal(context.result.WANX_HOST_TOKEN,'opaque');
 assert.equal(context.result.literal,'示例 ${WANX_EXPERT_READY}');
});
test('copy is stable across rebuilds and preserves protocol namespaces',()=>{
 const source='const a="从万象空间导入";const b=`请使用 WANX 模型，凭据为 ${key}`;';
 const once=memoboxSource(source);assert.equal(memoboxSource(once),once);
 assert.equal(memoboxCopy('请只回复 WANX_EXPERT_READY'),'请只回复 WANX_EXPERT_READY');
 assert.equal(memoboxCopy('WANX_HOST_TOKEN'), 'WANX_HOST_TOKEN');
 assert.equal(memoboxCopy('万象·星图 · WanX·Starlink'),'知识星图 · Starlink');
});

test('bundled template copy has a matching hash and keeps permissions and IDs',async()=>{
 const {memoboxTemplate}=await import('../tools/memobox-branding.mjs');
 const {createHash}=await import('node:crypto');
 const source={allowed:true,applicationId:'centaurai.wanx.template.example',sourceHash:'old',files:{'miniapp.manifest.json':'{"capabilities":["files"],"name":"万象示例"}','src/app.js':'const title="\\u4e07\\u8c61空间";'}};
 const branded=memoboxTemplate(source);
 const canonical=JSON.stringify(branded.files,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
 assert.equal(branded.sourceHash,createHash('sha256').update(canonical).digest('hex'));
 assert.equal(branded.applicationId,source.applicationId);assert.equal(branded.allowed,true);
 assert.equal(JSON.parse(branded.files['miniapp.manifest.json']).capabilities[0],'files');
 assert.equal(source.sourceHash,'old');assert.match(source.files['miniapp.manifest.json'],/万象/);
 assert.doesNotMatch(branded.files['src/app.js'],/万象/);
});

test('personal build brands both bundled templates on Windows and POSIX paths',()=>{
 const hooks=[];memoboxBuildPlugin().setup({onLoad(options,load){hooks.push({...options,load});}});
 for(const name of ['knowledge-template','zhike-template']) {
  for(const root of ['/repo/dist/', 'D:\\repo\\dist\\']) {
   const separator=root.includes('\\')?'\\':'/';
   assert.equal(hooks.filter(hook=>hook.filter.test(`${root}${name}${separator}wanx.editable.json`)).length,1);
  }
 }
 for(const filename of ['/repo/templates/custom/wanx.editable.json','D:\\repo\\templates\\custom\\wanx.editable.json']) {
  assert.equal(hooks.some(hook=>hook.filter.test(filename)),false,'unrelated imported templates stay unchanged');
 }
});

test('personal build leaves third-party scripts untouched on Windows and POSIX',async()=>{
 const hooks=[];memoboxBuildPlugin().setup({onLoad(options,load){hooks.push({...options,load});}});
 for(const filename of ['/missing/node_modules/vendor/index.js','D:\\missing\\node_modules\\vendor\\index.js']) {
  const hook=hooks.find(hook=>hook.filter.test(filename));
  assert.ok(hook);assert.equal(await hook.load({path:filename}),undefined);
 }
});
