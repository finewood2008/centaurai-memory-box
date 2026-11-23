import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { readMemoryConnection } from "./local-memory-runtime.mjs";

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 100_000;
const PREVIEW_TTL = 15 * 60_000;
const SOURCE = "claude_desktop";
const digest = value => createHash("sha256").update(value).digest("hex");
const invalid = message => Object.assign(new Error(message), { status: 400 });
const idOf = row => [row?.uuid, row?.id].find(value => typeof value === "string" && /^[a-z0-9_-]{1,160}$/i.test(value));
const conversationFile = /^conversations(?:[-_.]\d+)?\.json$/i;

async function readJsonBytes(stream, limit, check, expectedCrc) {
  const chunks = [];
  let size = 0;
  let checksum = 0;
  for await (const chunk of stream) {
    check();
    size += chunk.length;
    if (size > limit) throw invalid("对话 JSON 合计超过 100 MB，请分批选择导出文件。");
    if (expectedCrc !== undefined) checksum = crc32(chunk, checksum);
    chunks.push(chunk);
  }
  if (expectedCrc !== undefined && checksum !== expectedCrc) throw invalid("导出压缩包校验失败，请重新下载。");
  return Buffer.concat(chunks, size);
}

async function* conversationJson(file, check) {
  if (!path.isAbsolute(file) || file.startsWith("\\\\")) throw invalid("请选择本机的 Claude 导出文件。");
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".json" && extension !== ".zip") throw invalid("请选择 Claude 导出的 ZIP 或对话 JSON。");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw invalid("无法读取导出文件，请重新选择。");
  let zip;
  try {
    if (!(await handle.stat()).isFile()) throw invalid("请选择普通文件。");
    if (extension === ".json") {
      yield await readJsonBytes(handle.createReadStream({ autoClose: false }), MAX_JSON_BYTES, check);
      return;
    }
    zip = await yauzl.fromFdPromise(handle.fd, { autoClose: false, strictFileNames: true });
    const names = new Set();
    let remaining = MAX_JSON_BYTES;
    for await (const entry of zip.eachEntry()) {
      check();
      if (!conversationFile.test(path.posix.basename(entry.fileName))) continue;
      const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if ((fileType !== 0 && fileType !== 0o100000) || names.has(entry.fileName)) throw invalid("导出压缩包包含无效的对话文件。");
      names.add(entry.fileName);
      if (entry.uncompressedSize > remaining) throw invalid("对话 JSON 合计超过 100 MB，请解压后分批导入。");
      const bytes = await readJsonBytes(await zip.openReadStreamPromise(entry), remaining, check, entry.crc32);
      remaining -= bytes.length;
      yield bytes;
    }
    if (!names.size) throw invalid("ZIP 中没有找到 Claude 的 conversations.json 对话文件。");
  } catch (error) {
    check();
    if (error.status === 400) throw error;
    throw invalid("无法打开 Claude 导出文件，请检查 ZIP 或 JSON 是否完整。");
  } finally {
    // The FileHandle owns the descriptor and closes it after all entry streams finish.
    await handle.close();
  }
}

function visibleText(message) {
  const blocks = Array.isArray(message.content) ? message.content
    .filter(block => block?.type === "text" && typeof block.text === "string" && block.text.trim())
    .map(block => block.text) : [];
  const text = blocks.length ? blocks.join("\n\n") : message.text;
  return typeof text === "string" && text.trim() ? text.toWellFormed() : "";
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : undefined;
}

async function readHistory(file, check) {
  const records = new Map();
  const conversations = new Set();
  const messages = new Set();
  const fingerprint = createHash("sha256");
  let skippedMessages = 0;
  for await (const bytes of conversationJson(file, check)) {
    fingerprint.update(digest(bytes));
    let json;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw invalid("Claude 对话 JSON 格式无效或已损坏。"); }
    const chats = Array.isArray(json) ? json : json?.conversations;
    if (!Array.isArray(chats) || chats.some(chat => !idOf(chat) || !Array.isArray(chat.chat_messages)))
      throw invalid("文件不是 Claude 对话导出。请选择 ZIP 或其中的 conversations.json。");
    for (const chat of chats) {
      check();
      const conversation = idOf(chat);
      const title = (typeof chat.name === "string" ? chat.name.replace(/\s+/g, " ").trim().slice(0, 90).toWellFormed() : "") || "Claude Chat 对话";
      for (const [index, message] of chat.chat_messages.entries()) {
        const speaker = ["human", "user"].includes(message?.sender) ? "用户" : message?.sender === "assistant" ? "Claude" : null;
        const text = speaker ? visibleText(message) : "";
        if (!text) { skippedMessages++; continue; }
        const messageKey = JSON.stringify([conversation, idOf(message) ?? index]);
        if (messages.has(messageKey)) continue;
        messages.add(messageKey);
        conversations.add(conversation);
        const createdAt = timestamp(message.created_at) ?? timestamp(chat.created_at);
        for (let start = 0, part = 0; start < text.length; part++) {
          let end = Math.min(start + MAX_MESSAGE_CHARS, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          records.set(JSON.stringify([messageKey, part]), { title: `${title} · ${speaker}${part ? `（续 ${part}）` : ""}`,
            body: text.slice(start, end), createdAt });
          start = end;
        }
      }
    }
  }
  if (!records.size) throw invalid("这份导出没有可导入的 Chat 文本消息。");
  return { records, fingerprint: fingerprint.digest("hex"), conversationCount: conversations.size,
    messageCount: messages.size, skippedMessages };
}

function asMemoryContent(body, title) {
  // The local reader preserves role headings inside a chat_selection fence as text.
  const longestFence = (body.match(/`{3,}/g) ?? []).reduce((longest, marker) => Math.max(longest, marker.length), 2);
  const fence = "`".repeat(longestFence + 1);
  return `${fence}chat_selection\n${body}\n${fence}\n\n${title}`;
}

export function createClaudeChatHistoryImport({ runtimeFile, chooseFile, identity, request = fetch }) {
  let pending;
  let busy = false;

  async function action(method, input, assertScope, signal) {
    if (busy) throw invalid("正在处理 Claude 历史导入，请稍候。");
    const owner = identity();
    const check = () => {
      assertScope();
      if (!owner || identity() !== owner) throw invalid("记忆库已切换，请重新选择 Claude 导出文件。");
    };
    busy = true;
    try {
      check();
      if (method === "preview") {
        pending = undefined;
        if (Object.keys(input).length) throw invalid("请通过文件选择窗口选择 Claude 导出文件。");
        const file = await chooseFile();
        check();
        if (!file) return { canceled: true };
        const history = await readHistory(file, check);
        check();
        pending = { id: randomUUID(), file, owner, fingerprint: history.fingerprint, expires: Date.now() + PREVIEW_TTL };
        return { previewId: pending.id, name: path.basename(file), conversationCount: history.conversationCount,
          messageCount: history.messageCount, recordCount: history.records.size, skippedMessages: history.skippedMessages };
      }
      if (method !== "commit" || Object.keys(input).length !== 1 || !pending || pending.id !== input.previewId ||
          pending.owner !== owner || pending.expires < Date.now()) throw invalid("导入预览已失效，请重新选择文件。");
      const history = await readHistory(pending.file, check);
      if (history.fingerprint !== pending.fingerprint) {
        pending = undefined;
        throw invalid("导出文件已变化，请重新预览后导入。");
      }
      check();
      const { base, token } = await readMemoryConnection(runtimeFile).catch(() => {
        throw invalid("本机记忆服务暂不可用，请连接后重试。");
      });
      let imported = 0;
      let skipped = 0;
      for (const [key, entry] of history.records) {
        check();
        const requestId = digest(JSON.stringify([owner, key]));
        try {
          const response = await request(new URL("/api/v1/memory/add", base), {
            method: "POST", headers: { "x-memmy-local-token": token, "content-type": "application/json" },
            body: JSON.stringify({ content: asMemoryContent(entry.body, entry.title), title: entry.title, createdAt: entry.createdAt,
              requestId, turnId: requestId, layer: "L1", source: SOURCE, sourceAgentId: SOURCE,
              adapterId: `agent-source:${SOURCE}`, tags: ["claude-chat-history"], deferProcessing: true }),
            redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)].filter(Boolean)),
          });
          const result = await response.json();
          check();
          if (response.status === 409 && /idempotency key reused/i.test(result.error?.message ?? "")) skipped++;
          else if (response.ok && typeof result.id === "string") {
            if (result.duplicate) skipped++;
            else imported++;
          } else throw new Error("memory_add_failed");
        } catch {
          check();
          return { imported, skipped, remaining: history.records.size - imported - skipped };
        }
      }
      pending = undefined;
      return { imported, skipped, remaining: 0 };
    } finally { busy = false; }
  }

  return { action };
}
