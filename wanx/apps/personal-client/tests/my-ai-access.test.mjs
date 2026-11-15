import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMyAiAccess, createMyAiMemoryAccess } from "../shell/my-ai-access.mjs";
import { createMyAiMcpConfig } from "../shell/my-ai-mcp-config.mjs";
import { createCodexContext } from "../shell/codex-context.mjs";
import { createCodexContextSources } from "../shell/codex-context-sources.mjs";

test("one Agent connection registers all three sources and revokes them across scope changes", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-access-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const stdioPath = fileURLToPath(new URL("../shell/codex-context-stdio.mjs", import.meta.url));
  const runtimeFile = path.join(home, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:19535", localToken: "memory-token" }));
  const warehouse = "a1c4c496-d58b-4b3c-b6d3-1b3d25c20110";
  const fileId = "1".repeat(32);
  const reserved = "2".repeat(32);
  const projectId = "3".repeat(32);
  const project = { id: projectId, kind: "folder", name: "Project", parent: "" };
  const file = { id: fileId, kind: "file", name: "Project.txt", parent: projectId, size: 12, version: 1 };
  const backup = { id: reserved, kind: "folder", name: "半人马AI记忆备份", parent: "" };
  const sources = createCodexContextSources({
    space: {
      async operation(method, { parent, id }) {
        if (method === "stat") return id === fileId ? file : id === projectId ? project : null;
        return { parent, root: "", space_id: "personal", breadcrumbs: parent === projectId ? [project] : parent ? [backup] : [], items: parent === projectId ? [file] : parent ? [] : [project, backup] };
      },
      async preview(id) {
        assert.equal(id, fileId);
        return { type: "text/plain", name: file.name, data: Buffer.from("Project text").toString("base64") };
      },
    },
    async starlink(action, input) {
      if (action === "warehouses") return { items: [{ id: warehouse, name: "Projects", state: "active" }] };
      assert.equal(input.warehouseId, warehouse);
      const evidence = { id: "evidence_1", warehouse_id: warehouse, text: "Project evidence." };
      return action === "search" ? { items: [evidence] } : evidence;
    },
  });
  const memory = createMyAiMemoryAccess({
    runtimeFile,
    async request(url, options) {
      assert.equal(url.origin, "http://127.0.0.1:19535");
      assert.equal(options.headers["x-memmy-local-token"], "memory-token");
      if (url.pathname === "/api/v1/health") return Response.json({ ok: true, storage: { ready: true } });
      if (url.pathname.endsWith("/search")) {
        assert.equal(JSON.parse(options.body).source, "claude_code");
        return Response.json({ debug: { hits: [{ id: "memory_1", title: "Project" }] } });
      }
      assert.equal(url.pathname, "/api/v1/memory/memory_1");
      return Response.json({ item: { id: "memory_1", body: "Project memory." } });
    },
  });
  let owner = "Alice", box = "Box A", session = "first session", saved;
  const scope = () => session && JSON.stringify([owner, box, session]);
  const descriptor = path.join(home, "endpoint.json");
  const config = createMyAiMcpConfig("claude_code", { home, env: {}, stdioPath, descriptorPath: descriptor });
  const configFile = path.join(home, ".claude.json");
  await writeFile(configFile, '{"mcpServers":{"existing":{"command":"already-configured"}}}\n');
  const make = () => createMyAiAccess({
    agents: ["claude_code"], sources, memory, owner: () => owner, box: () => box, scope,
    store: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
    makeContext: (_agent, direct) => createCodexContext({ sources, configure: config, scope, descriptor, direct }),
  });
  const check = () => {};
  let access = make();
  t.after(() => access.close());
  await access.selection("claude_code", { folderId: projectId, warehouseId: warehouse, memoryEnabled: true }, check);
  await access.connect("claude_code", check);
  assert.equal((await access.status(check)).claude_code.available, false);
  const profile = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(profile.mcpServers.existing.command, "already-configured");
  assert.equal(profile.mcpServers["wanx-memobox"].type, "stdio");
  const bridge = profile.mcpServers["wanx-memobox"];

  async function rpc(method, params) {
    const result = await new Promise((resolve, reject) => {
      const child = execFile(bridge.command, bridge.args, { env: { ...process.env, ...bridge.env } }, (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout.trim()));
      });
      child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    return result;
  }
  async function call(name, args = {}, denied = false) {
    const reply = await rpc("tools/call", { name, arguments: args });
    assert.equal(Boolean(reply.result?.isError), denied);
    if (!denied) return JSON.parse(reply.result.content[0].text);
  }

  const listed = await rpc("tools/list");
  assert.equal(listed.result.tools.length, 9);
  assert.ok(listed.result.tools.every(tool => tool.annotations.readOnlyHint === (tool.name !== "memory_save")));
  const memories = await call("memory_search", { query: "Project" });
  assert.equal((await call("memory_read", { memoryId: memories.matches[0].memoryId })).body, "Project memory.");
  assert.deepEqual((await call("space_list")).items.map(item => item.id), [projectId]);
  const space = await call("space_search", { query: "Project" });
  assert.equal((await call("space_read", { fileId: space.matches[0].fileId })).text, "Project text");
  assert.equal((await call("starlink_warehouses")).warehouses[0].id, warehouse);
  const starlink = await call("starlink_search", { warehouseId: warehouse, query: "Project" });
  assert.equal((await call("starlink_evidence", { warehouseId: warehouse, evidenceId: starlink.matches[0].evidenceId })).text, "Project evidence.");
  assert.equal((await access.status(check)).claude_code.available, true);
  await call("space_list", { folderId: reserved }, true);
  assert.equal((await access.status(check)).claude_code.available, false);
  await call("memory_search", { query: "Project", task_id: "a".repeat(36) }, true);
  owner = "Bob";
  access.sync();
  await call("space_list", {}, true);
  owner = "Alice";
  box = "Box B";
  access.sync();
  await call("space_list", {}, true);
  box = "Box A";
  session = "";
  access.sync();
  await call("space_list", {}, true);
  session = "new session";
  await access.close();
  access = make();
  await access.restore(error => { throw error; });
  assert.equal((await access.status(check)).claude_code.available, false);
  assert.equal((await call("space_list")).items.length, 1);
  await access.disconnect("claude_code", check);
  assert.equal((await access.status(check)).claude_code.connected, false);
  assert.equal((await rpc("tools/list")).error.code, -32000);
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).mcpServers, { existing: { command: "already-configured" } });
});

test("editable Agent configurations preserve comments and refuse unrelated entries with the same name", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-config-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const options = { home, env: {}, stdioPath: path.join(home, "stdio.mjs"), descriptorPath: path.join(home, "endpoint.json") };
  const opencode = path.join(home, ".config", "opencode", "opencode.jsonc");
  await mkdir(path.dirname(opencode), { recursive: true });
  await writeFile(opencode, '{\n  // keep this note\n  "mcp": {"servers": {"existing": {"type": "local", "command": ["existing"]}}},\n}\n');
  const config = createMyAiMcpConfig("opencode", options);
  await config.ensure();
  assert.match(await readFile(opencode, "utf8"), /keep this note/);
  assert.equal(await config.isConfigured(), true);
  const updated = (await readFile(opencode, "utf8")).replace("ELECTRON_RUN_AS_NODE", "REPLACED");
  await writeFile(opencode, updated);
  await assert.rejects(config.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  await config.remove();
  assert.equal(await readFile(opencode, "utf8"), updated);
  for (const agent of ["hermes", "cursor", "pi", "openclaw"]) {
    const adapter = createMyAiMcpConfig(agent, options);
    await adapter.ensure();
    assert.equal(await adapter.isConfigured(), true);
    await adapter.remove();
    assert.equal(await adapter.isConfigured(), false);
  }
  for (const agent of ["workbuddy", "qwenwork"]) {
    const adapter = createMyAiMcpConfig(agent, options);
    await adapter.ensure();
    assert.equal(await adapter.isConfigured(), false);
    assert.equal(adapter.guided, true);
    assert.deepEqual(adapter.configuration().mcpServers["wanx-memobox"].args, [options.stdioPath, options.descriptorPath]);
  }
  const deepseekFile = path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
  await mkdir(path.dirname(deepseekFile), { recursive: true });
  await writeFile(deepseekFile, "# keep this patch\n- insert:\n    - id: existing\n      name: something\n");
  const deepseek = createMyAiMcpConfig("deepseek_harness", options);
  await deepseek.ensure();
  const deepseekConfig = await readFile(deepseekFile, "utf8");
  assert.match(deepseekConfig, /name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.match(deepseekConfig, /^# keep this patch/);
  assert.equal(await deepseek.isConfigured(), true);
  await deepseek.remove();
  assert.equal(await deepseek.isConfigured(), false);
  assert.match(await readFile(deepseekFile, "utf8"), /id: existing/);
});
