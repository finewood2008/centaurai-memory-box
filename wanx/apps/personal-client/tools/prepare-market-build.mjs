import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { readProjectManifest, stageMarketOutput } from "./package-market-app.mjs";

async function regularPath(root, relative, directory = false) {
  const parts = relative.split("/");
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    const info = await lstat(current);
    const folder = index < parts.length - 1 || directory;
    if (info.isSymbolicLink() || (folder ? !info.isDirectory() : !info.isFile()))
      throw new Error("应用构建输入不能包含链接或特殊文件。");
    if (!folder && info.size > 128 * 1024) throw new Error("应用构建清单不能超过 128 KiB。");
  }
}

async function validateBuildOutput(project) {
  await regularPath(project, "market/wanx-app.json");
  await regularPath(project, "package.json");
  await regularPath(project, "dist/application", true);
  await regularPath(project, "dist/application/application.manifest.json");
  await regularPath(project, "dist/application/package.json");
  const pending = [path.join(project, "dist/application")];
  let entries = 0, bytes = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error("应用构建产物不能包含链接或特殊文件。");
      if (info.isDirectory()) pending.push(file);
      else bytes += info.size;
      if (++entries > 20000 || bytes > 2 * 1024 ** 3)
        throw new Error("应用构建产物超过文件数量或总大小限制。");
    }
  }
}

// Validate an isolated build's output before the trusted packaging/signing step.
// This entry point never runs application scripts or reads a signing key.
export async function prepareMarketBuild({ project, version, outputDir, dependencyConfig }) {
  project = path.resolve(project);
  outputDir = path.resolve(outputDir);
  const relative = path.relative(project, outputDir);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    throw new Error("暂存目录必须位于应用工程之外。");
  // The build container has stopped. Reject its entire output before host-side
  // reads/copies can follow a link into the signing machine's filesystem.
  await validateBuildOutput(project);
  const { manifest } = await readProjectManifest(project, version);
  await mkdir(path.dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  try {
    await stageMarketOutput(project, outputDir, manifest, { dependencyConfig });
    return { sourceDir: outputDir, applicationId: manifest.applicationId, version: manifest.version };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(
      ["project", "version", "out", "dependency-config"].map(name => [name, { type: "string" }]),
    ) });
    if (!values.project || !values.version || !values.out)
      throw new Error("用法：node prepare-market-build.mjs --project <工程> --version <版本> --out <新暂存目录> [--dependency-config <配置>]");
    const dependencyConfig = values["dependency-config"]
      ? JSON.parse(await readFile(values["dependency-config"], "utf8")) : undefined;
    console.log(JSON.stringify(await prepareMarketBuild({
      project: values.project, version: values.version, outputDir: values.out, dependencyConfig,
    })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
