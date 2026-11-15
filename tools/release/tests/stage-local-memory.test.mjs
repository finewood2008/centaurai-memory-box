import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stageLocalMemory } from '../stage-local-memory.mjs';
import { assertNativeSqliteLock, assertReleaseTargetFree, nodeGypRebuildArgs, previewVersion, writePreviewBuildConfig } from '../package-windows-preview.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'memobox-release-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source);
  async function file(relative, contents = '') { const full = path.join(source,relative); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, contents); }
  async function pkg(relative, name, version, dependencies = {}, optionalDependencies = {}) {
    await file(relative + '/package.json', JSON.stringify({ name, version, type: 'module', main: 'dist/index.js', dependencies, optionalDependencies }));
    await file(relative + '/dist/index.js', `export const value=${JSON.stringify(version)};`);
    await file(relative + '/src/private.ts', 'source is not a runtime asset');
  }
  await pkg('Memory','@memmy/memory','2.1.7',{ alpha:'1', 'better-sqlite3':'13' });
  await pkg('App/backend','@memmy/backend','0.0.0',{ alpha:'2', '@memmy/core':'0' });
  await pkg('Core','@memmy/core','0.0.0',{ 'better-sqlite3':'12' });
  await pkg('node_modules/alpha','alpha','1.0.0', {}, { 'not-installed':'1' });
  await pkg('App/backend/node_modules/alpha','alpha','2.0.0');
  await pkg('node_modules/better-sqlite3','better-sqlite3','13.0.3');
  await pkg('Core/node_modules/better-sqlite3','better-sqlite3','12.6.3');
  await mkdir(path.join(source,'node_modules/@memmy'), { recursive:true });
  await symlink(path.join(source,'Core'), path.join(source,'node_modules/@memmy/core'), process.platform === 'win32' ? 'junction' : 'dir');
  await file('node_modules/alpha/.npmrc', 'SYNTHETIC_PRIVATE'); await file('Memory/dist/.env.fixture', 'SYNTHETIC_PRIVATE');
  await file('node_modules/development-only/package.json', JSON.stringify({name:'development-only'}));
  await file('Memory/.env', 'SYNTHETIC_PRIVATE'); await file('.env','SYNTHETIC_PRIVATE');
  await file('Memory/dist/templates/template.txt','compiled runtime asset'); await file('App/backend/dist/migrations/001.sql','CREATE TABLE fixture(id);');
  await file('LICENSE','upstream fixture license');
  const destination = path.join(root,'payload');
  const options = { source, destination, packages: ['Memory','App/backend','Core'], required: ['Memory/dist/index.js','App/backend/dist/index.js'] };
  return {root,source,destination,file,pkg,options};
}

test('stage preserves compiled assets, version conflicts and every native module without profiles or dev dependencies', async t => {
  const f = await fixture(t), report = await stageLocalMemory(f.options);
  assert.equal(await readFile(path.join(f.destination,'Memory/dist/templates/template.txt'),'utf8'),'compiled runtime asset');
  assert.match(await readFile(path.join(f.destination,'App/backend/dist/migrations/001.sql'),'utf8'),/CREATE TABLE/);
  assert.equal(await readFile(path.join(f.destination,'LICENSE'),'utf8'),'upstream fixture license');
  assert.equal(report.packages.find(row => row.path === 'node_modules/alpha').version,'1.0.0');
  assert.equal(report.packages.find(row => row.path === 'App/backend/node_modules/alpha').version,'2.0.0');
  assert.deepEqual([...new Set(report.packages.filter(row => row.name === 'better-sqlite3').map(row => row.version))].sort(),['12.6.3','13.0.3']);
  assert.equal(report.nativeModules.length,3); // root 13, canonical core 12, original core 12
  assert.equal((await readFile(path.join(f.destination,'runtime-manifest.json'),'utf8')).includes(f.source),false);
  const names = await readdir(f.destination); assert.equal(names.includes('.env'),false);
  await assert.rejects(readFile(path.join(f.destination,'Memory/.env')), {code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.destination,'node_modules/alpha/.npmrc')), {code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.destination,'Memory/dist/.env.fixture')), {code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.destination,'Memory/src/private.ts')), {code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.destination,'node_modules/development-only/package.json')), {code:'ENOENT'});
  const copied = await readFile(path.join(f.destination,'node_modules/@memmy/core/dist/index.js'),'utf8'); assert.match(copied,/0.0.0/);
});

test('staging refuses missing required modules, source overlap and existing destinations', async t => {
  const f = await fixture(t);
  await assert.rejects(stageLocalMemory({...f.options, required:['missing.js']}), /RUNTIME_INPUT_MISSING/);
  await assert.rejects(stageLocalMemory({...f.options, destination:path.join(f.source,'out')}), /RUNTIME_STAGE_OVERLAPS_SOURCE/);
  await mkdir(f.destination);
  await assert.rejects(stageLocalMemory(f.options), /RUNTIME_STAGE_EXISTS/);
});

test('required production dependencies fail closed while unavailable optional packages are allowed', async t => {
  const f=await fixture(t); await f.pkg('Memory','@memmy/memory','2.1.7',{ missing:'1' });
  await assert.rejects(stageLocalMemory(f.options),/RUNTIME_DEPENDENCY_MISSING:@memmy\/memory:missing/);
});

test('a runtime package asset cannot follow a source-machine symlink outside the source', async t => {
  const f=await fixture(t); const outside=path.join(f.root,'private-dir'); await mkdir(outside); await writeFile(path.join(outside,'private.txt'),'SYNTHETIC_SECRET');
  await symlink(outside,path.join(f.source,'Memory/dist/escaped'),process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageLocalMemory(f.options),/RUNTIME_ASSET_ESCAPES_SOURCE/);
});

test('preview versions are constrained and never silently replace an existing release or tag', async () => {
  assert.equal(previewVersion('1.0.6-windows-preview.2','1.0.6'),'1.0.6-windows-preview.2');
  for(const version of ['1.0.6','v1.0.6-windows-preview.2','1.0.6-windows-preview.0','1.0.6-windows-preview.2;echo']) assert.throws(()=>previewVersion(version));
  assert.throws(()=>previewVersion('1.0.7-windows-preview.2','1.0.6'),/SOURCE_VERSION_MISMATCH/);
  let calls=0; await assertReleaseTargetFree({repository:'owner/repo',version:'1.0.6-windows-preview.2',token:'fixture',request:async(url,init)=>{calls++;assert.equal(init.headers.authorization,'Bearer fixture');return {status:404,ok:false};}}); assert.equal(calls,2);
  await assert.rejects(assertReleaseTargetFree({repository:'owner/repo',version:'1.0.6-windows-preview.2',token:'fixture',request:async()=>({status:200,ok:true})}),/TARGET_ALREADY_EXISTS/);
  await assert.rejects(assertReleaseTargetFree({repository:'owner/repo',version:'1.0.6-windows-preview.2',token:'fixture',request:async()=>({status:403,ok:false})}),/PREFLIGHT_FAILED:403/);
});


test('real node-gyp parser keeps the Electron target out of positional gyp inputs', () => {
  const require = createRequire(new URL('../../../wanx/apps/personal-client/package.json', import.meta.url));
  const createGyp = require(process.env.MEMOBOX_TEST_NODE_GYP || 'node-gyp');
  const directory = 'D:\\a\\fixture module\\better-sqlite3', version = '37.10.3';
  const script = path.join(directory, 'node-gyp.js');
  const old = createGyp();
  old.parseArgv([process.execPath, script, 'rebuild', '--target', version]);
  assert.notEqual(old.opts.target, version);
  assert.ok(old.todo[0].args.includes(version), 'legacy separated value becomes an unwanted Python .gyp input');
  const current = createGyp();
  current.parseArgv([process.execPath, ...nodeGypRebuildArgs(script, directory, version)]);
  assert.equal(current.opts.target, version);
  assert.equal(current.opts.directory, directory);
  assert.equal(current.opts.arch, 'x64');
  assert.equal(current.opts['dist-url'], 'https://electronjs.org/headers');
  assert.deepEqual(current.todo, [{ name: 'rebuild', args: [] }]);
});


test('real electron-builder resolves each native resource once from a complete config file', async t => {
  const manifest = new URL('../../../wanx/apps/personal-client/package.json', import.meta.url);
  const require = createRequire(manifest);
  const { getConfig } = require(process.env.MEMOBOX_TEST_BUILDER_CONFIG || 'app-builder-lib/out/util/config/config.js');
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  const root = await mkdtemp(path.join(tmpdir(), 'memobox-release-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = path.join(root, 'client'); await mkdir(client);
  await writeFile(path.join(client, 'package.json'), JSON.stringify(pkg));
  const sourceResources = pkg.build.win.extraResources;
  assert.ok(sourceResources.length > 0, 'fixture includes the actual packaged Windows network binaries');
  const old = await getConfig(client, null, structuredClone(pkg.build));
  assert.equal(old.win.extraResources.length, sourceResources.length * 2, 'legacy object config schedules both disk and option FileSets');
  const extendsOnly = await getConfig(client, null, { ...structuredClone(pkg.build), extends: null });
  assert.equal(extendsOnly.win.extraResources.length, sourceResources.length * 2, 'extends:null alone cannot prevent the package build merge');
  const version = '1.0.6-windows-preview.2', buildIdentity = { sourceCommit: 'fixture-commit', distributionClass: 'unsigned-internal-only' };
  const staged = path.join(root, 'staged'), output = path.join(root, 'artifacts');
  const configFile = await writePreviewBuildConfig({ configFile: path.join(root, 'resolved-build-config.json'), pkg, client, staged, output, version, buildIdentity });
  const resolved = await getConfig(client, configFile);
  assert.deepEqual(resolved.win.extraResources, sourceResources);
  assert.equal(resolved.extraResources.length, pkg.build.extraResources.length + 2);
  assert.deepEqual(resolved.extraResources.slice(0, pkg.build.extraResources.length), pkg.build.extraResources);
  assert.deepEqual(resolved.extraResources.find(row => row.to === 'local-memory'), { from: staged, to: 'local-memory' });
  assert.equal(resolved.afterPack, path.join(client, 'tools/package-client-native.mjs'));
  assert.equal(resolved.appId, pkg.build.appId);
  assert.equal(resolved.productName, pkg.build.productName);
  assert.equal(resolved.win.executableName, 'WANX');
  assert.equal(resolved.win.signExecutable, false);
  assert.notEqual(resolved.win.signAndEditExecutable, false, 'unsigned previews retain icon and executable metadata editing');
  assert.equal(resolved.forceCodeSigning, false);
  assert.equal(resolved.nsis.include, path.join(client, 'shell/installer.nsh'));
  assert.equal(resolved.nsis.deleteAppDataOnUninstall, false);
  assert.equal(resolved.directories.output, output);
  assert.deepEqual(resolved.extraMetadata, { version, wanxBuild: buildIdentity });
  assert.deepEqual(resolved.files, (await getConfig(client)).files);
});

test('packaging CLI exits nonzero even if a dependency resets exitCode before exit', () => {
  const script = new URL('../package-windows-preview.mjs', import.meta.url);
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,process.on("beforeExit",()=>{process.exitCode=0})', fileURLToPath(script), '--version', 'invalid'], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WINDOWS_PREVIEW_VERSION_REQUIRED/);
});


async function sqliteFixture(t) {
  const f = await fixture(t);
  await f.pkg('Memory', '@memmy/memory', '2.1.7', { 'better-sqlite3': '^13.0.3' });
  await f.pkg('App/backend', '@memmy/backend', '0.0.0', { '@memmy/agent-source-readers': 'workspace:*' });
  await f.pkg('Memory/AgentSourceReaders', '@memmy/agent-source-readers', '0.0.0', { 'better-sqlite3': '^12.6.3' });
  await f.pkg('Memory/AgentSourceReaders/node_modules/better-sqlite3', 'better-sqlite3', '12.11.1');
  await symlink(path.join(f.source, 'Memory/AgentSourceReaders'), path.join(f.source, 'node_modules/@memmy/agent-source-readers'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.file('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    'Memory': { name: '@memmy/memory', dependencies: { 'better-sqlite3': '^13.0.3' } },
    'Memory/AgentSourceReaders': { name: '@memmy/agent-source-readers', dependencies: { 'better-sqlite3': '^12.6.3' } },
    'node_modules/better-sqlite3': { version: '13.0.3' },
    'Memory/AgentSourceReaders/node_modules/better-sqlite3': { version: '12.11.1' },
  } }));
  f.options.packages = ['Memory', 'Memory/AgentSourceReaders', 'App/backend'];
  f.options.required = ['Memory/dist/index.js'];
  return f;
}

test('SQLite lock guard accepts 12/13 and verifies canonical and aliased consumers with relative diagnostics', async t => {
  const f = await sqliteFixture(t), runtime = await stageLocalMemory(f.options);
  const diagnostics = await assertNativeSqliteLock({ source: f.source, destination: f.destination, packages: runtime.packages });
  assert.equal(diagnostics.length, 5, 'two source consumers and three staged physical consumers');
  assert.deepEqual([...new Set(diagnostics.map(item => item.version))].sort(), ['12.11.1', '13.0.3']);
  assert.equal(diagnostics.filter(item => item.scope === 'staged' && item.version === '12.11.1').length, 2);
  for (const item of diagnostics) {
    assert.equal(item.version, item.expectedVersion);
    assert.equal(path.isAbsolute(item.consumer), false);
    assert.equal(path.isAbsolute(item.sqlitePath), false);
    assert.equal(item.sqlitePath.includes(f.root), false);
  }
});

test('SQLite lock guard rejects a source readers install silently falling back to root 13', async t => {
  const f = await sqliteFixture(t);
  await rm(path.join(f.source, 'Memory/AgentSourceReaders/node_modules/better-sqlite3'), { recursive: true });
  const runtime = await stageLocalMemory(f.options);
  await assert.rejects(assertNativeSqliteLock({ source: f.source, destination: f.destination, packages: runtime.packages }), error => {
    assert.match(error.message, /SQLITE_LOCK_VERSION_MISMATCH/);
    const detail = JSON.parse(error.message.slice(error.message.indexOf(':') + 1));
    assert.deepEqual(detail, { scope: 'source', consumer: 'Memory/AgentSourceReaders', lockPath: 'Memory/AgentSourceReaders/node_modules/better-sqlite3', expectedVersion: '12.11.1', sqlitePath: 'node_modules/better-sqlite3', version: '13.0.3' });
    return true;
  });
});

test('SQLite lock guard rejects root 13 fallback independently in either staged reader copy', async t => {
  for (const copy of ['Memory/AgentSourceReaders', 'node_modules/@memmy/agent-source-readers']) {
    const f = await sqliteFixture(t), runtime = await stageLocalMemory(f.options);
    await rm(path.join(f.destination, copy, 'node_modules/better-sqlite3'), { recursive: true });
    await assert.rejects(assertNativeSqliteLock({ source: f.source, destination: f.destination, packages: runtime.packages }), error => {
      assert.match(error.message, /SQLITE_LOCK_VERSION_MISMATCH/);
      const detail = JSON.parse(error.message.slice(error.message.indexOf(':') + 1));
      assert.equal(detail.scope, 'staged'); assert.equal(detail.consumer, copy);
      assert.equal(detail.version, '13.0.3'); assert.equal(detail.expectedVersion, '12.11.1');
      assert.equal(detail.sqlitePath, 'node_modules/better-sqlite3');
      return true;
    });
  }
});
