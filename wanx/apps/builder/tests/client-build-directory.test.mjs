import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepareClientBuild, clientBuildDirectory } from '../tools/client-build-directory.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-client-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, '.gitignore'), 'build/\nnode_modules/\n.env\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', wanxEdition: 'personal', scripts: {}, build: {} }));
  await mkdir(path.join(root, 'shell'));
  await writeFile(path.join(root, 'shell/main.mjs'), 'source original');
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

test('isolated assembly copies current source and excludes generated copies, secrets and stale outputs', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'shell/main.mjs'), 'edited source');
  await writeFile(path.join(root, 'shell/new.mjs'), 'new source');
  await writeFile(path.join(root, 'shell/personal-workshop.mjs'), 'stale generated copy');
  await writeFile(path.join(root, '.env'), 'secret');
  const output = await prepareClientBuild(root, { dependencies: false });
  assert.equal(output, clientBuildDirectory(root));
  assert.equal(await readFile(path.join(output, 'shell/main.mjs'), 'utf8'), 'edited source');
  assert.equal(await readFile(path.join(output, 'shell/new.mjs'), 'utf8'), 'new source');
  for (const name of ['shell/personal-workshop.mjs', '.env']) await assert.rejects(readFile(path.join(output, name)), { code: 'ENOENT' });
  const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
  assert.equal(pkg.build, undefined); assert.equal(pkg.scripts, undefined);
  await writeFile(path.join(output, 'obsolete'), 'stale');
  await rm(path.join(root, 'shell/main.mjs'));
  await prepareClientBuild(root, { dependencies: false });
  for (const name of ['obsolete', 'shell/main.mjs']) await assert.rejects(readFile(path.join(output, name)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'shell/personal-workshop.mjs'), 'utf8'), 'stale generated copy');
});

test('build output symlinks cannot redirect assembly into source', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'build'));
  await symlink(path.join(root, 'shell'), clientBuildDirectory(root), 'dir');
  await assert.rejects(prepareClientBuild(root, { dependencies: false }), /CLIENT_BUILD_OUTPUT_INVALID/);
  assert.equal(await readFile(path.join(root, 'shell/main.mjs'), 'utf8'), 'source original');
});

test('production dependencies retain their own dependency versions inside isolated runtime', async t => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies = { one: '1' };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [relative, manifest] of [
    ['node_modules/one', { name: 'one', dependencies: { two: '2' } }],
    ['node_modules/two', { name: 'two', version: '2' }],
    ['node_modules/dev-only', { name: 'dev-only' }],
  ]) {
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(path.join(root, relative, 'package.json'), JSON.stringify(manifest));
  }
  const output = await prepareClientBuild(root);
  const fromOne = createRequire(path.join(output, 'node_modules/one/package.json'));
  assert.equal(JSON.parse(await readFile(fromOne.resolve('two/package.json'), 'utf8')).version, '2');
  await assert.rejects(readFile(path.join(output, 'node_modules/dev-only/package.json')), { code: 'ENOENT' });
});

test("production package names that also name Node builtins are copied", async t => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  pkg.dependencies = { string_decoder: "1" };
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  const dependency = path.join(root, "node_modules/string_decoder");
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "string_decoder", version: "1.0.0" }));
  const output = await prepareClientBuild(root);
  assert.equal(JSON.parse(await readFile(path.join(output, "node_modules/string_decoder/package.json"), "utf8")).version, "1.0.0");
});

test('dependency assembly preserves a shared registration module across sibling consumers', async t => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies = { registration: '1', serializer: '1' };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [name, dependencies, source] of [
    ['schema', {}, 'module.exports = new Map();'],
    ['registration', { schema: '1' }, 'require("schema").set("AlgorithmIdentifier", true); module.exports = {};'],
    ['serializer', { schema: '1', registration: '1' }, 'require("registration"); if (!require("schema").has("AlgorithmIdentifier")) throw Error("Cannot get schema for AlgorithmIdentifier target"); module.exports = true;'],
  ]) {
    const directory = path.join(root, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
    await writeFile(path.join(directory, 'index.js'), source);
  }
  const sourceRequire = createRequire(path.join(root, 'package.json'));
  assert.equal(sourceRequire('serializer'), true);
  const output = await prepareClientBuild(root);
  const builtRequire = createRequire(path.join(output, 'package.json'));
  assert.equal(builtRequire('serializer'), true);
  const registration = createRequire(builtRequire.resolve('registration'));
  const serializer = createRequire(builtRequire.resolve('serializer'));
  assert.equal(registration.resolve('schema'), serializer.resolve('schema'));
});

test('assembly retains physically distinct versions and closes cycles without duplication', async t => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies = { one: '1', two: '1' };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [relative, manifest, code] of [
    ['one', { name: 'one', dependencies: { shared: '1', two: '1' } }, 'module.exports = { shared: require("shared"), cycle: () => require("two") };'],
    ['two', { name: 'two', dependencies: { shared: '2', one: '1' } }, 'module.exports = { shared: require("shared"), cycle: () => require("one") };'],
    ['shared', { name: 'shared', version: '1.0.0' }, 'module.exports = { version: 1 };'],
    ['two/node_modules/shared', { name: 'shared', version: '2.0.0' }, 'module.exports = { version: 2 };'],
  ]) {
    const directory = path.join(root, 'node_modules', relative);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'index.js'), code);
  }
  const output = await prepareClientBuild(root);
  const require = createRequire(path.join(output, 'package.json'));
  const one = require('one'), two = require('two');
  assert.equal(one.shared.version, 1);
  assert.equal(two.shared.version, 2);
  assert.notEqual(one.shared, two.shared);
  assert.equal(one.cycle(), two);
  assert.equal(two.cycle(), one);
});
