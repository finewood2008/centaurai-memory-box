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
import { nativeCatalog, nativeResult, warehouseA, warehouseB } from "./fixtures/semantica-mcp.mjs";

test("an unavailable saved warehouse remains editable while new selections still require validation", async () => {
  const warehouseId = "a1c4c496-d58b-4b3c-b6d3-1b3d25c20110";
  let available = true;
  let saved;
  const access = createMyAiAccess({
    agents: ["codex"], owner: () => "owner-a", box: () => "box-a", scope: () => "scope-a",
    store: { load: async () => saved, save: async value => { saved = structuredClone(value); } },
    sources: { async validate(_folder, warehouse, check) {
      check();
      if (!available) throw Object.assign(new Error("无法访问所选星图仓库。"), { status: 403 });
      return { warehouseId: warehouse, warehouseName: "工程资料" };
    } },
    makeContext: () => ({ invalidate() {} }),
  });
  const selected = { warehouseId, memoryEnabled: true, memoryAgent: "codex" };
  await access.selection("codex", selected);
  available = false;
  assert.deepEqual(await access.selection("codex"), {
    selection: selected, resources: {}, warning: "无法访问所选星图仓库。",
  });
  await assert.rejects(access.selection("codex", selected), /无法访问所选星图仓库/);
  assert.deepEqual((await access.selection("codex", { memoryEnabled: true, memoryAgent: "codex" })).selection,
    { memoryEnabled: true, memoryAgent: "codex" });
});

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
  const photoId = "4".repeat(32);
  const otherId = "5".repeat(32);
  const otherPhotoId = "6".repeat(32);
  const photoBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf/sAAAAASUVORK5CYII=", "base64");
  const project = { id: projectId, kind: "folder", name: "Project", parent: "" };
  const file = { id: fileId, kind: "file", name: "Project.txt", parent: projectId, size: 12, version: 1 };
  const photo = { id: photoId, kind: "file", name: "Photo.png", parent: projectId, size: photoBytes.length, version: 2 };
  const other = { id: otherId, kind: "folder", name: "Other", parent: "" };
  const backup = { id: reserved, kind: "folder", name: "半人马AI记忆备份", parent: "" };
  const sources = createCodexContextSources({
    starlinkMcp: {
      discover: async () => nativeCatalog(),
      async call(id, name, args, check) {
        check(); assert.equal(id, warehouse);
        assert.equal(args.warehouseId, undefined); assert.equal(args.task_id, undefined);
        if (name === "xingtu_warehouse") return nativeResult({ id });
        if (name === "xingtu_search") return nativeResult({
          items: [{ id: "evidence_1" }],
          graph: { paths: [{ hops: 2, steps: [{ evidence_ids: ["evidence_1"] }, { evidence_ids: ["evidence_2"] }] }] },
        });
        assert.equal(args.evidence_id, "evidence_2");
        return nativeResult({ id: args.evidence_id, excerpt: "Project evidence.", sensitive_status: "clean" });
      },
    },
    nativeImage: { createFromBuffer(bytes) {
      assert.deepEqual(bytes, photoBytes);
      return { isEmpty: () => false, getSize: () => ({ width: 7952, height: 5304 }), resize(options) {
        assert.deepEqual(options, { width: 1280 });
        return { toPNG: () => photoBytes };
      } };
    } },
    space: {
      async operation(method, { parent, id }) {
        if (method === "stat") return id === fileId ? file : id === projectId ? project : null;
        const folders = { [projectId]: project, [otherId]: other, [reserved]: backup };
        const files = { [projectId]: [file, photo], [otherId]: [{ ...photo, id: otherPhotoId, parent: otherId }] };
        return { parent, root: "", space_id: "personal", breadcrumbs: parent ? [folders[parent]] : [], items: parent ? files[parent] ?? [] : [project, backup, other] };
      },
      async preview(id, options) {
        assert.deepEqual(options, { interactive: false });
        if (id === photoId) return { type: "image/png", name: photo.name, data: photoBytes.toString("base64") };
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
  let context;
  const make = () => createMyAiAccess({
    agents: ["claude_code"], sources, memory, owner: () => owner, box: () => box, scope,
    store: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
    makeContext: (_agent, direct) => (context = createCodexContext({ sources, configure: config, scope, descriptor, direct })),
  });
  const check = () => {};
  let access = make();
  t.after(() => access.close());
  await access.selection("claude_code", { folderId: projectId, warehouseId: warehouse, memoryEnabled: true }, check);
  assert.equal((await access.connect("claude_code", check)).configurationChanged, true);
  assert.equal((await access.connect("claude_code", check)).configurationChanged, undefined);
  assert.equal((await access.status(check)).claude_code.available, false);
  assert.equal((await access.status(check)).claude_code.configurationChanged, undefined);
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
  assert.equal(listed.result.tools.length, 10);
  assert.ok(listed.result.tools.every(tool => !tool.name.startsWith("starlink_")));
  assert.ok(listed.result.tools.every(tool => tool.annotations.readOnlyHint === (tool.name !== "memory_save")));
  const memories = await call("memory_search", { query: "Project" });
  assert.equal((await call("memory_read", { memoryId: memories.matches[0].memoryId })).body, "Project memory.");
  assert.deepEqual((await call("space_list")).items.map(item => item.id), [projectId]);
  const space = await call("space_search", { query: "Project" });
  assert.equal((await call("space_read", { fileId: space.matches[0].fileId })).text, "Project text");
  const found = await call("space_search", { query: "Photo.png" });
  const photoReply = await rpc("tools/call", { name: "space_read", arguments: { fileId: found.matches[0].fileId } });
  assert.deepEqual(JSON.parse(photoReply.result.content[0].text), {
    fileId: photoId, name: "Photo.png", path: "Photo.png", version: 2, nextStart: null,
  });
  assert.deepEqual(photoReply.result.content[1], { type: "image", mimeType: "image/png", data: photoBytes.toString("base64") });
  await call("space_read", { fileId: otherPhotoId }, true);
  await call("space_read", { fileId: photoId, start: 1 }, true);
  await call("space_read", { fileId: photoId });
  assert.equal((await call("xingtu_warehouse")).id, warehouse);
  const starlink = await call("xingtu_search", { warehouseId: warehouse, query: "Project" });
  const [graphPath] = starlink.graph.paths;
  assert.equal(graphPath.hops, 2);
  const [evidenceId] = graphPath.steps[1].evidence_ids;
  assert.equal((await call("xingtu_evidence", { warehouseId: warehouse, evidence_id: evidenceId })).excerpt, "Project evidence.");
  assert.equal((await access.status(check)).claude_code.available, true);
  await call("space_list", { folderId: reserved }, true);
  assert.equal((await access.status(check)).claude_code.available, false);
  await call("memory_search", { query: "Project", task_id: "a".repeat(36) }, true);
  const grant = await context.prepare({ folderId: projectId }, check);
  await call("space_read", { fileId: photoId }, true);
  await call("space_read", { fileId: otherPhotoId, task_id: grant.taskId }, true);
  const scopedPhoto = await rpc("tools/call", { name: "space_read", arguments: { fileId: photoId, task_id: grant.taskId } });
  assert.deepEqual(scopedPhoto.result, photoReply.result);
  grant.revoke();
  await call("space_read", { fileId: photoId, task_id: grant.taskId }, true);
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

test("one Codex confirmation persists a read-only scope without widening task grants", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-codex-read-only-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const descriptor = path.join(home, "endpoint.json");
  let box = "Box 79", saved, context;
  const scope = () => box;
  const folder = "1".repeat(32), photo = "2".repeat(32);
  const connectionId = "3".repeat(32), grantId = "4".repeat(32), operationId = "5".repeat(32);
  let writeGranted = false;
  const sources = {
    mcpTools: async () => nativeCatalog([{ id: warehouseA }, { id: warehouseB }]),
    async catalog(id) { return { folders: [], ...(id === folder && { folder: { id, name: "Results" } }) }; },
    async validate(folderId) { return { folderId, folderName: "Task folder" }; },
    async call() { throw new Error("The test photo is outside the task folder."); },
    async direct(name, args, check) {
      check();
      if (name === "space_list") return { items: [{ id: photo }] };
      if (name === "space_read" && args.fileId === photo) return { image: { mimeType: "image/png", data: "iVBORw0KGgo=" } };
      if (name === "xingtu_warehouse" && [warehouseA, warehouseB].includes(args.warehouseId)) return nativeResult({ id: args.warehouseId });
      throw new Error("Unexpected direct tool");
    },
  };
  const make = () => createMyAiAccess({
    agents: ["codex"], sources, scope, owner: () => "Alice", box: scope,
    spaceLinks: {
      async manage(action, input) {
        if (action === "mcp-issue") { assert.equal(input.internal, true); return { id: connectionId }; }
        if (action === "mcp-grant") {
          assert.deepEqual(input, { id: connectionId, root: folder, domain: "personal", purpose: "output" });
          writeGranted = true;
          return { id: grantId };
        }
        assert.equal(action, "mcp-revoke");
        assert.equal(input.id, connectionId);
        writeGranted = false;
      },
      async output(grant, name, args) {
        assert.equal(grant.grantId, grantId);
        assert.equal(name, "space_write_text");
        if (!writeGranted || args.target !== folder) throw new Error("SPACE_LINK_SCOPE");
        return { state: "complete", version: 1 };
      },
    },
    memory: { async ready() {}, async call(name, _args, check, _agent, _binding, memoryAgent) {
      check();
      assert.equal(name, "memory_search");
      assert.equal(memoryAgent, null);
      return { matches: [] };
    } },
    store: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
    makeContext: (_agent, direct) => (context = createCodexContext({ sources, scope, descriptor, direct, configure: {
      async ensure() {}, async isConfigured() { return true; },
    } })),
  });
  let access = make();
  t.after(() => access.close());
  const check = () => {};
  let rpcId = 0;
  async function rpc(method, params) {
    const { port, token } = JSON.parse(await readFile(descriptor, "utf8"));
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    return (await response.json()).result;
  }
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  await access.connect("codex", check, { allPersonalReadOnly: true });
  await access.selection("codex", { folderId: folder, memoryEnabled: false }, check);
  assert.equal((await access.status(check)).codex.allPersonalReadOnly, true);
  assert.ok((await rpc("tools/list")).tools.every(tool => tool.annotations.readOnlyHint));
  assert.ok((await call("memory_save", { content: "Forbidden write" })).isError);
  assert.ok(!(await call("memory_search", { query: "Query" })).isError);
  const routing = (await rpc("tools/list")).tools.find(tool => tool.name === "xingtu_warehouse").inputSchema.properties.warehouseId;
  assert.deepEqual(routing.enum, [warehouseA, warehouseB]);
  assert.equal(JSON.parse((await call("xingtu_warehouse", { warehouseId: warehouseB })).content[0].text).id, warehouseB);
  assert.equal((await call("space_read", { fileId: photo })).content[1].type, "image");
  const output = { name: "result.md", text: "Result", operation_id: operationId };
  assert.ok((await call("space_write_text", output)).isError);
  const approved = await access.outputFolder("codex", folder, check);
  assert.deepEqual(approved.outputFolder, { id: folder, name: "Results" });
  assert.ok((await rpc("tools/list")).tools.some(tool => tool.name === "space_write_text"));
  assert.equal(JSON.parse((await call("space_write_text", output)).content[0].text).state, "complete");
  assert.ok((await call("space_write_text", { ...output, target: photo })).isError);
  assert.ok((await call("space_write_text", { operation_id: operationId, text: "Result", target: photo })).isError);
  assert.ok((await call("space_output_upload", { action: "trash", upload_id: operationId })).isError);
  assert.ok((await call("memory_save", { content: "Forbidden write" })).isError);
  const task = await context.prepare({ folderId: folder }, check);
  assert.ok((await call("space_read", { fileId: photo, task_id: task.taskId })).isError);
  assert.ok((await call("space_read", { fileId: photo })).isError);
  task.revoke();
  box = "Another box";
  assert.ok((await call("space_read", { fileId: photo })).isError);
  box = "Box 79";
  await access.close();
  access = make();
  await access.restore(error => { throw error; });
  assert.equal((await call("space_read", { fileId: photo })).content[1].type, "image");
  assert.equal((await access.status(check)).codex.outputFolder.id, folder);
  await access.outputFolder("codex", null, check);
  assert.equal(writeGranted, false);
  assert.ok((await call("space_write_text", output)).isError);
  assert.equal((await call("space_read", { fileId: photo })).content[1].type, "image");
  await access.disconnect("codex", check);
  await assert.rejects(readFile(descriptor), { code: "ENOENT" });
  await access.close();
  access = make();
  await access.restore(error => { throw error; });
  const revoked = (await access.status(check)).codex;
  assert.equal(revoked.allPersonalReadOnly, false);
  assert.equal(revoked.revokedAccess, "all-personal-read-only");
  await assert.rejects(readFile(descriptor), { code: "ENOENT" });
  await access.connect("codex", check);
  assert.ok((await call("space_read", { fileId: photo })).isError);
  const reconnected = await access.connect("codex", check, { allPersonalReadOnly: true });
  assert.equal(reconnected.revokedAccess, undefined);
  assert.equal((await call("space_read", { fileId: photo })).content[1].type, "image");
  assert.ok((await call("space_write_text", output)).isError);
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
