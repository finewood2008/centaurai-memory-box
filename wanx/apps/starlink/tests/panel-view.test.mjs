import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../integration/panel-view.js', import.meta.url), 'utf8');
function fixture() {
  let event, respond = async () => ({ ok: true });
  const nodes = [];
  const createButton = { disabled: true };
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ x: 20, y: 30, width: 900, height: 600 }) };
  const window = { addEventListener() {}, wanxClient: { onStarlinkEvent(fn) { event = fn; } } };
  const document = { baseURI: 'file:///C:/app/local-ui/renderer/index.html',
    querySelector: selector => selector === '#starlink-banner-create' ? createButton : null,
    getElementById: id => id === 'starlink-panel-region' ? anchor : null,
    body: { append() {} }, createElement(tag) {
      const node = { tag, contentWindow: {}, style: {}, setAttribute() {}, append() {}, remove() { this.removed = true; } };
      nodes.push(node); return node;
    } };
  vm.runInNewContext(source, { window, document, URL, ResizeObserver: class { observe() {} disconnect() {} } });
  const panel = window.createStarlinkPanelView({ request: (...args) => args[1]?.action === 'reset' ? Promise.resolve({ok:true}) : respond(...args), changed() {} });
  const state = { canLaunchApplications: true, account: { accountId: 'one', clientId: 'client' }, connection: { deviceId: 'box' } };
  panel.sync(state, true, true); panel.mount();
  return { panel, window, state, nodes, createButton, event: value => event(value), respond: fn => { respond = fn; },
    connect: () => window.wanxStarlinkPanel.connect(nodes.filter(n=>n.tag==='iframe').at(-1).contentWindow),
    frame: () => nodes.filter(n => n.tag === 'iframe').at(-1) };
}
test('panel mounts packaged UI once, retaining edits across client broadcasts and navigation', () => {
  const f = fixture(), frame = f.frame();
  assert.equal(frame.src, 'file:///C:/app/local-ui/starlink/ui/index.html');
  f.panel.sync(f.state, true, true); f.panel.mount(); assert.equal(f.frame(), frame);
  f.panel.sync(f.state, true, false); assert.equal(f.nodes[0].hidden, true);
  f.panel.sync(f.state, true, true); f.panel.mount(); assert.equal(f.frame(), frame);
});
test('only the mounted outer frame can request actions; identity changes discard late responses', async () => {
  const f = fixture();
  assert.throws(() => f.window.wanxStarlinkPanel.connect({}), /UNTRUSTED_FRAME/);
  let release; f.respond(() => new Promise(resolve => { release = resolve; }));
  const old = f.frame();
  const bridge = f.connect();
  const pending = bridge.call(old.contentWindow, 'warehouses', {});
  await new Promise(resolve=>setImmediate(resolve));
  f.panel.sync({ ...f.state, account: { accountId: 'two' } }, true, true);
  release({ ok: true, value: 'private old result' });
  await assert.rejects(pending, /HOST_SESSION_EXPIRED|UNTRUSTED_FRAME/);
  f.panel.mount(); assert.notEqual(f.frame(), old);
});

test('reload revokes the previous document even when its WindowProxy is unchanged', async () => {
  const f = fixture(), source = f.frame().contentWindow;
  const old = f.connect(); let oldEvents=0,newEvents=0;
  old.subscribe(source,()=>oldEvents++);
  f.event({type:'upload'}); assert.equal(oldEvents,1);
  const current = f.connect(); current.subscribe(source,()=>newEvents++);
  f.event({type:'upload'});
  assert.equal(oldEvents,1); assert.equal(newEvents,1);
  await assert.rejects(old.call(source,'upload',{}), /HOST_SESSION_EXPIRED/);
  assert.throws(()=>old.subscribe(source,()=>{}), /HOST_SESSION_EXPIRED/);
  assert.equal((await current.call(source,'warehouses',{})).ok,true);
});

test('banner creation follows the active panel and is disabled when its document is retired', () => {
  const f = fixture();
  const source = f.frame().contentWindow;
  const bridge = f.connect();
  let opened = 0;
  bridge.register(source, { createWarehouse() { opened++; } });
  assert.equal(f.createButton.disabled, true);
  bridge.setCreationEnabled(source, true);
  assert.equal(f.createButton.disabled, false);
  f.panel.action('new-warehouse');
  assert.equal(opened, 1);

  f.panel.sync(f.state, true, false);
  assert.equal(f.createButton.disabled, true);
  f.panel.action('new-warehouse');
  f.panel.sync(f.state, true, true);
  assert.equal(f.createButton.disabled, false);

  f.connect();
  assert.equal(f.createButton.disabled, true);
  assert.throws(() => bridge.setCreationEnabled(source, true), /HOST_SESSION_EXPIRED/);
  f.panel.action('new-warehouse');
  assert.equal(opened, 1);
});
