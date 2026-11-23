import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {requiredRuntimeFiles} from '../../../tools/stage-local-memory.mjs';
import {prepareMemoryRuntime, probeMemoryRuntime} from './prepare-memory-runtime.mjs';

const client = fileURLToPath(new URL('../', import.meta.url));
const exists = async file => Boolean(await stat(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
}));

export function resolveMemorySource(clientRoot = client, env = process.env) {
  return env.WANX_MEMORY_BOX_ROOT?.trim()
    ? path.resolve(env.WANX_MEMORY_BOX_ROOT.trim()) : path.resolve(clientRoot, '../memory');
}

async function treeFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), {withFileTypes:true})) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await treeFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('MEMORY_BUILD_INPUT_NOT_FILE:' + relative);
  }
  return result;
}

async function sourceFingerprint(source, clientRoot, managed) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({source, managed, platform:process.platform, arch:process.arch,
    electron:createRequire(path.join(clientRoot, 'package.json'))('electron/package.json').version}));
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
    {cwd:source, encoding:'utf8', stdio:'pipe', maxBuffer:32 * 1024 * 1024}).split('\0').filter(Boolean).sort();
  for (const name of names) {
    if (!await exists(path.join(source, name))) continue;
    hash.update(name); hash.update('\0'); hash.update(await readFile(path.join(source, name))); hash.update('\0');
  }
  for (const file of [fileURLToPath(import.meta.url), fileURLToPath(new URL('./prepare-memory-runtime.mjs', import.meta.url)),
    fileURLToPath(new URL('../../../tools/stage-local-memory.mjs', import.meta.url)),
    fileURLToPath(new URL('../../../tools/repair-locked-sqlite.mjs', import.meta.url))]) hash.update(await readFile(file));
  return hash.digest('hex');
}

async function validFrontend(root, names) {
  return Array.isArray(names) && names.includes('wanx-memory.html') &&
    (await Promise.all(names.map(name => exists(path.join(root, name))))).every(Boolean);
}

export async function buildMemoryWorkspace({clientRoot = client, env = process.env, run = execFileSync,
  fingerprint = sourceFingerprint, prepareRuntime = prepareMemoryRuntime, probeRuntime = probeMemoryRuntime} = {}) {
  const source = resolveMemorySource(clientRoot, env), build = path.join(clientRoot, 'build');
  const renderer = path.join(source, 'App/frontend/desktop'), vite = path.join(source, 'node_modules/vite/bin/vite.js');
  if (!await exists(path.join(renderer, 'wanx-memory.html'))) throw new Error('MEMORY_SOURCE_MISSING:' + source);
  if (!await exists(vite)) throw new Error('MEMORY_DEPENDENCIES_MISSING: run npm ci --prefix ' + source);
  const managed = !env.MEMMY_RUNTIME_CONFIG_PATH?.trim();
  const key = await fingerprint(source, clientRoot, managed);
  const cachedUI = path.join(build, 'memory-ui'), runtime = path.join(build, 'local-memory');
  const stamp = path.join(build, 'memory-build.json');
  let previous;
  try { previous = JSON.parse(await readFile(stamp, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  let cached = previous?.fingerprint === key && await validFrontend(cachedUI, previous.frontend);
  if (cached && managed) {
    cached = (await Promise.all(requiredRuntimeFiles.map(name => exists(path.join(runtime, name))))).every(Boolean);
    if (cached) {
      try { cached = (await probeRuntime({runtime, clientRoot, env, run})).ok === true; } catch { cached = false; }
    }
  }
  await mkdir(build, {recursive:true});
  if (!cached) {
    const temporary = await mkdtemp(path.join(build, '.memory-build-'));
    try {
      const options = {cwd:source, env, stdio:'inherit', windowsHide:true};
      const npm = (args) => env.npm_execpath
        ? run(process.execPath, [env.npm_execpath, ...args], options)
        : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {...options, shell:process.platform === 'win32'});
      if (managed) {
        npm(['run', 'memory:build']);
        npm(['run', 'build', '-w', '@memmy/backend']);
      }
      const nextUI = path.join(temporary, 'ui');
      run(process.execPath, [vite, 'build', '--mode', 'wanx-memory', '--outDir', nextUI, '--emptyOutDir'],
        {...options, cwd:renderer});
      const frontend = (await treeFiles(nextUI)).sort();
      if (!await validFrontend(nextUI, frontend)) throw new Error('MEMORY_FRONTEND_BUILD_MISSING');
      if (managed) await prepareRuntime({source, clientRoot, env, run});
      await rm(cachedUI, {recursive:true, force:true});
      await rename(nextUI, cachedUI);
      await writeFile(stamp, JSON.stringify({schemaVersion:1, fingerprint:key, frontend}) + '\n');
    } finally { await rm(temporary, {recursive:true, force:true}); }
  }
  // build:studio recreates build/app. Restore the cached UI on every start.
  const output = path.join(build, 'app/local-ui/memory');
  await rm(output, {recursive:true, force:true});
  await mkdir(path.dirname(output), {recursive:true});
  await cp(cachedUI, output, {recursive:true});
  await writeFile(path.join(output, '.wanx-source'), source + '\n');
  return {source, output, runtime:managed ? runtime : null, cached};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildMemoryWorkspace();
  console.log(`Memory workspace ready (${result.cached ? 'cached' : 'built'}).`);
}
