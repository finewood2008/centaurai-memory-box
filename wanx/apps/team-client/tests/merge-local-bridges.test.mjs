import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAIDialogue } from '../shell/ai-dialogue.mjs';
import { createAIDialogue as createCloudAssistant } from '../shell/assistant-service.mjs';
import { createSpaceLinkBridge } from '../shell/space-links.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
const connectionId = 'a'.repeat(32);

function fixture() {
  const state = { phase: 'ready', account: { phase: 'authenticated', accountId: 'account-1', clientId: 'client-1' },
    connection: { deviceId: 'box-1', url: 'https://cloud-box.test/', gatewayURL: 'https://cloud-box.test/', mode: 'netbird' } };
  const listeners = new Set(), calls = [], links = [], sockets = [], copies = [], events = [];
  let saved, connect, handler, saveHandler;
  function newLink() {
    const link = { closed: false, close() { this.closed = true; }, async request(input) {
      calls.push(input);
      if (handler) { const value = await handler(input); if (value) return value; }
      if (input.path === '/api/assistant/profile') return response({ agent_id: 'private-agent', default_model: 'fixture/one' });
      if (input.path === '/api/providers/resolved') return response([{ provider_name: 'fixture', model: 'one' }, { provider_name: 'fixture', model: 'two' }]);
      if (input.path === '/api/providers/application-defaults') return response({ managed:false, revision:'0', defaults:{} });
      if (input.path === '/api/providers/active-model') return response({ provider_name: 'fixture', model: 'one' });
      if (input.path === '/api/preferences') return response({});
      if (input.path.startsWith('/api/assistant/context/defaults?')) return response({ context: {} });
      if (input.path === '/api/assistant/conversations') return response({ items: [{ thread_id: 'thread-1' }] });
      if (input.path === '/api/assistant/history') return response({ entries: {} });
      if (input.path === '/api/dialogue/sessions?limit=10000') return response({ sessions: [] });
      if (input.path === '/api/settings/timezone') return response({ timezone: 'Asia/Shanghai' });
      if (input.path.includes('/history?')) return response({ messages: [], turn_active: false });
      if (input.path.startsWith('/api/assistant/knowledge/sources/')) return response({ sources: [] });
      if (input.path === '/api/_client/space-mcp/connections') return response({ id: connectionId, status: 'active' });
      if (input.path.startsWith('/api/_client/space-mcp?')) return response({ connections: [{ id: connectionId, status: 'active' }], archives: [] });
      throw new Error('Unexpected route: ' + input.path);
    }, async openStream({ path }) {
      assert.equal(path, '/api/agents/private-agent/chat/ws');
      const socket = new EventEmitter(); socket.readyState = 1;
      socket.send = (_frame, done) => done?.();
      socket.terminate = () => { socket.readyState = 3; socket.emit('close'); };
      sockets.push(socket); return socket;
    } };
    links.push(link); return link;
  }
  const client = { snapshot: () => structuredClone(state),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    applicationConnection: (...args) => connect ? connect(...args) : newLink() };
  const store = { load: async () => saved, save: async value => { if (saveHandler) await saveHandler(value); saved = structuredClone(value); } };
  return { client, store, calls, links, sockets, copies, events, newLink,
    get saved() { return saved; },
    change(update) { update(state); for (const listener of listeners) listener(); },
    connectWith(value) { connect = value; }, respondWith(value) { handler = value; }, saveWith(value) { saveHandler = value; },
    assistant() { return createAIDialogue({ client, preferenceStore: store, onEvent: event => events.push(event) }); },
    bridge() { return createSpaceLinkBridge({ client, store, serviceURL: 'https://consumer.test', copyText: async value => copies.push(value), agentHubOptions: { team: true } }); },
  };
}

test('team and shared assistants require a signed-in cloud account', async t => {
  const f = fixture(), service = f.assistant(); t.after(() => service.close());
  const loaded = await service.action('load');
  assert.equal(loaded.agentId, 'private-agent'); assert.equal(loaded.timezone, 'Asia/Shanghai');
  assert.deepEqual(loaded.capabilities, { knowledge: true, space: true, channels: true, attachments: true });
  assert(f.calls.some(call => call.path === '/api/assistant/profile'));
  assert(f.calls.some(call => call.path === '/api/assistant/conversations'));
  const cloud = createCloudAssistant({ client: f.client }); t.after(() => cloud.close());
  assert.equal((await cloud.action('load')).agentId, 'private-agent');
  f.change(state => { state.account.phase = 'signed_out'; });
  await assert.rejects(cloud.action('load'), { code: 'BOX_CONNECTION_REQUIRED' });
  await assert.rejects(service.action('load'), { code: 'BOX_CONNECTION_REQUIRED' });
});

test('assistant model choice survives session refresh and stays isolated from another cloud account', async t => {
  const f = fixture(), service = f.assistant(); t.after(() => service.close());
  const first = await service.action('load');
  await service.action('model', { scope: first.scope, model: 'fixture/two' });
  f.change(state => { state.account.credits = 10; });
  const renewed = await service.action('load');
  assert.equal(renewed.scope, first.scope); assert.equal(renewed.defaultModel, 'fixture/two');
  assert.equal(Object.keys(f.saved.assistantConfigurations).length, 1);
  f.change(state => { state.account.accountId = 'account-2'; });
  await assert.rejects(service.action('model', { scope: first.scope, model: 'fixture/one' }), { code: 'DIALOGUE_CONTEXT_CHANGED' });
  assert.equal((await service.action('load')).defaultModel, 'fixture/one');
  f.change(state => { state.account.phase = 'signed_out'; });
  await assert.rejects(service.action('load'), { code: 'BOX_CONNECTION_REQUIRED' });
});

test('cloud file spaces include authorized server MCP drives', async t => {
  const f = fixture();
  f.respondWith(input => {
    if (input.path === '/api/personal-space/spaces') return response([{ id: 'personal' }, { id: 'company' }]);
    if (input.path === '/api/_client/space-mcp/drives') return response([{ id: connectionId }]);
  });
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const spaces = await bridge.manage('spaces');
  assert.deepEqual(spaces, ['personal', connectionId].map(id => ({ id, connections: [] })));
  assert.equal(f.calls.some(call => call.path === '/api/_client/space-mcp/drives'), true);
});

for (const field of ['accountId', 'clientId', 'deviceId', 'gatewayURL']) {
  test(`assistant revokes streams when cloud ${field} changes`, async t => {
    const f = fixture(), service = f.assistant(); t.after(() => service.close());
    const { scope } = await service.action('load');
    await service.action('watch', { scope, threadId: 'thread-1' });
    f.change(state => { const context = ['accountId', 'clientId'].includes(field) ? state.account : state.connection; context[field] += '-next'; });
    await tick();
    assert.equal(f.sockets[0].readyState, 3); assert.equal(f.links[0].closed, true);
    assert.equal(f.events.at(-1).type, 'invalidated');
    await assert.rejects(service.action('watch', { scope, threadId: 'thread-1' }), { code: 'DIALOGUE_CONTEXT_CHANGED' });
  });
}

test('assistant closes a late derived connection before dispatch after cloud account changes', async t => {
  const f = fixture(), pending = deferred(); f.connectWith(() => pending.promise);
  const service = f.assistant(); t.after(() => service.close());
  const load = service.action('load'); await tick();
  f.change(state => { state.account.accountId = 'account-2'; });
  const link = f.newLink(); pending.resolve(link);
  await assert.rejects(load, { code: 'DIALOGUE_CONTEXT_CHANGED' });
  assert.equal(link.closed, true); assert.equal(f.calls.length, 0);
});

test('assistant aborts an in-flight request and rejects its delayed response on logout', async t => {
  const f = fixture(), pending = deferred();
  f.respondWith(input => input.path === '/api/assistant/profile' ? pending.promise : undefined);
  const service = f.assistant(); t.after(() => service.close());
  const load = service.action('load'); await tick();
  f.change(state => { state.account.phase = 'signed_out'; });
  assert.equal(f.calls[0].signal.aborted, true);
  pending.resolve(response({ agent_id: 'old-private-agent' }));
  await assert.rejects(load, { code: 'DIALOGUE_CONTEXT_CHANGED' });
});

test('server MCP keys survive cloud session renewal but are hidden from another account or after logout', async t => {
  const f = fixture(), bridge = await f.bridge(); t.after(() => bridge.close());
  const created = await bridge.manage('mcp-issue', { name: 'Local integration' });
  const key = f.saved.spaceMcp[0].credential;
  assert.equal(created.id, connectionId); assert(!JSON.stringify(created).includes(key));
  assert.equal(JSON.parse(f.calls[0].body).destination, 'company');
  const endpoint = await bridge.mcpDetails();
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/space$/);
  assert.equal(endpoint.localOnly, true);
  f.change(state => { state.account.clientId = 'client-2'; });
  await bridge.manage('mcp-copy', { id: connectionId, kind: 'key' });
  assert.equal(f.copies[0], key); assert.equal(f.saved.spaceMcp.length, 1);
  assert.equal((await bridge.mcpDetails()).url, endpoint.url);
  f.change(state => { state.account.accountId = 'account-2'; });
  assert.equal((await bridge.manage('mcp-state')).connections[0].localKey, false);
  await assert.rejects(bridge.manage('mcp-copy', { id: connectionId, kind: 'key' }), { code: 'MCP_KEY_NOT_ON_THIS_CLIENT' });
  f.change(state => { state.account.phase = 'signed_out'; });
  const before = f.calls.length;
  await assert.rejects(bridge.manage('mcp-state'), { code: 'BOX_CONNECTION_REQUIRED' });
  assert.equal(f.calls.length, before);
});

test('server MCP refuses dispatch through a delayed connection from an earlier cloud session', async t => {
  const f = fixture(), pending = deferred(); f.connectWith(() => pending.promise);
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const operation = bridge.manage('mcp-state'); await tick();
  f.change(state => { state.account.clientId = 'client-2'; });
  const link = f.newLink(); pending.resolve(link);
  await assert.rejects(operation, { code: 'SPACE_CONTEXT_CHANGED' });
  assert.equal(f.calls.length, 0); assert.equal(link.closed, true);
});

test('MCP credential persistence cannot resume issuance under a renewed cloud session', async t => {
  const f = fixture(), pending = deferred(); f.saveWith(() => pending.promise);
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const operation = bridge.manage('mcp-issue', { name: 'Pending integration' }); await tick();
  f.change(state => { state.account.clientId = 'client-2'; }); pending.resolve();
  await assert.rejects(operation, { code: 'SPACE_CONTEXT_CHANGED' }); assert.equal(f.calls.length, 0);
  f.saveWith(null);
  await bridge.manage('mcp-issue', { name: 'Pending integration' });
  assert.equal(f.saved.spaceMcp.length, 1); assert.equal(f.calls.length, 1);
});

test('MCP aborts delayed data and rejects it after cloud account logout', async t => {
  const f = fixture(), pending = deferred(); f.respondWith(() => pending.promise);
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const operation = bridge.manage('mcp-state'); await tick();
  f.change(state => { state.account.phase = 'signed_out'; });
  assert.equal(f.calls[0].signal.aborted, true);
  pending.resolve(response({ connections: [{ id: 'previous-principal-data' }] }));
  await assert.rejects(operation, { code: 'BOX_CONNECTION_REQUIRED' });
});
