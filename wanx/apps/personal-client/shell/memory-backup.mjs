import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGzip, createGunzip } from "node:zlib";
import sdk from "../host-sdk/drive.cjs";

const storageRoute = "/api/local-data/wanx-storage";
const interval = 5 * 60_000;
const managedFolderName = "半人马AI记忆备份";
const entryId = /^[a-f0-9]{32}$/;
const backupName = /^半人马AI-记忆备份-[a-f0-9]{32}-[a-f0-9]{32}\.sqlite(?:\.gz)?$/;
const retryableReadCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "CONNECT_TIMEOUT", "NETWORK_NOT_READY", "NETWORK_CHANGED", "BOX_CONNECTION_REQUIRED", "SESSION_CLOSED", "GATEWAY_CLOSED",
  "SPACE_CONNECTION_TIMEOUT", "tunnel_timeout", "netbird_peer_disconnected", "network_unavailable", "network_recovering"]);
const retryableReadStatuses = new Set([408, 429, 502, 503, 504]);
const fail = message => new Error(message);

export function createMemoryBackup({ client, space, store, stagingRoot, protect, localRequest, accountScope = () => space.snapshot().scope, intervalMs = interval, now = Date.now }) {
  let connectionKey, controller, running, runningScope, closed = false, phase, progress, lastError, statusFor, nextAttempt = 0;
  let settingsWrite = Promise.resolve(), storeWrite = Promise.resolve();
  let availableBackup;
  let preferences = store.load().then(value => value || {});
  void preferences.catch(() => {});

  function scopeKey(scope = space.snapshot().scope) {
    return scope ? createHash("sha256").update(scope).digest("hex") : null;
  }

  function settingsKey() {
    const account = accountScope();
    return account ? "settings:" + createHash("sha256").update(account).digest("hex") : null;
  }

  function enabled(data, current) {
    return (data[settingsKey()]?.enabled ?? data[current?.key]?.enabled) !== false;
  }

  function scheduleMs(data) {
    const minutes = data[settingsKey()]?.intervalMinutes;
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes * 60_000 : intervalMs;
  }

  function context() {
    const { scope, dataContextId } = space.snapshot();
    return scope && dataContextId ? {
      key: scopeKey(scope),
      ticket: createHash("sha256").update(dataContextId).digest("hex"),
      dataContextId,
    } : null;
  }

  function sync() {
    const next = context()?.dataContextId;
    if (runningScope && scopeKey() !== runningScope) controller?.abort();
    if (statusFor && scopeKey() !== statusFor) availableBackup = undefined;
    if (next === connectionKey) return;
    connectionKey = next;
    nextAttempt = 0;
    if (next) void checkAutomatically();
  }

  async function scopedDrive(current, signal) {
    const check = () => {
      signal.throwIfAborted();
      if (closed || scopeKey() !== current.key) throw fail("账号或盒子已切换。");
    };
    check();
    let connection = await client.applicationConnection();
    check();
    return sdk.createDriveClient({
      context: async () => { check(); return connection.context(); },
      async request(route, { method = "GET", body, headers, timeoutMs, signal: requestSignal }) {
        const attempts = method === "GET" ? 8 : 1;
        const bytes = body instanceof Uint8Array;
        for (let attempt = 0; attempt < attempts; attempt++) {
          check();
          requestSignal?.throwIfAborted();
          const timeout = AbortSignal.timeout(timeoutMs);
          try {
            if (attempt) connection = await client.applicationConnection();
            connection.context();
            const result = await connection.request({
              path: route, method,
              signal: AbortSignal.any([signal, timeout, ...(requestSignal ? [requestSignal] : [])]),
              headers: { ...(body && !bytes ? { "content-type": "application/json" } : {}), ...headers },
              body: body && !bytes ? JSON.stringify(body) : body,
              ...(method === "PUT" ? { idleTimeoutMs: 15_000, freshConnection: true } : {}),
              ...(attempt ? { freshConnection: true } : {}),
            });
            check();
            connection.context();
            if (attempt + 1 === attempts || !retryableReadStatuses.has(result.status)) {
              const payload = [204, 205, 304].includes(result.status) ? null : result.body;
              return new Response(payload, { status: result.status, headers: result.headers });
            }
          } catch (error) {
            if (attempt + 1 === attempts || (!timeout.aborted && !retryableReadCodes.has(error?.code ?? error?.message))) throw error;
          }
          await delay(Math.min(400 * 2 ** attempt, 8_000), undefined, { signal });
        }
      },
    });
  }

  async function folder(drive, parent, signal) {
    if (parent !== "" && !entryId.test(parent)) throw fail("空间文件夹无效。");
    const page = await drive.list({ parent, signal });
    if (!(page?.root === "" || entryId.test(page?.root)) || page.space_id !== "personal" || page.parent !== (parent || page.root) ||
        !Array.isArray(page.items) || !Array.isArray(page.breadcrumbs)) throw fail("无法读取盒子的个人空间。");
    const items = page.items.filter(item => entryId.test(item.id) && item.parent === page.parent && !item.trashed);
    const backups = items.filter(item => item.kind === "file" && backupName.test(item.name) && /^[a-f0-9]{64}$/.test(item.digest));
    backups.sort((a, b) => b.modified - a.modified || b.id.localeCompare(a.id));
    return {
      parent, name: page.breadcrumbs.map(item => item.name).join(" / ") || "个人空间",
      up: page.breadcrumbs.at(-2)?.id ?? "",
      folders: items.filter(item => item.kind === "folder").map(({ id, name }) => ({ id, name })),
      latest: backups[0] || null, backups,
    };
  }

  async function withStaging(work) {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(stagingRoot);
    const directory = await mkdtemp(path.join(root, "backup-"));
    try {
      await protect(directory);
      return await work(directory);
    } finally {
      if (path.dirname(directory) === root) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  function persist(update, check) {
    const pending = storeWrite.then(async () => {
      check();
      const latest = await preferences;
      check();
      const updated = update(latest);
      await store.save(updated);
      preferences = Promise.resolve(updated);
      return updated;
    });
    storeWrite = pending.catch(() => {});
    return pending;
  }

  async function save(data, current, record, signal) {
    return persist(latest => ({ ...latest, [current.key]: record }), () => {
      signal.throwIfAborted();
      if (scopeKey() !== current.key) throw fail("账号或盒子已切换。");
    });
  }

  async function managedRecord(data, current, drive, signal) {
    const existing = data[current.key];
    if (existing?.managed === true && existing.parent !== undefined) return existing;
    const root = await folder(drive, "", signal);
    let matches = root.folders.filter(item => item.name === managedFolderName);
    if (!matches.length) {
      try { await drive.mkdir({ parent: "", name: managedFolderName, signal }); }
      catch (error) {
        // A concurrent installation may have created the same directory.
        const refreshed = await folder(drive, "", signal);
        if (!refreshed.folders.some(item => item.name === managedFolderName)) throw error;
      }
      matches = (await folder(drive, "", signal)).folders.filter(item => item.name === managedFolderName);
    }
    if (matches.length !== 1) throw fail("暂时无法确认记忆备份位置，请稍后重试。");
    const record = { enabled: existing?.enabled ?? true, managed: true, parent: matches[0].id, name: managedFolderName, writer: existing?.writer ?? randomUUID().replaceAll("-", "") };
    await save(data, current, record, signal);
    return record;
  }

  async function uploadSnapshot(drive, { parent, name, file, size, signal }) {
    const uploadId = randomUUID().replaceAll("-", "");
    const permanent = new Set(["SPACE_DISK_FULL", "SPACE_INVALID_SIZE", "SPACE_NOT_FOUND", "SPACE_LOCAL_FILE_CHANGED", "SPACE_CHUNK_INVALID"]);
    try {
      for (const wait of [0, 1_000, 3_000]) {
        if (wait) await delay(wait, undefined, { signal });
        const data = createReadStream(file, { signal });
        try {
          const entry = await drive.upload({
            parent, name, data, size, uploadId, signal,
            onProgress: ({ offset }) => { progress = { bytes: offset, total: size }; },
          });
          if (entry.id !== uploadId) throw fail("盒端备份标识校验失败。");
          return entry;
        } catch (error) {
          if (signal.aborted || permanent.has(error.code) || wait === 3_000) throw error;
        } finally { data.destroy(); }
      }
    } catch (error) {
      if (!signal.aborted) await drive.cancelUpload(uploadId, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
      throw error;
    }
  }

  async function snapshot(record, data, current, drive, signal) {
    const location = await folder(drive, record.parent, signal);
    const latest = location.latest;
    const ownPrefix = `半人马AI-记忆备份-${record.writer}-`;
    if (latest && latest.digest !== record.digest && !latest.name.startsWith(ownPrefix)) {
      phase = "restore-available";
      availableBackup = { id: latest.id, modified: latest.modified };
      return;
    }
    availableBackup = undefined;
    phase = "backing-up";
    await withStaging(async directory => {
      const result = await localRequest(storageRoute + "/snapshot", { directory }, { signal, timeout: 125_000 });
      if (typeof result?.path !== "string" || path.dirname(result.path) !== directory) throw fail("未能生成本机记忆快照。");
      const archive = path.join(directory, "snapshot.sqlite.gz");
      await pipeline(createReadStream(result.path), createGzip({ level: 1 }), createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
      const checksum = createHash("sha256");
      for await (const bytes of createReadStream(archive, { signal })) checksum.update(bytes);
      const digest = checksum.digest("hex");
      if (latest?.digest === digest) {
        if (record.backupId !== latest.id) await save(data, current, { ...record, digest, backupId: latest.id, lastBackup: latest.modified }, signal);
        phase = "ready";
        return;
      }
      const fileName = ownPrefix + randomUUID().replaceAll("-", "") + ".sqlite.gz";
      const { size } = await stat(archive);
      const entry = await uploadSnapshot(drive, { parent: record.parent, name: fileName, file: archive, size, signal });
      if (entry.digest !== digest || entry.name !== fileName) throw fail("盒端备份校验失败。");
      await save(data, current, { ...record, digest, backupId: entry.id, lastBackup: entry.modified }, signal);
      // Retire this installation's snapshots and the exact backup it continued from.
      for (const old of location.backups.filter(item => item.name.startsWith(ownPrefix) ||
        (item.id === record.backupId && item.digest === record.digest))) {
        try {
          await drive.trash(old.id, { signal });
          await drive.purge(old.id, { signal });
        } catch { /* A failed cleanup cannot invalidate the new backup. */ }
      }
      phase = "ready";
    });
  }

  async function restore(location, restoreId, drive, signal) {
    if (!location.latest || location.latest.id !== restoreId) throw fail("备份列表已变化，请刷新后重新选择。");
    phase = "restoring";
    await withStaging(async directory => {
      const source = path.join(directory, "restore.sqlite");
      const data = drive.read(restoreId, { signal });
      const destination = createWriteStream(source, { flags: "wx", mode: 0o600 });
      if (location.latest.name.endsWith(".gz")) {
        await pipeline(data, createGunzip(), destination, { signal });
      } else {
        await pipeline(data, destination, { signal });
      }
      const id = randomUUID();
      signal.throwIfAborted();
      const reply = await localRequest(storageRoute, { id, restoreFrom: source }, { signal, timeout: 125_000 });
      if (!reply?.accepted) throw fail("本机记忆服务未接受恢复请求。");
      const deadline = Date.now() + 120_000;
      do {
        const state = await localRequest(storageRoute, undefined, { signal }).catch(() => null);
        if (state?.result?.id === id) {
          if (state.result.failed) throw fail("恢复失败，原本机记忆库可继续使用。");
          return;
        }
        await delay(500, undefined, { signal });
      } while (Date.now() < deadline);
      throw fail("恢复结果尚未确认，请刷新记忆库后查看。");
    });
  }

  function run(current, work) {
    if (running) throw fail("正在处理记忆备份，请稍候。");
    controller = new AbortController();
    const { signal } = controller;
    runningScope = statusFor = current.key;
    progress = lastError = undefined;
    running = Promise.resolve().then(() => work(signal)).catch(error => {
      if (!signal.aborted) {
        phase = "error";
        if (/^[A-Z][A-Z_0-9]{1,80}$/.test(error?.code || "")) lastError = error.code;
      }
      throw error;
    }).finally(() => { running = controller = runningScope = undefined; });
    return running;
  }

  async function checkAutomatically() {
    if (closed || running || now() < nextAttempt) return;
    const current = context();
    if (!current) return;
    const data = await preferences.catch(() => null);
    nextAttempt = now() + (data ? scheduleMs(data) : intervalMs);
    if (!data || !enabled(data, current) || running || closed || context()?.dataContextId !== current.dataContextId) return;
    await run(current, async signal => {
      const drive = await scopedDrive(current, signal);
      const record = await managedRecord(data, current, drive, signal);
      await snapshot(record, data, current, drive, signal);
    }).catch(() => {});
    if (context()?.key === current.key) nextAttempt = now() + scheduleMs(await preferences);
  }

  const timer = setInterval(() => void checkAutomatically(), Math.min(intervalMs, 15_000));
  timer.unref?.();
  const unsubscribe = client.subscribe(sync);
  sync();
  return {
    async action(action, { id, context: expected, intervalMinutes } = {}) {
      const current = context();
      const setting = settingsKey();
      const data = await preferences;
      if (setting !== settingsKey() || current?.dataContextId !== context()?.dataContextId) throw fail("账号或盒子已切换。");
      const ticket = current?.ticket ?? setting;
      const record = data[current?.key];
      if (action === "status") return {
        connected: Boolean(current), context: ticket, enabled: enabled(data, current), busy: Boolean(running),
        lastBackup: record?.lastBackup, intervalMinutes: scheduleMs(data) / 60_000,
        ...(statusFor === current?.key ? { phase, progress, lastError, availableBackup } : {}),
      };
      if (!setting || expected !== ticket) throw fail("账号或盒子已切换，请重新打开备份设置。");
      if (action === "enable" || action === "disable" || action === "configure") {
        if (action === "configure" && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)) throw fail("备份间隔须为 1 至 1440 分钟。");
        const write = settingsWrite.then(async () => {
          if (setting !== settingsKey()) throw fail("账号已切换。");
          if (action === "disable" && running) {
            controller?.abort();
            await running.catch(() => {});
          }
          const updated = await persist(latest => ({ ...latest, [setting]: { ...latest[setting],
            ...(action === "configure" ? { intervalMinutes } : { enabled: action === "enable" }) } }), () => {
            if (setting !== settingsKey()) throw fail("账号已切换。");
          });
          nextAttempt = action === "configure" ? now() + scheduleMs(updated) : 0;
          if (action === "disable") phase = undefined;
        });
        settingsWrite = write.catch(() => {});
        await write;
        if (action === "enable") void checkAutomatically();
        return;
      }
      if (!current) throw fail("请先连接盒子。");
      if (!["restore", "backup"].includes(action)) throw fail("不支持此备份操作。");
      return run(current, async signal => {
        const drive = await scopedDrive(current, signal);
        const record = await managedRecord(data, current, drive, signal);
        if (action === "backup") {
          if (!enabled(await preferences, current)) throw fail("请先开启空间自动备份。");
          return snapshot(record, data, current, drive, signal);
        }
        const location = await folder(drive, record.parent, signal);
        await restore(location, id, drive, signal);
        await save(data, current, { ...record, digest: location.latest.digest, backupId: location.latest.id, lastBackup: location.latest.modified }, signal);
        availableBackup = undefined;
        phase = "ready";
        nextAttempt = now() + scheduleMs(await preferences);
      });
    },
    async close() {
      closed = true;
      unsubscribe();
      clearInterval(timer);
      controller?.abort();
      await running?.catch(() => {});
      await settingsWrite;
      await storeWrite;
    },
  };
}
