import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractFile } from "@electron/asar";
import { smokePackagedMemory } from "../../../tools/smoke-packaged-memory.mjs";
import { requiredRuntimeFiles } from "../../../tools/stage-local-memory.mjs";
import { buildMemoryWorkspace } from "./build-memory.mjs";
import { probeMemoryRuntime } from "./prepare-memory-runtime.mjs";

export function assertPackagedMemoryTarget({ platform = process.platform, arch = process.arch } = {}) {
  // The installed native dependencies and Electron smoke must match the target.
  if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch) ||
      platform !== process.platform || arch !== process.arch) {
    throw new Error("CLIENT_MEMORY_TARGET_HOST_MISMATCH:" + platform + "-" + arch +
      " (run the packager using a matching Node and Electron architecture)");
  }
}

export function packagedMemoryResources(clientRoot) {
  const runtime = path.join(clientRoot, "build", "local-memory");
  return [
    { from: runtime, to: "local-memory" },
    // electron-builder excludes a FileSet source's root node_modules even for extraResources.
    { from: path.join(runtime, "node_modules"), to: "local-memory/node_modules" },
  ];
}

export async function preparePackagedMemory({
  clientRoot, platform = process.platform, arch = process.arch, env = process.env,
  build = buildMemoryWorkspace, probe = probeMemoryRuntime,
}) {
  assertPackagedMemoryTarget({ platform, arch });
  const buildEnv = { ...env };
  // Release builds always ship a self-contained runtime from this checkout.
  delete buildEnv.WANX_MEMORY_BOX_ROOT;
  delete buildEnv.MEMMY_RUNTIME_CONFIG_PATH;
  const { runtime, output } = await build({ clientRoot, env: buildEnv });
  if (!runtime) throw new Error("CLIENT_MEMORY_RUNTIME_MISSING");
  assertNativeProbe(probe({ runtime, clientRoot, env: buildEnv }), { platform, arch });
  return { runtime, output, extraResources: packagedMemoryResources(clientRoot) };
}

function assertNativeProbe(result, { platform, arch }) {
  if (result?.ok !== true || result.platform !== platform || result.arch !== arch)
    throw new Error("CLIENT_MEMORY_NATIVE_SMOKE_FAILED:" + platform + "-" + arch);
  return result;
}

function verifyMemoryFrontend(archive) {
  try {
    const extract = name => extractFile(archive, path.join("local-ui", "memory", name));
    const html = extract("wanx-memory.html").toString("utf8");
    const assets = [...html.matchAll(/(?:src|href)=["']\.\/(assets\/[A-Za-z0-9._-]+\.(?:js|css))["']/g)]
      .map(match => match[1]);
    if (!assets.some(name => name.endsWith(".js")) || !assets.some(name => name.endsWith(".css"))) throw new Error();
    for (const name of assets) if (!extract(name).length) throw new Error();
  } catch {
    throw new Error("CLIENT_MEMORY_FRONTEND_MISSING");
  }
}

async function requireFile(file, relative) {
  const entry = await lstat(file).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!entry?.isFile() || entry.size === 0) throw new Error("CLIENT_MEMORY_RESOURCE_MISSING:" + relative);
}

export async function verifyPackagedMemoryLayout({ resourcesPath, platform = process.platform }) {
  const archive = path.join(resourcesPath, "app.asar");
  verifyMemoryFrontend(archive);
  try {
    if (!extractFile(archive, path.join("shell", "local-memory-worker.mjs")).length) throw new Error();
  } catch {
    throw new Error("CLIENT_MEMORY_WORKER_MISSING");
  }
  try {
    if (!extractFile(archive, path.join("host-sdk", "drive.cjs")).length) throw new Error();
  } catch {
    throw new Error("CLIENT_MEMORY_BACKUP_SDK_MISSING:host-sdk/drive.cjs");
  }
  const runtime = path.join(resourcesPath, "local-memory");
  const manifestName = "runtime-manifest.json";
  const files = ["package.json", manifestName, ...requiredRuntimeFiles];
  await Promise.all(files.map(name => requireFile(path.join(runtime, name), name)));
  const manifest = JSON.parse(await readFile(path.join(runtime, manifestName), "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.nativeModules) || !manifest.nativeModules.length ||
      manifest.nativeModules.some(relative =>
        typeof relative !== "string" || !/^(?:[A-Za-z0-9@_-][A-Za-z0-9@_.-]*\/)*better-sqlite3$/.test(relative))) {
    throw new Error("CLIENT_MEMORY_NATIVE_MANIFEST_INVALID");
  }
  for (const name of new Set(["node_modules/better-sqlite3", ...manifest.nativeModules])) {
    const packageManifest = name + "/package.json";
    await requireFile(path.join(runtime, packageManifest), packageManifest);
  }
  if (platform === "win32") {
    const acl = "security/windows-private-acl.ps1";
    await requireFile(path.join(resourcesPath, acl), acl);
  }
  return runtime;
}

export async function verifyPackagedMemory({
  resourcesPath, executable, platform = process.platform, arch = process.arch,
}) {
  assertPackagedMemoryTarget({ platform, arch });
  const runtime = await verifyPackagedMemoryLayout({ resourcesPath, platform });
  const native = assertNativeProbe(probeMemoryRuntime({ runtime, executable }), { platform, arch });
  const smoke = await smokePackagedMemory({ executable, resources: resourcesPath, temporary: os.tmpdir() });
  return { ...smoke, native };
}
