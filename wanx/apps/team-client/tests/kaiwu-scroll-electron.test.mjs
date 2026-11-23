import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import electron from 'electron';

test('Kaiwu new product form scrolls to an actionable handoff in the team client', {
  skip: process.env.WANX_TEST_ELECTRON !== '1', timeout: 60000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'wanx-kaiwu-scroll-'));
  t.after(() => rm(profile, {recursive: true, force: true}));
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const script = fileURLToPath(new URL('./support/electron-kaiwu-scroll.mjs', import.meta.url));
  await promisify(execFile)(electron, [script, '--user-data-dir=' + profile], {env, timeout: 55000});
});
