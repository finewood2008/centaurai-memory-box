import test from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePolling, taskPollDelay } from '../src/polling.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(refresh, delay = () => 1800) {
  const listeners = new Set();
  const scheduled = new Map();
  const errors = [];
  let next = 0;
  const visibility = { hidden: false,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const stop = startVisiblePolling({refresh, delay, onError: e => errors.push(e), visibility,
    timers: {setTimeout: (fn, ms) => { scheduled.set(++next, {fn, ms}); return next; },
      clearTimeout: id => scheduled.delete(id)},
  });
  return {stop, scheduled, errors, listeners,
    hide(hidden) {visibility.hidden = hidden; for (const fn of listeners) fn();},
    fire() { const [id, entry] = scheduled.entries().next().value; scheduled.delete(id); entry.fn(); },
  };
}

test('activity includes queued/running scans; idle and failed tasks use slow polling', () => {
  assert.equal(taskPollDelay(null), 1800);
  assert.equal(taskPollDelay({foreground_count: 1, sensitive_job: null}), 1800);
  for (const status of ['queued', 'running'])
    assert.equal(taskPollDelay({foreground_count: 0, sensitive_job: {status}}), 1800);
  for (const status of ['succeeded', 'failed', 'cancelled'])
    assert.equal(taskPollDelay({foreground_count: 0, sensitive_job: {status}}), 15000);
  assert.equal(taskPollDelay({foreground_count: 0, sensitive_job: null}), 15000);
});

test('hidden pages pause and visible pages immediately resume with the latest interval', async () => {
  let calls = 0;
  let delay = 1800;
  const h = harness(async () => { calls++; }, () => delay);
  await settle();
  assert.equal(calls, 1);
  assert.equal([...h.scheduled.values()][0].ms, 1800);
  h.hide(true);
  assert.equal(h.scheduled.size, 0);
  delay = 15000;
  h.hide(false);
  await settle();
  assert.equal(calls, 2);
  assert.equal([...h.scheduled.values()][0].ms, 15000);
  h.stop();
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('slow requests do not overlap and a visibility change queues only one refresh', async () => {
  let complete;
  let calls = 0;
  const h = harness(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  assert.equal(h.scheduled.size, 0);
  h.hide(true); h.hide(false); h.hide(true); h.hide(false);
  assert.equal(calls, 1);
  complete(); await settle();
  assert.equal(h.scheduled.size, 1);
  assert.equal([...h.scheduled.values()][0].ms, 0);
  h.fire();
  assert.equal(calls, 2);
  h.stop(); complete(); await settle();
  assert.equal(h.scheduled.size, 0);
});

test('failures back off and remain visible; successful recovery restores normal cadence', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('offline'); });
  await settle();
  assert.equal(h.errors[0].message, 'offline');
  assert.equal([...h.scheduled.values()][0].ms, 15000);
  fail = false; h.fire(); await settle();
  assert.equal([...h.scheduled.values()][0].ms, 1800);
  h.stop();
});
