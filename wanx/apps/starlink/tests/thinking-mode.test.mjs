import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.env.STARLINK_APP_SOURCE || new URL('../ui/app.js', import.meta.url), 'utf8');
const editor = source.slice(source.indexOf('function renderModelEditor('), source.indexOf('async function saveModels('));
const save = source.slice(source.indexOf('async function saveModels('), source.indexOf('\n$("#model-', source.indexOf('async function saveModels(')));

function setup({mode = 'manual', thinking = 'off', inherited = false, supported = ['auto','on','off']} = {}) {
  const model = {id: 'fixture', available: true, location: 'local', inference_options: {thinking_modes: supported}};
  const state = {generation: 1, modelRequest: 1, modelSaving: false, modelConfig: {revision: 4}, modelCatalog: [model], modelDefault: model};
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {value: '', checked: false, hidden: false, disabled: false});
    return nodes.get(id);
  };
  $('#model-scope').value = 'warehouse'; $('#model-mode').value = mode;
  $('#model-thinking').value = thinking; $('#model-extraction').value = model.id;
  $('#model-inherit').checked = inherited;
  const calls = [];
  const context = {state, $, esc: value => String(value), currentWarehouse: () => null,
    confirm: () => true, errorText: e => e.publicMessage || e.message,
    call: async (action, payload) => { calls.push({action, payload}); return action === 'check-models' ? {check_id: 'verified'} : {}; },
    loadProcessingSummary: async () => {}, loadModels: async () => {}};
  vm.createContext(context); vm.runInContext(editor + save, context);
  return {context, state, nodes, $, calls};
}

for (const mode of ['manual','automatic']) {
  test(`${mode} checks exact thinking choice before saving`, async () => {
    const h = setup({mode});
    await h.context.saveModels();
    assert.equal(h.calls[0].action, 'check-models');
    assert.equal(h.calls[0].payload.config.inference_options.thinking_mode, 'off');
    assert.equal(h.calls[0].payload.config.mode, mode);
    assert.equal(h.calls[1].payload.config.check_id, 'verified');
    assert.equal(h.calls[1].payload.config.inference_options, undefined);
  });
}
test('unsupported explicit choice is not silently changed or saved', async () => {
  const h = setup({supported: ['auto']});
  h.context.updateModelControls();
  assert.equal(h.$('#model-thinking').value, 'off');
  await h.context.saveModels();
  assert.equal(h.calls.length, 0);
  assert.match(h.$('#model-save-status').textContent, /不支持/);
});
test('inherit preserves existing save behavior', async () => {
  for (const settings of [{inherited: true}]) {
    const h = setup(settings);
    await h.context.saveModels();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].action, 'save-models');
  }
});

test('automatic auto mode is checked before saving too', async () => {
  const h = setup({mode: 'automatic', thinking: 'auto'});
  h.context.updateModelControls();
  assert.equal(h.$('#model-save').textContent, '检查并保存');
  await h.context.saveModels();
  assert.deepEqual(h.calls.map(c => c.action), ['check-models', 'save-models']);
  assert.equal(h.calls[0].payload.config.inference_options.thinking_mode, 'auto');
  assert.equal(h.calls[1].payload.config.inference_options, undefined);
});

test('new draft defaults off while missing capabilities allow only auto', () => {
  const h = setup();
  h.context.renderThinkingOptions(null);
  assert.equal(h.$('#model-thinking').value, 'off');
  delete h.state.modelCatalog[0].inference_options;
  h.context.renderThinkingOptions(null);
  assert.equal(h.$('#model-thinking').value, 'auto');
  assert.match(h.$('#model-thinking').innerHTML, /value="on" disabled/);
  assert.match(h.$('#model-thinking').innerHTML, /value="off" disabled/);
});

test('saved explicit choices remain unchanged', () => {
  const h = setup();
  for (const mode of ['auto', 'on', 'off']) {
    h.context.renderThinkingOptions(mode);
    assert.equal(h.$('#model-thinking').value, mode);
  }
});

test('editor always shows the backend effective mode even without a saved profile', () => {
  const h = setup();
  for (const mode of ['auto', 'off', 'on']) {
    h.state.modelConfig = {revision:0, default_revision:0, inherit:false,
      affected_warehouses:[], stages:[], effective:{mode:'automatic',
        extraction:h.state.modelDefault, inference_options:{thinking_mode:mode}}};
    h.context.renderModelEditor();
    assert.equal(h.$('#model-thinking').value, mode);
  }
});

for (const code of ['MODEL_THINKING_UNSUPPORTED', 'MODEL_OPTIONS_INVALID', 'MODEL_OPTIONS_UNCONFIRMED']) {
  test(`${code} aborts save and preserves the draft`, async () => {
    const h = setup();
    h.context.call = async (action) => { h.calls.push(action); throw {message:code}; };
    await h.context.saveModels();
    assert.deepEqual(h.calls, ['check-models']);
    assert.equal(h.$('#model-save-status').textContent, code);
    assert.equal(h.$('#model-thinking').value, 'off');
    assert.equal(h.state.modelSaving, false);
  });
}
test('model changes update capabilities and inherited mode remains visible read-only', () => {
  const h = setup({inherited: true});
  h.context.updateModelControls();
  assert.equal(h.$('#model-thinking-controls').hidden, false);
  assert.equal(h.$('#model-thinking').disabled, true);
  assert.match(h.$('#model-thinking-note').textContent, /继承/);
  h.state.modelCatalog[0].inference_options.thinking_modes = ['auto'];
  h.context.updateModelControls();
  assert.match(h.$('#model-thinking').innerHTML, /value="off" disabled/);
});
