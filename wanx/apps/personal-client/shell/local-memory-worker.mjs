import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const STARTUP_TIMEOUT_MS = 40_000;

function usableLocalUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname) && url.port && url.href === url.origin + "/" ? url : null;
  } catch {
    return null;
  }
}

async function jsonFile(filename) {
  try {
    return JSON.parse((await readFile(filename, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function samePath(expected, actual) {
  if (typeof actual !== "string" || !path.isAbsolute(actual)) return false;
  const canonical = value => realpath(value).catch(() => path.resolve(value));
  const [a, b] = await Promise.all([canonical(expected), canonical(actual)]);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readEndpoint(base, route, headers = {}, method = "GET") {
  try {
    const response = await fetch(new URL(route, base), {
      method, headers, redirect: "error", signal: AbortSignal.timeout(2000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return {};
  }
}

async function readyEngine(record, configFile, databasePath, token) {
  const endpoint = usableLocalUrl(record?.endpoint);
  if (record?.status !== "ready" || !processExists(record.pid) || !endpoint ||
      !await samePath(configFile, record.configPath) || !await samePath(databasePath, record.sqlitePath)) return null;
  const storage = await readEndpoint(endpoint, "/api/v1/admin/wanx-storage", { authorization: `Bearer ${token}` });
  return storage.status === 200 && await samePath(path.dirname(databasePath), storage.body?.dataPath)
    ? { endpoint, sourceProfile: storage.body?.sourceProfile } : null;
}

async function ensureEngine({ configFile, databasePath, serviceHome, engineEntry, config }) {
  const desired = usableLocalUrl(config.storage.endpoint);
  if (!desired) throw new Error("MEMORY_ENGINE_ENDPOINT_INVALID");
  const end = Date.now() + STARTUP_TIMEOUT_MS;
  let child;
  let childFailed = false;
  let retiring;
  const runtimeStateFile = path.join(serviceHome, "runtime.json");
  const serviceLock = path.join(serviceHome, "service.lock");
  while (Date.now() < end) {
    const record = await jsonFile(runtimeStateFile);
    // Let the retiring engine drain its keep-alive connections before polling it again.
    const ready = retiring === record?.pid ? null : await readyEngine(record, configFile, databasePath, config.storage.token);
    if (ready) {
      if (process.env.MEMMY_UNIFY_AGENT_SOURCES === "1" && ready.sourceProfile) {
        if (!["codex-desktop", "codex-cli"].includes(ready.sourceProfile)) throw new Error("MEMORY_SOURCE_PROFILE_UNKNOWN");
        if (retiring !== record.pid) {
          const stopped = await readEndpoint(ready.endpoint, "/api/v1/admin/shutdown", { authorization: `Bearer ${config.storage.token}` }, "POST");
          if (![200, 202].includes(stopped.status)) throw new Error("MEMORY_SOURCE_UPGRADE_FAILED");
          retiring = record.pid;
        }
      } else return ready.endpoint;
    }

    // A running owner may be starting up or moving its SQLite database.
    // The engine also holds its own exclusive service and database locks.
    const lock = await jsonFile(serviceLock).catch(error => {
      if (error instanceof SyntaxError) return { creating: true };
      throw error;
    });
    if (!lock?.creating && !processExists(lock?.pid) && !processExists(record?.pid)) {
      if (childFailed) throw new Error("MEMORY_ENGINE_START_FAILED");
      if (!child) {
        const occupied = await readEndpoint(desired, "/api/v1/health");
        if (occupied.status !== undefined) throw new Error("MEMORY_ENGINE_ENDPOINT_IN_USE");
        child = spawn(process.execPath, [engineEntry, "--config", configFile, "--db", databasePath,
          "--host", desired.hostname.replace(/^\[|\]$/g, ""), "--port", desired.port], {
          env: process.env, detached: true, stdio: "ignore", windowsHide: true,
        });
        child.on("error", () => { childFailed = true; });
        child.once("exit", () => { childFailed = true; });
        child.unref();
      }
    }
    await delay(200);
  }
  throw new Error("MEMORY_ENGINE_NOT_READY");
}

async function probeApi(descriptor, engine) {
  const configured = await jsonFile(descriptor).catch(error => {
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  const endpoint = usableLocalUrl(configured?.baseUrl);
  if (!endpoint || endpoint.hostname !== "127.0.0.1" || typeof configured.localToken !== "string" || !configured.localToken) return false;
  const headers = { "x-memmy-local-token": configured.localToken };
  if (usableLocalUrl(configured.memory?.baseUrl)?.origin !== engine.origin) return false;
  const bootstrap = await readEndpoint(endpoint, "/api/app/bootstrap", headers);
  if (bootstrap.status !== 200 || !bootstrap.body) return false;
  const health = await readEndpoint(endpoint, "/api/v1/health", headers);
  if (health.status !== 200 || health.body?.storage?.ready !== true) return false;
  return true;
}

async function run(sourceRoot, runtimeHome, descriptor, apiDatabasePath) {
  if (![sourceRoot, runtimeHome, descriptor, apiDatabasePath].every(value => typeof value === "string" && path.isAbsolute(value)))
    throw new Error("MEMORY_RUNTIME_ARGUMENTS_INVALID");
  const modulePath = (...parts) => pathToFileURL(path.join(sourceRoot, ...parts)).href;
  const memory = (...parts) => modulePath("Memory", "dist", "src", ...parts);
  const api = (...parts) => modulePath("App", "backend", "dist", "src", ...parts);
  const configFile = path.join(runtimeHome, "config.yaml");
  const serviceHome = path.join(runtimeHome, "memory-service");
  const defaultDatabasePath = path.join(serviceHome, "memory.sqlite");
  const engineEntry = path.join(sourceRoot, "Memory", "dist", "src", "server", "index.js");
  const persisted = await jsonFile(path.join(serviceHome, "wanx-storage.json"));
  if (persisted && (typeof persisted.databasePath !== "string" || !path.isAbsolute(persisted.databasePath) ||
      !(await stat(persisted.databasePath).catch(() => null))?.isFile())) throw new Error("MEMORY_DATABASE_UNAVAILABLE");

  // Reuse the application's config writer so initial config and engine updates share a lock.
  if (!existsSync(configFile)) {
    const { mutateMemoryConfig } = await import(memory("config", "writer.js"));
    await mutateMemoryConfig(configFile, root => {
      if (existsSync(configFile)) return;
      const isolated = Boolean(process.env.MEMMY_ISOLATED_CODEX_PROFILE) || process.env.MEMMY_UNIFY_AGENT_SOURCES === "1";
      root.memmyMemory = { storage: { mode: "local", backend: "sqlite", sqlitePath: defaultDatabasePath,
        endpoint: isolated ? "http://127.0.0.1:0" : "http://127.0.0.1:18960", token: randomBytes(32).toString("hex") },
        ...(isolated ? { agentAccess: { autoInjectSkill: false, autoScanKnownAgents: false, watchFileChanges: false } } : {}) };
    });
  }
  const { loadMemmyConfig } = await import(memory("config", "index.js"));
  const { config } = loadMemmyConfig(configFile);
  if (config.storage.mode !== "local" || config.storage.backend !== "sqlite" || !config.storage.token)
    throw new Error("MEMORY_LOCAL_STORAGE_UNAVAILABLE");
  const databasePath = persisted?.databasePath ?? config.storage.sqlitePath ?? defaultDatabasePath;
  if (!path.isAbsolute(databasePath)) throw new Error("MEMORY_DATABASE_PATH_INVALID");
  if (!await samePath(defaultDatabasePath, databasePath) && !(await stat(databasePath).catch(() => null))?.isFile())
    throw new Error("MEMORY_DATABASE_UNAVAILABLE");

  process.env.MEMMY_RUNTIME_CONFIG_PATH = descriptor;
  const engine = await ensureEngine({ configFile, databasePath, serviceHome, engineEntry, config });
  if (await probeApi(descriptor, engine)) return;

  if (!process.env.MEMMY_CLOUD_SERVICE?.trim() && !process.env.MEMMY_CLOUD_URL?.trim()) {
    process.env.MEMMY_CLOUD_URL = "http://127.0.0.1:1";
  }
  const [{ createLocalBackend }, { createHttpMemoryClient }] = await Promise.all([
    import(api("index.js")), import(api("adapters", "outbound", "memory-client", "index.js")),
  ]);
  await mkdir(path.dirname(apiDatabasePath), { recursive: true });
  const backend = await createLocalBackend({
    databasePath: apiDatabasePath, memmyConfigPath: configFile, runtimeConfigPath: descriptor,
    memoryBaseUrl: engine.origin,
    memoryClient: createHttpMemoryClient({ baseUrl: engine.origin, token: config.storage.token, timeoutMs: 20_000, maxRetries: 0 }),
    skipAgentMcpReload: true,
  });
  try {
    if (!await probeApi(descriptor, engine)) throw new Error("MEMORY_API_NOT_READY");
  } catch (error) {
    await backend.close();
    throw error;
  }
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void backend.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

run(...process.argv.slice(2)).catch(error => {
  const code = /^MEMORY_[A-Z_]+$/.test(error?.message) ? error.message : "MEMORY_SERVICE_START_FAILED";
  process.stderr.write(code + "\n");
  process.exitCode = 1;
});
