import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as Meetings from '../resources/accessory-preview/lib/meetings.mjs';
import { putSettings } from '../resources/accessory-preview/lib/library.mjs';
import { createMedia, fileDigest, media, CLOUD_ASR } from '../resources/accessory-preview/lib/media.mjs';

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wanx-transcription-mode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function settle(id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const meeting = Meetings.view(id);
    if (!meeting.pipelineRunning) return meeting;
    await delay(10);
  }
  assert.fail('meeting pipeline did not settle');
}

test('local and cloud submit distinct jobs, and old boxes reject cloud before uploading', async t => {
  const file = path.join(await scratch(t), 'audio.wav');
  await fs.writeFile(file, Buffer.alloc(44));
  const hash = await fileDigest(file);
  const jobs = [];
  function connect(cloud) {
    return createMedia({
      context: async () => ({ connection: 'ready' }),
      request: async (route, { body }) => {
        if (route.endsWith('/capabilities')) return Response.json({
          processingLocation: 'box', chunkBytes: 2048, maxInputBytes: 102400,
          capabilities: [{ id: 'audio.transcribe', configured: true }, ...(cloud ? [{ id: CLOUD_ASR, configured: true }] : [])],
        });
        if (route.endsWith('/jobs')) {
          jobs.push(body);
          return Response.json({ id: 'test-job', state: 'done' });
        }
        assert.ok(route.endsWith('/test-job/result'), route);
        return Response.json({ jobId: 'test-job', capability: jobs.at(-1).capability, inputSha256: hash, result: { segments: [] } });
      },
    }, null, 'demo');
  }
  const legacy = connect(false);
  assert.equal((await legacy.status()).cloudTranscribe, false);
  await assert.rejects(legacy.transcribe(file, 'refused', { cloudConsent: true }), /尚未开通云端精转/);
  assert.equal(jobs.length, 0);
  const both = connect(true);
  assert.equal((await both.status()).cloudTranscribe, true);
  await both.transcribe(file, 'local');
  await both.transcribe(file, 'cloud', { cloudConsent: true });
  assert.deepEqual(jobs.map(({ capability, options }) => [capability, options]), [
    ['audio.transcribe', {}], [CLOUD_ASR, { cloudConsent: true }],
  ]);
});

test('per-recording choice requires explicit cloud consent and keeps an existing transcript on cloud failure', async t => {
  await Meetings.initStore(await scratch(t));
  t.mock.method(media, 'scope', async () => 'test-box');
  const calls = [];
  t.mock.method(media, 'requireCapability', async (cap, opts) => {
    if (opts?.diarization) throw Error('unavailable');
    assert.ok([CLOUD_ASR, 'audio.transcribe'].includes(cap));
    return { maxInputBytes: 1024 ** 2, info: { maxDurationSeconds: 600, formats: ['wav'] } };
  });
  t.mock.method(media, 'summarize', async () => { throw Error('summary offline'); });
  let cloudWorks = false;
  t.mock.method(media, 'transcribe', async (file, id, { cloudConsent }) => {
    calls.push({ id, cloudConsent, hash: await fileDigest(file) });
    if (cloudConsent && !cloudWorks) throw Error('CLOUD_ASR_UNAVAILABLE');
    return { model: cloudConsent ? 'qwen3-asr-flash' : 'Qwen3-ASR-1.7B', segments: [{ startMs: 0, endMs: 800, text: cloudConsent ? '云端逐字稿' : '本地逐字稿' }] };
  });
  const create = async () => {
    const { id } = await Meetings.createMeeting({ source: 'disk' });
    await Meetings.saveChunk(id, 0, Buffer.alloc(32000));
    return id;
  };
  const id = await create();
  const cloud = { transcriptionMode: 'cloud', cloudConsent: true };
  await assert.rejects(Meetings.finishMeeting(id, { transcriptionMode: 'cloud' }), { status: 400 });
  await Meetings.finishMeeting(id);
  const first = await settle(id);
  assert.equal(first.transcript.segments[0].text, '本地逐字稿');
  const output = (await Meetings.spaceFile(id, 'transcript')).file;
  const localText = await fs.readFile(output, 'utf8');
  await assert.rejects(Meetings.retryStage(id, 'transcript', { transcriptionMode: 'unknown' }), { status: 400 });
  await assert.rejects(Meetings.retryStage(id, 'transcript', { transcriptionMode: 'cloud' }), { status: 400 });
  await Meetings.retryStage(id, 'transcript', cloud);
  const failed = await settle(id);
  assert.equal(failed.transcriptionError, 'CLOUD_ASR_UNAVAILABLE');
  assert.deepEqual(failed.transcript, first.transcript);
  assert.deepEqual(failed.minutes, first.minutes);
  assert.equal(await fs.readFile(output, 'utf8'), localText);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(calls[0].hash, calls[1].hash);
  cloudWorks = true;
  await Meetings.retryStage(id, 'transcript', cloud);
  const succeeded = await settle(id);
  assert.equal(succeeded.transcriptionError, undefined);
  assert.equal(succeeded.transcript.mode, 'cloud');
  assert.equal(succeeded.transcript.model, 'qwen3-asr-flash');
  assert.match(await fs.readFile(output, 'utf8'), /云端逐字稿/);
  assert.equal(calls[1].id, calls[2].id);
  const next = await create();
  await Meetings.finishMeeting(next, cloud);
  assert.equal((await settle(next)).transcript.mode, 'cloud');
  await assert.rejects(putSettings({ recordingModel: 'invalid' }), { status: 400 });
  await putSettings({ recordingModel: 'cloud' });
  const preferred = await create();
  assert.equal(Meetings.view(preferred).liveCaptionMode, 'cloud');
  await Meetings.finishMeeting(preferred);
  assert.equal((await settle(preferred)).transcript.mode, 'cloud');
  const clip = await Meetings.importAudio((await Meetings.spaceFile(id, 'audio')).file, 'clip.wav');
  assert.equal((await settle(clip.id)).transcript.mode, 'cloud');
  await putSettings({ recordingModel: 'local' });
  await Meetings.retryStage(clip.id, 'transcript');
  assert.equal((await settle(clip.id)).transcript.mode, 'local');
  const ordinary = await create();
  await Meetings.finishMeeting(ordinary);
  assert.equal((await settle(ordinary)).transcript.mode, 'local');
  assert.deepEqual(calls.map(({ cloudConsent }) => cloudConsent), [false, true, true, true, true, true, false, false]);
});
