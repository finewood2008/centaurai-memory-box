import { createDriveRouting } from "./space-drive-routing.mjs";
import { createHash, randomUUID } from "node:crypto";
import { open, stat, lstat, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { dataOwnerKey, dataInteractionKey } from "../device-trust/data-context.mjs";
import { walkUploads, importSummaries, validUploadName, sourceError, IMPORT_PAGE, IMPORT_WINDOW, MAX_UPLOAD_BYTES } from "./space-upload-imports.mjs";
import { createSpaceAnnotationService } from "./space-annotation-service.mjs";
import { createAnnotationWorkbench } from "./space-annotation-workbench.mjs";
import { extractAnnotationContent } from "./annotation-content.mjs";

const PREFIX = "/api/personal-space";
const CHUNK = 4 * 1024 * 1024;
const RECOVERY_CHUNK = 1024 * 1024;
const TEXT_EDIT_LIMIT = 16 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".log", ".csv"]);
// Match the client's existing binary MB display. Applies to new UI batches only.
export { MAX_UPLOAD_BYTES };
const transientCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "CONNECT_TIMEOUT", "SESSION_CLOSED", "GATEWAY_CLOSED", "NETWORK_CHANGED", "NETWORK_NOT_READY", "BOX_CONNECTION_REQUIRED", "SPACE_CONNECTION_TIMEOUT", "SPACE_CHUNK_STALLED", "SPACE_NETWORK_WAIT", "SPACE_UPLOAD_OFFSET", "tunnel_timeout", "tunnel_rejected", "network_unavailable", "network_recovering", "netbird_peer_disconnected"]);
const errorCode = cause => cause?.code || ((transientCodes.has(cause?.message) || permanentCodes.has(cause?.message)) ? cause.message : "SPACE_TRANSFER_FAILED");
const permanentCodes = new Set(["ACCOUNT_ACCESS_DENIED", "ACCOUNT_LOGIN_REQUIRED", "ACCOUNT_SESSION_EXPIRED", "NETWORK_DEVICE_ACCESS_DENIED", "PLATFORM_SESSION_EXPIRED", "BOX_PLATFORM_AUTH_FAILED", "BOX_PLATFORM_SESSION_EXPIRED", "BOX_UPSTREAM_AUTH_FAILED", "SPACE_DISK_FULL", "SPACE_LOCAL_FILE_CHANGED", "SPACE_REMOTE_FILE_CHANGED", "SPACE_NOT_FOUND", "SPACE_LINK_SCOPE", "SPACE_AGENT_PAUSED", "SPACE_AGENT_DISCONNECTED"]);
const transient = cause => !permanentCodes.has(errorCode(cause)) && ![401, 403].includes(cause?.status) && (transientCodes.has(errorCode(cause)) || [408, 429, 502, 503, 504].includes(cause?.status));
const terminal = task => ["complete", "canceled"].includes(task.phase);
const fail = code => Object.assign(new Error(code), { code });
const id = value => { if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw fail("SPACE_INVALID_ID"); return value; };
const folder = value => value === "" ? "" : id(value);
const name = value => { if (typeof value !== "string" || !value.trim() || value.length > 240) throw fail("SPACE_INVALID_NAME"); return value; };
const hash = data => createHash("sha256").update(data).digest("hex");
const fileVersion = entry => JSON.stringify([entry.id, entry.kind, entry.space_id, entry.parent, entry.name, entry.digest, entry.size, entry.version, entry.modified]);
const stamp = info => info ? `${info.size}:${info.mtimeMs}:${info.ino}` : null;
const fileStat = file => stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });

// Lives in the main process. Local paths come from a native picker or preload's
// File conversion; credentials, remote URLs and user ids never come from the renderer.
export async function createPersonalSpace({ client, store, annotationStore, workbenchStore, redactionStore, enableTextEditing = false, annotationAI, annotationExtract, serviceURL, chooseUploads, chooseDownload, chooseDownloadDirectory, driveCatalog, mountedSource, onChanged = () => {}, onEvent = () => {}, retryBaseMs = 1000, maxRetries = 6, recoveryCooldownMs = 30_000, random = Math.random }) {
  let restored = [], storageError = null;
  try { restored = await store.load() || []; if (!Array.isArray(restored)) throw new Error("Invalid transfer records"); }
  catch { storageError = "SECURE_STORAGE_READ_FAILED"; restored = []; }
  let tasks = restored.map(task => ({ ...task, phase: terminal(task) ? task.phase : task.recoveryVersion === 1 && task.autoResume ? "waiting" : "paused" }));
  let closed = false, lease = null, leaseKey = null, generation = 0, connectionPromise = null;
  let workbench;
  let overview = null, phase = "disconnected", error = null;
  const running = new Map(), scans = new Map(), scanKnown = new Map(), parentWaiters = new Set(), taskIndex = new Map(tasks.map(t => [t.id, t]));
  const annotationJobs = new Map();
  let redactionJob;
  let annotationTimer = null;
  let dispatchCursor = 0;
  let lastCheckpoint = 0, checkpointTimer = null, lastNotify = 0, notifyTimer = null;
  let writes = Promise.resolve(), wakeTimer = null, retryUntil = 0, degraded = false;
  let boundAccount = null, boundBox = null, wasReady = false, interaction = null;
  const event = (task, action, details = {}) => { taskIndex.set(task.id, task); try { onEvent({ taskId: task.id, batchId: task.batchId, action, phase: task.phase, offset: task.offset, size: task.size, attempt: task.attempt || 0, ...details }); } catch {} };
  const accountKey = () => dataOwnerKey(client.snapshot(), serviceURL);
  // The team build also assembles this transfer service. Redaction policy is
  // provided by the personal client's composition root.
  const redactionRules = redactionStore && (await import("./space-redaction-rules.mjs")).createSpaceRedactionRules({ store: redactionStore, currentOwner: () => closed ? null : accountKey() });
  // A route going offline is not an account/box change. Retain its identity,
  // but never dispatch while the live connection is not ready for that box.
  const scopeKey = () => {
    const account = accountKey(), state = client.snapshot();
    if (!account) return null;
    const box = state.connection?.deviceId || (account === boundAccount ? boundBox : null);
    return box ? JSON.stringify([account, box]) : null;
  };
  const ready = () => !!dataInteractionKey(client.snapshot(), serviceURL);
  const notify = () => {
    if (Date.now() - lastNotify < 100) { if (!notifyTimer && !closed) { notifyTimer = setTimeout(() => { notifyTimer = null; notify(); }, 100 - (Date.now() - lastNotify)); notifyTimer.unref?.(); } return; }
    lastNotify = Date.now(); onChanged(snapshot());
  };
  const persist = () => { clearTimeout(checkpointTimer); checkpointTimer = null; lastCheckpoint = Date.now(); if (storageError) return Promise.reject(fail(storageError)); const copy = structuredClone(tasks); writes = writes.catch(() => {}).then(() => store.save(copy)).catch(() => { storageError = "SECURE_STORAGE_WRITE_FAILED"; for (const task of tasks) if (!terminal(task)) { task.autoResume = false; task.phase = "paused"; task.pauseReason = "error"; task.error = storageError; } for (const job of running.values()) job.controller.abort(fail(storageError)); throw fail(storageError); }); return writes; };
  // The accepted plan and directory IDs are durable immediately. File progress
  // may lag by one second: restart always reconciles the box's confirmed offset.
  const checkpoint = () => {
    if (Date.now() - lastCheckpoint >= 1000) return persist();
    if (!checkpointTimer) { checkpointTimer = setTimeout(() => { checkpointTimer = null; void persist().catch(() => {}); }, 1000 - (Date.now() - lastCheckpoint)); checkpointTimer.unref?.(); }
    return Promise.resolve();
  };
  function snapshot() {
    const scope = scopeKey();
    return { phase, error, storageError, annotationAvailable: !!annotationStore, annotationWorkbenchAvailable: !!workbenchStore, redactionAvailable: !!redactionStore, textEditingAvailable: enableTextEditing && overview?.textEditing === true, overview, scope, dataOwnerId: accountKey(), dataContextId: dataInteractionKey(client.snapshot(), serviceURL), accountId: client.snapshot().account?.accountId, boxId: client.snapshot().connection?.deviceId || boundBox, imports: importSummaries(tasks, scope), tasks: tasks.filter(t => t.scope === scope && t.direction !== "import").map(({ localPath, partialPath, localStamp, destinationStamp, digest, ...publicTask }) => publicTask) };
  }
  function schedulePump(ms = 0) {
    clearTimeout(wakeTimer);
    if (closed) return;
    wakeTimer = setTimeout(pump, Math.max(0, ms)); wakeTimer.unref?.();
  }
  function sync() {
    const next = scopeKey(), online = ready(), nextInteraction = dataInteractionKey(client.snapshot(), serviceURL);
    if (next === leaseKey && online === wasReady && interaction === nextInteraction) return;
    const changed = next !== leaseKey, initial = leaseKey === null && !wasReady;
    generation++; leaseKey = next; lease = null; connectionPromise = null; wasReady = online; interaction = nextInteraction;
    boundAccount = accountKey(); boundBox = next ? JSON.parse(next)[1] : null;
    if (changed || client.snapshot().dataIdentity?.profileId) { overview = null; retryUntil = 0; degraded = false; }
    phase = online ? "idle" : "disconnected"; error = null;
    for (const task of tasks) {
      if (terminal(task) || task.phase === "paused") continue;
      if (changed && task.scope !== next) {
        let sameAccount = false; try { sameAccount = JSON.parse(task.scope)[0] === accountKey(); } catch {}
        if (initial && sameAccount && task.recoveryVersion === 1 && task.autoResume) { task.phase = "waiting"; task.pauseReason = "network"; }
        else { task.autoResume = false; task.pauseReason = "context"; task.phase = "paused"; task.error = "SPACE_CONTEXT_CHANGED"; }
      } else if (!online) {
        task.phase = "waiting"; task.pauseReason = "network";
        if (task.direction === "upload") task.chunkSize = Math.min(task.chunkSize || CHUNK, RECOVERY_CHUNK);
      }
      event(task, "connection");
    }
    for (const job of running.values()) job.controller.abort(fail(changed ? "SPACE_CONTEXT_CHANGED" : "SPACE_NETWORK_WAIT"));
    redactionJob?.controller.abort(fail("SPACE_CONTEXT_CHANGED"));
    workbench?.contextChanged();
    void persist().catch(() => {});
    notify(); schedulePump();
    scheduleAnnotations();
  }
  const annotations = await createSpaceAnnotationService({ store: annotationStore, scope: () => closed ? null : scopeKey(), request, notify,
    assertWritable: async ctx => {
      // The personal API is the current owner's space. Agent disks have an
      // explicit current permission in the server's catalog; renderer flags
      // and a previously cached drive grant cannot authorize an edit.
      if (ctx.spaceId === "personal") return;
      const disks = await driveCatalog?.(); ctx.check();
      if (!disks?.some(disk => disk.id === ctx.spaceId && disk.writable === true)) throw fail("SPACE_ANNOTATION_READ_ONLY");
    },
  });
  const unsubscribe = client.subscribe(sync);
  sync();
  async function connect() {
    sync();
    if (closed || !leaseKey || !ready()) throw fail("BOX_CONNECTION_REQUIRED");
    if (lease) { try { lease.context(); return lease; } catch { lease = null; } }
    if (!connectionPromise) {
      const epoch = generation;
      const pending = client.applicationConnection().then(value => {
        if (epoch !== generation || closed) throw fail("SPACE_CONTEXT_CHANGED");
        lease = value;
        return value;
      }).finally(() => { if (connectionPromise === pending) connectionPromise = null; });
      connectionPromise = pending;
    }
    return connectionPromise;
  }
  const driveRouting = createDriveRouting({catalog:driveCatalog,scope:scopeKey,send:async(aid,action,params,signal)=>{
    const connection=await connect();
    return request(connection,`/drives/${aid}/files`,{prefix:"/api/_client/space-mcp",method:"POST",body:{action,params},signal});
  }});
  workbench = await createAnnotationWorkbench({ store: workbenchStore, scope: () => closed ? null : scopeKey(), owner: accountKey,
    interaction: () => dataInteractionKey(client.snapshot(), serviceURL), ready, operation,
    batch: async input => annotations.applyBatch(await connect(), input), undo: async input => annotations.undoBatch(await connect(), input),
    receipt: async input => annotations.batchReceipt(await connect(), input),
    readBytes: annotationBytes, preview, model: annotationAI, ...(annotationExtract ? { extract: annotationExtract } : {}), notify,
  });
  async function request(connection, route, { method = "GET", body, signal, raw = false, headers = {}, prefix = PREFIX, spaceId } = {}) {
    if (signal?.aborted) throw fail("SPACE_PAUSED");
    connection.context();
    if(prefix===PREFIX){
      const routed=await driveRouting.route(route,{method,body,signal,raw,headers,spaceId});
      if(routed.handled)return routed.value;
      if(routed.path)route=routed.path;
    }
    const deadline = AbortSignal.timeout(route.endsWith("/complete") ? 120_000 : 60_000);
    let response;
    try {
      const send = prefix === "/api/clipboard/v1" ? input => connection.businessRequest("clipboard", input) : input => connection.request(input);
      response = await send({ path: `${prefix}${route}`, method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        ...(method === "PUT" && (route.startsWith("/uploads/") || prefix === "/api/clipboard/v1") ? { idleTimeoutMs: 15_000, freshConnection: true } : {}),
        headers: { ...(body && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers },
        body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
    } catch (cause) {
      if (deadline.aborted) throw fail("SPACE_CONNECTION_TIMEOUT");
      throw cause;
    }
    if (deadline.aborted) throw fail("SPACE_CONNECTION_TIMEOUT");
    if (signal?.aborted) throw fail("SPACE_PAUSED");
    connection.context();
    const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || "");
    let value;
    if (!raw || response.status >= 400) { try { value = JSON.parse(bytes.toString("utf8")); } catch {} }
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(fail(value?.detail?.code || value?.error?.code || (response.status === 404 ? "SPACE_UPGRADE_REQUIRED" : "SPACE_REQUEST_FAILED")), { status: response.status, retryAfter: (() => { const v = response.headers?.["retry-after"]; const seconds = Number(v); return v ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(v) - Date.now()) || 0 : 0; })() });
    return raw ? { bytes, headers: response.headers } : value;
  }
  async function refresh() {
    sync();
    driveRouting.invalidate();
    const epoch = generation, current = () => epoch === generation && !closed;
    try {
      const connection = await connect();
      if (!current()) return snapshot();
      phase = "loading"; error = null; notify();
      const result = await request(connection, "/overview");
      if (!current()) return snapshot();
      if (result?.protocolVersion !== 1) throw fail("SPACE_UPGRADE_REQUIRED");
      overview = result; phase = "ready";
    } catch (cause) {
      // A superseded read is canceled, including same-box network recovery.
      // Keep the connection/write guards strict; never publish its stale result.
      if (!current()) return snapshot();
      phase = cause.code === "SPACE_UPGRADE_REQUIRED" ? "unsupported" : "error"; error = cause.code || "SPACE_REQUEST_FAILED";
      throw cause;
    } finally { if (current()) notify(); }
    return snapshot();
  }
  async function operation(action, input = {}) {
    if (action === "open-text-edit" || action === "save-text-edit") return editTextFile(action, input);
    if (action === "import-volume") return importVolume(input);
    if (action === "annotation-workbench") return workbench.run(input);
    if (["annotation-stage-import", "annotation-pending-imports"].includes(action)) return annotations.localOperation(action, input);
    if (["redaction-rules", "save-redaction-rules", "redact"].includes(action)) {
      if (!redactionRules) throw fail("SPACE_REDACTION_RULES_UNAVAILABLE");
      if (action === "redaction-rules") return redactionRules.get(input);
      if (action === "save-redaction-rules") return redactionRules.save(input);
      return redact(input);
    }
    const connection = await connect();
    if (["annotation", "set-annotation", "auto-annotate", "search-annotations", "annotation-bind", "annotation-imports"].includes(action)) return annotations.operation(connection, action, input);
    const spaceId = input.space_id || "personal";
    switch (action) {
      case "restore-version": return request(connection, `/files/${id(input.id)}/previous`, { method: "POST", body: { expected: input.expected } });
      case "stat": return annotations.decorate(connection, await metadata(connection, input.id, input.space_id), spaceId);
      case "list": return annotations.list(connection, await request(connection, `/files?parent=${folder(input.parent || "")}&trash=${input.trash === true}&space_id=${spaceId !== "personal" ? id(spaceId) : "personal"}`), spaceId);
      case "mkdir": return annotations.decorate(connection, await request(connection, "/folders", { method: "POST", body: { parent: folder(input.parent || ""), name: name(input.name), space_id: spaceId } }), spaceId);
      case "move": return annotations.decorate(connection, await request(connection, `/files/${id(input.id)}`, { method: "PATCH", body: { parent: folder(input.parent || ""), name: name(input.name) } }), spaceId);
      case "trash": return request(connection, `/files/${id(input.id)}`, { method: "DELETE" });
      case "restore": return request(connection, `/trash/${id(input.id)}/restore`, { method: "POST" });
      case "purge": return request(connection, `/trash/${id(input.id)}`, { method: "DELETE" });
      default: throw fail("SPACE_ACTION_INVALID");
    }
  }
  async function importVolume({ volume, path: sourcePath, directory, parent = "", space_id: spaceId }) {
    if (!mountedSource || typeof volume !== "string" || !/^[A-Za-z0-9_.:-]+@\d+-\d+$/.test(volume) ||
      typeof sourcePath !== "string" || sourcePath.length > 4096 ||
      sourcePath.split("/").some(part => !part || part.startsWith("."))) throw fail("SPACE_INVALID_DESTINATION");
    const connection = await connect(), epoch = generation;
    const owner = dataInteractionKey(client.snapshot(), serviceURL);
    const check = () => {
      connection.context();
      if (closed || generation !== epoch || !owner || owner !== dataInteractionKey(client.snapshot(), serviceURL))
        throw fail("SPACE_CONTEXT_CHANGED");
    };
    const destination = spaceId === "personal" ? spaceId : id(spaceId);
    const send = (route, options) => { check(); return request(connection, route, {...options, spaceId:destination}); };
    const read = async (op, path, input = {}) => {
      check();
      const value = await mountedSource(op, {volume, path, ...input});
      check();
      return value;
    };
    const createFolder = (parent, fileName) => send("/folders", {
      method:"POST", body:{parent:folder(parent), name:name(fileName), space_id:destination},
    });
    async function copyFile(path, parent, fileName) {
      const {size,version} = await read("file", path);
      if (!Number.isSafeInteger(size) || size < 0 || typeof version !== "string") throw fail("SPACE_REMOTE_FILE_CHANGED");
      const uploadId = randomUUID().replaceAll("-", "");
      const route = `/uploads/${uploadId}`;
      try {
        await send("/uploads",{method:"POST", body:{id:uploadId, parent:folder(parent), name:name(fileName), size, space_id:destination}});
        const checksum = createHash("sha256");
        for (let offset = 0; offset < size;) {
          const length = Math.min(RECOVERY_CHUNK, size - offset);
          const result = await read("file", path, {offset,length,version});
          const data = Buffer.from(result.data, "base64");
          if (result.version !== version || result.size !== size || data.length !== length) throw fail("SPACE_REMOTE_FILE_CHANGED");
          checksum.update(data);
          const chunk = {method:"PUT",body:data,
            headers:{"content-type":"application/octet-stream","x-content-sha256":hash(data)}};
          let confirmed;
          try { confirmed = await send(`${route}?offset=${offset}`, chunk); }
          catch (error) {
            if (!transient(error)) throw error;
            confirmed = await send(route);
            if (confirmed.offset === offset) confirmed = await send(`${route}?offset=${offset}`, chunk);
          }
          offset += length;
          if (confirmed.offset !== offset) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
        }
        const digest = checksum.digest("hex");
        const complete = {method:"POST",body:{digest}};
        try { return await send(route+"/complete",complete); }
        catch (error) {
          if (!transient(error)) throw error;
          return await send(route+"/complete",complete);
        }
      } catch (error) {
        await Promise.resolve().then(() => send(route, {method:"DELETE"})).catch(() => {});
        throw error;
      }
    }
    const fileName = sourcePath.split("/").at(-1);
    if (!directory) return copyFile(sourcePath, parent, fileName);
    const staging = await createFolder(parent, ".importing-" + randomUUID());
    try {
      const queue = [{path:sourcePath, id:staging.id}];
      for (const current of queue) {
        let total, offset = 0;
        const names = new Set();
        do {
          const listing = await read("folder", current.path, {offset});
          total ??= listing.total;
          if (total !== listing.total || !Array.isArray(listing.items) ||
            (!listing.items.length && offset < total)) throw fail("SPACE_REMOTE_FILE_CHANGED");
          for (const item of listing.items) {
            name(item.name);
            if (names.has(item.name)) throw fail("SPACE_REMOTE_FILE_CHANGED");
            names.add(item.name);
            const child = current.path + "/" + item.name;
            if (item.folder) {
              const created = await createFolder(current.id, item.name);
              queue.push({path:child, id:created.id});
            } else await copyFile(child, current.id, item.name);
          }
          offset += listing.items.length;
        } while (offset < total);
      }
      return await send(`/files/${id(staging.id)}`, {method:"PATCH",body:{parent:folder(parent),name:name(fileName)}});
    } catch (error) {
      await Promise.resolve().then(() => send(`/files/${id(staging.id)}`, {method:"DELETE"})).catch(() => {});
      throw error;
    }
  }
  async function metadata(connection, itemId, spaceId) { return request(connection, `/files/${id(itemId)}`, {spaceId}); }
  async function editTextFile(action, input) {
    sync();
    if (!enableTextEditing || overview?.textEditing !== true) throw fail("SPACE_TEXT_EDIT_UNAVAILABLE");
    if (!ready()) throw fail("BOX_CONNECTION_REQUIRED");
    const epoch = generation;
    const check = () => {
      if (closed || epoch !== generation || !input?.scope || input.scope !== scopeKey() || input.dataContextId !== dataInteractionKey(client.snapshot(), serviceURL))
        throw fail("SPACE_CONTEXT_CHANGED");
    };
    check();
    const itemId = id(input.id), spaceId = input.space_id === "personal" ? "personal" : id(input.space_id);
    if (spaceId !== "personal") {
      const disks = await driveCatalog?.();
      check();
      if (!disks?.some(disk => disk.id === spaceId && disk.writable === true)) throw fail("MCP_DRIVE_READ_ONLY");
    }
    const connection = await connect();
    check();
    const entry = await metadata(connection, itemId, spaceId);
    check();
    if (entry?.id !== itemId || (entry.space_id ?? "personal") !== spaceId || entry.trashed != null) throw fail("SPACE_NOT_FOUND");
    const ext = path.extname(entry.name).toLowerCase();
    if (entry.kind !== "file" || !TEXT_EXTENSIONS.has(ext)) throw fail("SPACE_TEXT_UNSUPPORTED");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > TEXT_EDIT_LIMIT) throw fail("SPACE_TEXT_TOO_LARGE");

    if (action === "open-text-edit") {
      const bytes = await annotationBytes(entry, spaceId, undefined, RECOVERY_CHUNK);
      check();
      let decoded;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw fail("SPACE_TEXT_INVALID"); }
      if (decoded.includes("\0")) throw fail("SPACE_TEXT_INVALID");
      return { file: entry, text: decoded.replace(/\r\n?/g, "\n"), eol: decoded.match(/\r\n|[\n\r]/)?.[0] || "\n",
        bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), editId: randomUUID().replaceAll("-", "") };
    }

    const { expected, text, eol, bom } = input;
    const editId = id(input.editId);
    if (!Number.isSafeInteger(expected) || expected < 1 || expected >= Number.MAX_SAFE_INTEGER || typeof text !== "string" ||
        !["\n", "\r\n", "\r"].includes(eol) || typeof bom !== "boolean" || /[\0\r]|[\uD800-\uDFFF]/u.test(text)) throw fail("SPACE_TEXT_INVALID");
    if (text.length > TEXT_EDIT_LIMIT) throw fail("SPACE_TEXT_TOO_LARGE");
    const bytes = Buffer.from(`${bom ? "\uFEFF" : ""}${text.replaceAll("\n", eol)}`);
    if (bytes.length > TEXT_EDIT_LIMIT) throw fail("SPACE_TEXT_TOO_LARGE");
    if (ext === ".json") {
      try { JSON.parse(text); } catch { throw fail("SPACE_TEXT_JSON_INVALID"); }
    }
    const digest = hash(bytes), uploadId = hash(JSON.stringify([editId, itemId, expected, digest])).slice(0, 32);
    const route = `/uploads/${uploadId}`;
    const send = (target, options) => { check(); return request(connection, target, { ...options, spaceId }); };
    let reserved = false;
    async function save() {
      const state = await send(`/files/${itemId}/edit-uploads`, { method: "POST", body: { id: uploadId, expected, digest, size: bytes.length } });
      reserved = true;
      if (!Number.isSafeInteger(state?.offset) || state.offset < 0 || state.offset > bytes.length || !["pending", "complete"].includes(state.state))
        throw fail("SPACE_UPLOAD_OFFSET_INVALID");
      for (let offset = state.offset; offset < bytes.length; offset += RECOVERY_CHUNK) {
        const chunk = bytes.subarray(offset, offset + RECOVERY_CHUNK);
        const receipt = await send(`${route}?offset=${offset}`, { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream", "x-content-sha256": hash(chunk) } });
        if (receipt?.offset !== offset + chunk.length) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
      }
      const file = await send(`${route}/complete`, { method: "POST", body: { digest } });
      check();
      if (file?.id !== itemId || file.version !== expected + 1 || file.digest !== digest) throw fail("SPACE_VERSION_CONFLICT");
      return annotations.decorate(connection, file, spaceId);
    }
    try {
      try { return await save(); }
      catch (cause) { if (!transient(cause)) throw cause; return await save(); }
    } catch (cause) {
      check();
      if (reserved && !transient(cause)) await send(route, { method: "DELETE", signal: AbortSignal.timeout(3000) }).catch(() => {});
      check();
      throw cause;
    }
  }
  async function annotationBytes(entry, spaceId, signal, chunkSize = CHUNK) {
    if (entry.kind !== "file" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024) throw fail("SPACE_ANNOTATION_CONTENT_TOO_LARGE");
    const connection = await connect(), context = generation, parts = [];
    const current = () => { connection.context(); if (closed || context !== generation || signal?.aborted) throw fail("SPACE_CONTEXT_CHANGED"); };
    current(); if (fileVersion(await metadata(connection, entry.id, spaceId)) !== fileVersion(entry)) throw fail("SPACE_REMOTE_FILE_CHANGED");
    for (let offset = 0; offset < entry.size;) {
      const length = Math.min(chunkSize, entry.size - offset);
      const result = await request(connection, `/files/${id(entry.id)}/content?offset=${offset}&length=${length}`, { raw: true, spaceId, signal }); current();
      if (!result.bytes.length || result.bytes.length > length || result.headers?.["x-content-sha256"] && hash(result.bytes) !== result.headers["x-content-sha256"]) throw fail("SPACE_CHUNK_INVALID");
      parts.push(result.bytes); offset += result.bytes.length;
    }
    const bytes = Buffer.concat(parts); current();
    if (entry.digest && hash(bytes) !== entry.digest || fileVersion(await metadata(connection, entry.id, spaceId)) !== fileVersion(entry)) throw fail("SPACE_REMOTE_FILE_CHANGED");
    current(); return bytes;
  }
  // Internal main-process reader: obtain original, version-checked bytes;
  // document parsing never receives a local path, remote URL or credentials.
  async function readDocument(entry, { signal, check = () => {} } = {}) {
    check();
    const bytes = await annotationBytes(entry, "personal", signal);
    check();
    const extracted = await extractAnnotationContent({ entry, bytes, signal });
    check();
    return extracted;
  }

  function redact(input) {
    sync();
    if (!ready()) throw fail("BOX_CONNECTION_REQUIRED");
    const scope = scopeKey();
    if (input?.scope !== scope || input.dataContextId !== interaction) throw fail("SPACE_CONTEXT_CHANGED");
    if (redactionJob) throw fail("SPACE_REDACTION_BUSY");
    const itemId = id(input.id), spaceId = input.space_id === "personal" ? "personal" : id(input.space_id);
    const controller = new AbortController(), { signal } = controller, epoch = generation;
    const check = () => {
      if (closed || signal.aborted || epoch !== generation || scope !== scopeKey() || input.dataContextId !== dataInteractionKey(client.snapshot(), serviceURL))
        throw fail("SPACE_CONTEXT_CHANGED");
    };
    const promise = runRedaction(itemId, spaceId, scope, signal, check)
      .catch(cause => { check(); throw cause; })
      .finally(() => { redactionJob = undefined; });
    redactionJob = { controller, promise };
    return promise;
  }
  async function runRedaction(itemId, spaceId, scope, signal, check) {
    const rules = await redactionRules.get();
    const { redactSpaceFile, redactionSource } = await import("./space-redaction.mjs");
    check();
    if (!rules.builtins.some(rule => rule.enabled) && !rules.customRules.length) throw fail("SPACE_REDACTION_NO_RULES");
    if (spaceId !== "personal") {
      const disks = await driveCatalog?.();
      check();
      if (!disks?.some(disk => disk.id === spaceId && disk.writable === true)) throw fail("SPACE_REDACTION_READ_ONLY");
    }
    const connection = await connect();
    check();
    const recordUpload = uploadId => redactionRules.recordUpload(rules.owner, scope, spaceId, uploadId);
    const discardUpload = async uploadId => {
      check();
      try {
        await request(connection, `/uploads/${uploadId}`, { method: "DELETE", spaceId, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      } catch (cause) {
        if (cause.status !== 404) throw cause;
      }
      check();
      await recordUpload(null);
    };
    const pending = await redactionRules.pendingUpload(rules.owner, scope, spaceId);
    if (pending) {
      try { await discardUpload(pending); }
      catch { check(); throw fail("SPACE_REDACTION_WRITE_FAILED"); }
    }
    check();
    const readMetadata = () => request(connection, `/files/${itemId}`, { spaceId, signal });
    const entry = await readMetadata();
    check();
    if (entry?.id !== itemId || (entry.space_id ?? "personal") !== spaceId || entry.trashed != null) throw fail("SPACE_NOT_FOUND");
    const source = redactionSource(entry);
    const bytes = await annotationBytes(entry, spaceId, signal, RECOVERY_CHUNK);
    check();
    const output = await redactSpaceFile({ entry, source, bytes, rules, signal });
    check();
    if (!output.matches) return { file: null, matches: 0 };

    const uploadId = randomUUID().replaceAll("-", ""), route = `/uploads/${uploadId}`;
    const send = (path, options) => { check(); return request(connection, path, { ...options, spaceId, signal }); };
    const assertUnchanged = async () => {
      const current = await readMetadata();
      check();
      if (fileVersion(current) !== fileVersion(entry)) throw fail("SPACE_REMOTE_FILE_CHANGED");
    };
    await assertUnchanged();
    await recordUpload(uploadId);
    try {
      const size = output.bytes.length;
      const status = await send("/uploads", { method: "POST", body: { id: uploadId, parent: folder(entry.parent), name: output.name, size, space_id: spaceId } });
      if (status?.offset !== 0 || status.state !== "pending") throw fail("SPACE_UPLOAD_OFFSET_INVALID");
      for (let offset = 0; offset < size; offset += RECOVERY_CHUNK) {
        const chunk = output.bytes.subarray(offset, offset + RECOVERY_CHUNK);
        const result = await send(`${route}?offset=${offset}`, { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream", "x-content-sha256": hash(chunk) } });
        if (result?.offset !== offset + chunk.length) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
      }
      await assertUnchanged();
      const commit = { method: "POST", body: { digest: hash(output.bytes) } };
      let file;
      try { file = await send(`${route}/complete`, commit); }
      catch (cause) {
        if (!transient(cause)) throw cause;
        file = await send(`${route}/complete`, commit);
      }
      check();
      if (file?.id !== uploadId || file.kind !== "file" || file.digest !== commit.body.digest) throw fail("SPACE_REDACTION_WRITE_FAILED");
      await recordUpload(null).catch(() => {});
      check();
      return { file, matches: output.matches };
    } catch (cause) {
      check();
      // DELETE only discards pending bytes. A successful commit remains visible
      // if both attempts lose their receipt.
      await discardUpload(uploadId).catch(() => {});
      check();
      if (["SPACE_REMOTE_FILE_CHANGED", "SPACE_DISK_FULL", "SPACE_NOT_FOUND", "SPACE_CONTEXT_CHANGED"].includes(cause.code)) throw cause;
      if (cause.code === "MCP_DRIVE_READ_ONLY" || cause.status === 403) throw fail("SPACE_REDACTION_READ_ONLY");
      throw fail("SPACE_REDACTION_WRITE_FAILED");
    }
  }
  async function digestFile(file, signal) {
    const digest = createHash("sha256");
    const handle = await open(file, "r");
    try {
      for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK, autoClose: false })) {
        if (signal.aborted) throw fail("SPACE_PAUSED");
        digest.update(chunk);
      }
      return digest.digest("hex");
    } finally { await handle.close(); }
  }
  async function scanPage(batch, signal) {
    let iterator = scans.get(batch.id);
    if (!iterator) { iterator = walkUploads(batch.sources, signal); scans.set(batch.id, iterator); }
    let known = scanKnown.get(batch.id);
    if (!known) { known = new Map(tasks.filter(t => t.batchId === batch.id && t.direction === "upload").map(t => [t.sourceKey, t])); scanKnown.set(batch.id, known); }
    const pending = tasks.filter(t => t.batchId === batch.id && t.direction === "upload" && !terminal(t) && t.phase !== "paused").length;
    const budget = Math.min(IMPORT_PAGE, IMPORT_WINDOW - pending);
    const skippedSources = [...known.values()].filter(t => t.skipSource);
    for (let count = 0; count < budget;) {
      if (signal.aborted || batch.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
      const next = await iterator.next();
      if (signal.aborted || batch.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
      if (next.done) { batch.scanComplete = true; batch.phase = "complete"; scans.delete(batch.id); scanKnown.delete(batch.id); return; }
      const node = next.value, old = known.get(node.key);
      if (skippedSources.some(t => t.sourceKey === node.key || t.kind === "folder" && node.key.startsWith(t.sourceKey + "/")) || known.get(node.parentKey)?.skipSource) continue;
      if (old && old.phase !== "canceled") continue;
      const task = { id: randomUUID().replaceAll("-", ""), batchId: batch.id, batchName: batch.name, scope: batch.scope, direction: "upload", recoveryVersion: 1,
        sourceKey: node.key, relativePath: node.relativePath, parentTaskId: node.parentKey === null ? null : known.get(node.parentKey)?.id,
        parent: batch.parent, spaceId: batch.spaceId, kind: node.kind, name: node.name, localPath: node.localPath, localStamp: node.localStamp,
        size: node.size || 0, offset: 0, phase: node.error ? "paused" : "queued", autoResume: !node.error,
        ...(node.error ? { error: node.error, pauseReason: "error", preflightError: true } : {}) };
      if (node.parentKey !== null && !task.parentTaskId) throw fail("SPACE_INVALID_DESTINATION");
      tasks.push(task); known.set(node.key, task); event(task, node.error ? "skipped" : "enqueued"); count++;
    }
    batch.phase = "queued";
  }
  async function uploadFolder(task, connection, signal) {
    if (task.preflightError) throw fail(task.error || "SPACE_SOURCE_UNREADABLE");
    // Existing folder-create is not idempotent. A per-task staging name permits
    // receipt-loss reconciliation without merging an unrelated same-name folder.
    const stagingName = `.wanx-import-${task.id}`;
    if (!task.remoteId) {
      const listing = await request(connection, `/files?parent=${task.parent}&trash=false&space_id=${task.spaceId || "personal"}`, { signal });
      const matches = listing.items.filter(item => item.kind === "folder" && item.name === stagingName);
      if (matches.length > 1) throw fail("SPACE_IMPORT_FOLDER_CONFLICT");
      const entry = matches[0] || await request(connection, "/folders", { method: "POST", signal, body: { parent: task.parent, name: stagingName, space_id: task.spaceId || "personal" } });
      task.remoteId = id(entry.id); await persist();
    }
    const entry = await request(connection, `/files/${task.remoteId}`, { signal });
    if (entry.kind !== "folder" || entry.parent !== task.parent) throw fail("SPACE_IMPORT_FOLDER_CHANGED");
    if (entry.name === stagingName) await request(connection, `/files/${task.remoteId}`, { method: "PATCH", signal, body: { parent: task.parent, name: task.name } });
  }
  async function annotateUpload(task, connection) {
    task.annotationPending = true;
    try {
      await annotations.operation(connection, "auto-annotate", { id: task.kind === "folder" ? task.remoteId : task.id, space_id: task.spaceId || "personal" });
      task.annotationPending = false; task.annotationError = null; task.annotationRetryAt = null;
    } catch (cause) {
      task.annotationError = cause.code || cause.message;
      task.annotationRetryAt = Date.now() + Math.max(15_000, retryBaseMs);
    }
  }
  function scheduleAnnotations(ms = 0) {
    clearTimeout(annotationTimer);
    if (closed || !annotationStore || !ready()) return;
    annotationTimer = setTimeout(retryAnnotations, ms); annotationTimer.unref?.();
  }
  function retryAnnotations() {
    annotationTimer = null;
    if (closed || !ready() || storageError || annotationJobs.size) return;
    const pending = tasks.filter(task => task.scope === scopeKey() && task.phase === "complete" && task.annotationPending);
    const task = pending.find(item => !item.annotationRetryAt || item.annotationRetryAt <= Date.now());
    if (!task) { if (pending.length) scheduleAnnotations(Math.max(1, Math.min(...pending.map(item => item.annotationRetryAt)) - Date.now())); return; }
    const work = (async () => {
      try { await annotateUpload(task, await connect()); }
      catch (cause) { task.annotationError = cause.code || cause.message; task.annotationRetryAt = Date.now() + 15_000; }
      await persist().catch(() => {});
    })().finally(() => { annotationJobs.delete(task.id); notify(); scheduleAnnotations(); });
    annotationJobs.set(task.id, work);
  }
  async function run(task, controller) {
    const { signal } = controller;
    if (task.direction === "import") { await scanPage(task, signal); return; }
    const connection = await connect();
    const transferRequest = async (route, options) => {
      const start = performance.now(); let failure;
      try { driveRouting.remember(task.itemId||task.id,task.spaceId); return await request(connection, route, {...options,spaceId:task.spaceId}); }
      catch (cause) { failure = cause; throw cause; }
      finally { event(task, "request", { stage: route.endsWith("/complete") ? "commit" : options?.method === "PUT" ? "chunk" : "reconcile", durationMs: Math.round(performance.now() - start), errorCode: failure ? errorCode(failure) : undefined, httpStatus: failure?.status,
        transportPhase: failure?.transportPhase, requestBytes: failure?.requestBytes, responseBytes: failure?.responseBytes, reusedSocket: failure?.reusedSocket }); }
    };
    if (task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    if (task.direction === "upload") {
      if (!validUploadName(task.name)) throw fail("SPACE_INVALID_NAME");
      if (task.parentTaskId) {
        const parentTask = taskIndex.get(task.parentTaskId);
        if (parentTask?.phase !== "complete" || !parentTask.remoteId) throw fail("SPACE_IMPORT_PARENT_FAILED");
        task.parent = parentTask.remoteId;
      }
      if (task.kind === "folder") {
        task.phase = "running"; notify(); await uploadFolder(task, connection, signal);
        if (annotations.enabled) await annotateUpload(task, connection);
        if (signal.aborted || task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
        task.phase = "complete"; task.error = null; task.autoResume = false; task.pauseReason = null; event(task, "completed"); return;
      }
      let info;
      try { info = await lstat(task.localPath); } catch (cause) { throw fail(sourceError(cause)); }
      if (info.isSymbolicLink()) throw fail("SPACE_SOURCE_LINK");
      if (!info.isFile()) throw fail("SPACE_SOURCE_UNSUPPORTED");
      if (task.kind === "file" && info.size > MAX_UPLOAD_BYTES) throw fail("SPACE_UPLOAD_LIMIT");
      if (task.preflightError) { task.localStamp = stamp(info); task.size = info.size; task.preflightError = false; }
      if (stamp(info) !== task.localStamp) throw fail("SPACE_LOCAL_FILE_CHANGED");
      task.phase = "checking"; notify();
      const digest = task.digest || await digestFile(task.localPath, signal);
      task.digest = digest;
      const remote = await transferRequest("/uploads", { method: "POST", signal, body: { id: task.id, parent: task.parent, name: task.name, size: task.size, space_id: task.spaceId || "personal" } });
      if (!Number.isSafeInteger(remote.offset) || remote.offset < 0 || remote.offset > task.size) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
      task.offset = remote.offset; event(task, "reconciled");
      if (remote.state !== "complete") {
        const handle = await open(task.localPath, "r");
        try {
          task.phase = "running";
          while (task.offset < task.size) {
            if (signal.aborted) throw fail("SPACE_PAUSED");
            const buffer = Buffer.alloc(Math.min(task.chunkSize || RECOVERY_CHUNK, RECOVERY_CHUNK, task.size - task.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, task.offset);
            if (bytesRead !== buffer.length) throw fail("SPACE_LOCAL_FILE_CHANGED");
            const result = await transferRequest(`/uploads/${task.id}?offset=${task.offset}`, { method: "PUT", signal, body: buffer, headers: { "content-type": "application/octet-stream", "x-content-sha256": hash(buffer) } });
            if (result.offset !== task.offset + bytesRead) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
            task.offset = result.offset; task.attempt = 0;
            event(task, "confirmed"); await checkpoint(); notify();
          }
        } finally { await handle.close(); }
      }
      if (stamp(await fileStat(task.localPath)) !== task.localStamp) throw fail("SPACE_LOCAL_FILE_CHANGED");
      if (remote.state !== "complete") await transferRequest(`/uploads/${task.id}/complete`, { method: "POST", signal, body: { digest: task.digest } });
      if (annotations.enabled) await annotateUpload(task, connection);
      if (signal.aborted || task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    } else {
      const entry = await metadata(connection, task.itemId);
      if (entry.digest !== task.digest || entry.size !== task.size) throw fail("SPACE_REMOTE_FILE_CHANGED");
      const existing = await lstat(task.partialPath).catch(e => { if (e.code !== "ENOENT") throw e; return null; });
      if (existing && (!existing.isFile() || existing.nlink !== 1)) throw fail("SPACE_UNSAFE_DESTINATION");
      const handle = await open(task.partialPath, existing ? "r+" : "wx", 0o600);
      try {
        if (!existing) task.offset = 0;
        if ((await handle.stat()).size < task.offset) task.offset = 0;
        await handle.truncate(task.offset);
        task.phase = "running";
        while (task.offset < task.size) {
          const result = await transferRequest(`/files/${task.itemId}/content?offset=${task.offset}&length=${CHUNK}`, { signal, raw: true });
          if (!result.bytes.length || result.bytes.length > Math.min(CHUNK, task.size - task.offset) || hash(result.bytes) !== result.headers["x-content-sha256"]) throw fail("SPACE_CHUNK_INVALID");
          await handle.write(result.bytes, 0, result.bytes.length, task.offset);
          await handle.sync();
          task.offset += result.bytes.length; await persist(); notify();
        }
      } finally { await handle.close(); }
      if (await digestFile(task.partialPath, signal) !== task.digest) { task.offset = 0; throw fail("SPACE_CHUNK_INVALID"); }
      if (stamp(await fileStat(task.localPath)) !== task.destinationStamp) throw fail("SPACE_DESTINATION_CHANGED");
      if (signal.aborted || task.scope !== scopeKey()) throw fail("SPACE_PAUSED");
      await rename(task.partialPath, task.localPath);
    }
    task.phase = "complete"; task.error = null; task.autoResume = false; task.pauseReason = null; task.attempt = 0; event(task, "completed");
  }
  function pump() {
    clearTimeout(wakeTimer); wakeTimer = null;
    if (closed || !ready() || !scopeKey() || storageError) return;
    if (degraded && !tasks.some(t => t.scope === scopeKey() && ["retrying", "running", "checking"].includes(t.phase))) degraded = false;
    if (Date.now() < retryUntil) { schedulePump(retryUntil - Date.now()); return; }
    const probe = degraded ? tasks.findIndex(t => t.scope === scopeKey() && t.phase === "retrying" && t.autoResume) : -1;
    const start = probe < 0 ? dispatchCursor : probe, count = tasks.length;
    for (let index = 0; index < count; index++) {
      const position = (start + index) % count, task = tasks[position];
      if (running.size >= (degraded ? 1 : 2)) break;
      if (!["queued", "waiting", "retrying"].includes(task.phase) || task.scope !== scopeKey() || running.has(task.id)) continue;
      if (task.direction === "import" && tasks.filter(t => t.batchId === task.id && t.direction === "upload" && !terminal(t) && t.phase !== "paused").length >= IMPORT_WINDOW) continue;
      if (task.parentTaskId) {
        const parent = taskIndex.get(task.parentTaskId);
        if (parent?.phase !== "complete") {
          if (parent?.phase === "paused" && ["error", "parent"].includes(parent.pauseReason)) { task.phase = "paused"; task.pauseReason = "parent"; task.error = "SPACE_IMPORT_PARENT_FAILED"; parentWaiters.add(task); }
          continue;
        }
      }
      task.phase = "queued"; task.pauseReason = null; task.retryAt = null;
      const controller = new AbortController();
      const promise = run(task, controller).catch(cause => {
        const code = controller.signal.aborted ? errorCode(controller.signal.reason) : errorCode(cause);
        if (task.direction === "import") { const iterator = scans.get(task.id); scans.delete(task.id); void iterator?.return().catch(() => {}); }
        lease = null; connectionPromise = null;
        if (!task.autoResume || task.scope !== scopeKey()) {
          task.phase = "paused"; task.error = task.pauseReason === "user" ? null : code;
        } else if (closed || !ready()) {
          task.phase = "waiting"; task.pauseReason = closed ? "restart" : "network"; task.error = null;
        } else if (code === "SPACE_NETWORK_WAIT") {
          task.phase = "retrying"; task.pauseReason = "network"; task.error = code; degraded = true;
          retryUntil = Math.max(retryUntil, Date.now() + recoveryCooldownMs); task.retryAt = retryUntil;
        } else if (transient(cause) && (task.attempt || 0) < maxRetries) {
          task.attempt = (task.attempt || 0) + 1;
          task.phase = "retrying"; task.pauseReason = "network"; task.error = code; degraded = true;
          task.chunkSize = Math.max(256 * 1024, Math.min(RECOVERY_CHUNK, Math.floor((task.chunkSize || CHUNK) / 2)));
          retryUntil = Math.max(retryUntil, Date.now() + Math.max(cause.retryAfter || 0, Math.min(30_000, retryBaseMs * 2 ** (task.attempt - 1)) * (0.5 + random())));
          task.retryAt = retryUntil;
        } else if (transient(cause)) {
          // A network outage is not a user pause or a permanent file failure.
          // Cool the shared connection down, then probe with this stable task ID.
          task.phase = "retrying"; task.pauseReason = "network"; task.error = "SPACE_NETWORK_WAIT";
          task.attempt = 0; degraded = true;
          retryUntil = Math.max(retryUntil, Date.now() + Math.max(recoveryCooldownMs, retryBaseMs)); task.retryAt = retryUntil;
        } else {
          task.phase = "paused"; task.autoResume = false; task.pauseReason = "error"; task.error = transient(cause) ? "SPACE_RETRY_EXHAUSTED" : code;
          if (["SPACE_DISK_FULL", "ACCOUNT_LOGIN_REQUIRED", "ACCOUNT_ACCESS_DENIED", "ACCOUNT_SESSION_EXPIRED", "BOX_PLATFORM_AUTH_FAILED"].includes(code) || [401, 403].includes(cause.status)) {
            // Shared capacity/auth failures stop dispatch; a single bad source
            // never poisons the rest of the batch. Continue is an explicit action.
            for (const pending of tasks) if (pending.scope === task.scope && pending.autoResume && !terminal(pending)) {
              pending.phase = "paused"; pending.autoResume = false; pending.pauseReason = "error"; pending.error = code;
              running.get(pending.id)?.controller.abort(fail(code));
              event(pending, "interrupted", { errorCode: code });
            }
          }
        }
        event(task, "interrupted", { errorCode: code, httpStatus: cause.status });
      }).finally(async () => {
        await (task.direction === "upload" && task.kind !== "folder" ? checkpoint() : persist()).catch(() => { task.error = "SECURE_STORAGE_WRITE_FAILED"; task.phase = "paused"; task.autoResume = false; task.pauseReason = "error"; });
        running.delete(task.id); notify(); pump(); scheduleAnnotations();
      });
      running.set(task.id, { controller, promise });
      dispatchCursor = (position + 1) % count;
    }
    // Successful parent retries release only their dependent descendants.
    for (const task of parentWaiters) {
      if (task.pauseReason !== "parent" || terminal(task)) { parentWaiters.delete(task); continue; }
      if (task.scope === scopeKey() && taskIndex.get(task.parentTaskId)?.phase === "complete") { task.phase = "queued"; task.pauseReason = null; task.error = null; parentWaiters.delete(task); schedulePump(); }
    }
  }
  async function uploads(parent, droppedPaths, expectedScope, droppedNames, spaceId = "personal", folders = false) {
    if (storageError) throw fail(storageError);
    folder(parent); if (spaceId !== "personal") id(spaceId);
    await connect(); const scope = scopeKey(), epoch = generation;
    if (expectedScope !== undefined && expectedScope !== scope) throw fail("SPACE_CONTEXT_CHANGED");
    const selected = droppedPaths === undefined ? await chooseUploads({ folders }) : droppedPaths;
    if (!Array.isArray(selected) || selected.some(file => typeof file !== "string" || !path.isAbsolute(file))) throw fail("SPACE_INVALID_DROP");
    const check = () => { if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED"); };
    check(); if (!selected.length) return { canceled: true };
    if (droppedNames !== undefined && (!Array.isArray(droppedNames) || droppedNames.length !== selected.length || droppedNames.some(n => typeof n !== "string"))) throw fail("SPACE_INVALID_DROP");
    const roots = [], unique = new Set(); let containsFolder = false;
    for (const [index, localPath] of selected.entries()) {
      const fileName = droppedNames === undefined ? path.basename(localPath) : droppedNames[index];
      const key = JSON.stringify([localPath, fileName]); if (unique.has(key)) continue; unique.add(key);
      let info, error;
      try { info = await lstat(localPath); } catch (cause) { error = sourceError(cause); }
      check(); containsFolder ||= info?.isDirectory() === true;
      error ||= !validUploadName(fileName) ? "SPACE_INVALID_NAME" : info?.isSymbolicLink() ? "SPACE_SOURCE_LINK" : info && !info.isFile() && !info.isDirectory() ? "SPACE_SOURCE_UNSUPPORTED" : info?.isFile() && info.size > MAX_UPLOAD_BYTES ? "SPACE_UPLOAD_LIMIT" : null;
      roots.push({ localPath, name: fileName, info, error });
    }
    const sources = roots.map(({ localPath, name }) => ({ localPath, name }));
    const previous = tasks.find(t => t.direction === "import" && t.scope === scope && t.parent === parent && JSON.stringify(t.sources) === JSON.stringify(sources) && (!t.scanComplete || tasks.some(child => child.batchId === t.id && child.direction === "upload" && !terminal(child))));
    if (previous) return { batchId: previous.id, duplicate: true };
    const batchId = randomUUID().replaceAll("-", ""), batchName = roots.length === 1 ? roots[0].name : `${roots.length} 个项目`;
    if (containsFolder) {
      const batch = { id: batchId, batchId, batchName, name: batchName, direction: "import", scope, parent, spaceId, sources, scanComplete: false, phase: "queued", autoResume: true, recoveryVersion: 1 };
      try { await scanPage(batch, new AbortController().signal); check(); tasks.push(batch); }
      catch (cause) { tasks = tasks.filter(t => t.batchId !== batchId); const iterator = scans.get(batchId); scans.delete(batchId); await iterator?.return().catch(() => {}); throw cause; }
    } else {
      for (const [index, root] of roots.entries()) {
        const { localPath, name: fileName, info, error } = root;
        if (tasks.some(t => !terminal(t) && t.scope === scope && t.direction === "upload" && t.parent === parent && !t.parentTaskId && t.localPath === localPath && t.name === fileName && t.localStamp === stamp(info))) continue;
        const task = { batchId, batchName, recoveryVersion: 1, autoResume: !error, id: randomUUID().replaceAll("-", ""), scope, direction: "upload", kind: "file", sourceKey: String(index), relativePath: fileName, parent, spaceId,
          localPath, localStamp: stamp(info), name: fileName, size: info?.size || 0, offset: 0, phase: error ? "paused" : "queued", ...(error ? { error, pauseReason: "error", preflightError: true } : {}) };
        tasks.push(task); event(task, error ? "skipped" : "enqueued");
      }
    }
    check(); await persist(); notify(); pump();
    return { batchId, queued: tasks.filter(t => t.batchId === batchId && t.direction === "upload").length, scanning: containsFolder };
  }
  async function download(itemId) {
    if (storageError) throw fail(storageError);
    const connection = await connect(), scope = scopeKey(), epoch = generation;
    const entry = await metadata(connection, itemId);
    if (entry.kind !== "file") throw fail("SPACE_NOT_FILE");
    const localPath = await chooseDownload(path.basename(entry.name));
    if (!localPath) return;
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    const taskId = randomUUID().replaceAll("-", "");
    const destinationStamp = stamp(await fileStat(localPath));
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    tasks.push({ recoveryVersion: 1, autoResume: true, id: taskId, scope, direction: "download", itemId, spaceId: entry.space_id, name: entry.name, size: entry.size, digest: entry.digest,
      localPath, destinationStamp, partialPath: path.join(path.dirname(localPath), `.wanx-${taskId}.part`), offset: 0, phase: "queued" });
    try { await persist(); } catch (cause) { for (const t of tasks) if (t.phase === "queued") { t.phase = "paused"; t.autoResume = false; t.pauseReason = "error"; } throw cause; }
    notify(); pump();
  }
  async function downloads(itemIds) {
    if (storageError) throw fail(storageError);
    if (!Array.isArray(itemIds) || !itemIds.length) throw fail("SPACE_INVALID_ID");
    const ids = [...new Set(itemIds.map(id))];
    const connection = await connect(), scope = scopeKey(), epoch = generation;
    const checkScope = () => { if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED"); };
    const entries = [];
    for (const itemId of ids) { entries.push(await metadata(connection, itemId)); checkScope(); }
    const directory = await chooseDownloadDirectory();
    checkScope();
    if (!directory) return { canceled: true };
    const planned = [], visited = new Set(), reserved = new Set(tasks.filter(t => t.scope === scope && !["complete", "canceled"].includes(t.phase)).map(t => t.localPath?.toLocaleLowerCase()));
    async function destination(base, entry) {
      // Remote names never become local path components without validation.
      if (typeof entry.name !== "string" || !entry.name || /^[. ]*$/.test(entry.name) || /[\\/\x00-\x1f]/.test(entry.name)) throw fail("SPACE_INVALID_NAME");
      let safeName = entry.name.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/, "_");
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName)) safeName = "_" + safeName;
      const parsed = path.parse(safeName);
      for (let index = 0; ; index++) {
        const candidate = path.join(base, index ? `${parsed.name} (${index})${parsed.ext}` : safeName);
        if (reserved.has(candidate.toLocaleLowerCase())) continue;
        const exists = await lstat(candidate).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
        checkScope();
        if (exists) continue;
        reserved.add(candidate.toLocaleLowerCase());
        return candidate;
      }
    }
    async function collect(entry, base) {
      checkScope(); id(entry.id);
      if (visited.has(entry.id)) return;
      visited.add(entry.id);
      const localPath = await destination(base, entry);
      if (entry.kind === "folder") {
        await mkdir(localPath); checkScope();
        const listing = await request(connection, `/files?parent=${entry.id}&trash=false`);
        checkScope();
        for (const child of listing.items) await collect(child, localPath);
      } else if (entry.kind === "file") {
        const taskId = randomUUID().replaceAll("-", "");
        planned.push({ recoveryVersion: 1, autoResume: true, id: taskId, scope, direction: "download", itemId: entry.id, spaceId: entry.space_id, name: entry.name, size: entry.size, digest: entry.digest,
          localPath, destinationStamp: null, partialPath: path.join(base, `.wanx-${taskId}.part`), offset: 0, phase: "queued" });
      } else throw fail("SPACE_NOT_FILE");
    }
    for (const entry of entries) await collect(entry, directory);
    checkScope();
    tasks.push(...planned);
    try { await persist(); } catch (cause) { for (const task of planned) task.phase = "paused"; throw cause; }
    notify(); pump();
    return { count: planned.length };
  }
  async function transfer(action, taskId) {
    if (action === "retry-annotations") {
      const task = taskIndex.get(id(taskId));
      if (!task || task.scope !== scopeKey() || task.phase !== "complete" || !task.annotationPending) throw fail("SPACE_NOT_FOUND");
      task.annotationRetryAt = 0; await persist(); scheduleAnnotations(); return;
    }
    if (action === "clear-completed") {
      const scope = scopeKey(), groups = importSummaries(tasks, scope);
      if (taskId && !groups.some(g => g.id === id(taskId) && g.phase === "complete")) throw fail("SPACE_TRANSFER_BUSY");
      const completed = new Set(groups.filter(g => g.phase === "complete" && (!taskId || g.id === taskId) && !tasks.some(task => task.batchId === g.id && task.annotationPending)).map(g => g.id));
      const remove = task => task.scope === scope && (completed.has(task.batchId) || !taskId && task.direction === "download" && terminal(task));
      for (const task of tasks) if (remove(task)) taskIndex.delete(task.id);
      tasks = tasks.filter(task => !remove(task)); await persist(); notify(); return;
    }
    if (["pause-batch", "resume-batch", "retry-batch"].includes(action)) {
      const batchId = id(taskId), scope = scopeKey(), epoch = generation;
      const checkScope = () => { if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED"); };
      const members = tasks.filter(t => t.scope === scope && t.batchId === batchId);
      if (!members.length) throw fail("SPACE_NOT_FOUND");
      const batch = members.find(t => t.direction === "import");
      if (action === "pause-batch") {
        for (const task of members) if (!terminal(task) && task.phase !== "paused") { task.autoResume = false; task.phase = "paused"; task.pauseReason = "user"; task.error = null; task.retryAt = null; running.get(task.id)?.controller.abort(fail("SPACE_PAUSED")); }
        await Promise.allSettled(members.map(t => running.get(t.id)?.promise));
        checkScope();
      } else {
        if (action === "retry-batch" && batch && members.some(t => t.preflightError)) {
          const iterator = scans.get(batch.id); scans.delete(batch.id); await iterator?.return().catch(() => {});
          checkScope();
          for (const task of members) if (task.preflightError) task.phase = "canceled";
          batch.scanComplete = false; batch.phase = "paused";
        }
        for (const task of members) if (task.phase === "paused" && !running.has(task.id) && (action === "resume-batch" || ["error", "parent"].includes(task.pauseReason) || task === batch)) {
          task.phase = "queued"; task.autoResume = true; task.error = null; task.pauseReason = null; task.attempt = 0;
        }
        retryUntil = 0;
      }
      await persist(); notify(); pump(); return;
    }
    if (["pause-all", "resume-all", "retry-failed"].includes(action)) {
      sync(); const scope = scopeKey(), epoch = generation;
      if (action === "retry-failed") { for (const task of tasks) if (task.scope === scope && task.annotationPending) task.annotationRetryAt = 0; scheduleAnnotations(); }
      if (action === "retry-failed") for (const batch of tasks.filter(t => t.direction === "import" && t.scope === scope && tasks.some(child => child.batchId === t.id && child.preflightError && child.phase === "paused"))) await transfer("retry-batch", batch.id);
      const selected = tasks.filter(t => t.scope === scope && !terminal(t) && (action === "pause-all" ? t.phase !== "paused" : t.phase === "paused" && (action !== "retry-failed" || t.pauseReason === "error"))).map(t => t.id);
      if (action === "pause-all") for (const target of selected) { const task = tasks.find(t => t.id === target); task.autoResume = false; task.phase = "paused"; task.pauseReason = "user"; task.error = null; task.retryAt = null; running.get(target)?.controller.abort(fail("SPACE_PAUSED")); }
      for (const target of selected) {
        if (scope !== scopeKey() || epoch !== generation) throw fail("SPACE_CONTEXT_CHANGED");
        const task = tasks.find(t => t.id === target);
        if (action === "pause-all") await running.get(target)?.promise;
        else if (!running.has(target)) { task.phase = "queued"; task.error = null; task.pauseReason = null; task.autoResume = true; task.recoveryVersion = 1; task.attempt = 0; }
      }
      if (action !== "pause-all") retryUntil = 0;
      await persist(); notify(); pump(); return;
    }
    const epoch = generation;
    const task = tasks.find(t => t.id === id(taskId) && t.scope === scopeKey());
    if (!task) throw fail("SPACE_NOT_FOUND");
    const job = running.get(task.id);
    if (action === "resume") {
      if (job || task.phase !== "paused") return;
      task.phase = "queued"; task.error = null; task.pauseReason = null; task.autoResume = true; task.recoveryVersion = 1; task.attempt = 0; retryUntil = 0; event(task, "resumed");
      try { await persist(); } catch (cause) { task.phase = "paused"; task.autoResume = false; notify(); throw cause; }
      notify(); pump(); return;
    }
    if (!["pause", "cancel"].includes(action) || task.phase === "complete") return;
    task.autoResume = false; task.pauseReason = "user"; task.phase = "paused"; event(task, "paused");
    job?.controller.abort(fail("SPACE_PAUSED")); await job?.promise;
    task.phase = "paused";
    if (action === "cancel") {
      if (epoch !== generation || task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
      if (task.direction === "upload") {
        if (task.kind !== "folder" && task.kind !== "scan-error" && !task.preflightError) {
          const connection = await connect();
          if (epoch !== generation || task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
          try { await request(connection, `/uploads/${task.id}`, { method: "DELETE", spaceId: task.spaceId }); } catch (cause) { if (cause.status !== 404) throw cause; }
        }
      }
      else await unlink(task.partialPath).catch(e => { if (e.code !== "ENOENT") throw e; });
      task.phase = "canceled";
      task.skipSource = true;
      if (task.kind === "folder") {
        const children = tasks.filter(child => child.batchId === task.batchId && child.sourceKey?.startsWith(task.sourceKey + "/"));
        for (const child of children) { child.autoResume = false; child.pauseReason = "user"; child.skipSource = true; running.get(child.id)?.controller.abort(fail("SPACE_PAUSED")); }
        await Promise.allSettled(children.map(child => running.get(child.id)?.promise));
        for (const child of children) child.phase = "canceled";
      }
    }
    task.error = null; await persist(); notify();
  }
  let previewSequence = 0;
  function cancelPreview() { previewSequence++; }
  async function preview(itemId, { interactive = true } = {}) {
    const sequence = interactive ? ++previewSequence : previewSequence, epoch = generation;
    const current = () => { if (epoch !== generation || (interactive && sequence !== previewSequence) || closed) throw fail("SPACE_CONTEXT_CHANGED"); };
    const connection = await connect(), entry = await metadata(connection, itemId);
    current();
    const ext = path.extname(entry.name).toLowerCase();
    if ([".ppt", ".pptx", ".doc", ".docx"].includes(ext)) {
      if (entry.size > 64 * 1024 * 1024) throw fail("SPACE_PREVIEW_TOO_LARGE");
      const disk = await driveRouting.locate(entry.id); current();
      const drive = disk?.connection_id;
      const prefix = "/api/_client/space-previews";
      const route = `/${entry.id}?version=${entry.version}${drive ? `&drive=${drive}` : ""}`;
      let state = await request(connection, route, { prefix, method: "POST" }); current();
      const deadline = Date.now() + 150_000;
      while (state.state === "processing" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 750)); current();
        state = await request(connection, route, { prefix }); current();
      }
      if (state.state !== "ready") throw fail("SPACE_PREVIEW_TIMEOUT");
      if (!Number.isSafeInteger(state.size) || state.size < 5 || state.size > 64 * 1024 * 1024) throw fail("SPACE_PREVIEW_TOO_LARGE");
      const chunks = [];
      for (let offset = 0; offset < state.size; offset += CHUNK) {
        current();
        const value = await request(connection, `/${entry.id}/content?version=${entry.version}${drive ? `&drive=${drive}` : ""}&offset=${offset}&length=${CHUNK}`, { prefix, raw: true });
        current();
        if (hash(value.bytes) !== value.headers["x-content-sha256"]) throw fail("SPACE_CHUNK_INVALID");
        chunks.push(value.bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (hash(bytes) !== state.digest || bytes.subarray(0, 5).toString() !== "%PDF-") throw fail("SPACE_CHUNK_INVALID");
      return { name: entry.name, type: "application/pdf", converted: true, data: bytes.toString("base64") };
    }
    const type = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" })[ext] || (TEXT_EXTENSIONS.has(ext) ? "text/plain" : null);
    if (!type || entry.size > (ext === ".pdf" ? 64 : 16) * 1024 * 1024) throw fail(ext === ".pdf" ? "SPACE_PREVIEW_TOO_LARGE" : "SPACE_PREVIEW_DOWNLOAD");
    const chunks = [];
    for (let offset = 0; offset < entry.size; offset += CHUNK) {
      current();
      const result = await request(connection, `/files/${entry.id}/content?offset=${offset}&length=${CHUNK}`, { raw: true });
      current();
      if (hash(result.bytes) !== result.headers["x-content-sha256"]) throw fail("SPACE_CHUNK_INVALID");
      chunks.push(result.bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== entry.digest) throw fail("SPACE_CHUNK_INVALID");
    return { name: entry.name, type, data: bytes.toString("base64") };
  }
  async function clipboardRequest(route, options, bound) {
    if (bound !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    const connection = await connect();
    let result;
    try { result = await request(connection, route, { ...options, prefix: "/api/clipboard/v1" }); }
    catch (error) { if (error.code === "SPACE_UPGRADE_REQUIRED") throw fail("CLIPBOARD_SERVICE_UNAVAILABLE"); throw error; }
    if (bound !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    return result;
  }
  return { snapshot, refresh, operation, uploads, download, downloads, transfer, preview, readDocument, cancelPreview, clipboardRequest,
    async close() { closed = true; clearTimeout(wakeTimer); clearTimeout(annotationTimer); clearTimeout(checkpointTimer); clearTimeout(notifyTimer); generation++; unsubscribe(); for (const job of running.values()) job.controller.abort(); redactionJob?.controller.abort(fail("SPACE_CONTEXT_CHANGED")); await Promise.allSettled([redactionJob?.promise, redactionRules?.close()]); await workbench.close(); await Promise.allSettled([...running.values()].map(j => j.promise)); await Promise.allSettled([...annotationJobs.values()]); for (const iterator of scans.values()) await iterator.return().catch(() => {}); scans.clear(); for (const t of tasks) if (t.phase === "queued") { t.phase = t.autoResume ? "waiting" : "paused"; t.pauseReason = "restart"; } if (!storageError) await persist(); await annotations.close(); } };
}
