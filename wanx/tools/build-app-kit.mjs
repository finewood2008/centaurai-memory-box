import {cp, mkdir, readdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_SOURCE = path.join(root, 'apps', 'personal-client', 'host-sdk');
const CONTRACTS_SOURCE = path.join(SDK_SOURCE, 'contracts');

function parseArgs(argv) {
  const result = {distribution: 'workspace', out: path.join(root, '.wanx-app-kit')};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') result.version = argv[++i];
    else if (arg === '--distribution') result.distribution = argv[++i];
    else if (arg === '--out') result.out = path.resolve(root, argv[++i]);
    else throw new Error(`UNKNOWN_OPTION:${arg}`);
  }
  return result;
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value)) {
    throw new Error('INVALID_KIT_VERSION');
  }
}

function assertDistribution(value) {
  if (!['workspace', 'local-bundle', 'released'].includes(value)) {
    throw new Error('INVALID_KIT_DISTRIBUTION');
  }
}

async function filesUnder(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(directory, next));
    else if (entry.isFile()) files.push(next);
    else throw new Error(`UNSUPPORTED_KIT_ENTRY:${next}`);
  }
  return files;
}

async function digestTree(directory) {
  const hash = createHash('sha256');
  const files = await filesUnder(directory);
  for (const file of files) {
    hash.update(file.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(await readFile(path.join(directory, file)));
    hash.update('\0');
  }
  return {sha256: hash.digest('hex'), files};
}

function sourceInfo() {
  let revision = 'working-tree';
  let dirty = true;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {cwd: root, encoding: 'utf8'}).trim());
  } catch {
    // Keep the explicit working-tree marker when the source is not a Git checkout.
  }
  return {revision, dirty};
}

export async function buildAppKit({version, distribution = 'workspace', out = path.join(root, '.wanx-app-kit')} = {}) {
  assertVersion(version);
  assertDistribution(distribution);
  const sdkPackage = JSON.parse(await readFile(path.join(SDK_SOURCE, 'package.json'), 'utf8'));
  if (version !== sdkPackage.version) throw new Error('KIT_SDK_VERSION_MISMATCH');
  const output = path.resolve(out, version);
  const outputStat = await stat(output).catch(() => null);
  if (outputStat) throw new Error(`KIT_OUTPUT_EXISTS:${output}`);

  const sdkOutput = path.join(output, 'sdk', '@centaurai', 'wanx-host-sdk');
  await mkdir(path.dirname(sdkOutput), {recursive: true});
  await cp(SDK_SOURCE, sdkOutput, {
    recursive: true,
    filter: source => source !== CONTRACTS_SOURCE && !source.startsWith(`${CONTRACTS_SOURCE}${path.sep}`),
  });
  await cp(CONTRACTS_SOURCE, path.join(output, 'contracts'), {
    recursive: true,
    filter: source => source !== path.join(CONTRACTS_SOURCE, 'api.openapi.json'),
  });
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packageFile = execFileSync(process.execPath, [npmCli, 'pack', sdkOutput, '--pack-destination', output, '--ignore-scripts'], {cwd: root, encoding: 'utf8'})
    .trim().split(/\r?\n/).pop();
  const digest = await digestTree(sdkOutput);
  const contractsDigest = await digestTree(path.join(output, 'contracts'));
  const source = sourceInfo();
  const manifest = {
    kitId: 'wanx-app-kit',
    kitVersion: version,
    contractVersion: 1,
    distribution,
    source: {
      repository: 'wanx-platform-repository',
      ...source,
    },
    artifacts: [{
      kind: 'sdk',
      name: sdkPackage.name,
      version: sdkPackage.version,
      path: 'sdk/@centaurai/wanx-host-sdk',
      packageFile,
      sha256: digest.sha256,
      files: digest.files,
    }, {
      kind: 'contract',
      name: 'wanx-app-contracts',
      version: sdkPackage.version,
      path: 'contracts',
      sha256: contractsDigest.sha256,
      files: contractsDigest.files,
    }],
  };
  await writeFile(path.join(output, 'wanx-app-kit.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {output, manifest};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.version) throw new Error('MISSING_KIT_VERSION');
    const result = await buildAppKit(args);
    console.log(JSON.stringify({output: result.output, kitVersion: result.manifest.kitVersion, sourceRevision: result.manifest.source.revision}));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
