import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryRuntimeSupervisor } from "../shell/local-memory-runtime.mjs";

test("a reachable old scoped service must be upgraded before mixed collection is ready", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "memobox-unified-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:3334", localToken: "synthetic" }));
  let scoped = true, starts = 0;
  const runtime = createMemoryRuntimeSupervisor({ runtimeFile, source: root, appPath: root, appData: root, home: root,
    env: { MEMMY_UNIFY_AGENT_SOURCES: "1" }, retryMs: 1,
    request: async url => url.pathname.endsWith("/health")
      ? Response.json({ ok: true, storage: { ready: true } })
      : Response.json({ dataPath: root, ...(scoped ? { sourceProfile: "codex-desktop" } : {}) }),
    start: (_exec, _args, options) => {
      assert.equal(options.env.MEMMY_UNIFY_AGENT_SOURCES, "1");
      starts++;
      const child = new EventEmitter(); child.unref = () => { scoped = false; }; return child;
    },
  });
  await runtime.ensure(); await runtime.ensure();
  assert.equal(starts, 1);
});
