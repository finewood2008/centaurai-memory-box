import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assembleWorkbench } from '../tools/assemble-generated-directory.mjs';

async function put(root, file, body) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, body);
}
async function files(root) {
  const result = {};
  for (const item of await readdir(root, {withFileTypes: true})) {
    if (item.isDirectory()) {
      for (const [file, value] of Object.entries(await files(path.join(root, item.name)))) result[`${item.name}/${file}`] = value;
    } else result[item.name] = await readFile(path.join(root, item.name), 'utf8');
  }
  return result;
}
for (const edition of ['personal', 'team']) {
  test(`${edition}: repeated assembly replaces complete generated bundles and preserves siblings`, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'wanx-assembly-'));
    t.after(() => rm(temp, {recursive:true, force:true}));
    const source = path.join(temp, 'builder'), client = path.join(temp, 'client');
    const workbench = edition === 'personal' ? 'workshop/workbench' : 'studio/workbench';
    const runtime = edition === 'personal' ? 'workshop/runtime' : 'applications/studio-runtime';
    await put(source, 'release/wanx-studio-1/ui/assets/old.js', 'old');
    await put(source, 'dist/runtime/old.mjs', 'old-runtime');
    await put(source, 'dist/knowledge-template/wanx.editable.json', 'knowledge template');
    await put(source, 'dist/zhike-template/wanx.editable.json', 'zhike template');
    await put(client, 'user-data/saved.json', 'business-data');
    await put(client, `${path.dirname(workbench)}/embedded-preload.cjs`, 'sibling');
    await assembleWorkbench(source, client, edition, '1');
    await rm(path.join(source, 'release'), {recursive:true});
    await rm(path.join(source, 'dist/runtime'), {recursive:true});
    await put(source, 'release/wanx-studio-2/ui/index.html', '<script src="assets/new.js"></script>');
    await put(source, 'release/wanx-studio-2/ui/assets/new.js', 'new');
    await put(source, 'dist/runtime/new.mjs', 'new-runtime');
    await assembleWorkbench(source, client, edition, '2');
    const expected = await files(path.join(source, 'release/wanx-studio-2'));
    if (edition === 'team') {
      expected['templates/knowledge-qa/wanx.editable.json'] = 'knowledge template';
      expected['templates/zhike/wanx.editable.json'] = 'zhike template';
    }
    assert.deepEqual(await files(path.join(client, workbench)), expected);
    assert.deepEqual(await files(path.join(client, runtime)), await files(path.join(source, 'dist/runtime')));
    await assembleWorkbench(source, client, edition, '2');
    assert.deepEqual(await files(path.join(client, workbench)), expected);
    assert.equal(await readFile(path.join(client, 'user-data/saved.json'), 'utf8'), 'business-data');
    assert.equal(await readFile(path.join(client, path.dirname(workbench), 'embedded-preload.cjs'), 'utf8'), 'sibling');
  });
  test(`${edition}: missing source preserves existing bundle`, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'wanx-assembly-'));
    t.after(() => rm(temp, {recursive:true, force:true}));
    const source = path.join(temp, 'builder'), client = path.join(temp, 'client');
    const workbench = edition === 'personal' ? 'workshop/workbench' : 'studio/workbench';
    await put(client, `${workbench}/ui/index.html`, 'current');
    const before = await files(client);
    await assert.rejects(assembleWorkbench(source, client, edition, 'missing'), {code:'ENOENT'});
    assert.deepEqual(await files(client), before);
    if (edition === 'team') {
      await put(source, 'release/wanx-studio-1/ui/index.html', 'new');
      await assert.rejects(assembleWorkbench(source, client, edition, '1'), {code:'ENOENT'});
      assert.deepEqual(await files(client), before);
    }
  });
}
