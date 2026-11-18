import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertFixtureFrontend } from './browser/fixture-source.mjs';

test('browser acceptance rejects wrong checkout, stale identity and wrong served HTML', async t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'starlink-ui-source-'));
  t.after(() => {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const frontend = path.join(root, 'starlink/frontend'), other = path.join(root, 'semantica/frontend');
  fs.mkdirSync(path.join(frontend, 'dist'), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(frontend, 'dist/index.html'), 'CURRENT BUILD');
  const identity = { kind: 'skill-packages-isolated', frontend_root: frontend,
    frontend_entry: 'index.html', frontend_sha256: createHash('sha256').update('CURRENT BUILD').digest('hex') };
  let served = 'CURRENT BUILD';
  const server = http.createServer((req, res) => {
    res.end(req.url === '/_test/identity' ? JSON.stringify(identity) : served);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await assertFixtureFrontend(base, identity.kind, frontend);
  identity.frontend_root = other;
  await assert.rejects(assertFixtureFrontend(base, identity.kind, frontend), /different frontend checkout/);
  identity.frontend_root = frontend;
  const hash = identity.frontend_sha256;
  identity.frontend_sha256 = 'stale';
  await assert.rejects(assertFixtureFrontend(base, identity.kind, frontend), /differs from the current local build/);
  identity.frontend_sha256 = hash;
  served = 'OLD BACKEND UI';
  await assert.rejects(assertFixtureFrontend(base, identity.kind, frontend), /Served HTML differs/);
});
