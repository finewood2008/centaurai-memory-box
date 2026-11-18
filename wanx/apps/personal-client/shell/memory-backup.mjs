import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGzip, createGunzip } from "node:zlib";
import sdk from "../host-sdk/drive.cjs";
import { backupSourceId } from "./memory-backup-identity.mjs";

const storageRoute = "/api/local-data/wanx-storage";
const interval = 60 * 60_000;
const managedFolderName = "半人马AI记忆备份";
const entryId = /^[a-f0-9]{32}$/;
const legacyName = /^半人马AI-记忆备份-([a-f0-9]{32})-[a-f0-9]{32}\.sqlite(?:\.gz)?$/;
const backupName = /^半人马AI-记忆备份-v2-(darwin|win32|linux)-([a-f0-9]{32})-[a-f0-9]{32}\.sqlite\.gz$/;
const scopedBackupName = /^半人马AI-记忆备份-v3-(darwin|win32|linux)-([a-f0-9]{32})-(codex-cli|codex-desktop)-[a-f0-9]{32}\.sqlite\.gz$/;
export const backupSourcePattern = /^(?:(?:v2|legacy)-[a-f0-9]{32}|v3-[a-f0-9]{32}-(?:codex-cli|codex-desktop))$/;
const platforms = { darwin: "Mac", win32: "Windows", linux: "Linux" };
const digestPattern = /^[a-f0-9]{64}$/;
const retryableReadCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN",
  "CONNECT_TIMEOUT", "NETWORK_NOT_READY", "NETWORK_CHANGED", "BOX_CONNECTION_REQUIRED", "SESSION_CLOSED", "GATEWAY_CLOSED",
  "SPACE_CONNECTION_TIMEOUT", "SPACE_CHUNK_STALLED", "tunnel_timeout", "tunnel_rejected", "netbird_peer_disconnected", "network_unavailable", "network_recovering"]);
const retryableReadStatuses = new Set([408, 429, 502, 503, 504]);
const fail = message => new Error(message);

function snapshotSource(name) {
  const scoped = scopedBackupName.exec(name);
  if (scoped) return { id: `v3-${scoped[2]}-${scoped[3]}`, profile: scoped[3], name: `${platforms[scoped[1]]} · ${scoped[2].slice(0, 8)}` };
  const current = backupName.exec(name);
  if (current) return { id: `v2-${current[2]}`, profile: "legacy", name: `${platforms[current[1]]} · ${current[2].slice(0, 8)}` };
  const legacy = legacyName.exec(name);
  return legacy ? { id: `legacy-${legacy[1]}`, profile: "legacy", name: `旧版备份来源 · ${legacy[1].slice(0, 8)}` } : null;
}

export function createMemoryBackup({ client, space, sourceBinding, store, stagingRoot, protect, localRequest,
  accountScope = () => space.snapshot().scope, intervalMs = interval, now = Date.now,
  library = { id: "legacy", name: "旧版混合库" }, libraries, chooseLibrary }) {
  let connectionKey, controller, running, runningScope, runningOwner, operation, closed = false, phase, progress, lastError, statusFor, nextAttempt = 0;
  let settingsWrite = Promise.resolve(), storeWrite = Promise.resolve();
  let sourceIdentity, knownInstallation;
  let preferences = store.load().then(value => value || {});
  void preferences.catch(() => {});

  function scopeKey(scope = space.snapshot().scope) {
    return scope ? createHash("sha256").update(scope).digest("hex") : null;
  }

  function settingsKey() {
    const account = accountScope();
    if (!account) return null;
    const key = "settings:" + createHash("sha256").update(account).digest("hex");
    return library.id === "legacy" ? key : key + ":" + library.id;
  }

  const recordKey = current => library.id === "legacy" ? current?.key : current?.key && current.key + ":" + library.id;

  function enabled(data, current) {
    return (data[settingsKey()]?.enabled ?? data[recordKey(current)]?.enabled) !== false;
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
    if (running && (runningOwner !== settingsKey() || (runningScope && scopeKey() !== runningScope))) controller?.abort();
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
        const downloading = method === "GET" && /^\/api\/personal-space\/files\/[a-f0-9]{32}\/content\?/.test(route);
        if (downloading) {
          const url = new URL(route, "http://localhost");
          url.searchParams.set("length", String(Math.min(Number(url.searchParams.get("length")) || 1024 * 1024, 1024 * 1024)));
          route = url.pathname + url.search;
        }
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
              ...(method === "PUT" || downloading ? { idleTimeoutMs: 15_000, freshConnection: true } : {}),
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
    return {
      folders: items.filter(item => item.kind === "folder"),
      backups: items.filter(item => item.kind === "file" && digestPattern.test(item.digest) &&
        Number.isSafeInteger(item.size) && item.size > 0 && Number.isFinite(item.modified))
        .map(item => ({ ...item, source: snapshotSource(item.name) })).filter(item => item.source)
        .sort((a, b) => b.modified - a.modified || b.id.localeCompare(a.id)),
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

  async function save(current, record, signal) {
    return persist(latest => ({ ...latest, [recordKey(current)]: record }), () => {
      signal.throwIfAborted();
      if (scopeKey() !== current.key) throw fail("账号或盒子已切换。");
    });
  }

  function installationSource() {
    sourceIdentity ??= (async () => {
      const { binding, platform } = await sourceBinding();
      if (!digestPattern.test(binding) || !Object.hasOwn(platforms, platform)) throw fail("无效的本机备份来源。");
      let seed = (await preferences).sourceSeed;
      if (!entryId.test(seed)) {
        const data = await persist(latest => ({
          ...latest, sourceSeed: entryId.test(latest.sourceSeed) ? latest.sourceSeed : randomUUID().replaceAll("-", ""),
        }), () => { if (closed) throw fail("客户端已关闭。"); });
        seed = data.sourceSeed;
      }
      const id = backupSourceId(binding, seed);
      return knownInstallation = library.id === "legacy"
        ? { id: `v2-${id}`, prefix: `半人马AI-记忆备份-v2-${platform}-${id}-` }
        : { id: `v3-${id}-${library.id}`, prefix: `半人马AI-记忆备份-v3-${platform}-${id}-${library.id}-` };
    })().catch(error => { sourceIdentity = undefined; throw error; });
    return sourceIdentity;
  }

  async function managedParent(drive, signal, create = false) {
    const root = await folder(drive, "", signal);
    let matches = root.folders.filter(item => item.name === managedFolderName);
    if (!matches.length && create) {
      try { await drive.mkdir({ parent: "", name: managedFolderName, signal }); }
      catch (error) {
        // A concurrent installation may have created the same directory.
        const refreshed = await folder(drive, "", signal);
        if (!refreshed.folders.some(item => item.name === managedFolderName)) throw error;
      }
      matches = (await folder(drive, "", signal)).folders.filter(item => item.name === managedFolderName);
    }
    if (matches.length > 1 || (create && !matches.length)) throw fail("暂时无法确认记忆备份位置，请稍后重试。");
    return matches[0]?.id;
  }

  async function availableSnapshots(drive, data, current, signal) {
    const parent = await managedParent(drive, signal);
    const backups = parent ? (await folder(drive, parent, signal)).backups : [];
    const record = data[recordKey(current)];
    const legacyParent = record?.managed === true ? undefined : record?.parent;
    if (legacyParent !== parent && (legacyParent === "" || entryId.test(legacyParent))) {
      const previous = await folder(drive, legacyParent, signal).catch(error => {
        if (error?.code !== "SPACE_NOT_FOUND") throw error;
        return { backups: [] };
      });
      backups.push(...previous.backups.filter(item => item.source.id.startsWith("legacy-")));
    }
    return backups.filter(entry => entry.source.profile === library.id ||
      (library.id === "legacy" && ["codex-desktop", "codex-cli"].includes(entry.source.profile)))
      .sort((a, b) => b.modified - a.modified || b.id.localeCompare(a.id));
  }

  async function uploadSnapshot(drive, { parent, name, file, size, digest, signal }) {
    const uploadId = randomUUID().replaceAll("-", "");
    const retryable = error => retryableReadCodes.has(error?.code ?? error?.message) ||
      ["SPACE_UPLOAD_OFFSET", "SPACE_REQUEST_FAILED"].includes(error?.code) || error?.name === "TimeoutError";
    async function retry(work) {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try { return await work(); }
        catch (error) {
          if (signal.aborted || attempt >= 7 || !retryable(error)) throw error;
          await delay(Math.min(400 * 2 ** attempt, 8_000), undefined, { signal });
        }
      }
    }
    const validOffset = value => {
      if (!Number.isSafeInteger(value) || value < 0 || value > size) throw fail("盒端备份偏移校验失败。");
      return value;
    };
    const handle = await open(file, "r");
    try {
      const remote = await retry(() => drive.createUpload({ parent, name, size, uploadId, signal }));
      let offset = validOffset(remote.offset);
      progress = { bytes: offset, total: size };
      while (offset < size) {
        const start = offset;
        const bytes = Buffer.alloc(Math.min(1024 * 1024, size - start));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
        if (bytesRead !== bytes.length) throw fail("本机备份文件已变化。");
        let reconcile = false;
        offset = await retry(async () => {
          if (reconcile) {
            const state = await drive.uploadStatus(uploadId, { signal });
            const confirmed = validOffset(state.offset);
            if (confirmed === start + bytes.length) return confirmed;
            if (confirmed !== start) throw fail("盒端备份偏移校验失败。");
          }
          // A lost reply may still have committed the whole chunk on the box.
          // Reconcile before re-sending, and reset the retry budget per chunk.
          reconcile = true;
          const result = await drive.writeChunk(uploadId, {
            offset: start, data: bytes, signal,
          });
          if (result.offset !== start + bytes.length) throw fail("盒端备份偏移校验失败。");
          return result.offset;
        });
        progress = { bytes: offset, total: size };
      }
      const entry = await retry(() => drive.completeUpload(uploadId, { digest, signal }));
      if (entry.id !== uploadId || entry.size !== size) throw fail("盒端备份标识校验失败。");
      return entry;
    } catch (error) {
      if (!signal.aborted) await drive.cancelUpload(uploadId, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
      throw error;
    } finally { await handle.close(); }
  }

  async function snapshot(data, current, drive, signal) {
    phase = "backing-up";
    if (library.id !== "legacy") await localLibraryStatus(signal);
    const installation = await installationSource();
    const parent = await managedParent(drive, signal, true);
    const latest = (await folder(drive, parent, signal)).backups.find(item => item.source.id === installation.id);
    const previous = data[recordKey(current)];
    const remember = entry => save(current, {
      ...previous, v2: { sourceId: installation.id, backupId: entry.id, lastBackup: entry.modified },
    }, signal);
    await withStaging(async directory => {
      const result = await localRequest(storageRoute + "/snapshot", { directory }, { signal, timeout: 125_000 });
      if (typeof result?.path !== "string" || path.dirname(result.path) !== directory) throw fail("未能生成本机记忆快照。");
      const archive = path.join(directory, "snapshot.sqlite.gz");
      await pipeline(createReadStream(result.path), createGzip({ level: 1 }), createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
      const checksum = createHash("sha256");
      for await (const bytes of createReadStream(archive, { signal })) checksum.update(bytes);
      const digest = checksum.digest("hex");
      if (latest?.digest === digest) {
        if (previous?.v2?.backupId !== latest.id) await remember(latest);
        phase = "ready";
        return;
      }
      const fileName = installation.prefix + randomUUID().replaceAll("-", "") + ".sqlite.gz";
      const { size } = await stat(archive);
      const entry = await uploadSnapshot(drive, { parent, name: fileName, file: archive, size, digest, signal });
      if (entry.digest !== digest || entry.name !== fileName || entry.parent !== parent) throw fail("盒端备份校验失败。");
      await remember(entry);
      phase = "ready";
    });
  }

  async function localLibraryStatus(signal) {
    const status = await localRequest(storageRoute, undefined, { signal });
    if ((status?.sourceProfile ?? "legacy") !== library.id) throw fail("本机服务与所选记忆库来源不一致。");
    return status;
  }

  async function switchLibrary(input, signal) {
    const id = randomUUID();
    signal.throwIfAborted();
    const reply = await localRequest(storageRoute, { id, ...input }, { signal, timeout: 125_000 });
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
  }

  async function restore(entry, drive, signal) {
    phase = "restoring";
    const local = await localLibraryStatus(signal);
    if (typeof local?.rollbackAvailable !== "boolean") throw fail("请更新并重启本机记忆服务，以便恢复前保留本机副本。");
    await withStaging(async directory => {
      const source = path.join(directory, "restore.sqlite");
      progress = { bytes: 0, total: entry.size };
      const data = (async function* () {
        let received = 0;
        const checksum = createHash("sha256");
        for await (const bytes of drive.read(entry.id, { signal })) {
          received += bytes.length;
          if (received > entry.size) throw fail("快照已变化，请刷新后重新选择。");
          checksum.update(bytes);
          progress = { bytes: received, total: entry.size };
          yield bytes;
        }
        if (received !== entry.size || checksum.digest("hex") !== entry.digest) throw fail("快照校验失败，请重新选择。");
      })();
      const destination = createWriteStream(source, { flags: "wx", mode: 0o600 });
      if (entry.name.endsWith(".gz")) {
        await pipeline(data, createGunzip(), destination, { signal });
      } else {
        await pipeline(data, destination, { signal });
      }
      await switchLibrary({ restoreFrom: source }, signal);
    });
  }

  function run(current, kind, work) {
    if (closed || running) throw fail("正在处理记忆备份，请稍候。");
    controller = new AbortController();
    const { signal } = controller;
    runningScope = current?.key;
    runningOwner = settingsKey();
    operation = kind;
    const report = kind !== "catalog";
    if (report) {
      statusFor = runningScope ?? runningOwner;
      progress = lastError = undefined;
    }
    running = Promise.resolve().then(() => work(signal)).catch(error => {
      if (report && !signal.aborted) {
        phase = "error";
        if (/^[A-Z][A-Z_0-9]{1,80}$/.test(error?.code || "")) lastError = error.code;
      }
      throw error;
    }).finally(() => { running = controller = runningScope = runningOwner = operation = undefined; });
    return running;
  }

  async function checkAutomatically() {
    if (closed || running || now() < nextAttempt) return;
    const current = context();
    if (!current) return;
    const data = await preferences.catch(() => null);
    nextAttempt = now() + (data ? scheduleMs(data) : intervalMs);
    if (!data || !enabled(data, current) || running || closed || context()?.dataContextId !== current.dataContextId) return;
    await run(current, "backup", async signal => {
      const drive = await scopedDrive(current, signal);
      await snapshot(data, current, drive, signal);
    }).catch(() => {});
    if (context()?.key === current.key) nextAttempt = now() + scheduleMs(await preferences);
  }

  const timer = setInterval(() => void checkAutomatically(), Math.min(intervalMs, 15_000));
  timer.unref?.();
  const unsubscribe = client.subscribe(sync);
  sync();
  return {
    async action(action, { sourceId, id, digest, context: expected, intervalMinutes, libraryId } = {}) {
      const current = context();
      const setting = settingsKey();
      const data = await preferences;
      if (setting !== settingsKey() || current?.dataContextId !== context()?.dataContextId) throw fail("账号或盒子已切换。");
      const ticket = current?.ticket ?? setting;
      const record = data[recordKey(current)];
      if (action === "status") return {
        connected: Boolean(current), context: ticket, enabled: enabled(data, current), busy: Boolean(running),
        library: { id: library.id, name: library.id === "legacy" ? "本机记忆库" : library.name },
        lastBackup: knownInstallation && record?.v2?.sourceId === knownInstallation.id ? record.v2.lastBackup : undefined,
        intervalMinutes: scheduleMs(data) / 60_000,
        ...(statusFor && (statusFor === current?.key || statusFor === setting) ? { phase, progress, lastError } : {}),
      };
      if (!setting || expected !== ticket) throw fail("账号或盒子已切换，请重新打开备份设置。");
      if (action === "select-library") {
        if (typeof libraryId !== "string" || !chooseLibrary || !libraries.some(item => item.id === libraryId)) throw fail("无效的本机记忆库。");
        return run(null, "catalog", () => chooseLibrary(libraryId));
      }
      if (action === "enable" || action === "disable" || action === "configure") {
        if (action === "configure" && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440)) throw fail("备份间隔须为 1 至 1440 分钟。");
        const write = settingsWrite.then(async () => {
          if (setting !== settingsKey()) throw fail("账号已切换。");
          if (action === "disable" && operation === "backup") {
            controller?.abort();
            await running.catch(() => {});
          }
          const updated = await persist(latest => ({ ...latest, [setting]: { ...latest[setting],
            ...(action === "configure" ? { intervalMinutes } : { enabled: action === "enable" }) } }), () => {
            if (setting !== settingsKey()) throw fail("账号已切换。");
          });
          nextAttempt = action === "configure" ? now() + scheduleMs(updated) : 0;
          if (action === "disable" && !running) phase = undefined;
        });
        settingsWrite = write.catch(() => {});
        await write;
        if (action === "enable") void checkAutomatically();
        return;
      }
      if (action === "catalog") return run(current, "catalog", async signal => {
        const local = await localLibraryStatus(signal).catch(() => null);
        const rollbackAvailable = local?.rollbackAvailable === true;
        if (!current) return { sources: [], rollbackAvailable };
        let backups;
        try { backups = await availableSnapshots(await scopedDrive(current, signal), data, current, signal); }
        catch {
          signal.throwIfAborted();
          return { sources: [], rollbackAvailable, sourcesError: "暂时无法读取盒子上的快照，请检查连接后重试。" };
        }
        const installation = await installationSource().catch(() => null);
        signal.throwIfAborted();
        const sources = new Map();
        for (const entry of backups) {
          const key = entry.source.id;
          if (!sources.has(key)) sources.set(key, { ...entry.source, current: key === installation?.id, snapshots: [] });
          sources.get(key).snapshots.push({ id: entry.id, digest: entry.digest, size: entry.size, modified: entry.modified });
        }
        return { sources: [...sources.values()], rollbackAvailable };
      });
      if (action === "rollback") return run(null, "restore", async signal => {
        phase = "restoring";
        await localLibraryStatus(signal);
        await switchLibrary({ rollback: true }, signal);
        phase = "restored";
        nextAttempt = now() + scheduleMs(await preferences);
      });
      if (!current) throw fail("请先连接盒子。");
      if (action === "backup") return run(current, "backup", async signal => {
        try { await snapshot(data, current, await scopedDrive(current, signal), signal); }
        finally { if (context()?.key === current.key) nextAttempt = now() + scheduleMs(await preferences); }
      });
      if (action === "restore") {
        if (!backupSourcePattern.test(sourceId) || !entryId.test(id) || !digestPattern.test(digest)) {
          throw fail("请选择来源设备和具体快照。");
        }
        return run(current, "restore", async signal => {
          const drive = await scopedDrive(current, signal);
          const backups = await availableSnapshots(drive, data, current, signal);
          const selected = backups.find(entry => entry.id === id && entry.source.id === sourceId && entry.digest === digest);
          if (!selected) throw fail("所选快照已变化，请刷新后重新选择。");
          await restore(selected, drive, signal);
          phase = "restored";
          nextAttempt = now() + scheduleMs(await preferences);
        });
      }
      throw fail("不支持此备份操作。");
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
