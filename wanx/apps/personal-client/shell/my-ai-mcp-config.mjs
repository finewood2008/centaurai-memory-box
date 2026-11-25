import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import jsonc from "jsonc-parser";
import { parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";

export const configurableAgents = ["claude_code", "claude_desktop", "gemini", "workbuddy", "workbuddy_cn", "qwenwork", "deepseek_harness"];
const serverName = "wanx-memobox";
const mapping = value => value && typeof value === "object" && !Array.isArray(value);

export function deepseekDesktopMcpFile({ env = process.env, home = homedir() } = {}) {
  const root = env.DSH_HOME && path.isAbsolute(env.DSH_HOME) ? env.DSH_HOME : path.join(home, ".dsh");
  return path.join(root, "profiles", "desktop", "cordis.patch.yml");
}

async function read(file) {
  const info = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("MCP_CONFIG_INVALID");
  return readFile(file, "utf8");
}

function parse(content, yaml) {
  if (yaml) {
    const doc = parseDocument(content);
    if (doc.errors.length) throw new Error("MCP_CONFIG_INVALID");
    return { value: doc.toJS({ maxAliasCount: 20 }) ?? {}, doc };
  }
  const errors = [];
  const value = jsonc.parse(content, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("MCP_CONFIG_INVALID");
  return { value };
}

async function isMissing(file) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function isMovedMacBridge(current, expected) {
  if (typeof current?.command !== "string" || !path.isAbsolute(current.command)) return false;
  const bundle = path.resolve(path.dirname(current.command), "../..");
  if (path.extname(bundle) !== ".app" ||
      !["半人马AI-记忆盒子", "半人马AI记忆盒子", "记忆盒子"].some(name => current.command === path.join(bundle, "Contents", "MacOS", name))) return false;
  const previous = {
    ...expected,
    command: current.command,
    args: [
      path.join(bundle, "Contents", "Resources", "app.asar", "shell", "codex-context-stdio.mjs"),
      expected.args[1],
    ],
  };
  // A move may change both launch paths, but the local profile's endpoint must match.
  return isDeepStrictEqual(current, previous) && await isMissing(bundle);
}

async function isRetiredGeminiDevBridge(current, expected) {
  if (typeof current?.command !== "string" || !path.isAbsolute(current.command) ||
      !Array.isArray(current.args) || current.args.length !== 2 ||
      !current.args.every(value => typeof value === "string" && path.isAbsolute(value))) return false;
  const [stdio, endpoint] = current.args;
  const bundle = path.resolve(path.dirname(current.command), "../..");
  const checkout = path.dirname(path.dirname(stdio));
  const profile = path.dirname(path.dirname(path.dirname(endpoint)));
  // The old development launcher kept its Gemini profile inside the same checkout.
  if (path.basename(bundle) !== "半人马AI记忆盒子 开发版.app" ||
      !checkout.endsWith(path.join(path.sep, "apps", "personal-client")) ||
      path.dirname(profile) !== path.join(checkout, ".local")) return false;
  const previous = {
    ...expected,
    command: path.join(bundle, "Contents", "MacOS", "Electron"),
    args: [path.join(checkout, "shell", "codex-context-stdio.mjs"), path.join(profile, "my-ai-access", "gemini", "endpoint.json")],
  };
  return isDeepStrictEqual(current, previous) && await isMissing(bundle) && await isMissing(stdio) && await isMissing(endpoint);
}

async function writeAtomically(file, previous, updated, check) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID();
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    if (await read(file) !== previous) throw new Error("MCP_CONFIG_CHANGED");
    check();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function createLocalMcpLauncher({ executable, stdioPath, descriptorPath }) {
  const file = path.join(path.dirname(descriptorPath), "stdio-launcher.sh");
  const content = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${[executable, stdioPath, descriptorPath].map(shellQuote).join(" ")}\n`;
  return {
    entry: { command: "/bin/sh", args: [file] },
    async ready() { return await read(file) === content; },
    async refresh(check = () => {}) {
      check();
      const previous = await read(file);
      if (previous === content) return false;
      await writeAtomically(file, previous, content, check);
      check();
      return true;
    },
  };
}

export function createMyAiMcpConfig(agent, { executable = process.execPath, stdioPath, descriptorPath, env = process.env, home = homedir(), platform = process.platform, stableLauncher = false }) {
  const args = [stdioPath, descriptorPath];
  const directEntry = { command: executable, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
  const absolute = (candidate, fallback) => candidate && path.isAbsolute(candidate) ? candidate : fallback;
  const underHome = (...parts) => path.join(home, ...parts);
  const mainlandWorkBuddy = agent === "workbuddy_cn";
  const guided = agent === "workbuddy" || agent === "qwenwork";
  const openCodeDir = path.join(absolute(env.XDG_CONFIG_HOME, underHome(".config")), "opencode");
  const locations = {
    claude_code: [path.join(absolute(env.CLAUDE_CONFIG_DIR, home), ".claude.json"), ["mcpServers"]],
    claude_desktop: [platform === "win32"
      ? path.join(absolute(env.APPDATA, underHome("AppData", "Roaming")), "Claude", "claude_desktop_config.json")
      : underHome("Library", "Application Support", "Claude", "claude_desktop_config.json"), ["mcpServers"]],
    gemini: [underHome(".gemini", "config", "mcp_config.json"), ["mcpServers"]],
    workbuddy_cn: [underHome(".workbuddy", "mcp.json"), ["mcpServers"]],
    cursor: [underHome(".cursor", "mcp.json"), ["mcpServers"]],
    opencode: [path.join(openCodeDir, "opencode.json"), ["mcp"]],
    openclaw: [absolute(env.OPENCLAW_CONFIG_PATH, path.join(absolute(env.OPENCLAW_STATE_DIR, underHome(".openclaw")), "openclaw.json")), ["mcp", "servers"]],
    hermes: [path.join(absolute(env.HERMES_HOME, underHome(".hermes")), "config.yaml"), ["mcp_servers"]],
    pi: [path.join(absolute(env.PI_CODING_AGENT_DIR, underHome(".pi", "agent")), "mcp.json"), ["mcpServers"]],
    deepseek_harness: [deepseekDesktopMcpFile({ env, home }), []],
  };
  if ((!guided && !Object.hasOwn(locations, agent)) || ![executable, ...args].every(value => typeof value === "string" && path.isAbsolute(value)))
    throw new Error("MCP_CONFIG_INVALID");

  const macGemini = platform === "darwin" && agent === "gemini";
  const managedMacBridge = platform === "darwin" && configurableAgents.includes(agent);
  const legacyDirectEntry = agent === "claude_code" ? { type: "stdio", ...directEntry } : directEntry;
  const launcher = managedMacBridge && (stableLauncher || mainlandWorkBuddy) ? createLocalMcpLauncher({ executable, stdioPath, descriptorPath }) : null;
  const entry = launcher?.entry ?? directEntry;

  // These desktop clients document Connector setup, not a stable writable
  // configuration location. Export the bridge command without pretending that
  // a guessed file has connected the client.
  const configuration = () => ({ mcpServers: { [serverName]: structuredClone(entry) } });
  if (guided) return {
    guided: true,
    configuration,
    getConfiguration: configuration,
    async isConfigured() { return false; },
    async ensure(check) { await launcher?.refresh(check); },
    async remove() {},
  };

  const deepseek = agent === "deepseek_harness";
  const deepseekPatch = transport => ({ id: "mcp-" + serverName, name: "@deepseek-ai/dsh-mcp-client", config: { serverName, transport: "stdio", ...transport } });
  const legacyEntry = deepseek ? deepseekPatch(directEntry) : legacyDirectEntry;

  async function settings() {
    let [file, keys] = locations[agent];
    let previous = await read(file);
    if (agent === "opencode") {
      const jsoncFile = file + "c";
      const commented = await read(jsoncFile);
      if (commented !== null) {
        if (previous !== null) throw new Error("MCP_CONFIG_AMBIGUOUS");
        file = jsoncFile;
        previous = commented;
      }
    }
    const yaml = agent === "hermes" || deepseek;
    const content = previous?.replace(/^\uFEFF/, "").trim() ? previous.replace(/^\uFEFF/, "") : deepseek ? "[]\n" : "{}\n";
    const { value, doc } = parse(content, yaml);
    if (deepseek) {
      if (!Array.isArray(value)) throw new Error("MCP_CONFIG_INVALID");
      const expected = deepseekPatch(entry);
      for (const [rowIndex, patch] of value.entries()) {
        if (!Array.isArray(patch?.insert)) continue;
        const entryIndex = patch.insert.findIndex(row => row?.id === expected.id || row?.config?.serverName === serverName);
        if (entryIndex !== -1) return { file, previous, content, doc, keys: [rowIndex, "insert", entryIndex], current: patch.insert[entryIndex], expected };
      }
      return { file, previous, content, doc, keys: [value.length, "insert", 0], expected };
    }
    if (!mapping(value)) throw new Error("MCP_CONFIG_INVALID");
    let expected = entry;
    if (agent === "claude_code") expected = { type: "stdio", ...entry };
    if (agent === "opencode") {
      if (mapping(value.mcp?.servers)) keys = ["mcp", "servers"];
      expected = { type: "local", command: [executable, ...args], environment: entry.env };
    }
    let current = value;
    for (const key of keys) {
      current = current[key] ?? {};
      if (!mapping(current)) throw new Error("MCP_CONFIG_INVALID");
    }
    return { file, previous, content, doc, keys: [...keys, serverName], current: current[serverName], expected };
  }

  async function isConfigured() {
    const { current, expected } = await settings();
    if (launcher && isDeepStrictEqual(current, legacyEntry)) return true;
    return isDeepStrictEqual(current, expected) && (!launcher || await launcher.ready());
  }

  async function canMigrate(current) {
    if (!managedMacBridge) return false;
    if (isDeepStrictEqual(current, legacyEntry)) return true;
    const { command, args, env } = (deepseek ? current?.config : current) ?? {};
    const transport = deepseek ? { command, args, env } : current;
    if (deepseek && !isDeepStrictEqual(current, deepseekPatch(transport))) return false;
    return await isMovedMacBridge(transport, legacyDirectEntry) ||
      (macGemini && await isRetiredGeminiDevBridge(transport, legacyDirectEntry));
  }

  function isPreviousWorkBuddyEntry(current) {
    if (!mainlandWorkBuddy || platform !== "darwin") return false;
    const profile = path.dirname(descriptorPath);
    if (path.basename(profile) !== "workbuddy_cn" || path.basename(path.dirname(profile)) !== "my-ai-access") return false;
    const previousProfile = path.join(path.dirname(profile), "workbuddy");
    if (isDeepStrictEqual(current, { command: "/bin/sh", args: [path.join(previousProfile, "stdio-launcher.sh")] })) return true;
    if (typeof current?.command !== "string" || !path.isAbsolute(current.command) ||
        !Array.isArray(current.args) || typeof current.args[0] !== "string" || !path.isAbsolute(current.args[0])) return false;
    const bundle = path.resolve(path.dirname(current.command), "../..");
    if (path.basename(bundle) !== "半人马AI记忆盒子.app") return false;
    const [stdio, endpoint] = current.args;
    if (![descriptorPath, path.join(previousProfile, "endpoint.json")].includes(endpoint)) return false;
    const dev = current.command === path.join(bundle, "Contents", "MacOS", "Electron") &&
      stdio.endsWith(path.join(path.sep, "shell", "codex-context-stdio.mjs"));
    const packaged = current.command === path.join(bundle, "Contents", "MacOS", "半人马AI记忆盒子") &&
      stdio === path.join(bundle, "Contents", "Resources", "app.asar", "shell", "codex-context-stdio.mjs");
    return (dev || packaged) && isDeepStrictEqual(current, { ...directEntry, command: current.command, args: [stdio, endpoint] });
  }

  async function write({ file, previous, content, doc, keys }, value, check = () => {}) {
    let updated;
    if (doc) {
      if (value === undefined) doc.deleteIn(keys);
      else doc.setIn(keys, value);
      updated = doc.toString();
    } else {
      updated = jsonc.applyEdits(content, jsonc.modify(content, keys, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: content.includes("\r\n") ? "\r\n" : "\n" },
      }));
    }
    await writeAtomically(file, previous, updated, check);
  }

  async function ensure(check = () => {}) {
    check();
    const state = await settings();
    const configured = isDeepStrictEqual(state.current, state.expected);
    if (configured && !launcher) return { configurationChanged: false };
    if (!configured && state.current !== undefined && !await canMigrate(state.current) && !isPreviousWorkBuddyEntry(state.current))
      throw new Error("MCP_CONFIG_NAME_CONFLICT");
    return install(state, configured, check);
  }

  async function install(state, configured, check) {
    check();
    const launcherChanged = await launcher?.refresh(check) ?? false;
    if (!configured) await write(state, state.expected, check);
    if (!await isConfigured()) throw new Error("MCP_CONFIG_VERIFY_FAILED");
    return { configurationChanged: !configured || launcherChanged };
  }

  return {
    guided: false,
    configuration,
    getConfiguration: configuration,
    isConfigured,
    ...(launcher && {
      restoreWithoutDescriptor: true,
      async restore(check) {
        const state = await settings();
        const configured = isDeepStrictEqual(state.current, state.expected);
        if (!configured && !await canMigrate(state.current)) return false;
        await install(state, configured, check);
        return true;
      },
    }),
    async ensure(check) {
      try { return await ensure(check); }
      catch (error) {
        if (agent === "claude_code" && ["EACCES", "EPERM"].includes(error.code))
          throw new Error("MCP_CONFIG_PERMISSION", { cause: error });
        throw error;
      }
    },
    async remove() {
      const state = await settings();
      if (isDeepStrictEqual(state.current, state.expected) ||
          (launcher && isDeepStrictEqual(state.current, legacyEntry))) await write(state, undefined);
    },
  };
}
