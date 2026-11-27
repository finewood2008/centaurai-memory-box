import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMedia, media } from '../resources/accessory-preview/lib/media.mjs';
import * as meetings from '../resources/accessory-preview/lib/meetings.mjs';

const local = 'audio.transcribe.streaming';
const cloud = local + '.cloud';
const frame = Buffer.alloc(3200);

function box(capabilities, receipt = {}) {
  const requests = [];
  const events = [];
  let sockets = 0;
  const client = createMedia({
    context: async () => ({ connection: 'ready' }),
    request: async (route, { body }) => {
      if (route.endsWith('/capabilities')) return Response.json({ processingLocation: 'box',
        capabilities: capabilities.map(id => ({ id, configured: true, maxFrameBytes: 6400 })) });
      assert.ok(route.endsWith('/asr/sessions'));
      requests.push(body);
      return Response.json({ ticket: 'ticket', streamPath: '/api/services/wanx.media/v1/asr/sessions/id/stream',
        audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }, ...receipt });
    },
    openStream: async () => {
      sockets++;
      const socket = new EventEmitter();
      socket.protocol = 'wanx.asr.v1'; socket.readyState = 1;
      const emit = event => socket.emit('message', JSON.stringify(event), false);
      setImmediate(() => emit({ type: 'ready' }));
      socket.close = socket.terminate = () => socket.emit('close');
      socket.send = (value, _, cb) => {
        if (typeof value === 'string') {
          assert.equal(JSON.parse(value).type, 'end');
          setImmediate(() => {
            emit({ type: 'final', segmentId: 1, text: '完整句子' });
            emit({ type: 'end' });
          });
        } else emit({ type: 'partial', segmentId: 1, text: '句' });
        cb();
      };
      return socket;
    },
  }, null, 'demo');
  return { client, events, requests, sockets: () => sockets };
}

test('cloud captions verify capability and lease before sending audio, local sessions keep their wire format', async () => {
  const legacy = box([local]);
  await assert.rejects(legacy.client.openLive(() => {}, () => {}, true));
  assert.equal(legacy.requests.length, 0);
  const localSession = await legacy.client.openLive(() => {}, () => {});
  assert.deepEqual(legacy.requests, [undefined]);
  await localSession.end();
  const stale = box([cloud]);
  await assert.rejects(stale.client.openLive(() => {}, () => {}, true), /云端字幕会话无效/);
  assert.equal(stale.sockets(), 0);

  const crossed = box([local], { processingLocation: 'cloud', capability: cloud });
  await assert.rejects(crossed.client.openLive(() => {}, () => {}), /本地字幕会话无效/);
  assert.equal(crossed.sockets(), 0);

  const active = box([cloud], { processingLocation: 'cloud', capability: cloud });
  assert.equal((await active.client.status()).cloudLive, true);
  const stream = await active.client.openLive(event => active.events.push(event), () => {}, true);
  assert.deepEqual(active.requests, [{ capability: cloud, cloudConsent: true }]);
  assert.equal(stream.send(frame), true);
  await stream.end();
  assert.deepEqual(active.events.map(e => [e.type, e.segmentId]), [['partial', 1], ['final', 1]]);
});

test('cloud caption consent is per recording, survives resume and preserves the last final on end', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wanx-live-choice-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await meetings.initStore(dir);
  let scope = 'box-102';
  t.mock.method(media, 'scope', async () => scope);
  const seen = [];
  t.mock.method(media, 'openLive', async (emit, _closed, cloudConsent) => {
    seen.push(cloudConsent);
    return {
      send() { emit({ type: 'partial', segmentId: 1, text: '原句' }); return true; },
      async end() { await delay(5); emit({ type: 'final', segmentId: 1, text: '定稿' }); },
    };
  });
  const opts = { source: 'disk', liveCaptionMode: 'cloud', liveCloudConsent: true };
  await assert.rejects(meetings.createMeeting({ ...opts, liveCloudConsent: undefined }), { status: 400 });
  await assert.rejects(meetings.createMeeting({ ...opts, source: 'clip' }), { status: 400 });
  const { id } = await meetings.createMeeting(opts);
  await meetings.initStore(dir);
  assert.equal(meetings.view(id).liveCaptionMode, 'cloud');
  scope = 'other';
  await assert.rejects(meetings.pushLiveFrame(id, frame, 2000), {status: 409});
  assert.deepEqual(seen, []);
  scope = 'box-102';
  await meetings.saveChunk(id, 0, frame);
  await meetings.pushLiveFrame(id, frame, 2000);
  assert.equal(meetings.view(id).draft[0].final, false);
  const finished = await meetings.finishMeeting(id, { audioOnly: true });
  assert.deepEqual(finished.draft.map(line => [line.text, line.final]), [['定稿', true]]);
  while (meetings.view(id).pipelineRunning) await delay(10);
  const ordinary = await meetings.createMeeting({ source: 'disk' });
  await meetings.saveChunk(ordinary.id, 0, frame);
  await meetings.pushLiveFrame(ordinary.id, frame, 2000);
  assert.deepEqual(seen, [true, false]);
  await meetings.finishMeeting(ordinary.id, { audioOnly: true });
  while (meetings.view(ordinary.id).pipelineRunning) await delay(10);
});

test('cloud outage keeps recording and the chosen cloud mode without switching to local captions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wanx-live-outage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await meetings.initStore(dir);
  t.mock.method(media, 'scope', async () => 'box-102');
  const seen = [];
  t.mock.method(media, 'openLive', async (_emit, _closed, cloudConsent) => {
    seen.push(cloudConsent); throw Error('offline');
  });
  const { id } = await meetings.createMeeting({ source: 'disk', liveCaptionMode: 'cloud', liveCloudConsent: true });
  assert.equal((await meetings.pushLiveFrame(id, frame)).status, 'offline');
  assert.equal((await meetings.saveChunk(id, 0, frame)).saved, true);
  await meetings.finishMeeting(id, { audioOnly: true });
  while (meetings.view(id).pipelineRunning) await delay(10);
  assert.deepEqual(seen, [true]);
  assert.equal(meetings.view(id).audio.status, 'saved');
});
