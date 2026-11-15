import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { validateWorkbenchInput } from "./annotation-workbench-contract.mjs";
import { extractAnnotationContent } from "./annotation-content.mjs";

const uid = () => randomUUID().replaceAll("-", "");
const fail = code => Object.assign(new Error(code), { code });
const isId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const copy = value => structuredClone(value);
const sourceVersion = entry => JSON.stringify([entry.id, entry.parent, entry.kind, entry.name, entry.digest ?? null, entry.size ?? null, entry.version ?? null, entry.modified ?? null]);
const tagsValid = tags => Array.isArray(tags) && tags.length <= 30 && tags.every(tag => typeof tag === "string" && tag.trim() && tag.length <= 80);
const uniqueTags = tags => [...new Map(tags.map(tag => [tag.trim().toLocaleLowerCase(), tag.trim()])).values()];
const activeStatuses = new Set(["scanning", "applying", "suggesting", "undoing"]);
const rowStatus = row => row.error ? "failed" : row.annotation?.needsReview ? "review" : row.suggestion ? "suggested" : row.annotation?.manual ? "confirmed" : "unannotated";

export async function createAnnotationWorkbench({ store, scope, owner = scope, interaction = scope, ready = () => true,
  operation, batch, undo, receipt, readBytes, preview, model = {}, extract = extractAnnotationContent, notify = () => {} }) {
  let state = { version: 1, jobs: [], schemes: [] }, broken = false, queue = Promise.resolve(), closed = false;
  const running = new Map();
  if (store) try {
    const loaded = await store.load();
    if (loaded != null) {
      if (loaded.version !== 1 || !Array.isArray(loaded.jobs) || !Array.isArray(loaded.schemes) ||
        loaded.jobs.some(job => !isId(job.id) || typeof job.scope !== "string" || !Array.isArray(job.rows) || job.rows.some(row => !isId(row.id)))) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
      state = loaded;
      for (const job of state.jobs) if (activeStatuses.has(job.status)) { job.status = "paused"; job.error = "SPACE_ANNOTATION_RESTARTED"; }
    }
  } catch { broken = true; }
  const available = () => { if (!store) throw fail("SPACE_ANNOTATION_UNAVAILABLE"); if (broken) throw fail("SPACE_ANNOTATION_STORAGE_FAILED"); if (closed) throw fail("SPACE_CONTEXT_CHANGED"); };
  const namespace = space => { const value = scope(); return value ? JSON.stringify([value, space]) : null; };
  function jobFor(id) {
    const job = state.jobs.find(item => item.id === id);
    if (!job || !namespace(job.space_id) || job.scope !== namespace(job.space_id)) throw fail("SPACE_CONTEXT_CHANGED");
    return job;
  }
  function mutate(fn) {
    const work = queue.catch(() => {}).then(async () => {
      available(); const next = copy(state), result = fn(next);
      try { await store.save(next); } catch { throw fail("SPACE_ANNOTATION_STORAGE_FAILED"); }
      state = next; notify(); return copy(result);
    }); queue = work; return work;
  }
  const update = (id, fn) => mutate(next => { const job = next.jobs.find(item => item.id === id); if (!job) throw fail("SPACE_NOT_FOUND"); fn(job); job.updated = Date.now(); return job; });
  function bound(job, signal, online = true) {
    const context = interaction();
    const check = () => {
      if (closed || signal?.aborted || job.scope !== namespace(job.space_id) || context !== interaction()) throw fail("SPACE_CONTEXT_CHANGED");
      if (online && !ready()) throw fail("BOX_CONNECTION_REQUIRED");
    }; check(); return check;
  }
  function filterRows(job, filter = {}) {
    const query = String(filter.query || "").toLocaleLowerCase();
    return job.rows.filter(row => (!filter.type || filter.type === "all" || row.format === filter.type || row.kind === filter.type) &&
      (!filter.status || filter.status === "all" || rowStatus(row) === filter.status) &&
      (!query || [row.name, row.path, ...(row.annotation?.tags || []), row.annotation?.description || ""].join("\n").toLocaleLowerCase().includes(query)));
  }
  function select(job, selection) {
    if (!selection || Array.isArray(selection) || Object.keys(selection).some(key => !["ids", "allMatching"].includes(key)) || !!selection.ids === !!selection.allMatching) throw fail("SPACE_ANNOTATION_INVALID");
    if (selection.allMatching) {
      if (!job.scanComplete) throw fail("SPACE_ANNOTATION_SCAN_INCOMPLETE");
      if (typeof selection.allMatching !== "object" || Object.keys(selection.allMatching).some(key => !["query", "type", "status"].includes(key))) throw fail("SPACE_ANNOTATION_INVALID");
      return filterRows(job, selection.allMatching);
    }
    if (!Array.isArray(selection.ids) || !selection.ids.length || selection.ids.some(id => !isId(id)) || new Set(selection.ids).size !== selection.ids.length) throw fail("SPACE_ANNOTATION_INVALID");
    const wanted = new Set(selection.ids), rows = job.rows.filter(row => wanted.has(row.id));
    if (rows.length !== wanted.size) throw fail("SPACE_NOT_FOUND"); return rows;
  }
  function view(job, input = {}) {
    const filtered = filterRows(job, input), offset = input.offset ?? 0, limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail("SPACE_ANNOTATION_INVALID");
    const summary = { total: job.rows.length, unannotated: 0, suggested: 0, confirmed: 0, review: 0, failed: 0 }, tagCounts = new Map();
    for (const row of job.rows) { summary[rowStatus(row)]++; for (const tag of row.annotation?.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1); }
    summary.tagCounts = [...tagCounts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    const filteredTags = new Map(), descriptions = new Set();
    const filteredSummary = { count: filtered.length, tagCounts: [], emptyDescriptions: 0, commonDescription: null, inheritOn: 0, inheritOff: 0 };
    for (const row of filtered) {
      for (const tag of new Set(row.annotation?.manual?.tags ?? row.annotation?.automatic?.tags ?? [])) filteredTags.set(tag, (filteredTags.get(tag) || 0) + 1);
      const description = row.annotation?.description || ""; descriptions.add(description);
      if (!description.trim()) filteredSummary.emptyDescriptions++;
      filteredSummary[row.annotation?.inherit === false ? "inheritOff" : "inheritOn"]++;
    }
    filteredSummary.tagCounts = [...filteredTags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    if (descriptions.size === 1) filteredSummary.commonDescription = descriptions.values().next().value;
    const { rows, scanQueue, scanCurrent, initialIds, plan, suggestionTargets, ...publicJob } = job;
    return copy({ job: { ...publicJob, total: rows.length, scanned: rows.length }, items: filtered.slice(offset, offset + limit).map(row => ({ ...row, status: rowStatus(row) })),
      total: rows.length, filteredTotal: filtered.length, offset, summary, filteredSummary,
      resumableJobs: state.jobs.filter(item => item.scope === job.scope && item.id !== job.id).map(item => ({ id: item.id, status: item.status, total: item.rows.length, parent: item.parent })) });
  }
  async function currentRow(job, row, check) {
    const entry = await operation("stat", { id: row.id, space_id: job.space_id }); check();
    if (!entry || entry.id !== row.id || entry.trashed != null || entry.space_id && entry.space_id !== job.space_id) throw fail("SPACE_NOT_FOUND");
    // A selected subtree remains a permission boundary after the manifest was scanned.
    if (job.parent && entry.id !== job.parent) {
      let parent = entry.parent, within = false; const seen = new Set();
      while (parent && !seen.has(parent) && seen.size < 64) {
        if (parent === job.parent) { within = true; break; } seen.add(parent);
        const ancestor = await operation("stat", { id: parent, space_id: job.space_id }); check(); parent = ancestor.parent;
      }
      if (!within) throw fail("SPACE_LINK_SCOPE");
    }
    return entry;
  }
  function start(id, activity, worker) {
    if (running.has(id)) throw fail("SPACE_ANNOTATION_BUSY");
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => worker(controller.signal)).catch(async cause => {
      const job = state.jobs.find(item => item.id === id); if (!job || job.status === "canceled") return;
      await update(id, item => { item.status = "paused"; item.error = cause.code || "SPACE_ANNOTATION_FAILED"; }).catch(() => {});
    }).finally(() => { running.delete(id); notify(); });
    running.set(id, { controller, promise, activity });
  }
  async function scan(id, signal) {
    let job = jobFor(id); const check = bound(job, signal);
    await update(id, item => { item.status = "scanning"; item.activity = "scan"; item.error = null; });
    while (true) {
      check(); job = jobFor(id);
      if (!job.scanCurrent) {
        if (!job.scanQueue.length) break;
        const folder = job.scanQueue[0];
        let entries;
        if (folder.ids) {
          entries = [];
          for (let at = 0; at < folder.ids.length; at += 2) {
            const group = await Promise.all(folder.ids.slice(at, at + 2).map(itemId => operation("stat", { id: itemId, space_id: job.space_id }))); check(); entries.push(...group);
          }
        } else {
          const page = await operation("list", { parent: folder.id, space_id: job.space_id }); check();
          if (!Array.isArray(page?.items)) throw fail("SPACE_REQUEST_FAILED"); entries = page.items;
        }
        await update(id, item => { item.scanCurrent = { folder, entries: entries.filter(entry => entry.trashed == null), offset: 0 }; });
        job = jobFor(id);
      }
      const current = job.scanCurrent, chunk = current.entries.slice(current.offset, current.offset + 50);
      await update(id, item => {
        const known = new Set(item.rows.map(row => row.id));
        for (const entry of chunk) {
          if (!isId(entry.id) || known.has(entry.id)) continue;
          if (!entry.annotation) throw fail(entry.annotationError || "SPACE_ANNOTATION_UNAVAILABLE");
          const path = [current.folder.path, entry.name].filter(Boolean).join("/");
          item.rows.push({ ...entry, path, sourceVersion: sourceVersion(entry), format: entry.kind === "folder" ? "folder" : extname(entry.name).slice(1).toLowerCase(), writable: entry.writable !== false }); known.add(entry.id);
          if (item.recursive && entry.kind === "folder" && !item.seenFolders.includes(entry.id)) { item.scanQueue.push({ id: entry.id, path }); item.seenFolders.push(entry.id); }
        }
        item.scanCurrent.offset += chunk.length;
        if (item.scanCurrent.offset >= item.scanCurrent.entries.length) { item.scanCurrent = null; item.scanQueue.shift(); }
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    check(); await update(id, item => { item.scanComplete = true; item.status = "ready"; item.activity = null; });
  }
  function changesFor(row, input) {
    const mode = input.change || {};
    if (Object.keys(mode).some(key => !["tagMode", "tags", "descriptionMode", "description", "inherit"].includes(key)) ||
      !["keep", "add", "remove", "replace"].includes(mode.tagMode || "keep") || !["keep", "fill-empty", "replace"].includes(mode.descriptionMode || "keep") ||
      mode.tags !== undefined && !tagsValid(mode.tags) || mode.description !== undefined && (typeof mode.description !== "string" || mode.description.length > 2000) ||
      mode.inherit !== undefined && typeof mode.inherit !== "boolean") throw fail("SPACE_ANNOTATION_INVALID");
    const annotation = row.annotation, ownTags = annotation.manual?.tags ?? annotation.automatic?.tags ?? [], changes = {};
    const suggestion = input.acceptSuggestions ? row.suggestion : null;
    const wantedTags = suggestion?.tags ?? mode.tags ?? [];
    const tagMode = suggestion && mode.tagMode === undefined ? "add" : mode.tagMode || "keep";
    if (tagMode === "add") changes.tags = uniqueTags([...ownTags, ...wantedTags]);
    if (tagMode === "remove") { const removed = new Set(wantedTags.map(tag => tag.toLocaleLowerCase())); changes.tags = ownTags.filter(tag => !removed.has(tag.toLocaleLowerCase())); }
    if (tagMode === "replace") changes.tags = uniqueTags(wantedTags);
    const description = suggestion?.description ?? mode.description ?? "", descriptionMode = suggestion && mode.descriptionMode === undefined ? "fill-empty" : mode.descriptionMode || "keep";
    if (descriptionMode === "replace" || descriptionMode === "fill-empty" && description.trim() && !annotation.description?.trim()) changes.description = description;
    if (mode.inherit !== undefined) changes.inherit = mode.inherit;
    if (input.useDrafts && row.draft) {
      if (row.draftRevision !== undefined && row.draftRevision !== row.annotation.revision) throw fail("SPACE_ANNOTATION_CONFLICT");
      Object.assign(changes, row.draft);
    }
    if (!annotation.needsReview) {
      if (changes.tags && JSON.stringify(changes.tags) === JSON.stringify(annotation.manual?.tags)) delete changes.tags;
      if (changes.description !== undefined && changes.description.trim() === annotation.manual?.description) delete changes.description;
      if (changes.inherit !== undefined && changes.inherit === annotation.inherit) delete changes.inherit;
    }
    if (Object.keys(changes).length) changes.reviewed = true;
    if (changes.tags && !tagsValid(changes.tags)) throw fail("SPACE_ANNOTATION_INVALID");
    return changes;
  }
  async function prepare(input) {
    const job = jobFor(input.jobId); bound(job);
    if (running.has(job.id)) throw fail("SPACE_ANNOTATION_BUSY");
    const rows = select(job, input.selection), items = rows.filter(row => !input.acceptSuggestions || row.suggestion).map(row => ({ id: row.id,
      expectedRevision: row.annotation.revision, fingerprint: row.annotation.fingerprint, sourceVersion: row.sourceVersion, changes: changesFor(row, input) })).filter(item => Object.keys(item.changes).length);
    if (!items.length) throw fail("SPACE_ANNOTATION_NO_CHANGES");
    const plan = { id: uid(), operationId: uid(), items, created: Date.now() };
    await update(job.id, item => { item.plan = plan; item.completedChunks = []; item.applied = []; item.completed = 0; item.undone = false; });
    return { planId: plan.id, operationId: plan.operationId, targetCount: rows.length, changeCount: items.length,
      examples: items.slice(0, 5).map(item => { const row = rows.find(row => row.id === item.id); return { id: row.id, name: row.name, before: row.annotation, after: item.changes }; }),
      warnings: rows.some(row => row.writable === false) ? ["只读项目将在提交时单列，其他项目继续。"] : [] };
  }
  async function apply(id, signal) {
    let job = jobFor(id); const check = bound(job, signal), checkpoint = bound(job, undefined, false);
    await update(id, item => { item.status = "applying"; item.activity = "apply"; item.error = null; item.applied ||= []; });
    for (let offset = 0; offset < job.plan.items.length; offset += 50) {
      check(); job = jobFor(id); const items = job.plan.items.slice(offset, offset + 50), operationId = `${job.id}:${job.plan.operationId}:${offset / 50}`;
      if (job.completedChunks?.includes(operationId)) continue;
      const receipt = await batch({ space_id: job.space_id, parent: job.parent, operationId, items }); checkpoint();
      await update(id, item => {
        item.completedChunks ||= []; item.completedChunks.push(operationId);
        if (receipt.items.some(row => row.status === "applied")) item.lastBatch = { id: item.plan.operationId, operations: [...item.completedChunks] };
        for (const result of receipt.items) {
          const row = item.rows.find(row => row.id === result.id); if (!row) continue;
          row.error = result.status === "applied" ? null : result.code || "SPACE_ANNOTATION_CONFLICT";
          if (result.annotation) row.annotation = result.annotation;
          if (result.status === "applied") { delete row.draft; delete row.draftRevision; delete row.suggestion; item.applied.push(result.id); }
        }
        item.completed = Math.min(offset + 50, item.plan.items.length);
      });
      check();
    }
    check(); await update(id, item => { if (item.applied?.length) item.lastBatch = { operations: [...(item.completedChunks || [])], id: item.plan.operationId }; item.status = item.rows.some(row => row.error) ? "partial" : "complete"; item.activity = null; });
  }
  async function undoJob(id, signal) {
    const job = jobFor(id), check = bound(job, signal);
    let operations = job.lastBatch?.operations || [];
    if (job.plan && receipt) {
      const committed = [];
      for (let offset = 0; offset < job.plan.items.length; offset += 50) {
        const operationId = `${job.id}:${job.plan.operationId}:${offset / 50}`;
        const result = await receipt({ space_id: job.space_id, operationId }); check();
        if (result?.items.some(item => item.status === "applied")) committed.push(operationId);
      }
      if (committed.length) operations = committed;
    }
    if (!operations.length) throw fail("SPACE_ANNOTATION_NOTHING_TO_UNDO");
    await update(id, item => { item.status = "undoing"; item.activity = "undo"; });
    for (const operationId of [...operations].reverse()) {
      check();
      const result = await undo({ space_id: job.space_id, parent: job.parent, operationId, undoOperationId: `undo:${operationId}` }); check();
      await update(id, item => { for (const rowResult of result.items) { const row = item.rows.find(row => row.id === rowResult.id); if (row) { row.error = rowResult.status === "applied" ? null : rowResult.code || "SPACE_ANNOTATION_CONFLICT"; if (rowResult.annotation) row.annotation = rowResult.annotation; } } });
    }
    check(); await update(id, item => { item.status = item.rows.some(row => row.error) ? "partial" : "ready"; item.activity = null; item.undone = true; });
  }
  async function suggest(id, signal) {
    let job = jobFor(id); const check = bound(job, signal);
    await update(id, item => { item.status = "suggesting"; item.activity = "suggest"; item.error = null; });
    for (const itemId of job.suggestionTargets) {
      check(); job = jobFor(id); const row = job.rows.find(row => row.id === itemId);
      if (row.suggestion || row.suggestionSkipped) continue;
      try {
        const entry = await currentRow(job, row, check);
        if (sourceVersion(entry) !== row.sourceVersion) throw fail("SPACE_REMOTE_FILE_CHANGED");
        let extracted = { content: "", mode: "name-only", format: row.format, truncated: false };
        if (row.kind === "file") {
          if (["txt", "md", "csv", "tsv", "json", "log", "html", "htm", "pdf", "docx", "xlsx", "pptx"].includes(row.format) && entry.size <= 64 * 1024 * 1024) {
            const bytes = await readBytes(entry, job.space_id, signal); check(); extracted = await extract({ entry, bytes, signal }); check();
          } else extracted = { content: "", mode: "name-only", format: row.format, truncated: false, reason: "SPACE_ANNOTATION_NAME_ONLY" };
        }
        const request = { modelPresetId: job.modelPresetId, file: { name: entry.name, path: row.path, kind: entry.kind, format: extracted.format,
          content: extracted.mode === "content" ? extracted.content : "", contentMode: extracted.mode === "content" ? "content" : "name-only", truncated: extracted.truncated }, instructions: job.instructions || "", tags: job.schemeTags || [] };
        const suggestion = job.modelPresetId === "rules" ? {
          tags: uniqueTags([...(entry.annotation.automatic?.tags || []), ...(job.schemeTags || [])]),
          description: extracted.content.replace(/\s+/g, " ").slice(0, 240), model: { id: "rules", provider: "local", name: "本地规则" },
          contentMode: extracted.mode, truncated: extracted.truncated,
        } : await model.suggest(request, { signal });
        check();
        if (!tagsValid(suggestion.tags) || typeof suggestion.description !== "string" || suggestion.description.length > 2000) throw fail("SPACE_ANNOTATION_INVALID_MODEL_OUTPUT");
        const after = await currentRow(job, row, check);
        if (sourceVersion(after) !== row.sourceVersion || after.annotation.revision !== row.annotation.revision) throw fail("SPACE_ANNOTATION_CONFLICT");
        await update(id, item => { const target = item.rows.find(row => row.id === itemId); target.suggestion = { ...suggestion, contentMode: extracted.mode, truncated: extracted.truncated, reason: extracted.reason, created: Date.now() }; target.error = null; item.completed = (item.completed || 0) + 1; });
      } catch (cause) {
        check(); await update(id, item => { const target = item.rows.find(row => row.id === itemId); target.error = cause.code || "SPACE_ANNOTATION_MODEL_FAILED"; });
      }
    }
    check(); await update(id, item => { item.status = item.rows.some(row => row.error) ? "partial" : "ready"; item.activity = null; });
  }
  async function resume(job) {
    const workers = { scan, apply, suggest, undo: undoJob }, activity = job.activity || (!job.scanComplete ? "scan" : null);
    if (!workers[activity]) throw fail("SPACE_ANNOTATION_NOT_RESUMABLE");
    bound(job); await update(job.id, item => { item.status = { scan: "scanning", apply: "applying", suggest: "suggesting", undo: "undoing" }[activity]; item.error = null; });
    start(job.id, activity, signal => workers[activity](job.id, signal));
  }
  async function models() {
    const local = { id: "rules", name: "本地规则（无需模型）", provider: "local" };
    try { const result = await model.models?.({}); return { available: true, aiAvailable: result?.available === true, reason: result?.reason,
      presets: [local, ...(result?.presets || []).filter(item => item.id !== "rules")] }; }
    catch (cause) { return { available: true, aiAvailable: false, presets: [local], reason: cause.code || "SPACE_ANNOTATION_MODEL_UNAVAILABLE" }; }
  }
  return {
    async run(raw) {
      const beforeScope = scope(), beforeOwner = owner(), beforeInteraction = interaction();
      const execute = async () => {
      available(); const input = validateWorkbenchInput(raw); await queue.catch(() => {});
      if (input.op === "models") return models();
      if (input.op === "schemes") return copy({ items: state.schemes.filter(item => item.owner === owner()).map(({ owner, ...scheme }) => scheme) });
      if (["save-scheme", "delete-scheme"].includes(input.op)) {
        if (!owner()) throw fail("SPACE_CONTEXT_CHANGED");
        const who = owner();
        return mutate(next => {
          if (input.op === "delete-scheme") { next.schemes = next.schemes.filter(item => item.id !== input.id || item.owner !== who); return { deleted: true }; }
          const value = input.scheme;
          if (!value || Array.isArray(value) || Object.keys(value).some(key => !["id", "name", "tags", "instructions", "inherit"].includes(key)) ||
            typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || !tagsValid(value.tags || []) ||
            value.instructions !== undefined && (typeof value.instructions !== "string" || value.instructions.length > 4000) || value.inherit !== undefined && typeof value.inherit !== "boolean" || value.id !== undefined && !isId(value.id)) throw fail("SPACE_ANNOTATION_INVALID");
          if (value.id && !next.schemes.some(item => item.id === value.id && item.owner === who)) throw fail("SPACE_NOT_FOUND");
          const scheme = { id: value.id || uid(), name: value.name.trim(), tags: uniqueTags(value.tags || []), instructions: value.instructions || "", ...(value.inherit !== undefined ? { inherit: value.inherit } : {}), owner: who };
          next.schemes = next.schemes.filter(item => item.id !== scheme.id); next.schemes.push(scheme); const { owner: ignored, ...publicScheme } = scheme; return publicScheme;
        });
      }
      if (input.op === "open") {
        const space = input.space_id || "personal", parent = input.parent || "";
        if (space !== "personal" && !isId(space) || parent && !isId(parent) || input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.length || input.ids.some(id => !isId(id))) || input.recursive !== undefined && typeof input.recursive !== "boolean") throw fail("SPACE_ANNOTATION_INVALID");
        const key = namespace(space); if (!key || !ready()) throw fail("BOX_CONNECTION_REQUIRED");
        const initialIds = input.ids ? [...new Set(input.ids)].sort() : null;
        const previous = !input.fresh && [...state.jobs].reverse().find(job => job.scope === key && job.parent === parent && job.recursive === !!input.recursive && JSON.stringify(job.initialIds) === JSON.stringify(initialIds));
        if (previous) return view(previous);
        const job = { id: uid(), scope: key, space_id: space, parent, recursive: input.recursive === true, initialIds, rows: [],
          scanQueue: [initialIds ? { ids: initialIds, path: "" } : { id: parent, path: "" }], scanCurrent: null, seenFolders: parent ? [parent] : [], scanComplete: false,
          status: "scanning", activity: "scan", created: Date.now(), updated: Date.now(), completed: 0 };
        await mutate(next => { next.jobs.push(job); return job; }); start(job.id, "scan", signal => scan(job.id, signal)); return view(job);
      }
      const job = jobFor(input.jobId);
      // Terminal state is durable before the worker's finally microtask runs.
      // Drain that already-completed worker before accepting another edit.
      if (["ready", "complete", "partial"].includes(job.status) && running.has(job.id)) await running.get(job.id).promise;
      if (input.op === "list") return view(job, input);
      if (input.op === "draft") {
        if (activeStatuses.has(job.status)) throw fail("SPACE_ANNOTATION_BUSY");
        const patch = input.patch;
        if (!patch || Array.isArray(patch) || Object.keys(patch).some(key => !["tags", "description", "inherit"].includes(key)) ||
          patch.tags !== undefined && !tagsValid(patch.tags) || patch.description !== undefined && (typeof patch.description !== "string" || patch.description.length > 2000) || patch.inherit !== undefined && typeof patch.inherit !== "boolean") throw fail("SPACE_ANNOTATION_INVALID");
        bound(job, undefined, false);
        await update(job.id, item => { const row = item.rows.find(row => row.id === input.id); if (!row) throw fail("SPACE_NOT_FOUND"); row.draft = { ...row.draft, ...copy(patch) }; row.draftRevision = row.annotation.revision; item.plan = null; }); return view(jobFor(job.id));
      }
      if (input.op === "refresh-item") {
        if (activeStatuses.has(job.status)) throw fail("SPACE_ANNOTATION_BUSY");
        if (input.discardDraft !== undefined && typeof input.discardDraft !== "boolean") throw fail("SPACE_ANNOTATION_INVALID");
        const row = job.rows.find(row => row.id === input.id); if (!row) throw fail("SPACE_NOT_FOUND"); const check = bound(job);
        const entry = await currentRow(job, row, check);
        await update(job.id, item => { const target = item.rows.find(row => row.id === row.id);
          Object.assign(target, entry, { sourceVersion: sourceVersion(entry), error: null });
          if (input.discardDraft) { delete target.draft; delete target.draftRevision; }
          item.plan = null;
        }); return view(jobFor(job.id));
      }
      if (input.op === "prepare") return prepare(input);
      if (input.op === "preview") {
        const row = job.rows.find(row => row.id === input.id); if (!row) throw fail("SPACE_NOT_FOUND"); const check = bound(job);
        const entry = await currentRow(job, row, check); if (sourceVersion(entry) !== row.sourceVersion) throw fail("SPACE_REMOTE_FILE_CHANGED");
        try { const value = await preview(entry.id, { interactive: false }); check(); if (sourceVersion(await currentRow(job, row, check)) !== row.sourceVersion) throw fail("SPACE_REMOTE_FILE_CHANGED"); return value; }
        catch (cause) {
          check();
          if ([401, 403, 404].includes(cause.status) || ["SPACE_CONTEXT_CHANGED", "SPACE_REMOTE_FILE_CHANGED", "SPACE_LINK_SCOPE", "SPACE_NOT_FOUND"].includes(cause.code)) throw cause;
          const bytes = await readBytes(entry, job.space_id); const result = await extract({ entry, bytes }); check();
          if (sourceVersion(await currentRow(job, row, check)) !== row.sourceVersion) throw fail("SPACE_REMOTE_FILE_CHANGED");
          return { name: entry.name, type: "text/plain", data: Buffer.from(result.content || "此文件暂不支持内容预览。").toString("base64"), contentMode: result.mode, truncated: result.truncated, reason: result.reason || cause.code };
        }
      }
      if (["pause", "cancel"].includes(input.op)) {
        running.get(job.id)?.controller.abort(); await update(job.id, item => { item.status = input.op === "cancel" ? "canceled" : "paused"; }); return view(jobFor(job.id));
      }
      if (input.op === "resume") { if (running.has(job.id)) throw fail("SPACE_ANNOTATION_BUSY"); await resume(job); return view(jobFor(job.id)); }
      if (input.op === "apply") {
        if (!job.plan || job.plan.id !== input.planId) throw fail("SPACE_ANNOTATION_CONFLICT"); bound(job);
        if (job.lastBatch?.id === job.plan.operationId && job.completedChunks?.length === Math.ceil(job.plan.items.length / 50)) return view(job);
        if (!running.has(job.id)) { await update(job.id, item => { item.status = "applying"; item.activity = "apply"; }); start(job.id, "apply", signal => apply(job.id, signal)); } return view(jobFor(job.id));
      }
      if (input.op === "undo") {
        if ((!job.lastBatch && !job.plan) || job.undone) throw fail("SPACE_ANNOTATION_NOTHING_TO_UNDO"); bound(job);
        if (running.has(job.id)) { running.get(job.id).controller.abort(); await running.get(job.id).promise; }
        await update(job.id, item => { item.status = "undoing"; item.activity = "undo"; }); start(job.id, "undo", signal => undoJob(job.id, signal)); return view(jobFor(job.id));
      }
      if (input.op === "skip-suggestions") {
        bound(job, undefined, false); if (running.has(job.id)) throw fail("SPACE_ANNOTATION_BUSY");
        const ids = new Set(select(job, input.selection).map(row => row.id));
        await update(job.id, item => { for (const row of item.rows) if (ids.has(row.id)) { delete row.suggestion; row.suggestionSkipped = true; } item.plan = null; });
        return view(jobFor(job.id));
      }
      if (input.op === "suggest") {
        bound(job); if (running.has(job.id)) throw fail("SPACE_ANNOTATION_BUSY");
        if (typeof input.modelPresetId !== "string" || !input.modelPresetId || input.modelPresetId.length > 256 || input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 4000)) throw fail("SPACE_ANNOTATION_INVALID");
        const rows = select(job, input.selection), scheme = input.schemeId ? state.schemes.find(item => item.id === input.schemeId && item.owner === owner()) : null;
        if (input.schemeId && !scheme) throw fail("SPACE_NOT_FOUND");
        const instructions = [...new Set([scheme?.instructions, input.instructions].filter(Boolean))].join("\n");
        if (instructions.length > 4000) throw fail("SPACE_ANNOTATION_INSTRUCTIONS_TOO_LONG");
        await update(job.id, item => {
          item.suggestionTargets = rows.map(row => row.id);
          for (const target of item.rows) if (item.suggestionTargets.includes(target.id)) { delete target.suggestion; delete target.suggestionSkipped; }
          item.modelPresetId = input.modelPresetId; item.instructions = instructions; item.schemeTags = scheme?.tags || []; item.completed = 0; item.activity = "suggest"; item.status = "suggesting"; item.plan = null;
        });
        start(job.id, "suggest", signal => suggest(job.id, signal)); return view(jobFor(job.id));
      }
      throw fail("SPACE_ANNOTATION_INVALID");
      };
      const result = await execute();
      if (scope() !== beforeScope || owner() !== beforeOwner || interaction() !== beforeInteraction) throw fail("SPACE_CONTEXT_CHANGED");
      return result;
    },
    contextChanged() { for (const work of running.values()) work.controller.abort(); },
    async close() { closed = true; for (const work of running.values()) work.controller.abort(); await Promise.allSettled([...running.values()].map(work => work.promise)); await queue.catch(() => {}); },
  };
}
