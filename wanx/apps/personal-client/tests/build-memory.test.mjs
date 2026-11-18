import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildMemoryWorkspace, resolveMemorySource} from '../tools/build-memory.mjs';
import {createMemoryWorkspace} from '../shell/memory-workspace.mjs';
import {requiredRuntimeFiles} from '../../../tools/stage-local-memory.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-startup-build-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const clientRoot = path.join(root, 'apps/personal-client'), source = path.join(root, 'apps/memory');
  for (const name of ['App/frontend/desktop/wanx-memory.html', 'node_modules/vite/bin/vite.js']) {
    await mkdir(path.dirname(path.join(source, name)), {recursive:true});
    await writeFile(path.join(source, name), 'fixture');
  }
  const calls = [];
  const options = {clientRoot, env:{}, fingerprint:async () => 'source-v1',
    run(command, args) {
      calls.push(args);
      const index = args.indexOf('--outDir');
      if (index !== -1) {
        const output = args[index + 1];
        mkdirSync(path.join(output, 'assets'), {recursive:true});
        writeFileSync(path.join(output, 'wanx-memory.html'), '<script src="./assets/memory.js"></script>');
        writeFileSync(path.join(output, 'assets/memory.js'), 'window.memoryReady=true;');
      }
    },
    async prepareRuntime() {
      for (const name of requiredRuntimeFiles) {
        const file = path.join(clientRoot, 'build/local-memory', name);
        await mkdir(path.dirname(file), {recursive:true}); await writeFile(file, 'compiled runtime');
      }
      return path.join(clientRoot, 'build/local-memory');
    },
    probeRuntime:() => ({ok:true}),
  };
  return {root, source, clientRoot, calls, options};
}

test('default startup builds the repository memory entry and opens the actual workspace', async t => {
  const f = await fixture(t);
  assert.equal(resolveMemorySource(f.clientRoot, {}), f.source);
  const result = await buildMemoryWorkspace(f.options);
  assert.equal(result.cached, false);
  assert.ok(f.calls.some(args => args.includes('memory:build')));
  assert.ok(f.calls.some(args => args.includes('@memmy/backend')));
  const workspace = createMemoryWorkspace({assets:result.output,
    getState:() => ({account:{phase:'authenticated', accountId:'synthetic', clientId:'client'}})});
  t.after(() => workspace.close());
  assert.equal((await workspace.open()).available, true);
  assert.equal((await readFile(path.join(result.output, '.wanx-source'), 'utf8')).trim(), f.source);
});

test('startup restores cached memory after application assembly clears build/app', async t => {
  const f = await fixture(t); await buildMemoryWorkspace(f.options);
  await rm(path.join(f.clientRoot, 'build/app'), {recursive:true}); f.calls.length = 0;
  const result = await buildMemoryWorkspace(f.options);
  assert.equal(result.cached, true); assert.deepEqual(f.calls, []);
  assert.match(await readFile(path.join(result.output, 'wanx-memory.html'), 'utf8'), /memory.js/);
  assert.equal(await readFile(path.join(result.output, 'assets/memory.js'), 'utf8'), 'window.memoryReady=true;');
});

test('an explicit source checkout remains supported and missing dependencies fail startup', async t => {
  const f = await fixture(t);
  assert.equal(resolveMemorySource(f.clientRoot, {WANX_MEMORY_BOX_ROOT:f.source}), f.source);
  await rm(path.join(f.source, 'node_modules'), {recursive:true});
  await assert.rejects(buildMemoryWorkspace(f.options), /MEMORY_DEPENDENCIES_MISSING/);
});

test('an externally managed service builds the UI without preparing a second local backend', async t => {
  const f = await fixture(t);
  const result = await buildMemoryWorkspace({...f.options, env:{MEMMY_RUNTIME_CONFIG_PATH:'/external/runtime.json'},
    prepareRuntime:() => assert.fail('external runtime must not be replaced')});
  assert.equal(result.runtime, null);
  assert.equal(f.calls.some(args => args.includes('memory:build') || args.includes('@memmy/backend')), false);
});
