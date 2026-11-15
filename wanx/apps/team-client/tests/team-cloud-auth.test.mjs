import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { openConnectedDashboard, registerControlActions } from '../shell/control.mjs';
import { createTeamConnection } from '../shell/team-connection.mjs';

const source = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
function preload(raw) {
  const api = {}, calls = [];
  vm.runInNewContext(source, { process: { platform: 'win32' }, require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { api[name] = value; } },
    ipcRenderer: { invoke: async (channel, input) => { calls.push([channel, input]); return raw; }, on() {}, removeListener() {} },
  }) });
  return { api: api.wanxClient, calls };
}

test('Windows cloud login ignores a retained locked local profile and old enabled setting', async () => {
  const h = preload({ account: { phase: 'authenticated', accountId: 'cloud-user' }, phase: 'ready',
    identitySecurity: { enabled: true, active: true }, team: { identitySecurityEnabled: true },
    dataIdentity: { profileId: 'retained-Windows-profile', phase: 'locked' },
    platform: { phase: 'ready' }, network: { enabled: true, phase: 'ready' },
    connection: { deviceId: 'cloud-box', mode: 'netbird', gatewayURL: 'http://127.0.0.1:41000/session' } });
  const state = await h.api.getLocalState();
  assert.equal(state.route, 'applications');
  assert.equal(state.canLaunchApplications, true);
  assert.equal(state.dataIdentity, undefined);
  assert.equal(state.identitySecurity, undefined);
});

test('an unlocked retained local profile cannot replace cloud login or grant a local-trust session', async () => {
  for (const phase of ['signed_out', 'authenticated']) {
    const h = preload({ account: { phase }, phase: 'ready',
      dataIdentity: { profileId: 'retained-profile', phase: 'unlocked', selected: { boxId: 'box', sessionId: 'retired-session' } },
      connection: { deviceId: 'box', mode: 'local', authorization: 'local-trust-v1' } });
    const state = await h.api.getLocalState();
    assert.equal(state.route, phase === 'authenticated' ? 'applications' : 'auth');
    assert.equal(state.canLaunchApplications, false);
    assert.equal(state.dataIdentity, undefined);
  }
});

test('retired local identity actions are absent from both control IPC and preload', async () => {
  const handlers = new Map();
  registerControlActions({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    client: { snapshot: () => ({}) }, getState: async () => ({}), publishState() {},
    identitySecurity: { set: () => assert.fail('old setting must not be callable') },
    openDeviceTrust: () => assert.fail('old identity window must not open') });
  assert.equal(handlers.has('wanx-client:identity-security-set'), false);
  assert.equal(handlers.has('wanx-client:device-trust-open'), false);
  const h = preload({ account: { phase: 'authenticated' } });
  const retired = ['identity-security.set', 'device-trust.open', 'team.login', 'team.join', 'team.security'];
  for (const action of retired) {
    const reply = await h.api.action(action, { enabled: true });
    assert.equal(reply.code, 'UNKNOWN_CLIENT_ACTION');
  }
  assert.deepEqual(h.calls.map(([channel]) => channel), retired.map(() => 'wanx-client:get-state'));
});

test('team connection always uses cloud authorization even when obsolete options request local identity', async () => {
  const calls = [];
  let state = { account: { phase: 'authenticated' }, dataIdentity: { profileId: 'retained', phase: 'locked' } };
  const base = { snapshot: () => state,
    connectBox: async id => { calls.push(id); if (id === 'denied') throw Object.assign(Error('NETWORK_DEVICE_ACCESS_DENIED'), { code: 'NETWORK_DEVICE_ACCESS_DENIED' });
      state = { ...state, connection: { deviceId: id, mode: 'netbird' } }; },
    applicationRequest: async input => input,
  };
  const client = createTeamConnection({ base, identitySecurityEnabled: true,
    localDataAccess: { isProtectedBox: () => assert.fail('retained vault must not be consulted') } });
  await client.connectBox('allowed');
  assert.equal(client.snapshot().dataIdentity, undefined);
  assert.deepEqual(await client.applicationRequest({ path: '/api/auth/me' }), { path: '/api/auth/me' });
  await assert.rejects(client.connectBox('denied'), { code: 'NETWORK_DEVICE_ACCESS_DENIED' });
  assert.deepEqual(calls, ['allowed', 'denied']);
});

test('cloud maintenance ignores retained identity metadata and rejects retired local-trust sessions', () => {
  const state = { account: { phase: 'authenticated' }, phase: 'ready',
    dataIdentity: { profileId: 'retained', phase: 'locked' },
    connection: { deviceId: 'box', mode: 'local', gatewayURL: 'http://127.0.0.1/session' } };
  let opened = 0;
  const client = { snapshot: () => state }, dashboards = { open: () => ++opened };
  assert.equal(openConnectedDashboard(client, dashboards), 1);
  state.connection.authorization = 'local-trust-v1';
  assert.throws(() => openConnectedDashboard(client, dashboards), /BOX_CONNECTION_REQUIRED/);
  assert.equal(opened, 1);
});
