import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electron from "electron";

// Opt in like the other native Electron tests. Both processes use only this
// temporary profile, a fabricated box connection and a disposable AES key.
test("real sandboxed Electron IPC persists 1000 workbench annotations across process restart", {
  skip: process.env.WANX_TEST_ELECTRON !== "1", timeout: 90_000,
}, async t => {
  const profile = await mkdtemp(path.join(tmpdir(), "memobox-annotation-electron-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env, WANX_ANNOTATION_TEST_AES_KEY: randomBytes(32).toString("hex") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = fileURLToPath(new URL("./support/electron-annotation-workbench.mjs", import.meta.url));
  const results = [];
  for (const phase of ["write", "read"]) {
    const { stdout, stderr } = await promisify(execFile)(electron, [child, phase, profile, `--user-data-dir=${profile}`], {
      env, timeout: 40_000, maxBuffer: 1024 * 1024,
    });
    const marker = stdout.split("\n").find(line => line.startsWith("ANNOTATION_WORKBENCH_ELECTRON_PASS "));
    assert.ok(marker, stderr || stdout);
    assert.doesNotMatch(stderr, /Error occurred in handler for 'wanx-client:space-preview'/);
    results.push(JSON.parse(marker.slice("ANNOTATION_WORKBENCH_ELECTRON_PASS ".length)));
  }
  assert.deepEqual(results.map(result => result.phase), ["write", "read"]);
  assert.equal(results[0].files, 1000);
  assert.equal(results[0].batchReceipts, 21);
  assert.equal(results[0].crossPageTargets, 2);
  assert.equal(results[0].rendererSandboxed, true);
  assert.equal(results[0].foreignRendererRejected, true);
  assert.equal(results[1].restoredFiles, 1000);
  assert.equal(results[1].searchMatches, 100);
  assert.equal(results[1].undoRestored, 1000);
  assert.equal(results[1].retainedEarlierEdits, 2);
  assert.notEqual(results[0].pid, results[1].pid, "readback must come from another Electron process");
});
