import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../build/app/local-ui/',import.meta.url);
test('personal windows load the local material theme without adding scripts or permissions',async()=>{
 for(const surface of ['renderer','panel','device-trust']){
  const html=await readFile(new URL(surface+'/index.html',root),'utf8');
  const href=html.match(/<link rel="stylesheet" href="([^"]*material-theme\.css)"/)[1];
  assert((await readFile(new URL(href,new URL(surface+'/index.html',root)))).length>0);
  assert(html.includes('data-wanx-surface='));
 }
});
test('all local artwork files match canonical sources and decode as wide PNGs',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../builder/integration/personal-client/assets/material-v1/manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.assets.length,8);
 for(const item of manifest.assets){
  const bytes=await readFile(new URL('renderer/assets/material-v1/'+item.file,root));
  assert.equal(bytes.subarray(1,4).toString(),'PNG');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256);
  assert(bytes.readUInt32BE(16)>=2.5*bytes.readUInt32BE(20));
  assert(bytes.length<8*1024*1024);
 }
 const theme=await readFile(new URL('renderer/material-theme.css',root),'utf8');
 assert(!/url\(['"]?https?:/i.test(theme));
});
