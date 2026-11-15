import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export const localMemoryLibrary = Object.freeze({ id: "legacy", name: "本机记忆库" });
export const memoryLibraries = Object.freeze([localMemoryLibrary]);
const oldProfiles = new Set(["codex-desktop", "codex-cli"]);

// Old selections identify an existing storage location, never a collection mode.
// Keep using its records without merging or deleting any other historical store.
export async function readMemoryLibrary(userData) {
  let previous;
  try { previous = (await readFile(path.join(userData, "memory-library"), "utf8")).trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return oldProfiles.has(previous) ? { ...localMemoryLibrary, previousProfile: previous } : localMemoryLibrary;
}

export async function saveMemoryLibrary(userData, id) {
  if (id !== localMemoryLibrary.id) throw new Error("记忆统一采集到本机记忆库，不按智能体分库。");
  const filename = path.join(userData, "memory-library");
  const temporary = filename + "." + randomUUID();
  await writeFile(temporary, id + "\n", { mode: 0o600, flag: "wx", flush: true });
  await rename(temporary, filename);
}

export function memoryLibraryRuntime(library, userData, env = process.env) {
  const priorRoot = oldProfiles.has(library.previousProfile) ? path.join(userData, "memory-libraries", library.previousProfile) : undefined;
  const memoryHome = priorRoot ? path.join(priorRoot, "memory") : env.MEMMY_HOME?.trim() || path.join(homedir(), ".memmy");
  const root = priorRoot;
  const unified = { ...env, MEMMY_HOME: memoryHome, MEMMY_MEMORY_HOME: path.join(memoryHome, "memory-service"),
    MEMMY_UNIFY_AGENT_SOURCES: "1" };
  delete unified.MEMMY_ISOLATED_CODEX_PROFILE;
  return { root, env: unified };
}
