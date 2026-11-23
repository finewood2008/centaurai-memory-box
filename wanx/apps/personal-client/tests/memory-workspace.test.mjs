import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWorkspace, MEMORY_ORIGIN, resolveMemoryRuntimeFile } from "../shell/memory-workspace.mjs";
import { createMyAiTask } from "../shell/my-ai-task.mjs";

function signedIn(accountId) {
  return { account: { phase: "authenticated", accountId, clientId: "client" } };
}

test("independent libraries reject connection writes with a readable error envelope while keeping scans available", async t => {
  for (const id of ["codex-desktop", "codex-cli"]) {
    const library = { id, name: id === "codex-desktop" ? "Codex Desktop" : "Codex CLI" };
    const backup = { library, store: { async load() { return {}; } },
      space: { snapshot() { return { scope: null }; } } };
    const h = await fixture(t, undefined, undefined, undefined, () => Response.json({ ok: true }), backup);
    t.after(() => h.memory.close());
    h.setState(signedIn("one"));
    const { token } = await h.memory.open();
    for (const [route, method] of [
      ["/api/agent-sources/codex/plugin", "POST"],
      ["/api/agent-sources/codex/plugin", "DELETE"],
      ["/api/agent-sources/codex/plugin", "PATCH"],
      ["/api/agent-sources/codex/skill", "POST"],
      ["/api/agent-sources/codex/managed/sync", "POST"],
      ["/api/agent-sources/manual", "POST"],
    ]) {
      const response = await h.fetch(route, { token, method });
      assert.equal(response.status, 403);
      const { error } = await response.json();
      assert.equal(error.code, "forbidden");
      assert.match(error.requestId, /^[a-f0-9-]{36}$/);
      assert.match(error.message, new RegExp(library.name));
      assert.match(error.message, /本机扫描/);
    }
    assert.equal(h.requests.length, 0);
    assert.equal((await h.fetch("/api/agent-sources", { token })).status, 200);
    assert.equal((await h.fetch("/api/agent-sources/scan", { token, method: "POST", body: { sourceId: "codex" } })).status, 200);
    assert.equal(h.requests.length, 2);
  }
});

test("legacy libraries retain authenticated connection operations", async t => {
  const backup = { library: { id: "legacy", name: "旧版混合库" },
    store: { async load() { return {}; } }, space: { snapshot() { return { scope: null }; } } };
  const h = await fixture(t, undefined, undefined, undefined, () => Response.json({ ok: true }), backup);
  t.after(() => h.memory.close());
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  assert.equal((await h.fetch("/api/agent-sources/codex/plugin", { method: "POST" })).status, 403);
  assert.equal(h.requests.length, 0);
  const oldPicker = await h.fetch("/api/wanx-memory/backup", { token, method: "POST", body: { action: "select-library", libraryId: "codex-cli" } });
  assert.equal(oldPicker.status, 400);
  assert.equal((await h.fetch("/api/agent-sources/codex/plugin", { token, method: "POST" })).status, 200);
  assert.equal(h.requests.length, 1);
  const invalid = await h.fetch("/api/app/settings", { token, method: "PATCH", body: null });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_argument");
  await writeFile(h.runtimeFile, JSON.stringify({ baseUrl: "http://192.0.2.5:32113", localToken: "service-token" }));
  const unavailable = await h.fetch("/api/app/bootstrap", { token });
  assert.equal(unavailable.status, 503);
  const error = (await unavailable.json()).error;
  assert.equal(error.code, "memory_layer_unavailable");
  assert.match(error.requestId, /^[a-f0-9-]{36}$/);
});

test("MemoBox keeps its runtime endpoint when the standalone desktop overwrites the shared file", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-descriptor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { MEMMY_HOME: root };
  const shared = path.join(root, "runtime.json");
  const dedicated = path.join(root, "wanx-memobox-runtime.json");
  await writeFile(shared, JSON.stringify({ baseUrl: "http://127.0.0.1:3331", localToken: "old" }));
  assert.equal(resolveMemoryRuntimeFile(env), shared);
  assert.equal(resolveMemoryRuntimeFile(env, undefined, true), dedicated);
  await writeFile(dedicated, JSON.stringify({ baseUrl: "http://127.0.0.1:3332", localToken: "dedicated" }));
  assert.equal(resolveMemoryRuntimeFile(env), dedicated);
  await writeFile(shared, JSON.stringify({ baseUrl: "http://127.0.0.1:3333", localToken: "stale" }));
  assert.equal(resolveMemoryRuntimeFile(env), dedicated);
  assert.equal(resolveMemoryRuntimeFile({ ...env, MEMMY_RUNTIME_CONFIG_PATH: shared }), shared);
});

async function fixture(t, myAiTask, runtime, agentVisibilityStore, reply = () => Response.json({ ok: true }), backup) {
  const assets = await mkdtemp(path.join(tmpdir(), "wanx-memory-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await writeFile(path.join(assets, "wanx-memory.html"), "<!doctype html>");
  const runtimeFile = path.join(assets, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:32113", localToken: "service-token" }));
  let state = { account: { phase: "signed_out" } };
  const requests = [];
  const memory = createMemoryWorkspace({
    assets, runtimeFile, myAiTask, runtime, agentVisibilityStore, getState: () => state,
    backup, client: backup ? { snapshot: () => state, subscribe() { return () => {}; } } : undefined,
    fetchAsset: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    request: async (url, init) => {
      requests.push({ url: url.href, ...init });
      return reply(url, init);
    },
  });
  return {
    memory, runtimeFile, requests,
    setState(value) { state = value; memory.sync(); },
    fetch(route, { token, method = "GET", body } = {}) {
      const headers = token ? { "x-memmy-local-token": token } : {};
      return memory.handle(new Request(MEMORY_ORIGIN + route, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      }));
    },
  };
}

test("My AI list visibility is durable, account-scoped and separate from process and memory actions", async t => {
  let preferences = null;
  const store = {
    async load() { return structuredClone(preferences); },
    async save(value) { preferences = structuredClone(value); },
  };
  const task = async action => {
    assert.equal(action, "status");
    return { agents: [{ id: "codex" }] };
  };
  const first = await fixture(t, task, undefined, store);
  const next = await fixture(t, task, undefined, store);
  const endpoint = action => "/api/wanx-memory/my-ai/" + action;
  first.setState(signedIn("one"));
  const { token } = await first.memory.open();
  const change = (host, scope, action, agent) =>
    host.fetch(endpoint(action), { token: scope, method: "POST", body: { agent } });
  assert.equal((await change(first, "", "hide-agent", "codex")).status, 403);
  assert.deepEqual(await (await change(first, token, "hide-agent", "codex")).json(), { hiddenAgents: ["codex"] });
  assert.equal((await change(first, token, "hide-agent", "../anything")).status, 400);
  next.setState(signedIn("one"));
  const read = async () => {
    const { token: nextToken } = await next.memory.open();
    return { token: nextToken, status: await (await next.fetch(endpoint("status"), { token: nextToken })).json() };
  };
  const original = await read();
  assert.deepEqual(original.status, { agents: [{ id: "codex" }], hiddenAgents: ["codex"] });
  next.setState(signedIn("two"));
  assert.deepEqual((await read()).status.hiddenAgents, []);
  next.setState(signedIn("one"));
  const restored = await read();
  assert.deepEqual(await (await change(next, restored.token, "show-agent", "codex")).json(), { hiddenAgents: [] });
  assert.deepEqual((await read()).status.hiddenAgents, []);
  assert.deepEqual(first.requests, []);
  assert.deepEqual(next.requests, []);
});

test("memory reconnect is only allowed for the current embedded session", async t => {
  let resolveStart;
  let launches = 0;
  const runtime = {
    ensure() { launches++; return new Promise(resolve => { resolveStart = resolve; }); },
  };
  const h = await fixture(t, null, runtime);
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  const route = "/api/wanx-memory/reconnect";
  assert.equal((await h.fetch(route, { method: "POST" })).status, 403);
  assert.equal((await h.fetch(route, { token, body: {}, method: "POST" })).status, 400);
  assert.equal((await h.fetch(route, { token })).status, 403);
  assert.equal(launches, 0);
  const request = h.fetch(route, { token, method: "POST" });
  h.setState(signedIn("two"));
  resolveStart();
  assert.equal((await request).status, 403);
  assert.equal(launches, 1);
  assert.deepEqual(h.requests, []);
});

test("My AI updates both lists only after the memory service confirms disabling sync", async t => {
  let disabled = false;
  let reachable = false;
  const h = await fixture(t, async () => ({ agents: [{ id: "codex" }] }), { waitForStartup() {} }, undefined, (url, init) => {
    assert.equal(init.headers["x-memmy-local-token"], "service-token");
    if (!reachable) return Response.json({}, { status: 503 });
    if (init.method === "GET") {
      assert.equal(url.pathname, "/api/agent-sources/sync-access");
      return Response.json({ disabledSourceIds: disabled ? ["codex"] : [] });
    }
    assert.equal(url.pathname, "/api/agent-sources/codex/sync-access");
    disabled = !JSON.parse(init.body).enabled;
    return Response.json({ sourceId: "codex", syncDisabled: disabled });
  });
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  const base = "/api/wanx-memory/my-ai/";
  const change = action => h.fetch(base + action, { token, method: "POST", body: { agent: "codex" } });
  const read = async () => (await (await h.fetch(base + "status", { token })).json()).hiddenAgents;
  assert.equal((await change("hide-agent")).status, 503);
  assert.deepEqual(await read(), []);
  reachable = true;
  assert.deepEqual(await (await change("hide-agent")).json(), { hiddenAgents: ["codex"] });
  assert.deepEqual(await read(), ["codex"]);
  reachable = false;
  assert.deepEqual(await read(), ["codex"]);
  assert.equal((await change("show-agent")).status, 503);
  assert.deepEqual(await read(), ["codex"]);
  reachable = true;
  assert.deepEqual(await (await change("show-agent")).json(), { hiddenAgents: [] });
  assert.deepEqual(await read(), []);
});

test("My AI reads only the selected Starlink warehouse and explicitly hands off the edited prompt", async t => {
  const modelCalls = [], starlinkCalls = [], opened = [], copied = [];
  let hasCodexDesktop = true;
  let box = "box-one";
  const h = await fixture(t, createMyAiTask({
    protocolRegistered: url => hasCodexDesktop && url === "codex://threads/new",
    findApplication: async () => null,
    commandInstalled: async command => command === "claude",
    openExternal: async url => opened.push(new URL(url)),
    copyText: value => copied.push(value),
    boxScope: () => box,
    starlink: async (action, data) => {
      starlinkCalls.push([action, data]);
      if (action === "warehouses") return { items: [
        { id: "alpha", name: "测试仓库", state: "active" }, { id: "archived", name: "归档仓库", state: "archived" },
      ] };
      if (data.query === "换盒子") box = "box-two";
      return { items: [{ excerpt: "仅属于选择的仓库", document_name: "测试文件" }] };
    },
    polish: async (draft, signal, check) => {
      check();
      modelCalls.push(JSON.parse(draft.split("\n\n").at(-1)));
      return { text: "生成的任务" };
    },
  }));
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  const route = action => `/api/wanx-memory/my-ai/${action}`;
  const post = (action, body) => h.fetch(route(action), { token, method: "POST", body });
  assert.equal((await h.fetch(route("status"))).status, 403);
  assert.equal((await h.fetch(route("optimize"), { token })).status, 403);
  const info = await (await h.fetch(route("status"), { token })).json();
  assert.deepEqual(info.agents.map(({ id, prefill }) => [id, prefill]), [["codex", true], ["claude_code", false]]);
  const draft = "修复界面，仅修改客户端";
  const input = { agent: "codex", draft, warehouseId: null };
  assert.deepEqual(await (await post("optimize", input)).json(), { text: "生成的任务", referenceCount: 0 });
  assert.deepEqual(starlinkCalls, []);
  const { items, warehouseScope } = await (await h.fetch(route("warehouses"), { token })).json();
  assert.deepEqual(items, [{ id: "alpha", name: "测试仓库" }]);
  assert.equal((await post("optimize", { ...input, warehouseId: "archived", warehouseScope })).status, 400);
  assert.deepEqual(await (await post("optimize", { ...input, warehouseId: "alpha", warehouseScope })).json(), { text: "生成的任务", referenceCount: 1 });
  assert.equal((await post("optimize", { ...input, draft: "换盒子", warehouseId: "alpha", warehouseScope })).status, 400);
  assert.equal((await post("optimize", { ...input, warehouseId: "alpha", warehouseScope })).status, 400);
  assert.deepEqual(modelCalls, [
    { target: "Codex 客户端", taskDraft: draft, starlinkExcerpts: [] },
    { target: "Codex 客户端", taskDraft: draft, starlinkExcerpts: [{ title: "测试文件", excerpt: "仅属于选择的仓库" }] },
  ]);
  assert.deepEqual(opened, []);
  assert.deepEqual(copied, []);
  const text = "修改后的任务\n保留 & # + % 和空格";
  assert.deepEqual(await (await post("handoff", { agent: "codex", text })).json(), { opened: true, delivery: "draft" });
  assert.equal(opened[0].protocol, "codex:");
  assert.equal(opened[0].host + opened[0].pathname, "threads/new");
  assert.deepEqual([...opened[0].searchParams], [["prompt", text]]);
  assert.deepEqual(await (await post("handoff", { agent: "codex", text: "长".repeat(900) })).json(), { opened: true, copied: true, delivery: "copy-open", reason: "too-long" });
  hasCodexDesktop = false;
  assert.deepEqual(await (await post("handoff", { agent: "codex", text })).json(), { opened: false, copied: true, delivery: "copy-open", reason: "unavailable" });
  assert.equal(opened.length, 2);
  assert.deepEqual(await (await post("copy", { agent: "codex", text })).json(), { copied: true });
  h.setState(signedIn("two"));
  assert.equal((await post("copy", { agent: "codex", text: "旧账号" })).status, 403);
  assert.deepEqual(copied, ["长".repeat(900), text, text]);
  assert.deepEqual(h.requests, []);
});

test("My AI puts the chosen retrieval instructions into the optimized prompt and authorizes them at delivery", async t => {
  const delivered = [], copied = [], models = [], grants = [];
  let box = "box-one";
  let switchWhileOptimizing = false;
  const selection = { folderId: "folder-one", warehouseId: "warehouse-one" };
  const resolve = ({ folderId, warehouseId }) => ({
    ...(folderId && { folder: { id: folderId, name: "空间案例" } }),
    ...(warehouseId && { warehouse: { id: warehouseId, name: "支持仓库" } }),
  });
  const task = createMyAiTask({
    protocolRegistered: () => true,
    openExternal: url => { delivered.push(new URL(url).searchParams.get("prompt")); },
    copyText: text => { copied.push(text); },
    boxScope: () => box,
    starlink: () => assert.fail("Codex should retrieve its selected sources while executing the task"),
    async polish(text) {
      models.push(JSON.parse(text.split("\n\n").at(-1)));
      if (switchWhileOptimizing) box = "box-two";
      return { text: "梳理用户问题，给出带来源的处理步骤。" };
    },
    codexContext: {
      async describe(selected, check) { check(); return resolve(selected); },
      async prepare(selected, check) {
        check();
        const grant = { revoked: false };
        grants.push(grant);
        return { taskId: "a".repeat(36), resources: resolve(selected), revoke: () => { grant.revoked = true; } };
      },
    },
  });
  const h = await fixture(t, task);
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  const post = (action, body) => h.fetch(`/api/wanx-memory/my-ai/${action}`, { token, method: "POST", body });
  const optimize = codexContext => post("optimize", { agent: "codex", draft: "梳理用户问题", codexContext });
  const { text: spaceOnly } = await (await optimize({ folderId: selection.folderId })).json();
  assert.match(spaceOnly, /空间案例.*space_search.*space_read/u);
  assert.doesNotMatch(spaceOnly, /starlink_|task_id/u);
  const { text: both } = await (await optimize(selection)).json();
  assert.match(both, /支持仓库.*xingtu_search.*xingtu_evidence/u);
  assert.deepEqual(models.at(-1).taskSources, { spaceFolder: "空间案例", starlinkWarehouse: "支持仓库" });
  assert.equal(grants.length, 0);

  assert.deepEqual(await (await post("handoff", { agent: "codex", text: both, codexContext: selection })).json(), { opened: true, delivery: "draft" });
  assert.equal(delivered[0].split("## 资料检索").length, 2);
  assert.match(delivered[0], /MemoBox MCP task_id: a{36}/);
  const edit = { agent: "codex", text: "保留我编辑的任务。", codexContext: { warehouseId: selection.warehouseId } };
  assert.deepEqual(await (await post("copy", edit)).json(), { copied: true });
  assert.match(copied[0], /^保留我编辑的任务。.*xingtu_evidence.*task_id/su);
  assert.doesNotMatch(copied[0], /space_search/u);
  assert.deepEqual(await (await post("handoff", { ...edit, text: "长".repeat(900) })).json(), { opened: true, copied: true, delivery: "copy-open", reason: "too-long" });
  assert.equal(grants.at(-1).revoked, false);
  assert.equal((await post("optimize", { agent: "claude_code", draft: "查资料", codexContext: selection })).status, 400);
  switchWhileOptimizing = true;
  assert.equal((await optimize(selection)).status, 400);
});

test("My AI uses an official download and only launches and manages verified desktop agents", async t => {
  const opened = [];
  let codexInstalled = true;
  const h = await fixture(t, createMyAiTask({
    protocolRegistered: url => codexInstalled && url === "codex://threads/new",
    commandInstalled: async command => command === "claude",
    openExternal: async url => opened.push(url),
    platform: "win32",
  }));
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  const get = action => "/api/wanx-memory/my-ai/" + action;
  const act = (action, agent) => h.fetch(get(action), { token, method: "POST", body: { agent } });
  const { agents, apps } = await (await h.fetch(get("status"), { token })).json();
  assert.deepEqual(agents.map(({ id, launchable, uninstallable }) => [id, launchable, uninstallable]),
    [["codex", true, true], ["claude_code", false, true]]);
  assert.equal(apps.some(app => app.id === "cursor"), false);
  assert.equal(apps.find(app => app.id === "gemini").installed, false);
  assert.equal((await act("download", "https://not-a-vendor.example")).status, 400);
  assert.equal((await act("download", "cursor")).status, 400);
  assert.equal((await act("download", "gemini")).status, 200);
  assert.equal((await act("launch", "claude_code")).status, 400);
  assert.equal((await act("launch", "codex")).status, 200);
  assert.equal((await act("uninstall", "codex")).status, 200);
  codexInstalled = false;
  assert.equal((await act("launch", "codex")).status, 400);
  assert.equal((await act("uninstall", "codex")).status, 200);
  assert.deepEqual(opened, ["https://antigravity.google/docs/cli/tutorial/", "codex://threads/new", "ms-settings:appsfeatures", "https://chatgpt.com/download/"]);
});

test("memory only opens for the current WanX identity and retires stale sessions", async t => {
  const h = await fixture(t);
  assert.deepEqual(await h.memory.open(), { available: false });
  assert.equal((await h.fetch("/wanx-memory.html")).status, 403);
  h.setState(signedIn("one"));
  const first = await h.memory.open();
  assert.equal(first.available, true);
  const page = await h.fetch("/wanx-memory.html");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal((await h.fetch("/runtime.json")).status, 404);
  assert.equal((await h.fetch("/api/app/bootstrap")).status, 403);
  assert.equal((await h.fetch("/api/app/bootstrap", { token: first.token })).status, 200);
  assert.equal(h.requests[0].headers["x-memmy-local-token"], "service-token");
  assert.notEqual(first.token, "service-token");
  h.setState(signedIn("two"));
  const second = await h.memory.open();
  assert.notEqual(first.token, second.token);
  assert.equal((await h.fetch("/api/app/bootstrap", { token: first.token })).status, 403);
  h.setState({ ...signedIn("two"), dataIdentity: { profileId: "local", phase: "locked" } });
  assert.equal((await h.fetch("/api/app/bootstrap", { token: second.token })).status, 403);
});

test("memory settings use scoped endpoints and accept a local service only", async t => {
  const h = await fixture(t);
  h.setState(signedIn("one"));
  const { token } = await h.memory.open();
  const settings = { token, method: "PATCH" };
  assert.equal((await h.fetch("/api/app/settings", { ...settings, body: { memoryByokDailyLimitM: 12 } })).status, 200);
  assert.equal(h.requests[0].body, '{"memoryByokDailyLimitM":12}');
  assert.equal((await h.fetch("/api/app/settings", { ...settings, body: { language: "en" } })).status, 403);
  assert.equal((await h.fetch("/api/account/session", { token })).status, 403);
  assert.equal((await h.fetch("/api/app/settings", { ...settings, body: null })).status, 400);
  await writeFile(h.runtimeFile, JSON.stringify({ baseUrl: "http://192.0.2.5:32113", localToken: "service-token" }));
  assert.equal((await h.fetch("/api/app/bootstrap", { token })).status, 503);
  assert.equal(h.requests.length, 1);
});

test("memory uses the selected WANX box by default and supports a persisted custom override", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-model-"));
  const runtimeFile = path.join(root, "runtime.json");
  const preferenceFile = path.join(root, "model-source");
  const descriptorFile = path.join(root, "wanx-memory-model.json");
  let state = { ...signedIn("one"), phase: "ready", connection: { deviceId: "box-one", gatewayURL: "https://box" } };
  let defaultModel = "wanx-model";
  const catalog = [
    { provider_name: "test", model: "summary", name: "Summary", input: ["text"] },
    { provider_name: "test", model: "evolution", name: "Evolution", input: ["text"] },
    { provider_name: "test", model: "visual-only", input: ["image"] },
  ];
  let supportsRouting = false;
  let hasTextModel = true;
  let hasDefault = true;
  const calls = [];
  const client = {
    snapshot: () => state,
    applicationConnection: async () => ({
      async request(input) {
        calls.push(input);
        if (input.path === "/api/providers/resolved") return { status: 200, body: JSON.stringify(catalog) };
        if (input.path === "/api/providers/active-model")
          return { status: 200, body: JSON.stringify({ provider_name: "test", model: "summary" }) };
        if (input.path !== "/api/wanx/memory-model" && input.path !== "/api/wanx/memory-model/complete")
          return { status: 404 };
        const capabilities = supportsRouting && hasTextModel ? Object.fromEntries(
          ["memory_summary", "memory_evolution"].map(role => [role, {
            defaultRef: hasDefault ? "test/summary" : null, models: catalog.slice(0, 2),
          }])) : {};
        if (supportsRouting) {
          capabilities.asr = { defaultRef: "voice/speech", models: [{ provider_name: "voice", model: "speech", input: ["audio"] }] };
          capabilities.image_generation = { defaultRef: null, models: [{ provider_name: "image", model: "draw" }] };
        }
        return {
          status: input.method === "GET" && !hasTextModel ? 409 : 200,
          body: JSON.stringify(input.method === "GET"
            ? {
              ...(hasTextModel ? hasDefault ? { model: defaultModel, name: defaultModel, provider: "test" }
                : { error: "MEMORY_MODEL_NOT_CONFIGURED" }
                : { detail: "MEMORY_MODEL_NOT_CONFIGURED" }),
              capabilities,
            } : { text: "result" }),
        };
      },
    }),
  };
  await writeFile(path.join(root, "wanx-memory.html"), "<!doctype html>");
  const workspace = createMemoryWorkspace({ assets: root, runtimeFile, preferenceFile, getState: client.snapshot, client });
  t.after(async () => {
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const { token } = await workspace.open();
  async function settings(changes) {
    const response = await workspace.handle(new Request(MEMORY_ORIGIN + "/api/wanx-memory/model-settings", {
      method: changes ? "PUT" : "GET",
      headers: { "x-memmy-local-token": token },
      body: changes && JSON.stringify(changes),
    }));
    assert.equal(response.status, 200);
    return response.json();
  }
  const initial = await settings();
  assert.equal(initial.mode, "wanx");
  assert.equal(initial.roles.memory_summary.effective.model, "wanx-model");
  assert.deepEqual(initial.roles.memory_evolution.models.map(model => model.ref), ["test/summary", "test/evolution"]);
  assert.equal((await settings({ role: "agent", modelRef: "test/summary" })).inventory.agent.selectedRef, "test/summary");
  defaultModel = "new-default";
  assert.equal((await settings()).model, "new-default");
  const descriptor = JSON.parse(await readFile(descriptorFile, "utf8"));
  assert.equal(descriptor.model, "new-default");
  const messages = [{ role: "user", content: "synthetic prompt" }];
  const complete = (key, origin, role) => fetch(`http://127.0.0.1:${descriptor.port}/complete`, {
    method: "POST",
    headers: { authorization: "Bearer " + key, ...(origin && { origin }) },
    body: JSON.stringify({ messages, maxTokens: 256, jsonMode: true, role }),
  });
  assert.equal((await complete(token)).status, 403);
  assert.equal((await complete(descriptor.token, "https://untrusted.example")).status, 403);
  assert.deepEqual(await (await complete(descriptor.token)).json(), { text: "result" });
  assert.equal(calls.at(-1).path, "/api/wanx/memory-model/complete");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { messages, max_tokens: 256, json_mode: true });
  assert.equal((await settings({ role: "memory_evolution", modelRef: "test/evolution" })).roles.memory_evolution.ready, false);
  assert.equal((await complete(descriptor.token, undefined, "memory_evolution")).status, 409);
  supportsRouting = true;
  const updated = await settings();
  assert.equal(updated.roles.memory_evolution.effective.model, "evolution");
  assert.equal(updated.roles.memory_summary.effective.model, "summary");
  assert.equal(updated.inventory.agent.models.length, 2);
  assert.equal(updated.inventory.agent.defaultModel.ref, "test/summary");
  assert.equal(updated.inventory.embedding.reported, false);
  assert.equal(updated.inventory.asr.defaultModel.ref, "voice/speech");
  assert.equal(updated.inventory.image_generation.models[0].ref, "image/draw");
  assert.equal((await settings({ role: "asr", modelRef: "voice/speech" })).inventory.asr.selectedRef, "voice/speech");
  assert.equal((await settings({ role: "image_generation", modelRef: "image/draw" })).inventory.image_generation.selectedRef, "image/draw");
  for (const role of ["agent", "asr", "image_generation"]) {
    const cleared = await settings({ role, modelRef: null });
    assert.equal(cleared.inventory[role].selectedRef, null);
    assert.equal(cleared.roles.memory_summary.effective.model, "summary");
    assert.equal(cleared.roles.memory_evolution.effective.model, "evolution");
  }
  assert.deepEqual(JSON.parse(await readFile(descriptorFile, "utf8")).roles, {
    memory_summary: "summary", memory_evolution: "evolution",
  });
  assert.equal((await complete(descriptor.token, undefined, "memory_evolution")).status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).body), {
    messages, max_tokens: 256, json_mode: true, role: "memory_evolution", model_ref: "test/evolution",
  });

  hasDefault = false;
  assert.equal((await settings()).roles.memory_summary.ready, false);
  const separatelyAssigned = await settings({ role: "memory_summary", modelRef: "test/summary" });
  assert.equal(separatelyAssigned.roles.memory_summary.ready, true);
  assert.equal(separatelyAssigned.roles.memory_evolution.ready, true);
  assert.equal(separatelyAssigned.error, null);

  hasTextModel = false;
  const countBeforeMediaOnly = calls.length;
  const mediaOnly = await settings();
  assert.equal(mediaOnly.error, "MEMORY_MODEL_NOT_CONFIGURED");
  assert.equal(mediaOnly.roles.memory_summary.ready, false);
  assert.equal(mediaOnly.inventory.asr.defaultModel.ref, "voice/speech");
  assert.equal(mediaOnly.inventory.image_generation.models[0].ref, "image/draw");
  assert.ok(!calls.slice(countBeforeMediaOnly).some(call =>
    ["/api/voice/stt/capability", "/api/admin/media-generation"].includes(call.path)));

  state = { ...state, phase: "disconnected", connection: null };
  workspace.sync();
  assert.equal((await complete(descriptor.token)).status, 403);
  assert.equal((await settings()).error, "MEMORY_MODEL_BOX_DISCONNECTED");
  assert.equal(JSON.parse(await readFile(descriptorFile, "utf8")).model, null);
  assert.equal((await settings({ mode: "custom" })).mode, "custom");
  assert.equal(await readFile(preferenceFile, "utf8"), "custom");
  await assert.rejects(readFile(descriptorFile), { code: "ENOENT" });
});

test("box model assignments save from displayed candidates and survive restarting with the old box API", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-save-"));
  const runtimeFile = path.join(root, "runtime.json");
  const preferenceFile = path.join(root, "model-source");
  const summary = "admin-managed-deepseek/deepseek-flash";
  const evolution = "admin-managed-deepseek/deepseek-v4-pro";
  const asr = "voice/openai";
  const image = "images/image-model";
  const catalog = ["deepseek-flash", "deepseek-v4-pro"].map(model => ({ provider_name: "admin-managed-deepseek", model }));
  let state = { ...signedIn("one"), phase: "ready", connection: { deviceId: "old-box", gatewayURL: "https://box" } };
  let failReads = false;
  let requests = 0;
  const client = {
    snapshot: () => state,
    applicationConnection: async () => ({
      async request({ path, method }) {
        requests++;
        assert.equal(method, "GET");
        if (failReads) throw new Error("box transport interrupted");
        if (path === "/api/providers/resolved") return { status: 200, body: JSON.stringify(catalog) };
        if (path === "/api/voice/stt/capability") return { status: 200, body: JSON.stringify({
          available: true, provider_name: "voice", provider_kind: "openai", configuration_id: "opaque",
        }) };
        if (path === "/api/admin/media-generation") {
          const provider = { enabled: true, image_enabled: true, configured: true, image_model: "image-model" };
          return { status: 200, body: JSON.stringify({
            enabled: true, default_image_provider: "images",
            providers: [
              { ...provider, id: "images" },
              { ...provider, id: "video-only", image_enabled: false },
              { ...provider, id: "no-credentials", configured: false },
              { ...provider, id: "disabled", enabled: false },
            ],
          }) };
        }
        return { status: 404 };
      },
    }),
  };
  await writeFile(path.join(root, "wanx-memory.html"), "<!doctype html>");
  const openWorkspace = () => createMemoryWorkspace({ assets: root, runtimeFile, preferenceFile, getState: client.snapshot, client });
  let workspace = openWorkspace();
  t.after(async () => {
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  let { token } = await workspace.open();
  async function settings(changes) {
    const response = await workspace.handle(new Request(MEMORY_ORIGIN + "/api/wanx-memory/model-settings", {
      method: changes ? "PUT" : "GET",
      headers: { "x-memmy-local-token": token },
      body: changes && JSON.stringify(changes),
    }));
    assert.equal(response.status, 200);
    return response.json();
  }
  const initial = await settings();
  assert.equal(initial.error, "MEMORY_MODEL_BOX_UPDATE_REQUIRED");
  assert.deepEqual(initial.roles.memory_summary.models.map(model => model.ref), [summary, evolution]);
  assert.deepEqual(initial.inventory.asr.models, [{ ref: asr, provider: "voice", model: "openai", name: "openai" }]);
  assert.equal(initial.inventory.asr.defaultModel.ref, asr);
  assert.deepEqual(initial.inventory.image_generation.models.map(model => model.ref), [image]);
  assert.equal(initial.inventory.image_generation.defaultModel.ref, image);
  failReads = true;
  const before = requests;
  assert.equal((await settings({ role: "memory_summary", modelRef: summary })).roles.memory_summary.selectedRef, summary);
  assert.equal((await settings({ role: "memory_evolution", modelRef: evolution })).roles.memory_evolution.selectedRef, evolution);
  assert.equal((await settings({ role: "asr", modelRef: asr })).inventory.asr.selectedRef, asr);
  assert.equal((await settings({ role: "image_generation", modelRef: image })).inventory.image_generation.selectedRef, image);
  assert.equal(requests, before);

  await workspace.close();
  workspace = openWorkspace();
  ({ token } = await workspace.open());
  const restored = await settings();
  assert.equal(restored.roles.memory_summary.selectedRef, summary);
  assert.equal(restored.roles.memory_evolution.selectedRef, evolution);
  assert.equal(restored.roles.memory_summary.ready, false);
  assert.equal(restored.roles.memory_evolution.ready, false);
  assert.equal(restored.inventory.asr.selectedRef, asr);
  assert.equal(restored.inventory.image_generation.selectedRef, image);

  state = { ...state, connection: { deviceId: "other-box", gatewayURL: "https://box-two" } };
  workspace.sync();
  const other = await settings();
  assert.equal(other.roles.memory_summary.selectedRef, null);
  assert.equal(other.roles.memory_evolution.selectedRef, null);
  assert.equal(other.inventory.asr.selectedRef, null);
  assert.equal(other.inventory.image_generation.selectedRef, null);
});

test("automatic backup preference is authenticated, account-scoped and writable while offline", async t => {
  let saved;
  const f = await fixture(t, undefined, undefined, undefined, undefined, {
    space: { snapshot: () => ({}) }, stagingRoot: tmpdir(), protect: async () => {},
    store: { async load() { return saved; }, async save(value) { saved = value; } },
  });
  t.after(() => f.memory.close());
  const route = "/api/wanx-memory/backup";
  assert.equal((await f.fetch(route)).status, 403);
  f.setState(signedIn("first"));
  const { token } = await f.memory.open();
  const state = await (await f.fetch(route, { token })).json();
  assert.equal(state.enabled, true);
  assert.equal(state.connected, false);
  assert.equal((await f.fetch(route, { token, method: "POST", body: { action: "disable", context: state.context } })).status, 200);
  assert.equal((await (await f.fetch(route, { token })).json()).enabled, false);
  assert.equal((await f.fetch(route, { token, method: "POST", body: { action: "browse", parent: "" } })).status, 400);
  f.setState(signedIn("second"));
  assert.equal((await f.fetch(route, { token })).status, 403);
  const next = await f.memory.open();
  assert.equal((await (await f.fetch(route, { token: next.token })).json()).enabled, true);
});
