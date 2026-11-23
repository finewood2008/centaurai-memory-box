import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {stageLocalMemory} from '../../../tools/stage-local-memory.mjs';
import {repairLockedSqlite} from '../../../tools/repair-locked-sqlite.mjs';
import {assertNativeSqliteLock} from '../../../tools/package-windows-preview.mjs';

const probeCode = String.raw`
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const root=process.argv[1], report=JSON.parse(fs.readFileSync(path.join(root,'runtime-manifest.json'),'utf8'));
const modules=[];
for(const relative of report.nativeModules){
  const file=path.resolve(root,relative);
  if(!file.startsWith(path.resolve(root)+path.sep))throw Error('MEMORY_NATIVE_PATH_INVALID');
  const pkg=JSON.parse(fs.readFileSync(path.join(file,'package.json'),'utf8'));
  let db,ok=false;
  try{const Database=require(file);db=new Database(':memory:');ok=db.prepare('SELECT 1 AS ok').get().ok===1}catch{}finally{db?.close()}
  modules.push({path:relative,version:pkg.version,ok});
}
let vector=false,db;
try{
  const memory=createRequire(path.join(root,'Memory/package.json'));
  const Database=memory('better-sqlite3');db=new Database(':memory:');
  memory('sqlite-vec').load(db);
  vector=typeof db.prepare('SELECT vec_version() AS version').get().version==='string';
}catch{}finally{db?.close()}
console.log(JSON.stringify({platform:process.platform,arch:process.arch,abi:process.versions.modules,modules,vector,ok:modules.length>0&&modules.every(item=>item.ok)&&vector}));
`;

function clientTools(clientRoot) {
  const require = createRequire(path.join(clientRoot, 'package.json'));
  return {require, executable:require('electron'), version:require('electron/package.json').version};
}

const sqliteBinary = path.join('build', 'Release', 'better_sqlite3.node');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sqliteBuildInputs = file => !['build', 'node_modules'].includes(file.split(path.sep)[0]);

async function sqliteCacheFile({directory, source, env, platform, version, abi, arch, gypVersion}) {
  if (platform !== 'win32' || !env.WANX_SQLITE_CACHE || !env.WANX_SQLITE_TOOLCHAIN_KEY) return null;
  const lock = digest(await readFile(path.join(source, 'package-lock.json')));
  const hash = createHash('sha256').update(JSON.stringify({
    schema:1, lock, platform, version, abi, arch, gypVersion, toolchain:env.WANX_SQLITE_TOOLCHAIN_KEY,
  }));
  async function visit(prefix = '') {
    for (const name of (await readdir(path.join(directory, prefix))).sort()) {
      const relative = path.join(prefix, name);
      if (!sqliteBuildInputs(relative)) continue;
      const file = path.join(directory, relative);
      const info = await lstat(file);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) hash.update(JSON.stringify([relative, digest(await readFile(file))]));
      else throw new Error('MEMORY_SQLITE_CACHE_INPUT_NOT_FILE:' + relative);
    }
  }
  await visit();
  return path.join(env.WANX_SQLITE_CACHE, hash.digest('hex') + '.json');
}

async function restoreSqliteCache(file, binary) {
  if (!file) return false;
  try {
    if (!(await lstat(file)).isFile()) return false;
    const entry = JSON.parse(await readFile(file, 'utf8'));
    const bytes = Buffer.from(entry.data, 'base64');
    if (bytes.length < 1024 || bytes.toString('ascii', 0, 2) !== 'MZ' || digest(bytes) !== entry.sha256) return false;
    await mkdir(path.dirname(binary), {recursive:true});
    await writeFile(binary, bytes);
    return true;
  } catch { return false; }
}

async function saveSqliteCache(file, binary) {
  if (!file) return;
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const bytes = await readFile(binary);
    await mkdir(path.dirname(file), {recursive:true});
    await writeFile(temp, JSON.stringify({sha256:digest(bytes), data:bytes.toString('base64')}), {flag:'wx', mode:0o600});
    await rename(temp, file);
  } catch (error) { console.warn('SQLite 缓存写入失败：' + error.code); }
  finally { await rm(temp, {force:true}).catch(() => {}); }
}

async function rebuildLegacySqlite({directory, clientRoot, gyp, version, arch, env, run, platform}) {
  const rebuild = target => run(process.execPath, [gyp, 'rebuild', `--directory=${target}`,
    `--target=${version}`, `--arch=${arch}`, '--dist-url=https://electronjs.org/headers'], {
    cwd:clientRoot, env, stdio:'inherit', windowsHide:true,
  });
  if (platform !== 'win32') return rebuild(directory);

  // MSBuild appends intermediate filenames below the addon directory. Both
  // runtime dependency locations can be too deep, even in a short worktree.
  const work = await mkdtemp(path.join(tmpdir(), 'wx-sql-'));
  const binary = sqliteBinary;
  try {
    await cp(directory, work, {
      recursive:true,
      filter: file => sqliteBuildInputs(path.relative(directory, file)),
    });
    rebuild(work);
    await mkdir(path.dirname(path.join(directory, binary)), {recursive:true});
    await copyFile(path.join(work, binary), path.join(directory, binary));
  } finally {
    await rm(work, {recursive:true, force:true, maxRetries:10, retryDelay:200});
  }
}

// Probe in the actual Electron Node runtime, never the build host's Node ABI.
export function probeMemoryRuntime({runtime, clientRoot, executable = clientTools(clientRoot).executable,
  env = process.env, run = execFileSync}) {
  const childEnv = {...env, ELECTRON_RUN_AS_NODE:'1'};
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  return JSON.parse(run(executable, ['-e', probeCode, runtime], {
    cwd:clientRoot ?? runtime, env:childEnv,
    encoding:'utf8', stdio:'pipe', windowsHide:true, timeout:30_000,
  }).toString().trim());
}

// Prepare away from the current runtime. A failed native build cannot replace a
// previously usable payload, and the source workspace keeps its ordinary Node ABI.
export async function prepareMemoryRuntime({
  source, clientRoot, env = process.env, run = execFileSync,
  stage = stageLocalMemory, repair = repairLockedSqlite, validateLock = assertNativeSqliteLock,
  platform = process.platform, move = rename, wait = delay,
}) {
  const build = path.join(clientRoot, 'build');
  const info = await lstat(build).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error('MEMORY_BUILD_DIRECTORY_INVALID');
  await mkdir(build, {recursive:true});
  const work = await mkdtemp(path.join(build, '.memory-runtime-'));
  const next = path.join(work, 'next'), previous = path.join(work, 'previous');
  const destination = path.join(build, 'local-memory');
  const moveRuntime = async (from, to) => {
    // Windows can briefly retain native-module locks after compilation/probing.
    // Retry the directory swap, without rebuilding or discarding the old runtime.
    for (let attempt = 0; ; attempt++) {
      try { return await move(from, to); }
      catch (error) {
        if (platform !== 'win32' || !['EPERM','EBUSY','EACCES'].includes(error.code)) throw error;
        if (attempt >= 10) throw Object.assign(new Error('MEMORY_RUNTIME_BUSY: Windows 仍占用记忆运行目录，请确认已从托盘退出记忆盒子后重试。', {cause:error}), {code:'MEMORY_RUNTIME_BUSY'});
        await wait(Math.min((attempt + 1) * 200, 1000));
      }
    }
  };
  let saved = false, preserve = false;
  try {
    await repair({source, temporary:work});
    const report = await stage({source, destination:next});
    await validateLock({source, destination:next, packages:report.packages});
    let result = probeMemoryRuntime({runtime:next, clientRoot, env, run});
    if (!Array.isArray(result.modules) || !result.modules.length) throw Error('MEMORY_SQLITE_NATIVE_MODULE_MISSING');
    const tools = clientTools(clientRoot);
    const loadsInElectron = relative => {
      try {
        const probe = probeMemoryRuntime({runtime:next, clientRoot, env, run});
        return probe.abi === result.abi && probe.arch === result.arch &&
          probe.modules.find(item => item.path === relative)?.ok === true;
      } catch { return false; }
    };
    for (const entry of result.modules.filter(item => !item.ok)) {
      // v13 ships N-API prebuilds and must not be rebuilt using the legacy gyp path.
      if (Number(entry.version.split('.')[0]) >= 13) throw Error('MEMORY_SQLITE_PREBUILD_UNAVAILABLE:' + entry.path);
      const directory = path.resolve(next, entry.path);
      if (!directory.startsWith(next + path.sep)) throw Error('MEMORY_NATIVE_PATH_INVALID');
      const binary = path.join(directory, sqliteBinary);
      let cacheFile;
      try {
        if (platform === 'win32' && env.WANX_SQLITE_CACHE && env.WANX_SQLITE_TOOLCHAIN_KEY)
          cacheFile = await sqliteCacheFile({directory, source, env, version:tools.version,
            abi:result.abi, arch:result.arch, platform, gypVersion:tools.require('node-gyp/package.json').version});
      } catch (error) { console.warn('SQLite 缓存输入检查失败：' + (error.code || error.message)); }
      if (await restoreSqliteCache(cacheFile, binary)) {
        if (loadsInElectron(entry.path)) {
          console.log('SQLite 原生编译缓存命中：' + entry.path);
          continue;
        }
        await rm(binary, {force:true});
        console.warn('SQLite 缓存加载探针失败，重新编译：' + entry.path);
      }
      const compileStart = performance.now();
      await rebuildLegacySqlite({
        directory, clientRoot, gyp:tools.require.resolve('node-gyp/bin/node-gyp.js'),
        version:tools.version, arch:result.arch, env, run, platform,
      });
      console.log('SQLite 原生编译：' + entry.path + ' ' + ((performance.now() - compileStart) / 1000).toFixed(1) + ' 秒');
      if (cacheFile && loadsInElectron(entry.path)) await saveSqliteCache(cacheFile, binary);
    }
    result = probeMemoryRuntime({runtime:next, clientRoot, env, run});
    if (!result.ok) throw Error('MEMORY_RUNTIME_NATIVE_SMOKE_FAILED');
    try { await moveRuntime(destination, previous); saved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await moveRuntime(next, destination); }
    catch (error) {
      if (saved) {
        try { await moveRuntime(previous, destination); saved = false; }
        catch (restoreError) { preserve = true; throw restoreError; }
      }
      throw error;
    }
    return destination;
  } finally {
    if (!preserve) await rm(work, {recursive:true, force:true, maxRetries:10, retryDelay:200});
  }
}
