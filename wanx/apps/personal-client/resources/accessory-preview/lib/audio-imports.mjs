import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { audioType } from './audio-input.mjs';
import { HttpError, readJson, RE, syncDirectory, withLock, writeJson } from './util.mjs';

export const AUDIO_IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_IMPORT_BYTES = 16 * 1024 ** 3;
const ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function metadata(input) {
  const { name, size, lastModified, fingerprint, templateId, templateRevision } = input;
  if (typeof name !== 'string' || !name.length || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, '录音文件名无效');
  }
  if (!audioType(name)) throw new HttpError(415, '请选择受支持的音频文件');
  if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, '录音文件大小无效');
  if (size > MAX_AUDIO_IMPORT_BYTES) throw new HttpError(413, '录音文件最多 16 GiB');
  if (!Number.isSafeInteger(lastModified) || lastModified < 0 || typeof fingerprint !== 'string' || !SHA256.test(fingerprint)) {
    throw new HttpError(400, '录音文件校验信息无效');
  }
  if (templateId !== undefined && (typeof templateId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(templateId)) ||
      templateRevision !== undefined && (!Number.isSafeInteger(templateRevision) || templateRevision < 1)) {
    throw new HttpError(400, '录音纪要模板无效');
  }
  return { name, size, lastModified, fingerprint, templateId, templateRevision };
}

const importId = fields => createHash('sha256').update(JSON.stringify([
  fields.name, fields.size, fields.lastModified, fields.fingerprint, fields.templateId, fields.templateRevision,
])).digest('hex').slice(0, 32);

const receipt = record => ({ id: record.id, offset: record.offset, chunkBytes: AUDIO_IMPORT_CHUNK_BYTES });
const sha256 = () => createHash('sha256');

async function readExact(handle, buffer, position) {
  for (let count = 0; count < buffer.length;) {
    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, position + count);
    if (!bytesRead) throw new HttpError(409, '本地录音分片不完整，请重新选择原文件');
    count += bytesRead;
  }
}

async function requireWritableStaging(handle) {
  if ((await handle.stat()).nlink !== 1) throw new HttpError(409, '本地录音已关联归档，分片不能再写入');
}

async function verifyAudio(handle, size) {
  const fingerprint = sha256();
  const content = sha256();
  const block = Buffer.allocUnsafe(Math.min(size, AUDIO_IMPORT_CHUNK_BYTES));
  for (let position = 0; position < size; position += block.length) {
    const bytes = block.subarray(0, Math.min(block.length, size - position));
    await readExact(handle, bytes, position);
    content.update(bytes);
    fingerprint.update(sha256().update(bytes).digest());
  }
  return { fingerprint: fingerprint.digest('hex'), inputSha256: content.digest('hex') };
}

export async function createAudioImports(dataDirectory, { importAudio, findImportedAudio, view }) {
  const directory = path.join(dataDirectory, 'audio-imports');
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('录音导入目录无效');
  await syncDirectory(dataDirectory);

  const stateFile = id => path.join(directory, id + '.json');
  const stagedFile = record => path.join(directory, record.id + path.extname(record.name).toLowerCase());
  const serialized = (id, fn) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new HttpError(400, '录音导入 ID 无效');
    return withLock('audio-import:' + directory + ':' + id, async () => {
      try { return await fn(); }
      catch (error) {
        if (['ENOSPC', 'EDQUOT'].includes(error.code)) throw new HttpError(507, '本机空间不足，腾出空间后可继续录音导入');
        throw error;
      }
    });
  };

  async function save(record) {
    await writeJson(stateFile(record.id), record);
    await syncDirectory(directory);
  }

  async function load(id) {
    const file = stateFile(id);
    const info = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) return null;
    if (!info.isFile() || info.size > 8192) throw new Error('录音导入记录无效');
    const record = await readJson(file);
    if (record.schema !== 1 || record.id !== id || importId(metadata(record)) !== id ||
        !Number.isSafeInteger(record.offset) || record.offset < 0 || record.offset > record.size ||
        (record.offset !== record.size && record.offset % AUDIO_IMPORT_CHUNK_BYTES !== 0) ||
        (record.meetingId !== undefined && (record.offset !== record.size || !RE.meeting.test(record.meetingId)))) {
      throw new Error('录音导入记录无效');
    }
    return record;
  }

  async function openStaged(record) {
    const file = stagedFile(record);
    if (!(await fs.lstat(file)).isFile()) throw new HttpError(409, '本地录音分片无效');
    const handle = await fs.open(file, constants.O_RDWR | NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < record.offset) {
        throw new HttpError(409, '已保存的本地录音分片不完整');
      }
      // An interrupted append may have reached disk before its committed offset.
      if (stat.size > record.offset) {
        await requireWritableStaging(handle);
        await handle.truncate(record.offset);
        await handle.sync();
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async function begin(input) {
    const fields = metadata(input);
    const id = importId(fields);
    return serialized(id, async () => {
      let record = await load(id);
      if (!record) {
        record = { schema: 1, id, ...fields, offset: 0 };
        try {
          const handle = await fs.open(stagedFile(record), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
          try { await handle.sync(); } finally { await handle.close(); }
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          await (await openStaged(record)).close();
        }
        await save(record);
      } else if (!record.meetingId) {
        await (await openStaged(record)).close();
      }
      return receipt(record);
    });
  }

  async function append(id, offset, bytes) {
    return serialized(id, async () => {
      const record = await load(id);
      if (!record) throw new HttpError(404, '录音导入不存在，请重新选择原文件');
      if (offset !== record.offset || record.offset === record.size) {
        throw new HttpError(409, '录音上传位置已更新', { expectedOffset: record.offset });
      }
      if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(AUDIO_IMPORT_CHUNK_BYTES, record.size - offset)) {
        throw new HttpError(400, '录音分片长度不符', { expectedOffset: record.offset });
      }
      const handle = await openStaged(record);
      try {
        await requireWritableStaging(handle);
        for (let written = 0; written < bytes.length;) {
          const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!bytesWritten) throw new Error('录音分片未能写入');
          written += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      const next = { ...record, offset: offset + bytes.length };
      await save(next);
      return receipt(next);
    });
  }

  async function complete(id) {
    return serialized(id, async () => {
      const record = await load(id);
      if (!record) throw new HttpError(404, '录音导入不存在，请重新选择原文件');
      if (record.offset !== record.size) throw new HttpError(409, '录音上传未完成', { expectedOffset: record.offset });
      if (record.meetingId) {
        await fs.rm(stagedFile(record), { force: true }).catch(() => {});
        return view(record.meetingId);
      }
      let meeting = findImportedAudio(id);
      if (!meeting) {
        const handle = await openStaged(record);
        let verified;
        try {
          verified = await verifyAudio(handle, record.size);
          if (verified.fingerprint !== record.fingerprint) {
            await requireWritableStaging(handle);
            // Keep a recoverable zero-offset receipt across another interruption.
            await save({ ...record, offset: 0 });
            await handle.truncate(0);
            await handle.sync();
            throw new HttpError(409, '录音内容未通过校验，请重新上传', { expectedOffset: 0 });
          }
        } finally {
          await handle.close();
        }
        meeting = await importAudio(stagedFile(record), record.name, {
          importId: id, inputSha256: verified.inputSha256, templateId: record.templateId, templateRevision: record.templateRevision,
        });
      }
      await save({ ...record, meetingId: meeting.id });
      await fs.rm(stagedFile(record), { force: true }).catch(() => {});
      return meeting;
    });
  }

  return { begin, append, complete };
}
