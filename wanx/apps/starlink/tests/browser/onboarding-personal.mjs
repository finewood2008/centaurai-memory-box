import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { dialogueFixture } from '../fixtures/onboarding-dialogue.mjs';

// Run the assembled personal renderer, actual preload and Starlink iframe.
// The box replies below are synthetic and the profile belongs to this run.
const root = resolve(process.env.WANX_STARLINK_TEST_RUNTIME);
const output = process.env.WANX_STARLINK_TEST_OUTPUT;
app.setPath('userData', mkdtempSync(join(tmpdir(), 'starlink-personal-test-')));
const fixture = dialogueFixture();
const identity = { accountId: 'onboarding-test', boxId: 'onboarding-box', dataScope: 'personal', user: { id: 1, name: '验收用户' } };
const scope = {
  phase: 'ready', canLaunchApplications: true, activeDeviceId: identity.boxId,
  account: { phase: 'authenticated', accountId: identity.accountId, clientId: 'test-client' },
  connection: { deviceId: identity.boxId, mode: 'local', gatewayURL: 'http://127.0.0.1' },
  devices: [{ deviceId: identity.boxId, displayName: '测试盒子', accessState: 'ready' }],
  network: { enabled: false, phase: 'disabled' }, platform: { phase: 'idle' }, applications: [],
};
const calls = [];
const quickReceipts = new Map();
const conversationWarehouses = new Map();
let failRead = false, failQuick = false, failMaterial = false, legacyBox = false;
const empty = () => ({ items: [], total: 0, has_more: false });
const ok = value => ({ ok: true, value });
const fail = (code, status = 0) => ({ ok: false, code, status });
const ipc = (name, handler) => ipcMain.handle('wanx-client:' + name, handler);

ipc('get-state', () => scope);
const spaceFile = {id:'a'.repeat(32),space_id:'personal',name:'建仓验收资料.txt',kind:'file',parent:'',size:44,version:1};
ipc('space-links-spaces', () => [{id:'personal',name:'个人空间',root:'',connections:[]}]);
ipc('space-links-mcp-state', () => ({connections:[]}));
ipc('space-list', () => ({space_id:'personal',root:'',parent:'',breadcrumbs:[],items:[spaceFile]}));
ipcMain.handle('wanx:discovery:bluetooth-state', () => ({}));
for (const name of ['wallet-orders', 'wallet-catalog', 'wallet-balance']) ipc(name, () => ({ ok:false, error:{code:'CREDITS_NOT_CONFIGURED'} }));
for (const name of ['market-list', 'workshop', 'expert-apps', 'credits-transactions']) ipc(name, empty);
for (const name of ['credits-balance', 'clipboard-snapshot', 'memory-open', 'space-refresh']) ipc(name, () => ({}));
ipc('starlink', async (_event, { action, input = {} }) => {
  calls.push({ action, input: structuredClone(input) });
  if (action === 'initialize') return ok({
    identity, warehouses: { items: fixture.db.warehouses }, runtime: {}, capabilities: { accepted_suffixes: ['txt'], document_max_bytes: 10000000 },
  });
  if (action === 'launch-target') return ok(null);
  if (action === 'warehouses') return ok({ items: fixture.db.warehouses });
  if (legacyBox && ['onboarding-warehouses','conversation-list'].includes(action)) return fail('SEMANTICA_RESOURCE_NOT_FOUND',404);
  if (action === 'onboarding-warehouses' && failRead) return fail('SEMANTICA_CONNECTION_FAILED');
  if (action === 'graph') return ok({ nodes: [], edges: [] });
  if (action === 'conversation-material-workflows' && failMaterial) return fail('SEMANTICA_CONNECTION_FAILED');
  if (action === 'create-warehouse') {
    let warehouse = quickReceipts.get(input.operationId);
    if (!warehouse) {
      warehouse = { id: 'quick-' + quickReceipts.size, name: input.name, description: input.description, state: 'active', created_at:'2026-11-18T00:00:00Z', document_count: 0, entity_count: 0, relation_count: 0 };
      quickReceipts.set(input.operationId, warehouse);
      fixture.db.warehouses.push(warehouse);
    }
    if (failQuick) {failQuick=false;return fail('SEMANTICA_CONNECTION_FAILED');}
    return ok(warehouse);
  }
  if (action === 'conversation-list') return ok({ ...empty(), items: fixture.db.sessions.filter(session => conversationWarehouses.get(session.id) === input.warehouseId) });
  if (action === 'workbench-request' && input.url.includes('ontologies')) {
    return ok(await fixture.call('conversation-ontologies'));
  }
  if (action.startsWith('onboarding-') || action.startsWith('conversation-onboarding-') || action === 'conversation-ontologies' ||
      action === 'conversation-create' && input.scenario === 'onboarding') {
    try {
      const value = await fixture.call(action, input);
      if (action === 'conversation-create') conversationWarehouses.set(value.resource_id, input.warehouseId);
      if (action === 'onboarding-create') Object.assign(fixture.db.warehouses.find(item=>item.id===value.warehouse.id),{created_at:'2026-11-18T00:00:00Z',document_count:0,entity_count:0,relation_count:0});
      return ok(value);
    } catch(error) { return fail(error.code || 'SEMANTICA_INVALID_RESPONSE', error.status); }
  }
  return ok(empty());
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1420, height: 900, useContentSize: true,
    webPreferences:{ preload:join(root,'local-ui/remote-preload.cjs'), sandbox:true, contextIsolation:true, backgroundThrottling:false },
  });
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  const main = code => win.webContents.executeJavaScript(code);
  const iframe = () => win.webContents.mainFrame.frames.find(frame => frame.url.endsWith('/starlink/ui/index.html'));
  const star = code => iframe().executeJavaScript(code);
  const deadline = setTimeout(()=>{console.error('STARLINK_PERSONAL_ONBOARDING_TIMEOUT');app.exit(1);},60000);
  async function until(predicate, label) {
    for (let i=0;i<150;i++) {
      if (await Promise.resolve().then(predicate).catch(error => {if (/disposed|destroyed|cannot read/i.test(error.message)) return false;throw error;})) return;
      await pause(35);
    }
    const view = iframe() ? await star('document.querySelector("#app").textContent.slice(0,800)') : '';
    throw new Error(label + '\n' + view);
  }
  const click = (selector, run=star) => run(`(() => {const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error(${JSON.stringify(selector)});button.click();})()`);
  const fill = (selector,value) => star(`(() => {const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const match = (selector,value) => star(`Boolean(document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(value)}))`);
  const count = action => calls.filter(entry => entry.action===action).length;
  const open = () => click('#starlink-banner-create', main);
  const waitName = () => until(()=>star('Boolean(document.querySelector("#od-name-form button[type=submit]:enabled"))'),'Name form is ready');
  const waitDraft = () => until(()=>star('Boolean(document.querySelector("[data-od=preview]:enabled"))'),'Range draft is ready');
  const close = () => click('[data-od=close]');
  async function capture(name) {
    if (!output) return;
    await mkdir(output,{recursive:true});
    await writeFile(join(output,name), (await win.webContents.capturePage()).toPNG());
  }
  async function review() {
    await click('[data-od=preview]');
    await until(()=>match('#od-title','核对并发布规则'),'Review is visible');
    assert.equal(await star('document.querySelector("[data-od=publish]").disabled'),true);
    await click('#od-confirm');
    await click('[data-od=publish]');
  }
  try {
    await win.loadFile(join(root,'local-ui/renderer/index.html'));
    await until(()=>main('Boolean(document.querySelector("[data-action=show-data]"))'),'Personal navigation');
    await click('[data-action=show-data]',main);
    await until(()=>iframe()&&main('Boolean(document.querySelector("#starlink-banner-create:enabled"))'),'Personal Starlink banner');
    await click('#graph-empty-action');
    await waitName();
    assert.equal(await star('document.querySelector("#onboarding-shell").closest("#app").hidden'),false);
    assert.equal(await star('document.querySelector(".starlink-rail [aria-current=page]").dataset.view'),'warehouses');
    assert.equal(await star('document.activeElement.id'),'od-name');
    await close();
    await click('#crumb-warehouse');
    await click('#warehouse-picker [data-action=new-warehouse]');
    await waitName();
    await close();
    await click('.starlink-rail [data-view=warehouses]');
    await click('.warehouse-directory-tools [data-action=new-warehouse]');
    await waitName();
    await close();

    failRead=true;
    await open();
    await until(()=>match('.wp-error','读取'),'Warehouse list read error');
    await fill('#od-name','星图个人版验收');
    const writes=count('onboarding-create');
    assert.equal(await star('document.querySelector("#od-name").readOnly'),false);
    assert.equal(await star('document.querySelector("#od-name-form button[type=submit]").disabled'),true);
    assert.equal(count('onboarding-create'),writes);
    failRead=false;
    await click('[data-od=refresh]');
    await waitName();
    assert.equal(await star('document.querySelector("#od-name").value'),'星图个人版验收');
    await star('document.querySelector("#od-name").dataset.navigationProbe = "retained"');
    await click('[data-action=show-space]',main);
    await until(()=>main('document.querySelector(".starlink-panel-overlay")?.hidden === true'),'Space hides the Starlink panel');
    await until(()=>main('document.querySelector("#app").textContent.includes("建仓验收资料.txt")'),'Space shows its file list');
    await click('[data-action=show-data]',main);
    await until(()=>main('document.querySelector(".starlink-panel-overlay")?.hidden === false'),'Starlink returns from Space');
    assert.equal(await star('document.querySelector("#od-name").dataset.navigationProbe'),'retained');
    assert.equal(await star('document.querySelector("#od-name").value'),'星图个人版验收');
    await capture('01-新建数据仓.png');

    fixture.db.lose='onboarding-create';
    await click('#od-name-form button[type=submit]');
    await until(()=>star('Boolean(document.querySelector("[data-od=recover]:enabled"))'),'Creation receipt recovery');
    await close();
    await click('.starlink-rail [data-view=warehouses]');
    await click('[data-action=resume-onboarding]');
    await until(()=>star('Boolean(document.querySelector("[data-od=recover]:enabled"))'),'Saved request can be resumed');
    await click('[data-od=recover]');
    await until(()=>star('Boolean(document.querySelector("#od-input:enabled"))'),'Created warehouse chat');
    const creates=calls.filter(entry=>entry.action==='onboarding-create');
    assert.deepEqual(creates[0].input, creates[1].input);
    assert.equal(fixture.db.warehouses.length,1);
    await fill('#od-input','用于查阅访谈与设计决策');
    await close();
    await click('[data-warehouse-view=onboarding]');
    await until(()=>star('document.querySelector("#od-input:enabled")?.value==="用于查阅访谈与设计决策"'),'Return to saved chat');
    fixture.db.failTurn=true;
    await click('#od-answer-form button[type=submit]');
    await until(()=>star('Boolean(document.querySelector("[data-od-retry]:enabled"))'),'Retry failed turn');
    await click('[data-od-retry]');
    await click('#od-answer-form button[type=submit]');
    await waitDraft();

    win.setContentSize(590,800);
    await until(()=>star('getComputedStyle(document.querySelector(".od-panel-switch")).display==="flex"'),'Narrow chat tabs');
    await until(()=>star('getComputedStyle(document.querySelector("#starlink-rail")).visibility==="hidden"'),'Narrow nav closes before drawing scope');
    await click('[data-od=draft-panel]');
    assert.equal(await star('getComputedStyle(document.querySelector(".wp-chat")).display'),'none');
    await capture('02-窄窗范围草稿.png');
    await click('[data-od=chat-panel]');
    win.setContentSize(1420,900);
    await capture('03-建仓对话.png');
    await click('[data-od=preview]');
    await until(()=>match('#od-title','核对并发布规则'),'Review before simulated conflict');
    await capture('04-核对规则.png');
    const snapshot=Object.values(fixture.db.snapshots)[0];
    snapshot.draft_digest='d'.repeat(64);
    await click('#od-confirm');
    await click('[data-od=publish]');
    await until(()=>match('.wp-error','变化'),'Changed digest cancels review');
    assert.equal(count('conversation-onboarding-publish'),0);

    failMaterial=true;
    await review();
    await until(()=>match('.wp-error','规则已发布'),'Published result survived unavailable materials');
    await capture('05-发布后恢复.png');
    assert.equal(fixture.db.publishes,1);
    const reloaded=once(win.webContents,'did-finish-load');
    win.webContents.reload();
    await reloaded;
    await until(()=>main('Boolean(document.querySelector("[data-action=show-data]"))'),'Personal navigation after reload');
    await click('[data-action=show-data]',main);
    await until(()=>iframe()&&main('Boolean(document.querySelector("#starlink-banner-create:enabled"))'),'Starlink initialized after reload');
    await until(()=>star('Boolean(document.querySelector("#onboarding-resume:not([hidden])"))'),'Publish receipt survives restarting the panel');
    failMaterial=false;
    await click('[data-action=resume-onboarding]');
    await until(()=>star('Boolean(document.querySelector(".od-publication [data-od=enter]:enabled"))'),'Publish receipt is ready to open');
    await click('.od-publication [data-od=enter]');
    await until(()=>star('!document.querySelector("#view-conversation").hidden && document.querySelector("#onboarding-shell").hidden'),'Published warehouse materials');
    assert.equal(count('conversation-onboarding-publish'),1);
    await until(()=>star('Boolean(document.querySelector("#page-primary:enabled[data-action=import]"))'),'Import is ready in the new warehouse');
    await click('#page-primary');
    await until(()=>star('Boolean(document.querySelector("#import-dialog[open]"))'),'First import opens in the new warehouse');
    await star('document.querySelector("#import-dialog").close()');

    await open();
    await waitName();
    await fill('#od-name','快速创建验收仓');
    failQuick=true;
    await click('[data-od=quick]');
    await until(()=>star('Boolean(document.querySelector(".wp-info [data-od=quick]:enabled"))'),'Quick creation recovery');
    await close();
    await click('.starlink-rail [data-view=warehouses]');
    await click('[data-action=resume-onboarding]');
    await click('.wp-info [data-od=quick]');
    await until(()=>match('#crumb-warehouse','快速创建验收仓'),'Quick warehouse selected');
    await until(()=>star('!document.querySelector("#view-conversation").hidden && document.querySelector("#onboarding-shell").hidden'),'Quick warehouse materials');
    const quick=calls.filter(entry=>entry.action==='create-warehouse');
    assert.deepEqual(quick[0].input,quick[1].input);
    assert.equal(quickReceipts.size,1);
    await capture('06-资料库.png');

    await click('.starlink-rail [data-view=ontology]');
    await click('#ontology-actions summary');
    await click('[data-action=update-warehouse-rules]');
    await until(()=>star('Boolean(document.querySelector("#od-input:enabled"))'),'Existing warehouse rules chat');
    await fill('#od-input','按当前规则增加访谈主题');
    await click('#od-answer-form button[type=submit]');
    await waitDraft();
    await review();
    await until(()=>star('!document.querySelector("#view-workbench").hidden && document.querySelector("#onboarding-shell").hidden'),'Existing warehouse returns to rules');
    await until(()=>star('document.querySelector("#page-title").textContent === "本体与关系"'),'Published rules selected');
    assert.equal(fixture.db.publishes,2);
    assert.equal(fixture.db.warehouses.length,2);
    legacyBox=true;
    await open();
    await until(()=>star('Boolean(document.querySelector("[data-od=quick]:enabled"))'),'Quick creation works on a box without conversation endpoints');
    assert.equal(await star('document.querySelector("#od-name-form button[type=submit]").textContent.trim()'),'创建数据仓');
    assert.equal(await star('Boolean(document.querySelector(".od-steps"))'),false);
    await click('#od-templates summary');
    await click('[data-od-template="0"]');
    assert.ok(await star('document.querySelector("#od-name").value'));
    await fill('#od-name','旧盒兼容验收仓');
    await fill('#od-purpose','从旧版盒子进入资料库');
    await close();
    await open();
    await until(()=>star('Boolean(document.querySelector("[data-od=quick]:enabled"))'),'Legacy form reopens');
    assert.equal(await star('document.querySelector("#od-name").value'),'旧盒兼容验收仓');
    assert.equal(await star('document.querySelector("#od-purpose").value'),'从旧版盒子进入资料库');
    const beforeQuick = count('create-warehouse');
    await click('[data-od=quick]');
    await until(()=>star('!document.querySelector("#view-conversation").hidden && Boolean(document.querySelector("#page-primary:enabled[data-action=import]"))'),'Legacy box material library');
    await until(()=>star('document.querySelector("#onboarding-shell").hidden'),'Legacy warehouse handoff done');
    assert.equal(quickReceipts.size,2);
    assert.equal(count('create-warehouse'),beforeQuick+1);
    assert.equal(fixture.db.warehouses.find(w=>w.name==='旧盒兼容验收仓').description,'从旧版盒子进入资料库');
    await click('#page-primary');
    await until(()=>star('Boolean(document.querySelector("#import-dialog[open]"))'),'Legacy box opens standard import');
    assert.equal(await star('document.querySelector("#import-note-field").hidden'),true);
    await star('document.querySelector("#import-dialog").close()');
    console.log('STARLINK_PERSONAL_ONBOARDING_PASS');
  } catch (error) {
    console.error(error);
    console.error('Recent fixture actions:', calls.slice(-24).map(entry=>entry.action).join(', '));
    await capture('失败现场.png');
    process.exitCode=1;
  } finally {
    clearTimeout(deadline);
    win.destroy();
    app.exit(process.exitCode||0);
  }
}).catch(error=>{console.error(error);app.exit(1);});
