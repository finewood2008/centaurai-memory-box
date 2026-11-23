import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_LAUNCH_PAYLOAD_BYTES } from "./my-ai-launch-review.mjs";

const fail = message => Object.assign(new Error(message), { status: 400 });
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const powershellQuote = value => "'" + value.replaceAll("'", "''") + "'";
const artifacts = [".json", ".command", ".ps1", ".json.ready", ".json.request", ".json.approved"];
const run = promisify(execFile);

export async function openWindowsTerminal(file, execute = run) {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // ShellExecute gives the terminal a real console and keyboard handles. A
  // detached child with stdio:ignore inherits NUL handles and cannot review.
  // Only fixed switches and the generated script path enter the shell.
  const argumentsText = '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "' + file + '"';
  const script = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath " + powershellQuote(powershell)
    + " -ArgumentList " + powershellQuote(argumentsText) + " -WindowStyle Normal -ErrorAction Stop";
  await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 });
}

export function createMyAiLauncher({ directory, executable = process.execPath, openFile, openTerminal = openWindowsTerminal, getScope, now = Date.now, lifetime = 15 * 60_000, terminalTimeoutMs = 10000, platform = process.platform }) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(executable)) throw fail("启动助手路径无效。");
  const helper = fileURLToPath(new URL("./my-ai-launch-review.mjs", import.meta.url));
  const pending = new Map();
  let timer, closed = false, polling = false;

  async function authorize(filename) {
    if (!filename?.endsWith(".json.request")) return;
    const id = filename.slice(0, -".json.request".length);
    const entry = pending.get(id);
    if (!entry || entry.claimed) return;
    const file = path.join(directory, id + ".json");
    const request = await readFile(file + ".request", "utf8").catch(() => "");
    if (!request || entry.claimed) return;
    entry.claimed = true;
    const approved = !closed && request === id && entry.expires > now() && entry.scope && getScope() === entry.scope;
    const staged = file + ".approved.tmp";
    try {
      await writeFile(staged, JSON.stringify({ id, approved }), { flag: "wx", mode: 0o600 });
      // Publish only a complete response, preserving exclusive creation.
      await link(staged, file + ".approved");
    } finally {
      await rm(staged, { force: true });
    }
    pending.delete(id);
  }

  async function poll() {
    if (polling || closed || !pending.size) return;
    polling = true;
    try {
      const names = await readdir(directory);
      await Promise.all(names.filter(name => /^[a-f0-9]{36}\.json\.request$/.test(name)).map(authorize));
      for (const [id, entry] of pending) if (entry.expires <= now()) {
        pending.delete(id);
        await Promise.all(artifacts.map(extension =>
          rm(path.join(directory, id + extension), { force: true })));
      }
    } finally { polling = false; }
  }

  async function prepare(input, check = () => {}) {
    check();
    if (!["darwin", "win32"].includes(platform)) throw fail("此系统暂不支持终端启动，请复制提示词后在终端打开应用。");
    const scope = getScope();
    if (closed || !scope) throw fail("请先连接当前账号的盒子。");
    if (!input || !path.isAbsolute(input.executable ?? "") || !path.isAbsolute(input.cwd ?? "") ||
      !(await stat(input.cwd).catch(() => null))?.isDirectory() || !Array.isArray(input.args) ||
      !input.args.every(value => typeof value === "string" && !value.includes("\0")) ||
      typeof input.prompt !== "string" || input.prompt.includes("\0") || input.prompt.length > 24_000) throw fail("CLI 任务或工作目录无效。");
    check();
    if (getScope() !== scope) throw fail("盒子或账号已切换，请重新发起。");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    timer ??= setInterval(() => { void poll().catch(() => {}); }, 200);
    timer.unref();
    const id = randomBytes(18).toString("hex");
    const file = path.join(directory, id + ".json");
    const commandFile = path.join(directory, id + (platform === "win32" ? ".ps1" : ".command"));
    const expires = now() + lifetime;
    const task = { id, agent: String(input.agent), executable: input.executable, args: input.args, cwd: input.cwd,
      prompt: input.prompt, resources: input.resources ?? "", expires };
    const serialized = JSON.stringify(task);
    if (Buffer.byteLength(serialized, "utf8") > MAX_LAUNCH_PAYLOAD_BYTES) throw fail("任务内容过大，请缩短提示词或资料范围后重试。");
    try {
      await writeFile(file, serialized, { flag: "wx", mode: 0o600 });
      const script = platform === "win32"
        ? "\uFEFF$ErrorActionPreference = 'Stop'\r\n$env:ELECTRON_RUN_AS_NODE = '1'\r\n"
          + "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n"
          + "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n"
          + "$OutputEncoding = [Console]::OutputEncoding\r\n"
          + "$launchArguments = @(" + [helper, file].map(value => powershellQuote('"' + value + '"')).join(", ") + ")\r\n"
          + "$launchProcess = Start-Process -FilePath " + powershellQuote(executable)
          + " -ArgumentList $launchArguments -NoNewWindow -Wait -PassThru\r\n"
          + "if ($launchProcess.ExitCode -ne 0) { throw '终端任务未正常完成，请检查上方提示。' }\r\n"
        : "#!/bin/sh\nexec /usr/bin/env ELECTRON_RUN_AS_NODE=1 " + [executable, helper, file].map(quote).join(" ") + "\n";
      await writeFile(commandFile, script, { flag: "wx", mode: 0o700 });
      pending.set(id, { scope, expires, claimed: false });
      check();
      if (getScope() !== scope) throw fail("盒子或账号已切换，请重新发起。");
      const error = platform === "win32" ? await openTerminal(commandFile) : await openFile(commandFile);
      if (error) throw fail("无法打开终端，请检查系统终端应用。");
      if (platform === "win32") {
        const deadline = Date.now() + terminalTimeoutMs;
        while (await readFile(file + ".ready", "utf8").catch(() => "") !== id) {
          check();
          if (closed || getScope() !== scope) throw fail("任务授权已撤销，请重新发起。");
          if (Date.now() >= deadline) throw fail("终端核对窗口未就绪，请检查 PowerShell 窗口中的错误后重试。");
          await delay(50);
        }
        await rm(file + ".ready", { force: true });
      }
      check();
      if (closed || getScope() !== scope) throw fail("任务授权已撤销，请重新发起。");
      return { opened: true, prepared: true, delivery: "terminal-confirm" };
    } catch (error) {
      pending.delete(id);
      await Promise.all(artifacts.map(extension => rm(path.join(directory, id + extension), { force: true }).catch(() => {})));
      throw error;
    }
  }

  return {
    supported: ["darwin", "win32"].includes(platform),
    prepare,
    launch: (input, check) => prepare({ ...input, prompt: "" }, check),
    async close() {
      closed = true;
      clearInterval(timer);
      const ids = [...pending.keys()];
      pending.clear();
      await Promise.all(ids.flatMap(id => artifacts.map(extension =>
        rm(path.join(directory, id + extension), { force: true }).catch(() => {}))));
    },
  };
}
