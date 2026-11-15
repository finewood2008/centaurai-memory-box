import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
