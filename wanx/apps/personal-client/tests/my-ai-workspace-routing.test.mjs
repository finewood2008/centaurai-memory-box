import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWorkspace, MEMORY_ORIGIN } from "../shell/memory-workspace.mjs";

async function fixture(t) {
  const assets = await mkdtemp(path.join(tmpdir(), "my-ai-routing-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await writeFile(path.join(assets, "wanx-memory.html"), "<!doctype html>");
  const runtimeFile = path.join(assets, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:3456", localToken: "synthetic-service-token" }));
  let state = { account: { phase: "authenticated", accountId: "alice", clientId: "test-client" } };
  const calls = [];
  let onTransfer;
  const workspace = createMemoryWorkspace({ assets, runtimeFile, getState: () => state,
    runtime: { async waitForStartup() {} },
    agentAccess: { supports: id => ["codex", "claude_code"].includes(id), async disconnect(id) { calls.push(["disconnect", id]); return { connected: false }; } },
    memoryTransfer: { async action(method, data, check) { check(); calls.push(["transfer", method, data]); onTransfer?.(); check(); return { previewId: "opaque-preview" }; } },
    claudeChatImport: { async action(method, data, check) { check(); calls.push(["claude", method, data]); onTransfer?.(); check(); return { previewId: "claude-preview" }; } },
    myAiTask: async (action, data) => { calls.push([action, data]); return {}; },
    request: async (url, init) => {
      assert.equal(url.pathname, "/api/agent-sources/codex/sync-access");
      calls.push(["sync", JSON.parse(init.body)]);
      return Response.json({ sourceId: "codex", syncDisabled: true });
    },
  });
  const { token } = await workspace.open();
  const request = (action, data = {}, session = token, method = "POST") => workspace.handle(new Request(MEMORY_ORIGIN + "/api/wanx-memory/my-ai/" + action, {
    method, headers: { "x-memmy-local-token": session }, body: method === "POST" ? JSON.stringify(data) : undefined,
  }));
  return { workspace, calls, request, token,
    switchDuringTransfer() { onTransfer = () => { state = { account: { ...state.account, accountId: "bob" } }; workspace.sync(); }; } };
}

test("generic source and native-file transfer routes require an active desktop token and preserve the preview gate", async t => {
  const h = await fixture(t);
  assert.equal((await h.request("memory-transfer/preview", {}, "wrong-token")).status, 403);
  assert.equal((await h.request("memory-transfer/preview", {}, h.token, "GET")).status, 403);
  assert.equal((await h.request("memory-transfer/preview")).status, 200);
  assert.deepEqual(h.calls, [["transfer", "preview", {}]]);
  assert.equal((await h.workspace.handle(new Request(MEMORY_ORIGIN + "/api/local-data/bundle/import", {
    method: "POST", headers: { "x-memmy-local-token": h.token }, body: "{}",
  }))).status, 403);
  assert.equal((await h.request("agent-context/selection", { agent: "gemini", selection: { memoryEnabled: false } })).status, 200);
  assert.deepEqual(h.calls.at(-1), ["agent-context/selection", { agent: "gemini", selection: { memoryEnabled: false } }]);
  const repairAction = "agent-access/copy-removal-command";
  const claude = { agent: "claude_code" };
  assert.equal((await h.request(repairAction, claude, "wrong-token")).status, 403);
  assert.equal((await h.request(repairAction, claude)).status, 200);
  assert.deepEqual(h.calls.at(-1), [repairAction, claude]);
  assert.equal((await h.request("agent-access/test", { agent: "gemini" }, "wrong-token")).status, 403);
  assert.equal((await h.request("agent-access/test", { agent: "gemini" }, h.token, "GET")).status, 403);
  assert.equal((await h.request("agent-access/test", { agent: "gemini" })).status, 200);
  assert.deepEqual(h.calls.at(-1), ["agent-access/test", { agent: "gemini" }]);
  h.switchDuringTransfer();
  assert.equal((await h.request("memory-transfer/import", { previewId: "opaque-preview" })).status, 403);
});

test("Claude file selection and commit are restricted to the current desktop session", async t => {
  const h = await fixture(t);
  assert.equal((await h.request("claude-chat-import/preview", {}, "wrong-token")).status, 403);
  assert.equal((await h.request("claude-chat-import/preview", {}, h.token, "GET")).status, 403);
  const preview = await h.request("claude-chat-import/preview");
  assert.deepEqual(await preview.json(), { previewId: "claude-preview" });
  assert.deepEqual(h.calls, [["claude", "preview", {}]]);
  h.switchDuringTransfer();
  assert.equal((await h.request("claude-chat-import/commit", { previewId: "claude-preview" })).status, 403);
});

test("CLI and desktop mode revocation resolves their shared integration and scan source", async t => {
  const h = await fixture(t);
  assert.equal((await h.request("agent-access/disconnect", { agent: "codex_cli" })).status, 200);
  assert.equal((await h.request("agent-access/disconnect", { agent: "claude_desktop", mode: "code" })).status, 200);
  assert.deepEqual(h.calls, [["disconnect", "codex"], ["disconnect", "claude_code"]]);
  assert.equal((await h.request("hide-agent", { agent: "codex_cli" })).status, 200);
  assert.deepEqual(h.calls.slice(-2), [["disconnect", "codex"], ["sync", { enabled: false }]]);
});
