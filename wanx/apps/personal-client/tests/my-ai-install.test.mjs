import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMyAiInstallations } from "../shell/my-ai-install.mjs";

async function fixture(t, run) {
  const root = await mkdtemp(path.join(tmpdir(), "my-ai-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, manager: createMyAiInstallations({ directory: path.join(root, "programs"), run, platform: "darwin", env: {} }) };
}

test("managed install uses only official packages and prefix, then verifies before claiming success", async t => {
  const calls = [];
  const { root, manager } = await fixture(t, async (file, args) => {
    calls.push([file, args]);
    if (args[0] === "install") {
      const prefix = args[args.indexOf("--prefix") + 1];
      await mkdir(path.join(prefix, "node_modules", ".bin"), { recursive: true });
      await mkdir(path.join(prefix, "node_modules", "@openai", "codex"), { recursive: true });
      await writeFile(path.join(prefix, "node_modules", ".bin", "codex"), "fixture only");
      await writeFile(path.join(prefix, "node_modules", "@openai", "codex", "package.json"), JSON.stringify({ version: "0.1.2" }));
      return { stdout: "installed" };
    }
    assert.deepEqual(args, ["--version"]);
    return { stdout: "0.1.2" };
  });
  assert.equal(manager.supported("codex_cli"), true);
  assert.equal(manager.supported("claude_code"), false);
  assert.equal(manager.supported("gemini"), false);
  const result = await manager.install("codex_cli");
  assert.equal(result.installed, true);
  assert.equal(result.managed, true);
  assert.equal(result.version, "0.1.2");
  assert.equal(result.channel, "memobox-npm");
  assert.ok(calls[0][1].includes("--registry=https://registry.npmjs.org"));
  assert.ok(calls[0][1].includes("--ignore-scripts"));
  assert.equal(calls[0][1].at(-1), "@openai/codex");
  assert.equal(result.executable, path.join(root, "programs", "codex_cli", "node_modules", ".bin", "codex"));
  const memory = path.join(root, "memory.json");
  await writeFile(memory, "keep memory");
  assert.equal((await manager.uninstall("codex_cli")).uninstalled, true);
  assert.equal(await manager.inspect("codex_cli"), null);
  assert.equal(await readFile(memory, "utf8"), "keep memory");
});

test("failed installs never leave a successful manifest and unknown directories are not removed", async t => {
  const { root, manager } = await fixture(t, async () => { throw new Error("offline"); });
  await assert.rejects(manager.install("codex_cli"), /未完成/);
  assert.equal(await manager.inspect("codex_cli"), null);
  await assert.rejects(manager.install("arbitrary-package"), /官方/);
  const foreign = path.join(root, "programs", "codex_cli");
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, "user-data"), "keep");
  await assert.rejects(manager.uninstall("codex_cli"), /来源无法核实/);
  assert.equal(await readFile(path.join(foreign, "user-data"), "utf8"), "keep");
});
