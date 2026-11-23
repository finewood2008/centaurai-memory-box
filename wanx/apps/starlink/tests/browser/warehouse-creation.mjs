import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { WAREHOUSE_ONTOLOGY_PROFILES, getWarehouseOntologyProfile } from '../../shared/warehouse-ontology-profiles.mjs';

// Exercise the assembled personal renderer, preload and Starlink iframe with a synthetic box.
const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(process.env.WANX_STARLINK_TEST_RUNTIME || join(here, '../../../personal-client/build/app'));
const output = process.env.WANX_STARLINK_TEST_OUTPUT;
app.setPath('userData', mkdtempSync(join(tmpdir(), 'starlink-warehouse-browser-')));

const identity = {accountId:'creation-fixture', boxId:'creation-box', dataScope:'personal', user:{id:1, name:'验收用户'}};
const scope = {
  phase:'ready', canLaunchApplications:true, activeDeviceId:identity.boxId,
  account:{phase:'authenticated', accountId:identity.accountId, clientId:'creation-client'},
  connection:{deviceId:identity.boxId, mode:'local', gatewayURL:'http://127.0.0.1'},
  devices:[{deviceId:identity.boxId, displayName:'测试盒子', accessState:'ready'}],
  network:{enabled:false, phase:'disabled'}, platform:{phase:'idle'}, applications:[],
};
const oldSchema = {
  entity_types:[{name:'PERSON', label:'人物', properties:[]}],
  relation_types:[],
};
const sharedModel = {id:'shared-model', name:'底座默认测试模型', revision:'shared-v1', available:true, provider:'本地测试', location:'local', route:'wanx'};
const calls = [];
const receipts = new Map();
const warehouses = new Map();
const versions = new Map();
const lostCreates = new Set();
const lostDrafts = new Set();
const lostPublications = new Set();
const empty = () => ({items:[], total:0, has_more:false});
const ok = value => ({ok:true, value:structuredClone(value)});
const lost = () => ({ok:false, code:'SEMANTICA_CONNECTION_FAILED', status:503});
const ipc = (name, handler) => ipcMain.handle('wanx-client:' + name, handler);

ipc('get-state', () => scope);
ipc('space-links-spaces', () => [{id:'personal', name:'个人空间', root:'', connections:[]}]);
ipc('space-links-mcp-state', () => ({connections:[]}));
ipc('space-list', () => ({space_id:'personal', root:'', parent:'', breadcrumbs:[], items:[]}));
ipcMain.handle('wanx:discovery:bluetooth-state', () => ({}));
for (const name of ['wallet-orders', 'wallet-catalog', 'wallet-balance'])
  ipc(name, () => ({ok:false, error:{code:'CREDITS_NOT_CONFIGURED'}}));
for (const name of ['market-list', 'workshop', 'expert-apps', 'credits-transactions']) ipc(name, empty);
for (const name of ['credits-balance', 'clipboard-snapshot', 'memory-open', 'space-refresh']) ipc(name, () => ({}));

ipc('starlink', async (_event, {action, input = {}}) => {
  calls.push({action, input:structuredClone(input)});
  const warehouse = warehouses.get(input.warehouseId);
  const projectVersions = versions.get(input.warehouseId);
  if (action === 'initialize') return ok({
    identity, warehouses:{items:[...warehouses.values()]}, runtime:{},
    capabilities:{accepted_suffixes:['txt'], document_max_bytes:10000000},
  });
  if (action === 'launch-target') return ok(null);
  if (action === 'warehouses') return ok({items:[...warehouses.values()]});
  if (action === 'warehouse') return ok(warehouses.get(input.id ?? input.warehouseId));
  if (action === 'graph') return ok({nodes:[], edges:[]});
  if (action === 'conversation-ontologies') return ok({items:projectVersions || []});
  if (action === 'processing') return ok({revision:0, affected_warehouses:[...warehouses.values()].map(item => item.name), stages:[],
    effective:{revision:0, mode:'automatic', source:'default', extraction:sharedModel, sensitive:sharedModel}});
  if (action === 'model-catalog') return ok({items:[sharedModel], default:sharedModel});
  if (action === 'starxiaotu-models') return ok({models:[], defaultModel:null, selectedRef:null});
  if (action === 'create-warehouse') {
    assert.match(input.operationId, /^[a-f0-9-]{36}$/);
    let created = receipts.get(input.operationId);
    if (!created) {
      const id = 'created-' + (warehouses.size + 1);
      const base = {id:id + '-base', name:'原盒端默认本体', schema:oldSchema, version_number:1, status:'published'};
      created = {id, name:input.name, description:input.description, current_ontology:{id:base.id}, state:'active',
        created_at:'2026-11-23T00:00:00Z', document_count:0, entity_count:0, relation_count:0};
      receipts.set(input.operationId, created);
      warehouses.set(id, created);
      versions.set(id, [base]);
    }
    if (lostCreates.delete(input.name)) return lost();
    return ok(created);
  }
  if (action === 'workbench-request' && /^\/api\/ontologies(?:[/?]|$)/.test(input.url)) {
    assert.ok(warehouse && projectVersions, 'Ontology request targets the newly created project');
    const path = new URL(input.url, 'http://fixture.invalid').pathname;
    if (input.method === 'GET') return ok({items:projectVersions});
    assert.equal(input.method, 'POST');
    const body = JSON.parse(input.body);
    if (path === '/api/ontologies') {
      assert.match(input.operationId, /^[a-f0-9-]{36}-rules$/);
      let draft = projectVersions.find(row => row.operationId === input.operationId);
      if (!draft) {
        draft = {id:warehouse.id + '-draft', name:body.name, schema:body.schema, version_number:2,
          status:'draft', operationId:input.operationId};
        projectVersions.push(draft);
      }
      if (lostDrafts.delete(warehouse.name)) return lost();
      return ok(draft);
    }
    assert.match(input.operationId, /^[a-f0-9-]{36}-publish$/);
    const draft = projectVersions.find(row => row.status === 'draft');
    assert.ok(draft);
    assert.equal(path, '/api/ontologies/' + draft.id + '/publish');
    projectVersions.find(row => row.status === 'published').status = 'superseded';
    draft.status = 'published';
    if (lostPublications.delete(warehouse.name)) return lost();
    return ok(draft);
  }
  return ok(empty());
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false, width:1280, height:900,
    webPreferences:{preload:join(runtime, 'local-ui/remote-preload.cjs'), sandbox:true, contextIsolation:true, backgroundThrottling:false}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, callback) => callback({cancel:true}));
  const appFrame = () => window.webContents.mainFrame.frames.find(frame => frame.url.endsWith('/starlink/ui/index.html'));
  const star = code => appFrame()?.executeJavaScript(code);
  const runClick = (selector, run = star) => run(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control || control.disabled) throw Error(${JSON.stringify(selector)});
    control.click();
  })()`);
  const read = (selector, expression) => star(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return (${expression});
  })()`);
  const deadline = setTimeout(() => { console.error('STARLINK_WAREHOUSE_CREATION_TIMEOUT'); app.exit(1); }, 60000);
  async function until(predicate, description) {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await predicate()) return;
      await pause(35);
    }
    throw new Error(description);
  }
  function fillName(name) {
    return star(`(() => {
      const field = document.querySelector('#warehouse-creation-name');
      field.value = ${JSON.stringify(name)};
      field.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
  }
  async function open() {
    await runClick('#starlink-directory-entry');
    await until(() => read('#view-warehouses', 'node && !node.hidden'), 'Project directory did not open');
    await runClick('.warehouse-directory-tools [data-action=new-warehouse]');
    await until(() => read('#warehouse-creation-name', `(() => {
      if (!node?.closest('dialog').open) return false;
      const {left, top, width, height} = node.getBoundingClientRect();
      return width > 0 && height > 0 && document.elementFromPoint(left + width / 2, top + height / 2) === node;
    })()`), 'New project form did not become visible and interactive');
  }
  async function retry(name) {
    await until(() => read('#warehouse-creation-error', 'node && !node.hidden && Boolean(node.textContent.trim())'), 'Lost response did not show recovery');
    assert.equal(await read('#warehouse-creation-name', 'node.value'), name);
    assert.equal(await read('#warehouse-creation-name', 'node.readOnly'), true);
    assert.equal(await read('#warehouse-profile-change', 'node.disabled'), true);
    await runClick('#warehouse-creation-submit');
  }
  async function capture(name) {
    if (!output) return;
    await mkdir(output, {recursive:true});
    await pause(120);
    await writeFile(join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
  }

  try {
    await window.loadFile(join(runtime, 'local-ui/renderer/index.html'));
    await runClick('[data-action=show-data]', code => window.webContents.executeJavaScript(code));
    await until(() => read('#starlink-directory-entry', 'node && !node.disabled'), 'Starlink entry did not become ready');
    await runClick('.starlink-rail [data-view=models]');
    await until(() => read('#model-stages', 'node.textContent.includes("底座默认测试模型")'), 'Shared settings must work without a project');
    assert.equal(await read('#model-source', '!node.hidden && node.textContent.includes("跟随万象底座默认模型")'), true);
    assert.ok(calls.filter(({action}) => ['processing','model-catalog','starxiaotu-models'].includes(action)).every(({input}) => input.warehouseId === null));

    for (const {id, label} of WAREHOUSE_ONTOLOGY_PROFILES) {
      const projectName = '验收星图 · ' + label;
      const firstCall = calls.length;
      await open();
      assert.equal(await read('#warehouse-creation', '[...node.querySelectorAll("input:not([type=radio])")].map(field => field.id).join()'), 'warehouse-creation-name');
      assert.equal(await read('#warehouse-creation-name', 'node.required && node.value === ""'), true);
      assert.equal(await read('#warehouse-creation-submit', 'node.disabled'), true);
      assert.equal(await read('#warehouse-profile-options', 'node.hidden'), true);
      assert.equal(await read('#warehouse-creation-profile', 'node.textContent'), '通用知识');
      assert.equal(await read('#warehouse-profile-change', 'node.getAttribute("aria-expanded")'), 'false');
      assert.equal(await star('Boolean(document.querySelector("#onboarding-shell:not([hidden]),#od-templates,#od-answer-form"))'), false);
      if (id === 'general') await capture('01-默认新建星图');
      else {
        await runClick('#warehouse-profile-change');
        assert.equal(await read('#warehouse-profile-options', '!node.hidden'), true);
        assert.deepEqual(await read('#warehouse-profile-options', '[...node.querySelectorAll("input[type=radio]")].map(input => input.value)'),
          WAREHOUSE_ONTOLOGY_PROFILES.map(profile => profile.id));
        assert.equal(await read('#warehouse-profile-options :checked', 'node.value'), 'general');
        await runClick('#warehouse-profile-options input[value=' + id + ']');
        assert.equal(await read('#warehouse-creation-profile', 'node.textContent'), label);
        if (id === 'projects') await capture('02-更换本体');
      }
      assert.equal(calls.slice(firstCall).some(({action}) => action === 'create-warehouse'), false, 'Selecting a profile is side effect free');
      await fillName(projectName);
      if (id === 'projects') lostCreates.add(projectName);
      if (id === 'research') lostDrafts.add(projectName);
      if (id === 'operations') lostPublications.add(projectName);
      await runClick('#warehouse-creation-submit');
      if (id !== 'general') await retry(projectName);
      await until(() => read('#view-conversation', 'node && !node.hidden'), 'Successful creation did not enter the library');
      await until(() => read('#page-primary[data-action=import]', 'node && !node.disabled && !node.hidden'), 'Import is unavailable in the new library');
      await until(() => read('#import-model-summary', 'node.textContent.includes("底座默认测试模型")'), 'Import must use the platform model without a saved profile');
      assert.equal(await read('#warehouse-creation', '!node.open'), true);
      assert.equal(await read('#starlink-current-name', 'node.textContent.trim()'), projectName);
      assert.equal(await read('#view-conversation', 'node.querySelectorAll("#cv-message,.conversation-composer,[data-cv=library-start],[data-cv=material-dialogue]").length'), 0);
      assert.equal(await star('Boolean(document.querySelector("[data-sx-toggle]:not([hidden])"))'), true);

      const requestLog = calls.slice(firstCall);
      assert.equal(requestLog.some(({action}) => ['check-models', 'save-models'].includes(action)), false, 'New projects must use the platform model without writing a preference');
      const requests = requestLog.filter(({action}) => action === 'create-warehouse');
      assert.equal(requests.length, id === 'projects' ? 2 : 1);
      assert.ok(requests.every(({input}) => input.name === projectName && input.description === '' && !input.warehouseScope));
      const op = requests[0].input.operationId;
      assert.ok(requests.every(({input}) => input.operationId === op), 'Creating after response loss resumes the original operation');
      const created = receipts.get(op);
      const setup = requestLog.filter(({action, input}) => action === 'workbench-request' && /^\/api\/ontologies(?:[/?]|$)/.test(input.url));
      assert.ok(setup.every(({input}) => input.warehouseId === created.id), 'Ontology installation stays in the new project');
      assert.equal(setup[0].input.method, 'GET');
      const drafts = setup.filter(({input}) => input.method === 'POST' && input.url === '/api/ontologies');
      assert.equal(drafts.length, id === 'research' ? 2 : 1);
      const expected = getWarehouseOntologyProfile(id).schema;
      assert.ok(drafts.every(({input}) => input.operationId === op + '-rules'));
      for (const {input} of drafts) assert.deepEqual(JSON.parse(input.body).schema, expected);
      const publishes = setup.filter(({input}) => input.method === 'POST' && input.url.endsWith('/publish'));
      assert.equal(publishes.length, 1, 'Publication is verified without repeating a completed write');
      assert.equal(publishes[0].input.operationId, op + '-publish');
      const saved = versions.get(created.id);
      assert.equal(saved.length, 2);
      const published = saved.filter(row => row.status === 'published');
      assert.equal(published.length, 1);
      assert.deepEqual(published[0].schema, expected);
      assert.equal(requestLog.some(({action, input}) => action.startsWith('onboarding-') || action.startsWith('conversation-onboarding-') ||
        ['conversation-create','conversation-send','assistant-intent','starxiaotu-answer'].includes(action) ||
        (action === 'workbench-request' && input.method === 'POST' && input.url.startsWith('/api/conversations'))), false);
      if (id === 'general') await capture('03-直接进入资料库');
    }
    assert.equal(warehouses.size, 4);
    await runClick('#page-primary[data-action=import]');
    await until(() => read('#import-dialog', 'node?.open'), 'Import did not open in the new library');
    console.log('STARLINK_WAREHOUSE_CREATION_PASS');
  } catch (error) {
    console.error(error);
    console.error('Recent fixture actions:', calls.slice(-30).map(({action, input}) => [action, input.method, input.url].filter(Boolean).join(' ')).join(', '));
    await capture('失败现场');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window.destroy();
    app.exit(process.exitCode || 0);
  }
}).catch(error => { console.error(error); app.exit(1); });
