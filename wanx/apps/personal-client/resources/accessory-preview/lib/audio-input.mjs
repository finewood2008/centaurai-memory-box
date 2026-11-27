import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;
const MAX_PROCESSING_BYTES = 256 * 1024 * 1024;
const TIMELINE_TOLERANCE_MS = 250;
export const MAX_DIARIZATION_AUDIO_MS = 8 * HOUR_MS;
const formats = new Map([
  ['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.mp4', 'audio/mp4'],
  ['.flac', 'audio/flac'], ['.ogg', 'audio/ogg'], ['.aac', 'audio/aac'], ['.webm', 'audio/webm'],
]);
export const audioType = (file) => formats.get(path.extname(file).toLowerCase());

async function command(bin, args, label, timeout = 10 * 60 * 1000) {
  try { return await run(bin, args, { timeout, maxBuffer: 512 * 1024, windowsHide: true }); }
  catch (error) {
    if (['ENOENT', 'EACCES', 'ENOTDIR', 'ENOEXEC'].includes(error.code)) {
      throw Object.assign(new Error('本机音频组件缺失或无法启动，请修复安装后重试；原音已保留。'), { code: 'AUDIO_TOOL_UNAVAILABLE', audioToolUnavailable: true });
    }
    throw new Error(label);
  }
}

export async function probeAudio(file) {
  const { stdout } = await command(process.env.FFPROBE_BIN || 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'a:0',
    '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', file,
  ], '无法读取音频，请检查格式或音频工具配置');
  const data = JSON.parse(stdout);
  const durationMs = Math.round(Number(data.format?.duration) * 1000);
  if (!data.streams?.length || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('文件里没有可用的音频');
  return { durationMs, sampleRate: Number(data.streams[0].sample_rate), channels: Number(data.streams[0].channels) };
}

export async function prepareParts(file, durationMs, limits, directory) {
  const { info, maxInputBytes } = limits;
  const maxSeconds = info.maxDurationSeconds;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 100000) {
    throw new Error('盒端文件转写限制无效');
  }
  const format = path.extname(file).slice(1).toLowerCase();
  if (durationMs <= maxSeconds * 1000 && (await fs.stat(file)).size <= maxInputBytes && info.formats?.includes(format)) {
    return [{ file, offsetMs: 0, durationMs }];
  }
  if (!info.formats?.includes('wav')) throw new Error('当前盒端需要受支持的音频格式');
  const seconds = Math.min(1200, Math.floor(maxSeconds / 2), Math.floor((maxInputBytes - 4096) / 32000) - 1);
  if (seconds < 1) throw new Error('盒端分段容量过小');
  await fs.mkdir(directory, { recursive: true });
  await command(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', file, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(seconds),
    '-reset_timestamps', '1', path.join(directory, 'part-%06d.wav'),
  ], '无法生成可独立转写的音频分段', durationMs > HOUR_MS ? 2 * HOUR_MS : undefined);
  const parts = [];
  let offsetMs = 0;
  for (const name of (await fs.readdir(directory)).filter((n) => /^part-\d{6}\.wav$/.test(n)).sort()) {
    const part = path.join(directory, name);
    const duration = (await probeAudio(part)).durationMs;
    if ((await fs.stat(part)).size > maxInputBytes || duration > maxSeconds * 1000) throw new Error('切分音频超出目标盒限制');
    parts.push({ file: part, offsetMs, durationMs: duration });
    offsetMs += duration;
  }
  if (!parts.length) throw new Error('没有可转写的音频分段');
  return parts;
}

// Speaker identities only make sense over one recording. Resample the entire
// source when necessary, using no trim, seek, timestamp offsets, or chunks.
export async function prepareDiarizationAudio(file, durationMs, { info, maxInputBytes }, directory) {
  const maxSeconds = info.maxDiarizationDurationSeconds;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds <= 0 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new Error('盒端说话人校正限制无效');
  }
  const maxDurationMs = Math.min(maxSeconds * 1000, MAX_DIARIZATION_AUDIO_MS);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > maxDurationMs) {
    throw new Error('录音超出盒端说话人校正时长上限');
  }
  const long = durationMs > HOUR_MS;
  const maxBytes = Math.min(maxInputBytes, MAX_PROCESSING_BYTES);
  const format = path.extname(file).slice(1).toLowerCase();
  if (!long && (await fs.stat(file)).size <= maxBytes && info.formats?.includes(format)) return file;
  const outputFormat = long ? 'ogg' : 'wav';
  // 32 kbit/s plus a conservative allowance for Ogg framing and headers.
  const estimatedBytes = long ? Math.ceil(durationMs * 4.4) + 65536 : durationMs * 32 + 44;
  if (!info.formats?.includes(outputFormat) || estimatedBytes > maxBytes) {
    throw new Error('完整录音超出盒端说话人校正容量或目标盒子不支持长录音格式');
  }
  await fs.mkdir(directory, { recursive: true });
  const normalized = path.join(directory, 'recording.' + outputFormat);
  const codec = long ? ['-c:a', 'libopus', '-b:a', '32k', '-vbr', 'off', '-f', 'ogg'] : ['-c:a', 'pcm_s16le'];
  await command(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', file, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000', ...codec, '-map_metadata', '-1',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', normalized,
  ], '无法准备完整的说话人校正音频', long ? 2 * HOUR_MS : undefined);
  const converted = await probeAudio(normalized);
  // Ogg Opus reports 48 kHz and includes container pre-skip in its duration.
  if (converted.channels !== 1 || converted.sampleRate !== (long ? 48000 : 16000) ||
      Math.abs(converted.durationMs - durationMs) > TIMELINE_TOLERANCE_MS || (await fs.stat(normalized)).size > maxBytes) {
    throw new Error('转换后的完整音频超出盒端限制或与原音时间轴不一致');
  }
  return normalized;
}
