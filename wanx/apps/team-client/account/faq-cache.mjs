import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, mkdir, writeFile, rename, unlink, appendFile } from "node:fs/promises";
import path from "node:path";

export const FAQ_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const RETRIES = [60_000, 300_000, 1_800_000, 3_600_000];
const validEtag = value => typeof value === "string" && /^(?:W\/)?"[\x21\x23-\x7e]{1,160}"$/.test(value);
export function validFaq(data) {
  const id = value => Number.isSafeInteger(value) && value > 0 || typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
  return data && typeof data === "object" && typeof data.version === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.version) &&
    (data.updatedAt === null || typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))) &&
    Array.isArray(data.categories) && data.categories.every(row => row && id(row.id) && typeof row.name === "string" &&
      Array.isArray(row.items) && row.items.every(item => item && id(item.id) && typeof item.question === "string" && typeof item.answer === "string"));
}

// Public content only. Neither renderer reads nor IPC can force a network check.
export function createFaqCache({ directory, baseURL, edition, fetch, changed = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const scope = createHash("sha256").update(`${edition}:${new URL(baseURL).href}`).digest("hex").slice(0, 24);
  const cacheFile = path.join(directory, `faq-${scope}.json`);
  const logFile = path.join(directory, `faq-${scope}.jsonl`);
  let record = null, pending = null, timer = null, nextCheckAt = 0, failures = 0;
  let started = false, closed = false, lastError = null, logWrites = Promise.resolve();
  function log(event, errorCode) {
    const entry = { at: new Date(now()).toISOString(), event, version: record?.data.version || null,
      lastCheckedAt: record?.lastCheckedAt || null, updatedAt: record?.updatedAt || null,
      ...(errorCode ? { errorCode } : {}) };
    logWrites = logWrites.then(async () => {
      await mkdir(directory, { recursive: true });
      // Bounded diagnostic history; never logs FAQ text, contacts or credentials.
      if ((await stat(logFile).catch(() => null))?.size > 256 * 1024) await writeFile(logFile, "");
      await appendFile(logFile, JSON.stringify(entry) + "\n");
    }).catch(() => {});
  }
  const loaded = (async () => {
    try {
      const info = await stat(cacheFile);
      if (!info.isFile() || info.size > MAX_BYTES) throw Error("FAQ_INVALID_CACHE");
      const value = JSON.parse(await readFile(cacheFile, "utf8"));
      if (value.schema !== 1 || value.scope !== scope || !validFaq(value.data) || !validEtag(value.etag) ||
          !Number.isFinite(value.lastCheckedAt) || !Number.isFinite(value.updatedAt)) throw Error("FAQ_INVALID_CACHE");
      record = value;
    } catch (error) { if (error.code !== "ENOENT") log("cache-rejected", "FAQ_INVALID_CACHE"); }
  })();
  function schedule(delay) {
    clearTimer(timer); nextCheckAt = now() + delay;
    timer = setTimer(() => { void check(); }, delay); timer?.unref?.();
  }
  async function persist() {
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      await rename(temporary, cacheFile);
    } catch { await unlink(temporary).catch(() => {}); log("cache-write-failed", "FAQ_CACHE_WRITE_FAILED"); }
  }
  function check() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      await loaded;
      if (closed) return;
      try {
        let result = await fetch(record ? { etag: record.etag } : {});
        if (closed) return;
        if (result?.notModified && !record) result = await fetch({});
        if (closed) return;
        if (result?.notModified && record) {
          record = { ...record, lastCheckedAt: now(), etag: validEtag(result.etag) ? result.etag : record.etag };
        } else {
          if (!validFaq(result?.data) || !validEtag(result?.etag) || Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES - 1024)
            throw Object.assign(Error("FAQ_INVALID_RESPONSE"), { code: "FAQ_INVALID_RESPONSE" });
          const different = record?.data.version !== result.data.version;
          record = { schema: 1, scope, data: result.data, etag: result.etag, lastCheckedAt: now(),
            updatedAt: different ? now() : record.updatedAt };
        }
        lastError = null; failures = 0;
        await persist(); log("check-succeeded");
        if (!closed) schedule(FAQ_CHECK_INTERVAL);
      } catch (error) {
        if (closed) return;
        lastError = ["FAQ_RATE_LIMITED", "FAQ_INVALID_RESPONSE", "ACCOUNT_NETWORK_ERROR", "ACCOUNT_CANCELLED"].includes(error.code)
          ? error.code : "FAQ_UNAVAILABLE";
        log("check-failed", lastError);
        schedule(RETRIES[Math.min(failures++, RETRIES.length - 1)]);
      } finally {
        if (pending === task) pending = null;
        if (!closed) changed();
      }
    });
    pending = task;
    return task;
  }
  return {
    cacheFile, logFile,
    start() { if (!started && !closed) { started = true; void check(); } },
    checkDue() { if (!closed && started && now() >= nextCheckAt) return check(); },
    async read() {
      await loaded;
      return { data: record ? structuredClone(record.data) : null, etag: record?.etag || null,
        loading: Boolean(pending), errorCode: lastError };
    },
    async close() { closed = true; clearTimer(timer); await logWrites; },
  };
}
