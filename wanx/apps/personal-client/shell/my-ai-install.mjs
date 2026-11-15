import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { catalogAgent } from "./my-ai-catalog.mjs";

const execute = promisify(execFile);
const failure = message => Object.assign(new Error(message), { status: 400 });

// Only application-owned npm prefixes are mutated. Existing global installs are
// detected elsewhere and managed through their original installation channel.
export function createMyAiInstallations({ directory, npmExecutable = "npm", run = execute, env = process.env, platform = process.platform }) {
  if (!path.isAbsolute(directory)) throw failure("应用安装目录无效。");
  let changes = Promise.resolve();
  const rootFor = id => path.join(directory, id);
  const executableFor = (root, agent) => path.join(root, "node_modules", ".bin", agent.command + (platform === "win32" ? ".cmd" : ""));
  const supported = id => Boolean(catalogAgent(id)?.npmPackage && platform !== "win32");

  async function ownedRoot(id) {
    const agent = catalogAgent(id);
    if (!agent?.npmPackage) return null;
    const root = rootFor(id);
    const info = await lstat(root).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure("托管安装目录不是本应用创建的目录。");
    const manifest = JSON.parse(await readFile(path.join(root, "memobox-install.json"), "utf8").catch(() => "null"));
    if (manifest?.package !== agent.npmPackage || manifest?.agent !== id) throw failure("托管安装来源无法核实，请按官方方式管理。");
    return { root, agent, manifest };
  }

  async function inspect(id) {
    const current = await ownedRoot(id);
    if (!current) return null;
    const executable = executableFor(current.root, current.agent);
    const packageFile = path.join(current.root, "node_modules", ...current.agent.npmPackage.split("/"), "package.json");
    const pkg = JSON.parse(await readFile(packageFile, "utf8"));
    await lstat(executable);
    return { executable, version: typeof pkg.version === "string" ? pkg.version : undefined, channel: "memobox-npm", managed: true };
  }

  function update(id, method, check) {
    const result = changes.then(async () => {
      check();
      if (!supported(id)) throw failure("此应用请通过官方安装入口管理。");
      const agent = catalogAgent(id);
      const current = await ownedRoot(id);
      if (method === "uninstall") {
        if (!current) throw failure("未发现本应用管理的安装，请通过原安装渠道卸载。");
        check();
        await rm(current.root, { recursive: true });
        check();
        return { uninstalled: true, installed: false, message: "托管程序已卸载，记忆和登录资料已保留。" };
      }
      if (current) return { installed: true, ...await inspect(id), message: "已安装托管程序。" };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stage = path.join(directory, ".install-" + id + "-" + randomUUID());
      await mkdir(stage, { mode: 0o700 });
      try {
        await run(npmExecutable, ["install", "--prefix", stage, "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", "--ignore-scripts", agent.npmPackage],
          { env, timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true });
        check();
        const executable = executableFor(stage, agent);
        const verification = await run(executable, ["--version"], { env, timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true });
        if (typeof verification.stdout !== "string" || !/\d+\.\d+/.test(verification.stdout)) throw failure("安装后的版本验证未通过，请使用官方安装入口。");
        await writeFile(path.join(stage, "memobox-install.json"), JSON.stringify({ agent: id, package: agent.npmPackage }), { flag: "wx", mode: 0o600 });
        check();
        await rename(stage, rootFor(id));
        return { installed: true, ...await inspect(id), message: "托管程序安装并通过版本检查。" };
      } catch (error) {
        if (error.status) throw error;
        throw failure("自动安装未完成，请检查网络或使用官方安装入口。");
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
    changes = result.catch(() => {});
    return result;
  }

  return { supported, inspect, install: (id, check = () => {}) => update(id, "install", check), uninstall: (id, check = () => {}) => update(id, "uninstall", check) };
}
