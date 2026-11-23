import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {resolveManagedMemorySource} from '../shell/local-memory-runtime.mjs';

async function runtime(root) {
  for (const name of ['Memory/dist/src/server/index.js','App/backend/dist/src/index.js']) {
    await mkdir(path.dirname(path.join(root,name)),{recursive:true});
    await writeFile(path.join(root,name),'');
  }
  return root;
}
test('development uses prepared Electron runtime before a source override',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'memory-resolution-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const prepared=await runtime(path.join(root,'build/local-memory'));
  const source=await runtime(path.join(root,'source'));
  assert.equal(await resolveManagedMemorySource({appPath:path.join(root,'build/app'),packaged:false,env:{WANX_MEMORY_BOX_ROOT:source}}),prepared);
});
test('incomplete prepared runtime falls back to explicit source; packaged never uses it',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'memory-resolution-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=await runtime(path.join(root,'source'));
  const appPath=path.join(root,'build/app');
  await mkdir(path.join(root,'build/local-memory'),{recursive:true});
  assert.equal(await resolveManagedMemorySource({appPath,packaged:false,env:{WANX_MEMORY_BOX_ROOT:source}}),source);
  assert.equal(await resolveManagedMemorySource({appPath,packaged:true,resourcesPath:path.join(root,'resources'),env:{WANX_MEMORY_BOX_ROOT:source}}),null);
  const packaged=await runtime(path.join(root,'resources/local-memory'));
  assert.equal(await resolveManagedMemorySource({appPath,packaged:true,resourcesPath:path.join(root,'resources'),env:{WANX_MEMORY_BOX_ROOT:source}}),packaged);
});
