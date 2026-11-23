import assert from "node:assert/strict";
import { test } from "node:test";
import { initialIndexNotice, readIndexNotice, knowledgeStage, isMergedScan, jobExecutionLabel } from "../src/processing.ts";

const status = { fresh: false, publishable_segments: 2, items: [] };
function mockRead(job, indexStatus = status) {
  const urls = [];
  return { urls, read: async (url) => {
    urls.push(url);
    if (url === "/api/jobs/old") return job;
    assert.equal(url, "/api/search/indexes?workspace_id=default");
    return indexStatus;
  } };
}

test("deletion follows its job independently of visible task pages", async () => {
  const initial = initialIndexNotice({ index_status: "queued", index_job: { id: "old", status: "queued" } });
  const mock = mockRead({ id: "old", status: "running" });
  assert.equal(initial.jobId, "old");
  const next = await readIndexNotice(initial.jobId, "default", mock.read);
  assert.equal(next.jobId, "old");
  assert.deepEqual(mock.urls, ["/api/jobs/old"]); // no full-corpus check during execution
});

test("completed and fresh build stops polling and says synchronized", async () => {
  const mock = mockRead({ id: "old", status: "succeeded" }, { ...status, fresh: true });
  assert.deepEqual(await readIndexNotice("old", "default", mock.read), { text: "检索索引已同步。" });
});

test("cancelled superseded build follows current task; completed stale build does too", async () => {
  for (const state of ["cancelled", "succeeded", "failed"]) {
    const mock = mockRead({ id: "old", status: state }, { ...status,
      items: [{ build_job_id: "latest", status: "building", job_status: "queued" }] });
    assert.equal((await readIndexNotice("old", "default", mock.read)).jobId, "latest");
  }
});

test("failure and user cancellation stop showing an in-progress message", async () => {
  for (const state of ["failed", "cancelled"]) {
    const mock = mockRead({ id: "old", status: state, error_message: "索引测试原因" });
    assert.deepEqual(await readIndexNotice("old", "default", mock.read), { text: "索引测试原因", failed: true });
  }
});

test("last deletion resolves to empty corpus and never claims to still be building", async () => {
  const expected = { text: "当前已无可索引正文，旧索引已停用。" };
  assert.deepEqual(initialIndexNotice({ index_status: "empty" }), expected);
  const mock = mockRead({ id: "old", status: "cancelled" }, { ...status, publishable_segments: 0 });
  assert.deepEqual(await readIndexNotice("old", "default", mock.read), expected);
});

test("completed stale task is not incorrectly reported as a fresh index", async () => {
  const mock = mockRead({ id: "old", status: "succeeded" });
  const result = await readIndexNotice("old", "default", mock.read);
  assert.equal(result.failed, true);
  assert.equal(result.jobId, undefined);
  assert.match(result.text, /尚未同步/);
});

test("transient errors are propagated for the component to retry", async () => {
  await assert.rejects(readIndexNotice("old", "default", async () => { throw new Error("network"); }), /network/);
});

test("successful empty graph is described differently from valid publication and failure", () => {
  const empty = { accepted_relations: 0, published_relations: 0 };
  assert.equal(knowledgeStage("knowledge_publish", "succeeded", empty), "处理完成，未形成有效关系");
  assert.equal(knowledgeStage("knowledge_extract", "succeeded", empty), "抽取完成，无有效关系");
  assert.equal(knowledgeStage("knowledge_publish", "succeeded", { ...empty, published_relations: 1 }), "已入图");
  assert.equal(knowledgeStage("knowledge_publish", "failed", empty), null);
  assert.equal(knowledgeStage("knowledge_extract", "running", empty), null);
});

test("only superseded scans with a real successor are shown as merged", () => {
  const merged = { kind: "sensitive_scan", status: "cancelled", error_code: "SCAN_SCOPE_CHANGED",
    metrics: { replacement_job_id: "next-scan" } };
  assert.equal(isMergedScan(merged), true);
  for (const error_code of ["INDEX_CHANGED", "DETECTOR_CHANGED", "SCAN_SUPERSEDED"]) {
    assert.equal(isMergedScan({ ...merged, error_code }), true);
  }
  assert.equal(isMergedScan({ ...merged, error_code: "JOB_CANCELLED" }), false);
  assert.equal(isMergedScan({ ...merged, error_code: "SCAN_SCOPE_CHANGED", metrics: {} }), false);
  assert.equal(isMergedScan({ ...merged, status: "failed" }), false);
  assert.equal(isMergedScan({ ...merged, kind: "search_index" }), false);
});

test("not started and intentionally unnecessary scans have distinct labels", () => {
  assert.equal(jobExecutionLabel({ attempt: 0, status: "queued" }), "尚未执行");
  assert.equal(jobExecutionLabel({ attempt: 0, status: "cancelled" }), "未执行");
  assert.equal(jobExecutionLabel({ attempt: 0, status: "cancelled" }, true), "无需执行");
  assert.equal(jobExecutionLabel({ attempt: 1, status: "cancelled" }, true), "第 1 次执行");
});
