import { lstat, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

async function* readLines(input) {
  let accumulated = EMPTY;
  let oversized = false;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!oversized) {
        oversized = accumulated.length + part.length > MAX_REQUEST_BYTES;
        accumulated = oversized ? EMPTY : Buffer.concat([accumulated, part]);
      }
      if (newline < 0) break;
      yield oversized ? null : accumulated.toString('utf8');
      accumulated = EMPTY;
      oversized = false;
      offset = end + 1;
    }
  }
  if (oversized || accumulated.length) yield oversized ? null : accumulated.toString('utf8');
}

async function readDescriptor(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('bad_descriptor');
  const info = await lstat(filename);
  if (!info.isFile() || info.size > 4096) throw new Error('bad_descriptor');
  const content = await readFile(filename, 'utf8');
  if (content.length > 4096) throw new Error('bad_descriptor');
  const value = JSON.parse(content);
  if (!value || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token)) {
    throw new Error('bad_descriptor');
  }
  return value;
}

async function readReply(response, notification) {
  if (response.statusCode < 200 || response.statusCode > 299) {
    response.destroy();
    throw new Error('bridge_http_error');
  }
  if (notification) {
    response.destroy();
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('bridge_reply_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function forward(filename, message, notification) {
  // Reload the private descriptor after a client restart or token rotation.
  const {port, token} = await readDescriptor(filename);
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false,
      headers: {'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(payload)},
      signal: AbortSignal.timeout(message.method === 'tools/call' && message.params?.name?.startsWith('xingtu_') ? 330000 : 60000),
    }, response => { readReply(response, notification).then(resolve, reject); });
    outgoing.once('error', reject);
    outgoing.end(payload);
  });
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id, error: {code, message}})}\n`);
}

async function handle(filename, line) {
  if (line === null) return writeError(null, -32600, 'JSON-RPC 请求过大。');
  if (!line.trim()) return;
  let value;
  try { value = JSON.parse(line); } catch { return writeError(null, -32700, 'JSON-RPC 无法解析。'); }
  if (!value || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return writeError(null, -32600, 'JSON-RPC 请求无效。');
  const notification = !Object.hasOwn(value, 'id');
  if (!notification && typeof value.id !== 'string' && !Number.isSafeInteger(value.id)) return writeError(null, -32600, 'JSON-RPC 请求标识无效。');
  try {
    const result = await forward(filename, value, notification);
    if (notification) return;
    if (!result || result.jsonrpc !== '2.0' || result.id !== value.id || Object.hasOwn(result, 'result') === Object.hasOwn(result, 'error')) {
      throw new Error('bridge_invalid_reply');
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    if (!notification) writeError(value.id, -32000, '无法连接本机的记忆盒子客户端。请打开客户端并检查「我的 AI」中的资料连接。');
  }
}

async function main(filename) {
  const active = new Set();
  for await (const line of readLines(process.stdin)) {
    const completed = handle(filename, line).finally(() => active.delete(completed));
    active.add(completed);
    if (active.size >= 8) await Promise.race(active);
  }
  await Promise.all(active);
}

main(process.argv[2]).catch(() => { process.exitCode = 1; });
