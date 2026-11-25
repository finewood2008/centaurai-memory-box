import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMemoryRuntimeSupervisor } from "../shell/local-memory-runtime.mjs";

test("runtime startup joins concurrent callers and only relaunches after a failed health check", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:3334", localToken: "fixture" }));
  let ready = false;
  let starts = 0;
  const runtime = createMemoryRuntimeSupervisor({
    runtimeFile, appPath: root, source: root, appData: root, home: root, env: {}, retryMs: 1,
    request: async (url, options) => {
      assert.equal(url.href, "http://127.0.0.1:3334/api/v1/health");
      assert.equal(options.headers["x-memmy-local-token"], "fixture");
      return Response.json({ ok: true, storage: { ready } });
    },
    start: (_executable, args, options) => {
      starts++;
      assert.equal(args[3], runtimeFile);
      assert.equal(options.env.MEMMY_RUNTIME_CONFIG_PATH, runtimeFile);
      const child = new EventEmitter();
      child.unref = () => { ready = true; };
      return child;
    },
  });
  const start = runtime.ensure();
  assert.equal(runtime.ensure(), start);
  assert.equal(runtime.waitForStartup(), start);
  await start;
  await runtime.ensure();
  assert.equal(starts, 1);
  ready = false;
  await runtime.ensure();
  assert.equal(starts, 2);
});

test("model errors do not relaunch a reachable ready memory database", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-degraded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:3334", localToken: "fixture" }));
  let starts = 0;
  const runtime = createMemoryRuntimeSupervisor({
    runtimeFile, appPath: root, source: root, appData: root, home: root, env: {},
    request: async () => Response.json({ ok: false, storage: { ready: true }, models: { embedding: { lastError: "fixture unavailable" } } }),
    start: () => { starts++; throw new Error("must not restart a live database"); },
  });
  await runtime.ensure();
  await runtime.ensure();
  assert.equal(starts, 0);
});

test("startup preserves worker error codes across concurrent callers and allows another attempt", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  const runtime = createMemoryRuntimeSupervisor({
    runtimeFile: path.join(root, "runtime.json"), appPath: root, source: root, appData: root, home: root,
    env: {}, retryMs: 1,
    start: (_executable, _args, options) => {
      starts++;
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
      const child = new EventEmitter();
      child.unref = () => queueMicrotask(() => {
        child.emit("message", { type: "memory-startup-error", code: "MEMORY_DATABASE_UNAVAILABLE" });
        child.emit("exit", 1);
      });
      return child;
    },
  });
  const pending = runtime.ensure();
  assert.equal(runtime.ensure(), pending);
  await assert.rejects(pending, { message: "MEMORY_DATABASE_UNAVAILABLE" });
  await assert.rejects(runtime.ensure(), { message: "MEMORY_DATABASE_UNAVAILABLE" });
  assert.equal(starts, 2);
});

test("an unexpected child exit keeps the generic startup failure", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createMemoryRuntimeSupervisor({
    runtimeFile: path.join(root, "runtime.json"), appPath: root, source: root, appData: root, home: root,
    env: {}, retryMs: 1,
    start: () => {
      const child = new EventEmitter();
      child.unref = () => queueMicrotask(() => {
        child.emit("message", { type: "memory-startup-error", code: "private diagnostic text" });
        child.emit("exit", null, "SIGTERM");
      });
      return child;
    },
  });
  await assert.rejects(runtime.ensure(), { message: "MEMORY_RUNTIME_START_FAILED" });
});

test("the actual worker reports its startup error through the supervisor IPC channel", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-memory-worker-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createMemoryRuntimeSupervisor({
    runtimeFile: path.join(root, "runtime.json"), source: root, appData: root, home: root,
    appPath: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, MEMMY_HOME: "relative-path" }, retryMs: 10, timeoutMs: 5000,
  });
  await assert.rejects(runtime.ensure(), { message: "MEMORY_RUNTIME_ARGUMENTS_INVALID" });
});
