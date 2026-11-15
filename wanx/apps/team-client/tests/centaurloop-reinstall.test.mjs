import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationBackend } from "../applications/backend.mjs";
import { packageApplication } from "../tools/package-application.mjs";

const applicationId = "centaurai.wanx.centaurloop";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "centaurloop-reinstall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const applicationRoot = path.join(root, "applications"), keys = generateKeyPairSync("ed25519");
  const keyFile = path.join(root, "test-key.pem");
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const trustedKeys = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
  async function artifact(version, readRange = ">=1.0.0 <2.0.0") {
    const sourceDir = path.join(root, version);
    await mkdir(path.join(sourceDir, "shell"), { recursive: true });
    await writeFile(path.join(sourceDir, "shell/main.cjs"), "export default {};\n");
    await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify({
      applicationId, name: "CentaurLoop", version, protocolVersion: 3, runtime: "electron",
      launchMode: "shared", entrypoint: "shell/main.cjs", releaseAccess: "account",
      compatibility: { backendProductId: "wanx", clientRange: ">=0.1.4 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
        backendContracts: [], resourceDependencies: [], localDataSchema: { readRange, writeVersion: readRange.startsWith(">=2") ? "2.0.0" : "1.0.0" } },
    }));
    const packaged = await packageApplication({ sourceDir, outputDir: path.join(root, "packages"), keyFile, keyId: "test" });
    return { ...packaged, envelope: JSON.parse(await readFile(packaged.envelopePath, "utf8")) };
  }
  let allowed = true, suppliedSchema;
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
    getCompatibilityContext: async input => ({ ...await provider(input), ...(suppliedSchema ? { localDataSchemaVersion: suppliedSchema } : {}) }),
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
  return { root, applicationRoot, manager, artifact, revoke() { allowed = false; }, schema(value) { suppliedSchema = value; } };
}


for (const layout of ["runtime", "legacy"]) {
  for (const writer of ["previous-artifact", "missing"]) test(`CentaurLoop reinstalls with ${layout} data and ${writer} writer`, async t => {
    const f = await fixture(t);
    await f.manager.installVerifiedPackage(await f.artifact("0.10.4"));
    assert.equal((await f.manager.launch(applicationId)).state, "running");
    await f.manager.stop(applicationId);
    // This fixture represents pre-marker installations. Do not retain the new
    // Host's initial empty profile when modeling the historical legacy path.
    const primary = path.join(f.applicationRoot, ".runtime", applicationId);
    if (layout === "legacy") await rm(primary, { recursive: true });
    else await rm(path.join(primary, ".data-schema.json"));
    const profile = layout === "runtime" ? path.join(f.applicationRoot, ".runtime", applicationId)
      : path.join(f.root, "application-data", applicationId);
    await mkdir(path.join(profile, "Local Storage"), { recursive: true });
    const saved = { Preferences: "opaque preferences", DIPS: "opaque Chromium database", "Local Storage/runtime": "saved metadata" };
    for (const [file, bytes] of Object.entries(saved)) await writeFile(path.join(profile, file), bytes);
    await f.manager.uninstall(applicationId);
    assert.equal((await f.manager.listInstalled()).length, 0);
    if (writer === "missing") await rm(path.join(f.applicationRoot, ".data-access", `${applicationId}.json`));
    await f.manager.installVerifiedPackage(await f.artifact("1.0.0"));
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.manager.launch(applicationId)).state, "running");
      await f.manager.stop(applicationId);
    }
    for (const [file, bytes] of Object.entries(saved)) assert.equal(await readFile(path.join(profile, file), "utf8"), bytes);
    f.revoke();
    await assert.rejects(f.manager.launch(applicationId), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
  });
}

test("CentaurLoop unknown data remains blocked", async t => {
  const f = await fixture(t);
  await f.manager.installVerifiedPackage(await f.artifact("0.10.4"));
  const profile = path.join(f.applicationRoot, ".runtime", applicationId);
  await mkdir(profile, { recursive: true });
  const unknown = path.join(profile, "future-business.json");
  await writeFile(unknown, '{"important":"keep"}');
  await assert.rejects(f.manager.installVerifiedPackage(await f.artifact("1.0.0")), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(await readFile(unknown, "utf8"), '{"important":"keep"}');
  assert.equal((await f.manager.listInstalled())[0].version, "0.10.4");
});

test("CentaurLoop schema conflicts and corrupt writer records remain blocked", async t => {
  const f = await fixture(t);
  await f.manager.installVerifiedPackage(await f.artifact("0.10.4"));
  await f.manager.launch(applicationId);
  await f.manager.stop(applicationId);
  const profile = path.join(f.applicationRoot, ".runtime", applicationId);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "Preferences"), "keep preferences");
  await assert.rejects(f.manager.installVerifiedPackage(await f.artifact("1.0.0", ">=2.0.0 <3.0.0")), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
  f.schema("2.0.0");
  await assert.rejects(f.manager.launch(applicationId), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
  f.schema(null);
  const writerFile = path.join(f.applicationRoot, ".data-access", `${applicationId}.json`);
  await writeFile(writerFile, "{broken");
  await assert.rejects(f.manager.launch(applicationId), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  assert.equal(await readFile(writerFile, "utf8"), "{broken");
  assert.equal((await f.manager.listInstalled())[0].version, "0.10.4");
  assert.equal(await readFile(path.join(profile, "Preferences"), "utf8"), "keep preferences");
});
