import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const leaf = 'Memory/AgentSourceReaders/node_modules/better-sqlite3';
const version = '12.11.1';
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const maybeStat = file => lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
function installedTar() {
  const require = createRequire(new URL('../apps/personal-client/package.json', import.meta.url));
  return createRequire(require.resolve('node-gyp/package.json'))('tar');
}

export async function extractLockedSqlite(tarball, destination, tar = installedTar()) {
  let unsafe = false;
  const safe = (name, entry) => {
    const parts = name.replace(/\/$/, '').split('/');
    const accepted = parts[0] === 'package' && !parts.some(part => part === '..' || part.includes('\\') || part.includes(':') || part.includes('\0')) && ['File', 'Directory'].includes(entry.type);
    if (!accepted) unsafe = true;
    return accepted;
  };
  // Validate the entire archive before writing anything, including link entries.
  await tar.t({ file: tarball, strict: true, filter: safe });
  if (unsafe) throw new Error('SQLITE_REPAIR_UNSAFE_ARCHIVE');
  await tar.x({ file: tarball, cwd: destination, strip: 1, strict: true, preservePaths: false, filter: safe });
  if (unsafe) throw new Error('SQLITE_REPAIR_UNSAFE_ARCHIVE');
}

// npm 10/11 omit this nested workspace dependency despite its lock record.
// Repair exactly that missing leaf, without invoking npm or changing its graph.
export async function repairLockedSqlite({ source, temporary, request = fetch, extract = extractLockedSqlite }) {
  source = await realpath(source); temporary = await realpath(temporary);
  if (inside(source, temporary) || inside(temporary, source)) throw new Error('SQLITE_REPAIR_TEMP_OVERLAPS_SOURCE');
  const lockFile = path.join(source, 'package-lock.json'), lockText = await readFile(lockFile, 'utf8');
  const entry = JSON.parse(lockText).packages?.[leaf];
  if (entry?.version !== version) throw new Error('SQLITE_REPAIR_LOCK_VERSION_UNSUPPORTED');
  const integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity || '');
  const expectedDigest = integrity && Buffer.from(integrity[1], 'base64');
  if (expectedDigest?.length !== 64) throw new Error('SQLITE_REPAIR_LOCK_INTEGRITY_REQUIRED');
  const url = new URL(entry.resolved);
  if (url.protocol !== 'https:' || !['registry.npmjs.org', 'registry.npmmirror.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== `/better-sqlite3/-/better-sqlite3-${version}.tgz`) throw new Error('SQLITE_REPAIR_LOCK_URL_UNSUPPORTED');
  url.hostname = 'registry.npmjs.org';
  const target = path.join(source, leaf);
  async function assertParents() {
    for (const relative of ['Memory', 'Memory/AgentSourceReaders', 'Memory/AgentSourceReaders/node_modules']) {
      const item = await maybeStat(path.join(source, relative));
      if (item && (item.isSymbolicLink() || !item.isDirectory())) throw new Error('SQLITE_REPAIR_PARENT_CONFLICT:' + relative);
    }
    const consumer = JSON.parse(await readFile(path.join(source, 'Memory/AgentSourceReaders/package.json'), 'utf8'));
    if (consumer.name !== '@memmy/agent-source-readers') throw new Error('SQLITE_REPAIR_CONSUMER_MISMATCH');
  }
  await assertParents();
  const current = await maybeStat(target);
  if (current) {
    if (current.isSymbolicLink() || !current.isDirectory()) throw new Error('SQLITE_REPAIR_EXISTING_LEAF_CONFLICT:' + leaf);
    const installed = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
    if (installed.name !== 'better-sqlite3' || installed.version !== version) throw new Error('SQLITE_REPAIR_EXISTING_VERSION_CONFLICT:' + leaf);
    return { status: 'present', path: leaf, version };
  }
  const work = await mkdtemp(path.join(temporary, 'locked-sqlite-'));
  try {
    const response = await request(url.href, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) throw new Error('SQLITE_REPAIR_DOWNLOAD_FAILED:' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualDigest = createHash('sha512').update(bytes).digest();
    if (!timingSafeEqual(actualDigest, expectedDigest)) throw new Error('SQLITE_REPAIR_INTEGRITY_MISMATCH');
    const tarball = path.join(work, 'better-sqlite3.tgz'), unpacked = path.join(work, 'package');
    await writeFile(tarball, bytes); await mkdir(unpacked);
    await extract(tarball, unpacked);
    const installed = JSON.parse(await readFile(path.join(unpacked, 'package.json'), 'utf8'));
    if (installed.name !== 'better-sqlite3' || installed.version !== version) throw new Error('SQLITE_REPAIR_TARBALL_IDENTITY_MISMATCH');
    if (await readFile(lockFile, 'utf8') !== lockText) throw new Error('SQLITE_REPAIR_LOCK_CHANGED');
    await assertParents();
    if (await maybeStat(target)) throw new Error('SQLITE_REPAIR_EXISTING_LEAF_CONFLICT:' + leaf);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(unpacked, target);
    return { status: 'repaired', path: leaf, version };
  } finally { await rm(work, { recursive: true, force: true }); }
}
