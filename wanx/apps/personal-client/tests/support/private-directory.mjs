import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { protectPrivateDirectory } from '../../shell/private-storage.mjs';

async function directoryIdentity(target) {
  try {
    const info = await lstat(target, { bigint: true });
    if (!info.isDirectory()) throw new Error('Expected a test directory');
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// These directories hold synthetic identities. Apply the real ACL once per
// directory instance instead of starting PowerShell on every test state write.
export function createPrivateDirectoryFixture() {
  const protectedDirectories = new Map();
  return async directory => {
    if (process.platform !== 'win32') return;
    const target = path.resolve(directory);
    const identity = await directoryIdentity(target);
    if (identity && protectedDirectories.get(target) === identity) return;
    await protectPrivateDirectory(target);
    protectedDirectories.set(target, await directoryIdentity(target));
  };
}
