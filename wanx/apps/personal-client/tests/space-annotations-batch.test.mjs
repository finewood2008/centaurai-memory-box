import test from "node:test";
import assert from "node:assert/strict";
import { createSpaceAnnotations } from "../shell/space-annotations.mjs";

const id = number => number.toString(16).padStart(32, "0");
const scope = JSON.stringify(["synthetic-account", "synthetic-box", "personal"]);
const otherScope = JSON.stringify(["synthetic-account-b", "synthetic-box", "personal"]);
const digest = "a".repeat(64), changedDigest = "b".repeat(64);
const entry = (number, patch = {}) => ({ id: id(number), parent: "", name: `项目资料 ${number}.txt`, kind: "file", size: 30, digest, ...patch });
function memoryStore(initial = null) {
  let saved = structuredClone(initial), writes = 0, broken = false;
  return { load: async () => structuredClone(saved), async save(value) {
    writes++;
    if (broken) throw Error("synthetic write failure");
    saved = structuredClone(value);
  }, value: () => structuredClone(saved), writes: () => writes, fail(value) { broken = value; } };
}
const selected = (number, annotation, changes) => ({ id: id(number), expectedRevision: annotation.revision,
  fingerprint: annotation.fingerprint, changes });
const readSelection = (number, annotation) => ({ id: id(number), expectedRevision: annotation.revision, fingerprint: annotation.fingerprint });

test("1000 mixed entries are observed in one durable write and applied in 50-item transactions", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const extensions = ["txt", "md", "pdf", "xlsx", "png", "zip"];
  const entries = Array.from({ length: 1000 }, (_, number) => entry(number + 1, {
    name: `合成资料 ${number}.${extensions[number % extensions.length]}`,
    kind: number % 19 === 0 ? "folder" : "file",
  }));
  const annotations = await index.observeMany(scope, entries);
  assert.equal(annotations.length, 1000);
  assert.equal(store.writes(), 1);
  await index.observeMany(scope, entries);
  assert.equal(store.writes(), 1, "an unchanged directory scan must not rewrite the index");
  for (let offset = 0; offset < entries.length; offset += 50) {
    const result = await index.applyBatch(scope, { operationId: `synthetic-batch:${offset / 50}`,
      items: entries.slice(offset, offset + 50).map((file, position) => selected(offset + position + 1, annotations[offset + position], { tags: ["合成验收"], reviewed: true })) });
    assert.ok(result.items.every(item => item.status === "applied"));
  }
  assert.equal(store.writes(), 21);
  const restarted = await createSpaceAnnotations({ store });
  assert.deepEqual((await restarted.get(scope, id(1000))).manual.tags, ["合成验收"]);
  assert.equal((await restarted.batchReceipt(scope, "synthetic-batch:19")).items.length, 50);
});

test("observeMany has the same record and inheritance behavior and rejects an invalid batch atomically", async () => {
  const manyStore = memoryStore(), sequentialStore = memoryStore();
  const many = await createSpaceAnnotations({ store: manyStore }), sequential = await createSpaceAnnotations({ store: sequentialStore });
  const entries = [entry(1, { name: "预算", kind: "folder" }), entry(2, { parent: id(1), contentText: "会议纪要" })];
  await many.observeMany(scope, entries);
  for (const file of entries) await sequential.observe(scope, file);
  assert.deepEqual(await many.get(scope, id(2)), await sequential.get(scope, id(2)));
  const writes = manyStore.writes();
  await assert.rejects(many.observeMany(scope, [entry(3), entry(4, { parent: "../bad" })]), { code: "SPACE_ANNOTATION_INVALID" });
  assert.equal(manyStore.writes(), writes);
  assert.equal(await many.get(scope, id(3)), null);
});

test("a block commits successful items with revision, content, and missing-item failures in one receipt", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotations = await index.observeMany(scope, [entry(1), entry(2), entry(3)]);
  await index.set(scope, id(1), { expectedRevision: annotations[0].revision, tags: ["later manual edit"] });
  await index.observe(scope, entry(2, { digest: changedDigest }));
  const before = store.writes();
  const receipt = await index.applyBatch(scope, { operationId: "partial", items: [
    selected(1, annotations[0], { tags: ["forbidden overwrite"] }),
    selected(2, annotations[1], { tags: ["stale bytes"] }),
    selected(4, annotations[2], { tags: ["missing"] }),
    selected(3, annotations[2], { tags: ["applied"] }),
  ] });
  assert.equal(store.writes(), before + 1);
  assert.deepEqual(receipt.items.map(item => [item.status, item.code]), [
    ["conflict", "SPACE_ANNOTATION_CONFLICT"], ["conflict", "SPACE_REMOTE_FILE_CHANGED"],
    ["failed", "SPACE_NOT_FOUND"], ["applied", undefined],
  ]);
  assert.deepEqual((await index.get(scope, id(1))).manual.tags, ["later manual edit"]);
  assert.equal((await index.get(scope, id(2))).manual, null);
  assert.deepEqual((await index.get(scope, id(3))).manual.tags, ["applied"]);
  assert.equal(Object.hasOwn(receipt.items[3], "before"), false);
});

test("lost acknowledgements recover from the same durable receipt after restart without a second modification", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotation = await index.observe(scope, entry(1));
  const request = { operationId: "lost-ack", items: [selected(1, annotation, { tags: ["value"], description: "confirmed", reviewed: true })] };
  const first = await index.applyBatch(scope, request), writes = store.writes();
  const restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.batchReceipt(scope, request.operationId), first);
  // Canonical hashes ignore property ordering while retaining payload identity.
  assert.deepEqual(await restarted.applyBatch(scope, { items: [{ changes: { reviewed: true, description: "confirmed", tags: ["value"] },
    fingerprint: annotation.fingerprint, expectedRevision: annotation.revision, id: id(1) }], operationId: "lost-ack" }), first);
  assert.equal(store.writes(), writes);
  assert.equal((await restarted.get(scope, id(1))).revision, annotation.revision + 1);
  await assert.rejects(restarted.applyBatch(scope, { ...request, items: [selected(1, annotation, { tags: ["different request"] })] }), { code: "SPACE_ANNOTATION_OPERATION_CONFLICT" });
  first.items[0].annotation.manual.tags.push("tampered");
  assert.deepEqual((await restarted.batchReceipt(scope, request.operationId)).items[0].annotation.manual.tags, ["value"]);
});

test("write failure publishes neither batch changes nor receipts; the original operation can be retried", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotation = await index.observe(scope, entry(1));
  const request = { operationId: "retry-save", items: [selected(1, annotation, { tags: ["saved"] })] };
  store.fail(true);
  await assert.rejects(index.applyBatch(scope, request), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
  assert.deepEqual(await index.get(scope, id(1)), annotation);
  assert.equal(await index.batchReceipt(scope, "retry-save"), null);
  store.fail(false);
  assert.equal((await index.applyBatch(scope, request)).items[0].status, "applied");
});

test("preflight permission failures persist beside successful changes and cannot turn into writes on retry", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotations = await index.observeMany(scope, [entry(1), entry(2)]);
  const request = { operationId: "preflight-apply", items: [
    { ...selected(1, annotations[0], { tags: ["forbidden"] }), preflightError: "MCP_DRIVE_READ_ONLY" },
    selected(2, annotations[1], { tags: ["applied"] }),
  ] };
  const receipt = await index.applyBatch(scope, request);
  assert.deepEqual(receipt.items.map(item => [item.status, item.code]), [["failed", "MCP_DRIVE_READ_ONLY"], ["applied", undefined]]);
  assert.equal((await index.get(scope, id(1))).manual, null);
  const writes = store.writes(), restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.applyBatch(scope, request), receipt);
  assert.equal(store.writes(), writes);
  await assert.rejects(restarted.applyBatch(scope, { ...request, items: [selected(1, annotations[0], { tags: ["forbidden"] }), request.items[1]] }), { code: "SPACE_ANNOTATION_OPERATION_CONFLICT" });
  assert.equal((await restarted.get(scope, id(1))).manual, null);
});

test("concurrent duplicate operations use one transaction while competing revisions cannot overwrite each other", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotation = await index.observe(scope, entry(1));
  const request = { operationId: "same", items: [selected(1, annotation, { tags: ["first"] })] };
  const before = store.writes(), [first, duplicate] = await Promise.all([index.applyBatch(scope, request), index.applyBatch(scope, request)]);
  assert.deepEqual(duplicate, first); assert.equal(store.writes(), before + 1);
  const competitor = await index.applyBatch(scope, { ...request, operationId: "different" });
  assert.equal(competitor.items[0].status, "conflict");
  assert.deepEqual((await index.get(scope, id(1))).manual.tags, ["first"]);
});

test("undo restores only the prior human state and keeps the current inherited automatic annotation", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  await index.observeMany(scope, [entry(1, { kind: "folder", name: "合同" }), entry(2, { parent: id(1), name: "notes.txt" })]);
  let before = await index.get(scope, id(2));
  before = await index.set(scope, id(2), { expectedRevision: before.revision, tags: ["before"], description: "original note", inherit: true });
  const result = await index.applyBatch(scope, { operationId: "editable", items: [selected(2, before, { tags: ["after"], description: "new note", inherit: false, reviewed: true })] });
  await index.observe(scope, entry(1, { kind: "folder", name: "预算" }));
  const post = result.items[0].annotation;
  const undone = await index.undoBatch(scope, { operationId: "editable", undoOperationId: "undo-editable", items: [readSelection(2, post)] });
  assert.equal(undone.items[0].status, "applied");
  const current = await index.get(scope, id(2));
  assert.deepEqual(current.manual, before.manual); assert.equal(current.inherit, true);
  assert.ok(current.tags.includes("财务")); assert.ok(!current.tags.includes("合同"));
  assert.equal(current.automatic.source, "rules-v1");
  const writes = store.writes(), restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.undoBatch(scope, { operationId: "editable", undoOperationId: "undo-editable", items: [readSelection(2, post)] }), undone);
  assert.equal(store.writes(), writes);
});

test("undo preserves review-pending prior state and does not reactivate stale labels", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  let annotation = await index.observe(scope, entry(1));
  await index.set(scope, id(1), { expectedRevision: annotation.revision, tags: ["old manual"] });
  annotation = await index.observe(scope, entry(1, { digest: changedDigest }));
  assert.equal(annotation.needsReview, true);
  await index.applyBatch(scope, { operationId: "review", items: [selected(1, annotation, { tags: ["new manual"], reviewed: true })] });
  await index.undoBatch(scope, { operationId: "review", undoOperationId: "undo-review" });
  const result = await index.get(scope, id(1));
  assert.equal(result.needsReview, true); assert.deepEqual(result.manual.tags, ["old manual"]);
  assert.ok(!result.tags.includes("old manual"));
});

test("undo isolates later manual edits and content changes while undoing still-current items", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const initial = await index.observeMany(scope, [entry(1), entry(2), entry(3)]);
  const applied = await index.applyBatch(scope, { operationId: "mixed-undo", items: initial.map((annotation, i) => selected(i + 1, annotation, { tags: ["batch"] })) });
  await index.set(scope, id(1), { expectedRevision: applied.items[0].annotation.revision, tags: ["later edit"] });
  await index.observe(scope, entry(2, { digest: changedDigest }));
  const result = await index.undoBatch(scope, { operationId: "mixed-undo", undoOperationId: "undo-mixed" });
  assert.deepEqual(result.items.map(item => [item.status, item.code]), [
    ["conflict", "SPACE_ANNOTATION_CONFLICT"], ["conflict", "SPACE_REMOTE_FILE_CHANGED"], ["applied", undefined],
  ]);
  assert.deepEqual((await index.get(scope, id(1))).manual.tags, ["later edit"]);
  assert.equal((await index.get(scope, id(3))).manual, null);
});

test("failed undo writes preserve the edited state and can retry the same operation after restart", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotation = await index.observe(scope, entry(1));
  const edited = await index.applyBatch(scope, { operationId: "before-failed-undo", items: [selected(1, annotation, { tags: ["current"] })] });
  const request = { operationId: "before-failed-undo", undoOperationId: "retry-undo", items: [readSelection(1, edited.items[0].annotation)] };
  store.fail(true);
  await assert.rejects(index.undoBatch(scope, request), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
  assert.deepEqual((await index.get(scope, id(1))).manual.tags, ["current"]);
  assert.equal(await index.batchReceipt(scope, "retry-undo"), null);
  store.fail(false);
  const restarted = await createSpaceAnnotations({ store });
  assert.equal((await restarted.undoBatch(scope, request)).items[0].status, "applied");
  assert.equal((await restarted.get(scope, id(1))).manual, null);
});

test("explicit undo selection only touches that subset and checks the outer fresh observation", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  const annotations = await index.observeMany(scope, [entry(1), entry(2), entry(3)]);
  const edited = await index.applyBatch(scope, { operationId: "subset", items: annotations.map((annotation, i) => selected(i + 1, annotation, { tags: ["edited"] })) });
  const result = await index.undoBatch(scope, { operationId: "subset", undoOperationId: "undo-subset", items: [
    readSelection(1, edited.items[0].annotation), { ...readSelection(2, edited.items[1].annotation), fingerprint: "fresh bytes differ" },
  ] });
  assert.deepEqual(result.items.map(item => item.status), ["applied", "conflict"]);
  assert.equal((await index.get(scope, id(1))).manual, null);
  assert.deepEqual((await index.get(scope, id(2))).manual.tags, ["edited"]);
  assert.deepEqual((await index.get(scope, id(3))).manual.tags, ["edited"]);
});

test("undo persists external source-boundary failures without restoring those records on retry", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotations = await index.observeMany(scope, [entry(1), entry(2)]);
  const applied = await index.applyBatch(scope, { operationId: "before-preflight-undo", items: annotations.map((annotation, i) => selected(i + 1, annotation, { tags: ["current"] })) });
  const request = { operationId: "before-preflight-undo", undoOperationId: "preflight-undo", items: [
    { ...readSelection(1, applied.items[0].annotation), preflightError: "SPACE_LINK_SCOPE" }, readSelection(2, applied.items[1].annotation),
  ] };
  const result = await index.undoBatch(scope, request);
  assert.deepEqual(result.items.map(item => [item.status, item.code]), [["failed", "SPACE_LINK_SCOPE"], ["applied", undefined]]);
  assert.deepEqual((await index.get(scope, id(1))).manual.tags, ["current"]);
  assert.equal((await index.get(scope, id(2))).manual, null);
  const writes = store.writes(), restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.undoBatch(scope, request), result);
  assert.equal(store.writes(), writes);
});

test("receipts and undo remain scoped and coexist with legacy Starlink import fields", async () => {
  const store = memoryStore({ version: 1, records: [], imports: [], pendingImports: [] });
  const index = await createSpaceAnnotations({ store });
  const [a] = await index.observeMany(scope, [entry(1)]), [b] = await index.observeMany(otherScope, [entry(1)]);
  await index.applyBatch(scope, { operationId: "reused-id", items: [selected(1, a, { tags: ["owner a"] })] });
  await index.applyBatch(otherScope, { operationId: "reused-id", items: [selected(1, b, { tags: ["owner b"] })] });
  assert.equal(await index.batchReceipt("unseen account", "reused-id"), null);
  await assert.rejects(index.undoBatch("unseen account", { operationId: "reused-id", undoOperationId: "wrong-owner" }), { code: "SPACE_ANNOTATION_OPERATION_NOT_FOUND" });
  const warehouseId = "11111111-1111-1111-1111-111111111111";
  const binding = { id: id(1), warehouseId, documentId: "doc1", digest, annotationRevision: 2 };
  await index.stage(scope, binding);
  await index.bind(scope, { ...binding, versionId: "v1" });
  const restarted = await createSpaceAnnotations({ store });
  assert.equal((await restarted.imports(scope, warehouseId)).length, 1);
  assert.deepEqual((await restarted.get(otherScope, id(1))).manual.tags, ["owner b"]);
  assert.equal((await restarted.batchReceipt(scope, "reused-id")).items[0].status, "applied");
});

test("batch requests validate identifiers, chunk size, changes and undo membership", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const annotation = await index.observe(scope, entry(1)), item = selected(1, annotation, { tags: ["ok"] });
  for (const invalid of [
    { operationId: "../bad", items: [item] }, { operationId: "bad", items: [] },
    { operationId: "bad", items: Array.from({ length: 51 }, (_, i) => ({ ...item, id: id(i + 1) })) },
    { operationId: "bad", items: [item, item] }, { operationId: "bad", items: [{ ...item, id: "../bad" }] },
    { operationId: "bad", items: [{ ...item, changes: { tags: Array(31).fill("tag") } }] },
    { operationId: "bad", items: [{ ...item, changes: { reset: true } }] },
    { operationId: "bad", items: [{ ...item, fingerprint: 1 }] },
    { operationId: "bad", items: [{ ...item, preflightError: "invalid free text" }] },
    { operationId: "bad", items: [{ ...item, preflightError: "ACCOUNT_LOGIN_REQUIRED" }] },
    { operationId: "bad", items: [item], scope: otherScope },
  ]) await assert.rejects(index.applyBatch(scope, invalid), { code: "SPACE_ANNOTATION_INVALID" });
  await index.applyBatch(scope, { operationId: "valid", items: [item] });
  await assert.rejects(index.undoBatch(scope, { operationId: "valid", undoOperationId: "undo", items: [readSelection(2, annotation)] }), { code: "SPACE_ANNOTATION_INVALID" });
  assert.deepEqual((await index.get(scope, id(1))).manual.tags, ["ok"]);
});

test("malformed persisted receipts fail closed without overwriting the source store", async () => {
  const goodStore = memoryStore(), index = await createSpaceAnnotations({ store: goodStore });
  const annotation = await index.observe(scope, entry(1));
  await index.applyBatch(scope, { operationId: "valid", items: [selected(1, annotation, { tags: ["saved"] })] });
  for (const corrupt of [value => { value.batchReceipts = {}; }, value => { value.batchReceipts[0].requestHash = "bad"; },
    value => { value.batchReceipts[0].items[0].before.manual = { unknown: "bad" }; }]) {
    const value = goodStore.value(); corrupt(value);
    const store = memoryStore(value), restarted = await createSpaceAnnotations({ store });
    await assert.rejects(restarted.batchReceipt(scope, "valid"), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
    await assert.rejects(restarted.observeMany(scope, [entry(2)]), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
    assert.equal(store.writes(), 0);
  }
});

test("batch operations never fall back to volatile storage", async () => {
  const index = await createSpaceAnnotations();
  assert.deepEqual(await index.observeMany(scope, [entry(1), entry(2)]), [null, null]);
  assert.equal(await index.batchReceipt(scope, "missing"), null);
  await assert.rejects(index.applyBatch(scope, { operationId: "none", items: [] }), { code: "SPACE_ANNOTATION_UNAVAILABLE" });
  await assert.rejects(index.undoBatch(scope, { operationId: "none", undoOperationId: "undo" }), { code: "SPACE_ANNOTATION_UNAVAILABLE" });
});
