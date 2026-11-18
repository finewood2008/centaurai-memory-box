import { createHash } from "node:crypto";
import { extname } from "node:path";

const fail = code => Object.assign(new Error(code), { code });
const own = (value, key) => Object.hasOwn(value, key);
const resource = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const rules = [
  ["合同", /合同|协议|contract|agreement/i],
  ["财务", /财务|发票|报销|预算|finance|invoice|budget/i],
  ["项目", /项目|方案|project|proposal/i],
  ["会议", /会议|纪要|meeting|minutes/i],
  ["研发", /研发|代码|开发|engineering|development|source code/i],
  ["学习", /学习|课程|教程|learning|course|tutorial/i],
];
const types = [
  ["文档", [".txt", ".md", ".pdf", ".doc", ".docx", ".rtf"]],
  ["表格", [".csv", ".tsv", ".xls", ".xlsx"]],
  ["演示", [".ppt", ".pptx", ".key"]],
  ["图片", [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]],
  ["音频", [".mp3", ".wav", ".m4a", ".flac"]],
  ["视频", [".mp4", ".mov", ".webm", ".mkv"]],
];
function automatic(entry) {
  const content = typeof entry.contentText === "string" ? entry.contentText.slice(0, 32768) : "";
  const text = `${entry.name}\n${content}`;
  const tags = rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  const type = types.find(([, extensions]) => extensions.includes(extname(entry.name).toLowerCase()));
  if (entry.kind !== "folder" && type) tags.push(type[0]);
  return { tags, description: content.replace(/\s+/g, " ").trim().slice(0, 240), source: "rules-v1" };
}
const contentFingerprint = entry => JSON.stringify(entry.kind === "folder" ? ["folder"] :
  [entry.kind, entry.digest ?? null, entry.size ?? null, entry.digest ? null : entry.modified ?? entry.version ?? null]);
const key = (scope, id) => JSON.stringify([scope, id]);
const scopeValid = scope => typeof scope === "string" && scope.length > 0 && scope.length <= 4096;
const warehouseValid = value => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const documentValid = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const tagsValid = (tags, limit = 30) => Array.isArray(tags) && tags.length <= limit && tags.every(tag => typeof tag === "string" && tag.trim().length > 0 && tag.length <= 80);
const manualValid = manual => manual === null || (manual && typeof manual === "object" && !Array.isArray(manual) &&
  Object.keys(manual).every(field => ["tags", "description"].includes(field)) &&
  (!own(manual, "tags") || tagsValid(manual.tags)) &&
  (!own(manual, "description") || typeof manual.description === "string" && manual.description.length <= 2000));
const operationValid = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const preflightErrorValid = value => typeof value === "string" && value.length <= 81 && /^(?:SPACE|BOX|MCP)_[A-Z0-9_]+$/.test(value);
const changesValid = value => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(field => ["tags", "description", "inherit", "reviewed"].includes(field)) &&
  (!own(value, "tags") || tagsValid(value.tags)) &&
  (!own(value, "description") || typeof value.description === "string" && value.description.length <= 2000) &&
  ["inherit", "reviewed"].every(field => !own(value, field) || typeof value[field] === "boolean");
const selectionValid = (items, withChanges = false) => Array.isArray(items) && items.length <= 50 &&
  new Set(items.map(item => item?.id)).size === items.length && items.every(item => item && !Array.isArray(item) &&
    Object.keys(item).every(field => ["id", "expectedRevision", "fingerprint", "preflightError", ...(withChanges ? ["changes"] : [])].includes(field)) &&
    resource(item.id) && Number.isSafeInteger(item.expectedRevision) && item.expectedRevision >= 1 &&
    typeof item.fingerprint === "string" && item.fingerprint.length <= 4096 &&
    (!own(item, "preflightError") || preflightErrorValid(item.preflightError)) && (!withChanges || changesValid(item.changes)));

// The supplied store is OS-encrypted by the main process. This index is a cache
// of annotations, never authority to read an item; callers revalidate on the box.
export async function createSpaceAnnotations({ store } = {}) {
  let records = new Map(), bindings = new Map(), pendingImports = new Map(), batchReceipts = new Map(), storageError = null, queue = Promise.resolve();
  if (store) {
    try {
      const value = await store.load();
      if (value !== null && value !== undefined) {
        if (value.version !== 1 || !Array.isArray(value.records)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
        for (const record of value.records) {
          if (!scopeValid(record?.scope) || !resource(record.id) || !["file", "folder"].includes(record.kind) ||
            typeof record.name !== "string" || !(record.parent === "" || resource(record.parent)) ||
            !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.fingerprint !== "string" ||
            typeof record.needsReview !== "boolean" || typeof record.inherit !== "boolean" || !manualValid(record.manual) ||
            !tagsValid(record.automatic?.tags) || typeof record.automatic.description !== "string" || record.automatic.source !== "rules-v1" ||
            record.contentTags !== undefined && !tagsValid(record.contentTags) ||
            record.contentHash !== undefined && (typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)))
            throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          const recordKey = key(record.scope, record.id);
          if (records.has(recordKey)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          records.set(recordKey, record);
        }
        if (value.imports !== undefined && !Array.isArray(value.imports)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
        for (const binding of value.imports || []) {
          if (!scopeValid(binding?.scope) || !bindingValid(binding)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          const bindingKey = JSON.stringify([binding.scope, binding.warehouseId, binding.documentId]);
          if (bindings.has(bindingKey)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          bindings.set(bindingKey, binding);
        }
        if (value.pendingImports !== undefined && !Array.isArray(value.pendingImports)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
        for (const receipt of value.pendingImports || []) {
          if (!scopeValid(receipt?.scope) || !bindingValid(receipt, true)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          const receiptKey = JSON.stringify([receipt.scope, receipt.warehouseId, receipt.documentId]);
          if (pendingImports.has(receiptKey) || bindings.has(receiptKey)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          pendingImports.set(receiptKey, receipt);
        }
        if (value.batchReceipts !== undefined && !Array.isArray(value.batchReceipts)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
        for (const receipt of value.batchReceipts || []) {
          if (!batchReceiptValid(receipt)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          const receiptKey = key(receipt.scope, receipt.operationId);
          if (batchReceipts.has(receiptKey)) throw fail("SPACE_ANNOTATION_STORAGE_FAILED");
          batchReceipts.set(receiptKey, receipt);
        }
      }
    } catch { records = new Map(); bindings = new Map(); pendingImports = new Map(); batchReceipts = new Map(); storageError = "SPACE_ANNOTATION_STORAGE_FAILED"; }
  }
  const available = () => {
    if (!store) throw fail("SPACE_ANNOTATION_UNAVAILABLE");
    if (storageError) throw fail(storageError);
  };
  function effective(scope, id, sourceRecords = records) {
    const record = sourceRecords.get(key(scope, id));
    if (!record) return null;
    const tags = [], provenance = [], visited = new Set();
    let description = "", descriptionSource = null, descriptionChosen = false, current = record;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const manual = current.needsReview ? null : current.manual;
      const source = manual && own(manual, "tags") ? "manual" : "automatic";
      for (const tag of source === "manual" ? manual.tags : current.automatic.tags) {
        if (tags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) continue;
        tags.push(tag);
        provenance.push({ tag, source: current === record ? source : "inherited", itemId: current.id, origin: source });
      }
      if (!descriptionChosen && (manual && own(manual, "description") || current.automatic.description)) {
        description = manual && own(manual, "description") ? manual.description : current.automatic.description;
        descriptionSource = { source: current === record ? manual && own(manual, "description") ? "manual" : "automatic" : "inherited", itemId: current.id };
        descriptionChosen = true;
      }
      if (!current.inherit || !current.parent) break;
      current = sourceRecords.get(key(scope, current.parent));
    }
    return structuredClone({ tags, description, provenance, descriptionSource, revision: record.revision,
      needsReview: record.needsReview, manual: record.manual, automatic: record.automatic, inherit: record.inherit,
      fingerprint: record.fingerprint });
  }
  async function commit(next, nextBindings = bindings, nextPending = pendingImports, nextReceipts = batchReceipts) {
    try { await store.save({ version: 1, records: [...next.values()], imports: [...nextBindings.values()], pendingImports: [...nextPending.values()], batchReceipts: [...nextReceipts.values()] }); }
    catch { throw fail("SPACE_ANNOTATION_STORAGE_FAILED"); }
    records = next; bindings = nextBindings; pendingImports = nextPending; batchReceipts = nextReceipts;
  }
  function mutate(work) {
    const pending = queue.catch(() => {}).then(work);
    queue = pending;
    return pending;
  }
  function observation(scope, entry, next) {
    if (!scopeValid(scope) || !resource(entry?.id) || !["file", "folder"].includes(entry.kind) ||
      typeof entry.name !== "string" || entry.name.length > 1000 || !(entry.parent === "" || resource(entry.parent)))
      throw fail("SPACE_ANNOTATION_INVALID");
    const recordKey = key(scope, entry.id), previous = next.get(recordKey), fingerprint = contentFingerprint(entry);
    const hasContent = typeof entry.contentText === "string";
    const contentHash = hasContent ? createHash("sha256").update(entry.contentText.slice(0, 32768)).digest("hex") : undefined;
    if (previous && previous.name === entry.name && previous.parent === entry.parent && previous.fingerprint === fingerprint &&
      (!hasContent || contentHash === previous.contentHash)) return false;
    const unchangedContent = previous?.fingerprint === fingerprint;
    const generated = automatic(entry);
    // Listing metadata does not erase verified extraction for the same bytes.
    if (unchangedContent && !hasContent && previous.contentHash) {
      generated.tags = [...new Set([...generated.tags, ...(previous.contentTags || [])])];
      generated.description = previous.automatic.description;
    }
    next.set(recordKey, { scope, id: entry.id, parent: entry.parent, kind: entry.kind, name: entry.name,
      digest: entry.digest ?? null, revision: (previous?.revision || 0) + 1, automatic: generated,
      manual: previous?.manual ?? null, needsReview: previous?.needsReview === true || !!previous?.manual && !unchangedContent,
      inherit: previous?.inherit ?? true, fingerprint,
      contentTags: hasContent ? automatic({ name: "", kind: "folder", contentText: entry.contentText }).tags : unchangedContent ? previous?.contentTags || [] : [],
      ...((hasContent ? contentHash : unchangedContent ? previous?.contentHash : undefined) ? { contentHash: hasContent ? contentHash : previous.contentHash } : {}) });
    return true;
  }
  function observeMany(scope, entries) {
    if (!Array.isArray(entries) || entries.length > 10000) return Promise.reject(fail("SPACE_ANNOTATION_INVALID"));
    if (!store) return Promise.resolve(entries.map(() => null));
    return mutate(async () => {
      available();
      if (!scopeValid(scope)) throw fail("SPACE_ANNOTATION_INVALID");
      const next = new Map(records);
      let changed = false;
      for (const entry of entries) changed = observation(scope, entry, next) || changed;
      if (changed) await commit(next);
      return entries.map(entry => effective(scope, entry.id));
    });
  }
  function knownReceipt(scope, operationId, requestHash, kind) {
    const receipt = batchReceipts.get(key(scope, operationId));
    if (receipt && (receipt.kind !== kind || receipt.requestHash !== requestHash)) throw fail("SPACE_ANNOTATION_OPERATION_CONFLICT");
    return receipt;
  }
  return {
    async get(scope, id) {
      if (!store) return null;
      await queue.catch(() => {}); available();
      if (!scopeValid(scope) || !resource(id)) throw fail("SPACE_ANNOTATION_INVALID");
      return effective(scope, id);
    },
    observe(scope, entry) {
      return observeMany(scope, [entry]).then(([result]) => result);
    },
    observeMany,
    set(scope, id, input = {}) {
      return mutate(async () => {
        available();
        if (!scopeValid(scope) || !resource(id) || !input || Array.isArray(input) ||
          Object.keys(input).some(field => !["expectedRevision", "tags", "description", "inherit", "reviewed", "reset"].includes(field)) ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          own(input, "tags") && !tagsValid(input.tags) ||
          own(input, "description") && (typeof input.description !== "string" || input.description.length > 2000) ||
          ["inherit", "reviewed", "reset"].some(field => own(input, field) && typeof input[field] !== "boolean")) throw fail("SPACE_ANNOTATION_INVALID");
        const recordKey = key(scope, id), previous = records.get(recordKey);
        if (!previous) throw fail("SPACE_NOT_FOUND");
        if (input.expectedRevision !== previous.revision) throw fail("SPACE_ANNOTATION_CONFLICT");
        const record = structuredClone(previous);
        if (input.reset === true) { record.manual = null; record.needsReview = false; }
        for (const field of ["tags", "description"]) if (own(input, field)) {
          record.manual ||= {};
          record.manual[field] = field === "tags" ? [...new Set(input.tags.map(tag => tag.trim()))] : input.description.trim();
        }
        if (own(input, "inherit")) record.inherit = input.inherit;
        if (input.reviewed === true) record.needsReview = false;
        record.revision++;
        const next = new Map(records); next.set(recordKey, record); await commit(next);
        return effective(scope, id);
      });
    },
    applyBatch(scope, input) {
      return mutate(async () => {
        available();
        if (!scopeValid(scope) || !input || Array.isArray(input) ||
          Object.keys(input).some(field => !["operationId", "items"].includes(field)) ||
          !operationValid(input.operationId) || !selectionValid(input.items, true) || !input.items.length)
          throw fail("SPACE_ANNOTATION_INVALID");
        const requestHash = batchRequestHash(input), known = knownReceipt(scope, input.operationId, requestHash, "apply");
        if (known) return publicBatchReceipt(known);
        const next = new Map(records), items = [];
        for (const item of input.items) {
          if (item.preflightError) { items.push({ id: item.id, status: "failed", code: item.preflightError }); continue; }
          const recordKey = key(scope, item.id), previous = records.get(recordKey);
          if (!previous) { items.push({ id: item.id, status: "failed", code: "SPACE_NOT_FOUND" }); continue; }
          if (previous.revision !== item.expectedRevision || previous.fingerprint !== item.fingerprint) {
            items.push({ id: item.id, status: "conflict", code: previous.fingerprint !== item.fingerprint ? "SPACE_REMOTE_FILE_CHANGED" : "SPACE_ANNOTATION_CONFLICT" });
            continue;
          }
          const record = structuredClone(previous), changes = item.changes;
          for (const field of ["tags", "description"]) if (own(changes, field)) {
            record.manual ||= {};
            record.manual[field] = field === "tags" ? [...new Set(changes.tags.map(tag => tag.trim()))] : changes.description.trim();
          }
          if (own(changes, "inherit")) record.inherit = changes.inherit;
          if (changes.reviewed === true) record.needsReview = false;
          record.revision++;
          next.set(recordKey, record);
          items.push({ id: item.id, status: "applied", before: manualState(previous), postRevision: record.revision, fingerprint: record.fingerprint });
        }
        // Parent and child changes in one block expose the same final effective
        // state; no intermediate inheritance snapshot escapes the transaction.
        for (const item of items) if (item.status === "applied") item.annotation = effective(scope, item.id, next);
        const receipt = { scope, kind: "apply", operationId: input.operationId, requestHash, items };
        const nextReceipts = new Map(batchReceipts); nextReceipts.set(key(scope, input.operationId), receipt);
        await commit(next, bindings, pendingImports, nextReceipts);
        return publicBatchReceipt(receipt);
      });
    },
    undoBatch(scope, input) {
      return mutate(async () => {
        available();
        if (!scopeValid(scope) || !input || Array.isArray(input) ||
          Object.keys(input).some(field => !["operationId", "undoOperationId", "items"].includes(field)) ||
          !operationValid(input.operationId) || !operationValid(input.undoOperationId) ||
          own(input, "items") && !selectionValid(input.items)) throw fail("SPACE_ANNOTATION_INVALID");
        const requestHash = batchRequestHash(input), known = knownReceipt(scope, input.undoOperationId, requestHash, "undo");
        if (known) return publicBatchReceipt(known);
        const original = batchReceipts.get(key(scope, input.operationId));
        if (!original || original.kind !== "apply") throw fail("SPACE_ANNOTATION_OPERATION_NOT_FOUND");
        const applied = original.items.filter(item => item.status === "applied");
        const selection = own(input, "items") ? new Map(input.items.map(item => [item.id, item])) : null;
        if (selection && [...selection.keys()].some(id => !applied.some(item => item.id === id))) throw fail("SPACE_ANNOTATION_INVALID");
        const next = new Map(records), items = [];
        for (const originalItem of applied) {
          if (selection && !selection.has(originalItem.id)) continue;
          const id = originalItem.id, recordKey = key(scope, id), previous = records.get(recordKey), selected = selection?.get(id);
          if (selected?.preflightError) { items.push({ id, status: "failed", code: selected.preflightError }); continue; }
          if (!previous) { items.push({ id, status: "failed", code: "SPACE_NOT_FOUND" }); continue; }
          if (previous.revision !== originalItem.postRevision || previous.fingerprint !== originalItem.fingerprint ||
            selected && (selected.expectedRevision !== previous.revision || selected.fingerprint !== previous.fingerprint)) {
            items.push({ id, status: "conflict", code: previous.fingerprint !== originalItem.fingerprint || selected && selected.fingerprint !== previous.fingerprint ? "SPACE_REMOTE_FILE_CHANGED" : "SPACE_ANNOTATION_CONFLICT" });
            continue;
          }
          // Restore only user-controlled state. In particular, keep current
          // automatic tags and extraction rather than replacing an old record.
          const record = { ...previous, ...structuredClone(originalItem.before), revision: previous.revision + 1 };
          next.set(recordKey, record);
          items.push({ id, status: "applied", before: manualState(previous), postRevision: record.revision, fingerprint: record.fingerprint });
        }
        for (const item of items) if (item.status === "applied") item.annotation = effective(scope, item.id, next);
        const receipt = { scope, kind: "undo", operationId: input.undoOperationId, sourceOperationId: input.operationId, requestHash, items };
        const nextReceipts = new Map(batchReceipts); nextReceipts.set(key(scope, input.undoOperationId), receipt);
        await commit(next, bindings, pendingImports, nextReceipts);
        return publicBatchReceipt(receipt);
      });
    },
    async batchReceipt(scope, operationId) {
      if (!store) return null;
      await queue.catch(() => {}); available();
      if (!scopeValid(scope) || !operationValid(operationId)) throw fail("SPACE_ANNOTATION_INVALID");
      const receipt = batchReceipts.get(key(scope, operationId));
      return receipt ? publicBatchReceipt(receipt) : null;
    },
    bind(scope, input) {
      return mutate(async () => {
        available();
        if (!scopeValid(scope) || !bindingValid(input)) throw fail("SPACE_ANNOTATION_INVALID");
        const binding = normalizedReceipt(scope, input);
        const bindingKey = JSON.stringify([scope, input.warehouseId, input.documentId]);
        const next = new Map(bindings);
        if (JSON.stringify(next.get(bindingKey)) === JSON.stringify(binding) && !pendingImports.has(bindingKey)) return structuredClone(binding);
        const nextPending = new Map(pendingImports); nextPending.delete(bindingKey);
        next.set(bindingKey, binding); await commit(records, next, nextPending);
        return structuredClone(binding);
      });
    },
    stage(scope, input) {
      return mutate(async () => {
        available();
        if (!scopeValid(scope) || !bindingValid(input, true)) throw fail("SPACE_ANNOTATION_INVALID");
        const receipt = normalizedReceipt(scope, input);
        const receiptKey = JSON.stringify([scope, input.warehouseId, input.documentId]);
        // A delayed receipt can never downgrade a completed import.
        if (bindings.has(receiptKey)) return structuredClone(bindings.get(receiptKey));
        if (JSON.stringify(pendingImports.get(receiptKey)) === JSON.stringify(receipt)) return structuredClone(receipt);
        const nextPending = new Map(pendingImports); nextPending.set(receiptKey, receipt);
        await commit(records, bindings, nextPending);
        return structuredClone(receipt);
      });
    },
    async pending(scope, warehouseId) {
      if (!store) return [];
      await queue.catch(() => {}); available();
      if (!scopeValid(scope) || !warehouseValid(warehouseId)) throw fail("SPACE_ANNOTATION_INVALID");
      return structuredClone([...pendingImports.values()].filter(receipt => receipt.scope === scope && receipt.warehouseId === warehouseId));
    },
    async imports(scope, warehouseId, query) {
      if (!store) return [];
      await queue.catch(() => {}); available();
      if (!scopeValid(scope) || !warehouseValid(warehouseId)) throw fail("SPACE_ANNOTATION_INVALID");
      const selected = [...bindings.values()].filter(binding => binding.scope === scope && binding.warehouseId === warehouseId);
      const needle = typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
      if (!needle) return structuredClone(selected);
      // Use current local labels to prioritize what to verify on the box. Older
      // imports and files whose local metadata has changed remain candidates.
      const matching = [], remaining = [];
      for (const binding of selected) {
        const annotation = effective(scope, binding.id);
        const matches = annotation && !annotation.needsReview &&
          [...annotation.tags, annotation.description].some(value => value.toLocaleLowerCase().includes(needle));
        (matches ? matching : remaining).push(binding);
      }
      return structuredClone([...matching, ...remaining]);
    },
    async close() { await queue.catch(() => {}); },
  };
}

function bindingValid(value, pending = false) {
  const fields = ["scope", "id", "warehouseId", "documentId", "digest", "annotationRevision", "snapshot", ...(pending ? [] : ["versionId"])];
  if (!value || Array.isArray(value) || Object.keys(value).some(field => !fields.includes(field)) ||
    !resource(value.id) || !warehouseValid(value.warehouseId) || !documentValid(value.documentId) || !pending && !documentValid(value.versionId) ||
    typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.annotationRevision) ||
    value.annotationRevision < (pending && value.snapshot === undefined ? 0 : 1)) return false;
  const snapshot = value.snapshot;
  return snapshot === undefined || snapshot && !Array.isArray(snapshot) && tagsValid(snapshot.tags, 2048) &&
    typeof snapshot.description === "string" && snapshot.description.length <= 2000 &&
    (!own(snapshot, "revision") || Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 1) &&
    (!own(snapshot, "needsReview") || typeof snapshot.needsReview === "boolean") &&
    (!own(snapshot, "provenance") || Array.isArray(snapshot.provenance) && snapshot.provenance.length <= 2048 && snapshot.provenance.every(item =>
      item && typeof item.tag === "string" && item.tag.length <= 80 && ["manual", "automatic", "inherited"].includes(item.source) && resource(item.itemId)));
}

function normalizedReceipt(scope, input) {
  const receipt = structuredClone({ ...input, scope });
  if (input.snapshot) receipt.snapshot = {
    tags: [...input.snapshot.tags], description: input.snapshot.description,
    ...(input.snapshot.revision !== undefined ? { revision: input.snapshot.revision } : {}),
    ...(input.snapshot.needsReview !== undefined ? { needsReview: input.snapshot.needsReview } : {}),
    ...(input.snapshot.provenance ? { provenance: input.snapshot.provenance.map(({ tag, source, itemId, origin }) => ({ tag, source, itemId,
      ...(["manual", "automatic"].includes(origin) ? { origin } : {}) })) } : {}),
  };
  return receipt;
}

function manualState(record) {
  return structuredClone({ manual: record.manual, inherit: record.inherit, needsReview: record.needsReview });
}

function batchRequestHash(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.keys(input).sort().map(field => [field, canonical(input[field])])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function publicBatchReceipt(receipt) {
  return structuredClone({ operationId: receipt.operationId,
    ...(receipt.sourceOperationId ? { sourceOperationId: receipt.sourceOperationId } : {}),
    items: receipt.items.map(({ id, status, annotation, code }) => ({ id, status,
      ...(annotation ? { annotation } : {}), ...(code ? { code } : {}) })) });
}

function batchReceiptValid(receipt) {
  if (!receipt || Array.isArray(receipt) || !scopeValid(receipt.scope) || !operationValid(receipt.operationId) ||
    !["apply", "undo"].includes(receipt.kind) || typeof receipt.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.requestHash) ||
    Object.keys(receipt).some(field => !["scope", "kind", "operationId", "requestHash", "sourceOperationId", "items"].includes(field)) ||
    (receipt.kind === "undo" ? !operationValid(receipt.sourceOperationId) : own(receipt, "sourceOperationId")) ||
    !Array.isArray(receipt.items) || receipt.items.length > 50 || new Set(receipt.items.map(item => item?.id)).size !== receipt.items.length) return false;
  return receipt.items.every(item => {
    if (!item || Array.isArray(item) || !resource(item.id) || !["applied", "conflict", "failed"].includes(item.status) ||
      Object.keys(item).some(field => !["id", "status", "annotation", "code", "before", "postRevision", "fingerprint"].includes(field))) return false;
    if (item.status !== "applied") return typeof item.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(item.code) &&
      !["before", "postRevision", "fingerprint", "annotation"].some(field => own(item, field));
    const annotation = item.annotation, before = item.before;
    return !own(item, "code") && before && !Array.isArray(before) && Object.keys(before).length === 3 &&
      manualValid(before.manual) && typeof before.inherit === "boolean" && typeof before.needsReview === "boolean" &&
      Number.isSafeInteger(item.postRevision) && item.postRevision >= 2 && typeof item.fingerprint === "string" && item.fingerprint.length <= 4096 &&
      annotation && tagsValid(annotation.tags, 2048) && typeof annotation.description === "string" && annotation.description.length <= 2000 &&
      annotation.revision === item.postRevision && annotation.fingerprint === item.fingerprint && manualValid(annotation.manual) &&
      typeof annotation.inherit === "boolean" && typeof annotation.needsReview === "boolean" &&
      tagsValid(annotation.automatic?.tags) && typeof annotation.automatic.description === "string" && annotation.automatic.source === "rules-v1" &&
      Array.isArray(annotation.provenance) && annotation.provenance.length <= 2048 && annotation.provenance.every(row => row &&
        typeof row.tag === "string" && row.tag.length <= 80 && ["manual", "automatic", "inherited"].includes(row.source) && resource(row.itemId));
  });
}
