import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPersonalWorkshop } from '../../builder/integration/personal-client/workshop-service.mjs';

const preloadSource = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
const viewSource = await readFile(new URL('../../builder/integration/personal-client/workshop.js', import.meta.url), 'utf8');

function fixture({ status = 404, body = { detail: 'Not Found' }, failure } = {}) {
  let available = false, calls = 0, mainError;
  const link = {
    context: () => ({}), close() {},
    async request(input) {
      assert.equal(input.path, '/api/_client/workshop/_management/projects');
      calls++;
      if (available) return { status: 200, body: Buffer.from('{"projects":[]}') };
      if (failure) throw new Error(failure);
      return { status, body: Buffer.from(JSON.stringify(body)) };
    },
  };
  const service = createPersonalWorkshop({
    client: {
      snapshot: () => ({ account: { accountId: 'synthetic-owner' }, connection: { deviceId: 'synthetic-box' } }),
      subscribe: () => () => {}, applicationConnection: async () => link,
    },
    applications: {}, assets: 'unused', ipcMain: { handle() {}, removeHandler() {} }, control: { on() {} },
  });
  let api;
  vm.runInNewContext(preloadSource, {
    process: { platform: 'darwin' },
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'wanxClient') api = value; } },
        ipcRenderer: {
          on() {}, removeListener() {},
          async invoke(channel, input) {
            if (channel === 'wanx-client:get-state') return {};
            assert.equal(channel, 'wanx-client:workshop');
            try { return await service.action(input.action, input.input); }
            catch (error) {
              mainError = error;
              // Electron serializes main-process rejections into an Error with
              // a channel prefix and does not preserve custom Error fields.
              throw new Error(`Error invoking remote method '${channel}': Error: ${error.message}`);
            }
          },
        },
      };
    },
  });
  const window = { createStudioProduct: () => ({ sync() {}, reset() {}, pause() {}, render: () => '', mounted() {} }) };
  vm.runInNewContext(viewSource, { window, crypto: globalThis.crypto });
  const view = window.createWanxWorkshop({
    changed() {},
    async request(action, input) {
      const result = await api.action('workshop', { action, input });
      if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
      return result.value;
    },
  });
  return {
    api, view, close: () => service.close(), recover: () => { available = true; },
    calls: () => calls, mainError: () => mainError,
    async open() { view.sync('synthetic-owner-box', true, true); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('Workshop 404 keeps its compatibility code through the real service, preload and renderer request boundary', async t => {
  const f = fixture(); t.after(f.close);
  const result = await f.api.action('workshop', { action: 'list', input: {} });
  assert.equal(f.mainError().code, 'WORKSHOP_UPDATE_REQUIRED');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WORKSHOP_UPDATE_REQUIRED');
  await f.open();
  const html = f.view.render();
  assert.match(html, /当前盒端尚未提供工坊服务，请先更新盒端/);
  assert.doesNotMatch(html, /操作未完成，请检查盒子连接后重试|Error invoking remote method/);
});

test('Workshop preserves a closed session error instead of replacing it with an IPC wrapper', async t => {
  const f = fixture({ status: 403, body: { code: 'HOST_SESSION_EXPIRED' } }); t.after(f.close);
  const result = await f.api.action('workshop', { action: 'list', input: {} });
  assert.equal(result.code, 'HOST_SESSION_EXPIRED');
  await f.open();
  assert.match(f.view.render(), /连接已变化，请重新打开工坊/);
});

for (const failure of [
  'request failed https://fixture.invalid/key?token=synthetic-private-token /private/fixture',
  'WORKSHOP_UPDATE_REQUIRED /private/fixture synthetic-private-token',
]) test('unknown Workshop failure text cannot escape the preload as an error code: ' + failure.split(' ')[0], async t => {
  const f = fixture({ failure }); t.after(f.close);
  const result = await f.api.action('workshop', { action: 'list', input: {} });
  assert.equal(result.code, 'WORKSHOP_REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-token|fixture\.invalid|\/private\/fixture|Error invoking remote method/);
  await f.open();
  assert.doesNotMatch(f.view.render(), /synthetic-private-token|fixture\.invalid|\/private\/fixture/);
});

test('an explicit Workshop retry recovers after the compatibility failure without a passive retry loop', async t => {
  const f = fixture(); t.after(f.close);
  await f.open();
  assert.equal(f.calls(), 1);
  assert.match(f.view.render(), /当前盒端尚未提供工坊服务/);
  for (let i = 0; i < 3; i++) f.view.sync('synthetic-owner-box', true, true);
  assert.equal(f.calls(), 1);
  f.recover(); await f.view.action('workshop-refresh');
  assert.equal(f.calls(), 2);
  assert.doesNotMatch(f.view.render(), /当前盒端尚未提供工坊服务|操作未完成|正在读取…/);
});
