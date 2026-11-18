// Assemble a pinned source dependency; never consume a developer's sibling checkout.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildAppKit} from '../../../tools/build-app-kit.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const vendor = path.join(root, 'apps/builder/vendor');

export async function stageDevKit({out = path.join(root, '.wanx-builder-runtime/dev-kit'), source = vendor} = {}) {
  const lock = JSON.parse(await readFile(path.join(source, 'dev-kit-source.json'), 'utf8'));
  if (lock.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(lock.revision) || lock.archive !== 'dev-kit-source.tar.gz') {
    throw new Error('DEVKIT_SOURCE_LOCK_INVALID');
  }
  const archive = path.join(source, lock.archive);
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== lock.sha256) {
    throw new Error('DEVKIT_SOURCE_DIGEST_MISMATCH');
  }
  await mkdir(path.dirname(out), {recursive: true});
  const stage = await mkdtemp(path.join(path.dirname(out), '.dev-kit-'));
  try {
    const kit = await buildAppKit({version: lock.kitVersion, out: path.join(stage, '.kit')});
    execFileSync('tar', ['-xzf', archive, '-C', stage], {stdio: 'inherit'});
    await cp(kit.output, path.join(stage, 'vendor/wanx-app-kit', lock.kitVersion), {recursive: true});
    await rm(path.join(stage, '.kit'), {recursive: true});
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: stage, stdio: 'inherit'});
    await rm(out, {recursive: true, force: true});
    await rename(stage, out);
    return {root: out, revision: lock.revision, sourceSha256: lock.sha256};
  } finally {
    await rm(stage, {recursive: true, force: true});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await stageDevKit()));
}
