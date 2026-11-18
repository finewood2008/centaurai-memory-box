import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationManager } from "../build/app/applications/manager.mjs";
import { createApplicationBackend } from "../applications/backend.mjs";
import { packageApplication } from "../tools/package-application.mjs";

const applicationId = "centaurai.wanx.ai-browser";
const threads = JSON.stringify({ '["box-a",1,"browser-agent"]': { thread_id: "saved-thread" } });
const learning = JSON.stringify({ '["box-a",1]': { recordingId: "learn_" + "a".repeat(32), name: "Saved skill", goal: "Keep the task", agentId: "browser-agent" } });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const applicationRoot = path.join(root, "applications"), keys = generateKeyPairSync("ed25519");
  const keyFile = path.join(root, "test-key.pem");
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const trustedKeys = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
  async function artifact(version, readRange = ">=1.0.0 <2.0.0") {
    const sourceDir = path.join(root, version);
    await mkdir(path.join(sourceDir, "shell"), { recursive: true });
    await writeFile(path.join(sourceDir, "shell/main.mjs"), "export default {};\n");
    await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify({
      applicationId, name: "AI Browser", version, protocolVersion: 3, runtime: "electron",
      launchMode: "shared", entrypoint: "shell/main.mjs", releaseAccess: "account",
      compatibility: { backendProductId: "wanx", clientRange: ">=0.1.4 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
        backendContracts: [], resourceDependencies: [], localDataSchema: { readRange, writeVersion: readRange.startsWith(">=2") ? "2.0.0" : "1.0.0" } },
    }));
    const packaged = await packageApplication({ sourceDir, outputDir: path.join(root, "packages"), keyFile, keyId: "test" });
    return { ...packaged, envelope: JSON.parse(await readFile(packaged.envelopePath, "utf8")) };
  }
  let allowed = true;
  const provider = createApplicationBackend({ clientVersion: "1.0.2",
    account: { getIdentity: () => ({ accountId: "account-a", clientId: "client-a" }) },
    client: { snapshot: () => ({ phase: "ready", connection: { deviceId: "box-a" } }),
      async applicationConnection() { return {
        context: () => ({ connection: "ready", boxId: "box-a", accountId: "account-a", clientId: "client-a" }),
        async request(input) { const body = JSON.parse(input.body); return { status: 200, body: Buffer.from(JSON.stringify({
          schemaVersion: 1, productId: "wanx", deviceId: "box-a", observedAt: new Date().toISOString(), authorization: { status: "ready" },
          contracts: [], resources: [], bindings: [],
          ...(input.path.endsWith("prepare") ? { status: "ready", backendProductId: "wanx", applicationId, artifactId: body.artifactId } : {}),
        })) }; },
      }; },
    },
  }).getCompatibilityContext;
  const manager = await createApplicationManager({ applicationRoot, applicationId: "test-host", trustedKeys,
    getCompatibilityContext: provider,
    authorizeRelease: async () => {
      if (!allowed) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
      return { expiresAt: Date.now() + 60000, assertLive() {}, assertSession() {} };
    },
    spawn(_file, _args, options) {
      const child = Object.assign(new EventEmitter(), { pid: 1 });
      child.kill = () => { child.emit("exit", null, "SIGTERM"); return true; };
      child.send = () => {};
      queueMicrotask(() => child.emit("message", { type: "wanx:application-ready", launchId: options.env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  t.after(() => manager.close());
  return { root, applicationRoot, manager, artifact, revoke() { allowed = false; } };
}

for (const layout of ["runtime", "legacy"]) test(`browser 0.1.2 to 1.0.0 preserves ${layout} data and opens repeatedly`, async t => {
  const f = await fixture(t);
  await f.manager.installVerifiedPackage(await f.artifact("0.1.2"));
  assert.equal((await f.manager.launch(applicationId)).state, "running");
  await f.manager.stop(applicationId);
  const profile = layout === "runtime" ? path.join(f.applicationRoot, ".runtime", applicationId)
    : path.join(f.root, "application-data", applicationId);
  await mkdir(path.join(profile, "Local Storage"), { recursive: true });
  const saved = { "threads.json": threads, "learning.json": learning, DIPS: "opaque Chromium SQLite", "Local Storage/sidebar": "collapsed" };
  for (const [file, bytes] of Object.entries(saved)) await writeFile(path.join(profile, file), bytes);
  await f.manager.installVerifiedPackage(await f.artifact("1.0.0"));
  assert.equal((await f.manager.listInstalled())[0].version, "1.0.0");
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.manager.launch(applicationId)).state, "running");
    await f.manager.stop(applicationId);
  }
  for (const [file, bytes] of Object.entries(saved)) assert.equal(await readFile(path.join(profile, file), "utf8"), bytes);
  f.revoke();
  await assert.rejects(f.manager.launch(applicationId), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
});

test("unrecognized browser data and incompatible read ranges preserve the active version", async t => {
  const f = await fixture(t);
  await f.manager.installVerifiedPackage(await f.artifact("0.1.2"));
  const profile = path.join(f.applicationRoot, ".runtime", applicationId);
  await mkdir(profile, { recursive: true });
  const file = path.join(profile, "threads.json");
  await writeFile(file, "{broken");
  const next = await f.artifact("1.0.0");
  await assert.rejects(f.manager.installVerifiedPackage(next), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal((await f.manager.listInstalled())[0].version, "0.1.2");
  assert.equal(await readFile(file, "utf8"), "{broken");
  await writeFile(file, threads);
  await assert.rejects(f.manager.installVerifiedPackage(await f.artifact("2.0.0", ">=2.0.0 <3.0.0")), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
  assert.equal((await f.manager.listInstalled())[0].version, "0.1.2");
  assert.equal(await readFile(file, "utf8"), threads);
});
