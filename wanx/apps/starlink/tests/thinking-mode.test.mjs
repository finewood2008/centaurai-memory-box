import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.env.STARLINK_APP_SOURCE || new URL('../ui/app.js', import.meta.url), 'utf8');
const embedding = source.slice(source.indexOf('const embeddingTransferNotice'), source.indexOf('function actualModel('));
const editor = source.slice(source.indexOf('function modelAvailability('), source.indexOf('async function saveModels('));
const save = source.slice(source.indexOf('async function saveModels('), source.indexOf('const reprocessPlans ='));

function setup({mode = 'manual', thinking = 'off', supported = ['auto','on','off'], pending = 0} = {}) {
  const model = {id: 'fixture', available: true, location: 'local', inference_options: {thinking_modes: supported}};
  const savedConfig = {revision: 5, stages: [], effective: {mode, extraction: model, inference_options: {thinking_mode: thinking}}, modelSync: {pending}};
  const state = {ready: true, identity: {boxId: 'box'}, generation: 1, warehouseId: null,
    modelRequest: 1, modelSaving: false, modelConfig: {revision: 4}, modelCatalog: [model], modelDefault: model};
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {value: '', checked: false, hidden: false, disabled: false});
    return nodes.get(id);
  };
  $('#model-mode').value = mode;
  $('#model-thinking').value = thinking; $('#model-extraction').value = model.id;
  const calls = [];
  const context = {state, $, starxiaotuTermMarker: () => "", esc: value => String(value), currentWarehouse: () => null,
    confirm: () => true, errorText: e => e.publicMessage || e.message,
    call: async (action, payload, warehouseId) => {
      calls.push({action, payload, warehouseId});
      if (action === 'check-models') return {check_id: 'verified'};
      if (action === 'sync-models') return {modelSync: {pending: 0}};
      return savedConfig;
    },
    loadProcessingSummary: async () => {}, loadModels: async () => {}};
  vm.createContext(context); vm.runInContext(embedding + editor + save, context);
  return {context, state, nodes, $, calls};
}

for (const mode of ['manual','automatic']) {
  test(`${mode} checks exact thinking choice and saves the shared profile with no selected project`, async () => {
    const h = setup({mode});
    await h.context.saveModels();
    assert.deepEqual(h.calls.map(call => [call.action, call.payload.scope, call.warehouseId]), [
      ['check-models', 'default', null], ['save-models', 'default', null],
    ]);
    assert.equal(h.calls[0].payload.config.inference_options.thinking_mode, 'off');
    assert.equal(h.calls[0].payload.config.mode, mode);
    assert.equal(h.calls[1].payload.config.expected_revision, 4);
    assert.equal(h.calls[1].payload.config.check_id, 'verified');
    assert.equal(h.calls[1].payload.applyToAll, true);
    assert.equal(h.calls[1].payload.config.inherit, undefined);
    assert.equal(h.calls[1].payload.config.inference_options, undefined);
    assert.equal(h.state.modelConfig.revision, 5);
    assert.match(h.$('#model-save-status').textContent, /所有星图的新任务/);
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
test('declining the shared cloud model confirmation leaves the profile unsaved', async () => {
  const h = setup();
  h.state.modelCatalog[0].location = 'cloud';
  let prompt = '';
  h.context.confirm = message => { prompt = message; return false; };
  await h.context.saveModels();
  assert.match(prompt, /未经脱敏.*正文片段/);
  assert.match(prompt, /星图/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state.modelSaving, false);
});
test('switching projects during the check still saves the same shared profile', async () => {
  const h = setup();
  let completeCheck;
  const call = h.context.call;
  h.context.call = (action, ...input) => {
    const response = call(action, ...input);
    if (action === 'check-models') return new Promise(resolve => { completeCheck = () => resolve(response); });
    return response;
  };
  const saving = h.context.saveModels();
  h.state.generation++;
  h.state.warehouseId = 'different-project';
  completeCheck();
  await saving;
  assert.deepEqual(h.calls.map(({action, warehouseId}) => [action, warehouseId]), [['check-models', null], ['save-models', null]]);
});

test('switching boxes during the check discards the old check receipt', async () => {
  const h = setup();
  let completeCheck;
  h.context.call = action => {
    h.calls.push(action);
    return new Promise(resolve => { completeCheck = resolve; });
  };
  const saving = h.context.saveModels();
  h.state.identity = {boxId: 'other-box'};
  h.state.modelRequest++;
  completeCheck({check_id: 'verified-on-first-box'});
  await saving;
  assert.deepEqual(h.calls, ['check-models']);
});

test('automatic auto mode is checked before saving too', async () => {
  const h = setup({mode: 'automatic', thinking: 'auto'});
  h.context.updateModelControls();
  assert.equal(h.$('#model-save').disabled, false);
  await h.context.saveModels();
  assert.deepEqual(h.calls.map(c => c.action), ['check-models', 'save-models']);
  assert.equal(h.calls[0].payload.config.inference_options.thinking_mode, 'auto');
  assert.equal(h.calls[1].payload.config.inference_options, undefined);
});

test('retrying pending old project updates uses the saved shared revision without saving the model again', async () => {
  const h = setup({pending: 2});
  await h.context.saveModels();
  assert.equal(h.$('#model-sync').hidden, false);
  assert.match(h.$('#model-sync-status').textContent, /2 个旧项目待切换/);
  assert.doesNotMatch(h.$('#model-save-status').textContent, /所有星图/);
  await h.context.retryModelSync();
  assert.deepEqual(h.calls.map(call => call.action), ['check-models', 'save-models', 'sync-models']);
  assert.equal(h.calls[2].payload.scope, 'default');
  assert.equal(h.calls[2].payload.expectedRevision, 5);
  assert.equal(h.calls[2].warehouseId, null);
  assert.equal(h.$('#model-sync').hidden, true);
  assert.match(h.$('#model-save-status').textContent, /所有星图的新任务/);
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

test('external vector service disclosure follows the embedding stage with local extraction', () => {
  const h = setup();
  const embeddingStage = {role:'embedding', name:'Vector model', available:true, location:'external'};
  h.state.modelConfig = {revision:0, inherit:false, affected_warehouses:[], stages:[embeddingStage],
    effective:{mode:'automatic', extraction:h.state.modelDefault}};
  h.context.renderModelEditor();
  assert.match(h.$('#model-stages').innerHTML, /未经脱敏的正文片段.*检索词/);
  embeddingStage.location = 'local';
  h.context.renderModelEditor();
  assert.doesNotMatch(h.$('#model-stages').innerHTML, /未经脱敏的正文片段/);
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
test('model changes update supported thinking modes without requiring a project', () => {
  const h = setup();
  h.context.updateModelControls();
  assert.equal(h.$('#model-thinking-controls').hidden, false);
  assert.equal(h.$('#model-thinking').disabled, false);
  h.state.modelCatalog[0].inference_options.thinking_modes = ['auto'];
  h.context.updateModelControls();
  assert.match(h.$('#model-thinking').innerHTML, /value="off" disabled/);
});
