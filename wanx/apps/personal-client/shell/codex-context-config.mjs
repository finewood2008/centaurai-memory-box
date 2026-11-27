import { execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createLocalMcpLauncher } from './my-ai-mcp-config.mjs';

export const CODEX_CONTEXT_MCP_NAME = 'wanx-memobox';

const runFile = promisify(execFile);
const id = CODEX_CONTEXT_MCP_NAME;
const failure = (code, message) => Object.assign(new Error(message), {code});
const macBundleCliPaths = [
  ['codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'],
  ['codex-cli', 'bin', 'codex'],
  ['codex'],
];

function macCliDirectories(home) {
  return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

export function myAiCliEnvironment(env = process.env, platform = process.platform, home = homedir()) {
  if (platform !== 'darwin') return env;
  const fallback = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const directories = env.PATH ? env.PATH.split(path.delimiter) : fallback;
  return {...env, PATH: [...new Set([...directories, ...macCliDirectories(home)])].join(path.delimiter)};
}

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

export async function findCodexCli({env = process.env, platform = process.platform, arch = process.arch, home = homedir(),
  macApplicationDirectories = ['/Applications', path.join(home, 'Applications')]} = {}) {
  const windows = platform === 'win32';
  const delimiter = windows ? ';' : path.delimiter;
  const pathEnv = env.PATH ?? (windows ? env.Path : undefined) ?? '';
  const directories = pathEnv.split(delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(entry => path.isAbsolute(entry));
  const binaryName = windows ? 'codex.exe' : 'codex';

  for (const directory of directories) {
    const filename = path.join(directory, binaryName);
    if (await isExecutable(filename, platform)) return filename;
  }
  if (platform === 'darwin') {
    // Finder-launched clients typically do not inherit the shell's PATH. The
    // desktop app includes a native CLI even when no separate CLI was installed.
    for (const directory of macApplicationDirectories) {
      for (const bundle of ['Codex.app', 'ChatGPT.app']) {
        for (const relativePath of macBundleCliPaths) {
          const filename = path.join(directory, bundle, 'Contents', 'Resources', ...relativePath);
          if (await isExecutable(filename, platform)) return filename;
        }
      }
    }
    for (const directory of macCliDirectories(home)) {
      const filename = path.join(directory, binaryName);
      if (await isExecutable(filename, platform)) return filename;
    }
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

export function createCodexContextConfig({executable = process.execPath, stdioPath, descriptorPath, env = process.env,
  platform = process.platform, discover = findCodexCli, run = runFile, confirmReplace, stableLauncher = false}) {
  const args = [stdioPath, descriptorPath];
  if (![executable, ...args].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Codex MCP 本机路径无效。');
  const launcher = platform === 'darwin' && stableLauncher ? createLocalMcpLauncher({executable, stdioPath, descriptorPath}) : null;
  const directEntry = {command: executable, args, env: {ELECTRON_RUN_AS_NODE: '1'}};
  const entry = launcher?.entry ?? directEntry;
  const home = homedir();
  const locateCli = () => discover({env, platform, home});
  // npm's Codex entry point uses /usr/bin/env node. Its runtime must also be
  // discoverable when MemoBox was started from the desktop.
  const cliEnv = myAiCliEnvironment(env, platform, home);

  function matches(server, expected = entry) {
    const transport = server?.transport;
    return transport?.type === 'stdio' && transport.command === expected.command
      && isDeepStrictEqual(transport.env ?? {}, expected.env ?? {})
      && !transport.env_vars?.length && !transport.cwd
      && isDeepStrictEqual(transport.args, expected.args);
  }

  async function invoke(cli, command) {
    try {
      return await run(cli, command, {cwd: home, env: cliEnv, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8'});
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
    const file = transport?.args?.[0];
    if (typeof file === 'string' && path.isAbsolute(file) &&
        path.basename(file) === 'stdio-launcher.sh' && path.basename(path.dirname(file)) === 'codex-context' &&
        matches(server, {command: '/bin/sh', args: [file]})) return true;
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
  async function register(check, restore = false) {
    check();
    const cli = await locateCli();
    if (!cli && restore) return false;
    if (!cli) throw failure('CODEX_CLI_NOT_FOUND', '找不到可用的 Codex CLI。请先安装或启动 Codex。');
    const existing = await get(cli);
    check();
    const sameBridge = launcher && matches(existing, directEntry);
    if (restore && (!existing || existing.enabled === false || (!matches(existing) && !sameBridge))) return false;
    if (existing) {
      if (existing.enabled === false) throw failure('CODEX_MCP_DISABLED', 'Codex 已禁用 wanx-memobox。请在 Codex 设置中启用。');
      if (matches(existing)) {
        const configurationChanged = await launcher?.refresh(check);
        return restore ? true : { configurationChanged: configurationChanged === true };
      }
      if (!sameBridge) {
        if (!previousBridge(existing) || !confirmReplace)
          throw failure('MCP_CONFIG_NAME_CONFLICT', 'Codex 中的 wanx-memobox 名称已被占用。请在 Codex 设置中检查该连接。');
        const accepted = await confirmReplace({
          previous: {command: existing.transport.command, args: [...existing.transport.args]},
          next: {command: entry.command, args: [...entry.args]},
        });
        check();
        if (!accepted) throw failure('CODEX_MCP_REPAIR_CANCELLED', '已保留原来的 Codex 资料连接。');
      }
      if (!isDeepStrictEqual(existing, await get(cli)))
        throw failure('MCP_CONFIG_CHANGED', 'Codex 配置刚被修改，请重新连接。');
    }
    await launcher?.refresh(check);
    check();
    const environment = Object.entries(entry.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    await invoke(cli, ['mcp', 'add', id, ...environment, '--', entry.command, ...entry.args]);
    check();
    const configured = await get(cli);
    if (!matches(configured) || configured.enabled === false)
      throw failure('MCP_CONFIG_VERIFY_FAILED', 'Codex MCP 连接写入后校验失败。');
    return restore ? true : { configurationChanged: true };
  }

  return {
    async isConfigured() {
      const cli = await locateCli();
      if (!cli) return false;
      const existing = await get(cli).catch(() => null);
      return existing?.enabled !== false && (launcher && matches(existing, directEntry) ||
        matches(existing) && (!launcher || await launcher.ready()));
    },
    ...(launcher && {restoreWithoutDescriptor: true, restore: check => register(check, true)}),
    ensure(check = () => {}) {
      current ??= register(check).finally(() => { current = null; });
      return current;
    },
    async remove() {
      const cli = await locateCli();
      if (!cli) return;
      const existing = await get(cli);
      if (matches(existing) || (launcher && matches(existing, directEntry))) await invoke(cli, ['mcp', 'remove', id]);
    },
  };
}
