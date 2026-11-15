import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplicationSession } from '../../team-client/app-host/session.mjs';
import { fromEnvironment } from '../../personal-client/host-sdk/index.cjs';
import { createStudioControl } from '../integration/host-control.mjs';

const exec = promisify(execFile);

test('BDK-404 standard install, Host session, box read/write/refresh, errors and revoke', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-bdk404-'));
  const archiveRoot = path.join(root, 'package');
  const archive = path.join(root, 'standard.zip');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ applicationId: 'dev.wanx.acceptance.12345678', version: '0.1.0' }));
  await exec('/usr/bin/zip', ['-q', archive, 'manifest.json'], { cwd: root });
  const packageBase64 = (await readFile(archive)).toString('base64');
  const records = new Map();
  let revoked = false;
  let invalidated;
  const bodyText = async body => {
    if (body && typeof body[Symbol.asyncIterator] === 'function') { let text = ''; for await (const chunk of body) text += chunk; return text; }
    return Buffer.isBuffer(body) ? body.toString() : String(body ?? '');
  };
  const context = { boxId: 'bdk404-test-box', connection: 'ready', user: { id: 'tester' } };
  const connection = {
    context: () => { if (revoked) throw Object.assign(new Error('NETWORK_CHANGED'), { code: 'NETWORK_CHANGED' }); return context; },
    subscribe: callback => { invalidated = callback; return () => {}; },
    request: async ({ path: requestPath, method = 'GET', body }) => {
      if (requestPath.startsWith('/api/data/items') && method === 'GET') return { status: 200, body: Buffer.from(JSON.stringify({ items: [...records.values()], total: records.size })) };
      if (requestPath.startsWith('/api/data/items') && method === 'PUT') {
        const value = JSON.parse(await bodyText(body));
        records.set(value.id, value);
        return { status: 200, body: Buffer.from(JSON.stringify(value)) };
      }
      if (requestPath === '/api/data/failure') return { status: 503, body: Buffer.from(JSON.stringify({ code: 'BOX_SERVICE_UNAVAILABLE' })) };
      return { status: 404, body: Buffer.from(JSON.stringify({ code: 'NOT_FOUND' })) };
    },
  };
  const installed = [];
  const applications = {
    launch: applicationId => ({ applicationId, state: 'launched' }),
    listInstalled: async () => installed,
    install: async ({ archivePath }) => { installed.push({ applicationId: 'dev.wanx.acceptance.12345678', version: '0.1.0', installPath: archivePath }); return installed.at(-1); },
  };
  const installReceipts = [];
  const studioConnection = {
    context: () => context,
    request: async ({ path: requestPath, method = 'GET', body }) => {
      if (requestPath.startsWith('/api/app-studio/projects/' + 'b'.repeat(32) + '/install/')) return { status: 200, body: Buffer.from(JSON.stringify({ taskId: 'task', applicationId: 'dev.wanx.acceptance.12345678', version: '0.1.0', artifactHash: 'a'.repeat(64), packageBase64 })) };
      if (requestPath === '/api/app-studio/projects/' + 'b'.repeat(32) + '/installed' && method === 'POST') { installReceipts.push(JSON.parse(body.toString())); return { status: 200, body: Buffer.from('{}') }; }
      return { status: 404, body: Buffer.from('{}') };
    },
  };
  const control = createStudioControl({ applications, assets: root });
  const session = await createApplicationSession({ hostApplicationId: 'wanx-host', applicationId: 'dev.wanx.acceptance.12345678', installPath: root, createConnection: () => connection });
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true }); });
  const host = fromEnvironment(session.environment);
  t.after(() => host.close());

  assert.deepEqual(await control({ operation: 'open', body: { applicationId: 'dev.wanx.acceptance.12345678' }, connection: studioConnection, assertLive: session.assertLive }), { applicationId: 'dev.wanx.acceptance.12345678', state: 'launched' });
  const projectId = 'b'.repeat(32);
  const installResult = await control({ operation: 'install', body: { projectId, artifactHash: 'a'.repeat(64) }, connection: studioConnection, assertLive: session.assertLive });
  assert.equal(installResult.state, 'installed');
  assert.equal(installReceipts.length, 1);
  assert.deepEqual(await host.context(), context);

  const write = await host.request('/api/data/items', { method: 'PUT', body: JSON.stringify({ id: 'item-1', value: 'first' }) });
  assert.equal(write.status, 200);
  assert.deepEqual(await (await host.request('/api/data/items')).json(), { items: [{ id: 'item-1', value: 'first' }], total: 1 });
  records.set('item-1', { id: 'item-1', value: 'refreshed' });
  assert.equal((await (await host.request('/api/data/items')).json()).items[0].value, 'refreshed');
  assert.equal((await host.request('/api/data/failure')).status, 503);

  revoked = true;
  invalidated?.();
  await assert.rejects(host.context(), /HOST_SESSION_EXPIRED/);
  await assert.rejects(host.request('/api/data/items'), /HOST_SESSION_EXPIRED/);
});
