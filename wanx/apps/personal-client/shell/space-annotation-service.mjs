import { createHash, randomBytes } from "node:crypto";
import { extname } from "node:path";
import { createSpaceAnnotations } from "./space-annotations.mjs";

const fail = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const textTypes = new Set([".txt", ".md", ".csv", ".json", ".log"]);
const maxText = 128 * 1024;
const searchPageEntries = 2000;
const searchPageFolders = 128;
const searchCursorLifetime = 10 * 60 * 1000;
const maxSearchCursors = 16;
const fingerprint = entry => JSON.stringify([entry.id, entry.parent, entry.name, entry.kind, entry.digest, entry.size, entry.version, entry.modified]);

// The index supplies candidates only. Every operation uses the current box
// lease and freshly authorized metadata before reading or returning a record.
export async function createSpaceAnnotationService({ store, scope, request, assertWritable = async () => {}, notify = () => {} }) {
  let index, loadError;
  const searchCursors = new Map();
  try { index = await createSpaceAnnotations({ store }); }
  catch (cause) { loadError = cause; }
  const enabled = !!store;
  const available = () => { if (loadError) throw loadError; if (!enabled) throw fail("SPACE_ANNOTATION_UNAVAILABLE"); };
  function context(connection, spaceId = "personal") {
    if (spaceId !== "personal" && !validId(spaceId)) throw fail("SPACE_INVALID_ID");
    const owner = scope();
    const check = () => { connection.context(); if (!owner || owner !== scope()) throw fail("SPACE_CONTEXT_CHANGED"); };
    check();
    return { spaceId, key: JSON.stringify([owner, spaceId]), check, connection };
  }
  async function stat(ctx, itemId) {
    if (!validId(itemId)) throw fail("SPACE_INVALID_ID");
    ctx.check();
    const entry = await request(ctx.connection, `/files/${itemId}`, { spaceId: ctx.spaceId });
    ctx.check();
    if (entry?.id !== itemId || entry.trashed != null || entry.space_id && entry.space_id !== ctx.spaceId) throw fail("SPACE_NOT_FOUND");
    return entry;
  }
  async function observe(ctx, entry, root = "", relativePath = false) {
    ctx.check();
    const ancestors = [], seen = new Set([entry.id]);
    let parent = entry.parent;
    while (parent) {
      if (!validId(parent) || seen.has(parent) || ancestors.length >= 64) throw fail("SPACE_INVALID_DESTINATION");
      seen.add(parent);
      const ancestor = await stat(ctx, parent);
      if (ancestor.kind !== "folder") throw fail("SPACE_INVALID_DESTINATION");
      ancestors.push(ancestor); parent = ancestor.parent;
    }
    ancestors.reverse();
    const rootIndex = root ? ancestors.findIndex(ancestor => ancestor.id === root) : -1;
    if (root && rootIndex < 0) throw fail("SPACE_LINK_SCOPE");
    for (const ancestor of ancestors) { ctx.check(); await index.observe(ctx.key, ancestor); }
    ctx.check();
    const annotation = await index.observe(ctx.key, entry);
    ctx.check();
    const path = relativePath ? ancestors.slice(rootIndex + 1) : ancestors;
    return { ...entry, folder_path: path.map(folder => folder.name).join(" / "),
      annotation: provenance(annotation, [entry, ...ancestors]) };
  }
  function provenance(annotation, entries) {
    if (!annotation) return annotation;
    const known = new Map(entries.map(entry => [entry.id, entry]));
    return { ...annotation, provenance: annotation.provenance.map(item => {
      const source = known.get(item.itemId), path = []; let current = source; const seen = new Set();
      while (current && !seen.has(current.id)) { seen.add(current.id); path.unshift(current.name); current = known.get(current.parent); }
      return { ...item, ...(source ? { sourceName: source.name, sourcePath: path.join("/") } : {}) };
    }) };
  }
  async function decorate(connection, entry, spaceId = "personal") {
    if (!enabled || !entry?.id || entry.trashed != null) return entry;
    const ctx = context(connection, spaceId);
    try { available(); return await observe(ctx, entry); }
    catch (cause) { ctx.check(); return { ...entry, annotationError: cause.code || cause.message || "SPACE_ANNOTATION_UNAVAILABLE" }; }
  }
  async function list(connection, result, spaceId) {
    if (!enabled || !Array.isArray(result?.items)) return result;
    const ctx = context(connection, spaceId), ancestors = new Map(), active = result.items.filter(entry => entry?.id && entry.trashed == null);
    try {
      available();
      for (const entry of active) {
        let parent = entry.parent; const seen = new Set([entry.id]);
        while (parent) {
          if (!validId(parent) || seen.has(parent) || seen.size > 64) throw fail("SPACE_INVALID_DESTINATION"); seen.add(parent);
          const ancestor = ancestors.get(parent) || await stat(ctx, parent);
          ancestors.set(parent, ancestor); parent = ancestor.parent;
        }
      }
      const entries = [...ancestors.values(), ...active], values = new Map();
      for (let offset = 0; offset < entries.length; offset += 10000) {
        ctx.check(); const chunk = entries.slice(offset, offset + 10000), annotations = await index.observeMany(ctx.key, chunk); ctx.check();
        chunk.forEach((entry, index) => values.set(entry.id, annotations[index]));
      }
      // Resolve inheritance after every parent has been observed, independent
      // of listing order. get() does not write the store.
      for (const entry of active) values.set(entry.id, await index.get(ctx.key, entry.id)); ctx.check();
      return { ...result, items: result.items.map(entry => values.has(entry.id) ? { ...entry, annotation: provenance(values.get(entry.id), entries) } : entry) };
    } catch (cause) { ctx.check(); return { ...result, items: result.items.map(entry => ({ ...entry, annotationError: cause.code || cause.message })) }; }
  }
  const sourceVersion = entry => JSON.stringify([entry.id, entry.parent, entry.kind, entry.name, entry.digest ?? null, entry.size ?? null, entry.version ?? null, entry.modified ?? null]);
  async function writable(ctx, entry) {
    if (entry.writable === false || ctx.connection.context()?.writable === false) throw fail("SPACE_ANNOTATION_READ_ONLY");
    await assertWritable(ctx, entry); ctx.check();
  }
  async function inRoot(ctx, entry, root) {
    if (!root || entry.id === root) return;
    let parent = entry.parent; const seen = new Set();
    while (parent && !seen.has(parent) && seen.size < 64) {
      if (parent === root) return; seen.add(parent); parent = (await stat(ctx, parent)).parent;
    }
    throw fail("SPACE_LINK_SCOPE");
  }
  async function applyBatch(connection, input) {
    available(); const ctx = context(connection, input.space_id || "personal");
    const existing = await index.batchReceipt(ctx.key, input.operationId); ctx.check();
    const prepared = [], current = new Map();
    for (const item of input.items) {
      let preflightError;
      try {
        const entry = await stat(ctx, item.id); await inRoot(ctx, entry, input.parent); await writable(ctx, entry);
        current.set(item.id, (await observe(ctx, entry)).annotation);
        if (sourceVersion(entry) !== item.sourceVersion) throw fail("SPACE_REMOTE_FILE_CHANGED");
      } catch (cause) { ctx.check(); preflightError = /^(?:SPACE|BOX|MCP)_[A-Z0-9_]+$/.test(cause.code || "") ? cause.code : "SPACE_ANNOTATION_READ_ONLY"; }
      prepared.push({ id: item.id, expectedRevision: item.expectedRevision, fingerprint: item.fingerprint, changes: item.changes, ...(preflightError ? { preflightError } : {}) });
    }
    ctx.check();
    const receipt = existing || await index.applyBatch(ctx.key, { operationId: input.operationId, items: prepared }); ctx.check();
    return { ...receipt, items: receipt.items.map(item => {
      const failed = prepared.find(row => row.id === item.id)?.preflightError;
      return failed ? { id: item.id, status: "failed", code: failed, ...(current.has(item.id) ? { annotation: current.get(item.id) } : {}) }
        : { ...item, ...(current.has(item.id) && (existing || item.status !== "applied") ? { annotation: current.get(item.id) } : {}) };
    }) };
  }
  async function undoBatch(connection, input) {
    available(); const ctx = context(connection, input.space_id || "personal"), original = await index.batchReceipt(ctx.key, input.operationId); ctx.check();
    if (!original) throw fail("SPACE_NOT_FOUND");
    const previous = await index.batchReceipt(ctx.key, input.undoOperationId); ctx.check();
    const items = [];
    for (const item of original.items.filter(row => row.status === "applied")) {
      let annotation, preflightError;
      try { const entry = await stat(ctx, item.id); await inRoot(ctx, entry, input.parent); await writable(ctx, entry); annotation = (await observe(ctx, entry)).annotation; }
      catch (cause) { ctx.check(); preflightError = /^(?:SPACE|BOX|MCP)_[A-Z0-9_]+$/.test(cause.code || "") ? cause.code : "SPACE_ANNOTATION_READ_ONLY"; }
      items.push({ id: item.id, expectedRevision: annotation?.revision || item.annotation?.revision || 1,
        fingerprint: annotation?.fingerprint || item.annotation?.fingerprint || "unavailable", ...(preflightError ? { preflightError } : {}) });
    }
    if (!items.length) return { operationId: input.undoOperationId, items: [] };
    if (previous) return { ...previous, items: previous.items.map(item => {
      const fresh = items.find(row => row.id === item.id);
      return fresh?.preflightError ? { id: item.id, status: "failed", code: fresh.preflightError } : item;
    }) };
    const result = await index.undoBatch(ctx.key, { operationId: input.operationId, undoOperationId: input.undoOperationId, items }); ctx.check(); return result;
  }
  async function batchReceipt(connection, input) {
    available(); const ctx = context(connection, input.space_id || "personal");
    const result = await index.batchReceipt(ctx.key, input.operationId); ctx.check(); return result;
  }
  async function auto(ctx, entry) {
    let contentText;
    if (entry.kind === "file" && textTypes.has(extname(entry.name).toLowerCase()) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= maxText) {
      const value = await request(ctx.connection, `/files/${entry.id}/content?offset=0&length=${Math.max(1, entry.size)}`, { raw: true, spaceId: ctx.spaceId });
      ctx.check();
      if (value.bytes.length !== entry.size || entry.digest && createHash("sha256").update(value.bytes).digest("hex") !== entry.digest) throw fail("SPACE_REMOTE_FILE_CHANGED");
      try { contentText = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes); }
      catch { throw fail("SPACE_SOURCE_UNSUPPORTED"); }
      if (contentText.includes("\0")) throw fail("SPACE_SOURCE_UNSUPPORTED");
      if (fingerprint(await stat(ctx, entry.id)) !== fingerprint(entry)) throw fail("SPACE_REMOTE_FILE_CHANGED");
    }
    return (await observe(ctx, { ...entry, ...(contentText !== undefined ? { contentText } : {}) })).annotation;
  }
  async function operation(connection, action, input = {}) {
    available();
    const ctx = context(connection, input.space_id || "personal");
    if (action === "annotation-imports") {
      if (ctx.spaceId !== "personal") throw fail("SPACE_ACTION_INVALID");
      const rows = await index.imports(ctx.key, input.warehouseId, input.query); ctx.check();
      return rows.map(row => ({ ...row, space_id: "personal" }));
    }
    if (action === "search-annotations") return search(ctx, input);
    const entry = await stat(ctx, input.id);
    const current = await observe(ctx, entry);
    if (action === "annotation") return current.annotation;
    if (["auto-annotate", "set-annotation"].includes(action)) {
      await writable(ctx, entry);
    }
    if (action === "auto-annotate") { const result = await auto(ctx, entry); ctx.check(); notify(); return result; }
    if (action === "annotation-bind") {
      if (ctx.spaceId !== "personal" || entry.kind !== "file" || input.digest !== entry.digest) throw fail("SPACE_REMOTE_FILE_CHANGED");
      const { space_id, ...binding } = input;
      const result = await index.bind(ctx.key, binding); ctx.check(); return result;
    }
    if (action !== "set-annotation") throw fail("SPACE_ACTION_INVALID");
    // Fetching metadata and observing its new content before the CAS makes a
    // dialog opened against an old file revision fail without overwriting it.
    const { id, space_id, ...changes } = input;
    const result = await index.set(ctx.key, entry.id, changes);
    ctx.check(); notify(); return result;
  }
  async function search(ctx, input) {
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 300) throw fail("SPACE_ANNOTATION_INVALID");
    const query = input.query.trim().toLocaleLowerCase(), root = input.parent || "";
    const filesOnly = input.filesOnly === true;
    const after = input.after ?? "";
    if (after !== "" && (!filesOnly || typeof after !== "string" || !/^[a-f0-9]{32}$/.test(after)))
      throw fail("SPACE_ANNOTATION_INVALID");
    const searchKey = JSON.stringify([ctx.key, root, query]);
    const saved = after ? searchCursors.get(after) : null;
    if (after && (!saved || saved.key !== searchKey || saved.expires <= Date.now()))
      throw fail("SPACE_TAG_RESULTS_CHANGED");
    if (root) { const entry = await stat(ctx, root); if (entry.kind !== "folder") throw fail("SPACE_INVALID_DESTINATION"); await observe(ctx, entry); }
    const matches = (entry, annotation) =>
      [entry.name, ...(annotation?.tags || []), annotation?.description || ""].join("\n").toLocaleLowerCase().includes(query);
    // Continue a checkpoint only after a successful page. Failed reads can retry
    // the same cursor, and queued metadata never authorizes a returned item.
    const queue = saved ? [...saved.queue] : [{ id: root, depth: 0 }], seen = new Set(saved?.seen);
    let candidates = saved?.candidates || [];
    let scanned = 0, folders = 0, scanLimited = saved?.scanLimited || false;
    if (!candidates.length) {
      candidates = [];
      while (queue.length && folders < searchPageFolders && scanned < searchPageEntries) {
        const folder = queue.shift();
        let entries = folder.entries;
        const offset = folder.offset || 0;
        if (!entries && seen.has(folder.id)) continue;
        folders++;
        try {
          if (folder.id && folder.id !== root) {
            const current = await stat(ctx, folder.id);
            if (current.kind !== "folder") throw fail("SPACE_NOT_FOUND");
            await observe(ctx, current, root);
          }
          if (!entries) {
            seen.add(folder.id);
            const page = await request(ctx.connection, `/files?parent=${folder.id}&trash=false&space_id=${ctx.spaceId}`, { spaceId: ctx.spaceId });
            ctx.check();
            if (!Array.isArray(page?.items)) throw fail("SPACE_REQUEST_FAILED");
            entries = page.items;
          }
        } catch (error) {
          ctx.check();
          if (![403, 404].includes(error.status) && !["SPACE_LINK_SCOPE", "SPACE_NOT_FOUND"].includes(error.code)) throw error;
          scanLimited = true;
          continue;
        }
        const end = Math.min(entries.length, offset + searchPageEntries - scanned);
        const eligible = entries.slice(offset, end).filter(entry => validId(entry?.id) &&
          entry.trashed == null && entry.parent === folder.id && (!entry.space_id || entry.space_id === ctx.spaceId));
        const annotations = await index.observeMany(ctx.key, eligible);
        ctx.check();
        scanned += end - offset;
        eligible.forEach((entry, index) => {
          if (entry.kind === "folder") {
            if (folder.depth < 16) queue.push({ id: entry.id, depth: folder.depth + 1 });
            else scanLimited = true;
          }
          if ((!filesOnly || entry.kind === "file") && matches(entry, annotations[index])) candidates.push(entry);
        });
        if (end < entries.length) queue.unshift({ ...folder, entries, offset: end });
      }
      if (filesOnly) candidates.sort((a, b) => a.id.localeCompare(b.id));
    }
    const limit = Math.max(1, Math.min(100, Number.isSafeInteger(input.limit) ? input.limit : 50)), items = [];
    let consumed = 0;
    for (; consumed < candidates.length && items.length < limit; consumed++) {
      const candidate = candidates[consumed];
      try {
        const current = await stat(ctx, candidate.id);
        if (fingerprint(current) !== fingerprint(candidate)) continue;
        const row = await observe(ctx, current, root, filesOnly);
        if (matches(row, row.annotation)) items.push(row);
      } catch (cause) { ctx.check(); if (![403, 404].includes(cause.status) && !["SPACE_NOT_FOUND", "SPACE_LINK_SCOPE"].includes(cause.code)) throw cause; }
    }
    ctx.check();
    const more = consumed < candidates.length || queue.length > 0;
    let nextCursor = null;
    if (filesOnly && more) {
      nextCursor = randomBytes(16).toString("hex");
      if (searchCursors.size >= maxSearchCursors) searchCursors.delete(searchCursors.keys().next().value);
      searchCursors.set(nextCursor, {key:searchKey, expires:Date.now() + searchCursorLifetime,
        scanLimited, queue, seen, candidates:candidates.slice(consumed)});
    }
    return filesOnly
      ? {items, scanned, truncated:scanLimited || Boolean(nextCursor), scanLimited, nextCursor}
      : {items, scanned, truncated:more || scanLimited};
  }
  async function localOperation(action, input) {
    available();
    const owner = scope(), spaceId = input.space_id || "personal";
    if (!owner || spaceId !== "personal") throw fail("SPACE_CONTEXT_CHANGED");
    const key = JSON.stringify([owner, spaceId]);
    // Receipts are candidates observed by the importer, never permissions or
    // completed bindings. Reconnection checks both source and document again.
    const { space_id, ...receipt } = input;
    const result = action === "annotation-stage-import" ? await index.stage(key, receipt) : await index.pending(key, input.warehouseId);
    if (scope() !== owner) throw fail("SPACE_CONTEXT_CHANGED");
    return Array.isArray(result) ? result.map(row => ({ ...row, space_id: spaceId })) : result;
  }
  return { enabled, decorate, list, operation, localOperation, applyBatch, undoBatch, batchReceipt,
    async close() { searchCursors.clear(); await index?.close(); } };
}
