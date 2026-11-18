import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const packages = { codex: "@openai/codex", gemini: "@google/gemini-cli", claude: "@anthropic-ai/claude-code" };
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

// npm's .cmd launchers require cmd.exe, which would parse the user's prompt.
// Resolve the installed package's declared JS entry and pass the original argv
// directly to Node instead. Never interpret the batch file or task text.
export async function resolveWindowsCli(executable, args, { node = process.execPath } = {}) {
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
      return { executable: node, args: [file, ...args], runAsNode: true };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("未找到 Windows CLI 的程序入口，请通过原安装渠道修复安装。");
}
