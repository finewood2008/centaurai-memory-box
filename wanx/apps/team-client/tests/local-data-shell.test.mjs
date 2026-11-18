import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPersonalSpace } from '../build/app/shell/personal-space.mjs';
import { createSuperClipboard } from '../shell/super-clipboard.mjs';
import { createAIDialogue } from '../build/app/shell/ai-dialogue.mjs';
import { dataOwnerKey } from '../shell/cloud-context.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = body => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });
function cloudState(accountId = 'account-a', generation = 1) {
  return { phase: 'ready', account: { phase: 'authenticated', accountId, clientId: `client-${generation}` },
    connection: { deviceId: 'box-a', mode: 'lan', gatewayURL: 'http://127.0.0.1:12345' } };
}
function clientFixture(respond = () => reply({ protocolVersion: 1 })) {
  let state = cloudState(); const listeners = new Set();
  return { snapshot: () => structuredClone(state),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(patch) { state = { ...state, ...patch }; for (const fn of listeners) fn(); },
    logout() { this.update({ account: { ...state.account, phase: 'signed_out' } }); },
    async applicationConnection() { return { context: () => ({}), request: respond }; } };
}
const memoryStore = () => { let value; return { load: async () => structuredClone(value), save: async v => { value = structuredClone(v); } }; };

test('personal space follows the cloud account and clears data on account switch or logout', async t => {
  const client = clientFixture();
  const service = await createPersonalSpace({ client, store: memoryStore(), serviceURL: 'cloud-a' });
  t.after(() => service.close());
  await service.refresh(); const first = service.snapshot().scope;
  assert.equal(service.snapshot().overview.protocolVersion, 1);
  client.update({ account: { ...client.snapshot().account, credits: 100 } });
  assert.equal(service.snapshot().scope, first);
  client.update(cloudState('account-b'));
  assert.notEqual(service.snapshot().scope, first);
  assert.equal(service.snapshot().overview, null);
  client.logout();
  assert.equal(service.snapshot().scope, null);
  assert.deepEqual(service.snapshot().tasks, []);
});

test('personal-space response from before logout cannot populate a fresh cloud session', async t => {
  const held = deferred(), entered = deferred();
  const client = clientFixture(() => { entered.resolve(); return held.promise; });
  const service = await createPersonalSpace({ client, store: memoryStore(), serviceURL: 'cloud' });
  t.after(() => service.close());
  const pending = service.refresh(); await entered.promise;
  client.logout(); client.update(cloudState('account-a', 3));
  held.resolve(reply({ protocolVersion: 1, privateData: 'stale' })); await pending;
  assert.equal(service.snapshot().overview, null);
});

test('native assistant preferences follow the cloud account and logout aborts late responses', async t => {
  let held, entered;
  const client = clientFixture(input => {
    if (held) { entered.resolve(input.signal); return held.promise; }
    if (input.path === '/api/assistant/profile') return reply({ agent_id: 'private-agent', default_model: 'fixture/model-a' });
    if (input.path === '/api/providers/resolved') return reply([
      { provider_name: 'fixture', model: 'model-a' }, { provider_name: 'fixture', model: 'model-b' },
    ]);
    if (input.path === '/api/providers/application-defaults') return reply({ managed:false, revision:'0', defaults:{} });
      if (input.path === '/api/providers/active-model') return reply({ provider_name: 'fixture', model: 'model-a' });
    if (input.path === '/api/preferences') return reply({});
    if (input.path === '/api/assistant/context/defaults?data_scope=team') return reply({ context: {} });
    if (input.path === '/api/assistant/conversations') return reply({ items: [] });
    if (input.path === '/api/assistant/history') return reply({ entries: {} });
    if (input.path === '/api/dialogue/sessions?limit=10000') return reply({ sessions: [] });
    if (input.path === '/api/settings/timezone') return reply({ timezone: 'Asia/Shanghai' });
    throw new Error('Unexpected native assistant route: ' + input.path);
  });
  const service = createAIDialogue({ client, preferenceStore: memoryStore() });
  t.after(() => service.close());
  let value = await service.action('load');
  await service.action('model', { scope: value.scope, model: 'fixture/model-b' });
  client.update({ account: { ...client.snapshot().account, credits: 100 } });
  assert.equal((await service.action('load')).defaultModel, 'fixture/model-b');
  client.update(cloudState('account-b'));
  assert.equal((await service.action('load')).defaultModel, 'fixture/model-a');
  client.update(cloudState('account-a'));
  value = await service.action('load');
  assert.equal(value.defaultModel, 'fixture/model-b');
  held = deferred(); entered = deferred();
  const pending = service.action('open', { scope: value.scope, threadId: 'thread-1' });
  const rejected = assert.rejects(pending, { code: 'DIALOGUE_CONTEXT_CHANGED' });
  const signal = await entered.promise; client.logout();
  assert.equal(signal.aborted, true);
  client.update(cloudState('account-a', 3)); held.resolve(reply({ id: 'thread-1', active_thread_id: 'thread-1', versions: [] }));
  await rejected;
});

async function clipboardFixture(t, { request, chooseFiles = async () => [] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'local-clipboard-scope-'));
  const client = clientFixture();
  const scope = () => { const owner = dataOwnerKey(client.snapshot(), 'cloud'); return owner ? JSON.stringify([owner, 'box-a']) : null; };
  const service = await createSuperClipboard({ client, directory, deviceName: 'test', serviceURL: 'cloud', store: memoryStore(),
    personalSpace: { snapshot: () => ({ scope: scope() }), clipboardRequest: request || (async () => ({ items: [], usage: {} })) },
    systemClipboard: { read: async () => ({ text: 'test' }) }, chooseFiles, chooseDownload: async () => null });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, service };
}

test('clipboard late reads are aborted and cannot repopulate a new cloud session', async t => {
  const held = deferred(), entered = deferred();
  const { client, service } = await clipboardFixture(t, { request: async (_route, options) => {
    entered.resolve(options.signal); return held.promise;
  } });
  const pending = service.operation('refresh');
  const rejected = assert.rejects(pending, { code: 'SPACE_CONTEXT_CHANGED' });
  const signal = await entered.promise; client.logout();
  assert.equal(signal.aborted, true);
  assert.equal(service.snapshot().scope, null);
  assert.deepEqual(service.snapshot().note.blocks, []);
  client.update(cloudState('account-a', 3));
  held.resolve({ items: [{ preview: 'old principal data' }], usage: {} }); await rejected;
  assert.deepEqual(service.snapshot().items, []);
});

test('a native clipboard picker cannot resume after logout and another cloud session', async t => {
  const held = deferred();
  const { client, service } = await clipboardFixture(t, { chooseFiles: () => held.promise });
  const pending = service.operation('choose');
  const rejected = assert.rejects(pending, { code: 'SPACE_CONTEXT_CHANGED' });
  client.logout(); client.update(cloudState('account-a', 3)); held.resolve([]); await rejected;
  assert.deepEqual(service.snapshot().tasks, []);
});
