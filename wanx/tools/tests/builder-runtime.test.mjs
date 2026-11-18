import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {stageDevKit} from '../../apps/builder/tools/stage-dev-kit.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('corrupt pinned source is rejected before replacing an existing runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wanx-kit-reject-'));
  try {
    const lock = JSON.parse(await readFile(path.join(root, 'apps/builder/vendor/dev-kit-source.json')));
    await writeFile(path.join(directory, 'dev-kit-source.json'), JSON.stringify(lock));
    await writeFile(path.join(directory, lock.archive), 'corrupt archive');
    const out = path.join(directory, 'existing');
    await writeFile(out, 'original runtime');
    await assert.rejects(stageDevKit({source: directory, out}), /DIGEST_MISMATCH/);
    assert.equal(await readFile(out, 'utf8'), 'original runtime');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('pinned source assembles expert shell and current SDK and replaces stale generated files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wanx-kit-stage-'));
  const out = path.join(directory, 'dev-kit');
  try {
    const result = await stageDevKit({out});
    assert.match(result.revision, /^[a-f0-9]{40}$/);
    const preload = await readFile(path.join(out, 'templates/standard-host-app/shell/preload.cjs'), 'utf8');
    assert.match(preload, /expertContext/);
    assert.match(preload, /expertInvoke/);
    const sdk = 'vendor/wanx-app-kit/0.3.0/sdk/@centaurai/wanx-host-sdk/index.cjs';
    assert.deepEqual(await readFile(path.join(out, sdk)), await readFile(path.join(root, 'apps/personal-client/host-sdk/index.cjs')));
    await writeFile(path.join(out, 'stale-resource.js'), 'old build');
    await stageDevKit({out});
    await assert.rejects(readFile(path.join(out, 'stale-resource.js')), {code: 'ENOENT'});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
