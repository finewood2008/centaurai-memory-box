import assert from "node:assert/strict";
import { test } from "node:test";
import { requestJson } from "../src/request.ts";
import { detectionNotice } from "../src/graph.ts";

test("request timeout remains distinguishable from empty graph and supports retry", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    await assert.rejects(requestJson("/graph", undefined, 5), /加载超时/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    assert.deepEqual(await requestJson("/graph", undefined, 100), { nodes: [], edges: [] });
  } finally { globalThis.fetch = original; }
});

test("failed, cancelled and pending detection are not presented as an empty graph", () => {
  for (const status of ["failed", "cancelled", "pending", "running", "queued", "changed"]) {
    assert.ok(detectionNotice({ status, pending_texts: 1 }));
  }
  assert.equal(detectionNotice({ status: "completed", pending_texts: 0 }), null);
  assert.equal(detectionNotice({ status: "not_required", pending_texts: 0 }), null);
});
