import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf('const ontologyHeadings ='), source.indexOf('const jobNames ='));
const views = ['ontology', 'review'];

function setup({ warehouseId = null, warehouses = [], ready = true, invalid = false, canNavigate = true } = {}) {
  const state = { warehouseId, warehouses, ready, invalid, view: 'models' };
  const toasts = [], shown = [], refreshes = [];
  const elements = new Map();
  const context = {
    state, bridge: null, conversationFlow: null, onboarding:{busy:false},
    pages: Object.fromEntries(['warehouses', 'models', 'conversation', ...views].map(view => [view, [view, '', '']])),
    workbench: { has: view => views.includes(view), clearOntologyAction() {}, show: view => { shown.push(view); return Boolean(warehouseId) && canNavigate; } },
    document: { querySelectorAll: () => [], getElementById: () => null },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { dataset: {}, classList: { toggle() {}, remove() {} } });
      return elements.get(selector);
    },
    toast: message => toasts.push(message), icon: () => '',
    renderWarehouses() {}, renderProcessingSummary() {}, syncControls() {}, syncStarxiaotu() {}, stopConversation() {}, setNavigationOpen() {},
    refresh: () => refreshes.push('directory-read'),
    loadPolicy() {}, loadKeys() {}, renderManagement() {}, loadModels() {},
    skillsUi: { load() {} },
    graphMotion: { reset() {} },
  };
  vm.createContext(context);
  vm.runInContext(navigation, context);
  context.loadConversation=()=>{};
  return { state, toasts, shown, refreshes, navigate: (view, fromWorkbench = false) => context.setView(view, fromWorkbench) };
}

for (const view of views) test(`unselected ${view} opens the warehouse directory with guidance, even when an active warehouse exists`, () => {
  for (const warehouses of [[], [{ id: 'available-warehouse', state: 'active' }]]) {
    const h = setup({ warehouses });
    h.navigate(view);
    assert.equal(h.state.view, 'warehouses');
    assert.equal(h.state.warehouseId, null);
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0], /选择.*新建.*星图/);
    assert.deepEqual(h.shown, [], 'no unscoped iframe or knowledge read may be started');
    assert.deepEqual(h.refreshes, ['directory-read']);
  }
});

test('a selected warehouse retains normal integrated navigation and a cancelled leave remains cancelled', () => {
  for (const view of views.filter(v=>v!=='review')) {
    const h = setup({ warehouseId: 'selected-warehouse' });
    h.navigate(view);
    assert.equal(h.state.view, view);
    assert.deepEqual(h.shown, [view]);
    assert.deepEqual(h.toasts, []);
    const cancelled = setup({ warehouseId: 'selected-warehouse', canNavigate: false });
    cancelled.navigate(view);
    assert.equal(cancelled.state.view, 'models');
    assert.deepEqual(cancelled.shown, [view]);
    assert.deepEqual(cancelled.toasts, []);
    assert.deepEqual(cancelled.refreshes, []);
  }
});

test('the former review entry opens the material workspace; trusted editor callbacks still open the detailed editor',()=>{
  const h=setup({warehouseId:'selected-warehouse'});h.navigate('review');assert.equal(h.state.view,'conversation');assert.deepEqual(h.shown,[]);
  h.navigate('review',true);assert.equal(h.state.view,'review');
});

test('not-ready or invalid sessions do not redirect or suggest creating a warehouse', () => {
  for (const view of views) for (const state of [{ ready: false }, { invalid: true }]) {
    const h = setup(state);
    h.navigate(view);
    assert.equal(h.state.view, 'models');
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.refreshes, []);
  }
});

test('unknown views remain inert and trusted workbench callbacks retain their existing navigation path', () => {
  const unknown = setup();
  unknown.navigate('unknown-view');
  assert.equal(unknown.state.view, 'models');
  assert.deepEqual(unknown.shown, []);
  assert.deepEqual(unknown.toasts, []);
  for (const view of views) {
    const callback = setup();
    callback.navigate(view, true);
    assert.equal(callback.state.view, view);
    assert.deepEqual(callback.shown, []);
    assert.deepEqual(callback.toasts, []);
  }
});
