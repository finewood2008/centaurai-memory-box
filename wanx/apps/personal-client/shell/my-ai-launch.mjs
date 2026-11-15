import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fail = message => Object.assign(new Error(message), { status: 400 });
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function createMyAiLauncher({ directory, executable = process.execPath, openFile, getScope, now = Date.now, lifetime = 15 * 60_000, platform = process.platform }) {
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
    await writeFile(file + ".approved", JSON.stringify({ id, approved }), { flag: "wx", mode: 0o600 }).catch(() => {});
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
        await Promise.all([".json", ".command", ".json.request", ".json.approved"].map(extension =>
          rm(path.join(directory, id + extension), { force: true })));
      }
    } finally { polling = false; }
  }

  async function prepare(input, check = () => {}) {
    check();
    if (platform !== "darwin") throw fail("此终端启动助手目前支持 macOS，请复制提示词后在终端打开应用。");
    const scope = getScope();
    if (closed || !scope) throw fail("请先连接当前账号的盒子。");
    if (!input || !path.isAbsolute(input.executable ?? "") || !path.isAbsolute(input.cwd ?? "") ||
      !(await stat(input.cwd).catch(() => null))?.isDirectory() || !Array.isArray(input.args) ||
      !input.args.every(value => typeof value === "string" && !value.includes("\0")) ||
      typeof input.prompt !== "string" || input.prompt.length > 24_000) throw fail("CLI 任务或工作目录无效。");
    check();
    if (getScope() !== scope) throw fail("盒子或账号已切换，请重新发起。");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    timer ??= setInterval(() => { void poll().catch(() => {}); }, 200);
    timer.unref();
    const id = randomBytes(18).toString("hex");
    const file = path.join(directory, id + ".json");
    const commandFile = path.join(directory, id + ".command");
    const expires = now() + lifetime;
    const task = { id, agent: String(input.agent), executable: input.executable, args: input.args, cwd: input.cwd,
      prompt: input.prompt, resources: input.resources ?? "", expires };
    try {
      await writeFile(file, JSON.stringify(task), { flag: "wx", mode: 0o600 });
      await writeFile(commandFile, "#!/bin/sh\nexec /usr/bin/env ELECTRON_RUN_AS_NODE=1 " + [executable, helper, file].map(quote).join(" ") + "\n", { flag: "wx", mode: 0o700 });
      pending.set(id, { scope, expires, claimed: false });
      check();
      if (getScope() !== scope) throw fail("盒子或账号已切换，请重新发起。");
      const error = await openFile(commandFile);
      if (error) throw fail("无法打开终端，请检查系统终端应用。");
      check();
      if (closed || getScope() !== scope) throw fail("任务授权已撤销，请重新发起。");
      return { opened: true, prepared: true, delivery: "terminal-confirm" };
    } catch (error) {
      pending.delete(id);
      await Promise.all([file, commandFile].map(target => rm(target, { force: true })));
      throw error;
    }
  }

  return {
    supported: platform === "darwin",
    prepare,
    launch: (input, check) => prepare({ ...input, prompt: "" }, check),
    async close() {
      closed = true;
      clearInterval(timer);
      const ids = [...pending.keys()];
      pending.clear();
      await Promise.all(ids.flatMap(id => [".json", ".command", ".json.request", ".json.approved"].map(extension =>
        rm(path.join(directory, id + extension), { force: true }).catch(() => {}))));
    },
  };
}
