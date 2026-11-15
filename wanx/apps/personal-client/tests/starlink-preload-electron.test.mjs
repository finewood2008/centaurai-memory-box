import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import electron from 'electron';

test('real sandboxed Electron preloads transport typed Starlink actions for both client editions',{
  skip:process.env.WANX_TEST_ELECTRON!=='1',timeout:45000,
},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'wanx-starlink-preload-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout,stderr}=await promisify(execFile)(electron,[fileURLToPath(new URL('./support/electron-starlink-preload.mjs',import.meta.url)),`--user-data-dir=${profile}`],{env,timeout:40000});
  assert.match(stdout,/STARLINK_PRELOAD_ELECTRON_PASS/,stderr);
});
