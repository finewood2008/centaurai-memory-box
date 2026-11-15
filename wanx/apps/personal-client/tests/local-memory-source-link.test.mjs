import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { linkLocalMemorySource } from "../tools/local-memory-source-link.mjs";

test("development source link executes main and forwards all modules required by the worker", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "memobox-source-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const resourcesPath = path.join(root, "resources");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "package.json"), '{"type":"module"}');
  const captured = path.join(root, "called.json");
  for (const [module, content] of [
    ["Memory/dist/src/server/index.js", `import {writeFile} from 'node:fs/promises'; export async function main(args) { await writeFile(${JSON.stringify(captured)},JSON.stringify(args)); }`],
    ["Memory/dist/src/config/index.js", "export const config = 'synthetic';"],
    ["Memory/dist/src/config/writer.js", "export function mutateMemoryConfig() {}"],
    ["App/backend/dist/src/index.js", "export function createLocalBackend() {}"],
    ["App/backend/dist/src/adapters/outbound/memory-client/index.js", "export function createHttpMemoryClient() {}"],
  ]) {
    const file = path.join(sourceRoot, module); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  }
  const target = await linkLocalMemorySource({ sourceRoot, resourcesPath });
  await promisify(execFile)(process.execPath, [path.join(target, "Memory/dist/src/server/index.js"), "--config", "a literal path with spaces", "--port", "0"]);
  assert.deepEqual(JSON.parse(await readFile(captured, "utf8")), ["--config", "a literal path with spaces", "--port", "0"]);
  const client = await import(pathToFileURL(path.join(target, "App/backend/dist/src/adapters/outbound/memory-client/index.js")));
  assert.equal(typeof client.createHttpMemoryClient, "function");
  await assert.rejects(linkLocalMemorySource({ sourceRoot: root, resourcesPath }), /SOURCE_NOT_BUILT/);
});
