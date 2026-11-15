import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const warehouseId = '11111111-1111-1111-1111-111111111111';
const online = { id: 'online-default', revision: 'online-v2', name: 'Online default', provider: 'Provider', location: 'external', available: true };
const local = { id: 'local-selection', revision: 'local-v1', name: 'Local selection', provider: 'Local', location: 'local', available: true };
const response = body => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });

for (const edition of ['personal-client', 'team-client']) {
  const source = await readFile(new URL(`../../${edition}/applications/starlink/ui/app.js`, import.meta.url), 'utf8');
  const editor = source.slice(source.indexOf('async function loadModels() {'), source.indexOf('async function reprocessModels('));
  function fixture({ mode = 'automatic', defaultModel = online, scope = 'warehouse', inherit = false, accept = true, checkError, switchDuringCheck = false } = {}) {
    const elements = new Map();
    const $ = selector => {
      if (!elements.has(selector)) elements.set(selector, { value: '', checked: false, textContent: '' });
      return elements.get(selector);
    };
    $('#model-scope').value = scope;
    const state = { ready: true, generation: 1, modelRequest: 0 };
    const calls = [], confirmations = [];
    const config = { revision: 0, inherit, affected_warehouses: [], stages: [], effective: {
      mode, extraction: local, sensitive: local,
      blocked_reason: 'MODEL_CLOUD_CONFIRMATION_REQUIRED',
    } };
    const context = vm.createContext({ state, $, esc: String, date: String,
      currentWarehouse: () => ({ name: 'Synthetic warehouse' }),
      confirm: text => { confirmations.push(text); return accept; },
      errorText: error => error.publicMessage || error.code || error.message,
      loadProcessingSummary: async () => {},
      async call(action, input) {
        calls.push({ action, input: input && JSON.parse(JSON.stringify(input)) });
        if (action === 'processing') return config;
        if (action === 'model-catalog') return { items: [online, local], default: defaultModel };
        if (action === 'check-models') {
          if (switchDuringCheck) state.generation++;
          if (checkError) throw checkError;
          return { check_id: 'checked-synthetic-model' };
        }
        if (action === 'save-models') return {};
        throw new Error('Unexpected action: ' + action);
      },
    });
    vm.runInContext(editor, context);
    return { state, $, calls, confirmations,
      load: () => vm.runInContext('loadModels()', context),
      save: () => vm.runInContext('saveModels()', context),
    };
  }

  test(`${edition}: automatic online model requires explicit consent, checks the actual default and saves the check`, async () => {
    const f = fixture();
    await f.load();
    assert.match(f.$('#model-status').textContent, /检查实际调用能力/);
    await f.save();
    assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0], /Online default/);
    assert.match(f.confirmations[0], /未经脱敏/);
    const checks = f.calls.filter(c => c.action === 'check-models');
    assert.equal(checks.length, 1);
    assert.deepEqual(checks[0].input, { scope: 'warehouse', config: {
      mode: 'automatic', extraction: online.id, inference_options: {thinking_mode: 'auto'}, cloud_confirmations: [online.revision],
    } });
    assert.deepEqual(f.calls.find(c => c.action === 'save-models').input.config, {
      expected_revision: 0, inherit: false, mode: 'automatic', check_id: 'checked-synthetic-model',
    });
    assert.equal(f.state.modelSaving, false);
  });

  test(`${edition}: cancelling online confirmation never checks or saves model permission`, async () => {
    const f = fixture({ accept: false });
    await f.load(); await f.save();
    assert.equal(f.confirmations.length, 1);
    assert(!f.calls.some(c => ['check-models', 'save-models'].includes(c.action)));
    assert.equal(f.state.modelSaving, false);
  });

  test(`${edition}: owner default configuration explicitly checks and saves confirmation for inheriting warehouses`, async () => {
    const f = fixture({ scope: 'default' });
    await f.load(); await f.save();
    assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0], /未来新仓/);
    assert.equal(f.calls.find(c => c.action === 'check-models')?.input.scope, 'default');
    const saved = f.calls.find(c => c.action === 'save-models');
    assert.equal(saved?.input.scope, 'default');
    assert.equal(saved?.input.config.check_id, 'checked-synthetic-model');
    assert.equal(saved?.input.config.inherit, false);
  });

  test(`${edition}: local automatic model is checked without an online confirmation`, async () => {
    const f = fixture({ defaultModel: local });
    await f.load(); await f.save();
    assert.equal(f.confirmations.length, 0);
    assert.deepEqual(f.calls.find(c => c.action === 'check-models')?.input.config, {
      mode: 'automatic', extraction: local.id, inference_options: {thinking_mode: 'auto'}, cloud_confirmations: [],
    });
    assert.equal(f.calls.find(c => c.action === 'save-models')?.input.config.check_id, 'checked-synthetic-model');
  });

  test(`${edition}: missing automatic default cannot save an unchecked reset`, async () => {
    const f = fixture({ defaultModel: null });
    await f.load(); await f.save();
    assert(!f.calls.some(c => ['check-models', 'save-models'].includes(c.action)));
    assert.match(f.$('#model-status').textContent, /可用模型/);
  });

  test(`${edition}: model changes during check require a new check instead of saving consent`, async () => {
    const f = fixture({ checkError: { code: 'MODEL_CONFIG_CHANGED' } });
    await f.load(); await f.save();
    assert.equal(f.calls.filter(c => c.action === 'check-models').length, 1);
    assert(!f.calls.some(c => c.action === 'save-models'));
    assert.equal(f.$('#model-status').textContent, 'MODEL_CONFIG_CHANGED');
  });

  test(`${edition}: changing warehouse during check cannot save into the new context`, async () => {
    const f = fixture({ switchDuringCheck: true });
    await f.load(); await f.save();
    assert.equal(f.calls.filter(c => c.action === 'check-models').length, 1);
    assert(!f.calls.some(c => c.action === 'save-models'));
  });

  test(`${edition}: manual selection retains its chosen model and check result`, async () => {
    const f = fixture({ mode: 'manual' });
    await f.load(); await f.save();
    assert.deepEqual(f.calls.find(c => c.action === 'check-models')?.input.config, {
      mode: 'manual', extraction: local.id, inference_options: {thinking_mode: 'auto'}, cloud_confirmations: [],
    });
    assert.equal(f.calls.find(c => c.action === 'save-models')?.input.config.mode, 'manual');
  });

  test(`${edition}: restoring inheritance does not grant independent online permission`, async () => {
    const f = fixture({ inherit: true });
    await f.load(); await f.save();
    assert.equal(f.confirmations.length, 0);
    assert(!f.calls.some(c => c.action === 'check-models'));
    assert.equal(f.calls.find(c => c.action === 'save-models')?.input.config.inherit, true);
  });

  test(`${edition}: online confirmation notification differs from model failure and deduplicates`, async () => {
    const { collectStarlinkNotifications } = await import(`../../${edition}/shell/starlink-notifications.mjs`);
    let state = {}, blocked = true;
    const notices = [];
    const poll = () => collectStarlinkNotifications({ deviceId: 'synthetic-box', dataScope: 'personal',
      isCurrent: () => true, state, collect: notice => notices.push(notice), save: async next => { state = next; },
      request: async ({ path }) => path.endsWith('/warehouses') ? response({ items: [{ id: warehouseId, state: 'active' }] })
        : path.includes('/processing?') ? response({ effective: { mode: 'automatic', signature: 'model-config',
          blocked_reason: blocked ? 'MODEL_CLOUD_CONFIRMATION_REQUIRED' : null,
          extraction: { available: true }, sensitive: { available: true } } })
        : response({ feed_id: 'synthetic-feed', items: [], next_cursor: 0, has_more: false }),
    });
    await poll(); await poll();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, '星图在线模型待确认');
    assert.match(notices[0].body, /模型与处理/);
    assert.doesNotMatch(notices[0].body, /无法使用|模型不可用/);
    blocked = false; await poll(); blocked = true; await poll();
    assert.equal(notices.length, 2);
  });
}
