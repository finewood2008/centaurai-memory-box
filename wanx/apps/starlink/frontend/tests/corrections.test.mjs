import assert from "node:assert/strict";
import { test } from "node:test";
import { correctionRequest, correctionUrl, editable, changedFields, operationEnvelope, swapDirection, cachedCorrectionEditor, rememberCorrectionLease } from "../src/corrections.ts";

const relation = { id: "relation", kind: "relation", payload: { type: "HAS_FEATURE", source_candidate_key: "product", target_candidate_key: "feature" },
  evidence: [{ segment_id: "source", excerpt: "原文" }], review_note: "旧说明", issues: [{ code: "old" }], endpoints: {} };
test("direction edit preserves stable endpoints, clears prior review, and does not mutate the loaded item", () => {
  const swapped = swapDirection(relation);
  assert.equal(swapped.payload.source_candidate_key, "feature");
  assert.equal(swapped.payload.target_candidate_key, "product");
  assert.equal(swapped.review_note, "");
  assert.equal(relation.payload.source_candidate_key, "product");
  assert.deepEqual(changedFields({ before: relation, after: swapped }), ["起点", "终点", "复核说明"]);
});
test("saving freezes a retry envelope without presentation fields or reference sharing", () => {
  const envelope = operationEnvelope(4, [relation], [], "说明", "same-operation");
  assert.equal(envelope.expected_revision, 4);
  assert.equal(envelope.operation_id, "same-operation");
  assert.equal("issues" in envelope.upserts[0], false);
  assert.equal("endpoints" in envelope.upserts[0], false);
  envelope.upserts[0].evidence[0].excerpt = "edited";
  assert.equal(relation.evidence[0].excerpt, "原文");
  assert.equal(editable(relation).review_note, "旧说明");
});
test("requests are confined to correction endpoints, disable caches/redirects, and retain conflict codes", async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "error");
      if (url.includes('/sessions?')) return new Response(JSON.stringify({editor_session:'synthetic-session'}));
      return new Response(JSON.stringify({ detail: "草稿已变化", code: "CORRECTION_REVISION_CONFLICT" }), { status: 409 });
    };
    await assert.rejects(correctionRequest(correctionUrl("仓库", "document", "/draft/save"), new AbortController().signal, {}),
      error => error.code === "CORRECTION_REVISION_CONFLICT" && error.status === 409);
    for (const url of ["https://external/api/documents/d/corrections?", "/api/settings?", "/api/documents/d/corrections/../settings?", "/api/documents/d/corrections/%2e%2e?"])
      await assert.rejects(correctionRequest(url, new AbortController().signal), /地址无效/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
test('sessions stay in headers and lease generations survive late responses without crossing documents', async () => {
  const original = globalThis.fetch, calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({url, init});
      if (url.includes('/sessions?')) return new Response(JSON.stringify({editor_session:'lease-test-secret'}));
      if (!url.includes('/draft/')) return new Response(JSON.stringify({draft_id:'draft',revision:1,status:'editing',lease_generation:2}));
      assert.equal(init.headers['X-Correction-Session'], 'lease-test-secret');
      assert.equal(init.headers['X-Correction-Generation'], '2');
      assert.ok(!url.includes('lease-test-secret'));
      return new Response(JSON.stringify({draft_id:'draft',revision:2,status:'editing',lease_generation:1}));
    };
    const signal = new AbortController().signal;
    await correctionRequest(correctionUrl('lease-workspace','lease-doc'), signal, {operation_id:'open'});
    await correctionRequest(correctionUrl('lease-workspace','lease-doc','/draft/save'), signal, {operation_id:'save',expected_revision:1});
    assert.equal(calls.filter(c=>c.url.includes('/sessions?')).length, 1);
    assert.equal(cachedCorrectionEditor('lease-workspace','lease-doc').lease_generation, 2);
    assert.equal(cachedCorrectionEditor('other-workspace','lease-doc'), null);
    assert.equal(cachedCorrectionEditor('lease-workspace','another-doc'), null);
    rememberCorrectionLease('lease-workspace','lease-doc',{draft_id:'draft',status:'editing',lease_generation:3});
    assert.equal(cachedCorrectionEditor('lease-workspace','lease-doc').lease_generation, 3);
  } finally { globalThis.fetch = original; }
});
test("late responses after switching documents are discarded", async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  try {
    globalThis.fetch = async () => { controller.abort(); return new Response('{}'); };
    await assert.rejects(correctionRequest(correctionUrl("default", "old-document"), controller.signal), { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("cancellation during a conflict response body never becomes a definite stale-document refusal", async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  try {
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => {
      controller.abort(); return { code: 'CORRECTION_REVISION_CONFLICT', detail: '草稿已变化' };
    } });
    await assert.rejects(correctionRequest(correctionUrl('default', 'old-document'), controller.signal, {}), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
