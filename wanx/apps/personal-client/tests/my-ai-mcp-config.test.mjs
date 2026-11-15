import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configurableAgents, createMyAiMcpConfig } from "../shell/my-ai-mcp-config.mjs";

async function fixture(t, env = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "my-ai-mcp-adapter-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env, executable: process.execPath, stdioPath: path.join(home, "stdio.mjs"), descriptorPath: path.join(home, "endpoint.json") };
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
  await adapter.ensure();
  assert.equal(await adapter.isConfigured(), true);
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
  await adapter.remove();
  assert.equal(await adapter.isConfigured(), false);
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
