import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamService } from '../integration/team-client/service.mjs';
const appId = 'ai.wanx.selfmade.' + 'a'.repeat(32);
function fixture({ role = 'user', authorization, contextAccount = 'cloud-account', response } = {}) {
  const calls = [];
  const me = { id: 42, username: 'cloud-member', role, application_id: 'wanx', team: { permissions: ['applications.manage'] } };
  const context = { protocolVersion: 1, user: { id: 42 }, authorization, boxId: 'box', accountId: contextAccount, clientId: 'client' };
  const client = {
    snapshot: () => ({ phase: 'ready', account: { phase: 'authenticated', accountId: 'cloud-account', clientId: 'client' }, connection: { deviceId: 'box' } }),
    applicationConnection: async id => { assert.equal(id, 'wanx'); return { context: () => context, request: async input => {
      calls.push(input);
      if (response) return response;
      const body = input.path === '/api/auth/me' ? me : input.path === '/api/app-studio/context' ? { features: { teamPublishing: 1 } } : input.path === '/api/app-studio/projects' ? { projects: [{ id: 'a'.repeat(32), appId, name: 'published' }] } : input.path === '/api/admin/applications/' + appId + '/access' ? { accepted: true } : null;
      return { status: body ? 200 : 403, body: Buffer.from(JSON.stringify(body)), headers: {} };
    } }; }
  };
  return { service: createTeamService({ client, applications: {} }), calls };
}
test('ordinary cloud members use the server catalog and cannot inherit legacy local permissions', async () => {
  const f = fixture();
  assert.deepEqual((await f.service.identity()).permissions, []);
  assert.equal((await f.service.action('catalog'))[0].appId, appId);
  assert.equal(f.calls.some(input => input.path === '/api/users' || input.path.startsWith('/api/admin/')), false);
  assert.equal(f.calls.some(input => input.headers['x-wanx-data-context']), false);
  await assert.rejects(f.service.action('members'), { code: 'TEAM_ADMIN_REQUIRED' });
});

for (const status of [401, 403]) {
  for (const body of ['{"code":"UNRECOGNIZED_ACCESS_DENIAL"}', '<html>access denied</html>', '']) {
    test(`HTTP ${status} denial survives team IPC code sanitization for ${body ? body[0] : 'empty'} responses`, async () => {
      const f = fixture({ response: { status, body: Buffer.from(body), headers: {} } });
      await assert.rejects(f.service.identity(), { code: 'TEAM_PERMISSION_DENIED', status });
    });
  }
}
test('cloud team rejects a local session or another cloud account before querying the server', async () => {
  for (const options of [{ authorization: 'local-trust-v1' }, { contextAccount: 'another-account' }]) {
    const f = fixture(options);
    await assert.rejects(f.service.identity(), { code: 'TEAM_IDENTITY_INVALID' });
    assert.deepEqual(f.calls, []);
  }
});
test('application access only accepts native positive user IDs', async () => {
  const f = fixture({ role: 'admin' });
  await f.service.action('access', { applicationId: appId, userId: 7, enabled: true });
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { user_id: 7, enabled: true });
  for (const input of [{ userId: '7' }, { userId: 0 }, { userId: -1 }, { membershipId: 'legacy-membership' }]) {
    const before = f.calls.filter(call => call.path.endsWith('/access')).length;
    await assert.rejects(f.service.action('access', { applicationId: appId, enabled: true, ...input }), { code: 'TEAM_INPUT_INVALID' });
    assert.equal(f.calls.filter(call => call.path.endsWith('/access')).length, before);
  }
});
