import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A passing UI test must exercise this checkout, not Semantica's old frontend build.
export async function assertFixtureFrontend(base, kind, frontendRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const identityResponse = await fetch(base + '/_test/identity');
  assert.equal(identityResponse.status, 200, 'Fixture identity unavailable');
  const identity = await identityResponse.json();
  assert.equal(identity.kind, kind, 'Wrong disposable backend fixture');
  assert.equal(typeof identity.frontend_root, 'string', 'Update Semantica and pass --frontend-root');
  const frontend = fs.realpathSync(frontendRoot);
  assert.equal(fs.realpathSync(identity.frontend_root), frontend, 'Fixture is serving a different frontend checkout');
  const corrections = kind === 'knowledge-corrections-isolated';
  const entry = corrections ? 'tests/browser/corrections.html' : 'index.html';
  const directory = corrections ? path.resolve(frontend, '../.tmp/knowledge-correction-ui') : path.join(frontend, 'dist');
  assert.equal(identity.frontend_entry, entry);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const expected = hash(fs.readFileSync(path.join(directory, entry)));
  assert.equal(identity.frontend_sha256, expected, 'Fixture build differs from the current local build');
  const response = await fetch(base + '/' + entry, { redirect: 'error', cache: 'no-store' });
  assert.equal(response.status, 200, 'Selected frontend entry unavailable');
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), expected, 'Served HTML differs from the current local build');
  fs.mkdirSync(path.resolve(frontend, '../.tmp'), { recursive: true });
  return identity;
}
