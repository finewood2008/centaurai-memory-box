import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { createQuitRequest, registerShutdown } from '../shell/shutdown.mjs';

function quit(app) {
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  return prevented;
}

test('repeated Host quit waits for application cleanup before accepting exit', async () => {
  const app = new EventEmitter();
  let release, calls = 0, hostClosed = 0, accepted = 0;
  app.quit = () => { if (!quit(app)) accepted++; };
  registerShutdown({ app,
    closeApplications: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    closeHost: async () => { hostClosed++; }, onError: assert.fail,
  });
  assert.equal(quit(app), true);
  await setImmediate();
  assert.equal(quit(app), true);
  assert.equal(calls, 1);
  assert.equal(hostClosed, 0);
  release(); await setImmediate();
  assert.equal(hostClosed, 1);
  assert.equal(accepted, 1);
});

test('failed application cleanup reports failure and allows a quit retry', async () => {
  const app = new EventEmitter(), errors = [];
  let fail = true, accepted = 0, hostClosed = 0;
  app.quit = () => { if (!quit(app)) accepted++; };
  registerShutdown({ app,
    closeApplications: async () => { if (fail) throw new Error('APPLICATION_STOP_FAILED'); },
    closeHost: async () => { hostClosed++; }, onError: e => errors.push(e.message),
  });
  quit(app); await setImmediate();
  assert.deepEqual(errors, ['APPLICATION_STOP_FAILED']);
  assert.equal(accepted, 0); assert.equal(hostClosed, 0);
  fail = false;
  quit(app); await setImmediate();
  assert.equal(accepted, 1); assert.equal(hostClosed, 1);
});

test('tray exit from a hidden Mac window confirms in front before normal cleanup', async () => {
  const app = new EventEmitter(), calls = [];
  let minimized = true, visible = false, resolveDialog, dialogParent, dialogOptions, accepted = 0;
  const control = {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore() { minimized = false; calls.push('restore'); },
    show() { visible = true; calls.push('show'); },
    focus() { calls.push('focus-window'); },
  };
  app.focus = ({ steal }) => { assert.equal(steal, true); calls.push('focus-app'); };
  app.quit = () => { if (!quit(app)) accepted++; };
  registerShutdown({
    app, closeApplications() { calls.push('close-applications'); },
    closeHost() { calls.push('close-host'); }, onError: assert.fail,
  });
  const requestQuit = createQuitRequest({ app, control, platform: 'darwin', onError: assert.fail,
    dialog: {
      showMessageBox(parent, options) {
        calls.push('show-confirmation');
        dialogParent = parent;
        dialogOptions = options;
        return new Promise(resolve => { resolveDialog = resolve; });
      },
    },
  });
  const request = requestQuit();
  assert.equal(requestQuit(), request);
  await setImmediate();
  assert.deepEqual(calls, ['restore', 'show', 'focus-app', 'focus-window', 'show-confirmation']);
  assert.equal(visible, true);
  assert.equal(dialogParent, control);
  assert.equal(dialogOptions.cancelId, 0);
  assert.equal(accepted, 0);
  resolveDialog({ response: 0 });
  await request;
  assert.equal(accepted, 0);

  const retry = requestQuit();
  await setImmediate();
  resolveDialog({ response: 1 });
  await retry;
  await setImmediate();
  assert.equal(accepted, 1);
  assert.deepEqual(calls.slice(-2), ['close-applications', 'close-host']);
});
