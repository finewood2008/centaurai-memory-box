import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { captions, finishCaptions, sendLiveFrame } from '../resources/accessory-preview/lib/live-captions.mjs';
import { attachMedia } from '../resources/accessory-preview/lib/media.mjs';
import * as Meetings from '../resources/accessory-preview/lib/meetings.mjs';
import { editSpeakerState, newSpeakers, normalizeTurns, speakerProjection, withSpeakerTurns } from '../resources/accessory-preview/lib/speaker-annotations.mjs';
import { prepareDiarizationAudio, probeAudio } from '../resources/accessory-preview/lib/audio-input.mjs';
import { wavHeader } from '../resources/accessory-preview/lib/wav.mjs';

const turn = (startMs, endMs, ...speakerIds) => ({ startMs, endMs, speakerIds });

test('unassigned speech can be named by segment and stays manual across retry and rename', () => {
  const segments = [
    { i: 0, fromMs: 0, toMs: 1000, text: '第一段' },
    { i: 1, fromMs: 1000, toMs: 2000, text: '第二段' },
  ];
  const turns = [turn(0, 2000)];
  const empty = withSpeakerTurns(newSpeakers(), turns);
  assert.deepEqual(speakerProjection(empty, segments).speakers.labels, []);
  for (const initial of [empty, newSpeakers()]) {
    let state = editSpeakerState(initial, { rev: initial.rev, action: 'assign',
      segmentIndex: 0, speakerIds: [], newName: '林工' }, segments);
    const label = speakerProjection(state, segments).speakers.labels[0];
    assert.equal(label.name, '林工');
    assert.deepEqual(speakerProjection(state, segments).segments[0].speakerIds, [label.id]);
    assert.ok(!speakerProjection(state, segments).segments[1].speakerIds?.length);
    state = editSpeakerState(state, { rev: state.rev, action: 'rename', speakerId: label.id, name: '林晓' }, segments);
    const result = speakerProjection(withSpeakerTurns(state, turns), segments);
    assert.equal(result.speakers.labels[0].name, '林晓');
    assert.deepEqual(result.segments[0].speakerIds, [label.id]);
    assert.equal(result.segments[0].speakerConflict, false);
    assert.deepEqual(result.segments[1].speakerIds, []);
  }
});

test('live attribution arrives after text, can change after a final line, and keeps session labels', async () => {
  let emit;
  const id = 'live-speakers';
  const service = { async openLive(callback) {
    emit = callback;
    return { send: () => true, end() {} };
  } };
  try {
    await sendLiveFrame(id, Buffer.alloc(2), service, [], 1200);
    emit({ type: 'partial', segmentId: 1, text: '文字先到' });
    assert.equal(captions(id).lines[0].speakerIds, undefined);
    emit({ type: 'speaker', segmentId: 1, speakerIds: ['speaker-9'] });
    await sendLiveFrame(id, Buffer.alloc(2), service, [], 2300);
    emit({ type: 'final', segmentId: 1, text: '最终文字' });
    emit({ type: 'partial', segmentId: 2, text: '另一段' });
    emit({ type: 'speaker', segmentId: 2, speakerIds: ['speaker-9', 'speaker-3'] });
    assert.deepEqual(captions(id).lines.map(line => line.speakerIds), [['live-1'], ['live-1', 'live-2']]);
    emit({ type: 'speaker', segmentId: 1, speakerIds: [] });
    assert.deepEqual(captions(id).lines[0], { key: '1:1', text: '最终文字', final: true, receivedAtMs: 1200, speakerIds: [] });
    assert.equal(captions(id).lines[1].receivedAtMs, 2300);
  } finally { finishCaptions(id); }
});

test('full-audio timelines preserve unknown and overlapping speech and carry mapped edits on rerun', () => {
  const segments = [
    { i: 0, fromMs: 0, toMs: 2000, text: '第一段' },
    { i: 1, fromMs: 2000, toMs: 4000, text: '第二段' },
    { i: 2, fromMs: 4000, toMs: 5000, text: '同时发言' },
    { i: 3, fromMs: 5100, toMs: 5600, text: '听不清身份' },
  ];
  const original = [turn(0, 2000, 'A'), turn(2000, 4000, 'B'), turn(4000, 5000, 'A', 'B'), turn(5100, 5600)];
  let state = withSpeakerTurns(newSpeakers(), normalizeTurns({ durationMs: 6000, speakerTurns: original }, 6000));
  assert.deepEqual(speakerProjection(state, segments).segments.map(s => s.speakerIds),
    [['speaker-1'], ['speaker-2'], ['speaker-1', 'speaker-2'], []]);
  state = editSpeakerState(state, { rev: state.rev, action: 'rename', speakerId: 'speaker-2', name: '林工' }, segments);
  state = editSpeakerState(state, { rev: state.rev, action: 'assign', segmentIndex: 0, speakerIds: ['speaker-2'] }, segments);
  // New box IDs are deliberately reversed. An automatic assignment identical
  // to the previous one must not invalidate a prior human correction.
  const rerun = [turn(0, 2000, 'new-b'), turn(2000, 4000, 'new-a'), turn(4000, 5000, 'new-a', 'new-b'), turn(5100, 5600)];
  state = withSpeakerTurns(state, rerun);
  const stable = speakerProjection(state, segments);
  assert.equal(stable.speakers.labels.find(label => label.id === 'speaker-2').name, '林工');
  assert.deepEqual(stable.segments[0].speakerIds, ['speaker-2']);
  assert.equal(stable.segments[0].speakerConflict, false);
  const ambiguous = withSpeakerTurns(state, [turn(0, 4000, 'one')]);
  assert.equal(speakerProjection(ambiguous, segments).segments[0].speakerConflict, true);
  const merged = editSpeakerState(state, { rev: state.rev, action: 'merge', speakerId: 'speaker-1', targetId: 'speaker-2' }, segments);
  assert.deepEqual(speakerProjection(merged, segments).segments[2].speakerIds, ['speaker-2']);
  assert.throws(() => editSpeakerState(merged, { rev: state.rev, action: 'rename', speakerId: 'speaker-2', name: '迟到的修改' }, segments), { status: 409 });
});

test('a short overlap within a longer transcript line keeps its exact listening position', () => {
  const turns = [turn(0, 1000, 'A'), turn(1000, 1250, 'A', 'B'), turn(1250, 1600), turn(1600, 2400, 'A')];
  const state = withSpeakerTurns(newSpeakers(), turns);
  const { segments: [line] } = speakerProjection(state, [{ i: 0, fromMs: 0, toMs: 2400, text: '较长的字幕' }]);
  assert.deepEqual(line.speakerIds, ['speaker-1']);
  assert.equal(line.overlapAtMs, 1000);
  assert.equal(line.unknownAtMs, 1250);
});

test('oversize multi-channel audio is converted to one deterministic file with the original duration', async t => {
  for (const tool of [process.env.FFMPEG_BIN || 'ffmpeg', process.env.FFPROBE_BIN || 'ffprobe']) {
    if (spawnSync(tool, ['-version']).error?.code === 'ENOENT') { t.skip('本机未安装音频工具'); return; }
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wanx-speaker-original-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original.wav');
  const pcm = Buffer.alloc(48000 * 2 * 2 * 2);
  await fs.writeFile(original, Buffer.concat([wavHeader(pcm.length, 48000, 2), pcm]));
  const limits = { info: { formats: ['wav'], maxDiarizationDurationSeconds: 10 }, maxInputBytes: 70000 };
  const prepared = await prepareDiarizationAudio(original, 2000, limits, path.join(root, 'first'));
  assert.deepEqual(await probeAudio(prepared), { durationMs: 2000, sampleRate: 16000, channels: 1 });
  assert.ok((await fs.stat(prepared)).size <= limits.maxInputBytes);
  assert.deepEqual(await fs.readdir(path.dirname(prepared)), ['recording.wav']);
  const retry = await prepareDiarizationAudio(original, 2000, limits, path.join(root, 'second'));
  assert.deepEqual(await fs.readFile(prepared), await fs.readFile(retry));
});

async function until(meetingId, predicate) {
  for (let i = 0; i < 100; i++) {
    const row = Meetings.view(meetingId);
    if (predicate(row)) return row;
    await delay(15);
  }
  assert.fail('录音流程未完成');
}

test('speaker retry sends original audio only and retains text, bookmarks, and the confirmed summary', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wanx-recording-speakers-'));
  const sdk = path.join(root, 'host.cjs');
  await fs.writeFile(sdk, 'exports.fromEnvironment = () => globalThis.recordingSpeakerTestHost;');
  const jobs = new Map();
  let fail = true;
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.recordingSpeakerTestHost = {
    context: async () => ({ connection: 'ready', boxId: 'fixture-box', principalId: 'fixture-user' }),
    close() {},
    request: async (route, { method, body }) => {
      const endpoint = route.replace('/api/services/wanx.media/v1', '');
      if (endpoint === '/capabilities') return response({ instance: 'fixture', processingLocation: 'box', chunkBytes: 65536,
        maxInputBytes: 1048576, capabilities: [{ id: 'audio.transcribe', configured: true, formats: ['wav'], speakerDiarization: true, maxDiarizationDurationSeconds: 300 }] });
      if (endpoint === '/jobs') {
        assert.equal(method, 'POST');
        let job = [...jobs.values()].find(row => row.requestId === body.requestId);
        if (!job) {
          job = { ...body, id: 'speaker-job-' + jobs.size, state: 'uploading', offset: 0 };
          jobs.set(job.id, job);
        }
        return response(job);
      }
      const job = jobs.get(endpoint.split('/')[2]);
      assert.ok(job);
      if (endpoint.endsWith('/submit') || endpoint.endsWith('/retry')) {
        job.state = fail ? 'failed' : 'done';
        job.error = fail ? 'SPEAKER_DIARIZATION_FAILED' : undefined;
        return response(job);
      }
      if (endpoint.includes('/input?')) {
        job.offset += body.length;
        return response({ offset: job.offset });
      }
      assert.ok(endpoint.endsWith('/result'));
      return response({ jobId: job.id, capability: job.capability, inputSha256: job.sha256,
        result: { durationMs: 2000, speakerTurns: [turn(0, 2000, 'one')] } });
    },
  };
  attachMedia({ WANX_HOST_TRANSPORT: 'test', MEMOBOX_MEDIA_INSTANCE: 'fixture', MEMOBOX_HOST_SDK_PATH: sdk });
  t.after(async () => {
    attachMedia({});
    delete globalThis.recordingSpeakerTestHost;
    await fs.rm(root, { recursive: true, force: true });
  });
  await Meetings.initStore(root);
  const { id } = await Meetings.createMeeting({ source: 'disk', memoryEnabled: false });
  const pending = await Meetings.addBookmark(id, { sampleOffset: 6000, note: '第一处' });
  assert.equal(pending.bookmarks[0].positionMs, 375);
  await Meetings.saveChunk(id, 0, Buffer.alloc(16000 * 2));
  const latest = await Meetings.addBookmark(id, { sampleOffset: 20000 });
  const second = latest.bookmarks[1].id;
  await Meetings.saveChunk(id, 1, Buffer.alloc(16000 * 2));
  await Meetings.finishMeeting(id, { chunkCount: 2, audioOnly: true });
  await until(id, row => row.audio.status === 'saved' && !row.pipelineRunning);
  const local = Meetings.getMeetingRaw(id);
  local.transcript = { ...local.transcript, status: 'done', segments: [{ i: 0, fromMs: 0, toMs: 1800, text: '原来的逐字稿' }] };
  await Meetings.saveMinutes(id, { rev: 0, documentText: '原来的确认版' });
  await Meetings.confirmMinutes(id, { rev: 1 });
  await assert.rejects(Meetings.retryStage(id, 'speakers', { expectedSpeakers: 13 }), { status: 400 });
  await Meetings.retryStage(id, 'speakers', { expectedSpeakers: 3 });
  let row = await until(id, current => current.speakers.status === 'error');
  assert.equal(row.transcript.segments[0].text, '原来的逐字稿');
  assert.equal(row.review.status, 'confirmed');
  assert.equal(row.audio.status, 'saved');
  fail = false;
  await Meetings.retryStage(id, 'speakers', { expectedSpeakers: 3 });
  row = await until(id, current => current.speakers.status === 'done');
  assert.equal(jobs.size, 1);
  const [job] = jobs.values();
  assert.deepEqual(job.options, { mode: 'diarize', expectedSpeakers: 3 });
  assert.equal(job.offset, (await fs.stat(Meetings.audioFile(id))).size);
  assert.equal(row.transcript.segments[0].text, '原来的逐字稿');
  assert.deepEqual(row.transcript.segments[0].speakerIds, ['speaker-1']);
  const updated = await Meetings.changeBookmark(id, second, { note: '第二处' });
  assert.equal(updated.bookmarks[1].positionMs, 1250);
  await Meetings.changeBookmark(id, updated.bookmarks[0].id, null);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'meetings', id, 'meeting.json'), 'utf8'));
  assert.equal(saved.speakerState.status, 'done');
  assert.deepEqual(saved.bookmarks, [{ id: second, sampleOffset: 20000, note: '第二处' }]);
  const originalSummary = await Meetings.spaceFile(id, 'v1');
  assert.match(await fs.readFile(originalSummary.file, 'utf8'), /原来的确认版/);
});
