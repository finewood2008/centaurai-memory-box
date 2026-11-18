import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('temporary media contains only existing image assets, not app metadata or policy',async()=>{
 const context={window:{}};vm.runInNewContext(await readFile(new URL('../local-ui/renderer/app-media.js',import.meta.url),'utf8'),context);
 const media=context.window.wanxAppMedia;
 assert.equal(Object.getPrototypeOf(media),null);
 for(const item of Object.values(media)){
  assert.deepEqual(Object.keys(item).sort(),['icon','posters']);
  assert.equal(Object.isFrozen(item),true);
  assert.ok((await readFile(new URL('../build/app/local-ui/renderer/'+item.icon,import.meta.url))).length>0);
  for(const poster of item.posters) assert.ok((await readFile(new URL('../build/app/local-ui/renderer/assets/posters/'+poster,import.meta.url))).length>0);
 }
});
