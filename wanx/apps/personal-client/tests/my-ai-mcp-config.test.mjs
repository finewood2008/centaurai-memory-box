import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { configurableAgents, createMyAiMcpConfig } from "../shell/my-ai-mcp-config.mjs";

async function fixture(t, env = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-mcp-adapter-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env, platform:'darwin', executable: process.execPath, stdioPath: path.join(home, "stdio.mjs"), descriptorPath: path.join(home, "endpoint.json") };
}

test("the managed catalog advertises only first-release contexts", () => {
  assert.deepEqual(configurableAgents, ["claude_code", "claude_desktop", "gemini", "workbuddy", "qwenwork", "deepseek_harness"]);
});

test("Gemini merges an MCP entry without changing settings, comments, or tool approval", async t => {
  const options = await fixture(t);
  const file = path.join(options.home, ".gemini", "settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{\r\n  // personal settings\r\n  "theme": "Dark",\r\n  "mcpServers": {"other": {"command": "existing"}},\r\n}\r\n');
  const adapter = createMyAiMcpConfig("gemini", options);
  assert.equal(adapter.guided, false);
  assert.deepEqual(await adapter.ensure(), { configurationChanged: true });
  assert.equal(await adapter.isConfigured(), true);
  assert.deepEqual(await adapter.ensure(), { configurationChanged: false });
  const updated = await readFile(file, "utf8");
  assert.match(updated, /\/\/ personal settings\r\n/);
  assert.match(updated, /"theme": "Dark"/);
  assert.match(updated, /"other":\s*\{\s*"command": "existing"\s*\}/);
  assert.ok(!updated.includes('"trust"'));
  await adapter.remove();
  const removed = await readFile(file, "utf8");
  assert.equal(await adapter.isConfigured(), false);
  assert.match(removed, /personal settings/);
  assert.match(removed, /existing/);
});

test("Gemini repairs the retired macOS development bridge without overwriting active or foreign connections", async t => {
  const options = await fixture(t);
  options.descriptorPath = path.join(options.home, "profile", "my-ai-access", "gemini", "endpoint.json");
  const file = path.join(options.home, ".gemini", "settings.json");
  const bundle = path.join(options.home, "Applications", "半人马AI记忆盒子 开发版.app");
  const checkout = path.join(options.home, "old", "apps", "personal-client");
  const endpoint = path.join(checkout, ".local", "installed-space-annotations", "my-ai-access", "gemini", "endpoint.json");
  const old = {
    command: path.join(bundle, "Contents", "MacOS", "Electron"),
    args: [path.join(checkout, "shell", "codex-context-stdio.mjs"), endpoint],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const other = { command: "keep" };
  const config = bridge => JSON.stringify({ theme: "Dark", mcpServers: { other, "wanx-memobox": bridge } }) + "\n";
  const adapter = createMyAiMcpConfig("gemini", { ...options, stableLauncher: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, config(old));

  await mkdir(bundle, { recursive: true });
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  assert.equal(await readFile(file, "utf8"), config(old));
  await rm(bundle, { recursive: true });

  await mkdir(path.dirname(endpoint), { recursive: true });
  await writeFile(endpoint, "{}");
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  assert.equal(await readFile(file, "utf8"), config(old));
  await rm(endpoint);

  for (const bridge of [
    { ...old, args: [old.args[0], options.descriptorPath] },
    { ...old, httpUrl: "https://example.test/mcp" },
    { ...old, env: { ...old.env, USER_OVERRIDE: "1" } },
  ]) {
    await writeFile(file, config(bridge));
    await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
    assert.equal(await readFile(file, "utf8"), config(bridge));
  }

  await writeFile(file, config(old));
  await adapter.ensure();
  assert.equal(await adapter.isConfigured(), true);
  const registered = await readFile(file, "utf8");
  assert.deepEqual(JSON.parse(registered), { theme: "Dark", mcpServers: { other, ...adapter.configuration().mcpServers } });
  assert.equal(adapter.configuration().mcpServers["wanx-memobox"].command, "/bin/sh");

  const moved = createMyAiMcpConfig("gemini", { ...options, stableLauncher: true, stdioPath: path.join(options.home, "new", "stdio.mjs") });
  assert.equal(await moved.isConfigured(), false);
  assert.equal(await moved.restore(() => {}), true);
  assert.equal(await moved.isConfigured(), true);
  assert.equal(await readFile(file, "utf8"), registered);
});

test("Claude Desktop and Claude Code use separate configurations", async t => {
  const options = await fixture(t);
  const desktopFile = path.join(options.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const cliFile = path.join(options.home, ".claude.json");
  await writeFile(cliFile, '{"account":"untouched"}\n');
  const desktop = createMyAiMcpConfig("claude_desktop", options);
  await desktop.ensure();
  const desktopEntry = JSON.parse(await readFile(desktopFile, "utf8")).mcpServers["wanx-memobox"];
  assert.equal(desktopEntry.command, process.execPath);
  assert.deepEqual(desktopEntry.args, [options.stdioPath, options.descriptorPath]);
  assert.equal(await readFile(cliFile, "utf8"), '{"account":"untouched"}\n');
  const cli = createMyAiMcpConfig("claude_code", options);
  await cli.ensure();
  assert.equal(JSON.parse(await readFile(cliFile, "utf8")).mcpServers["wanx-memobox"].type, "stdio");
  await desktop.remove();
  assert.equal(await desktop.isConfigured(), false);
  assert.equal(await cli.isConfigured(), true);
  const configuredDirectory = path.join(options.home, "claude-custom");
  const custom = createMyAiMcpConfig("claude_code", { ...options, env: { CLAUDE_CONFIG_DIR: configuredDirectory } });
  await custom.ensure();
  assert.equal(JSON.parse(await readFile(path.join(configuredDirectory, ".claude.json"), "utf8")).mcpServers["wanx-memobox"].type, "stdio");
});

test("macOS Claude Desktop repairs a moved MemoBox bridge and keeps a stable launcher", async t => {
  const options = await fixture(t);
  options.descriptorPath = path.join(options.home, "my-ai-access", "claude_desktop", "endpoint.json");
  const file = path.join(options.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const bundle = path.join(options.home, "old", "半人马AI记忆盒子.app");
  const legacy = {
    command: path.join(bundle, "Contents", "MacOS", "半人马AI记忆盒子"),
    args: [path.join(bundle, "Contents", "Resources", "app.asar", "shell", "codex-context-stdio.mjs"), options.descriptorPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const other = { command: "keep" };
  const config = bridge => JSON.stringify({ theme: "dark", mcpServers: { other, "wanx-memobox": bridge } }) + "\n";
  const adapter = createMyAiMcpConfig("claude_desktop", { ...options, stableLauncher: true });
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(file, config(legacy));
  assert.equal(await adapter.restore(() => {}), false);
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  await rm(bundle, { recursive: true });

  const foreign = config({ ...legacy, args: [legacy.args[0], path.join(options.home, "foreign", "endpoint.json")] });
  await writeFile(file, foreign);
  assert.equal(await adapter.restore(() => {}), false);
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  assert.equal(await readFile(file, "utf8"), foreign);

  await writeFile(file, config(legacy));
  await adapter.ensure();
  const registered = await readFile(file, "utf8");
  const launcher = path.join(path.dirname(options.descriptorPath), "stdio-launcher.sh");
  assert.deepEqual(JSON.parse(registered), {
    theme: "dark", mcpServers: { other, "wanx-memobox": { command: "/bin/sh", args: [launcher] } },
  });
  assert.equal(await adapter.isConfigured(), true);

  const nextStdio = path.join(options.home, "next", "stdio.mjs");
  const moved = createMyAiMcpConfig("claude_desktop", { ...options, stdioPath: nextStdio, stableLauncher: true });
  assert.equal(await moved.isConfigured(), false);
  assert.equal(await moved.restore(() => {}), true);
  assert.equal(await moved.isConfigured(), true);
  assert.equal(await readFile(file, "utf8"), registered);
  assert.ok((await readFile(launcher, "utf8")).includes(nextStdio));

  await writeFile(file, config(legacy));
  assert.equal(await moved.restore(() => {}), true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), JSON.parse(registered));
});

test("Claude Code restores a bridge from a moved MemoBox app for the same endpoint", async t => {
  const options = await fixture(t);
  const file = path.join(options.home, ".claude.json");
  const bundle = path.join(options.home, "记忆盒子 1.5.2 合并版.app");
  const oldBridge = {
    type: "stdio",
    command: path.join(bundle, "Contents", "MacOS", "半人马AI记忆盒子"),
    args: [path.join(bundle, "Contents", "Resources", "app.asar", "shell", "codex-context-stdio.mjs"), options.descriptorPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const other = { command: "keep" };
  const adapter = createMyAiMcpConfig("claude_code", { ...options, stableLauncher: true });
  const config = bridge => JSON.stringify({ account: "untouched", mcpServers: { other, "wanx-memobox": bridge } }) + "\n";

  await mkdir(bundle);
  const conflicting = config(oldBridge);
  await writeFile(file, conflicting);
  assert.equal(await adapter.restore(() => {}), false);
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  assert.equal(await readFile(file, "utf8"), conflicting);
  await rm(bundle, { recursive: true });

  const foreignEntries = [
    { ...oldBridge, args: [oldBridge.args[0], path.join(options.home, "different-endpoint.json")] },
    { ...oldBridge, args: [path.join(bundle, "custom-bridge.mjs"), options.descriptorPath] },
    { ...oldBridge, env: { ...oldBridge.env, USER_OVERRIDE: "1" } },
  ];
  for (const bridge of foreignEntries) {
    const foreign = config(bridge);
    await writeFile(file, foreign);
    assert.equal(await adapter.restore(() => {}), false);
    await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
    assert.equal(await readFile(file, "utf8"), foreign);
  }

  await writeFile(file, conflicting);
  assert.equal(await adapter.isConfigured(), false);
  assert.equal(await adapter.restore(() => {}), true);
  assert.equal(await adapter.isConfigured(), true);
  const updated = await readFile(file, "utf8");
  assert.deepEqual(JSON.parse(updated), {
    account: "untouched", mcpServers: {
      other, "wanx-memobox": { type: "stdio", ...adapter.configuration().mcpServers["wanx-memobox"] },
    },
  });
  await adapter.ensure();
  assert.equal(await readFile(file, "utf8"), updated);
});

test("Claude Code keeps its launcher registration when a packaged app moves", { skip: process.platform === "win32" }, async t => {
  const options = await fixture(t);
  options.stdioPath = path.join(options.home, "旧版 '测试'.mjs");
  const nextStdio = path.join(options.home, "新版 '测试'.mjs");
  const file = path.join(options.home, ".claude.json");
  const shell = promisify(execFile);
  const fakeStdio = `console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, process.argv[2], import.meta.filename]));\n`;
  await writeFile(options.stdioPath, fakeStdio);
  await writeFile(nextStdio, fakeStdio);
  const legacy = createMyAiMcpConfig("claude_code", options);
  await legacy.ensure();
  const adapter = createMyAiMcpConfig("claude_code", { ...options, stableLauncher: true });
  assert.equal(await adapter.restore(() => {}), true);
  const registered = await readFile(file, "utf8");
  const { command, args } = JSON.parse(registered).mcpServers["wanx-memobox"];
  assert.equal(command, "/bin/sh");
  const [launcher] = args;
  assert.equal((await lstat(launcher)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse((await shell(command, args)).stdout), ["1", options.descriptorPath, await realpath(options.stdioPath)]);

  await rm(options.stdioPath);
  const moved = createMyAiMcpConfig("claude_code", { ...options, stdioPath: nextStdio, stableLauncher: true });
  assert.equal(await moved.isConfigured(), false);
  await assert.rejects(moved.restore(() => { throw new Error("scope changed"); }), /scope changed/);
  assert.equal(await moved.restore(() => {}), true);
  assert.equal(await moved.isConfigured(), true);
  assert.equal(await readFile(file, "utf8"), registered);
  assert.deepEqual(JSON.parse((await shell(command, args)).stdout), ["1", options.descriptorPath, await realpath(nextStdio)]);
});

test('Windows Claude Desktop uses APPDATA and leaves the obsolete macOS path untouched', async t => {
  const options=await fixture(t);
  const appData=path.join(options.home,'roaming-profile');
  const file=path.join(appData,'Claude','claude_desktop_config.json');
  const obsolete=path.join(options.home,'Library','Application Support','Claude','claude_desktop_config.json');
  await mkdir(path.dirname(file),{recursive:true});
  await mkdir(path.dirname(obsolete),{recursive:true});
  await writeFile(file,'{"mcpServers":{"existing":{"command":"keep"}}}\n');
  await writeFile(obsolete,'keep old user configuration\n');
  const adapter=createMyAiMcpConfig('claude_desktop',{...options,platform:'win32',env:{APPDATA:appData}});
  await adapter.ensure();
  const value=JSON.parse(await readFile(file,'utf8'));
  assert.equal(value.mcpServers.existing.command,'keep');
  assert.equal(value.mcpServers['wanx-memobox'].command,process.execPath);
  assert.equal(await adapter.isConfigured(),true);
  assert.equal(await readFile(obsolete,'utf8'),'keep old user configuration\n');
  await adapter.remove();
  assert.equal(JSON.parse(await readFile(file,'utf8')).mcpServers.existing.command,'keep');
});

test('Windows Claude Desktop falls back to the user roaming directory when APPDATA is absent',async t=>{
  const options=await fixture(t);
  const adapter=createMyAiMcpConfig('claude_desktop',{...options,platform:'win32'});
  await adapter.ensure();
  const file=path.join(options.home,'AppData','Roaming','Claude','claude_desktop_config.json');
  assert.ok(JSON.parse(await readFile(file,'utf8')).mcpServers['wanx-memobox']);
});

test("Gemini respects GEMINI_CLI_HOME as the parent of .gemini", async t => {
  const options = await fixture(t);
  const isolatedHome = path.join(options.home, "gemini-isolated-home");
  const ignoredDirectory = path.join(options.home, "not-a-gemini-variable");
  const adapter = createMyAiMcpConfig("gemini", { ...options, env: {
    GEMINI_CLI_HOME: isolatedHome, GEMINI_CONFIG_DIR: ignoredDirectory,
  } });
  await adapter.ensure();
  const file = path.join(isolatedHome, ".gemini", "settings.json");
  assert.equal(await adapter.isConfigured(), true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).mcpServers["wanx-memobox"].command, process.execPath);
  assert.equal(await lstat(path.join(options.home, ".gemini")).catch(error => error.code), "ENOENT");
  assert.equal(await lstat(path.join(isolatedHome, "settings.json")).catch(error => error.code), "ENOENT");
  assert.equal(await lstat(ignoredDirectory).catch(error => error.code), "ENOENT");
  await adapter.remove();
  assert.equal(await adapter.isConfigured(), false);
});

test("guided Connector clients export configuration and never write guessed files", async t => {
  const options = await fixture(t);
  const guessed = path.join(options.home, ".workbuddy", "mcp.json");
  await mkdir(path.dirname(guessed), { recursive: true });
  await writeFile(guessed, "malformed user file - do not inspect or rewrite\n");
  for (const agent of ["workbuddy", "qwenwork"]) {
    const adapter = createMyAiMcpConfig(agent, options);
    assert.equal(adapter.guided, true);
    await adapter.ensure();
    assert.equal(await adapter.isConfigured(), false);
    const configuration = adapter.configuration();
    assert.deepEqual(configuration, { mcpServers: { "wanx-memobox": {
      command: process.execPath, args: [options.stdioPath, options.descriptorPath], env: { ELECTRON_RUN_AS_NODE: "1" },
    } } });
    configuration.mcpServers["wanx-memobox"].args.push("changed by caller");
    assert.equal(adapter.getConfiguration().mcpServers["wanx-memobox"].args.length, 2);
    await adapter.remove();
    const descriptorPath = path.join(options.home, agent, "endpoint.json");
    const installed = createMyAiMcpConfig(agent, { ...options, descriptorPath, stableLauncher: true });
    await installed.ensure();
    const launcher = path.join(path.dirname(descriptorPath), "stdio-launcher.sh");
    assert.deepEqual(installed.configuration().mcpServers["wanx-memobox"], { command: "/bin/sh", args: [launcher] });
    assert.ok((await readFile(launcher, "utf8")).includes(descriptorPath));
  }
  assert.equal(await readFile(guessed, "utf8"), "malformed user file - do not inspect or rewrite\n");
  assert.equal(await lstat(path.join(options.home, ".qwenwork")).catch(error => error.code), "ENOENT");
});

test("DeepSeek Harness changes only the desktop profile and preserves the shared patch", async t => {
  const options = await fixture(t);
  const shared = path.join(options.home, ".dsh", "cordis.patch.yml");
  const file = path.join(options.home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(shared, "# shared profiles\n[]\n");
  await writeFile(file, "# desktop configuration\n- insert:\n    - id: existing\n      name: existing-plugin\n");
  const adapter = createMyAiMcpConfig("deepseek_harness", options);
  await adapter.ensure();
  assert.equal(await adapter.isConfigured(), true);
  const content = await readFile(file, "utf8");
  assert.match(content, /desktop configuration/);
  assert.match(content, /existing-plugin/);
  assert.match(content, /@deepseek-ai\/dsh-mcp-client/);
  assert.equal(await readFile(shared, "utf8"), "# shared profiles\n[]\n");
  const installed = createMyAiMcpConfig("deepseek_harness", { ...options, stableLauncher: true });
  assert.equal(await installed.restore(() => {}), true);
  assert.equal(await installed.isConfigured(), true);
  assert.match(await readFile(file, "utf8"), /\/bin\/sh/);
  await installed.remove();
  assert.equal(await installed.isConfigured(), false);
  assert.match(await readFile(file, "utf8"), /existing-plugin/);
  assert.equal(await readFile(shared, "utf8"), "# shared profiles\n[]\n");
});

test("config adapters refuse malformed files, conflicting entries, and symlinks", async t => {
  const options = await fixture(t);
  const file = path.join(options.home, ".gemini", "settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  const adapter = createMyAiMcpConfig("gemini", options);
  await writeFile(file, "not JSON");
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_INVALID/);
  assert.equal(await readFile(file, "utf8"), "not JSON");
  const foreign = '{"mcpServers":{"wanx-memobox":{"command":"foreign"}}}\n';
  await writeFile(file, foreign);
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_NAME_CONFLICT/);
  await adapter.remove();
  assert.equal(await readFile(file, "utf8"), foreign);
  const target = path.join(options.home, "symlink-target.json");
  await writeFile(target, "{}\n");
  await rm(file);
  await symlink(target, file);
  await assert.rejects(adapter.ensure(), /MCP_CONFIG_INVALID/);
  assert.equal(await readFile(target, "utf8"), "{}\n");
});
