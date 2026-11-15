import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamConnection } from '../shell/team-connection.mjs';

test('obsolete team credentials and local identity storage are never opened during cloud restore or logout', async () => {
  const calls = [];
  const base = { snapshot: () => ({ account: { phase: 'signed_out' } }),
    initialize: async () => calls.push('cloud.restore'), logout: async () => calls.push('cloud.logout') };
  const client = createTeamConnection({ base,
    store: { load: () => assert.fail('retained legacy store must not be read'), clear: () => assert.fail('retained files must not be deleted') },
    deviceTrust: { lock: () => assert.fail('retired local identity must not load') } });
  const value = await client.initialize();
  assert.deepEqual(value.team, {});
  assert.equal(client.teamLogin, undefined);
  assert.equal(client.teamJoin, undefined);
  await client.logout();
  assert.deepEqual(calls, ['cloud.restore', 'cloud.logout']);
});

test('team delegates only to the cloud connector and preserves its denial', async () => {
  const calls = [];
  let state = { account: { phase: 'authenticated' }, phase: 'disconnected' };
  const base = { snapshot: () => state, subscribe: () => () => {},
    connectBox: async id => { calls.push(id); if (id === 'denied') throw Object.assign(Error('NETWORK_DEVICE_ACCESS_DENIED'), { code: 'NETWORK_DEVICE_ACCESS_DENIED' });
      state = { ...state, phase: 'ready', connection: { deviceId: id, mode: 'netbird' } }; },
    applicationRequest: async input => input,
  };
  const client = createTeamConnection({ base });
  await client.connectBox('cloud-box');
  assert.deepEqual(await client.applicationRequest({ path: '/api/auth/me' }), { path: '/api/auth/me' });
  await assert.rejects(client.connectBox('denied'), { code: 'NETWORK_DEVICE_ACCESS_DENIED' });
  assert.equal(client.connectLocalBox, undefined);
  state = { ...state, account: { phase: 'signed_out' } };
  await assert.rejects(client.applicationRequest({ path: '/api/auth/me' }), { code: 'ACCOUNT_LOGIN_REQUIRED' });
  state = { account: { phase: 'authenticated' }, connection: { deviceId: 'cloud-box', authorization: 'local-trust-v1' } };
  await assert.rejects(client.applicationRequest({ path: '/api/auth/me' }), { code: 'NETWORK_NOT_READY' });
  assert.deepEqual(calls, ['cloud-box', 'denied']);
});
