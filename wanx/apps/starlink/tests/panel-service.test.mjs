import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarlinkPanelService } from '../integration/client-service.mjs';
import { SemanticaService } from '../shell/service.mjs';

function fixture(options = {}) {
  let state = { phase: 'ready', account: { phase: 'authenticated', accountId: 'account', clientId: 'client' }, connection: { deviceId: 'box', gatewayURL: 'http://gateway' } };
  let listener, hold, userId = 1;
  const requests = [], events = [], links = [];
  const context = () => ({ accountId: state.account.accountId, boxId: state.connection.deviceId, user: { id: userId, username: 'fixture' } });
  const client = {
    snapshot: () => state, subscribe: fn => { listener = fn; return () => {}; },
    async applicationConnection(id) {
      assert.equal(id, 'centaurai.wanx.semantica');
      const link = { context, subscribe: () => () => {}, close() { link.closed = true; },
        async request(input) {
          requests.push(input);
          if (options.request) return options.request(input);
          if (hold) await hold;
          const route = input.path;
          let value = {};
          if (route.endsWith('/warehouses')) value = { items: [{ id: 'warehouse', state: 'active' }] };
          if (route.endsWith('/search')) value = { results: [{ document_id: 'document', excerpt: 'synthetic evidence' }] };
          return { status: 200, body: Buffer.from(JSON.stringify(value)), headers: {} };
        } };
      links.push(link); return link;
    },
  };
  const service = createStarlinkPanelService({ client, emit: event => events.push(event) });
  return { service, requests, events, links, hold: promise => { hold = promise; },
    changeUser(id) { userId = id; },
    switchAccount(id) { state = { ...state, account: { ...state.account, accountId: id } }; listener(); } };
}

test('panel uses the current Host identity and routes knowledge reads through Bridge', async () => {
  const f = fixture();
  try {
    const init = await f.service.action('initialize');
    assert.equal(init.ok, true); assert.equal(init.value.identity.boxId, 'box');
    const result = await f.service.action('search', { warehouseId: 'warehouse', query: 'material' });
    assert.equal(result.ok, true); assert.equal(result.value.results[0].document_id, 'document');
    assert.equal(f.requests.at(-1).path, '/api/semantica/warehouses/warehouse/search');
    assert.equal(JSON.parse(f.requests.at(-1).body).query, 'material');
  } finally { f.service.close(); }
});

test('space import errors retain actionable public codes across the panel boundary', async () => {
  const f = fixture({request: async () => ({status:404,body:Buffer.from('{}'),headers:{}})});
  try {
    const result = await f.service.action('space-list', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SPACE_UPGRADE_REQUIRED');
  } finally { f.service.close(); }
});

test('a service-side identity refusal releases the old session and can initialize again', async () => {
  const f = fixture();
  try {
    await f.service.action('initialize');
    f.changeUser(2);
    assert.equal((await f.service.action('onboarding-read')).ok, false);
    assert.equal(f.links[0].closed, true);
    const next = await f.service.action('initialize');
    assert.equal(next.ok, true);
    assert.equal(next.value.identity.user.id, 2);
  } finally { f.service.close(); }
});

test('closing the service refuses a file chooser that completes after logout', async () => {
  let finish;
  const service = new SemanticaService({host:{onSessionInvalidated:()=>()=>{},close(){}},
    selectFiles:()=>new Promise(resolve=>{finish=resolve;})});
  const pending = service.call('select-files', {warehouseId:'warehouse'});
  service.close(); finish([]);
  await assert.rejects(pending, {code:'HOST_SESSION_EXPIRED'});
  assert.equal(service.files.size, 0);
});

test('removed application management actions never reach the backend', async () => {
  const f = fixture();
  try {
    for (const action of ['create-key', 'import-skill', 'clear-warehouse', 'delete-warehouse', 'open-starlink']) {
      const result = await f.service.action(action, {});
      assert.equal(result.ok, false);
    }
    assert.equal(f.requests.length, 0); assert.equal(f.links.length, 0);
  } finally { f.service.close(); }
});

test('account changes discard pending reads and release their connection', async () => {
  const f = fixture(); let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.action('warehouses');
  await new Promise(resolve => setImmediate(resolve));
  f.switchAccount('other'); release();
  assert.equal((await pending).ok, false);
  assert.equal(f.links[0].closed, true);
  assert.equal((await f.service.action('initialize')).value.identity.accountId, 'other');
  assert.ok(f.events.some(event => event.type === 'invalidated'));
  f.service.close();
});

test('reset releases resources and starts a fresh session on the next visit', async () => {
  const f = fixture();
  await f.service.action('warehouses');
  await f.service.action('reset');
  assert.equal(f.links[0].closed, true);
  await f.service.action('warehouses'); assert.equal(f.links.length, 2);
  f.service.close();
});
