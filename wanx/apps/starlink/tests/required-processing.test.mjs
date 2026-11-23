import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticaService } from '../shell/service.mjs';

const warehouse = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const operation = value => assert.match(value, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);

async function fixture(t, mode = 'required') {
  const seen = []; let revoke, currentMode = mode;
  const host = {
    context: async () => ({ boxId: 'synthetic-box', user: { id: 1, username: 'synthetic' }, connection: 'ready' }),
    onSessionInvalidated(fn) { revoke = fn; return () => {}; },
    close() {},
    async request(endpoint, options) {
      seen.push({ endpoint, ...structuredClone({ method: options?.method || 'GET', body: options?.body }) });
      if (endpoint === '/api/semantica/status') return response({ local_data_gate_mode: currentMode });
      if (endpoint === '/api/semantica/capabilities') return response({});
      if (endpoint === '/api/semantica/warehouses') return response({ items: [{ id: warehouse }] });
      if (endpoint === '/api/semantica/warehouses/runtime') return response({});
      return response({ status: 'saved', check_id: 'synthetic-check' });
    },
  };
  const service = new SemanticaService({ host });
  t.after(() => service.close());
  await service.call('initialize'); seen.length = 0;
  return { service, seen, revoke: () => revoke(), mode: value => { currentMode = value; } };
}

for (const mode of ['required', 'legacy']) test(`${mode} explicit warehouse model scope cannot fall back to default without a warehouse`, async t => {
  const f = await fixture(t, mode);
  for (const action of ['processing', 'model-catalog', 'check-models', 'save-models']) {
    await assert.rejects(f.service.call(action, { scope: 'warehouse', config: { inherit: false } }), { code: 'INVALID_RESOURCE' });
  }
  assert.equal(f.seen.length, 0);
});

test('required processing uses the selected warehouse signed path and preserves model confirmation data', async t => {
  const f = await fixture(t);
  await f.service.call('processing', { warehouseId: warehouse });
  await f.service.call('model-catalog', { warehouseId: warehouse });
  const check = { extraction: { id: 'provider:model', revision: 'a'.repeat(64) }, mode: 'manual',
    inference_options: { thinking_mode: 'auto' }, cloud_confirmations: ['a'.repeat(64)] };
  const save = { expected_revision: 7, inherit: false, mode: 'manual', check_id: 'synthetic-check' };
  await f.service.call('check-models', { warehouseId: warehouse, config: check });
  await f.service.call('save-models', { warehouseId: warehouse, config: save });
  assert.deepEqual(f.seen.map(value => [value.method, value.endpoint]), [
    ['GET', `/api/semantica/warehouses/${warehouse}/processing?warehouse_id=${warehouse}`],
    ['GET', `/api/semantica/warehouses/${warehouse}/processing/catalog`],
    ['POST', `/api/semantica/warehouses/${warehouse}/processing/check`],
    ['PUT', `/api/semantica/warehouses/${warehouse}/processing`],
  ]);
  for (const [index, expected] of [[2, check], [3, save]]) {
    const { operation_id, ...body } = f.seen[index].body; operation(operation_id);
    assert.deepEqual(body, { ...expected, warehouse_id: warehouse });
  }
  assert.deepEqual(check.cloud_confirmations, ['a'.repeat(64)]);
  assert.equal(check.warehouse_id, undefined);
});

test('required default processing stays on the private default profile and cannot carry another warehouse selector', async t => {
  const f = await fixture(t);
  await f.service.call('processing', { warehouseId: warehouse, scope: 'default' });
  await f.service.call('model-catalog', { warehouseId: warehouse, scope: 'default' });
  await f.service.call('check-models', { warehouseId: warehouse, scope: 'default', config: { mode: 'automatic' } });
  await f.service.call('save-models', { warehouseId: warehouse, scope: 'default', config: { inherit: false, expected_revision: 0 } });
  assert.deepEqual(f.seen.map(value => value.endpoint), ['/api/semantica/processing', '/api/semantica/processing/catalog',
    '/api/semantica/processing/check', '/api/semantica/processing']);
  assert.equal(f.seen[2].body.warehouse_id, null);
  assert.equal(f.seen[3].body.warehouse_id, null);
  const before = f.seen.length;
  await assert.rejects(f.service.call('save-models', { warehouseId: warehouse, scope: 'default',
    config: { warehouse_id: other, inherit: false } }), { code: 'INVALID_RESOURCE' });
  assert.equal(f.seen.length, before);
});

test('required processing rejects malformed or conflicting selectors and caller flags never choose legacy', async t => {
  const f = await fixture(t);
  for (const selected of ['warehouse-a', warehouse.toUpperCase().replace('10000000', 'ABCDEF00'), warehouse + '?warehouse_id=' + other]) {
    await assert.rejects(f.service.call('processing', { warehouseId: selected }), { code: 'INVALID_RESOURCE' });
  }
  await assert.rejects(f.service.call('check-models', { warehouseId: warehouse, config: { warehouse_id: other } }), { code: 'INVALID_RESOURCE' });
  assert.equal(f.seen.length, 0);
  await f.service.call('processing', { warehouseId: warehouse, local_data_gate_mode: 'legacy', required: false });
  assert.equal(f.seen[0].endpoint, `/api/semantica/warehouses/${warehouse}/processing?warehouse_id=${warehouse}`);
  f.revoke();
  await assert.rejects(f.service.call('processing', { warehouseId: warehouse }), { code: 'HOST_SESSION_EXPIRED' });
  assert.equal(f.seen.length, 1);
});

test('legacy processing retains its existing query/body routes and a fresh verified initialization updates formatting', async t => {
  const f = await fixture(t, 'legacy');
  await f.service.call('processing', { warehouseId: 'warehouse-a' });
  await f.service.call('model-catalog', { warehouseId: 'warehouse-a' });
  await f.service.call('check-models', { warehouseId: 'warehouse-a', config: { mode: 'automatic' } });
  await f.service.call('save-models', { warehouseId: 'warehouse-a', config: { expected_revision: 2, check_id: 'checked' } });
  assert.deepEqual(f.seen.map(value => value.endpoint), ['/api/semantica/processing?warehouse_id=warehouse-a',
    '/api/semantica/processing/catalog', '/api/semantica/processing/check', '/api/semantica/processing']);
  assert.equal(f.seen[2].body.warehouse_id, 'warehouse-a');
  f.mode('required'); await f.service.call('initialize'); f.seen.length = 0;
  await f.service.call('processing', { warehouseId: warehouse });
  assert.equal(f.seen[0].endpoint, `/api/semantica/warehouses/${warehouse}/processing?warehouse_id=${warehouse}`);
});
