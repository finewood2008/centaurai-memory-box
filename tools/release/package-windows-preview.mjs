import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageLocalMemory } from './stage-local-memory.mjs';
import { repairLockedSqlite } from './repair-locked-sqlite.mjs';
import { smokePackagedMemory } from './smoke-packaged-memory.mjs';
import { smokePackagedAccessories } from './smoke-packaged-accessories.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const checksum = async file => createHash('sha256').update(await readFile(file)).digest('hex');
export function previewVersion(value, base) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-windows-preview\.[1-9]\d*$/.test(value)) throw new Error('WINDOWS_PREVIEW_VERSION_REQUIRED');
  if (base && value.split('-')[0] !== base) throw new Error('WINDOWS_PREVIEW_SOURCE_VERSION_MISMATCH');
  return value;
}
export async function assertReleaseTargetFree({ repository, version, token, request = fetch }) {
  previewVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) throw new Error('GITHUB_RELEASE_CONTEXT_REQUIRED');
  const tag = encodeURIComponent('v' + version);
  for (const route of ['releases/tags/' + tag, 'git/ref/tags/' + tag]) {
    const response = await request(`https://api.github.com/repos/${repository}/${route}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) continue;
    if (response.ok) throw new Error('GITHUB_RELEASE_TARGET_ALREADY_EXISTS');
    throw new Error('GITHUB_RELEASE_PREFLIGHT_FAILED:' + response.status);
  }
}
// node-gyp 12 treats untyped --target as a boolean when the value is a
// separate token, forwarding that value to Python as an extra .gyp input.
export function nodeGypRebuildArgs(gyp, directory, electronVersion) {
  return [gyp, 'rebuild', `--directory=${directory}`, `--target=${electronVersion}`, '--arch=x64', '--dist-url=https://electronjs.org/headers'];
}
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('WINDOWS_PREVIEW_COMMAND_FAILED:' + path.basename(command) + ':' + result.status);
}

// Resolve each native consumer against its nearest lockfile entry. A missing
// nested install must never silently promote the readers from SQLite 12 to 13.
export async function assertNativeSqliteLock({ source, destination, packages }) {
  source = await realpath(source); destination = await realpath(destination);
  const lock = JSON.parse(await readFile(path.join(source, 'package-lock.json'), 'utf8'));
  const diagnostics = [];
  const relativePath = (root, file) => path.relative(root, file).split(path.sep).join('/');
  async function resolveVersion(root, consumer, expectedVersion, lockPath, scope) {
    let manifestFile, manifest;
    try {
      manifestFile = await realpath(createRequire(path.join(root, consumer, 'package.json')).resolve('better-sqlite3/package.json'));
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch { throw new Error(`SQLITE_LOCK_RESOLUTION_FAILED:${scope}:${consumer}`); }
    const sqlitePath = relativePath(root, path.dirname(manifestFile));
    if (sqlitePath === '..' || sqlitePath.startsWith('../') || path.isAbsolute(sqlitePath)) throw new Error(`SQLITE_LOCK_RESOLUTION_ESCAPES_ROOT:${scope}:${consumer}`);
    const result = { scope, consumer, lockPath, expectedVersion, sqlitePath, version: manifest.version };
    if (manifest.name !== 'better-sqlite3' || manifest.version !== expectedVersion) throw new Error('SQLITE_LOCK_VERSION_MISMATCH:' + JSON.stringify(result));
    diagnostics.push(result);
  }
  for (const consumer of ['Memory', 'Memory/AgentSourceReaders']) {
    const manifest = JSON.parse(await readFile(path.join(source, consumer, 'package.json'), 'utf8'));
    let lockPath, expectedVersion;
    for (let directory = consumer; ; directory = path.posix.dirname(directory)) {
      const candidate = path.posix.join(directory, 'node_modules/better-sqlite3');
      const entry = lock.packages?.[candidate];
      if (entry) { lockPath = candidate; expectedVersion = entry.version; break; }
      if (directory === '.') break;
    }
    if (typeof expectedVersion !== 'string' || !expectedVersion) throw new Error('SQLITE_LOCK_ENTRY_MISSING:' + consumer);
    await resolveVersion(source, consumer, expectedVersion, lockPath, 'source');
    const stagedConsumers = new Set([consumer, ...packages.filter(item => item.name === manifest.name).map(item => item.path)]);
    for (const stagedConsumer of stagedConsumers) await resolveVersion(destination, stagedConsumer, expectedVersion, lockPath, 'staged');
  }
  return diagnostics;
}

// A complete config must be loaded as a file: passing it as an options object
// makes electron-builder merge package.json build a second time. Resource
// FileSets are distinct objects, so that merge schedules duplicate copies.
export async function writePreviewBuildConfig({ configFile, pkg, client, staged, output, version, buildIdentity }) {
  const options = {
    ...pkg.build,
    extends: null,
    afterPack: path.join(client, 'tools/package-client-native.mjs'),
    asar: true, npmRebuild: false, nodeGypRebuild: false, forceCodeSigning: false,
    directories: { ...pkg.build.directories, output },
    extraMetadata: { version, wanxBuild: buildIdentity },
    extraResources: [...(pkg.build.extraResources || []), { from: staged, to: 'local-memory' },
      // electron-builder excludes a copy source's root node_modules even for
      // extraResources. Copy that directory explicitly to preserve the graph.
      { from: path.join(staged, 'node_modules'), to: 'local-memory/node_modules' },
      { from: path.join(client, 'shell/windows-private-acl.ps1'), to: 'security/windows-private-acl.ps1' }],
    win: { ...pkg.build.win, signExecutable: false, executableName: 'WANX', requestedExecutionLevel: 'asInvoker', target: [{ target: 'nsis', arch: ['x64'] }],
      artifactName: `CentaurAI-MemoBox-${version}-windows-x64.exe` },
    nsis: { ...pkg.build.nsis, include: path.join(client, 'shell/installer.nsh'),
      oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false, differentialPackage: false, useZip: true },
  };
  await writeFile(configFile, JSON.stringify(options, null, 2) + '\n');
  return configFile;
}

export async function packageWindowsPreview({ version, out, repo = repositoryRoot }) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 22) throw new Error('WINDOWS_X64_NODE22_REQUIRED');
  const client = path.join(repo, 'wanx/apps/personal-client'), memory = path.join(repo, 'memory');
  const manifestFile = path.join(client, 'package.json'), manifestText = await readFile(manifestFile, 'utf8'), pkg = JSON.parse(manifestText);
  previewVersion(version, pkg.version);
  if (pkg.name !== 'centuarai-wanx-client' || pkg.main !== 'shell/entry.mjs' || pkg.build?.appId !== 'ai.centuarai.wanx.client') throw new Error('CLIENT_SOURCE_IDENTITY_CHANGED');
  out = path.resolve(out);
  const relative = path.relative(repo, out);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('PREVIEW_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
  await mkdir(out, { recursive: false });
  const require = createRequire(manifestFile), { build, Platform, Arch } = require('electron-builder');
  const electronVersion = require('electron/package.json').version;
  if (electronVersion !== pkg.devDependencies.electron) throw new Error('ELECTRON_LOCK_MISMATCH');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const sqliteRepair = await repairLockedSqlite({ source: memory, temporary: out });
  console.log(JSON.stringify({ stage: 'sqlite-lock-repair', ...sqliteRepair }));
  const staged = path.join(out, 'staging/local-memory');
  const runtime = await stageLocalMemory({ source: memory, destination: staged });
  if (!runtime.nativeModules.length) throw new Error('MEMORY_SQLITE_NATIVE_MODULE_MISSING');
  console.log(JSON.stringify({ stage: 'local-memory', nativePackages: runtime.packages.filter(item => item.name === 'better-sqlite3') }));
  const sqliteLock = await assertNativeSqliteLock({ source: memory, destination: staged, packages: runtime.packages });
  console.log(JSON.stringify({ stage: 'sqlite-lock', consumers: sqliteLock }));
  // Every physical version, including the readers' older dependency, must match
  // Electron's ABI. Never reuse the build host's plain-Node binding in a release.
  const gyp = require.resolve('node-gyp/bin/node-gyp.js');
  for (const relative of runtime.nativeModules) run(process.execPath, nodeGypRebuildArgs(gyp, path.join(staged, relative), electronVersion), client);
  const output = path.join(out, 'artifacts');
  const buildIdentity = { schemaVersion: 1, buildId: `${process.env.GITHUB_RUN_ID || Date.now()}-${sourceCommit.slice(0,12)}`, sourceCommit,
    channel: 'internal', securityEpoch: 0, installationScope: 'per-user', distributionClass: 'unsigned-internal-only' };
  const configFile = await writePreviewBuildConfig({ configFile: path.join(out, 'resolved-build-config.json'), pkg, client, staged, output, version, buildIdentity });
  const previousDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  try { await build({ projectDir: client, publish: 'never', targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: configFile }); }
  finally { if (previousDiscovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY; else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previousDiscovery; }
  if (await readFile(manifestFile, 'utf8') !== manifestText) throw new Error('CLIENT_SOURCE_MANIFEST_CHANGED');
  const installers = (await readdir(output)).filter(file => file.endsWith('.exe'));
  if (installers.length !== 1) throw new Error('WINDOWS_PREVIEW_INSTALLER_MISSING');
  const unpacked = path.join(output, 'win-unpacked'), executable = path.join(unpacked, 'WANX.exe'), resources = path.join(unpacked, 'resources');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  // Keep Windows PowerShell's Authenticode module ahead of pwsh 7 modules.
  const verificationEnv = { ...process.env, PSModulePath: [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(path.parse(systemRoot).root, 'Program Files', 'WindowsPowerShell', 'Modules'),
  ].join(';') };
  for (const file of [executable, path.join(output, installers[0])]) run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(client, 'shell/verify-unsigned.ps1'), '-Path', file], client, verificationEnv);
  const { verifyPackagedMemoryLayout } = await import(new URL('../../wanx/apps/personal-client/tools/package-client-memory.mjs', import.meta.url));
  await verifyPackagedMemoryLayout({ resourcesPath: resources, platform: 'win32' });
  const { extractFile } = require('@electron/asar');
  const packed = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json').toString('utf8'));
  if (packed.version !== version || packed.name !== pkg.name || packed.productName !== pkg.productName || packed.wanxBuild?.sourceCommit !== sourceCommit) throw new Error('PACKED_PREVIEW_IDENTITY_MISMATCH');
  const nativeCode = `const fs=require('node:fs'),path=require('node:path');const root=process.argv[1];const report=JSON.parse(fs.readFileSync(path.join(root,'runtime-manifest.json')));for(const item of report.nativeModules){const Db=require(path.join(root,item));const db=new Db(':memory:');if(db.prepare('SELECT 1 AS ok').get().ok!==1)throw Error('SQLITE_NATIVE_SMOKE_FAILED');db.close();}console.log(JSON.stringify({nativeAbi:process.versions.modules,nativeModules:report.nativeModules.length}));`;
  const nativeSmoke = JSON.parse(execFileSync(executable, ['-e', nativeCode, path.join(resources, 'local-memory')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 }).trim());
  const smoke = await smokePackagedMemory({ executable, resources, temporary: out });
  if (!extractFile(path.join(resources, 'app.asar'), path.join('host-sdk', 'index.cjs')).length) {
    throw new Error('RECORDING_HOST_SDK_MISSING');
  }
  const accessoriesSmoke = await smokePackagedAccessories({ executable, resources, temporary: out });
  const report = { schemaVersion: 1, version, sourceCommit, platform: 'windows', arch: 'x64', signed: false,
    distributionClass: 'unsigned-internal-only', installer: installers[0], electronVersion, nativeSmoke, sqliteRepair, sqliteLock, smoke, accessoriesSmoke,
    runtimePackages: runtime.packages, immutableIdentity: { packageName: pkg.name, appId: pkg.build.appId, profileName: pkg.productName || pkg.name },
    sourceLocks: Object.fromEntries(await Promise.all(['memory/package-lock.json','wanx/apps/personal-client/package-lock.json'].map(async file => [file, await checksum(path.join(repo,file))]))) };
  const verification = path.join(output, 'verification-windows-preview.json');
  await writeFile(verification, JSON.stringify(report, null, 2) + '\n');
  const sums = await Promise.all([installers[0], path.basename(verification)].map(async file => `${await checksum(path.join(output,file))}  ${file}`));
  await writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  await writeFile(path.join(output, 'release-notes.md'), [
    '半人马AI记忆盒子 Windows x64 预览版',
    '',
    `- 来源提交 \`${sourceCommit}\`。`,
    '- 「我的 AI」新增 Google，并区分 WorkBuddy 国内版和海外版。国内版首次配置提供 MCP 信任指引。',
    '- 空间支持编辑可预览的纯文本文件，文件脱敏可通过右键菜单进入。',
    '- 打包时验证应用内的备份 Drive SDK，防止缺少模块导致客户端启动失败。',
    '- 「配件」支持本机录音。实时字幕、转写和云端总结需匹配的盒端服务与授权。',
    '- 「配件 → 外接存储」可管理连接到盒子的外接硬盘。NAS 入口暂不可用。',
    '- 安装包未签名，预览版不启用正式自动更新。',
    '- 安装包内的原生依赖和本机记忆服务已在 Windows CI 验证。',
    '- 真实盒子登录、备份恢复和跨设备行为待实机联测。',
    '',
  ].join('\n'));
  return { output, installer: installers[0], version, sourceCommit };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' }, 'check-release': { type: 'boolean' } } });
  try {
    const base = JSON.parse(await readFile(path.join(repositoryRoot, 'wanx/apps/personal-client/package.json'), 'utf8')).version;
    const version = previewVersion(values.version || process.env.MEMOBOX_RELEASE_VERSION, base);
    if (values['check-release']) await assertReleaseTargetFree({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN, version });
    else console.log(JSON.stringify(await packageWindowsPreview({ version, out: values.out })));
  } catch (error) { console.error(error.message); process.exit(1); }
}
