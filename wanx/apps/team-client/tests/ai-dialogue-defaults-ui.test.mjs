import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electron from 'electron';

test('automatic dialogue defaults preserve manual selection during refresh and expose waiting state', {
  skip:process.env.WANX_TEST_ELECTRON !== '1', timeout:30000,
},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'wanx-defaults-ui-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(electron,[fileURLToPath(new URL('./support/electron-dialogue-defaults.mjs',import.meta.url)),`--user-data-dir=${profile}`],{env,timeout:25000});
  assert.match(stdout,/DIALOGUE_DEFAULTS_UI_PASS/);
});
