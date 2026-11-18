import { cp, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Stage the complete bundle before touching the current one. A failed copy must
// not remove a usable build; failed promotion restores the previous directory.
async function replaceGeneratedDirectory(source, target, prepare) {
  if (!(await stat(source)).isDirectory()) throw Error('GENERATED_SOURCE_NOT_DIRECTORY');
  const parent = path.dirname(target);
  await mkdir(parent, {recursive: true});
  const staging = await mkdtemp(path.join(parent, '.wanx-assembly-'));
  const next = path.join(staging, 'next'), previous = path.join(staging, 'previous');
  let previousSaved = false;
  try {
    await cp(source, next, {recursive: true});
    await prepare?.(next);
    try {
      await rename(target, previous);
      previousSaved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(next, target);
    } catch (error) {
      if (previousSaved) {
        await rename(previous, target);
        previousSaved = false;
      }
      throw error;
    }
    previousSaved = false;
  } finally {
    // Preserve the backup if restoration itself failed, rather than deleting it.
    if (!previousSaved) await rm(staging, {recursive: true, force: true});
  }
}

// Only these generated application bundles belong here, never user data.
export async function assembleWorkbench(root, client, edition, version) {
  if (!['personal', 'team'].includes(edition)) throw Error('EDITION_REQUIRED');
  const workbench = edition === 'personal' ? 'workshop/workbench' : 'studio/workbench';
  const runtime = edition === 'personal' ? 'workshop/runtime' : 'applications/studio-runtime';
  const templates = edition === 'team' ? async next => {
    for (const [source, name] of [['knowledge-template', 'knowledge-qa'], ['zhike-template', 'zhike']]) {
      const target = path.join(next, 'templates', name);
      await mkdir(target, {recursive:true});
      await cp(path.join(root, 'dist', source, 'wanx.editable.json'), path.join(target, 'wanx.editable.json'));
    }
  } : undefined;
  await replaceGeneratedDirectory(path.join(root, `release/wanx-studio-${version}`), path.join(client, workbench), templates);
  await replaceGeneratedDirectory(path.join(root, 'dist/runtime'), path.join(client, runtime));
}
