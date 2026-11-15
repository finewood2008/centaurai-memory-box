import test from "node:test";
import assert from "node:assert/strict";
import { createSpaceAnnotations } from "../shell/space-annotations.mjs";

const fileId = "a".repeat(32), parentId = "b".repeat(32), nestedId = "c".repeat(32);
const digest = "d".repeat(64), changedDigest = "e".repeat(64);
const scope = JSON.stringify(["account-a", "box-a", "personal"]);
const file = (patch = {}) => ({ id: fileId, parent: "", kind: "file", name: "项目合同.md", size: 100, digest, ...patch });
function memoryStore(value = null) {
  let saved = structuredClone(value), count = 0, broken = false;
  return {
    async load() { return structuredClone(saved); },
    async save(value) { count++; if (broken) throw new Error("disk full"); saved = structuredClone(value); },
    value: () => saved, writes: () => count, fail: value => { broken = value; },
  };
}
test("automatic rules persist without confirmation and survive restart; unchanged listings do not write", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const result = await index.observe(scope, file());
  assert.deepEqual(result.tags, ["合同", "项目", "文档"]);
  assert.equal(result.automatic.source, "rules-v1");
  assert.equal(result.manual, null);
  assert.equal(result.needsReview, false);
  await index.observe(scope, file());
  assert.equal(store.writes(), 1);
  const restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.get(scope, fileId), result);
});
test("manual fields override automatic data, including deliberate empty values", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  let result = await index.observe(scope, file({ contentText: "项目合同正文。" }));
  result = await index.set(scope, fileId, { expectedRevision: result.revision, tags: ["  客户资料  ", "客户资料"], description: "手工说明" });
  assert.deepEqual(result.tags, ["客户资料"]);
  assert.equal(result.description, "手工说明");
  assert.equal(result.provenance[0].source, "manual");
  result = await index.set(scope, fileId, { expectedRevision: result.revision, tags: [], description: "" });
  assert.deepEqual(result.tags, []); assert.equal(result.description, "");
  result = await index.set(scope, fileId, { expectedRevision: result.revision, reset: true });
  assert.ok(result.tags.includes("合同")); assert.equal(result.manual, null);
});
test("folder inheritance retains origin and nearest description; explicit opt out blocks it", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  let parent = await index.observe(scope, file({ id: parentId, kind: "folder", name: "研发项目", size: undefined, digest: undefined }));
  await index.set(scope, parentId, { expectedRevision: parent.revision, tags: ["重要客户"], description: "用于续约" });
  await index.observe(scope, file({ id: nestedId, parent: parentId, kind: "folder", name: "二级", size: undefined, digest: undefined }));
  let child = await index.observe(scope, file({ parent: nestedId, name: "report.txt" }));
  assert.ok(child.tags.includes("重要客户")); assert.equal(child.description, "用于续约");
  assert.deepEqual(child.provenance.find(p => p.tag === "重要客户"), { tag: "重要客户", source: "inherited", itemId: parentId, origin: "manual" });
  child = await index.set(scope, fileId, { expectedRevision: child.revision, tags: [], inherit: false });
  assert.deepEqual(child.tags, []); assert.equal(child.description, "");
});
test("content changes quarantine manual labels until reviewed; observations retain content extraction", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  let entry = file({ name: "notes.txt", contentText: "会议记录及预算审核" });
  let result = await index.observe(scope, entry);
  assert.ok(result.tags.includes("会议")); assert.ok(result.tags.includes("财务"));
  result = await index.observe(scope, file({ name: "renamed.txt" }));
  assert.ok(result.tags.includes("会议")); assert.equal(result.description, "会议记录及预算审核");
  result = await index.set(scope, fileId, { expectedRevision: result.revision, tags: ["已确认客户"], description: "人工说明" });
  result = await index.observe(scope, file({ name: "new.txt", digest: changedDigest, size: 200 }));
  assert.equal(result.needsReview, true);
  assert.ok(!result.tags.includes("已确认客户")); assert.equal(result.description, "");
  assert.deepEqual(result.manual.tags, ["已确认客户"]);
  result = await index.set(scope, fileId, { expectedRevision: result.revision, reviewed: true });
  assert.equal(result.needsReview, false); assert.deepEqual(result.tags, ["已确认客户"]);
});
test("folder timestamps changing as children are added do not invalidate folder labels", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  const folder = file({ kind: "folder", name: "客户", digest: undefined, size: undefined, modified: 1 });
  const initial = await index.observe(scope, folder);
  await index.set(scope, fileId, { expectedRevision: initial.revision, tags: ["客户项目"] });
  const result = await index.observe(scope, { ...folder, modified: 2 });
  assert.equal(result.needsReview, false); assert.deepEqual(result.tags, ["客户项目"]);
});
test("same-revision concurrent edits accept one writer; stale edits cannot overwrite it", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  const current = await index.observe(scope, file());
  const attempts = await Promise.allSettled([
    index.set(scope, fileId, { expectedRevision: current.revision, tags: ["甲"] }),
    index.set(scope, fileId, { expectedRevision: current.revision, tags: ["乙"] }),
  ]);
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(attempts.find(item => item.status === "rejected").reason.code, "SPACE_ANNOTATION_CONFLICT");
  assert.deepEqual((await index.get(scope, fileId)).tags, ["甲"]);
});
test("failed writes never publish unpersisted labels and can be retried", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const current = await index.observe(scope, file());
  store.fail(true);
  await assert.rejects(index.set(scope, fileId, { expectedRevision: current.revision, tags: ["未保存"] }), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
  assert.deepEqual(await index.get(scope, fileId), current);
  store.fail(false);
  const result = await index.set(scope, fileId, { expectedRevision: current.revision, tags: ["已保存"] });
  assert.deepEqual(result.tags, ["已保存"]);
});
test("accounts and boxes isolate labels and ancestor lookup", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  const owner = await index.observe(scope, file());
  await index.set(scope, fileId, { expectedRevision: owner.revision, tags: ["私密"] });
  for (const other of ["account-b/box-a/personal", "account-a/box-b/personal", "account-a/box-a/team"]) {
    assert.equal(await index.get(other, fileId), null);
    const independent = await index.observe(other, file());
    assert.ok(!independent.tags.includes("私密"));
  }
});
test("unreadable or malformed storage fails closed without replacing records", async () => {
  for (const saved of [{ version: 2, records: [] }, { version: 1, records: [{}] }]) {
    const store = memoryStore(saved), index = await createSpaceAnnotations({ store });
    await assert.rejects(index.observe(scope, file()), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
    await assert.rejects(index.get(scope, fileId), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
    assert.equal(store.writes(), 0);
  }
});
test("missing encrypted store never presents volatile annotations as persisted", async () => {
  const index = await createSpaceAnnotations();
  assert.equal(await index.observe(scope, file()), null);
  assert.equal(await index.get(scope, fileId), null);
  await assert.rejects(index.set(scope, fileId, { expectedRevision: 1, tags: ["x"] }), { code: "SPACE_ANNOTATION_UNAVAILABLE" });
});
test("cycles stop; returned snapshots cannot mutate stored tags", async () => {
  const index = await createSpaceAnnotations({ store: memoryStore() });
  await index.observe(scope, file({ id: parentId, parent: fileId, name: "财务", kind: "folder" }));
  const result = await index.observe(scope, file({ parent: parentId }));
  assert.ok(result.tags.includes("财务"));
  result.tags.push("tampered"); result.automatic.tags.push("tampered");
  assert.ok(!(await index.get(scope, fileId)).tags.includes("tampered"));
});
test("Starlink bindings are durable, idempotent, validated and scoped to warehouse/account", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const warehouseId = "11111111-1111-1111-1111-111111111111";
  const binding = { id: fileId, warehouseId, documentId: "doc_1", versionId: "v1", digest, annotationRevision: 1,
    snapshot: { tags: ["合同"], description: "导入快照", revision: 1 } };
  await index.bind(scope, binding); const count = store.writes(); await index.bind(scope, binding);
  assert.equal(store.writes(), count);
  const restarted = await createSpaceAnnotations({ store });
  assert.equal((await restarted.imports(scope, warehouseId))[0].snapshot.description, "导入快照");
  assert.deepEqual(await restarted.imports("another-owner", warehouseId), []);
  assert.deepEqual(await restarted.imports(scope, "22222222-2222-2222-2222-222222222222"), []);
  await assert.rejects(index.bind(scope, { ...binding, versionId: "../bad" }), { code: "SPACE_ANNOTATION_INVALID" });
});
test("async import receipts survive restart separately from bindings and promote atomically", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const warehouseId = "11111111-1111-1111-1111-111111111111";
  const receipt = { id: fileId, warehouseId, documentId: "doc_async", digest, annotationRevision: 1,
    snapshot: { tags: ["合同"], description: "等待解析" } };
  await index.stage(scope, receipt); const writes = store.writes(); await index.stage(scope, receipt);
  assert.equal(store.writes(), writes);
  let restarted = await createSpaceAnnotations({ store });
  assert.equal((await restarted.pending(scope, warehouseId))[0].documentId, "doc_async");
  assert.deepEqual(await restarted.imports(scope, warehouseId), []);
  assert.equal(await restarted.get(scope, fileId), null);
  assert.deepEqual(await restarted.pending("another-account", warehouseId), []);
  assert.deepEqual(await restarted.pending(scope, "22222222-2222-2222-2222-222222222222"), []);
  store.fail(true);
  await assert.rejects(restarted.bind(scope, { ...receipt, versionId: "parsed_v1" }), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
  assert.equal((await restarted.pending(scope, warehouseId)).length, 1);
  assert.deepEqual(await restarted.imports(scope, warehouseId), []);
  store.fail(false);
  await restarted.bind(scope, { ...receipt, versionId: "parsed_v1" });
  restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.pending(scope, warehouseId), []);
  assert.equal((await restarted.imports(scope, warehouseId))[0].versionId, "parsed_v1");
  await restarted.stage(scope, { ...receipt, snapshot: { tags: ["过期"], description: "晚到回执" } });
  assert.deepEqual(await restarted.pending(scope, warehouseId), []);
  assert.deepEqual((await restarted.imports(scope, warehouseId))[0].snapshot.tags, ["合同"]);
});
test("malformed pending receipts fail closed and cannot overwrite existing storage", async () => {
  const warehouseId = "11111111-1111-1111-1111-111111111111";
  for (const pendingImports of [{}, [{}], [{ scope, id: fileId, warehouseId, documentId: "doc1", digest, annotationRevision: 1, versionId: "not-pending" }]]) {
    const store = memoryStore({ version: 1, records: [], imports: [], pendingImports });
    const index = await createSpaceAnnotations({ store });
    await assert.rejects(index.pending(scope, warehouseId), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
    await assert.rejects(index.stage(scope, { id: fileId, warehouseId, documentId: "doc1", digest, annotationRevision: 1 }), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
    assert.equal(store.writes(), 0);
  }
});
test("inherited snapshots larger than the manual tag limit survive staging, binding and restart", async () => {
  const store = memoryStore(), index = await createSpaceAnnotations({ store });
  const parent = await index.observe(scope, file({ id: parentId, kind: "folder", name: "资料" }));
  await index.set(scope, parentId, { expectedRevision: parent.revision, tags: Array.from({ length: 20 }, (_, i) => `父标签${i}`) });
  const child = await index.observe(scope, file({ parent: parentId }));
  const snapshot = await index.set(scope, fileId, { expectedRevision: child.revision, tags: Array.from({ length: 20 }, (_, i) => `子标签${i}`) });
  assert.equal(snapshot.tags.length, 40); assert.equal(snapshot.provenance.length, 40);
  const warehouseId = "11111111-1111-1111-1111-111111111111";
  const receipt = { id: fileId, warehouseId, documentId: "doc_inherited", digest, annotationRevision: snapshot.revision, snapshot };
  await index.stage(scope, receipt);
  let restarted = await createSpaceAnnotations({ store });
  assert.deepEqual((await restarted.pending(scope, warehouseId))[0].snapshot.tags, snapshot.tags);
  await restarted.bind(scope, { ...receipt, versionId: "v1" });
  restarted = await createSpaceAnnotations({ store });
  assert.deepEqual(await restarted.pending(scope, warehouseId), []);
  assert.deepEqual((await restarted.imports(scope, warehouseId))[0].snapshot.provenance, snapshot.provenance);
  await assert.rejects(restarted.set(scope, fileId, { expectedRevision: snapshot.revision, tags: snapshot.tags }), { code: "SPACE_ANNOTATION_INVALID" });
});
