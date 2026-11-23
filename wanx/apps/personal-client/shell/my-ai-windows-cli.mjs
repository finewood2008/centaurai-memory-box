import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const packages = { codex: "@openai/codex", gemini: "@google/gemini-cli", claude: "@anthropic-ai/claude-code" };
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

async function consoleNode(executable, env) {
  const directories = [path.dirname(executable), ...(env.PATH ?? env.Path ?? "").split(path.delimiter)]
    .map(value => value.replace(/^"|"$/g, "")).filter(path.isAbsolute);
  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, "node.exe");
    if ((await stat(candidate).catch(() => null))?.isFile()) return realpath(candidate);
  }
  throw new Error("此 npm CLI 需要 Node.js 才能在 Windows 终端交互。请检查 Node.js 安装与 PATH，或使用 CLI 的原生可执行程序。");
}

// npm's .cmd launchers require cmd.exe, which would parse the user's prompt.
// Resolve the installed package's declared JS entry and pass the original argv
// directly to Node instead. Never interpret the batch file or task text.
export async function resolveWindowsCli(executable, args, { node = process.versions.electron ? null : process.execPath, env = process.env } = {}) {
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { executable, args };
  const command = path.basename(executable).replace(/\.(?:cmd|bat)$/i, "").toLowerCase();
  const name = packages[command];
  if (!name) throw new Error("无法核实此 Windows CLI 的启动入口，请使用官方安装版本。");
  const directory = path.dirname(executable);
  const roots = path.basename(directory).toLowerCase() === ".bin"
    ? [path.join(directory, "..", ...name.split("/"))]
    : [path.join(directory, "node_modules", ...name.split("/"))];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[command];
      if (pkg.name !== name || typeof entry !== "string" || !inside(root, path.resolve(root, entry))) continue;
      const base = await realpath(root), file = await realpath(path.resolve(root, entry));
      if (!inside(base, file) || !(await stat(file)).isFile()) continue;
      // Electron's GUI executable loses console stdio again when used as a JS
      // CLI host. npm installs already depend on Node; use its console runtime.
      return { executable: node ?? await consoleNode(executable, env), args: [file, ...args], runAsNode: true };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("未找到 Windows CLI 的程序入口，请通过原安装渠道修复安装。");
}
