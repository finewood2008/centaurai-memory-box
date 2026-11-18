import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {lstat, mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
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
    for (const entry of result.modules.filter(item => !item.ok)) {
      // v13 ships N-API prebuilds and must not be rebuilt using the legacy gyp path.
      if (Number(entry.version.split('.')[0]) >= 13) throw Error('MEMORY_SQLITE_PREBUILD_UNAVAILABLE:' + entry.path);
      const directory = path.resolve(next, entry.path);
      if (!directory.startsWith(next + path.sep)) throw Error('MEMORY_NATIVE_PATH_INVALID');
      run(process.execPath, [tools.require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild',
        `--directory=${directory}`, `--target=${tools.version}`, `--arch=${result.arch}`,
        '--dist-url=https://electronjs.org/headers'], {
        cwd:clientRoot, env, stdio:'inherit', windowsHide:true,
      });
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
