import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTimingRecorder } from '../shell/timings.mjs';
import { createProvisioningHost } from '../shell/provisioning-host.cjs';
import { createSecureChannel, stableJson } from '@nexusaos/local-provisioning-core';
import { createNodeProvisioningCryptoProvider } from '@nexusaos/local-provisioning-core/node';
import { createProvisioningDiagnostics } from '../shell/provisioning-diagnostics.cjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const utf8 = text => new TextEncoder().encode(text);
async function jobReply(crypto, body, { corrupt = false } = {}) {
  const keys = { appToDeviceKey: new Uint8Array(32).fill(1), deviceToAppKey: new Uint8Array(32).fill(2), confirmKey: new Uint8Array(32).fill(3) };
  const channel = createSecureChannel(crypto, { deviceId: 'box-test', pairingSessionId: sessionId, keys });
  const aad = utf8(['NEXUSAOS-PROVISIONING-V2', 'box-test', sessionId, 'device-to-app', messageId, 'job.status.result', '1'].join('\n'));
  const nonce = new Uint8Array(12); nonce.set(utf8('NDEV')); nonce[11] = 1;
  const ciphertext = await crypto.aes256GcmEncrypt(keys.deviceToAppKey, nonce, aad,
    utf8(stableJson({ request_id: messageId, message_type: 'job.status.result', ...body })));
  if (corrupt) ciphertext[0] ^= 1;
  const frame = utf8(stableJson({ schema_version: 2, pairing_session_id: sessionId, request_id: messageId,
    message_type: 'job.status.result', direction: 'device-to-app', counter: '1', ciphertext: Buffer.from(ciphertext).toString('base64') }) + '\n');
  return { channel, keys, open: (match = { requestId: messageId, messageType: 'job.status' }) => channel.openIncoming(frame, match) };
}

test('crypto observer preserves the frozen provider, original bytes, receiver and original errors', async () => {
  const aad = utf8(['NEXUSAOS-PROVISIONING-V2', 'SECRET-box', sessionId, 'device-to-app', messageId, 'job.status.result', '1'].join('\n'));
  for (const clear of [utf8('not json SECRET'), utf8('x'.repeat(2049)), utf8('{"status":"failed","error":{"code":"SECRET"}}')]) {
    const originalArgs = [new Uint8Array(32), new Uint8Array(12), aad, new Uint8Array(16)];
    const provider = Object.freeze({ async aes256GcmDecrypt(...args) { assert.equal(this, provider); assert.deepEqual(args, originalArgs); return clear; } });
    const observed = [];
    const crypto = createProvisioningDiagnostics(value => observed.push(value)).crypto(provider);
    assert.notEqual(crypto, provider);
    assert.equal(await crypto.aes256GcmDecrypt(...originalArgs), clear);
    assert.doesNotMatch(JSON.stringify(observed), /SECRET|11111111|22222222/);
    assert.equal(observed[0].outcome, 'authenticated');
    const throwingObserver = createProvisioningDiagnostics(() => { throw new Error('SECRET'); }).crypto(provider);
    assert.equal(await throwingObserver.aes256GcmDecrypt(...originalArgs), clear);
  }
  const originalError = new Error('SECRET');
  const provider = Object.freeze({ async aes256GcmDecrypt() { throw originalError; } });
  const crypto = createProvisioningDiagnostics(() => { throw new Error('observer failure'); }).crypto(provider);
  await assert.rejects(crypto.aes256GcmDecrypt(null, null, aad, null), error => error === originalError);
});

test('authenticated device errors stay distinct from SDK validation, without changing AEAD/replay guards', async () => {
  for (const code of ['protocol_error', 'auth_failed', 'LOCAL_WIFI_REQUIRED', 'secret_sensitive_code']) {
    const records = [];
    const crypto = createProvisioningDiagnostics(value => records.push(value)).crypto(createNodeProvisioningCryptoProvider());
    const reply = await jobReply(crypto, { status: 'failed', error: { code, retryable: false,
      retry_after_ms: 1000, job_id: 'job_SECRET', device_state: 'failed', state_version: 3 } });
    if (code === 'LOCAL_WIFI_REQUIRED') {
      await assert.rejects(reply.open(), { name: 'ProtocolError' });
      assert.ok(reply.keys.deviceToAppKey.every(byte => byte === 0));
    } else {
      assert.equal((await reply.open()).error.code, code);
      assert.ok(reply.keys.deviceToAppKey.some(Boolean));
      await assert.rejects(reply.open(), { name: 'ProtocolError' });
      assert.ok(reply.keys.deviceToAppKey.every(byte => byte === 0));
    }
    assert.deepEqual(records, [{ kind: 'protocol', outcome: 'authenticated', messageType: 'job.status.result',
      responseStatus: 'failed', deviceErrorCode: code === 'secret_sensitive_code' ? 'UNKNOWN_ERROR' : code }]);
  }
  for (const corruption of ['tag', 'binding', 'payload']) {
    const records = [];
    const crypto = createProvisioningDiagnostics(value => records.push(value)).crypto(createNodeProvisioningCryptoProvider());
    const reply = await jobReply(crypto, { status: 'completed', payload: { operation_status: 'completed',
      job_id: 'job_SECRET', device_state: 'connected', state_version: 3, ...(corruption === 'payload' ? { secret: 'SECRET' } : {}) } },
    { corrupt: corruption === 'tag' });
    await assert.rejects(reply.open(corruption === 'binding' ? { requestId: sessionId, messageType: 'job.status' } : undefined), { name: 'ProtocolError' });
    assert.ok(reply.keys.deviceToAppKey.every(byte => byte === 0));
    assert.doesNotMatch(JSON.stringify(records), /SECRET|secret|job_id/);
    if (corruption === 'binding') assert.deepEqual(records, []);
    else assert.equal(records[0].outcome, corruption === 'tag' ? 'decrypt_failed' : 'authenticated');
  }
});

test('disk projection rejects untrusted protocol and flow labels even when passed directly to the recorder', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-protocol-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'connection.jsonl');
  const recorder = createTimingRecorder({ filePath });
  recorder.provisioning({ kind: 'protocol', outcome: 'authenticated', messageType: 'job.status.result',
    responseStatus: 'failed', deviceErrorCode: 'SECRET', password: 'SECRET', payload: { secret: 'SECRET' } });
  recorder.provisioning({ kind: 'flow', state: 'terminalError', errorCode: 'SECRET', retryable: false, preview: 'SECRET' });
  recorder.provisioning({ kind: 'protocol', outcome: 'authenticated', messageType: 'SECRET' });
  recorder.provisioning({ kind: 'flow', state: 'SECRET', errorCode: 'PROTOCOL_CHANGED' });
  await recorder.flush();
  const text = await readFile(filePath, 'utf8');
  assert.doesNotMatch(text, /SECRET|payload|password|preview/);
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].deviceErrorCode, 'UNKNOWN_ERROR');
  assert.equal(rows[1].errorCode, 'UNKNOWN_ERROR');
});

test('asynchronous diagnostic callback failures cannot escape state or authenticated response observation', async () => {
  const observer = createProvisioningDiagnostics(async () => { throw new Error('SECRET observer failure'); });
  observer.state({ state: 'provisioningWifi' });
  const reply = await jobReply(observer.crypto(createNodeProvisioningCryptoProvider()), {
    status: 'completed', payload: { operation_status: 'completed', job_id: 'job_test', device_state: 'connected', state_version: 3 },
  });
  assert.equal((await reply.open()).payload.device_state, 'connected');
  reply.channel.destroy();
  await new Promise(resolve => setImmediate(resolve));
});

test('Main persists the authenticated job failure before the terminal coordinator error without response secrets', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-job-diagnostic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recorder = createTimingRecorder({ filePath: path.join(dir, 'connection.jsonl') });
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const contents = new EventEmitter(); contents.mainFrame = { url: 'file:///job-test.html' };
  contents.send = (name, input) => {
    if (name === 'wanx:setup:transport') queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result',
      { sender: contents, senderFrame: contents.mainFrame }, { requestId: input.requestId, ok: true }));
  };
  let lateResponse;
  const host = await createProvisioningHost({
    webContents: contents, ipcMain, documentUrl: contents.mainFrame.url,
    onDiagnostic: value => recorder.provisioning(value),
    consumer: { current: async () => ({ accountId: 'SECRET-account', clientId: 'SECRET-client' }), pairingApi: async () => ({}) },
    cryptoFactory: createNodeProvisioningCryptoProvider,
    coordinatorFactory: ({ crypto }) => {
      let state = { state: 'idle' }, notify;
      lateResponse = async () => {
        const reply = await jobReply(crypto, { status: 'failed', error: { code: 'auth_failed', retryable: true,
          retry_after_ms: 1000, job_id: 'job_SECRET', device_state: 'failed', state_version: 3 } });
        try { await reply.open(); notify(); } finally { reply.channel.destroy(); }
      };
      return {
        getSnapshot: () => state, subscribe: fn => { notify = fn; return () => {}; },
        async begin() {
          const reply = await jobReply(crypto, { status: 'failed', error: { code: 'protocol_error', retryable: false,
            retry_after_ms: 1000, job_id: 'job_SECRET', device_state: 'failed', state_version: 3 } });
          try {
            const result = await reply.open();
            assert.equal(result.error.code, 'protocol_error');
            state = { state: 'terminalError', errorCode: 'PROTOCOL_CHANGED', retryable: false, pairingSessionId: sessionId, password: 'SECRET' };
            notify(); notify();
            throw Object.assign(new Error('SECRET'), { code: 'PROTOCOL_CHANGED' });
          } finally { reply.channel.destroy(); }
        },
        suspend: async () => {}, dispose: async () => {},
      };
    },
  });
  t.after(() => host.dispose());
  await assert.rejects(host.begin({ candidateId: 'candidate', transport: 'ble-gatt', transportHandle: 'handle',
    selectionLeaseId: 'lease', advertisedName: 'SECRET-name', rssi: -40, firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1 }),
  { code: 'PROTOCOL_CHANGED' });
  await recorder.flush();
  const text = await readFile(path.join(dir, 'connection.jsonl'), 'utf8');
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.step), ['setup.protocol', 'setup.flow']);
  assert.equal(rows[0].outcome, 'authenticated');
  assert.equal(rows[0].messageType, 'job.status.result');
  assert.equal(rows[0].responseStatus, 'failed');
  assert.equal(rows[0].deviceErrorCode, 'protocol_error');
  assert.equal(rows[1].state, 'terminalError');
  assert.equal(rows[1].errorCode, 'PROTOCOL_CHANGED');
  assert.equal(rows[1].retryable, false);
  assert.doesNotMatch(text, /SECRET|job_id|ciphertext|password|pairingSessionId|11111111|22222222/);
  await host.reset();
  await recorder.flush();
  const afterReset = await readFile(path.join(dir, 'connection.jsonl'), 'utf8');
  await lateResponse();
  await recorder.flush();
  assert.equal(await readFile(path.join(dir, 'connection.jsonl'), 'utf8'), afterReset,
    'responses and coordinator notifications from the previous context cannot pollute the next attempt');
});

test('provisioning diagnostics persist only fixed stages and errors, never credentials or arbitrary labels', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-setup-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'connection.jsonl');
  const recorder = createTimingRecorder({ filePath });
  recorder.provisioning({
    operation: 'connect', outcome: 'failed', durationMs: 123, attempt: 2,
    source: 'renderer', stage: 'service', errorName: 'NetworkError',
    errorCode: 'LOCAL_TRANSPORT_DISCONNECTED',
    requestId: '12345678-1234-4234-8234-123456789abc',
    password: 'SECRET', message: 'SECRET', deviceId: 'SECRET', stack: 'SECRET',
  });
  recorder.provisioning({
    operation: 'request', outcome: 'failed', durationMs: 35000,
    source: 'deadline', messageType: 'pairing.token.result',
    errorCode: 'GATT_FRAGMENT_INCOMPLETE', token: 'SECRET', frame: 'SECRET',
  });
  recorder.provisioning({
    operation: 'readDeviceInfo', outcome: 'failed', durationMs: -1,
    source: 'SECRET', stage: 'SECRET', errorName: 'SECRET', errorCode: 'SECRET',
    requestId: 'SECRET', attempt: 'SECRET', messageType: 'SECRET',
  });
  recorder.provisioning({ operation: 'SECRET', outcome: 'failed' });
  await recorder.flush();
  const contents = await readFile(filePath, 'utf8');
  assert.doesNotMatch(contents, /SECRET|password|token":|frame":|deviceId|stack|message":/);
  const rows = contents.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].step, 'setup.transport');
  assert.equal(rows[0].stage, 'service');
  assert.equal(rows[0].errorName, 'NetworkError');
  assert.equal(rows[0].attempt, 2);
  assert.equal(rows[1].messageType, 'pairing.token.result');
  assert.equal(rows[1].source, 'deadline');
  assert.equal(rows[2].errorCode, 'UNKNOWN_ERROR');
  assert.equal(Object.hasOwn(rows[2], 'durationMs'), false);
});

test('Main records both failed connection attempts with renderer stage and bounded elapsed time', async t => {
  const ipcMain = new EventEmitter(), contents = new EventEmitter(), records = [];
  ipcMain.handle = () => {};
  ipcMain.removeHandler = () => {};
  contents.mainFrame = { url: 'file:///diagnostic-test.html' };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  contents.send = (channel, input) => {
    if (channel !== 'wanx:setup:transport') return;
    queueMicrotask(() => ipcMain.emit('wanx:setup:transport-result', event, {
      requestId: input.requestId, ok: input.operation !== 'connect',
      code: 'LOCAL_TRANSPORT_DISCONNECTED',
      diagnostic: { stage: 'service', errorName: 'NetworkError', message: 'SECRET' },
    }));
  };
  let ticks = 0;
  const host = await createProvisioningHost({
    webContents: contents, ipcMain, documentUrl: contents.mainFrame.url,
    onDiagnostic: record => records.push(record),
    clock: { monotonicMs: () => ++ticks, nowUtc: () => new Date().toISOString() },
    consumer: {
      current: async () => ({ accountId: 'SECRET-account', clientId: 'SECRET-client' }),
      pairingApi: async () => ({}),
    },
    cryptoFactory: () => ({}),
    coordinatorFactory: ({ transportFactory }) => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ state: 'idle' }),
      begin: async (input, signal) => { await transportFactory.connect(input.selected, signal); },
      suspend: async () => {}, dispose: async () => {},
    }),
  });
  t.after(() => host.dispose());
  await assert.rejects(host.begin({
    candidateId: 'candidate', transport: 'ble-gatt', transportHandle: 'handle',
    selectionLeaseId: 'lease', advertisedName: 'SECRET-name', rssi: -40,
    firstSeenMonotonicMs: 0, lastSeenMonotonicMs: 1,
  }), { code: 'LOCAL_TRANSPORT_DISCONNECTED' });
  const failures = records.filter(record => record.operation === 'connect');
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map(record => record.attempt), [1, 2]);
  for (const record of failures) {
    assert.equal(record.source, 'renderer');
    assert.equal(record.stage, 'service');
    assert.equal(record.errorName, 'NetworkError');
    assert.ok(record.durationMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
});
