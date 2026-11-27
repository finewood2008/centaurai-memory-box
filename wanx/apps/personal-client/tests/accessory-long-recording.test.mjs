import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_DIARIZATION_AUDIO_MS, prepareDiarizationAudio, probeAudio } from '../resources/accessory-preview/lib/audio-input.mjs';
import { createMedia, fileDigest, media } from '../resources/accessory-preview/lib/media.mjs';
import * as Meetings from '../resources/accessory-preview/lib/meetings.mjs';
import { wavHeader } from '../resources/accessory-preview/lib/wav.mjs';

const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const probeAvailable = spawnSync(ffprobe, ['-version']).status === 0;
const opusAvailable = /\blibopus\b/.test(spawnSync(ffmpeg, ['-encoders'], { encoding: 'utf8' }).stdout || '');
const box = {
  info: { formats: ['wav', 'ogg'], maxDiarizationDurationSeconds: 8 * 3600 },
  maxInputBytes: 256 * 1024 * 1024,
};

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wanx-recording-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function wav(file, seconds) {
  const bytes = seconds * 16000 * 2;
  const handle = await fs.open(file, 'wx');
  try {
    await handle.write(wavHeader(bytes));
    await handle.truncate(bytes + 44);
  } finally {
    await handle.close();
  }
}

async function waitForPipeline(id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!Meetings.view(id).pipelineRunning) return;
    await delay(20);
  }
  assert.fail('录音会后流程未退出');
}

test('a silent transcription part contributes no text and never retries its failed audio job', async t => {
  const root = await scratch(t);
  const source = path.join(root, 'silence.wav');
  await wav(source, 1);
  const media = createMedia({
    context: async () => ({ connection: 'ready' }),
    request: async route => {
      if (route.endsWith('/capabilities')) return Response.json({
        processingLocation: 'box', chunkBytes: 1024 ** 2, maxInputBytes: box.maxInputBytes,
        capabilities: [{ id: 'audio.transcribe', configured: true }],
      });
      assert.ok(route.endsWith('/jobs'), route);
      return Response.json({ id: 'silent-part', state: 'failed', error: 'AUDIO_NO_SPEECH' });
    },
  }, null, 'demo');
  assert.deepEqual(await media.transcribe(source, 'silent', { retryFailed: true }), { text: '', segments: [] });
});

test('over one hour sends a deterministic bounded mono Ogg and keeps the original', {
  skip: !probeAvailable || !opusAvailable,
  timeout: 30000,
}, async t => {
  const root = await scratch(t);
  const source = path.join(root, 'original.wav');
  const duration = 3601;
  await wav(source, duration);
  const input = await fs.stat(source);
  const first = await prepareDiarizationAudio(source, duration * 1000, box, path.join(root, 'first'));
  const retry = await prepareDiarizationAudio(source, duration * 1000, box, path.join(root, 'retry'));
  const converted = await probeAudio(first);
  assert.equal(path.extname(first), '.ogg');
  assert.equal(converted.channels, 1);
  assert.ok(Math.abs(converted.durationMs - duration * 1000) <= 250);
  const minimum = duration * 4000;
  const maximum = duration * 4400 + 65536;
  assert.ok((await fs.stat(first)).size >= minimum && (await fs.stat(first)).size <= maximum);
  assert.equal(await fileDigest(first), await fileDigest(retry));
  assert.equal((await fs.stat(source)).size, input.size);
  await assert.rejects(prepareDiarizationAudio(
    source, MAX_DIARIZATION_AUDIO_MS + 1, box, path.join(root, 'above-eight-hours'),
  ), /时长上限/);
});

test('clip import and retranscription retain the full text without scheduling speaker separation', {
  skip: !probeAvailable,
}, async t => {
  const root = await scratch(t);
  await Meetings.initStore(root);
  const file = path.join(root, 'clip.wav');
  await wav(file, 5);
  t.mock.method(media, 'scope', async () => 'clip-test');
  const capability = t.mock.method(media, 'requireCapability', async () => ({
    ...box, info: { ...box.info, maxDurationSeconds: 300, speakerDiarization: true },
  }));
  const text = '现场走访的完整原话。';
  t.mock.method(media, 'transcribe', async () => ({ segments: [{ startMs: 0, endMs: 1800, text }] }));
  const { id } = await Meetings.importAudio(file, '走访.wav');
  await waitForPipeline(id);
  await Meetings.retryStage(id, 'transcript');
  await waitForPipeline(id);
  assert.deepEqual(Meetings.view(id).transcript.segments.map(segment => segment.text), [text]);
  assert.equal(Meetings.view(id).speakers.status, 'none');
  assert.equal(capability.mock.calls.some(call => call.arguments[1]?.diarization), false);
});

test('complete keeps one original inode and resumes a linked archive from its reservation', {
  skip: !probeAvailable,
}, async t => {
  const root = await scratch(t);
  await Meetings.initStore(root);
  const directory = path.join(root, 'audio-imports');
  await fs.mkdir(directory);
  const id = '1'.repeat(32);
  const source = path.join(directory, id + '.wav');
  await wav(source, 2);
  const inputSha256 = await fileDigest(source);

  const first = await Meetings.importAudio(source, '巡检.wav', { importId: id, inputSha256 });
  await waitForPipeline(first.id);
  assert.equal(first.source, 'clip');
  const archive = Meetings.audioFile(first.id);
  assert.equal((await fs.stat(source)).ino, (await fs.stat(archive)).ino);
  assert.equal(Meetings.findImportedAudio(id).id, first.id);
  assert.equal(first.audioImportIds, undefined);

  const recordPath = path.join(root, 'meetings', first.id, 'meeting.json');
  const linked = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  linked.state = 'importing';
  linked.audio.status = 'importing';
  await fs.writeFile(recordPath, JSON.stringify(linked));
  await Meetings.initStore(root);
  assert.equal(Meetings.findImportedAudio(id), null);
  assert.ok(!Meetings.listMeetings().some(project => project.id === first.id));
  const completed = await Meetings.importAudio(source, '巡检.wav', { importId: id, inputSha256 });
  await waitForPipeline(first.id);
  assert.equal(completed.id, first.id);
  await fs.unlink(source);
  assert.equal(await fileDigest(archive), inputSha256);
  await Meetings.initStore(root);
  assert.equal(Meetings.findImportedAudio(id).id, first.id);
});

test('missing ffprobe preserves a playable archive and later retry restores duration metadata', {
  skip: !probeAvailable,
}, async t => {
  const root = await scratch(t);
  await Meetings.initStore(root);
  const directory = path.join(root, 'audio-imports');
  await fs.mkdir(directory);
  const importId = '2'.repeat(32);
  const input = path.join(directory, importId + '.wav');
  await wav(input, 3);
  const previous = process.env.FFPROBE_BIN;
  try {
    process.env.FFPROBE_BIN = path.join(root, 'missing-ffprobe');
    const imported = await Meetings.importAudio(input, '会话.wav', { importId });
    await waitForPipeline(imported.id);
    assert.equal(imported.audio.metadataStatus, 'pending');
    assert.equal(imported.audio.status, 'saved');
    assert.equal(await fileDigest(Meetings.audioFile(imported.id)), await fileDigest(input));
    await assert.rejects(probeAudio(input), { audioToolUnavailable: true });
    process.env.FFPROBE_BIN = ffprobe;
    await Meetings.retryStage(imported.id, 'transcript');
    await waitForPipeline(imported.id);
    assert.equal(Meetings.view(imported.id).audio.metadataStatus, undefined);
    assert.equal(Meetings.view(imported.id).audio.durationMs, 3000);

    const invalid = path.join(directory, 'invalid.wav');
    await fs.writeFile(invalid, 'file without audio');
    await assert.rejects(Meetings.importAudio(invalid, '损坏.wav', { importId: '3'.repeat(32) }), { status: 415 });
  } finally {
    if (previous === undefined) delete process.env.FFPROBE_BIN;
    else process.env.FFPROBE_BIN = previous;
  }
});
