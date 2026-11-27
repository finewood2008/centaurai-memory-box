import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AUDIO_IMPORT_CHUNK_BYTES as CHUNK, createAudioImports } from '../resources/accessory-preview/lib/audio-imports.mjs';
import { wavHeader } from '../resources/accessory-preview/lib/wav.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest();
function uploadMetadata(bytes, fields = {}) {
  const digests = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) digests.push(digest(bytes.subarray(offset, offset + CHUNK)));
  return { name: '大会议录音.wav', size: bytes.length, lastModified: 123, fingerprint: digest(Buffer.concat(digests)).toString('hex'), ...fields };
}

async function storage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-upload-test-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

test('resumes from the committed offset, repairs an interrupted append, and finalizes the exact bytes once', async t => {
  const root = await storage(t);
  const full = Buffer.alloc(CHUNK + 23, 0x1a);
  const metadata = uploadMetadata(full, { templateId: 'default', templateRevision: 1 });
  const imported = new Map();
  const expected = { id: 'm-20261126-120000-123abc' };
  let imports = 0;
  const input = {
    findImportedAudio: id => imported.get(id),
    view: id => { assert.equal(id, expected.id); return expected; },
    async importAudio(file, name, options) {
      imports++;
      assert.equal(name, metadata.name);
      assert.equal(options.inputSha256, digest(full).toString('hex'));
      assert.equal(options.templateId, 'default');
      assert.equal(options.templateRevision, 1);
      assert.deepEqual(await fs.readFile(file), full);
      imported.set(options.importId, expected);
      return expected;
    },
  };
  let store = await createAudioImports(root, input);
  const started = await store.begin(metadata);
  const { id } = started;
  assert.deepEqual(started, { id, offset: 0, chunkBytes: CHUNK });
  await assert.rejects(store.append(id, 0, Buffer.alloc(1)), error => error.status === 400 && error.extra.expectedOffset === 0);
  const outcomes = await Promise.allSettled([0, 0].map(offset => store.append(id, offset, full.subarray(0, CHUNK))));
  assert.equal(outcomes[0].value.offset, CHUNK);
  assert.equal(outcomes[1].reason.status, 409);
  const staged = path.join(root, 'audio-imports', id + '.wav');
  await fs.appendFile(staged, 'uncommitted after crash');
  store = await createAudioImports(root, input);
  assert.deepEqual(await store.begin(metadata), { id, offset: CHUNK, chunkBytes: CHUNK });
  assert.equal((await fs.stat(staged)).size, CHUNK);
  await assert.rejects(store.complete(id), error => error.status === 409 && error.extra.expectedOffset === CHUNK);
  assert.equal((await store.append(id, CHUNK, full.subarray(CHUNK))).offset, full.length);
  assert.deepEqual(await store.complete(id), expected);
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  store = await createAudioImports(root, input);
  assert.equal((await store.begin(metadata)).offset, full.length);
  assert.deepEqual(await store.complete(id), expected);
  assert.equal(imports, 1);
});

test('checks whole-file content, can recover from mismatched bytes, and caps declared size before allocating disk', async t => {
  const root = await storage(t);
  const correct = Buffer.alloc(1024, 32);
  const wrong = Buffer.from(correct);
  wrong[512] = 0;
  let calls = 0;
  const store = await createAudioImports(root, {
    findImportedAudio: () => null,
    importAudio: () => { calls++; return { id: 'm-20261126-120000-123abc' }; },
  });
  const metadata = uploadMetadata(correct);
  const { id } = await store.begin(metadata);
  await store.append(id, 0, wrong);
  await assert.rejects(store.complete(id), error => error.status === 409 && error.extra.expectedOffset === 0);
  assert.equal(calls, 0);
  assert.equal((await store.begin(metadata)).offset, 0);
  await store.append(id, 0, correct);
  await store.complete(id);
  assert.equal(calls, 1);
  const maximum = 16 * 1024 ** 3;
  const accepted = await store.begin({ ...metadata, size: maximum });
  assert.equal((await fs.stat(path.join(root, 'audio-imports', accepted.id + '.wav'))).size, 0);
  await assert.rejects(store.begin({ ...metadata, size: maximum + 1 }), { status: 413 });
});

test('recovers a meeting already adopted before the final upload receipt', async t => {
  const root = await storage(t);
  const body = Buffer.alloc(64);
  const known = { id: 'm-20261126-120000-123abc' };
  let adopted = false;
  const store = await createAudioImports(root, {
    findImportedAudio: () => adopted ? known : null,
    view: () => known,
    importAudio: () => { adopted = true; throw new Error('模拟归档完成后中断'); },
  });
  const { id } = await store.begin(uploadMetadata(body));
  await store.append(id, 0, body);
  await assert.rejects(store.complete(id), /模拟归档完成后中断/);
  assert.deepEqual(await store.complete(id), known);
  assert.deepEqual(await store.complete(id), known);
});

const serverEntry = fileURLToPath(new URL('../resources/accessory-preview/server.mjs', import.meta.url));

async function runServer(root) {
  const viewKey = 'recording-upload-guard-test';
  const child = spawn(process.execPath, [serverEntry], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HOST: '127.0.0.1', PORT: '0', RECORDING_MODULE_DATA: root, RECORDING_MODULE_PROFILE: 'recording',
    RECORDING_VIEW_KEY: viewKey, WANX_HOST_TRANSPORT: '', MEMOBOX_MEDIA_INSTANCE: '', RECORDING_LEGACY_DATA: '',
  } });
  const origin = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('本地录音服务启动超时')); }, 5000);
    child.stdout.on('data', data => {
      output += data;
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0].slice(0, -1)); }
    });
    child.stderr.on('data', data => { errors = (errors + data).slice(-350); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('本地录音服务退出 ' + code + ' ' + errors)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return {
    fetch(relative, { headers, ...options } = {}) {
      return fetch(origin + relative, { ...options, headers: { 'x-recording-view': viewKey, ...headers } });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    },
  };
}

test('HTTP import requires the view key and resumes after the recording server restarts', async t => {
  if (spawnSync(process.env.FFPROBE_BIN || 'ffprobe', ['-version']).error?.code === 'ENOENT') {
    t.skip('本机未安装音频探测工具');
    return;
  }
  let server;
  t.after(() => server?.close());
  const root = await storage(t);
  server = await runServer(root);
  const pcm = Buffer.alloc(CHUNK);
  const body = Buffer.concat([wavHeader(pcm.length, 16000, 1), pcm]);
  const metadata = uploadMetadata(body);
  const start = (override = {}) => server.fetch('/api/audio-imports', { method: 'POST', body: JSON.stringify(metadata),
    headers: { 'Content-Type': 'application/json', ...override } });
  assert.equal((await start({ 'x-recording-view': 'different-key' })).status, 403);
  let response = await start();
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const put = (offset, data) => server.fetch('/api/audio-imports/' + id + '?offset=' + offset, { method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  assert.equal((await (await put(0, body.subarray(0, CHUNK))).json()).offset, CHUNK);
  await server.close();
  server = await runServer(root);
  assert.equal((await (await start()).json()).offset, CHUNK);
  assert.equal((await (await put(CHUNK, body.subarray(CHUNK))).json()).offset, body.length);
  response = await server.fetch('/api/audio-imports/' + id + '/complete', { method: 'POST' });
  assert.equal(response.status, 202);
  const meeting = await response.json();
  response = await server.fetch('/api/meetings/' + meeting.id + '/audio', { headers: { Range: 'bytes=0-7' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(0, 8));
  response = await server.fetch('/api/audio-imports/' + id + '/complete', { method: 'POST' });
  assert.equal((await response.json()).id, meeting.id);
});
