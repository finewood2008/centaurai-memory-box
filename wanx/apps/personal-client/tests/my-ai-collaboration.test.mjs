import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMemoryWorkspace } from "../shell/memory-workspace.mjs";
import { createMyAiCollaboration } from "../shell/my-ai-collaboration.mjs";
import { createCollaborationModels } from "../shell/my-ai-collaboration-models.mjs";
import { createCollaborationSources } from "../shell/my-ai-collaboration-sources.mjs";

const task = "根据发布清单研究首发试点";
const selection = { folderId: "folder" };
const evidence = [
  { id: "E1", kind: "space", title: "发布清单", locator: { label: "资料 / 清单" }, text: "先核对资料授权，再小范围试点。" },
  { id: "E2", kind: "memory", title: "未批准的资料名称", locator: { label: "本机路径" }, text: "不应发送的片段" },
];
const output = {
  recommendation: { text: "先验证资料授权。", evidenceIds: ["E1"] },
  findings: [{ text: "首发需要先验证权限。", evidenceIds: ["E1"] }],
  questions: ["试点人数待确认。"],
  disagreements: [],
};
const recipients = ["claude", "gemini", "gpt"].map(id => ({ id, name: id, model: id + "-test", configured: true }));

function fixture({ model, sources, timeout, config = recipients } = {}) {
  let current = { owner: "account-a", box: "box-a", scope: "scope-a" };
  let saved;
  const calls = [];
  const exports = [];
  const store = { async load() { return structuredClone(saved); }, async save(value) { saved = structuredClone(value); } };
  const options = {
    identity: () => current, store, timeout,
    sources: {
      async collect() { return { evidence, notices: [] }; },
      async verify() { return true; },
      ...sources,
    },
    models: { recipients: config, async call(provider, stage, body, signal) {
      calls.push({ provider, stage, body, signal });
      const response = model ? await model(provider, stage, body, signal) : stage === "review" ? { issues: [] } : output;
      return { output: response, usage: { inputTokens: 80, outputTokens: 30 } };
    } },
    async saveReport(text, check) { await check(); exports.push(text); return true; },
  };
  const service = createMyAiCollaboration(options);
  return {
    service, options, calls, exports, store, change(next) { current = { ...current, ...next }; service.sync(); },
    preview: check => service.action("preview", { task, selection }, check),
    run: async (preview, ids = ["E1"], check) => service.action("start", { previewId: preview.previewId, evidenceIds: ids }, check),
  };
}

async function until(get) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await get();
    if (value) return value;
    await delay(5);
  }
  throw Error("Expected task state was not reached");
}

async function state(service, id, ...states) {
  return until(async () => {
    const job = await service.action("status", { id });
    return states.includes(job.state) && job;
  });
}

test("only approved excerpts reach independent workers, duplicated starts are idempotent and verified reports export", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ async model(provider, stage) {
    if (stage === "research") await gate;
    return stage === "review" ? { issues: [] } : output;
  } });
  t.after(() => f.service.close());
  const first = await f.preview();
  const second = await f.preview();
  assert.equal(f.calls.length, 0);
  let requestLive = true;
  const check = () => { if (!requestLive) throw Error("HTTP request completed"); };
  const [job, duplicate] = await Promise.all([f.run(first, ["E1"], check), f.run(first)]);
  requestLive = false;
  assert.equal(job.id, duplicate.id);
  await assert.rejects(f.run(first, ["E2"]), /已经用于另一组片段/);
  await assert.rejects(f.run(second), /已有正在运行/);
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls.map(call => call.provider).sort(), ["claude", "gemini"]);
  assert.deepEqual(f.calls[0].body, { task, evidence: [{ id: "E1", text: evidence[0].text }] });
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  release();
  const complete = await state(f.service, job.id, "completed");
  assert.deepEqual(Object.keys(complete.analyses).sort(), ["claude", "gemini"]);
  assert.equal(complete.usage.length, 4);
  assert.equal(f.calls[2].body.analyses.length, 2);
  assert.equal(f.calls[3].provider, "gpt");
  assert.ok(f.calls.every(call => !JSON.stringify(call.body).includes(evidence[1].text)));
  assert.deepEqual(await f.service.action("export", { id: job.id }), { saved: true });
  assert.match(f.exports[0], /E1 · 个人空间 · 发布清单/);
  assert.doesNotMatch(f.exports[0], /不应发送/);
});

test("unknown citations block finalization even when GPT passes, and review is capped at two rounds", async t => {
  const bad = { ...output, findings: [{ text: "引用未经授权。", evidenceIds: ["E2"] }] };
  const f = fixture({ model: (_provider, stage) => stage === "review" ? { issues: [] } : stage === "research" ? output : bad });
  t.after(() => f.service.close());
  const job = await f.run(await f.preview());
  const result = await state(f.service, job.id, "needs-review");
  assert.equal(f.calls.length, 6);
  assert.equal(result.reviewRound, 2);
  assert.deepEqual(result.report.findings[0].evidenceIds, []);
  assert.match(result.issues[0].text, /缺少获准的证据/);
  await assert.rejects(f.service.action("export", { id: job.id }), /通过核证后/);
});

test("changed sources before start prevent transmission, and a changed source blocks export", async t => {
  let valid = false;
  const f = fixture({ sources: { async verify() { return valid; } } });
  t.after(() => f.service.close());
  const job = await f.run(await f.preview());
  assert.match((await state(f.service, job.id, "failed")).failure, /资料有变更/);
  assert.equal(f.calls.length, 0);
  valid = true;
  const second = await f.run(await f.preview());
  await state(f.service, second.id, "completed");
  valid = false;
  await assert.rejects(f.service.action("export", { id: second.id }), /资料有变更/);
  assert.equal(f.exports.length, 0);
});

test("cancellation, timeout, scope changes and recovery stop work", async t => {
  const f = fixture({ model: () => new Promise(() => {}) });
  t.after(() => f.service.close());
  const first = await f.run(await f.preview());
  await until(() => f.calls.length === 2);
  const cancel = await f.service.action("cancel", { id: first.id });
  assert.equal(cancel.state, "cancelled");
  assert.ok(f.calls.every(call => call.signal.aborted));

  const second = await f.run(await f.preview());
  await until(() => f.calls.length === 4);
  const restored = createMyAiCollaboration({ ...f.options, store: { load: f.store.load, async save() {} } });
  assert.equal((await restored.action("status", { id: second.id })).state, "interrupted");
  await restored.close();
  f.change({ owner: "account-b", box: "box-b", scope: "scope-b" });
  await assert.rejects(f.service.action("status", { id: second.id }), /无法打开/);
  assert.deepEqual(await f.service.action("list"), { jobs: [] });
  assert.ok(f.calls.every(call => call.signal.aborted));
  f.change({ owner: "account-a", box: "box-a", scope: "scope-a-new" });
  await state(f.service, second.id, "interrupted");

  const timed = fixture({ timeout: 30, model: () => new Promise(() => {}) });
  t.after(() => timed.service.close());
  const job = await timed.run(await timed.preview());
  assert.match((await state(timed.service, job.id, "failed")).failure, /超过执行时限/);
});

test("unconfigured models and expired or cross-scope previews fail closed", async t => {
  const f = fixture({ config: recipients.map(row => ({ ...row, configured: row.id !== "gpt" })) });
  t.after(() => f.service.close());
  const prior = await f.preview();
  await assert.rejects(f.run(prior), /尚未全部配置/);
  assert.equal(f.calls.length, 0);
  const complete = fixture();
  t.after(() => complete.service.close());
  const old = await complete.preview();
  complete.change({ scope: "new-version" });
  await assert.rejects(complete.run(old), /预览已失效/);
});

test("the three model adapters pin official hosts and parse structured results without exposing credentials", async () => {
  const call = [];
  const fakeKey = "fixture-credential";
  const config = { MEMOBOX_COLLAB_CLAUDE_KEY: fakeKey, MEMOBOX_COLLAB_CLAUDE_MODEL: "claude-test",
    MEMOBOX_COLLAB_GEMINI_KEY: fakeKey, MEMOBOX_COLLAB_GEMINI_MODEL: "gemini-test",
    MEMOBOX_COLLAB_GPT_KEY: fakeKey, MEMOBOX_COLLAB_GPT_MODEL: "gpt-test" };
  const json = JSON.stringify({ issues: [] });
  const models = createCollaborationModels(config, async (url, request) => {
    call.push({ url, ...request, body: JSON.parse(request.body) });
    if (url.includes("anthropic")) return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: json }] });
    if (url.includes("google")) return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: json }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 4, total_thought_tokens: 5 } });
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: json }] }] });
  });
  for (const provider of ["claude", "gemini", "gpt"]) {
    const answer = await models.call(provider, "review", { task }, new AbortController().signal);
    assert.deepEqual(answer.output, { issues: [] });
    if (provider === "gemini") assert.deepEqual(answer.usage, { inputTokens: 10, outputTokens: 9 });
  }
  assert.ok(models.recipients.every(row => row.configured));
  assert.doesNotMatch(JSON.stringify(models.recipients), /fixture-credential/);
  assert.deepEqual(call.map(item => new URL(item.url).hostname), [
    "api.anthropic.com", "generativelanguage.googleapis.com", "api.openai.com",
  ]);
  assert.ok(call.every(item => item.redirect === "error" && !item.body.tools));
  assert.equal(call[1].body.store, false);
  assert.equal(call[2].body.store, false);
});

test("preview gathers scoped sources through reads without model-backed Starlink search and verifies versioned excerpts", async () => {
  const verbs = [];
  let version = "v1";
  const resolver = createCollaborationSources({
    sources: {
      async validate(folderId, warehouseId) { return { folderId, warehouseId }; },
      async call(_scope, action) {
        verbs.push(action);
        if (action === "space_search") return { matches: [{ fileId: "readme", snippet: "发布清单", version: 1 }] };
        return { name: "发布清单", path: "文件夹/发布清单", version: 1, text: "请先核对发布清单。" };
      },
    },
    async starlink(action) {
      verbs.push(action);
      if (action === "documents") return { items: [{ id: "doc", title: "首发试点" }] };
      assert.equal(action, "document");
      return { document: { id: "doc" }, version: { id: version }, segments: [{ id: "one", text: "首发试点须核对清单。" }] };
    },
    memory: {
      async sourceCatalog() { return [{ id: "product" }]; },
      async searchSource() { return { matches: [{ memoryId: "record" }] }; },
      async call(action, _args, _check, _agent, _binding, filter) {
        verbs.push(action);
        assert.equal(filter, "product");
        return { memoryId: "record", title: "讨论", body: "本轮试点人数待定。" };
      },
    },
  });
  const select = { ...selection, warehouseId: "warehouse", memoryAgent: "product" };
  const check = () => {};
  const preview = await resolver.collect(select, task, check);
  assert.deepEqual(preview.notices, []);
  assert.deepEqual(preview.evidence.map(item => item.kind), ["space", "starlink", "memory"]);
  assert.ok(verbs.every(item => ["space_search", "space_read", "documents", "document", "memory_read"].includes(item)));
  assert.ok((await Promise.all(preview.evidence.map(item => resolver.verify(select, item, check)))).every(Boolean));
  version = "v2";
  assert.equal(await resolver.verify(select, preview.evidence[1], check), false);
});

test("Electron protocol exposes collaboration only on the authorized personal memory session", async t => {
  const assets = await mkdtemp(join(tmpdir(), "memobox-collab-protocol-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await writeFile(join(assets, "wanx-memory.html"), "<!doctype html>");
  const f = fixture();
  let requestState = { account: { phase: "authenticated", accountId: "a", clientId: "client" } };
  const workspace = createMemoryWorkspace({ assets, getState: () => requestState,
    myAiTask: async () => ({ agents: [] }), myAiCollaboration: f.service });
  t.after(() => workspace.close());
  const opened = await workspace.open();
  const token = opened.token;
  assert.match(token, /^[a-f0-9]{64}$/);
  const hit = (action, headers = {}) => workspace.handle(new Request("wanx-memory://local/api/wanx-memory/my-ai/" + action, { headers }));
  const headers = { "x-memmy-local-token": token };
  assert.equal((await hit("collaboration/config")).status, 403);
  assert.equal((await (await hit("status", headers)).json()).collaboration, true);
  assert.equal((await (await hit("collaboration/config", headers)).json()).available, true);
  requestState = { account: { phase: "authenticated", accountId: "b", clientId: "client" } };
  assert.equal((await hit("collaboration/config", headers)).status, 403);
});
