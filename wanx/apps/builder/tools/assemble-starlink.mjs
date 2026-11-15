// Shared builtin payload for both clients. Never reads or writes installed apps/user data.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppKit } from '../../../tools/build-app-kit.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const digest = data => createHash('sha256').update(data).digest('hex');
const sdkVendorPrefix = 'vendor/wanx-host-sdk/';
const isGeneratedFile = name => name.startsWith(sdkVendorPrefix) || name.startsWith('wanx-app-kit/');
const sdkVersionForKit = (value, distribution) => {
  const suffix = `-${distribution}`;
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
};
const clientName = edition => {
  if (!['personal', 'team'].includes(edition)) throw Error('EDITION_REQUIRED');
  return edition === 'personal' ? 'apps/personal-client' : 'apps/team-client';
};

async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules') continue;
    const name = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw Error('STARLINK_PAYLOAD_SYMLINK');
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
    else throw Error('STARLINK_PAYLOAD_INVALID');
  }
  return result.sort((a, b) => a.localeCompare(b));
}

async function digestTree(directory) {
  const hash = createHash('sha256');
  const names = await files(directory);
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(path.join(directory, name)));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: names };
}

export async function validateStarlinkSource(repoRoot = repository) {
  const source = path.join(repoRoot, 'apps/team-client/applications/starlink');
  const receipt = JSON.parse(await readFile(path.join(repoRoot, 'apps/builder/integration/starlink-source.json'), 'utf8'));
  const names = (await files(source)).filter(name => !isGeneratedFile(name));
  const expected = Object.keys(receipt.files).filter(name => !isGeneratedFile(name)).sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw Error('STARLINK_SOURCE_FILES_CHANGED');
  for (const name of names) {
    if (digest(await readFile(path.join(source, name))) !== receipt.files[name]) {
      throw Error(`STARLINK_SOURCE_HASH_MISMATCH:${name}`);
    }
  }
  const manifest = JSON.parse(await readFile(path.join(source, 'application.manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (manifest.applicationId !== receipt.applicationId || manifest.version !== receipt.version ||
      pkg.version !== receipt.version || manifest.launchMode !== 'shared') throw Error('STARLINK_SOURCE_VERSION_MISMATCH');
  return { source, receipt, names };
}

async function resolveAppKit(repoRoot, sdkPackage, requestedDirectory) {
  const directory = path.resolve(
    requestedDirectory || process.env.WANX_APP_KIT_DIR ||
      path.join(repoRoot, '.wanx-app-kit', sdkPackage.version),
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'wanx-app-kit.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' || requestedDirectory || process.env.WANX_APP_KIT_DIR) {
      throw Error(`APP_KIT_NOT_FOUND:${directory}`);
    }
    await buildAppKit({ version: sdkPackage.version, out: path.join(repoRoot, '.wanx-app-kit') });
    manifest = JSON.parse(await readFile(path.join(directory, 'wanx-app-kit.json'), 'utf8'));
  }
  const sdkArtifact = manifest.artifacts?.find(artifact => artifact.kind === 'sdk');
  const contractArtifact = manifest.artifacts?.find(artifact => artifact.kind === 'contract');
  if (manifest.kitId !== 'wanx-app-kit' || sdkVersionForKit(manifest.kitVersion || '', manifest.distribution) !== sdkPackage.version ||
      sdkArtifact?.version !== sdkPackage.version || contractArtifact?.version !== sdkPackage.version) {
    throw Error('APP_KIT_VERSION_MISMATCH');
  }
  const sdkDirectory = path.join(directory, 'sdk', '@centaurai', 'wanx-host-sdk');
  const contractsDirectory = path.join(directory, 'contracts');
  const actualSdk = await digestTree(sdkDirectory).catch(() => null);
  const actualContracts = await digestTree(contractsDirectory).catch(() => null);
  if (!actualSdk || !actualContracts || actualSdk.sha256 !== sdkArtifact.sha256 ||
      actualContracts.sha256 !== contractArtifact.sha256) throw Error('APP_KIT_DIGEST_MISMATCH');
  return { directory, manifest, sdkDirectory, contractsDirectory, sdkArtifact, contractArtifact };
}

export async function assembleStarlink(edition, { repoRoot = repository, appKitDirectory } = {}) {
  const client = path.join(repoRoot, clientName(edition));
  const { source, receipt, names } = await validateStarlinkSource(repoRoot);
  const sdkPackage = JSON.parse(await readFile(path.join(repoRoot, 'apps/personal-client/host-sdk/package.json'), 'utf8'));
  const kit = await resolveAppKit(repoRoot, sdkPackage, appKitDirectory);
  const require = createRequire(path.join(client, 'package.json'));
  const ws = path.dirname(require.resolve('ws/package.json'));
  if (JSON.parse(await readFile(path.join(ws, 'package.json'), 'utf8')).version !== sdkPackage.dependencies.ws) {
    throw Error('STARLINK_WS_VERSION_MISMATCH');
  }
  const target = path.join(client, 'applications/starlink');
  if (edition === 'personal') {
    const info = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink()) throw Error('STARLINK_OUTPUT_SYMLINK');
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const name of names) {
      await mkdir(path.dirname(path.join(target, name)), { recursive: true });
      await cp(path.join(source, name), path.join(target, name));
    }
  }
  await rm(path.join(target, 'node_modules'), { recursive: true, force: true });
  await rm(path.join(target, 'vendor', 'wanx-host-sdk'), { recursive: true, force: true });
  await rm(path.join(target, 'wanx-app-kit'), { recursive: true, force: true });
  await mkdir(path.join(target, 'node_modules/@centaurai'), { recursive: true });
  await mkdir(path.join(target, 'vendor'), { recursive: true });
  await cp(kit.sdkDirectory, path.join(target, 'node_modules/@centaurai/wanx-host-sdk'), { recursive: true });
  await cp(kit.sdkDirectory, path.join(target, 'vendor/wanx-host-sdk'), { recursive: true });
  await cp(kit.contractsDirectory, path.join(target, 'wanx-app-kit/contracts'), { recursive: true });
  await cp(path.join(kit.directory, 'wanx-app-kit.json'), path.join(target, 'wanx-app-kit/wanx-app-kit.json'));
  await cp(ws, path.join(target, 'node_modules/ws'), { recursive: true });
  return {
    edition,
    version: receipt.version,
    applicationId: receipt.applicationId,
    appKitVersion: kit.manifest.kitVersion,
    files: names.length,
    target,
  };
}

export async function verifyPackagedStarlink(archive, clientRoot, { repoRoot = repository, appKitDirectory } = {}) {
  const { receipt, names } = await validateStarlinkSource(repoRoot);
  const sdkPackage = JSON.parse(await readFile(path.join(repoRoot, 'apps/personal-client/host-sdk/package.json'), 'utf8'));
  const kit = await resolveAppKit(repoRoot, sdkPackage, appKitDirectory);
  const { extractFile, listPackage } = createRequire(path.join(clientRoot, 'package.json'))('@electron/asar');
  const actual = name => extractFile(archive, path.join('applications', 'starlink', name));
  // Electron Builder omits the lockfile and declaration files from app.asar.
  const packagedNames = names.filter(name => name !== 'package-lock.json' && !name.endsWith('.d.ts'));
  for (const name of packagedNames) {
    if (digest(actual(name)) !== receipt.files[name]) throw Error(`STARLINK_PACKAGED_HASH_MISMATCH:${name}`);
  }
  const packagedSdkFiles = kit.sdkArtifact.files.filter(name => !name.endsWith('.d.ts'));
  for (const name of packagedSdkFiles) {
    const expected = await readFile(path.join(kit.sdkDirectory, name));
    if (!actual(`vendor/wanx-host-sdk/${name}`).equals(expected) ||
        !actual(`node_modules/@centaurai/wanx-host-sdk/${name}`).equals(expected)) throw Error('STARLINK_PACKAGED_SDK_MISMATCH');
  }
  const packagedContractFiles = kit.contractArtifact.files.filter(name => !name.endsWith('.d.ts'));
  for (const name of packagedContractFiles) {
    if (!actual(`wanx-app-kit/contracts/${name}`).equals(await readFile(path.join(kit.contractsDirectory, name)))) {
      throw Error('STARLINK_PACKAGED_CONTRACT_MISMATCH');
    }
  }
  if (!actual('wanx-app-kit/wanx-app-kit.json').equals(await readFile(path.join(kit.directory, 'wanx-app-kit.json')))) {
    throw Error('STARLINK_PACKAGED_KIT_MANIFEST_MISMATCH');
  }
  const require = createRequire(path.join(clientRoot, 'package.json'));
  const ws = path.dirname(require.resolve('ws/package.json'));
  const wsFiles = await files(ws);
  for (const name of wsFiles) {
    const packed = actual(`node_modules/ws/${name}`);
    const original = await readFile(path.join(ws, name));
    if (name === 'package.json') {
      const packedPackage = JSON.parse(packed);
      const sourcePackage = JSON.parse(original);
      for (const key of ['name', 'version', 'main', 'exports', 'browser', 'engines']) {
        if (JSON.stringify(packedPackage[key]) !== JSON.stringify(sourcePackage[key])) {
          throw Error('STARLINK_PACKAGED_WS_MISMATCH');
        }
      }
    } else if (!packed.equals(original)) {
      throw Error('STARLINK_PACKAGED_WS_MISMATCH');
    }
  }
  const allowed = new Set([
    ...names,
    ...kit.sdkArtifact.files.flatMap(name => [`vendor/wanx-host-sdk/${name}`, `node_modules/@centaurai/wanx-host-sdk/${name}`]),
    ...kit.contractArtifact.files.map(name => `wanx-app-kit/contracts/${name}`),
    'wanx-app-kit/wanx-app-kit.json',
    ...wsFiles.map(name => `node_modules/ws/${name}`),
  ].map(name => name.replaceAll('\\', '/')));
  for (const entry of listPackage(archive)) {
    const name = entry.replaceAll('\\', '/').replace(/^\//, '');
    if (!name.startsWith('applications/starlink/')) continue;
    const relative = name.slice('applications/starlink/'.length);
    if (!allowed.has(relative) && ![...allowed].some(item => item.startsWith(`${relative}/`))) {
      throw Error(`STARLINK_PACKAGED_UNEXPECTED:${relative}`);
    }
  }
  return { version: receipt.version, appKitVersion: kit.manifest.kitVersion, files: names.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await assembleStarlink(process.argv[2])));
}
