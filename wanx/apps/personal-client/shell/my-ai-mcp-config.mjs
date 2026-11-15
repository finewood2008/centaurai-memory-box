import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import jsonc from "jsonc-parser";
import { parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";

export const configurableAgents = ["claude_code", "cursor", "opencode", "openclaw", "hermes", "pi", "workbuddy", "deepseek_harness"];
const serverName = "wanx-memobox";
const mapping = value => value && typeof value === "object" && !Array.isArray(value);

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

export function createMyAiMcpConfig(agent, { executable = process.execPath, stdioPath, descriptorPath, env = process.env, home = homedir() }) {
  const args = [stdioPath, descriptorPath];
  const entry = { command: executable, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
  const absolute = (candidate, fallback) => candidate && path.isAbsolute(candidate) ? candidate : fallback;
  const underHome = (...parts) => path.join(home, ...parts);
  const openCodeDir = path.join(absolute(env.XDG_CONFIG_HOME, underHome(".config")), "opencode");
  const locations = {
    claude_code: [path.join(absolute(env.CLAUDE_CONFIG_DIR, home), ".claude.json"), ["mcpServers"]],
    cursor: [underHome(".cursor", "mcp.json"), ["mcpServers"]],
    opencode: [path.join(openCodeDir, "opencode.json"), ["mcp"]],
    openclaw: [absolute(env.OPENCLAW_CONFIG_PATH, path.join(absolute(env.OPENCLAW_STATE_DIR, underHome(".openclaw")), "openclaw.json")), ["mcp", "servers"]],
    hermes: [path.join(absolute(env.HERMES_HOME, underHome(".hermes")), "config.yaml"), ["mcp_servers"]],
    pi: [path.join(absolute(env.PI_CODING_AGENT_DIR, underHome(".pi", "agent")), "mcp.json"), ["mcpServers"]],
    workbuddy: [path.join(absolute(env.WORKBUDDY_CONFIG_DIR, underHome(".workbuddy")), "mcp.json"), ["mcpServers"]],
    deepseek_harness: [path.join(absolute(env.DSH_HOME, underHome(".dsh")), "cordis.patch.yml"), []],
  };
  if (!Object.hasOwn(locations, agent) || ![executable, ...args].every(value => typeof value === "string" && path.isAbsolute(value)))
    throw new Error("MCP_CONFIG_INVALID");

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
    const deepseek = agent === "deepseek_harness";
    const yaml = agent === "hermes" || deepseek;
    const content = previous?.replace(/^\uFEFF/, "").trim() ? previous.replace(/^\uFEFF/, "") : deepseek ? "[]\n" : "{}\n";
    const { value, doc } = parse(content, yaml);
    if (deepseek) {
      if (!Array.isArray(value)) throw new Error("MCP_CONFIG_INVALID");
      const expected = { id: "mcp-" + serverName, name: "@deepseek-ai/dsh-mcp-client", config: { serverName, transport: "stdio", ...entry } };
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
    return isDeepStrictEqual(current, expected);
  }

  async function write({ file, previous, content, doc, keys }, value) {
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
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID();
    try {
      await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
      if (await read(file) !== previous) throw new Error("MCP_CONFIG_CHANGED");
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    isConfigured,
    async ensure() {
      const state = await settings();
      if (isDeepStrictEqual(state.current, state.expected)) return;
      if (state.current !== undefined) throw new Error("MCP_CONFIG_NAME_CONFLICT");
      await write(state, state.expected);
      if (!await isConfigured()) throw new Error("MCP_CONFIG_VERIFY_FAILED");
    },
    async remove() {
      const state = await settings();
      if (isDeepStrictEqual(state.current, state.expected)) await write(state, undefined);
    },
  };
}
