import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function readMemoryConnection(file) {
  const data = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  const base = new URL(data.baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port ||
    base.username || base.password || base.href !== base.origin + "/" ||
    typeof data.localToken !== "string" || !data.localToken) throw new Error("MEMORY_RUNTIME_INVALID");
  return { base, token: data.localToken };
}

export function resolveManagedMemorySource({ appPath, packaged, resourcesPath, env = process.env }) {
  const sourceMarker = path.join(appPath, "local-ui", "memory", ".wanx-source");
  let root;
  if (packaged) {
    root = path.join(resourcesPath, "local-memory");
  } else if (env.WANX_MEMORY_BOX_ROOT?.trim()) {
    root = path.resolve(env.WANX_MEMORY_BOX_ROOT.trim());
  }
  return root ? usableSource(root) : sourceFromMarker(sourceMarker);
}

function usableSource(root) {
  return ["Memory/dist/src/server/index.js", "App/backend/dist/src/index.js"]
    .every(file => existsSync(path.join(root, file))) ? root : null;
}

async function sourceFromMarker(file) {
  try {
    const root = (await readFile(file, "utf8")).trim();
    return path.isAbsolute(root) ? usableSource(root) : null;
  } catch { return null; }
}

export function createMemoryRuntimeSupervisor({
  runtimeFile, source, appPath, appData, env = process.env, home = homedir(), executable = process.execPath,
  request = fetch, start = spawn, timeoutMs = 60_000, retryMs = 350,
} = {}) {
  let pending;
  const runtimeHome = env.MEMMY_HOME?.trim() || path.join(home, ".memmy");

  async function ready() {
    try {
      const { base, token } = await readMemoryConnection(runtimeFile);
      const response = await request(new URL("/api/v1/health", base), {
        headers: { "x-memmy-local-token": token },
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const health = await response.json();
      return health?.ok === true && health.storage?.ready === true;
    } catch { return false; }
  }

  async function recover() {
    if (await ready()) return;
    const root = await source;
    if (!root) throw new Error("MEMORY_RUNTIME_NOT_INSTALLED");
    const database = path.join(appData, "Memmy", "app.sqlite");
    const worker = path.join(appPath, "shell", "local-memory-worker.mjs");
    const child = start(executable, [worker, root, runtimeHome, runtimeFile, database], {
      windowsHide: true, detached: true, stdio: "ignore",
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", MEMMY_RUNTIME_CONFIG_PATH: runtimeFile },
    });
    let failed = false;
    child.once("error", () => { failed = true; });
    child.once("exit", code => { failed = code !== 0; });
    child.unref();
    const deadline = Date.now() + timeoutMs;
    do {
      if (await ready()) return;
      if (failed) throw new Error("MEMORY_RUNTIME_START_FAILED");
      await delay(retryMs);
    } while (Date.now() < deadline);
    throw new Error("MEMORY_RUNTIME_START_TIMEOUT");
  }

  function ensure() {
    pending ??= recover().finally(() => { pending = undefined; });
    return pending;
  }

  return { ensure, waitForStartup: () => pending };
}
