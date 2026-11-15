import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, main, writeCurrentEndpoint } from "../src/server/index.js";
import * as memoryHttp from "../src/server/http.js";
import * as memoryRestart from "../src/server/service-restart.js";
import { MemoryDb } from "../src/storage/db.js";
import { bindWanxSourceProfile, copyWanxDatabase, prepareWanxRestore } from "../src/server/wanx-storage.js";

describe("memmy memory server entrypoint", () => {
  it("checks the source inside a SQLite snapshot before restoring it", async () => {
    const root = mkdtempSync(join(tmpdir(), "memobox-source-profile-"));
    const cli = new MemoryDb({ path: join(root, "cli.sqlite") });
    const desktop = new MemoryDb({ path: join(root, "desktop.sqlite") });
    try {
      bindWanxSourceProfile(cli, "codex-cli", true);
      bindWanxSourceProfile(desktop, "codex-desktop", true);
      expect(() => bindWanxSourceProfile(cli, "codex-desktop", false)).toThrow(/different source/);
      const cliFile = await copyWanxDatabase(cli, root);
      await expect(prepareWanxRestore(cliFile, root, "codex-desktop")).rejects.toThrow(/备份/);
      await expect(prepareWanxRestore(cliFile, root)).rejects.toThrow(/备份/);
      await expect(prepareWanxRestore(cliFile, root, "codex-cli")).resolves.toMatch(/\.sqlite$/);
    } finally { cli.close(); desktop.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("gives shutdown priority over restart while cleanup is still pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-restart-shutdown-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {
      storage: { mode: "local", backend: "sqlite", sqlitePath: join(root, "memory.sqlite") },
    } }));
    const listeners = ["SIGINT", "SIGTERM", "exit"].map((signal) => process.listenerCount(signal));
    vi.stubEnv("MEMMY_DESKTOP_MANAGED_MEMORY", "1");
    const originalRestart = memoryRestart.requestMemoryServiceRestart;
    vi.spyOn(memoryRestart, "requestMemoryServiceRestart").mockImplementation((dependencies) =>
      originalRestart({ ...dependencies, send: null }));
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((done) => { finishCleanup = done; });
    const originalClose = memoryHttp.closeMemoryHttpServer;
    const close = vi.spyOn(memoryHttp, "closeMemoryHttpServer").mockImplementation(async (server) => {
      await cleanup;
      await originalClose(server);
    });
    const create = vi.spyOn(memoryHttp, "createMemoryHttpServer");
    const running = main(["--config", configPath, "--host", "127.0.0.1", "--port", "0"]);
    try {
      const endpoint = await waitForWrittenEndpoint(configPath);
      const response = await waitForResponse(`${endpoint}/api/v1/system/restart`, 202, {
          method: "POST",
          headers: { "x-memmy-viewer": "1", "content-type": "application/json" },
          body: "{}",
        });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      create.mock.calls[0]![0].onShutdownRequested?.();
      finishCleanup();
      await running;
      expect(create).toHaveBeenCalledOnce();
      expect(["SIGINT", "SIGTERM", "exit"].map((signal) => process.listenerCount(signal))).toEqual(listeners);
      expect(existsSync(join(root, "memory-service", "service.lock"))).toBe(false);
    } finally {
      create.mock.calls[0]?.[0].onShutdownRequested?.();
      finishCleanup();
      await running;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes Windows packaged paths as direct server execution", () => {
    const entry = "C:\\Users\\tester\\AppData\\Local\\Programs\\Memmy\\resources\\app.asar\\dist\\runtime\\memory\\src\\server\\index.js";

    expect(isDirectRun(entry, entry)).toBe(true);
    expect(isDirectRun(
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Memmy\\resources\\app.asar\\dist\\runtime\\memory\\src\\cli\\index.js",
      entry
    )).toBe(false);
  });

  it("patches only the Memory endpoint and preserves unknown catalog fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-server-config-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      futureSection: { keepMe: true },
      providers: {
        openai: {
          futureProviderField: "keep-provider",
          endpoints: { chat: { futureEndpointField: "keep-endpoint" } }
        }
      },
      modelPresets: {
        "future-preset": { futurePresetField: "keep-preset" }
      },
      memmyMemory: {
        futureMemoryField: "keep-memory",
        storage: { endpoint: "http://old.local", futureStorageField: "keep-storage" }
      }
    }));

    try {
      await writeCurrentEndpoint(configPath, "http://127.0.0.1:18960");
      const saved = YAML.parse(readFileSync(configPath, "utf8"));
      expect(saved).toMatchObject({
        futureSection: { keepMe: true },
        providers: {
          openai: {
            futureProviderField: "keep-provider",
            endpoints: { chat: { futureEndpointField: "keep-endpoint" } }
          }
        },
        modelPresets: {
          "future-preset": { futurePresetField: "keep-preset" }
        },
        memmyMemory: {
          futureMemoryField: "keep-memory",
          storage: {
            endpoint: "http://127.0.0.1:18960",
            futureStorageField: "keep-storage"
          }
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shuts down through the admin endpoint and releases the sqlite server lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-server-shutdown-"));
    const configPath = join(root, "config.yaml");
    const databasePath = join(root, "memory.sqlite");
    const lockPath = `${databasePath}.server.lock`;
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        storage: {
          mode: "local",
          backend: "sqlite",
          sqlitePath: databasePath
        }
      }
    }));

    try {
      const running = main([
        "--config", configPath,
        "--host", "127.0.0.1",
        "--port", "0",
        "--db", databasePath
      ]);
      const endpoint = await waitForWrittenEndpoint(configPath);
      const response = await fetch(`${endpoint}/api/v1/admin/shutdown`, { method: "POST" });

      expect(response.ok).toBe(true);
      await running;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates restore candidates, preserves committed WAL data and supports a local rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-wanx-restore-"));
    const stage = mkdtempSync(join(root, "stage-"));
    const configPath = join(root, "config.yaml");
    const databasePath = join(root, "memory.sqlite");
    const runtimePath = join(root, "memory-service", "runtime.json");
    const token = randomUUID();
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: { storage: { mode: "local", backend: "sqlite", sqlitePath: databasePath, token } }
    }));
    const request = (endpoint: string, route: string, data?: object) => fetch(endpoint + "/api/v1/admin/" + route, {
      method: data === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const readRuntime = () => JSON.parse(readFileSync(runtimePath, "utf8"));
    const ready = (prior?: string) => vi.waitFor(() => {
      const state = readRuntime();
      expect(state.status).toBe("ready");
      if (prior) expect(state.sqlitePath).not.toBe(prior);
      return state;
    }, { timeout: 15_000 });
    const running = main(["--config", configPath, "--host", "127.0.0.1", "--port", "0"]);
    try {
      const { endpoint } = await ready();
      expect((await request(endpoint, "wanx-storage", { id: randomUUID(), rollback: true })).status).toBe(400);
      const source = new Database(databasePath);
      let snapshot: string;
      try {
        source.exec("CREATE TABLE wanx_backup_test (value TEXT); INSERT INTO wanx_backup_test VALUES ('before')");
        const response = await request(endpoint, "wanx-storage/snapshot", { directory: stage });
        expect(response.status).toBe(200);
        snapshot = (await response.json()).path;
        source.exec("UPDATE wanx_backup_test SET value = 'after'");
      } finally { source.close(); }

      const bad = join(stage, "invalid.sqlite");
      writeFileSync(bad, "invalid sqlite");
      expect((await request(endpoint, "wanx-storage", { id: randomUUID(), restoreFrom: bad })).status).toBe(400);
      const future = join(stage, "future.sqlite");
      writeFileSync(future, readFileSync(snapshot));
      const newer = new Database(future);
      try { newer.exec("UPDATE schema_migrations SET version = 10000 WHERE version = (SELECT MAX(version) FROM schema_migrations)"); }
      finally { newer.close(); }
      expect((await request(endpoint, "wanx-storage", { id: randomUUID(), restoreFrom: future })).status).toBe(400);
      expect((await ready()).sqlitePath).toBe(databasePath);

      const failedId = randomUUID();
      const startup = vi.spyOn(memoryHttp, "createMemoryHttpServer").mockImplementationOnce(() => {
        throw new Error("test failure before storage switch commits");
      });
      const awaitResult = (id: string, failed: boolean) => vi.waitFor(async () => {
        const state = readRuntime();
        expect(state.status).toBe("ready");
        const response = await request(state.endpoint, "wanx-storage");
        expect((await response.json()).result).toEqual({ id, failed });
        return state;
      }, { timeout: 15_000 });
      try {
        expect(await (await request(endpoint, "wanx-storage", { id: failedId, restoreFrom: snapshot })).json()).toEqual({ accepted: true });
        expect((await awaitResult(failedId, true)).sqlitePath).toBe(databasePath);
      } finally { startup.mockRestore(); }

      const id = randomUUID();
      const reverted = await ready();
      expect(await (await request(reverted.endpoint, "wanx-storage", { id, restoreFrom: snapshot })).json()).toEqual({ accepted: true });
      const restored = await awaitResult(id, false);
      expect(restored.sqlitePath).not.toBe(databasePath);
      expect(restored.endpoint).toBe(endpoint);
      expect((await (await request(restored.endpoint, "wanx-storage")).json()).rollbackAvailable).toBe(true);
      const { recoveryPath } = JSON.parse(readFileSync(join(root, "memory-service", "wanx-storage.json"), "utf8"));
      expect(recoveryPath).not.toBe(databasePath);
      const original = new Database(databasePath, { readonly: true });
      const active = new Database(restored.sqlitePath, { readonly: true });
      const recovery = new Database(recoveryPath, { readonly: true });
      try {
        expect(original.prepare("SELECT value FROM wanx_backup_test").pluck().get()).toBe("after");
        expect(active.prepare("SELECT value FROM wanx_backup_test").pluck().get()).toBe("before");
        expect(recovery.prepare("SELECT value FROM wanx_backup_test").pluck().get()).toBe("after");
      } finally { original.close(); active.close(); recovery.close(); }
      const undoId = randomUUID();
      expect(await (await request(restored.endpoint, "wanx-storage", { id: undoId, rollback: true })).json()).toEqual({ accepted: true });
      const undone = new Database((await awaitResult(undoId, false)).sqlitePath, { readonly: true });
      try { expect(undone.prepare("SELECT value FROM wanx_backup_test").pluck().get()).toBe("after"); }
      finally { undone.close(); }
    } finally {
      await request((await ready()).endpoint, "shutdown", {});
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForWrittenEndpoint(configPath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const config = YAML.parse(readFileSync(configPath, "utf8")) as {
      memmyMemory?: { storage?: { endpoint?: unknown } };
    };
    const endpoint = config.memmyMemory?.storage?.endpoint;
    if (typeof endpoint === "string" && !endpoint.endsWith(":18960")) {
      return endpoint;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Memory server did not write its bound endpoint");
}

async function waitForResponse(url: string, status: number, init: RequestInit): Promise<Response> {
  const deadline = Date.now() + 5_000;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(url, init);
    if (response.status === status) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`endpoint did not return ${status}; received ${response?.status ?? "no response"}`);
}
