#!/usr/bin/env node
// 录音智能体 · 独立试用 —— 原生 Node 22+，无 npm 依赖。
import http from 'node:http';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, RE } from './lib/util.mjs';
import { media, attachMedia } from './lib/media.mjs';
import { usbInputs } from './lib/usb-inputs.mjs';
import { audioType } from './lib/audio-input.mjs';
import { AUDIO_IMPORT_CHUNK_BYTES, createAudioImports } from './lib/audio-imports.mjs';
import * as M from './lib/meetings.mjs';
import * as Lib from './lib/library.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT_ENV = process.env.PORT ?? '4180';
const PROFILE = process.env.RECORDING_MODULE_PROFILE || 'recording';
if (!['recording', 'accessories'].includes(PROFILE) || (PROFILE === 'accessories' && !process.env.RECORDING_VIEW_KEY)) {
  console.error('录音模块启动配置无效，请从客户端打开配件。');
  process.exit(1);
}
const accessoryData = process.env.RECORDING_ACCESSORY_DATA;
if (PROFILE === 'accessories' && !path.isAbsolute(accessoryData || '')) {
  console.error('配件演示须使用本机数据目录。');
  process.exit(1);
}
process.umask(0o077);
const DATA_DIR = PROFILE === 'accessories' ? accessoryData
  : path.resolve(process.env.RECORDING_MODULE_DATA || path.join(ROOT, 'data'));

if (HOST !== '127.0.0.1') {
  console.error('HOST 仅允许 127.0.0.1（试用版只在本机回环地址提供服务）');
  process.exit(1);
}
if (!/^\d{1,5}$/.test(PORT_ENV) || Number(PORT_ENV) > 65535) {
  console.error('PORT 无效');
  process.exit(1);
}

const INDEX = ['index.html', 'text/html; charset=utf-8'];
const ACCESSORY_PATH = /^\/accessories(?:\/(?:disk|clip|boxes))?\/?$/;
const STATIC = {
  '/': INDEX,
  '/index.html': INDEX,
  '/nas.js': ['nas.js','text/javascript; charset=utf-8'],
  '/nas.css': ['nas.css','text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/accessories.css': ['accessories.css', 'text/css; charset=utf-8'],
  '/box-connection.css': ['box-connection.css', 'text/css; charset=utf-8'],
  '/accessory-art.svg': ['accessory-art.svg', 'image/svg+xml'],
  '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript; charset=utf-8'],
  '/disk-agent.svg': ['disk-agent.svg', 'image/svg+xml'],
  '/clip-agent.svg': ['clip-agent.svg', 'image/svg+xml'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/centaurai-mark.png': ['centaurai-mark.png', 'image/png'],
};

const LIMIT_JSON = 512 * 1024;
let allowedHosts = new Set();
let allowedOrigins = new Set();

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': isBuf ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) { req.resume(); return reject(new HttpError(413, '请求体过大')); }
    const parts = [];
    let size = 0, done = false;
    req.on('data', (d) => {
      if (done) return;
      size += d.length;
      if (size > limit) { done = true; req.resume(); reject(new HttpError(413, '请求体过大')); return; }
      parts.push(d);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readJsonBody(req) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, '需要 Content-Type: application/json');
  const buf = await readBody(req, LIMIT_JSON);
  if (!buf.length) return {};
  let v;
  try { v = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'JSON 无法解析'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '请求体必须是 JSON 对象');
  return v;
}

async function sendFile(req, res, file, type, extra = {}) {
  const st = await fs.stat(file);
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { ...SEC_HEADERS, 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    if (start > end || start >= size) { res.writeHead(416, { ...SEC_HEADERS, 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  res.writeHead(status, {
    ...SEC_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
    'Content-Length': size ? end - start + 1 : 0,
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    ...extra,
  });
  if (req.method === 'HEAD' || !size) return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function checkRequest(req) {
  if (process.env.RECORDING_VIEW_KEY && req.headers['x-recording-view'] !== process.env.RECORDING_VIEW_KEY) throw new HttpError(403, '请从记忆盒子打开录音');
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) throw new HttpError(421, 'Host 不受信任');
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(String(origin).toLowerCase())) throw new HttpError(403, 'Origin 不受信任');
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && !['same-origin', 'none'].includes(String(sfs))) throw new HttpError(403, '拒绝跨站请求');
  if ((req.url || '').length > 2048) throw new HttpError(414, 'URL 过长');
}

function param(v, re, what) {
  if (!re.test(v)) throw new HttpError(400, `${what} 无效`);
  return v;
}

async function health() {
  return { ok: true, app: '录音智能体', profile: PROFILE, desktop: typeof process.send === 'function', media: await media.status() };
}

async function acceptRecordingFile(req, name, params) {
  if (!name || !audioType(name)) throw new HttpError(415, '请选择受支持的音频文件');
  if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '需要二进制录音文件');
  const size = Number(req.headers['content-length']);
  const cap = 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, '录音文件大小无效');
  if (size > cap) { req.resume(); throw new HttpError(413, '独立试用版的原音上限为 1 GiB'); }
  const temp = path.join(M.P.tmp, randomUUID() + path.extname(name).toLowerCase());
  let seen = 0;
  const guard = new Transform({ transform(bytes, _encoding, cb) {
    seen += bytes.length;
    if (seen > size) cb(new HttpError(400, '文件长度不符'));
    else cb(null, bytes);
  } });
  try {
    await pipeline(req, guard, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (seen !== size) throw new HttpError(400, '录音传输未完成');
    return await M.importAudio(temp, name, {templateId: params.get('templateId') || undefined, templateRevision: params.has('templateRevision') ? Number(params.get('templateRevision')) : undefined});
  } finally { await fs.rm(temp, { force: true }); }
}

async function route(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const seg = p.split('/').filter(Boolean);
  const is = (m) => method === m;

  if (is('GET') || is('HEAD')) {
    let s = Object.hasOwn(STATIC, p) ? STATIC[p] : null;
    if (PROFILE === 'accessories') {
      if (s === INDEX) {
        res.writeHead(302, { ...SEC_HEADERS, 'Cache-Control': 'no-store', Location: '/accessories' });
        return res.end();
      }
      if (p === '/accessories/storage' || p === '/accessories/storage/drive' || p === '/accessories/nas') s = ['nas.html','text/html; charset=utf-8'];
      if (ACCESSORY_PATH.test(p)) s = INDEX;
    }
    if (s) return sendFile(req, res, path.join(PUBLIC, s[0]), s[1]);
  }
  if (seg[0] !== 'api') throw new HttpError(404, '未找到');

  const agent = req.headers['x-recording-agent'];
  const storageRequest = p.startsWith('/api/nas/') && is('POST');
  if (PROFILE === 'accessories' && agent === 'storage' && !storageRequest)
    throw new HttpError(403, '硬盘管理智能体仅可访问外接硬盘服务');
  if (storageRequest && PROFILE === 'accessories' && process.send) {
    const id=randomUUID(), op=p.slice('/api/nas/'.length), input=await readJsonBody(req);
    const summary = agent === 'catalog' && op === 'volume-status';
    if (!summary && agent !== 'storage') throw new HttpError(403, '请从配件打开硬盘管理智能体');
    const result=await new Promise((resolve,reject) => {
      const done=(error,value) => {
        clearTimeout(timer); process.off('message',receive);
        if (error) reject(new HttpError(503,error)); else resolve(value);
      };
      const receive=m => { if (m?.type==='nas-result' && m.id===id) done(m.error,m.result); };
      const timer=setTimeout(()=>done('盒端等待超时'),op==='ask'?270000:120000);
      process.on('message',receive);
      process.send({type:'nas-request',id,op,input,summary},e=>{if (e) done('宿主连接已关闭');});
    });
    return send(res,200,result);
  }
  if (p === '/api/usb-inputs' && is('GET') && PROFILE === 'accessories' && typeof process.send === 'function') {
    return send(res, 200, await usbInputs());
  }
  if (p === '/api/health' && is('GET')) return send(res, 200, await health());
  if (p === '/api/import-audio' && is('POST')) {
    const imported = await acceptRecordingFile(req, url.searchParams.get('name') || '', url.searchParams);
    return send(res, 202, imported);
  }
  if (p === '/api/audio-imports' && is('POST')) {
    return send(res, 200, await audioImports.begin(await readJsonBody(req)));
  }
  if (seg[1] === 'audio-imports' && seg.length === 3 && is('PUT')) {
    const id = param(seg[2], /^[a-f0-9]{32}$/, '录音导入 ID');
    const offsets = url.searchParams.getAll('offset');
    if (offsets.length !== 1 || !/^(0|[1-9]\d{0,10})$/.test(offsets[0])) throw new HttpError(400, '录音上传位置无效');
    if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '需要二进制录音分片');
    const bytes = await readBody(req, AUDIO_IMPORT_CHUNK_BYTES);
    return send(res, 200, await audioImports.append(id, Number(offsets[0]), bytes));
  }
  if (seg[1] === 'audio-imports' && seg[3] === 'complete' && seg.length === 4 && is('POST')) {
    if (req.headers['content-type'] || req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) {
      await readJsonBody(req);
    }
    return send(res, 202, await audioImports.complete(seg[2]));
  }
  if (p === '/api/recording-capture' && PROFILE === 'accessories') {
    const kind = req.headers['x-recording-agent'];
    if (is('GET')) return send(res, 200, await Lib.recordingCapture(kind, 'status'));
    if (is('POST')) return send(res, 200, await Lib.recordingCapture(kind, (await readJsonBody(req)).action));
  }
  if (p === '/api/settings') {
    if (is('GET')) return send(res, 200, await Lib.getSettings());
    if (is('PUT')) return send(res, 200, await Lib.putSettings(await readJsonBody(req)));
  }
  if (p === '/api/minutes-templates') {
    if (is('GET')) return send(res, 200, await Lib.listMinutesTemplates());
    if (is('PUT')) return send(res, 200, await Lib.saveMinutesTemplate(await readJsonBody(req)));
  }
  if (p === '/api/meetings') {
    if (is('GET')) return send(res, 200, { meetings: M.listMeetings() });
    if (is('POST')) {
      const b = await readJsonBody(req);
      const project = await M.createMeeting({ title: b.title, inputLabel: b.inputLabel, memoryEnabled: b.memoryEnabled, liveCaptionMode: b.liveCaptionMode, liveCloudConsent: b.liveCloudConsent, source: b.source, sampleRate: b.sampleRate, channels: b.channels, templateId: b.templateId, templateRevision: b.templateRevision });
      return send(res, 201, project);
    }
  }
  if (seg[1] === 'meetings' && seg.length >= 3) {
    const id = param(seg[2], RE.meeting, '会议 ID');
    const sub = seg[3];
    if (seg.length === 3) {
      if (is('GET')) return send(res, 200, M.view(id));
      if (is('PATCH')) return send(res, 200, await M.patchMeeting(id, await readJsonBody(req)));
    }
    if (seg.length === 4) {
      if (sub === 'bookmarks' && is('POST')) return send(res, 201, await M.addBookmark(id, await readJsonBody(req)));
      if (sub === 'speakers' && is('PATCH')) return send(res, 200, await M.patchSpeakers(id, await readJsonBody(req)));
      if (sub === 'chunks' && is('POST')) {
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/octet-stream') throw new HttpError(415, '需要 Content-Type: application/octet-stream（PCM16LE 16 kHz 单声道）');
        const raw = url.searchParams.get('seq') ?? req.headers['x-chunk-seq'];
        if (typeof raw !== 'string' || !RE.seq.test(raw)) throw new HttpError(400, 'seq 必须是 0–999999 的整数');
        const buf = await readBody(req, M.LIMITS.chunkMaxBytes);
        return send(res, 201, await M.saveChunk(id, Number(raw), buf));
      }
      if (sub === 'live' && is('POST')) {
        if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '需要 PCM 音频帧');
        const frame = await readBody(req, 6400);
        if (!frame.length || frame.length % 2) throw new HttpError(400, 'PCM 音频帧长度无效');
        const rawOffset = url.searchParams.get('samples');
        const sampleOffset = rawOffset === null ? undefined : Number(rawOffset);
        if (rawOffset !== null && (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(sampleOffset))) {
          throw new HttpError(400, '字幕帧采样位置无效');
        }
        return send(res, 200, await M.pushLiveFrame(id, frame, sampleOffset));
      }
      if (sub === 'finish' && is('POST')) return send(res, 202, await M.finishMeeting(id, await readJsonBody(req)));
      if (sub === 'retry' && is('POST')) {
        const b = await readJsonBody(req);
        return send(res, 202, await M.retryStage(id, b.stage, b));
      }
      if (sub === 'audio' && (is('GET') || is('HEAD'))) {
        const file = M.audioFile(id);
        return sendFile(req, res, file, audioType(file) || 'application/octet-stream');
      }
      if (sub === 'minutes' && is('PUT')) return send(res, 200, await M.saveMinutes(id, await readJsonBody(req)));
      if (PROFILE === 'accessories' && sub === 'save' && is('POST')) return send(res, 200, await M.saveDestination(id, await readJsonBody(req)));
      if (sub === 'confirm' && is('POST')) return send(res, 200, await M.confirmMinutes(id, await readJsonBody(req)));
      if (sub === 'import' && is('POST')) {
        const b = await readJsonBody(req);
        const vid = param(String(b.vaultId || ''), RE.vault, '仓 ID');
        const r = await Lib.importMeeting(M.getMeetingRaw(id), vid);
        if (!r.deduped) await M.recordImport(id, { vaultId: vid, materialId: r.material.id, version: r.material.version, at: r.material.importedAt });
        return send(res, r.deduped ? 200 : 201, r);
      }
    }
    if (seg.length === 5 && sub === 'bookmarks' && (is('PATCH') || is('DELETE'))) {
      const bookmarkId = param(seg[4], /^[0-9a-f-]{36}$/, '重点标记 ID');
      return send(res, 200, await M.changeBookmark(id, bookmarkId, is('PATCH') ? await readJsonBody(req) : null));
    }
  }
  if (p === '/api/space' && is('GET')) return send(res, 200, { root: '试用空间/录音记录', meetings: await M.spaceList() });
  if (seg[1] === 'space' && seg.length === 4 && (is('GET') || is('HEAD'))) {
    const id = param(seg[2], RE.meeting, '会议 ID');
    const key = param(seg[3], /^(audio|transcript|minutes|meta|v[1-9]\d{0,3})$/, '文件键');
    const f = await M.spaceFile(id, key);
    const type = key === 'audio' ? audioType(f.name) || 'application/octet-stream' : key === 'meta' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    return sendFile(req, res, f.file, type, { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(f.name))}` });
  }
  if (seg[1] === 'starmap' && seg[2] === 'vaults') {
    if (seg.length === 3) {
      if (is('GET')) return send(res, 200, { root: '试用星图', vaults: await Lib.listVaults() });
      if (is('POST')) {
        req.resume();
        return send(res, 405, { error: '录音智能体只可导入已有知识仓。' }, { Allow: 'GET' });
      }
    }
    const vid = seg[3] && param(seg[3], RE.vault, '仓 ID');
    if (seg.length === 4 && is('GET')) return send(res, 200, await Lib.getVault(vid));
    if (seg.length === 6 && seg[4] === 'materials' && is('GET')) {
      return send(res, 200, await Lib.getMaterial(vid, param(seg[5], RE.material, '材料 ID')));
    }
  }
  if (p === '/api/memory' && is('GET')) return send(res, 200, { root: '试用记忆', ...(await Lib.listMemory()) });
  if (seg[1] === 'memory' && seg[2] === 'meetings' && seg.length === 4 && is('DELETE')) {
    const id = param(seg[3], RE.meeting, '会议 ID');
    return send(res, 200, { removed: await Lib.removeMeetingMemory(id) });
  }
  throw new HttpError(404, '未找到');
}

const server = http.createServer(async (req, res) => {
  try {
    checkRequest(req);
    const rawPath = String(req.url || '/').split('?')[0];
    if (!rawPath.startsWith('/') || /\.\.|%2e|%2f|%5c|\\/i.test(rawPath)) throw new HttpError(400, '路径无效');
    const url = new URL(req.url, 'http://127.0.0.1');
    // 所有合法路径都是 ASCII 且不含编码字符；拒绝穿越与编码绕过
    if (!/^[A-Za-z0-9/_.-]*$/.test(url.pathname) || url.pathname.includes('..')) throw new HttpError(400, '路径无效');
    await route(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.destroy();
    send(res, status, { error: status === 500 ? '服务器内部错误' : e.message, ...(e.extra || {}) });
  }
});
server.requestTimeout = 120000;
server.headersTimeout = 20000;

await M.initStore(DATA_DIR);
await M.openLegacyProjects(process.env.RECORDING_LEGACY_DATA);
const audioImports = await createAudioImports(DATA_DIR, M);
if (PROFILE === 'accessories') {
  let retrying = false;
  setInterval(async () => {
    if (retrying) return;
    retrying = true;
    try { await M.retryPendingCapture(); }
    catch { /* A later pass can retry when local settings are readable. */ }
    finally { retrying = false; }
  }, 60000).unref();
}
process.on('message', message => {
  if (message?.type !== 'recording-media') return;
  attachMedia(message.env);
  void M.openLegacyProjects(message.legacy).catch(() => console.warn('读取旧版录音档案失败'))
    .finally(() => { if (process.connected) process.send({type:'recording-media-ready'}); });
});
server.listen(Number(PORT_ENV), HOST, () => {
  const port = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const entryPath = PROFILE === 'accessories' ? '/accessories' : '/';
  console.log(`录音智能体 · 独立试用  http://127.0.0.1:${port}${entryPath}`);
  console.log('模式：盒端接口');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
