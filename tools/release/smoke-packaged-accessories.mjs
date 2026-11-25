import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function smokePackagedAccessories({ executable, resources, temporary }) {
  const profile = await mkdtemp(path.join(temporary, 'memobox-accessories-smoke-'));
  const worker = path.join(resources, 'accessory-preview', 'server.mjs');
  const viewKey = randomUUID();
  const child = spawn(executable, [worker], {
    cwd: path.dirname(worker),
    env: {
      SystemRoot: process.env.SystemRoot,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      RECORDING_MODULE_PROFILE: 'accessories',
      RECORDING_ACCESSORY_DATA: profile,
      RECORDING_VIEW_KEY: viewKey,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stdout = '', stderr = '', launchError;
  let closed = false;
  const done = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  child.once('error', error => { launchError = error; });
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4096); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  try {
    const ready = /http:\/\/127\.0\.0\.1:\d{1,5}\/accessories(?=\r?\n)/;
    const deadline = Date.now() + 15000;
    while (!ready.test(stdout) && !closed && !launchError && Date.now() < deadline) await delay(100);
    if (launchError) throw launchError;
    const url = ready.exec(stdout)?.[0];
    if (!url) throw new Error('PACKAGED_ACCESSORIES_START_FAILED: ' + stderr.trim());

    const request = async (route, status, init = {}) => {
      const response = await fetch(new URL(route, url), {
        ...init,
        headers: { 'x-recording-view': viewKey, ...init.headers },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, status, route + ': ' + (response.ok ? '' : await response.text()));
      return response;
    };
    const post = (route, status, value) => request(route, status, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const health = await (await request('/api/health', 200)).json();
    assert.equal(health.ok, true);
    assert.equal(health.desktop, true);
    assert.equal(health.profile, 'accessories');
    await (await request('/accessories/disk', 200)).text();
    assert.match(await (await request('/accessories/storage', 200)).text(), /外接存储/);

    const { id } = await (await post('/api/meetings', 201, { title: 'Release smoke recording', source: 'disk' })).json();
    const saved = await (await request(`/api/meetings/${id}/chunks?seq=0`, 201, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(3200),
    })).json();
    assert.equal(saved.durationMs, 100);
    await (await post(`/api/meetings/${id}/finish`, 202, { chunkCount: 1 })).json();
    let recording;
    const audioDeadline = Date.now() + 10000;
    do {
      recording = await (await request(`/api/meetings/${id}`, 200)).json();
      if (recording.audio?.status === 'saved') break;
      await delay(100);
    } while (Date.now() < audioDeadline);
    assert.equal(recording.audio?.status, 'saved');
    const wav = Buffer.from(await (await request(`/api/meetings/${id}/audio`, 200)).arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.length, 3244);
    return { ok: true, recordingDurationMs: saved.durationMs, wavBytes: wav.length };
  } finally {
    if (!closed) child.kill();
    await done;
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
