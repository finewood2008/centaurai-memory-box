import { execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

export const CODEX_CONTEXT_MCP_NAME = 'wanx-memobox';

const runFile = promisify(execFile);
const id = CODEX_CONTEXT_MCP_NAME;
const failure = (code, message) => Object.assign(new Error(message), {code});

async function isExecutable(filename, platform) {
  try {
    if (!(await stat(filename)).isFile()) return false;
    if (platform !== 'win32') await access(filename, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function localCodexBinaries(base) {
  const directories = await readdir(base, {withFileTypes: true}).catch(() => []);
  const entries = await Promise.all(directories.filter(entry => entry.isDirectory() && /^[a-f0-9]{8,64}$/i.test(entry.name)).map(async entry => {
    const filename = path.join(base, entry.name, 'codex.exe');
    const info = await stat(filename).catch(() => null);
    return info?.isFile() ? {filename, updated: info.mtimeMs} : null;
  }));
  return entries.filter(Boolean).sort((a, b) => b.updated - a.updated).map(entry => entry.filename);
}

export async function findCodexCli({env = process.env, platform = process.platform, arch = process.arch} = {}) {
  const windows = platform === 'win32';
  const delimiter = windows ? ';' : ':';
  const pathEnv = env.PATH ?? (windows ? env.Path : undefined) ?? '';
  const directories = pathEnv.split(delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(entry => path.isAbsolute(entry));
  const binaryName = windows ? 'codex.exe' : 'codex';

  for (const directory of directories) {
    const filename = path.join(directory, binaryName);
    if (await isExecutable(filename, platform)) return filename;
  }
  if (!windows) return null;

  // The desktop app stages a runnable CLI outside its Microsoft Store package.
  if (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) {
    const available = await localCodexBinaries(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'));
    if (available.length) return available[0];
  }

  const target = {x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc'}[arch];
  if (!target) return null;
  const packageName = `codex-win32-${arch}`;
  const npmDirectories = new Set([...directories, env.APPDATA && path.join(env.APPDATA, 'npm')]);
  for (const directory of npmDirectories) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const openai = path.join(directory, 'node_modules', '@openai');
    const packageRoots = [path.join(openai, packageName), path.join(openai, 'codex', 'node_modules', '@openai', packageName), path.join(openai, 'codex')];
    for (const packageRoot of packageRoots) {
      const filename = path.join(packageRoot, 'vendor', target, 'bin', binaryName);
      if (await isExecutable(filename, platform)) return filename;
    }
  }
  return null;
}

function parseList(stdout) {
  try {
    const result = JSON.parse(stdout);
    if (Array.isArray(result)) return result.find(server => server?.name === id) ?? null;
  } catch {}
  throw failure('CODEX_MCP_READ_FAILED', '无法读取 Codex 的 MCP 配置。');
}

export function createCodexContextConfig({executable = process.execPath, stdioPath, descriptorPath, env = process.env, discover = findCodexCli, run = runFile, confirmReplace}) {
  const args = [stdioPath, descriptorPath];
  if (![executable, ...args].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Codex MCP 本机路径无效。');

  function matches(server) {
    const transport = server?.transport;
    return transport?.type === 'stdio' && transport.command === executable
      && transport.env?.ELECTRON_RUN_AS_NODE === '1'
      && Object.keys(transport.env).length === 1
      && !transport.env_vars?.length && !transport.cwd
      && Array.isArray(transport.args) && transport.args.length === args.length
      && args.every((argument, index) => transport.args[index] === argument);
  }

  async function invoke(cli, command) {
    try {
      return await run(cli, command, {cwd: homedir(), env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8'});
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
      throw failure('CODEX_MCP_CLI_FAILED', '无法更新 Codex 的 MCP 配置。请检查本机 Codex CLI。');
    }
  }

  async function get(cli) {
    return parseList((await invoke(cli, ['mcp', 'list', '--json'])).stdout);
  }

  // A previous installation may use another app/profile path. Only offer an
  // explicit repair for this bridge's transport shape; arbitrary same-name
  // servers and user-disabled entries remain untouched.
  function previousBridge(server) {
    const transport = server?.transport;
    return transport?.type === 'stdio' && typeof transport.command === 'string' && path.isAbsolute(transport.command)
      && transport.env?.ELECTRON_RUN_AS_NODE === '1' && Object.keys(transport.env).length === 1
      && !transport.env_vars?.length && !transport.cwd
      && Array.isArray(transport.args) && transport.args.length === 2
      && transport.args.every(value => typeof value === 'string' && path.isAbsolute(value))
      && path.basename(transport.args[0]) === 'codex-context-stdio.mjs'
      && path.basename(transport.args[1]) === 'endpoint.json'
      && path.basename(path.dirname(transport.args[1])) === 'codex-context';
  }

  let current;
  async function register(check) {
    check();
    const cli = await discover({env});
    if (!cli) throw failure('CODEX_CLI_NOT_FOUND', '找不到可用的 Codex CLI。请先安装或启动 Codex。');
    const existing = await get(cli);
    check();
    if (existing) {
      if (existing.enabled === false) throw failure('CODEX_MCP_DISABLED', 'Codex 已禁用 wanx-memobox。请在 Codex 设置中启用。');
      if (matches(existing)) return;
      if (!previousBridge(existing) || !confirmReplace)
        throw failure('MCP_CONFIG_NAME_CONFLICT', 'Codex 中的 wanx-memobox 名称已被占用。请在 Codex 设置中检查该连接。');
      const accepted = await confirmReplace({
        previous: {command: existing.transport.command, args: [...existing.transport.args]},
        next: {command: executable, args: [...args]},
      });
      check();
      if (!accepted) throw failure('CODEX_MCP_REPAIR_CANCELLED', '已保留原来的 Codex 资料连接。');
      if (!isDeepStrictEqual(existing, await get(cli)))
        throw failure('MCP_CONFIG_CHANGED', 'Codex 配置刚被修改，请重新连接。');
    }
    check();
    await invoke(cli, ['mcp', 'add', id, '--env', 'ELECTRON_RUN_AS_NODE=1', '--', executable, ...args]);
    check();
    const configured = await get(cli);
    if (!matches(configured) || configured.enabled === false)
      throw failure('MCP_CONFIG_VERIFY_FAILED', 'Codex MCP 连接写入后校验失败。');
  }

  return {
    async isConfigured() {
      const cli = await discover({env});
      if (!cli) return false;
      const existing = await get(cli).catch(() => null);
      return matches(existing) && existing.enabled !== false;
    },
    ensure(check = () => {}) {
      current ??= register(check).finally(() => { current = null; });
      return current;
    },
    async remove() {
      const cli = await discover({env});
      if (cli && matches(await get(cli))) await invoke(cli, ['mcp', 'remove', id]);
    },
  };
}
