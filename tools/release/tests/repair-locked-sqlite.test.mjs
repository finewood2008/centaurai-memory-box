import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractLockedSqlite, repairLockedSqlite } from '../repair-locked-sqlite.mjs';

const clientRequire = createRequire(new URL('../../../wanx/apps/personal-client/package.json', import.meta.url));
const gyp = process.env.MEMOBOX_TEST_NODE_GYP ? path.join(process.env.MEMOBOX_TEST_NODE_GYP, 'package.json') : clientRequire.resolve('node-gyp/package.json');
const tar = createRequire(gyp)('tar');
const leaf = 'Memory/AgentSourceReaders/node_modules/better-sqlite3';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'memobox-sqlite-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), temporary = path.join(root, 'out'), archive = path.join(root, 'archive');
  await mkdir(path.join(source, 'Memory/AgentSourceReaders'), { recursive: true });
  await mkdir(temporary); await mkdir(path.join(archive, 'package/lib'), { recursive: true });
  await writeFile(path.join(archive, 'package/package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.11.1' }));
  await writeFile(path.join(archive, 'package/lib/index.js'), 'synthetic SQLite package');
  const tarball = path.join(root, 'fixture.tgz');
  await tar.c({ file: tarball, cwd: archive, gzip: true }, ['package']);
  const bytes = await readFile(tarball);
  const lock = { lockfileVersion: 3, packages: { [leaf]: { version: '12.11.1', resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.11.1.tgz', integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } } };
  const originals = { 'package.json': '{"name":"synthetic-source","private":true}\n', 'Memory/AgentSourceReaders/package.json': '{"name":"@memmy/agent-source-readers","version":"0.0.0"}\n', 'package-lock.json': JSON.stringify(lock, null, 2) + '\n' };
  for (const [name, text] of Object.entries(originals)) await writeFile(path.join(source, name), text);
  const options = { source, temporary, request: async () => new Response(bytes), extract: (file, destination) => extractLockedSqlite(file, destination, tar) };
  return { root, source, temporary, archive, bytes, lock, originals, options, target: path.join(source, leaf), tarball };
}

async function assertOriginals(f) {
  for (const [name, text] of Object.entries(f.originals)) assert.equal(await readFile(path.join(f.source, name), 'utf8'), text);
  assert.deepEqual(await readdir(f.temporary), [], 'only the repair-created temporary directory is removed');
}

test('repairs only the locked missing leaf using a verified tarball and preserves source manifests', async t => {
  const f = await fixture(t); let requests = 0;
  f.options.request = async (url, options) => { requests++; assert.equal(url, f.lock.packages[leaf].resolved); assert.equal(options.redirect, 'error'); return new Response(f.bytes); };
  assert.deepEqual(await repairLockedSqlite(f.options), { status: 'repaired', path: leaf, version: '12.11.1' });
  assert.equal(await readFile(path.join(f.target, 'lib/index.js'), 'utf8'), 'synthetic SQLite package');
  assert.deepEqual(await repairLockedSqlite(f.options), { status: 'present', path: leaf, version: '12.11.1' });
  assert.equal(requests, 1, 'existing correct packages never download or overwrite');
  await assertOriginals(f);
});

test('normalizes only the npmmirror host to the exact official locked tarball path', async t => {
  const f = await fixture(t); f.lock.packages[leaf].resolved = f.lock.packages[leaf].resolved.replace('registry.npmjs.org', 'registry.npmmirror.com');
  f.originals['package-lock.json'] = JSON.stringify(f.lock) + '\n'; await writeFile(path.join(f.source, 'package-lock.json'), f.originals['package-lock.json']);
  f.options.request = async url => { assert.equal(new URL(url).hostname, 'registry.npmjs.org'); return new Response(f.bytes); };
  await repairLockedSqlite(f.options); await assertOriginals(f);
});

test('integrity mismatch fails before extraction and leaves the dependency absent', async t => {
  const f = await fixture(t); let extracted = false;
  f.options.request = async () => new Response(Buffer.from('invalid archive'));
  f.options.extract = async () => { extracted = true; };
  await assert.rejects(repairLockedSqlite(f.options), /SQLITE_REPAIR_INTEGRITY_MISMATCH/);
  assert.equal(extracted, false); await assert.rejects(readFile(path.join(f.target, 'package.json')), { code: 'ENOENT' });
  await assertOriginals(f);
});

test('existing incorrect directories and symbolic leaves are conflicts rather than overwritten', async t => {
  for (const link of [false, true]) {
    const f = await fixture(t); await mkdir(path.dirname(f.target), { recursive: true });
    const existing = link ? path.join(f.root, 'existing') : f.target; await mkdir(existing);
    const original = '{"name":"better-sqlite3","version":"13.0.3"}'; await writeFile(path.join(existing, 'package.json'), original);
    if (link) await symlink(existing, f.target, process.platform === 'win32' ? 'junction' : 'dir');
    f.options.request = async () => { throw new Error('must not download'); };
    await assert.rejects(repairLockedSqlite(f.options), link ? /EXISTING_LEAF_CONFLICT/ : /EXISTING_VERSION_CONFLICT/);
    assert.equal(await readFile(path.join(existing, 'package.json'), 'utf8'), original); await assertOriginals(f);
  }
});

test('rejects a linked target parent and temporary paths within the source', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.dirname(f.target), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(repairLockedSqlite(f.options), /PARENT_CONFLICT/);
  await assert.rejects(repairLockedSqlite({ ...f.options, temporary: f.source }), /TEMP_OVERLAPS_SOURCE/);
  assert.deepEqual(await readdir(outside), []); await assertOriginals(f);
});

test('real tar preflight refuses links before writing any extracted entries', async t => {
  const f = await fixture(t); await link(path.join(f.archive, 'package/lib/index.js'), path.join(f.archive, 'package/lib/alias.js'));
  tar.c({ file: f.tarball, cwd: f.archive, sync: true, gzip: true }, ['package']);
  const output = path.join(f.root, 'extract-output'); await mkdir(output);
  await assert.rejects(extractLockedSqlite(f.tarball, output, tar), /UNSAFE_ARCHIVE/);
  assert.deepEqual(await readdir(output), []);
});

test('a target created while downloading is retained and reported as a conflict', async t => {
  const f = await fixture(t);
  f.options.request = async () => { await mkdir(f.target, { recursive: true }); await writeFile(path.join(f.target, 'keep.txt'), 'concurrent fixture'); return new Response(f.bytes); };
  await assert.rejects(repairLockedSqlite(f.options), /EXISTING_LEAF_CONFLICT/);
  assert.equal(await readFile(path.join(f.target, 'keep.txt'), 'utf8'), 'concurrent fixture'); await assertOriginals(f);
});
