import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, access, rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareMemoryRuntime, probeMemoryRuntime} from '../tools/prepare-memory-runtime.mjs';

async function fixture(t, {napiReady = true, vector = true, rebuildFails = false} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-memory-runtime-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const clientRoot = path.join(root, 'client'), source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'original-native-binding'), 'plain node bytes');
  await mkdir(path.join(clientRoot, 'node_modules/electron'), {recursive:true});
  await writeFile(path.join(clientRoot, 'package.json'), '{}');
  await writeFile(path.join(clientRoot, 'node_modules/electron/package.json'), JSON.stringify({name:'electron', version:'37.10.3'}));
  await writeFile(path.join(clientRoot, 'node_modules/electron/index.js'), 'module.exports = "fixture-electron";');
  await mkdir(path.join(clientRoot, 'node_modules/node-gyp/bin'), {recursive:true});
  await writeFile(path.join(clientRoot, 'node_modules/node-gyp/bin/node-gyp.js'), '// fixture');
  const current = path.join(clientRoot, 'build/local-memory');
  await mkdir(current, {recursive:true});
  await writeFile(path.join(current, 'old-runtime'), 'previous usable runtime');
  let rebuilt = false;
  const calls = [];
  const modules = () => [
    {path:'node_modules/better-sqlite3', version:'13.0.3', ok:napiReady},
    {path:'Memory/AgentSourceReaders/node_modules/better-sqlite3', version:'12.11.1', ok:rebuilt},
  ];
  const run = (executable, args, options) => {
    calls.push({executable, args, options});
    if (executable === 'fixture-electron') {
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      const entries = modules();
      return JSON.stringify({arch:'arm64', modules:entries, vector, ok:entries.every(item => item.ok) && vector});
    }
    assert.equal(executable, process.execPath);
    assert.ok(args.includes('--target=37.10.3'));
    assert.ok(args.includes('--arch=arm64'));
    assert.ok(args.some(value => value.startsWith('--directory=') && value.includes('.memory-runtime-') && value.endsWith(path.join('Memory','AgentSourceReaders','node_modules','better-sqlite3'))));
    if (rebuildFails) throw Error('native compilation failed');
    rebuilt = true;
  };
  const stage = async ({source:input, destination}) => {
    assert.equal(input, source);
    await mkdir(destination);
    await writeFile(path.join(destination, 'new-runtime'), 'compiled payload');
    return {packages:[], nativeModules:modules().map(item => item.path)};
  };
  const repair = async ({source:input, temporary}) => {
    assert.equal(input, source);
    assert.ok(temporary.startsWith(path.join(clientRoot, 'build') + path.sep));
  };
  const validateLock = async ({source:input, destination}) => {
    assert.equal(input, source);
    await access(path.join(destination, 'new-runtime'));
  };
  return {source, clientRoot, current, calls, run, stage, repair, validateLock};
}

test('runtime preparation rebuilds only the legacy SQLite copy for Electron and promotes verified payload', async t => {
  const f = await fixture(t);
  assert.equal(await prepareMemoryRuntime(f), f.current);
  assert.equal(await readFile(path.join(f.current, 'new-runtime'), 'utf8'), 'compiled payload');
  await assert.rejects(access(path.join(f.current, 'old-runtime')), {code:'ENOENT'});
  assert.equal(f.calls.filter(call => call.executable === process.execPath).length, 1);
  assert.equal(await readFile(path.join(f.source, 'original-native-binding'), 'utf8'), 'plain node bytes');
  assert.equal(probeMemoryRuntime({...f, runtime:f.current}).ok, true);
});

test('missing v13 NAPI prebuild never invokes legacy node-gyp or replaces the current runtime', async t => {
  const f = await fixture(t, {napiReady:false});
  await assert.rejects(prepareMemoryRuntime(f), /MEMORY_SQLITE_PREBUILD_UNAVAILABLE/);
  assert.equal(f.calls.filter(call => call.executable === process.execPath).length, 0);
  assert.equal(await readFile(path.join(f.current, 'old-runtime'), 'utf8'), 'previous usable runtime');
});

test('native compilation failure retains the previous usable runtime', async t => {
  const f = await fixture(t, {rebuildFails:true});
  await assert.rejects(prepareMemoryRuntime(f), /native compilation failed/);
  assert.equal(await readFile(path.join(f.current, 'old-runtime'), 'utf8'), 'previous usable runtime');
  assert.equal(await readFile(path.join(f.source, 'original-native-binding'), 'utf8'), 'plain node bytes');
});

test('a missing vector extension prevents promotion even when both SQLite copies load', async t => {
  const f = await fixture(t, {vector:false});
  await assert.rejects(prepareMemoryRuntime(f), /MEMORY_RUNTIME_NATIVE_SMOKE_FAILED/);
  assert.equal(await readFile(path.join(f.current, 'old-runtime'), 'utf8'), 'previous usable runtime');
});

test('Windows retries a temporary promotion lock without recompiling or losing the previous runtime', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const move = async (from, to) => {
    if (from.endsWith(`${path.sep}next`) && ++attempts < 3) throw Object.assign(Error('temporary native file lock'), {code:'EPERM'});
    return rename(from, to);
  };
  assert.equal(await prepareMemoryRuntime({...f, platform:'win32', move, wait:async () => {}}), f.current);
  assert.equal(attempts, 3);
  assert.equal(f.calls.filter(call => call.executable === process.execPath).length, 1);
  assert.equal(await readFile(path.join(f.current, 'new-runtime'), 'utf8'), 'compiled payload');
});

test('persistent Windows promotion locks stop after bounded retries and restore the previous runtime', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const move = async (from, to) => {
    if (from.endsWith(`${path.sep}next`)) { attempts++; throw Object.assign(Error('locked'), {code:'EPERM'}); }
    return rename(from, to);
  };
  await assert.rejects(prepareMemoryRuntime({...f, platform:'win32', move, wait:async () => {}}), {code:'MEMORY_RUNTIME_BUSY'});
  assert.ok(attempts > 1 && attempts <= 12);
  assert.equal(await readFile(path.join(f.current, 'old-runtime'), 'utf8'), 'previous usable runtime');
});
