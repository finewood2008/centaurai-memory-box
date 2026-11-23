import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {app, BrowserWindow, ipcMain} from 'electron';

const localFile = name => fileURLToPath(new URL('../../build/app/local-ui/' + name, import.meta.url));
const state = {
  phase: 'ready', canLaunchApplications: true,
  account: {phase: 'authenticated', accountId: 'test', clientId: 'team'},
  connection: {deviceId: 'test-box', mode: 'local'}, network: {enabled: false},
  devices: [], applications: [],
};
const requirement = '创意对话助手需要生成可编辑的文案。\n'.repeat(45);
const configured = [], started = [];
const handle = (channel, fn) => ipcMain.handle('wanx-client:' + channel, (_, input) => fn(input));
handle('get-state', () => state);
handle('team', ({operation}) => operation === 'identity' ? {permissions: ['applications.manage']} : []);
handle('market-list', () => ({items: []}));
handle('ownership-list', () => []);
handle('studio-overview', () => ({protocolVersion: 2, projects: [], modelAvailable: true}));
handle('studio-intake-open', () => ({}));
handle('studio-engines-list', () => ({defaultId: 'codex', items: [
  {id: 'codex', name: 'Codex', adapted: true, enabled: true},
]}));
handle('studio-launch-suggest', () => ({requirement}));
handle('studio-launch-sources', () => ({items: [], spaceId: 'personal', folderName: '我的空间', spaceName: '我的空间'}));
handle('studio-launch-configure', input => {
  configured.push(input);
  return {id: 'scroll-test', preparation: {revision: 1}};
});
handle('studio-launch-start', input => { started.push(input); return {id: input.projectId}; });

async function verify() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, useContentSize: true, width: 1085, height: 655,
    webPreferences: {preload: localFile('remote-preload.cjs'), backgroundThrottling: false},
  });
  await win.loadFile(localFile('renderer/index.html'));
  win.webContents.debugger.attach('1.3');
  const js = code => win.webContents.executeJavaScript(code);
  const button = action => 'document.querySelector(\'[data-action="' + action + '"]\')';
  async function until(expression) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await js('Boolean(' + expression + ')')) return;
      await pause(25);
    }
    throw Error('Timed out waiting for ' + expression);
  }
  async function click(action) {
    const element = button(action);
    await until(element + ' && !' + element + '.disabled');
    await js(element + '.click()');
  }

  await until('teamFeatureAccess.snapshot().allowed');
  win.webContents.send('wanx-client:navigate', 'studio-projects');
  async function prepareProduct() {
    await click('studio-workspace');
    await until('document.querySelector("#launch-engine")?.value === "codex"');
    await js(`{ const original = document.querySelector('[data-intake-field="original"]');
      original.value = '做一个创意对话助手';
      original.dispatchEvent(new Event('input', {bubbles: true})); }`);
    await js(`document.querySelector('[data-action="studio-intake-picker"][data-kind="storage"]').click()`);
    await click('studio-intake-storage');
    await click('studio-intake-suggest');
    await until('document.querySelector(".launch-notice") && !' + button('studio-intake-handoff') + '.disabled');
  }

  const target = button('studio-intake-handoff');
  const center = `(() => { const r = ${target}.getBoundingClientRect();
    return {x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2)};
  })()`;
  for (const [width, height] of [[1085, 655], [680, 600]]) {
    win.setContentSize(width, height);
    await prepareProduct();
    await js('window.scrollTo(0, 0)');
    assert.ok((await js(center)).y >= height, 'handoff should initially be below the fold');
    // Wheel over the page margin so an overflowing textarea cannot consume the gesture.
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 16, y: height - 40, deltaX: 0,
      deltaY: await js('document.querySelector(".launch-page").scrollHeight'),
    });
    await until(`(() => { const {x, y} = ${center};
      return ${target}.contains(document.elementFromPoint(x, y)); })()`);
    const point = await js(center);
    for (const type of ['mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({type, ...point, button: 'left', clickCount: 1});
    }
    await until('!document.querySelector(".launch-page")');
    assert.equal(configured.at(-1).requirement, requirement.trim());
    assert.equal(configured.at(-1).storage.spaceId, 'personal');
  }
  assert.deepEqual(started, [{projectId: 'scroll-test'}, {projectId: 'scroll-test'}]);
}

verify().then(() => app.exit(0)).catch(error => {console.error(error); app.exit(1);});
