// Assemble a pinned source dependency; never consume a developer's sibling checkout.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveAppKit} from '../../../tools/build-app-kit.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const vendor = path.join(root, 'apps/builder/vendor');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function stageDevKit({out = path.join(root, '.wanx-builder-runtime/dev-kit'), source = vendor,
  appKitDirectory = process.env.WANX_APP_KIT_DIR, requireRelease = false} = {}) {
  const lock = JSON.parse(await readFile(path.join(source, 'dev-kit-source.json'), 'utf8'));
  if (lock.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(lock.revision) || lock.archive !== 'dev-kit-source.tar.gz') {
    throw new Error('DEVKIT_SOURCE_LOCK_INVALID');
  }
  const archive = path.join(source, lock.archive);
  if (sha256(await readFile(archive)) !== lock.sha256) {
    throw new Error('DEVKIT_SOURCE_DIGEST_MISMATCH');
  }
  await mkdir(path.dirname(out), {recursive: true});
  const stage = await mkdtemp(path.join(path.dirname(out), '.dev-kit-'));
  try {
    const directory = appKitDirectory || (requireRelease ? path.join(root, '.wanx-app-kit', lock.kitVersion) : undefined);
    const kit = await resolveAppKit(lock.kitVersion, directory);
    execFileSync('tar', ['-xzf', archive, '-C', stage], {stdio: 'inherit'});
    const staged = path.join(stage, 'vendor/wanx-app-kit', lock.kitVersion);
    await cp(kit.output, staged, {recursive: true});
    const {manifest} = await resolveAppKit(lock.kitVersion, staged);
    const catalog = JSON.parse(await readFile(path.join(staged, 'contracts/contract-status.v1.json'), 'utf8'));
    const expert = catalog.apis.find(entry => entry.id === 'wanx.expert-app.v1');
    if (!expert || !['open', 'ready-for-acceptance'].includes(expert.status)) {
      throw new Error('APP_KIT_EXPERT_CONTRACT_REQUIRED');
    }
    const sdk = manifest.artifacts.find(entry => entry.kind === 'sdk');
    const contract = manifest.artifacts.find(entry => entry.kind === 'contract');
    const packageFile = `centaurai-wanx-host-sdk-${lock.kitVersion}.tgz`;
    if (sdk.packageFile !== packageFile || sdk.sha256 !== lock.appKit?.sdkSha256 ||
        contract.sha256 !== lock.appKit?.contractSha256 ||
        sha256(await readFile(path.join(staged, packageFile))) !== lock.appKit?.packageSha256) {
      throw new Error('APP_KIT_RELEASE_DIGEST_MISMATCH');
    }
    if (requireRelease && sha256(await readFile(path.join(staged, 'wanx-app-kit.json'))) !== lock.appKit.manifestSha256) {
      throw new Error('APP_KIT_RELEASE_MANIFEST_MISMATCH');
    }
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
  console.log(JSON.stringify(await stageDevKit({requireRelease: process.env.WANX_REQUIRE_RELEASE_SNAPSHOT === '1'})));
}
