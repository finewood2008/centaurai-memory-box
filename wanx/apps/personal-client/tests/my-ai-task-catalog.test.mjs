import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

test("optimization identifies model failures without exposing raw provider errors or blaming the box connection", async () => {
  for (const [cause, expected] of [
    [Object.assign(new Error("private upstream detail"), { status: 402 }), /模型服务商账户余额不足/],
    [Object.assign(new Error("private upstream detail"), { status: 500, code: "INTERNAL_ERROR" }), /模型服务商账户余额/],
    [Object.assign(new Error("private upstream detail"), { name: "TimeoutError" }), /优化超时/],
  ]) {
    const task = createMyAiTask(options({ polish: async () => { throw cause; } }));
    await assert.rejects(task("optimize", { agent: "codex", draft: "查找资料" }, check), error => {
      assert.equal(error.status, 400); assert.equal(error.cause, cause);
      assert.match(error.message, expected); assert.doesNotMatch(error.message, /private|检查盒子连接/); return true;
    });
  }
  const unavailable = Object.assign(new Error("APPLICATION_MODEL_UNAVAILABLE"), { code: "APPLICATION_MODEL_UNAVAILABLE" });
  const task = createMyAiTask(options({ polish: async () => { throw unavailable; } }));
  await assert.rejects(task("optimize", { agent: "codex", draft: "查找资料" }, check), error => error === unavailable);
  let revoked = false;
  const scopeError = Object.assign(new Error("Session revoked"), { status: 403 });
  const canceled = createMyAiTask(options({ polish: async () => { revoked = true; throw new Error("provider error"); } }));
  await assert.rejects(canceled("optimize", { agent: "codex", draft: "查找资料" }, () => { if (revoked) throw scopeError; }), error => error === scopeError);
});

test("older Codex actions use the same account-bound authorization as My AI", async () => {
  const calls = [];
  const task = createMyAiTask(options({
    codexContext: { manage() { assert.fail("legacy connection bypassed My AI authorization"); } },
    agentAccess: {
      async connect(id, assertScope) { assertScope(); calls.push(["connect", id]); },
      async status(assertScope) { assertScope(); return { codex: { authorized: true } }; },
      async test(id, assertScope) { assertScope(); calls.push(["test", id]); },
      async disconnect(id, assertScope) { assertScope(); calls.push(["disconnect", id]); },
    },
  }));
  await task("codex-context/connect", {}, check);
  assert.deepEqual(await task("codex-context/status", {}, check), { authorized: true });
  await task("codex-context/test", {}, check);
  await task("codex-context/disconnect", {}, check);
  assert.deepEqual(calls, [["connect", "codex"], ["test", "codex"], ["disconnect", "codex"]]);
});

test("finds Mac CLI installations with a desktop PATH and uses the same PATH for their version probes", async t => {
  const home = await mkdtemp(join(tmpdir(), "memobox-agent-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const localBin = join(home, ".local", "bin");
  const executable = join(localBin, "agy");
  await mkdir(localBin, { recursive: true });
  await writeFile(join(localBin, "gemini"), "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  const pathValue = ["/usr/bin", "/bin"].join(delimiter);
  const launches = [];
  const task = createMyAiTask(options({
    home, env: { PATH: pathValue }, commandInstalled: undefined,
    async version(command, args, { env }) {
      if (command !== executable) return { stdout: "" };
      assert.deepEqual(args, ["--version"]);
      assert.equal(env.PATH.split(delimiter).slice(0, 2).join(delimiter), pathValue);
      assert.ok(env.PATH.split(delimiter).includes(localBin));
      return { stdout: "1.2.3" };
    },
    launcher: { async launch(input) { launches.push(input.executable); } },
  }));
  const gemini = (await task("status", {}, check)).agents.find(agent => agent.id === "gemini");
  assert.equal(gemini.name, "Google");
  assert.equal(gemini.connectionAvailable, true);
  assert.equal(gemini.version, "1.2.3");
  await task("launch", { agent: "gemini" }, check);
  assert.deepEqual(launches, [executable]);
  await rm(executable);
  await assert.rejects(task("launch", { agent: "gemini" }, check), /未找到可用 CLI/);
});

test("connects guided agents and an existing DeepSeek desktop profile without an installed app", async t => {
  const home = await mkdtemp(join(tmpdir(), "memobox-agent-profile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "custom-dsh");
  const profile = join(root, "profiles", "desktop", "cordis.patch.yml");
  const calls = [];
  const task = createMyAiTask(options({ home, env: { DSH_HOME: root }, agentAccess: {
    supports: () => true, async status() { return {}; },
    async connect(id, assertScope) { assertScope(); calls.push(id); },
  } }));
  const status = async id => (await task("status", {}, check)).apps.find(agent => agent.id === id);
  assert.equal((await status("workbuddy")).connectionAvailable, true);
  assert.equal((await status("deepseek_harness")).connectionAvailable, false);
  await assert.rejects(task("agent-access/connect", { agent: "deepseek_harness" }, check), /请先安装/);
  await assert.rejects(task("agent-access/connect", { agent: "gemini" }, check), /请先安装/);
  await mkdir(dirname(profile), { recursive: true });
  await writeFile(profile, "[]\n");
  assert.equal((await status("deepseek_harness")).installed, false);
  assert.equal((await status("deepseek_harness")).connectionAvailable, true);
  await task("agent-access/connect", { agent: "workbuddy" }, check);
  await task("agent-context/connect", { agent: "deepseek_harness" }, check);
  assert.deepEqual(calls, ["workbuddy", "deepseek_harness"]);
});

test('Windows protocol handlers recognize known executables and reject foreign or network paths', async () => {
  let handler = 'C:\\Apps\\Codex\\Codex.exe';
  const task = createMyAiTask(options({platform:'win32',home:'C:\\Users\\fixture',
    protocolRegistered:()=>true,applicationForProtocol:async()=>({path:handler})}));
  const inspect = async id => (await task('status',{},check)).apps.find(agent=>agent.id===id);
  assert.equal((await inspect('codex')).installed,true);
  assert.equal((await inspect('codex')).prefill,true);
  handler='C:\\Apps\\Claude\\Claude.exe';
  assert.equal((await inspect('claude_desktop')).installed,true);
  handler='C:\\Apps\\WorkBuddy\\WorkBuddy.exe';
  assert.equal((await inspect('workbuddy_cn')).installed,true);
  assert.equal((await inspect('workbuddy_cn')).name,'WorkBuddy（国内版）');
  for (const rejected of ['C:\\Windows\\System32\\cmd.exe','\\\\server\\share\\Codex.exe','//server/share/Codex.exe','Codex.exe']) {
    handler=rejected;
    assert.equal((await inspect('codex')).installed,false,rejected);
  }
});

test("labels and opens the international and mainland WorkBuddy editions on macOS", async () => {
  const opened = [];
  const bundles = { workbuddy: "WorkBuddy AI.app", workbuddy_cn: "WorkBuddy.app" };
  const task = createMyAiTask(options({
    findApplication: async agent => {
      const name = bundles[agent.id];
      return name && agent.bundles.includes(name.toLowerCase()) ? join("/Applications", name) : null;
    },
    async openApplication(file) { opened.push(file); },
  }));
  const { agents } = await task("status", {}, check);
  for (const [id, bundle] of Object.entries(bundles)) {
    const edition = agents.find(agent => agent.id === id);
    assert.equal(edition?.name, id === "workbuddy" ? "WorkBuddy（海外版）" : "WorkBuddy（国内版）");
    assert.equal(edition.sourceId, "workbuddy");
    await task("launch", { agent: id }, check);
    assert.equal(opened.at(-1), join("/Applications", bundle));
  }
});

test("catalog contains exactly nine runtime entries and shares product context identities", async () => {
  assert.deepEqual(managedAgentIds, ["codex", "codex_cli", "claude_code", "claude_desktop", "gemini", "workbuddy", "workbuddy_cn", "qwenwork", "deepseek_harness"]);
  assert.equal(new Set(agentCatalog.map(agent => agent.product)).size, 6);
  assert.equal(contextAgent("codex_cli"), "codex");
  assert.equal(contextAgent("claude_desktop", "code"), "claude_code");
  assert.equal(contextAgent("claude_desktop", "cowork"), "claude_desktop");
  const task = createMyAiTask(options({ commandInstalled: async command => command === "codex" }));
  const status = await task("status", {}, check);
  assert.deepEqual(status.agents.map(agent => agent.id), ["codex_cli"]);
  assert.equal(status.apps.length, 9);
  assert.equal(status.apps.find(agent => agent.id === "codex").installed, false);
  assert.equal(status.apps.find(agent => agent.id === "workbuddy").name, "WorkBuddy（海外版）");
  assert.equal(status.apps.find(agent => agent.id === "workbuddy").capabilities.configuration, "guided");
  await assert.rejects(task("download", { agent: "cursor" }, check), /不可用/);
});

test("the manual repair action copies only the user-scope Claude Code command", async () => {
  const copied = [];
  const task = createMyAiTask(options({ copyText: text => copied.push(text) }));
  const action = "agent-access/copy-removal-command";
  await assert.rejects(task(action, { agent: "gemini" }, check), /仅适用于 Claude Code/);
  await assert.rejects(task(action, { agent: "claude_code" }, () => { throw new Error("scope changed"); }), /scope changed/);
  assert.deepEqual(copied, []);
  assert.deepEqual(await task(action, { agent: "claude_desktop", mode: "code" }, check), { copied: true });
  assert.deepEqual(copied, ["claude mcp remove wanx-memobox --scope user"]);
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
    commandInstalled: async command => command === "agy" ? { executable: "/test/bin/agy", version: "1.0.0", channel: "external" } : false,
    launcher: { async prepare(input) { prepared.push(input); return { opened: true, prepared: true, delivery: "terminal-confirm" }; },
      async launch(input) { launched.push(input); return { opened: true, prepared: true, delivery: "terminal-confirm" }; } },
  }));
  const text = "--yolo `touch bad` $(echo secret) \" x\n第二行";
  assert.equal((await task("handoff", { agent: "gemini", text, workspacePath: "/tmp/project" }, check)).prepared, true);
  assert.deepEqual(prepared[0].args, ["--prompt-interactive=" + text]);
  assert.equal(prepared[0].prompt, text);
  assert.equal(prepared[0].cwd, "/tmp/project");
  assert.equal(prepared[0].executable, "/test/bin/agy");
  await task("launch", { agent: "gemini", workspacePath: "/tmp/project" }, check);
  assert.equal(launched[0].executable, "/test/bin/agy");
  assert.deepEqual(launched[0].args, []);
});

test("generic resources authorize per product, including Codex CLI and local Cowork", async () => {
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
      async status() { return { claude_code: { configured: true, available: false }, claude_desktop: { configured: true } }; },
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
  assert.deepEqual(await task("agent-context/status", { agent: "claude_desktop", mode: "cowork" }, check), { configured: true });
  await task("copy", { agent: "claude_desktop", mode: "cowork", text: "Review", agentContext: { folderId: "folder" } }, check);
  assert.equal(prepared[1].folderId, "folder");
  assert.match(copied[1], /space_search.*space_read/s);
  await assert.rejects(task("copy", { agent: "claude_code", text: "Review", codexContext: { folderId: "folder" } }, check), /Codex/);
  assert.equal(described.length, 1);
});

test("installation actions distinguish managed lifecycle from official-page guidance", async () => {
  const calls = [], urls = [];
  const task = createMyAiTask(options({ openExternal: async value => { urls.push(value); },
    installations: {
      inspect: async () => null, supported: id => id === "codex_cli",
      async install(id) { calls.push(id); return { installed: true, message: "verified" }; },
    },
  }));
  assert.equal((await task("install", { agent: "codex_cli" }, check)).installed, true);
  const guided = await task("install", { agent: "gemini" }, check);
  assert.equal(guided.guided, true);
  assert.equal(guided.installed, undefined);
  assert.deepEqual(calls, ["codex_cli"]);
  assert.deepEqual(urls, ["https://antigravity.google/docs/cli/tutorial/"]);
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

test("review binds the handoff to the confirmed prompt, box and model without persisting the task", async () => {
  let scope = "box-one", model = null;
  const copies = [], prepared = [], revoked = [];
  const task = createMyAiTask(options({
    boxScope: () => scope,
    copyText: value => copies.push(value),
    cloudRoutes: { async action() { return { selected: model }; } },
    codexContext: {
      async manage() { return { connected: true }; },
      async prepare(selected) {
        prepared.push(selected);
        return { taskId: "d".repeat(36), resources: {}, revoke: () => revoked.push(true) };
      },
    },
    agentAccess: {
      async selection() { assert.fail("explicit empty review must never load the saved default scope"); },
    },
  }));
  const input = { agent: "codex", text: "整理发布清单" };
  const approval = await task("review-handoff", input, check);
  assert.equal(copies.length, 0);
  assert.equal(prepared.length, 0);
  assert.deepEqual(approval.context.sources, { memoryEnabled: false });
  assert.doesNotMatch(JSON.stringify(approval), /box-one/);
  const approved = { ...input, confirmation: approval.confirmation };
  await assert.rejects(task("copy", { ...approved, text: "另一个任务" }, check), /重新核对/);
  scope = "box-two";
  await assert.rejects(task("copy", approved, check), /重新核对/);
  scope = "box-one";
  model = { model: "selected", ref: "provider/selected" };
  await assert.rejects(task("copy", approved, check), /重新核对/);
  assert.equal(copies.length, 0);
  assert.equal(revoked.length, 3);
  model = null;
  assert.deepEqual(await task("copy", approved, check), { copied: true });
  assert.ok(prepared.every(value => value.memoryEnabled === false));
  assert.match(copies[0], /整理发布清单.*未授权/s);
});
