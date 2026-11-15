import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { resolveGeminiHomeDirectory } from "../../agent-paths.js";
import { createNodeHookCommand } from "../hook-command.js";
import type { SkillTarget } from "../types.js";
import { renderGeminiCaptureHook } from "./capture-hook.js";

const hookName = "memobox-gemini-capture";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Hook-only target. It deliberately never edits GEMINI.md or trust settings. */
export function createGeminiSkillTarget({ rootDirectory = resolveGeminiHomeDirectory() }: { rootDirectory?: string } = {}): SkillTarget {
  const settingsFile = join(rootDirectory, "settings.json");
  const hookFile = join(rootDirectory, "hooks", "memobox-after-agent.mjs");
  const script = renderGeminiCaptureHook(join(rootDirectory, "memobox-captures"));
  const command = createNodeHookCommand(hookFile);
  const expected = { hooks: [{ name: hookName, type: "command", command, timeout: 5000 }] };
  const owned = (group: unknown) => object(group) && Array.isArray(group.hooks) && group.hooks.length === 1 &&
    object(group.hooks[0]) && group.hooks[0].name === hookName && group.hooks[0].command === command;

  async function readSettings() {
    const previous = await text(settingsFile);
    const errors: ParseError[] = [];
    const value: unknown = parse(previous || "{}", errors, { allowTrailingComma: true });
    if (errors.length || !object(value) || (value.hooks !== undefined && !object(value.hooks))) throw new Error("Invalid Gemini hook settings");
    const hooks = object(value.hooks) ? value.hooks : {};
    if (hooks.AfterAgent !== undefined && !Array.isArray(hooks.AfterAgent)) throw new Error("Invalid Gemini AfterAgent hooks");
    return { previous, groups: (hooks.AfterAgent ?? []) as unknown[] };
  }

  async function change(remove: boolean) {
    if (!(await lstat(rootDirectory)).isDirectory()) throw new Error("Gemini configuration directory is unavailable");
    const state = await readSettings();
    const groups = state.groups.filter(group => !owned(group));
    if (!remove) {
      if (groups.some(group => object(group) && Array.isArray(group.hooks) && group.hooks.some(hook => object(hook) && hook.name === hookName)))
        throw new Error("Gemini capture hook name is already in use");
      const previousScript = await text(hookFile);
      if (previousScript && previousScript !== script) throw new Error("Gemini capture script already exists with different contents");
      await atomicWrite(hookFile, script);
      groups.push(expected);
    }
    const updated = applyEdits(state.previous || "{}\n", modify(state.previous || "{}\n", ["hooks", "AfterAgent"], groups.length ? groups : undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: state.previous.includes("\r\n") ? "\r\n" : "\n" },
    }));
    if (await text(settingsFile) !== state.previous) throw new Error("Gemini settings changed; retry configuration");
    if (updated !== state.previous) await atomicWrite(settingsFile, updated);
    if (remove && await text(hookFile) === script) await rm(hookFile, { force: true });
  }

  return {
    targetId: "gemini", displayName: "Gemini CLI",
    async resolveRootDirectory() {
      try { return (await lstat(rootDirectory)).isDirectory() ? rootDirectory : null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    async install() { await change(false); }, async installPlugin() { await change(false); },
    async uninstall() { await change(true); }, async uninstallPlugin() { await change(true); },
    async isInstalled() { return (await readSettings()).groups.some(owned) && await text(hookFile) === script; },
    async isInstalledHookCurrent() { return (await readSettings()).groups.some(owned) && await text(hookFile) === script; },
  };
}

async function text(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("Invalid Gemini configuration file");
    return await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function atomicWrite(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (!(await lstat(dirname(file))).isDirectory()) throw new Error("Invalid Gemini configuration directory");
  await text(file);
  const temporary = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, value, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
