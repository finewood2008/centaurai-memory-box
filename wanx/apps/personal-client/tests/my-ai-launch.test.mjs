import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMyAiLauncher, openWindowsTerminal } from "../shell/my-ai-launch.mjs";
import { runLaunchReview } from "../shell/my-ai-launch-review.mjs";
import { resolveWindowsCli } from "../shell/my-ai-windows-cli.mjs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "my-ai-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = [];
  let scope = "owner/box/session";
  const launcher = createMyAiLauncher({ directory: path.join(root, "pending"), executable: process.execPath, platform: "darwin",
    openFile: async file => { opened.push(file); return ""; }, getScope: () => scope, ...options });
  t.after(() => launcher.close());
  const prompt = "--yolo $(touch should-not-exist) `echo secret` \"quoted\"\n你好\u001b]52;clipboard";
  const prepare = () => launcher.prepare({ agent: "Gemini CLI", executable: process.execPath, cwd: root, args: ["--", prompt], prompt, resources: "Test folder" });
  return { root, opened, launcher, prompt, prepare, switchScope(value) { scope = value; } };
}

const successfulChild = (...args) => {
  const child = new EventEmitter();
  process.nextTick(() => child.emit("exit", 0));
  return child;
};

async function terminalReady(file) {
  await writeFile(file.replace(/\.ps1$/, ".json.ready"), path.basename(file, ".ps1"));
}

test("launcher stages a private literal payload and does not start any CLI before terminal confirmation", async t => {
  const h = await fixture(t);
  assert.deepEqual(await h.prepare(), { opened: true, prepared: true, delivery: "terminal-confirm" });
  const file = h.opened[0].replace(/\.command$/, ".json");
  const task = JSON.parse(await readFile(file, "utf8"));
  assert.equal(task.prompt, h.prompt);
  assert.deepEqual(task.args, ["--", h.prompt]);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(h.opened[0])).mode & 0o777, 0o700);
  }
  const script = await readFile(h.opened[0], "utf8");
  assert.doesNotMatch(script, /yolo|should-not-exist|clipboard/);
  assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
  let release;
  const answer = new Promise(resolve => { release = resolve; });
  const spawned = [], output = [];
  const run = runLaunchReview(file, {
    platform: "darwin", env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
    question: async () => answer, output: { write: value => { output.push(value); } },
    spawnChild(...args) { spawned.push(args); return successfulChild(); },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned.length, 0);
  release("");
  assert.deepEqual(await run, { started: true, exitCode: 0 });
  assert.deepEqual(spawned[0][1], ["--", h.prompt]);
  assert.equal(spawned[0][2].shell, false);
  assert.equal(spawned[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.ok(spawned[0][2].env.PATH.split(":").includes("/opt/homebrew/bin"));
  assert.doesNotMatch(output.join(""), /\u001b/);
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("cancel, expiration, and changing the signed-in scope all prevent CLI execution", async t => {
  const canceled = await fixture(t);
  await canceled.prepare();
  const file = canceled.opened[0].replace(/\.command$/, ".json");
  assert.deepEqual(await runLaunchReview(file, { question: async () => "cancel", output: { write() {} }, spawnChild: () => assert.fail("must not spawn") }), { started: false, canceled: true });

  let now = Date.now();
  const expired = await fixture(t, { now: () => now, lifetime: 100 });
  await expired.prepare();
  now += 101;
  await assert.rejects(runLaunchReview(expired.opened[0].replace(/\.command$/, ".json"), {
    now: () => now, question: async () => "", output: { write() {} }, spawnChild: () => assert.fail("must not spawn"),
  }), /过期/);

  const switched = await fixture(t);
  await switched.prepare();
  switched.switchScope("different-owner/box/session");
  await assert.rejects(runLaunchReview(switched.opened[0].replace(/\.command$/, ".json"), {
    question: async () => "", output: { write() {} }, spawnChild: () => assert.fail("must not spawn"),
  }), /授权已撤销/);
});

test("closed launcher withdraws pending payloads and invalid workspaces never produce a terminal task", async t => {
  const h = await fixture(t);
  await h.prepare();
  await h.launcher.close();
  await assert.rejects(readFile(h.opened[0]), { code: "ENOENT" });
  await assert.rejects(h.prepare(), /连接/);
  const invalid = await fixture(t);
  await assert.rejects(invalid.launcher.prepare({ executable: process.execPath, cwd: "relative", args: [], prompt: "test" }), /无效/);
  assert.equal(invalid.opened.length, 0);
});

test("Windows stages a PowerShell launcher and keeps prompt metacharacters out of executable script", async t => {
  const opened = [];
  const h = await fixture(t, { platform: "win32", openFile: () => assert.fail("must not depend on file associations"),
    openTerminal: async file => { opened.push(file); await terminalReady(file); } });
  assert.equal(h.launcher.supported, true);
  await h.prepare();
  assert.match(opened[0], /\.ps1$/);
  const script = await readFile(opened[0], "utf8");
  assert.equal(script.charCodeAt(0), 0xFEFF); // Windows PowerShell 5 needs a BOM for Chinese paths.
  assert.doesNotMatch(script, /yolo|should-not-exist|clipboard/);
  assert.match(script, /ELECTRON_RUN_AS_NODE/);
  const file = opened[0].replace(/\.ps1$/, ".json");
  const calls = [];
  const run = await runLaunchReview(file, { platform: "win32", question: async () => "", output: { write() {} },
    spawnChild: (...args) => { calls.push(args); return successfulChild(); } });
  assert.equal(run.started, true);
  assert.deepEqual(calls[0][1], ["--", h.prompt]);
  assert.equal(calls[0][2].shell, false);
  await assert.rejects(readFile(opened[0]), { code: "ENOENT" });
});

test("Windows resolves global and workspace npm shims without passing arguments through cmd.exe", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "my-ai-npm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const local of [false, true]) {
    const prefix = path.join(root, local ? "本地 安装" : "全局 ' $安装");
    const moduleRoot = path.join(prefix, "node_modules", "@google", "gemini-cli");
    const shim = path.join(prefix, ...(local ? ["node_modules", ".bin"] : []), "gemini.cmd");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "cli.js" } }));
    await writeFile(path.join(moduleRoot, "cli.js"), "");
    const args = ["--prompt-interactive", '你好 & | %PATH% $(Write-Output bad) "quoted"\nline two'];
    const command = await resolveWindowsCli(shim, args);
    assert.equal(command.executable, process.execPath);
    assert.deepEqual(command.args.slice(1), args);
    assert.equal(command.runAsNode, true);
    assert.equal(path.basename(command.args[0]), "cli.js");
    const consoleRuntime = path.join(prefix, "Node runtime");
    await mkdir(consoleRuntime);
    const node = path.join(consoleRuntime, "node.exe");
    await writeFile(node, "fixture, never executed");
    assert.equal((await resolveWindowsCli(shim, args, { node: null, env: { PATH: consoleRuntime } })).executable, node);
    await assert.rejects(resolveWindowsCli(shim, args, { node: null, env: { PATH: "" } }), /需要 Node.js/);
    await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "../outside.js" } }));
    await assert.rejects(resolveWindowsCli(shim, args), /程序入口/);
  }
  await assert.rejects(resolveWindowsCli(path.join(root, "unknown.cmd"), []), /无法核实/);
});

test("Windows confirmation rejects a changed account or box and removes the pending script", async t => {
  let script;
  const h = await fixture(t, { platform: "win32", openTerminal: async file => { script = file; await terminalReady(file); } });
  await h.prepare();
  h.switchScope("another-owner/box/session");
  await assert.rejects(runLaunchReview(script.replace(/\.ps1$/, ".json"), {
    platform: "win32", question: async () => "", output: { write() {} }, spawnChild: () => assert.fail("must not spawn"),
  }), /授权已撤销/);
  await assert.rejects(readFile(script), { code: "ENOENT" });
});

for (const runtime of ["node", "electron"]) for (const confirm of [true, false]) test(`Windows PowerShell ${runtime} ${confirm ? "confirms literal multiline arguments" : "rejects closed input without starting the CLI"}`, { skip: process.platform !== "win32", timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "任务 ' & $启动-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = path.join(root, "node_modules", "@google", "gemini-cli");
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "cli.cjs" } }));
  await writeFile(path.join(moduleRoot, "cli.cjs"), "require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n");
  const shim = path.join(root, "gemini.cmd");
  await writeFile(shim, "@echo must-not-execute\r\nexit /b 1\r\n");
  const prompt = '你好 "quoted" & | %PATH% $(Write-Output bad) `echo bad`\nline two';
  let child, completed;
  let stdout = "", stderr = "";
  const executable = runtime === "electron" ? createRequire(import.meta.url)("electron") : process.execPath;
  const launcher = createMyAiLauncher({ directory: path.join(root, "待确认"), executable, platform: "win32",
    getScope: () => "synthetic/owner/box", openTerminal: async file => {
      const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
      child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      completed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      child.stdout.on("data", bytes => { stdout += bytes; });
      child.stderr.on("data", bytes => { stderr += bytes; });
    } });
  t.after(() => { child?.kill(); return launcher.close(); });
  await launcher.prepare({ agent: "Gemini CLI", executable: shim, args: ["--prompt-interactive", prompt], prompt, cwd: root });
  child.stdin.end(confirm ? "\n" : "");
  const code = await completed;
  if (!confirm) {
    assert.equal(code, 1);
    assert.match(stderr, /终端输入已关闭，任务未启动/);
    assert.equal(await stat(path.join(root, "argv.json")).catch(() => null), null);
    assert.deepEqual(await readdir(path.join(root, "待确认")), []);
    return;
  }
  assert.equal(code, 0, stderr);
  assert.match(stdout, /核对后按 Enter/, stderr);
  assert.equal((await stat(path.join(root, "argv.json")).catch(() => null))?.isFile(), true, JSON.stringify({ stdout, stderr }));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "argv.json"), "utf8")), ["--prompt-interactive", prompt]);
});

test("Windows terminal uses ShellExecute and only reports ready after the review acknowledges", async t => {
  let captured;
  const file = path.join(tmpdir(), "中文 ' & $路径", "task.ps1");
  await openWindowsTerminal(file, async (...args) => { captured = args; });
  const command = Buffer.from(captured[1].at(-1), "base64").toString("utf16le");
  assert.match(command, /Start-Process/);
  assert.match(command, /-WindowStyle Normal/);
  assert.ok(command.includes(file.replaceAll("'", "''")));
  assert.doesNotMatch(command, /-NoNewWindow|RedirectStandard|stdio/);
  const h = await fixture(t, { platform: "win32", terminalTimeoutMs: 70, openTerminal: async () => {} });
  await assert.rejects(h.prepare(), /核对窗口未就绪/);
  assert.deepEqual(await readdir(path.join(h.root, "pending")), []);
});

for (const mode of ["native", "npm", "cancel"]) test(`Windows Electron ${mode} review and CLI read real console keys without stdin pipes`, { skip: process.platform !== "win32" || process.env.WANX_TEST_CONSOLE !== "1", timeout: 35000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "my-ai-real-console-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = path.join(root, "console.exe");
  const framework = path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  await promisify(execFile)(framework, ["/nologo", "/target:exe", "/out:" + driver,
    fileURLToPath(new URL("./fixtures/hidden-console.cs", import.meta.url))]);
  const packageRoot = path.join(root, "node_modules", "@google", "gemini-cli");
  await mkdir(packageRoot, { recursive: true });
  const entry = path.join(packageRoot, "cli.cjs"), result = path.join(root, "result.json");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "cli.cjs" } }));
  const shim = path.join(root, "gemini.cmd");
  await writeFile(shim, "@echo must-not-execute\r\nexit /b 1\r\n");
  const send = path.join(root, "send-input");
  await writeFile(entry, `const fs=require('node:fs'); const readline=require('node:readline');
    const result={tty:[!!process.stdin.isTTY,!!process.stdout.isTTY,!!process.stderr.isTTY],args:process.argv.slice(2)};
    fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(result));
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    rl.question('CLI second confirmation: ', answer=>{result.answer=answer;fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(result));rl.close();});`);
  let child, completed;
  const launcher = createMyAiLauncher({ directory: path.join(root, "pending"), platform: "win32",
    executable: createRequire(import.meta.url)("electron"), getScope: () => "isolated/console/session",
    openTerminal: async script => {
      child = spawn(driver, [path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        script, send, mode === "cancel" ? "cancel\r" : "\r", ...(mode === "cancel" ? [] : [result, "console input\r"])], { windowsHide: true, stdio: "ignore" });
      completed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    } });
  t.after(() => { child?.kill(); return launcher.close(); });
  const prompt = '中文 "quoted" & | $(Write-Output bad)\nline two';
  await launcher.prepare({ agent: "Fixture CLI", executable: mode === "npm" ? shim : process.execPath,
    cwd: root, args: mode === "npm" ? ["--prompt-interactive", prompt] : [entry, prompt], prompt });
  await writeFile(send, "ready");
  const code = await completed;
  const value = JSON.parse(await readFile(result, "utf8").catch(() => "{}"));
  assert.equal(code, 0, JSON.stringify(value));
  if (mode === "cancel") {
    assert.deepEqual(value, {});
    assert.deepEqual(await readdir(path.join(root, "pending")), []);
    return;
  }
  assert.deepEqual(value.tty, [true, true, true]);
  assert.equal(value.answer, "console input");
  assert.deepEqual(value.args, mode === "npm" ? ["--prompt-interactive", prompt] : [prompt]);
});

test("long Chinese drafts survive serialization, and oversized tasks fail before opening a terminal", async t => {
  const h = await fixture(t);
  const prompt = "中".repeat(24_000);
  await h.launcher.prepare({ agent: "Codex CLI", executable: process.execPath, cwd: h.root, args: ["--", prompt], prompt });
  await runLaunchReview(h.opened[0].replace(/\.command$/, ".json"), {
    question: async () => "cancel", output: { write() {} },
  });
  await assert.rejects(h.launcher.prepare({ agent: "Codex CLI", executable: process.execPath,
    cwd: h.root, args: ["x".repeat(512 * 1024)], prompt: "small" }), /任务内容过大/);
  assert.equal(h.opened.length, 1);
});

test("Windows acknowledges a review even when the user cancels before the launcher polls", async t => {
  const h = await fixture(t, { platform: "win32", terminalTimeoutMs: 100,
    openTerminal: async script => {
      await runLaunchReview(script.replace(/\.ps1$/, ".json"), {
        platform: "win32", question: async () => "cancel", output: { write() {} },
        spawnChild: () => assert.fail("must not spawn"),
      });
    } });
  assert.equal((await h.prepare()).opened, true);
  assert.deepEqual(await readdir(path.join(h.root, "pending")), []);
});
