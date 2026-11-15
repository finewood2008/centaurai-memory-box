import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const memoryLibraries = Object.freeze([
  { id: "legacy", name: "旧版混合库" },
  { id: "codex-desktop", name: "Codex Desktop" },
  { id: "codex-cli", name: "Codex CLI" },
]);

export function readMemoryLibrary(userData) {
  return readFile(path.join(userData, "memory-library"), "utf8").then(value => {
    const library = memoryLibraries.find(item => item.id === value.trim());
    if (!library) throw new Error("无法识别所选本机记忆库。");
    return library;
  }, error => {
    if (error.code === "ENOENT") return memoryLibraries[0];
    throw error;
  });
}

export async function saveMemoryLibrary(userData, id) {
  if (!memoryLibraries.some(item => item.id === id)) throw new Error("无效的本机记忆库。");
  const filename = path.join(userData, "memory-library");
  const temporary = filename + "." + randomUUID();
  await writeFile(temporary, id + "\n", { mode: 0o600, flag: "wx", flush: true });
  await rename(temporary, filename);
}

export function memoryLibraryRuntime(library, userData, env = process.env) {
  if (library.id === "legacy") return null;
  const root = path.join(userData, "memory-libraries", library.id);
  const memoryHome = path.join(root, "memory");
  return { root, env: { ...env, MEMMY_HOME: memoryHome, MEMMY_MEMORY_HOME: path.join(memoryHome, "memory-service"),
    MEMMY_RUNTIME_CONFIG_PATH: "", MEMMY_ISOLATED_CODEX_PROFILE: library.id } };
}
