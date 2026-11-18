import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('assembled renderer and panel resolve every local asset', async () => {
    const root = fileURLToPath(new URL('../build/app', import.meta.url));
    for (const name of ['local-ui/renderer/index.html', 'local-ui/panel/index.html']) {
      const file = path.join(root, name);
      const html = await readFile(file, 'utf8');
      for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const reference = match[1];
        if (/^(?:[a-z]+:|\/|#)/i.test(reference)) continue;
        const target = path.resolve(path.dirname(file), reference.split(/[?#]/)[0]);
        assert.ok(target.startsWith(root + path.sep), `${name}: ${reference} escapes runtime`);
        await assert.doesNotReject(access(target), `${name}: missing ${reference}`);
      }
    }
  });

test("assembled shared integration files match the canonical Builder source", async () => {
  for (const name of ["application-presentation.js", "application-presentation.css"]) {
    assert.deepEqual(await readFile(new URL(`../build/app/local-ui/${name}`, import.meta.url)),
      await readFile(new URL(`../../builder/integration/${name}`, import.meta.url)));
  }
  assert.deepEqual(await readFile(new URL("../build/app/shell/assistant-service.mjs", import.meta.url)),
    await readFile(new URL("../../builder/integration/team-client/assistant-service.mjs", import.meta.url)));
});
