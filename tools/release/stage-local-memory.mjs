import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const runtimePackages = [
  'Memory', 'App/backend', 'Memory/AgentSourceCore', 'Memory/AgentSourceReaders',
  'Knowledge', 'Migrations', 'App/backend/local-api-contracts',
];
export const requiredRuntimeFiles = [
  'Memory/dist/src/server/index.js', 'Memory/dist/src/config/index.js', 'Memory/dist/src/config/writer.js',
  'App/backend/dist/src/index.js', 'App/backend/dist/src/adapters/outbound/memory-client/index.js',
];
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const exists = async file => Boolean(await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; }));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function canonicalDestination(candidate) {
  const missing = []; let parent = path.resolve(candidate);
  while (!await exists(parent)) {
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent); if (next === parent) throw new Error('RUNTIME_STAGE_PARENT_MISSING'); parent = next;
  }
  return path.join(await realpath(parent), ...missing);
}

const privateFile = name => name === '.env' || name.startsWith('.env.') || ['.git', '.github', '.local', '.runtime', '.cache', '.DS_Store', '.npmrc', '.netrc', '.git-credentials'].includes(name);
const workspaceAsset = name => ['package.json', 'dist', 'adapters', 'embedding-models'].includes(name) || /^(LICENSE|NOTICE|COPYING)(\.|$)/i.test(name);

// Copy only compiled workspace payloads and the installed production dependency
// graph. Resolve each dependency from its original package and preserve version
// conflicts in a local node_modules override; never ship source-machine links.
export async function stageLocalMemory({ source, destination, packages = runtimePackages, required = requiredRuntimeFiles }) {
  source = await realpath(source); destination = await canonicalDestination(destination);
  if (inside(source, destination) || inside(destination, source)) throw new Error('RUNTIME_STAGE_OVERLAPS_SOURCE');
  if (await exists(destination)) throw new Error('RUNTIME_STAGE_EXISTS');
  for (const file of required) if (!(await stat(path.join(source, file)).catch(() => null))?.isFile()) throw new Error('RUNTIME_INPUT_MISSING:' + file);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: 'centaurai-memobox-local-memory', private: true, type: 'module' }) + '\n');
  for (const name of ['LICENSE', 'NOTICE', 'COPYING']) if (await exists(path.join(source, name))) {
    const file = await realpath(path.join(source, name)); if (!inside(source, file)) throw new Error('RUNTIME_ASSET_ESCAPES_SOURCE:' + name);
    await cp(file, path.join(destination, name));
  }
  const planned = new Map(), inventory = [], nativeModules = [];
  async function find(name, from) {
    for (let dir = from; inside(source, dir); dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'));
      if (await exists(path.join(candidate, 'package.json'))) {
        const actual = await realpath(candidate);
        if (!inside(source, actual)) throw new Error('RUNTIME_DEPENDENCY_ESCAPES_SOURCE:' + name);
        return actual;
      }
      if (dir === source) break;
    }
  }
  function plannedDependency(name, from) {
    for (let dir = from; inside(destination, dir); dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'));
      if (planned.has(candidate)) return planned.get(candidate);
      if (dir === destination) break;
    }
  }
  async function copyPackage(from, to, workspace = false) {
    const manifest = await json(path.join(from, 'package.json')), identity = from;
    const already = planned.get(to);
    if (already) { if (already !== identity) throw new Error('RUNTIME_PACKAGE_COLLISION'); return; }
    planned.set(to, identity);
    await mkdir(to, { recursive: true });
    const filter = async file => {
      const relative = path.relative(from, file), parts = relative.split(path.sep);
      if (parts.some(part => privateFile(part) || part === 'node_modules')) return false;
      if (workspace && relative && !workspaceAsset(parts[0])) return false;
      const actual = await realpath(file);
      if (!inside(source, actual)) throw new Error('RUNTIME_ASSET_ESCAPES_SOURCE:' + manifest.name);
      return true;
    };
    await cp(from, to, { recursive: true, dereference: true, filter });
    inventory.push({ name: manifest.name, version: manifest.version, path: path.relative(destination, to).split(path.sep).join('/') });
    if (manifest.name === 'better-sqlite3') nativeModules.push(path.relative(destination, to).split(path.sep).join('/'));
    const names = new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.optionalDependencies || {}), ...Object.keys(manifest.peerDependencies || {})]);
    for (const name of [...names].sort()) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('RUNTIME_DEPENDENCY_NAME_INVALID');
      const optional = Object.hasOwn(manifest.optionalDependencies || {}, name) || manifest.peerDependenciesMeta?.[name]?.optional;
      const dependency = await find(name, from);
      if (!dependency) { if (optional) continue; throw new Error('RUNTIME_DEPENDENCY_MISSING:' + manifest.name + ':' + name); }
      if (plannedDependency(name, to) === dependency) continue;
      const global = path.join(destination, 'node_modules', ...name.split('/'));
      const target = !planned.has(global) ? global : path.join(to, 'node_modules', ...name.split('/'));
      const relative = path.relative(source, dependency);
      const isWorkspace = packages.includes(relative.split(path.sep).join('/'));
      await copyPackage(dependency, target, isWorkspace);
    }
  }
  for (const relative of packages) {
    const from = await realpath(path.join(source, relative));
    if (!inside(source, from)) throw new Error('RUNTIME_PACKAGE_ESCAPES_SOURCE');
    await copyPackage(from, path.join(destination, relative), true);
  }
  for (const file of required) if (!(await stat(path.join(destination, file))).isFile()) throw new Error('RUNTIME_OUTPUT_MISSING:' + file);
  const report = { schemaVersion: 1, packages: inventory.sort((a,b) => a.path.localeCompare(b.path)), nativeModules: nativeModules.sort() };
  await writeFile(path.join(destination, 'runtime-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
