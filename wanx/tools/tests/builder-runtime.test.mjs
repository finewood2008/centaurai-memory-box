import assert from 'node:assert/strict';
import {copyFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {stageDevKit} from '../../apps/builder/tools/stage-dev-kit.mjs';
import {buildAppKit} from '../build-app-kit.mjs';

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
    const lock = JSON.parse(await readFile(path.join(root, 'apps/builder/vendor/dev-kit-source.json')));
    const {output: appKitDirectory} = await buildAppKit({version: lock.kitVersion, out: directory});
    const packageFile = `centaurai-wanx-host-sdk-${lock.kitVersion}.tgz`;
    // The unit fixture pins its own npm output; only the release job consumes the official archive.
    const packageSha256 = createHash('sha256').update(await readFile(path.join(appKitDirectory, packageFile))).digest('hex');
    if (packageSha256 !== lock.appKit.packageSha256) {
      await assert.rejects(stageDevKit({out, appKitDirectory}), /APP_KIT_RELEASE_DIGEST_MISMATCH/);
    }
    const source = directory;
    await copyFile(path.join(root, 'apps/builder/vendor', lock.archive), path.join(source, lock.archive));
    await writeFile(path.join(source, 'dev-kit-source.json'), JSON.stringify({
      ...lock, appKit: {...lock.appKit, packageSha256},
    }));
    const result = await stageDevKit({source, out, appKitDirectory});
    assert.match(result.revision, /^[a-f0-9]{40}$/);
    const preload = await readFile(path.join(out, 'templates/standard-host-app/shell/preload.cjs'), 'utf8');
    assert.match(preload, /expertContext/);
    assert.match(preload, /expertInvoke/);
    const sdk = 'vendor/wanx-app-kit/0.3.0/sdk/@centaurai/wanx-host-sdk/index.cjs';
    assert.deepEqual(await readFile(path.join(out, sdk)), await readFile(path.join(root, 'apps/personal-client/host-sdk/index.cjs')));
    await writeFile(path.join(out, 'stale-resource.js'), 'old build');
    await stageDevKit({source, out, appKitDirectory});
    await assert.rejects(readFile(path.join(out, 'stale-resource.js')), {code: 'ENOENT'});
    const installedPackage = path.join(out, 'vendor/wanx-app-kit', lock.kitVersion, packageFile);
    const expected = await readFile(installedPackage);
    await assert.rejects(stageDevKit({source, out, appKitDirectory, requireRelease: true}), /APP_KIT_RELEASE_MANIFEST_MISMATCH/);
    // Same tar contents and filename, different bytes supplied by the caller.
    await writeFile(path.join(appKitDirectory, packageFile), gzipSync(gunzipSync(expected), {level: 1}));
    await assert.rejects(stageDevKit({source, out, appKitDirectory}), /APP_KIT_RELEASE_DIGEST_MISMATCH/);
    assert.deepEqual(await readFile(installedPackage), expected);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
