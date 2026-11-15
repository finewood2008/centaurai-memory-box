import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createAccount } from "../account/index.mjs";
import { createPlatformClient } from "../platform.mjs";
import { registerControlActions } from "../shell/control.mjs";
const input = { content: "尚未解决的问题" };
for (const [payload, header, scope, seconds] of [
  [{ limitScope: "day", retryAfterSeconds: 3600 }, "10", "day", 3600],
  [null, "45", "minute", 45], [null, null, "minute", 60],
  [{ limitScope: "<script>", retryAfterSeconds: -1 }, null, "minute", 60],
]) test(`429 propagates bounded quota metadata (${scope}/${seconds}) across the real IPC chain`, async () => {
  let fetches = 0;
  const account = createAccount({ fetch: async () => { fetches++; return new Response(JSON.stringify({ code: 429, success: false, data: payload }),
    { status: 429, headers: header ? { "Retry-After": header } : {} }); } });
  const client = createPlatformClient({ account });
  const handlers = new Map(), exposed = {};
  const frame = { url: "file:///fixture/index.html" }, webContents = { mainFrame: frame };
  const event = { sender: webContents, senderFrame: frame };
  registerControlActions({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    control: { webContents, isDestroyed: () => false }, controlURL: frame.url, client });
  vm.runInNewContext(await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "win32" }, require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { on() {}, removeListener() {}, async invoke(name, body) {
        if (name === "wanx-client:get-state") return { account: { phase: "signed_out" } };
        return structuredClone(await handlers.get(name)(event, body));
      } } }),
  });
  const result = await exposed.wanxClient.action("help.feedback", input);
  assert.equal(result.code, "FAQ_FEEDBACK_RATE_LIMITED"); assert.equal(result.limitScope, scope); assert.equal(result.retryAfterSeconds, seconds);
  assert.equal(fetches, 1); await client.close();
});
test("cooldown blocks retries, day-limit keeps draft, and manual FAQ refresh is absent", async () => {
  const window = {}; let time = 1000, calls = 0;
  vm.runInNewContext(await readFile(new URL("../local-ui/renderer/help.js", import.meta.url), "utf8"), { window });
  const view = window.createHelpView({ now: () => time, changed() {}, request: async () => { calls++;
    throw Object.assign(Error("FAQ_FEEDBACK_RATE_LIMITED"), { code: "FAQ_FEEDBACK_RATE_LIMITED", limitScope: "day", retryAfterSeconds: 3600 }); } });
  view.action("help-feedback-open"); view.input("content", input.content);
  await view.action("help-feedback-submit"); await view.action("help-feedback-submit");
  assert.equal(calls, 1); assert.match(view.render(), /今日提交次数已达上限/); assert.match(view.render(), /尚未解决的问题/);
  assert.doesNotMatch(view.render(), /help-refresh|刷新内容/);
  time += 3_600_000; await view.action("help-feedback-submit"); assert.equal(calls, 2);
});
test("cached update preserves search, category, expanded answers and feedback draft", async () => {
  const window = {}; let answer = "旧答案";
  vm.runInNewContext(await readFile(new URL("../local-ui/renderer/help.js", import.meta.url), "utf8"), { window });
  const view = window.createHelpView({ changed() {}, request: async () => ({ data: { categories: [{ id: 7, name: "分类", items: [{ id: 8, question: "如何添加", answer }] }] } }) });
  view.visible(true); await view.refresh(); view.action("help-category", { id: "7" }); view.action("help-search", { query: "添加" });
  view.action("help-feedback-open"); view.input("content", "尚未提交的草稿"); answer = "新答案";
  await view.refresh(); assert.match(view.render(), /data-id="7" aria-pressed="true"/); assert.match(view.render(), /value="添加"/);
  assert.match(view.render(), /新答案/); assert.match(view.render(), /尚未提交的草稿/);
});
