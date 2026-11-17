import assert from "node:assert/strict";
import test from "node:test";
import { agentCatalog, contextAgent, managedAgentIds } from "../shell/my-ai-catalog.mjs";
import { createMyAiTask } from "../shell/my-ai-task.mjs";

const check = () => {};
const options = overrides => ({
  platform: "darwin", home: "/tmp", findApplication: async () => null,
  commandInstalled: async () => false, protocolRegistered: () => false,
  openExternal: async () => {}, copyText() {}, boxScope: () => "account/box/session",
  polish: async () => ({ text: "Optimized task" }), ...overrides,
});

test("catalog contains exactly eight runtime entries and shares product context identities", async () => {
  assert.deepEqual(managedAgentIds, ["codex", "codex_cli", "claude_code", "claude_desktop", "gemini", "workbuddy", "qwenwork", "deepseek_harness"]);
  assert.equal(new Set(agentCatalog.map(agent => agent.product)).size, 6);
  assert.equal(contextAgent("codex_cli"), "codex");
  assert.equal(contextAgent("claude_desktop", "code"), "claude_code");
  assert.equal(contextAgent("claude_desktop", "cowork"), null);
  const task = createMyAiTask(options({ commandInstalled: async command => command === "codex" }));
  const status = await task("status", {}, check);
  assert.deepEqual(status.agents.map(agent => agent.id), ["codex_cli"]);
  assert.equal(status.apps.length, 8);
  assert.equal(status.apps.find(agent => agent.id === "codex").installed, false);
  assert.equal(status.apps.find(agent => agent.id === "workbuddy").capabilities.configuration, "guided");
  await assert.rejects(task("download", { agent: "cursor" }, check), /不可用/);
});

test("desktop mode links prefill exact text without submitting and decline unverified protocol handlers", async () => {
  const opened = [];
  const task = createMyAiTask(options({
    protocolRegistered: protocol => protocol.startsWith("claude:"),
    applicationForProtocol: async () => ({ path: "/Applications/Claude.app" }),
    openExternal: async url => { opened.push(new URL(url)); },
  }));
  const text = "Review & keep + % # 你好\n$(touch /tmp/never-execute)";
  const result = await task("handoff", { agent: "claude_desktop", mode: "code", text, workspacePath: "/tmp/review" }, check);
  assert.deepEqual(result, { opened: true, delivery: "draft" });
  assert.equal(opened[0].host, "code");
  assert.equal(opened[0].searchParams.get("q"), text);
  assert.equal(opened[0].searchParams.get("folder"), "/tmp/review");
  assert.equal(opened[0].searchParams.has("send"), false);
  const invalid = createMyAiTask(options({ protocolRegistered: () => true, applicationForProtocol: async () => ({ path: "/Applications/Unrelated.app" }) }));
  assert.deepEqual((await invalid("status", {}, check)).agents, []);
  await assert.rejects(task("handoff", { agent: "claude_desktop", mode: "unknown", text }, check), /不可用/);
});

test("long drafts and guided clients copy the entire prompt and explicitly report manual delivery", async () => {
  const copied = [], opened = [];
  const task = createMyAiTask(options({ protocolRegistered: protocol => protocol.startsWith("codex:"),
    copyText: text => { copied.push(text); }, openExternal: async url => { opened.push(url); },
  }));
  const text = "长".repeat(3000);
  const result = await task("handoff", { agent: "codex", text }, check);
  assert.equal(result.delivery, "copy-open");
  assert.equal(result.reason, "too-long");
  assert.equal(result.copied, true);
  assert.equal(copied[0], text);
  assert.equal(opened[0], "codex://threads/new");
  const guided = createMyAiTask(options({ findApplication: async agent => agent.id === "qwenwork" ? "/Applications/QwenWork.app" : null,
    copyText: value => { copied.push(value); }, openApplication: async file => { opened.push(file); return ""; },
  }));
  assert.deepEqual(await guided("handoff", { agent: "qwenwork", text: "Task" }, check), { opened: true, copied: true, delivery: "copy-open", reason: "manual" });
});

test("Windows detects the registered Codex package and sends the full draft to that package", async () => {
  const opened = [];
  const task = createMyAiTask(options({
    platform: "win32",
    applicationForProtocol: async () => { throw new Error("No executable exposed for the packaged handler"); },
    windowsCodex: {
      detect: async () => ({ version: "26.1111.2228.0" }),
      open: async url => { opened.push(new URL(url)); },
    },
  }));
  const desktop = (await task("status", {}, check)).agents.find(agent => agent.id === "codex");
  assert.equal(desktop?.version, "26.1111.2228.0");
  assert.equal(desktop?.prefill, true);
  await task("launch", { agent: "codex" }, check);
  const text = "检查测试草稿 & 保留原文。".repeat(200);
  const workspacePath = import.meta.dirname;
  assert.deepEqual(await task("handoff", { agent: "codex", text, workspacePath }, check), { opened: true, delivery: "draft" });
  assert.equal(opened[0].href, "codex://threads/new");
  assert.equal(opened[1].searchParams.get("prompt"), text);
  assert.equal(opened[1].searchParams.get("path"), workspacePath);
  assert.equal(opened[1].searchParams.has("send"), false);
  const missing = createMyAiTask(options({ platform: "win32", protocolRegistered: () => true, windowsCodex: { detect: async () => null } }));
  assert.equal((await missing("status", {}, check)).agents.some(agent => agent.id === "codex"), false);
});

test("CLI tasks use resolved executable, preserve arguments literally and delegate review before start", async () => {
  const prepared = [], launched = [];
  const task = createMyAiTask(options({
    commandInstalled: async command => command === "gemini" ? { executable: "/test/bin/gemini", version: "1.0.0", channel: "external" } : false,
    launcher: { async prepare(input) { prepared.push(input); return { opened: true, prepared: true, delivery: "terminal-confirm" }; },
      async launch(input) { launched.push(input); return { opened: true, prepared: true, delivery: "terminal-confirm" }; } },
  }));
  const text = "--yolo `touch bad` $(echo secret) \" x\n第二行";
  assert.equal((await task("handoff", { agent: "gemini", text, workspacePath: "/tmp/project" }, check)).prepared, true);
  assert.deepEqual(prepared[0].args, ["--prompt-interactive=" + text]);
  assert.equal(prepared[0].prompt, text);
  assert.equal(prepared[0].cwd, "/tmp/project");
  assert.equal(prepared[0].executable, "/test/bin/gemini");
  await task("launch", { agent: "gemini", workspacePath: "/tmp/project" }, check);
  assert.deepEqual(launched[0].args, []);
});

test("generic resources authorize per product, preserve Codex alias and reject Cowork claims", async () => {
  const prepared = [], described = [], copied = [], calls = [];
  const resources = { folder: { id: "folder", name: "Selected folder" } };
  const context = {
    async describe(selection, check) { check(); described.push(selection); return resources; },
    async prepare(selection, check) { check(); prepared.push(selection); return { taskId: "a".repeat(36), resources, revoke() {} }; },
    async manage(action) { calls.push(action); return { folders: [] }; },
  };
  const task = createMyAiTask(options({ copyText: text => { copied.push(text); },
    agentAccess: {
      context(id) { calls.push(id); return context; }, supports: () => true,
      async selection(id, input) { calls.push([id, input]); return { selection: input ?? { folderId: "folder", memoryEnabled: false }, resources }; },
      async status() { return { claude_code: { configured: true, available: false } }; },
    },
    codexContext: context,
  }));
  const optimized = await task("optimize", { agent: "claude_code", draft: "Review selected files" }, check);
  assert.match(optimized.text, /Selected folder.*space_search/s);
  await task("copy", { agent: "codex_cli", text: "Review", agentContext: { folderId: "folder", memoryEnabled: true } }, check);
  assert.equal(prepared[0].memoryEnabled, true);
  assert.match(copied[0], /memory_search.*memory_read/s);
  assert.match(copied[0], /task_id: a{36}/);
  assert.deepEqual(await task("agent-context/status", { agent: "claude_desktop", mode: "code" }, check), { configured: true, available: false });
  await assert.rejects(task("agent-context/status", { agent: "claude_desktop", mode: "cowork" }, check), /暂无/);
  await assert.rejects(task("copy", { agent: "claude_code", text: "Review", codexContext: { folderId: "folder" } }, check), /Codex/);
  assert.equal(described.length, 1);
});

test("installation actions distinguish managed lifecycle from official-page guidance", async () => {
  const calls = [], urls = [];
  const task = createMyAiTask(options({ openExternal: async value => { urls.push(value); },
    installations: {
      inspect: async () => null, supported: id => id === "gemini",
      async install(id) { calls.push(id); return { installed: true, message: "verified" }; },
    },
  }));
  assert.equal((await task("install", { agent: "gemini" }, check)).installed, true);
  const guided = await task("install", { agent: "workbuddy" }, check);
  assert.equal(guided.guided, true);
  assert.equal(guided.installed, undefined);
  assert.deepEqual(calls, ["gemini"]);
  assert.equal(urls.length, 1);
});

test("connected explicit empty scopes create a zero-scope task, while plain disconnected drafts stay usable", async () => {
  const prepared = [], copied = [];
  const context = {
    async manage() { return { configured: true, connected: true }; },
    async prepare(selected) { prepared.push(selected); return { taskId: "b".repeat(36), resources: {}, revoke() {} }; },
  };
  const task = createMyAiTask(options({ codexContext: context, copyText: value => copied.push(value) }));
  await task("copy", { agent: "codex", text: "Plain task", agentContext: { memoryEnabled: false } }, check);
  assert.deepEqual(prepared, [{ memoryEnabled: false }]);
  assert.match(copied[0], /未授权空间、星图或历史记忆读取/);
  assert.match(copied[0], /task_id: b{36}/);
  await assert.rejects(task("copy", { agent: "codex", text: "Plain task", agentContext: null }, check), /无效/);
  const isolated = createMyAiTask(options({ integrationUnavailable: "isolated", agentAccess: { supports: () => false, status: async () => ({}) } }));
  assert.equal((await isolated("status", {}, check)).integrationUnavailable, "isolated");
  assert.equal((await isolated("optimize", { agent: "claude_desktop", mode: "cowork", draft: "Plain task", agentContext: { memoryEnabled: false } }, check)).text, "Optimized task");
});
