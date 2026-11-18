import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWindowsCli } from "./my-ai-windows-cli.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const display = value => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "�");
// Prompt text also appears in argv; allow the full 24,000-character Unicode draft.
export const MAX_LAUNCH_PAYLOAD_BYTES = 512 * 1024;

export async function readLaunchPayload(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_LAUNCH_PAYLOAD_BYTES) throw new Error("任务文件无效。");
  const task = JSON.parse(await readFile(file, "utf8"));
  if (!/^[a-f0-9]{36}$/.test(task.id) || path.basename(file) !== task.id + ".json" ||
      !path.isAbsolute(task.executable) || !path.isAbsolute(task.cwd) ||
      !Array.isArray(task.args) || !task.args.every(value => typeof value === "string" && !value.includes("\0")) ||
      typeof task.prompt !== "string" || !Number.isFinite(task.expires)) throw new Error("任务文件无效。");
  return task;
}

async function requestApproval(file, task) {
  const request = file + ".request";
  const response = file + ".approved";
  await writeFile(request, task.id, { flag: "wx", mode: 0o600 });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const result = JSON.parse(await readFile(response, "utf8"));
      if (result.id !== task.id || result.approved !== true) throw new Error("任务授权已撤销，请在盒子中重新发起。");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await pause(100);
  }
  throw new Error("盒子客户端未确认任务，请重新打开盒子后再试。");
}

export async function runLaunchReview(file, { question, output = process.stdout, spawnChild = spawn, approve = requestApproval, now = Date.now,
  platform = process.platform, resolveCli = resolveWindowsCli } = {}) {
  const task = await readLaunchPayload(file);
  const readline = question ? null : createInterface({ input: process.stdin, output });
  try {
    if (task.expires <= now()) throw new Error("任务已过期，请在盒子中重新发起。");
    output.write(`\n${display(task.agent)}\n工作目录：${display(task.cwd)}\n资料范围：${display(task.resources || "未选择空间或星图")}\n\n${display(task.prompt || "打开空白会话")}\n\n`);
    await writeFile(file + ".ready", task.id, { mode: 0o600 });
    const answer = await (question ?? (text => readline.question(text)))("核对后按 Enter 开始，输入其他内容取消：");
    readline?.close();
    if (answer.trim()) return { started: false, canceled: true };
    if (task.expires <= now()) throw new Error("任务已过期，请在盒子中重新发起。");
    const command = platform === "win32" ? await resolveCli(task.executable, task.args) : { executable: task.executable, args: task.args };
    if (task.expires <= now()) throw new Error("任务已过期，请在盒子中重新发起。");
    await approve(file, task);
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (command.runAsNode) childEnv.ELECTRON_RUN_AS_NODE = "1";
    const child = spawnChild(command.executable, command.args, { cwd: task.cwd, stdio: "inherit", shell: false, env: childEnv });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", value => resolve(value));
    });
    return { started: true, exitCode: code };
  } finally {
    readline?.close();
    // Windows consumes readiness in the launcher. Keep that acknowledgment
    // durable even when the user cancels before its next polling interval.
    await Promise.all([file, ...(platform === "win32" ? [] : [file + ".ready"]), file + ".request", file + ".approved", file.replace(/\.json$/, ".command"), file.replace(/\.json$/, ".ps1")].map(target => rm(target, { force: true }).catch(() => {})));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLaunchReview(process.argv[2]).then(result => { process.exitCode = result.exitCode ?? 0; }).catch(error => {
    process.stderr.write((error.message || "任务未启动。") + "\n");
    process.exitCode = 1;
  });
}
