import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const common = [
  'local-ui/application-presentation.js', 'local-ui/application-presentation.css',
  ...['space-shares.js','space-shares.css','space-workspaces.js','space-agent-hub.js','space-agent-hub.css','space-document-preview.css'].map(name => `local-ui/renderer/${name}`),
  ...['space-shares.mjs','assistant-service.mjs','assistant-channels.mjs','channel-qr.mjs','channel-qr.LICENSE'].map(name => `shell/${name}`),
  'local-ui/panel/panel-assistant.js', 'local-ui/panel/panel-assistant.css',
  'local-ui/renderer/channel-icons', 'local-ui/renderer/data-view.js', 'local-ui/renderer/data.css',
  'local-ui/renderer/device-setup.bundle.js', 'local-ui/renderer/wallet.bundle.js', 'local-ui/maintenance',
];
export function generatedClientPaths(edition) {
  if (!['personal', 'team'].includes(edition)) throw Error('EDITION_REQUIRED');
  return [...common, ...(edition === 'personal' ? [
    'applications/starlink', 'workshop', 'shell/personal-workshop.mjs', 'shell/personal-data-service.mjs',
    'shell/starlink-panel-service.mjs', 'local-ui/starlink',
    ...['workshop.js','workshop.css','personal-layout.css','material-theme.css','action-menus.js','studio-product.js','studio-home.css','construction.css'].map(name => `local-ui/renderer/${name}`),
    'local-ui/renderer/assets/material-v1', 'local-ui/renderer/assets/section-icons-v2', 'local-ui/renderer/assets/app-icons/workshop-v1.png',
  ] : [
    'applications/starlink/vendor/wanx-host-sdk', 'applications/starlink/wanx-app-kit',
    'studio', 'applications/studio.mjs', 'applications/studio-runtime',
    ...['team-service.mjs','team-data-service.mjs','wanx-mcp-bridge.mjs','personal-space.mjs','space-drive-routing.mjs','ai-dialogue.mjs'].map(name => `shell/${name}`),
    ...['ai-dialogue.js','ai-dialogue.css','personal-space.js','studio-home.js','studio-product.js','studio-intake.js','studio-input.js','studio-home.css','construction.js','construction.css','team-view.js','team-feature-access.js'].map(name => `local-ui/renderer/${name}`),
    'local-ui/renderer/assets/wanx-builder.svg',
  ])];
}
export const clientBuildDirectory = root => path.join(root, 'build', 'app');

// Every output ancestor is checked before mutation, so an old symlink cannot
// redirect an assembly into a source tree or a directory outside the build root.
export async function ensureBuildDirectory(clientRoot, output = clientBuildDirectory(clientRoot)) {
  const buildRoot = path.resolve(clientRoot, 'build');
  const relative = path.relative(buildRoot, path.resolve(output));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('CLIENT_BUILD_OUTPUT_INVALID');
  const ancestors = [buildRoot];
  for (const part of relative.split(path.sep)) ancestors.push(path.join(ancestors.at(-1), part));
  for (const dir of ancestors) {
    const info = await lstat(dir).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw Error('CLIENT_BUILD_OUTPUT_INVALID');
  }
  await mkdir(output, { recursive: true });
  return output;
}

async function packageRoot(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  for (const directory of require.resolve.paths(`${name}/package.json`) || []) {
    const candidate = path.join(directory, name);
    try { if ((await lstat(path.join(candidate, 'package.json'))).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  throw Error(`CLIENT_BUILD_DEPENDENCY_MISSING:${name}`);
}
async function copyDependencies(source, target) {
  const root = await realpath(source);
  const copied = new Set();
  async function visit(from) {
    const pkg = JSON.parse(await readFile(path.join(from, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies })) {
      let dependency;
      try { dependency = await realpath(await packageRoot(name, from)); }
      catch (error) { if (Object.hasOwn(pkg.optionalDependencies || {}, name) || pkg.peerDependenciesMeta?.[name]?.optional) continue; throw error; }
      const relative = path.relative(root, dependency);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw Error(`CLIENT_BUILD_DEPENDENCY_OUTSIDE_ROOT:${name}`);
      if (copied.has(dependency)) continue;
      copied.add(dependency);
      // Preserve npm placement: hoisted siblings must share one module instance,
      // while physically nested installations must retain their own versions.
      const destination = path.join(target, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(dependency, destination, { recursive: true, dereference: true, filter: file => !path.relative(dependency, file).split(path.sep).includes('node_modules') });
      await visit(dependency);
    }
  }
  await visit(root);
}

export async function prepareClientBuild(clientRoot, { edition, dependencies = true } = {}) {
  edition ||= JSON.parse(await readFile(path.join(clientRoot, 'package.json'), 'utf8')).wanxEdition;
  const output = await ensureBuildDirectory(clientRoot);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const generated = [...generatedClientPaths(edition), 'applications/starlink'];
  // Include new, nonignored source files during development as well as tracked
  // working-tree edits. Git's ignore rules exclude caches, secrets and artifacts.
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: clientRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  for (const name of new Set(names)) {
    if (name.startsWith('build/') || generated.some(item => name === item || name.startsWith(`${item}/`))) continue;
    const source = path.join(clientRoot, name);
    const info = await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!info) continue; // A working-tree deletion must not resurrect old source.
    if (!info.isFile()) throw Error(`CLIENT_BUILD_SOURCE_NOT_FILE:${name}`);
    await mkdir(path.dirname(path.join(output, name)), { recursive: true });
    await cp(source, path.join(output, name));
  }
  const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
  delete pkg.build;
  delete pkg.scripts;
  await writeFile(path.join(output, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  if (dependencies) await copyDependencies(clientRoot, output);
  return output;
}
