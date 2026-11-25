// 会议存储与会后流程：片段先落盘 → 异步识别；结束后组合原音 → 完整转录 → 纪要草稿 → 核对确认版。
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import {
  SAMPLE_RATE, writeFileAtomic, writeJson, readJson, withLock, newMeetingId, RE, cleanText,
  safeName, sha256, insideDir, HttpError, localStamp,
} from './util.mjs';
import { pcmStats, wavHeader } from './wav.mjs';
import { media, requireSample, fileDigest } from './media.mjs';
import { saveSpaceFiles, submitAccessoryMemory } from './destinations.mjs';
import { audioType, probeAudio, prepareParts } from './audio-input.mjs';
import { captions, finishCaptions, sendLiveFrame } from './live-captions.mjs';
import { generateMinutes, sanitizeItems, openPendingCount, renderMinutesMd, renderTranscriptTxt, legacySummarySections } from './minutes.mjs';
import { writeMeetingMemory, saveDemoAccessoryMemory, initLibrary, getSettings, resolveMinutesTemplate } from './library.mjs';
import { DEFAULT_TEMPLATE_ID, templateSnapshot, validateInstruction } from './minutes-templates.mjs';

export const P = {};
const cache = new Map();
const pipelines = new Set();

export const LIMITS = {
  chunkMaxBytes: 8 * 1024 * 1024,
  totalPcmBytes: 1024 * 1024 * 1024,
  maxChunks: 4000,                     // 约 5.5 小时
  silentRms: 0.0025,
};

export const FILES = { audio: '原始录音.wav', transcript: '完整转录.txt', minutes: '会议纪要.md', meta: 'meta.json' };
const minutesName = (m) => m.minutes.document ? '录音总结.md' : FILES.minutes;
const audioName = (m) => m.audio.name || FILES.audio;
const durationOf = (m) => m.audio.durationMs || Math.round(m.totalSamples / m.sampleRate * 1000);

export async function initStore(dataDir) {
  P.data = path.resolve(dataDir);
  P.meetings = path.join(P.data, 'meetings');
  P.spaceRoot = path.join(P.data, '试用空间');
  P.space = path.join(P.spaceRoot, '录音记录');
  P.star = path.join(P.data, '试用星图');
  P.memory = path.join(P.data, '试用记忆');
  P.tmp = path.join(P.data, 'tmp');
  for (const d of [P.meetings, P.space, P.star, P.memory, P.tmp]) await fs.mkdir(d, { recursive: true });
  initLibrary(P);
  await fs.rm(P.tmp, { recursive: true, force: true });
  await fs.mkdir(P.tmp, { recursive: true });
  const restart = [];
  for (const name of await fs.readdir(P.meetings)) {
    if (!RE.meeting.test(name)) continue;
    try {
      const m = await readJson(path.join(P.meetings, name, 'meeting.json'));
      if (m?.id !== name) continue;
      if (m.state === 'finished') {
        const pending = ['pending', 'running'];
        if (['pending', 'composing'].includes(m.audio?.status)) restart.push([m.id, 'audio']);
        else if (m.audioOnly && m.audio?.status === 'saved') {
          m.transcript = { ...m.transcript, status: 'offline', error: '请连接盒子后重试转写。' };
          m.minutes = { ...m.minutes, status: 'waiting', error: '' };
        }
        else if (pending.includes(m.transcript?.status)) restart.push([m.id, 'transcript']);
        else if (pending.includes(m.minutes?.status)) restart.push([m.id, 'minutes']);
        recoverInterrupted(m);
      }
      cache.set(m.id, m);
      await persist(m);
    } catch (e) { console.warn(`跳过无法读取的会议 ${name}: ${e.message}`); }
  }
  for (const [id, stage] of restart) runPipeline(id, stage, undefined, true);
}

function recoverInterrupted(m) {
  const error = '服务重启时中断，可重试';
  for (const key of ['audio', 'transcript', 'minutes']) {
    if (['running', 'pending', 'composing'].includes(m[key]?.status)) m[key] = { ...m[key], status: 'error', error };
  }
}

const legacyProjects = new Map();
let legacyRoot;
export async function openLegacyProjects(root) {
  legacyRoot = root;
  if (!root || !path.isAbsolute(root)) return;
  const dir = path.join(root, 'meetings');
  for (const id of await fs.readdir(dir).catch(err => { if (err.code === 'ENOENT') return []; throw err; })) {
    if (!RE.meeting.test(id) || cache.has(id)) continue;
    const project = await readJson(path.join(dir, id, 'meeting.json')).catch(() => null);
    if (legacyRoot !== root) return;
    if (project?.id === id && !cache.has(id)) { legacyProjects.set(id, root); cache.set(id, project); }
  }
}
const isVisible = m => !legacyProjects.has(m.id) || legacyProjects.get(m.id) === legacyRoot;
const meetingDir = id => path.join(legacyProjects.get(id) || P.data, 'meetings', id);
const chunkFile = (id, seq) => path.join(meetingDir(id), 'chunks', `${String(seq).padStart(6, '0')}.pcm`);
export function spaceDir(m) {
  const space = legacyProjects.has(m.id) ? path.join(legacyProjects.get(m.id), '试用空间', '录音记录') : P.space;
  const d = path.join(space, m.folder);
  if (!insideDir(space, d)) throw new HttpError(500, '归档目录异常');
  return d;
}

async function persist(m) {
  m.updatedAt = new Date().toISOString();
  await writeJson(path.join(meetingDir(m.id), 'meeting.json'), m);
}

function must(id) {
  if (typeof id !== 'string' || !RE.meeting.test(id)) throw new HttpError(400, '会议 ID 无效');
  const m = cache.get(id);
  if (!m || !isVisible(m)) throw new HttpError(404, '会议不存在');
  return m;
}

async function update(id, fn) {
  return withLock(id, async () => {
    const m = must(id);
    const r = await fn(m);
    await persist(m);
    return r === undefined ? m : r;
  });
}

// —— 视图 ——
export function summary(m) {
  return {
    id: m.id, title: m.title, createdAt: m.createdAt, state: m.state,
    durationMs: durationOf(m), source: m.source, sample: m.sample === true,
    chunks: m.chunks.length,
    audio: m.audio.status, transcript: m.transcript.status, minutes: m.minutes.status,
    review: m.review.status, reviewVersion: m.review.version,
  };
}
export const listMeetings = () => [...cache.values()].filter(isVisible).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary);

export function view(id) {
  const m = must(id);
  const live = captions(id);
  return {
    ...m,
    durationMs: durationOf(m),
    chunks: m.chunks.map(({ sha256: _h, ...c }) => c),
    draft: live.lines, liveStatus: live.status,
    openPending: openPendingCount(m.minutes.items),
    summarySections: m.minutes.document?.sections || legacySummarySections(m.minutes),
    pipelineRunning: pipelines.has(m.id),
    spacePath: `试用空间 › 录音记录 › ${m.folder}`,
  };
}

// —— 创建 / 修改 ——
export async function createMeeting({ title, inputLabel, memoryEnabled, templateId, templateRevision, source = 'disk', sample = false, sampleRate = SAMPLE_RATE, channels = 1 }) {
  if (!['disk', 'clip'].includes(source)) throw new HttpError(400, '录音来源无效');
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 ||
    !Number.isSafeInteger(channels) || channels < 1 || channels > 8) throw new HttpError(400, '音频采集格式无效');
  const template = await resolveMinutesTemplate(templateId);
  if (templateRevision !== undefined && templateRevision !== template.revision) throw new HttpError(409, '模板已更新，请重新选择');
  const id = newMeetingId();
  const now = new Date();
  const t = cleanText(title, 80) || `录音 ${localStamp(now.toISOString())}`;
  const m = {
    schema: 1, id, source, sample: sample === true, title: t, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    inputLabel: cleanText(inputLabel, 120),
    memoryEnabled: memoryEnabled !== false,
    minutesTemplate: templateSnapshot(template),
    folder: `${localStamp(now.toISOString()).replace(/[: ]/g, (c) => (c === ' ' ? '_' : ''))}_${safeName(t)}_${id.slice(-6)}`,
    state: 'recording', sampleRate, channels,
    chunks: [], totalSamples: 0, finishedAt: null,
    audio: { status: 'recording', error: '', bytes: 0, durationMs: 0 },
    transcript: { status: 'none', source: '', segments: [], error: '', failedChunks: [], updatedAt: null },
    minutes: { status: 'none', model: '', error: '', items: [], dropped: 0, rev: 0, generatedAt: null, origin: '' },
    review: { status: 'none', version: 0, confirmedAt: null, versions: [] },
    memory: { status: 'none', count: 0, version: 0 },
    imports: [],
  };
  await fs.mkdir(path.join(meetingDir(id), 'chunks'), { recursive: true });
  cache.set(id, m);
  await persist(m);
  return view(id);
}

export async function patchMeeting(id, body) {
  await update(id, (m) => {
    if ('title' in body) {
      const t = cleanText(body.title, 80);
      if (!t) throw new HttpError(400, '主题不能为空');
      m.title = t;
    }
    if ('memoryEnabled' in body) {
      if (typeof body.memoryEnabled !== 'boolean') throw new HttpError(400, 'memoryEnabled 必须是布尔值');
      m.memoryEnabled = body.memoryEnabled;
    }
    if ('inputLabel' in body) m.inputLabel = cleanText(body.inputLabel, 120);
  });
  return view(id);
}

// —— 片段：先落盘再返回，随后异步识别 ——
export async function saveChunk(id, seq, buf) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, '片号无效');
  if (!buf.length || buf.length % 2) throw new HttpError(400, 'PCM16 数据长度必须为正偶数');
  if (buf.length > LIMITS.chunkMaxBytes) throw new HttpError(413, '片段过大');
  const res = await withLock(id, async () => {
    const m = must(id);
    const frameBytes = (m.channels || 1) * 2;
    if (buf.length % frameBytes || buf.length > m.sampleRate * frameBytes * 6) throw new HttpError(400, '音频分片格式无效');
    const hash = sha256(buf);
    const existing = m.chunks[seq];
    if (existing) {
      if (existing.sha256 === hash) return { chunk: existing, duplicate: true };
      throw new HttpError(409, '该片号已保存为不同内容', { expectedSeq: m.chunks.length });
    }
    if (m.state !== 'recording') throw new HttpError(409, '会议已结束，不能追加录音');
    if (seq !== m.chunks.length) throw new HttpError(409, `片号不连续，期望 ${m.chunks.length}`, { expectedSeq: m.chunks.length });
    if (m.chunks.length >= LIMITS.maxChunks || m.totalSamples * frameBytes + buf.length > LIMITS.totalPcmBytes) throw new HttpError(413, '录音已达试用上限');
    await writeFileAtomic(chunkFile(id, seq), buf);
    const { rms, peak } = pcmStats(buf);
    const chunk = {
      seq, samples: buf.length / frameBytes, start: m.totalSamples, bytes: buf.length, sha256: hash,
      rms: Math.round(rms * 10000) / 10000, peak: Math.round(peak * 10000) / 10000,
      savedAt: new Date().toISOString(),
    };
    m.chunks.push(chunk);
    m.totalSamples += chunk.samples;
    await persist(m);
    return { chunk, duplicate: false };
  });
  const m = must(id);
  return {
    ok: true, seq, duplicate: res.duplicate, saved: true,
    savedChunks: m.chunks.length, totalSamples: m.totalSamples,
    durationMs: durationOf(m),
  };
}

async function assertMediaScope(m, service = media) {
  requireSample(m.sample);
  const scope = await service.scope();
  if (m.mediaScope && m.mediaScope !== scope) throw new HttpError(409, '请连接创建这份录音时的盒子和应用实例');
  if (!m.mediaScope) await update(m.id, (row) => {
    if (row.mediaScope && row.mediaScope !== scope) throw new HttpError(409, '录音所属盒子或应用实例已变化');
    row.mediaScope = scope;
  });
}

export async function pushLiveFrame(id, frame) {
  const m = must(id);
  if (m.source !== 'disk' || m.state !== 'recording') throw new HttpError(409, '当前录音未开启实时字幕');
  const service = media;
  try { await assertMediaScope(m, service); }
  catch (error) { if (error.offline) return { status: 'offline' }; throw error; }
  return { status: await sendLiveFrame(id, frame, service) };
}

export async function importAudio(file, name, { source = 'clip', sample = false, templateId, templateRevision } = {}) {
  const ext = path.extname(name).toLowerCase();
  if (!audioType(name)) throw new HttpError(415, '请选择 WAV、MP3、M4A、FLAC、OGG 或其他支持的音频');
  let metadata;
  try { metadata = await probeAudio(file); }
  catch (err) { throw new HttpError(415, err.message); }
  const digest = await fileDigest(file);
  const bytes = (await fs.stat(file)).size;
  return withLock('imports', async () => {
    if (!sample) {
      const prior = [...cache.values()].filter(isVisible).find((m) => !m.sample && m.source === source && m.audio?.inputSha256 === digest && m.audio.status === 'saved');
      if (prior) return view(prior.id);
    }
    const title = sample ? (source === 'disk' ? '示例 · 圆盘会议' : '示例 · 领夹巡检') : path.basename(name, ext);
    const original = await createMeeting({ title, inputLabel: sample ? '内置合成音频' : name, source, sample, templateId, templateRevision });
    const m = must(original.id);
    const archived = '原始录音' + ext;
    await fs.mkdir(spaceDir(m), { recursive: true });
    await fs.copyFile(file, path.join(spaceDir(m), archived));
    await update(m.id, async (row) => {
      row.state = 'finished';
      row.finishedAt = new Date().toISOString();
      row.audio = { ...metadata, name: archived, bytes, status: 'saved', inputSha256: digest };
      row.transcript.status = 'pending';
      row.minutes.status = 'pending';
      await writeMeta(row);
    });
    runPipeline(m.id, 'transcript');
    return view(m.id);
  });
}

// —— 结束与会后流程 ——
export async function finishMeeting(id, body = {}) {
  const expected = body.chunkCount;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) throw new HttpError(400, 'chunkCount 无效');
  const started = await update(id, (m) => {
    if (m.state === 'finished') return false;
    if (expected !== undefined && expected > m.chunks.length) {
      throw new HttpError(409, `仍有片段未保存：已保存 ${m.chunks.length}/${expected}`, { savedChunks: m.chunks.length });
    }
    m.state = 'finished';
    m.finishedAt = new Date().toISOString();
    if (body.audioOnly === true) m.audioOnly = true;
    m.audio = { ...m.audio, status: 'pending', error: '' };
    m.transcript = { ...m.transcript, status: 'pending', error: '' };
    m.minutes = { ...m.minutes, status: 'pending', error: '' };
    m.review = { ...m.review, status: 'none' };
    return true;
  });
  if (started) { finishCaptions(id); runPipeline(id, 'audio'); }
  return view(id);
}

const STAGES = ['audio', 'transcript', 'minutes'];
export async function retryStage(id, stage, { templateId, templateRevision, rev, instruction } = {}) {
  const m = must(id);
  if (!STAGES.includes(stage)) throw new HttpError(400, 'stage 必须是 audio / transcript / minutes');
  if ((templateId !== undefined || instruction !== undefined) && stage !== 'minutes') throw new HttpError(400, '只能为总结设置生成要求');
  const template = templateId === undefined ? null : await resolveMinutesTemplate(templateId);
  if (templateRevision !== undefined && templateRevision !== template?.revision) throw new HttpError(409, '模板已更新，请重新选择');
  if (m.state !== 'finished') throw new HttpError(409, '会议尚未结束');
  if (pipelines.has(id)) throw new HttpError(409, '会后处理正在进行');
  if (stage !== 'audio' && m.audio.status !== 'saved') throw new HttpError(409, '请先完成原始录音保存');
  if (stage === 'minutes' && m.transcript.status !== 'done') throw new HttpError(409, '请先完成转录');
  if (rev !== undefined && rev !== m.minutes.rev) throw new HttpError(409, '纪要已更新，请重新打开后操作');
  const selected = template && templateSnapshot(template);
  const requested = instruction !== undefined ? { ...selected, name: '本次自定义', rules: validateInstruction(instruction), revision: 1 } : selected;
  runPipeline(id, stage, requested, true);
  return view(id);
}

function runPipeline(id, from, template, retryFailed = false) {
  if (pipelines.has(id)) return;
  pipelines.add(id);
  (async () => {
    const i = STAGES.indexOf(from);
    if (i <= 0) {
      if (!(await composeAudio(id))) return;
      if (must(id).audioOnly) {
        await update(id, row => {
          row.transcript = { ...row.transcript, status: 'offline', error: '请连接盒子后重试转写。' };
          row.minutes = { ...row.minutes, status: 'waiting', error: '' };
        });
        return;
      }
    }
    if (i <= 1 && !(await finalTranscript(id, retryFailed))) return;
    await makeMinutes(id, template, retryFailed);
  })().catch((e) => console.error(`会后流程异常 ${id}: ${e.stack || e.message}`))
    .finally(() => pipelines.delete(id));
}

async function writeMeta(m) {
  const meta = {
    schema: 1, meeting_id: m.id, title: m.title, recorded_at: m.createdAt, finished_at: m.finishedAt,
    duration_ms: m.audio.durationMs, sample_rate: m.audio.sampleRate || SAMPLE_RATE, channels: m.audio.channels || 1, input: m.inputLabel, source: m.source,
    files: { audio: audioName(m), transcript: FILES.transcript, minutes: minutesName(m) },
    transcript: { status: m.transcript.status, source: m.transcript.source, segments: m.transcript.segments.length },
    minutes: { status: m.minutes.status, generator: m.minutes.model ? `wanx.media:${m.minutes.model}` : '', review: m.review.status, versions: m.review.versions, template: m.minutes.template && { id: m.minutes.template.id, name: m.minutes.template.name, revision: m.minutes.template.revision } },
    note: '试用空间记录，与正式盒子/星图隔离。',
  };
  await writeJson(path.join(spaceDir(m), FILES.meta), meta);
}

async function composeAudio(id) {
  const m = await update(id, (mm) => { mm.audio = { ...mm.audio, status: 'composing', error: '' }; });
  try {
    if (!m.chunks.length) throw new Error('没有已保存的音频片段');
    const dir = spaceDir(m);
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, FILES.audio);
    const tmp = `${out}.tmp`;
    const fh = await fs.open(tmp, 'w');
    let bytes = 0;
    try {
      const dataBytes = m.chunks.reduce((s, c) => s + c.bytes, 0);
      await fh.write(wavHeader(dataBytes, m.sampleRate, m.channels || 1));
      for (const c of m.chunks) {
        const buf = await fs.readFile(chunkFile(id, c.seq));
        if (buf.length !== c.bytes || sha256(buf) !== c.sha256) throw new Error(`片段 ${c.seq} 校验失败`);
        await fh.write(buf);
        bytes += buf.length;
      }
      await fh.sync();
    } finally { await fh.close(); }
    await fs.rename(tmp, out);
    await update(id, async (mm) => {
      mm.audio = { status: 'saved', error: '', bytes: bytes + 44, durationMs: durationOf(m), sampleRate: m.sampleRate, channels: m.channels || 1, savedAt: new Date().toISOString() };
      await writeMeta(mm);
    });
    return true;
  } catch (e) {
    await update(id, (mm) => {
      mm.audio = { ...mm.audio, status: 'error', error: cleanText(e.message, 300) };
      mm.transcript.status = 'waiting';
      mm.minutes.status = 'waiting';
    });
    return false;
  }
}

async function finalTranscript(id, retryFailed) {
  const m = await update(id, (row) => {
    delete row.audioOnly;
    row.transcript = { ...row.transcript, status: 'running', error: '' };
    row.minutes = { ...row.minutes, status: 'pending', error: '' };
  });
  const directory = path.join(P.tmp, id);
  try {
    const service = media;
    await assertMediaScope(m, service);
    const source = path.join(spaceDir(m), audioName(m));
    const files = await prepareParts(source, m.audio.durationMs, await service.requireCapability('audio.transcribe'), directory);
    const segments = [];
    const failed = [];
    for (const [index, part] of files.entries()) {
      try {
        const digest = (await fileDigest(part.file)).slice(0, 20);
        const tag = m.sample ? 'demo-' + m.source : 'recording';
        const result = await service.transcribe(part.file, tag + '-' + id + '-' + index + '-' + digest, { retryFailed });
        if (!Array.isArray(result.segments)) throw new Error('媒体转录时间轴无效');
        for (const t of result.segments) {
          const text = cleanText(t?.text, 2200);
          if (!text || !Number.isFinite(t?.startMs) || !Number.isFinite(t?.endMs) || t.endMs <= t.startMs || t.startMs < 0 || t.startMs >= part.durationMs) continue;
          segments.push({
            i: segments.length, text, fromMs: part.offsetMs + t.startMs,
            toMs: part.offsetMs + Math.min(t.endMs, part.durationMs),
          });
        }
      } catch (err) {
        if (err.offline) throw err;
        failed.push(index + 1);
      }
    }
    if (failed.length && !segments.length) throw new Error('盒端转写未完成，请重试');
    const status = failed.length ? 'partial' : 'done';
    await update(id, async (row) => {
      row.transcript = {
        status, source: files.length === 1 ? 'wanx.media' : 'chunks', segments, failedChunks: failed,
        error: failed.length ? `第 ${failed.join('、')} 段等待重试` : '', updatedAt: new Date().toISOString(),
      };
      if (failed.length) row.minutes.status = 'waiting';
      await writeFileAtomic(path.join(spaceDir(row), FILES.transcript), renderTranscriptTxt(row));
      await writeMeta(row);
    });
    return !failed.length;
  } catch (error) {
    await update(id, async (row) => {
      row.transcript = { ...row.transcript, status: error.offline || error.status === 503 ? 'offline' : 'error', error: cleanText(error.message, 230) };
      row.minutes = { ...row.minutes, status: 'waiting', error: '等待完整转写' };
      await writeMeta(row);
    });
    return false;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function makeMinutes(id, requestedTemplate, retryFailed) {
  const m = await update(id, (mm) => { mm.minutes = { ...mm.minutes, status: 'running', error: '' }; });
  if (!m.transcript.segments.length) {
    await update(id, (mm) => { mm.minutes = { ...mm.minutes, status: 'empty', error: '转录为空，没有可提取的内容；可手动编写纪要' }; mm.review.status = 'draft'; });
    return;
  }
  try {
    const template = requestedTemplate || m.minutes.template || m.minutesTemplate || templateSnapshot(await resolveMinutesTemplate(DEFAULT_TEMPLATE_ID));
    const service = media;
    await assertMediaScope(m, service);
    const r = await generateMinutes(id, m.transcript.segments, template, m.minutes.rev, retryFailed, service);
    if (!r.sections.length && !r.text?.trim()) throw new Error('盒端未生成有效总结');
    await update(id, async (mm) => {
      mm.minutes = { status: 'done', model: r.model, error: '', items: [], rev: mm.minutes.rev + 1, generatedAt: new Date().toISOString(), origin: 'model', template, document: { sections: r.sections, ...(r.text ? { text: r.text } : {}) } };
      mm.review.status = 'draft';
      await writeFileAtomic(path.join(spaceDir(mm), minutesName(mm)), renderMinutesMd(mm));
      await writeMeta(mm);
    });
  } catch (e) {
    await update(id, async (mm) => {
      mm.minutes = { ...mm.minutes, status: e.offline ? 'offline' : 'error', error: cleanText(e.message, 300) };
      if (mm.review.status === 'none') mm.review.status = 'draft';
      await writeMeta(mm);
    });
  }
}

// —— 核对 ——
export async function saveMinutes(id, body) {
  await update(id, async (m) => {
    if (m.state !== 'finished') throw new HttpError(409, '会议尚未结束');
    if (m.minutes.status === 'running' || pipelines.has(id)) throw new HttpError(409, '纪要正在生成');
    if (!Number.isSafeInteger(body.rev) || body.rev !== m.minutes.rev) throw new HttpError(409, '纪要已被更新，请刷新后再编辑', { rev: m.minutes.rev });
    if ('documentText' in body) {
      const text = typeof body.documentText === 'string' ? cleanText(body.documentText, 60001, { multiline: true }) : '';
      if (!text || text.length > 60000) throw new HttpError(400, '总结需要填写，最多 60000 字');
      m.minutes.document = { sections: m.minutes.document?.sections || legacySummarySections(m.minutes), text };
    } else {
      if (m.minutes.document) throw new HttpError(400, '请提交录音总结正文');
      try { m.minutes.items = sanitizeItems(body.items, m.transcript.segments, m.minutes.items); } catch (e) { throw new HttpError(400, e.message); }
    }
    m.minutes.rev += 1;
    if (!m.minutes.origin) m.minutes.origin = 'manual';
    m.review.status = 'draft';
    await fs.mkdir(spaceDir(m), { recursive: true });
    await writeFileAtomic(path.join(spaceDir(m), minutesName(m)), renderMinutesMd(m));
    await writeMeta(m);
  });
  return view(id);
}

export async function confirmMinutes(id, { documentReview = false, rev } = {}) {
  let memoryResult = { status: 'skipped', count: 0 };
  await update(id, async (m) => {
    if (m.state !== 'finished') throw new HttpError(409, '会议尚未结束');
    if (pipelines.has(id)) throw new HttpError(409, '会后处理正在进行');
    if (rev !== undefined && rev !== m.minutes.rev) throw new HttpError(409, '总结已更新，请重新打开后确认');
    if (m.review.status === 'confirmed') { memoryResult = { status: m.memory.status, count: m.memory.count }; return; }
    if (m.review.status !== 'draft') throw new HttpError(409, '还没有可核对的纪要');
    const open = !m.minutes.document && !documentReview ? openPendingCount(m.minutes.items) : 0;
    if (open) throw new HttpError(409, `还有 ${open} 项待核对`, { openPending: open });
    if (!m.minutes.items.length && !['done', 'empty'].includes(m.minutes.status) && m.minutes.rev === 0) {
      throw new HttpError(409, '纪要尚未生成或编写，可重试生成或手动编写后再核对');
    }
    if (!m.minutes.document && documentReview) m.minutes.document = { sections: legacySummarySections(m.minutes) };
    const version = m.review.version + 1;
    const confirmedAt = new Date().toISOString();
    const md = renderMinutesMd(m, { version, confirmedAt });
    const dir = spaceDir(m);
    const file = `版本/${minutesName(m).replace(/\.md$/, '')}.v${version}.md`;
    await writeFileAtomic(path.join(dir, minutesName(m)), md);
    await writeFileAtomic(path.join(dir, file), md);
    m.review = { status: 'confirmed', version, confirmedAt, versions: [...m.review.versions, { version, confirmedAt, sha256: sha256(Buffer.from(md)), file }] };
    if (m.memoryEnabled && process.env.RECORDING_MODULE_PROFILE !== 'accessories') {
      const n = await writeMeetingMemory(m, version);
      m.memory = { status: 'saved', count: n, version };
    } else {
      const grant = process.env.RECORDING_MODULE_PROFILE === 'accessories'
        && (await getSettings()).recordingCaptureGrants?.[m.source];
      m.memory = { status: grant ? 'pending' : 'disabled', count: 0, version, ...(grant && { grant }) };
    }
    memoryResult = { status: m.memory.status, count: m.memory.count };
    await writeMeta(m);
  });
  const confirmed = view(id);
  if (confirmed.memory.status === 'pending') {
    try {
      const result = await saveDestination(id, {destination:'memory', version:confirmed.review.version, automatic:true});
      return {meeting:result, memory:result.memory};
    } catch {
      // The confirmation is already durable. The same version can be submitted again.
      return {meeting:view(id), memory:{status:'pending', count:0}};
    }
  }
  return { meeting: confirmed, memory: memoryResult };
}

// —— 文件读取（仅限固定文件名）——
export function audioFile(id) {
  const m = must(id);
  if (m.audio.status !== 'saved') throw new HttpError(404, '原始录音尚未保存完成');
  return path.join(spaceDir(m), audioName(m));
}

export async function spaceList() {
  const out = [];
  for (const m of [...cache.values()].filter(isVisible).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const dir = spaceDir(m);
    const files = [];
    for (const [key, name] of Object.entries({ ...FILES, audio: audioName(m), minutes: minutesName(m) })) {
      try { const st = await fs.stat(path.join(dir, name)); files.push({ key, name, bytes: st.size, mtime: st.mtime.toISOString() }); } catch { /* 尚未生成 */ }
    }
    for (const v of m.review.versions) files.push({ key: `v${v.version}`, name: v.file, bytes: null, mtime: v.confirmedAt });
    if (files.length) out.push({ id: m.id, title: m.title, folder: m.folder, path: `试用空间/录音记录/${m.folder}`, createdAt: m.createdAt, files });
  }
  return out;
}

export async function spaceFile(id, key) {
  const m = must(id);
  if (typeof key !== 'string') throw new HttpError(400, '文件键无效');
  let name = key === 'minutes' ? minutesName(m) : key === 'audio' ? audioName(m) : Object.hasOwn(FILES, key) ? FILES[key] : '';
  const vm = /^v([1-9]\d{0,3})$/.exec(key);
  if (vm) {
    const v = m.review.versions.find((x) => x.version === Number(vm[1]));
    if (!v) throw new HttpError(404, '版本不存在');
    name = v.file;
  }
  if (!name) throw new HttpError(400, '文件键无效');
  const file = path.join(spaceDir(m), name);
  if (!insideDir(spaceDir(m), file)) throw new HttpError(400, '路径无效');
  try { await fs.access(file); } catch { throw new HttpError(404, '文件尚未生成'); }
  return { file, name, key };
}

export const getMeetingRaw = (id) => must(id);
export async function recordImport(id, rec) { await update(id, (m) => { m.imports.push(rec); }); }
export { createReadStream };

export async function saveDestination(id, { destination, version, automatic = false }) {
  if (!['space','memory'].includes(destination)) throw new HttpError(400, '请选择空间或记忆。');
  await update(id, async m => {
    if (m.review.status !== 'confirmed' || m.review.version !== version) throw new HttpError(409, '请先确认当前版本的总结。');
    if (m.savedTo?.[version]?.[destination]) return;
    const service = media;
    const demo = service.mode === 'demo';
    const localOnly = destination === 'memory' && !m.mediaScope && !legacyProjects.has(id);
    if (!demo && !localOnly && (!m.mediaScope || m.mediaScope !== await service.scope())) throw new HttpError(409, '请连接此项目所属的盒子。');
    const confirmed = m.review.versions.find(row => row.version === version);
    const summaryFile = path.join(spaceDir(m), confirmed.file);
    const md = await fs.readFile(summaryFile);
    if (sha256(md) !== confirmed.sha256) throw new HttpError(409, '项目确认版已发生变化。');
    let receipt;
    if (destination === 'space') {
      const files = [audioFile(id), path.join(spaceDir(m), FILES.transcript), summaryFile];
      if (demo) {
        const dir = path.join(P.data, '演示空间', '录音记录', m.folder);
        await fs.mkdir(dir, {recursive:true});
        for (const file of files) await fs.copyFile(file, path.join(dir, path.basename(file)));
        receipt = {folder:m.folder, files:files.map(f => path.basename(f))};
      } else {
        try { receipt = await saveSpaceFiles(service.drive, m, files); }
        catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, '空间暂未保存完成，请连接盒子后重试。'); }
      }
    } else {
      const body = m.minutes.document?.text ?? (m.minutes.document?.sections || legacySummarySections(m.minutes))
        .map(section => [section.heading, ...section.blocks.map(block => block.text)].join('\n')).join('\n\n');
      if (!body.trim()) throw new HttpError(409, '请先填写总结。');
      const agent = m.source === 'disk' ? '会议录音智能体' : '随身录音智能体';
      const payload = {title:m.title, createdAt:m.createdAt, kind:m.source, project:id, version, localOnly,
        requestId:sha256(Buffer.from([m.mediaScope || (localOnly ? 'local' : 'demo'), id, confirmed.sha256, version].join('/'))),
        content:md.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim() + '\n\n来源：配件 › ' + agent + ' › ' + m.title + ' · v' + version + '\n项目编号：' + id};
      const submit = () => demo ? saveDemoAccessoryMemory(payload) : submitAccessoryMemory(payload);
      if (automatic) {
        receipt = await withLock('settings', async () => {
          const grant = (await getSettings()).recordingCaptureGrants?.[m.source];
          if (grant && m.memory.status === 'pending' && m.memory.grant === grant) return submit();
        });
        if (!receipt) return;
      } else receipt = await submit();
    }
    if (destination === 'memory') m.memory = {status:'saved', count:1, version};
    m.savedTo ||= {};
    m.savedTo[version] ||= {};
    m.savedTo[version][destination] = { ...receipt, demo, savedAt:new Date().toISOString() };
  });
  return view(id);
}

// Retry only confirmed versions that previously opted into automatic collection.
export async function retryPendingCapture() {
  const settings = await getSettings();
  for (const m of cache.values()) {
    if (isVisible(m) && m.review.status === 'confirmed' && m.memory.status === 'pending'
        && m.memory.grant && settings.recordingCaptureGrants?.[m.source] === m.memory.grant) {
      await saveDestination(m.id, {destination:'memory', version:m.review.version, automatic:true}).catch(() => {});
    }
  }
}
