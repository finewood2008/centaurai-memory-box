import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Development .app shells need a complete executable entry and module surface.
// Production packages continue to ship their own complete local-memory runtime.
export async function linkLocalMemorySource({ sourceRoot, resourcesPath }) {
  if (![sourceRoot, resourcesPath].every(value => typeof value === "string" && path.isAbsolute(value)))
    throw new Error("LOCAL_MEMORY_SOURCE_PATH_INVALID");
  const target = path.join(resourcesPath, "local-memory");
  if (path.resolve(target) === path.resolve(sourceRoot)) throw new Error("LOCAL_MEMORY_SOURCE_TARGET_CONFLICT");
  const modules = [
    "Memory/dist/src/server/index.js", "Memory/dist/src/config/index.js", "Memory/dist/src/config/writer.js",
    "App/backend/dist/src/index.js", "App/backend/dist/src/adapters/outbound/memory-client/index.js",
  ];
  for (const module of modules) {
    if (!(await stat(path.join(sourceRoot, module)).catch(() => null))?.isFile()) throw new Error("LOCAL_MEMORY_SOURCE_NOT_BUILT");
  }
  for (const module of modules) {
    const file = path.join(target, module);
    const url = JSON.stringify(pathToFileURL(path.join(sourceRoot, module)).href);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, module === modules[0]
      ? `const { main } = await import(${url});\nawait main(process.argv.slice(2));\n`
      : `export * from ${url};\n`);
  }
  await writeFile(path.join(target, "package.json"), JSON.stringify({ name: "memobox-local-memory-source-link", private: true, type: "module" }) + "\n");
  return target;
}
