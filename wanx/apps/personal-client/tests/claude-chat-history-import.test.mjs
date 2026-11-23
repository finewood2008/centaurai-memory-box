import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createClaudeChatHistoryImport } from "../shell/claude-chat-history-import.mjs";

const history = [{ uuid: "chat-1", name: "青色纸舟", chat_messages: [
  { uuid: "message-1", sender: "human", text: "查询虚构纸舟", created_at: "2025-06-18T03:02:01.123456Z" },
  { uuid: "message-2", sender: "assistant", text: "重复回退字段", content: [
    { type: "thinking", thinking: "NOT VISIBLE" }, { type: "text", text: "第一段\n## tool\n原文" },
    { type: "tool_result", content: "INTERNAL RESULT" }, { type: "text", text: "第二段" },
  ] },
  { uuid: "message-3", sender: "assistant", content: [{ type: "tool_use", name: "internal" }] },
] }];

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "claude-history-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeFile = path.join(home, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:19000", localToken: "fixture-token" }));
  const memories = new Map();
  let file;
  let owner = "owner-a";
  let failing = false;
  const importer = createClaudeChatHistoryImport({ runtimeFile, identity: () => owner, chooseFile: async () => file,
    async request(url, options) {
      assert.equal(String(url), "http://127.0.0.1:19000/api/v1/memory/add");
      assert.equal(options.headers["x-memmy-local-token"], "fixture-token");
      const payload = JSON.parse(options.body);
      assert.equal(payload.deferProcessing, true);
      assert.equal(payload.source, "claude_desktop");
      const previous = memories.get(payload.requestId);
      if (previous) return JSON.stringify(previous) === JSON.stringify(payload)
        ? Response.json({ id: "fixture", duplicate: true })
        : Response.json({ error: { message: "idempotency key reused with different request body" } }, { status: 409 });
      if (failing && memories.size === 1) return Response.json({}, { status: 503 });
      memories.set(payload.requestId, payload);
      return Response.json({ id: "fixture" });
    },
  });
  return { memories, async select(name, contents) { file = path.join(home, name); await writeFile(file, contents); },
    setOwner(value) { owner = value; }, setFailure(value) { failing = value; },
    action: (method, data = {}) => importer.action(method, data, () => {}),
  };
}

test("previews ZIP shards, reads visible text only, and skips previously imported messages", async t => {
  const h = await fixture(t);
  const zip = new JSZip();
  zip.file("export/conversations.json", JSON.stringify(history));
  zip.file("export/conversations-1.json", JSON.stringify(history));
  zip.file("export/users.json", JSON.stringify([{ private: true }]));
  await h.select("claude.zip", await zip.generateAsync({ type: "nodebuffer" }));
  const preview = await h.action("preview");
  assert.equal(preview.conversationCount, 1);
  assert.equal(preview.messageCount, 2);
  assert.equal(preview.recordCount, 2);
  assert.equal(h.memories.size, 0);
  assert.deepEqual(await h.action("commit", { previewId: preview.previewId }), { imported: 2, skipped: 0, remaining: 0 });
  const [first, second] = [...h.memories.values()];
  assert.equal(first.createdAt, "2025-06-18T03:02:01.123Z");
  assert.match(second.content, /第一段\n## tool\n原文\n\n第二段/);
  assert.doesNotMatch(second.content, /重复回退字段|NOT VISIBLE|INTERNAL RESULT/);
  await h.select("conversations.json", JSON.stringify(history));
  const again = await h.action("preview");
  assert.deepEqual(await h.action("commit", { previewId: again.previewId }), { imported: 0, skipped: 2, remaining: 0 });
  const renamed = [{ ...history[0], name: "更新后的标题" }];
  await h.select("conversations.json", JSON.stringify(renamed));
  const newer = await h.action("preview");
  assert.deepEqual(await h.action("commit", { previewId: newer.previewId }), { imported: 0, skipped: 2, remaining: 0 });
});

test("binds preview to file and owner, rejects unrelated JSON, and safely retries interrupted imports", async t => {
  const h = await fixture(t);
  await h.select("conversations.json", JSON.stringify(history));
  const first = await h.action("preview");
  h.setOwner("owner-b");
  await assert.rejects(h.action("commit", { previewId: first.previewId }), /预览已失效/);
  h.setOwner("owner-a");
  await h.select("conversations.json", JSON.stringify([]));
  await assert.rejects(h.action("commit", { previewId: first.previewId }), /没有可导入/);
  await h.select("manifest.json", JSON.stringify({ files: [] }));
  await assert.rejects(h.action("preview"), /不是 Claude 对话导出/);
  await assert.rejects(h.action("preview", { path: "/tmp/conversations.json" }), /文件选择窗口/);
  await h.select("conversations.json", JSON.stringify(history));
  const preview = await h.action("preview");
  h.setFailure(true);
  assert.deepEqual(await h.action("commit", { previewId: preview.previewId }), { imported: 1, skipped: 0, remaining: 1 });
  h.setFailure(false);
  assert.deepEqual(await h.action("commit", { previewId: preview.previewId }), { imported: 1, skipped: 1, remaining: 0 });
});
