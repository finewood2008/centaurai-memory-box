import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { stageLocalMemory } from '../stage-local-memory.mjs';
import { assertReleaseTargetFree, previewVersion } from '../package-windows-preview.mjs';

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
