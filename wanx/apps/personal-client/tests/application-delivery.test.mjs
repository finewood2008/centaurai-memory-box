import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createDefaultApplicationDelivery, createDefaultApplicationStore } from "../applications/delivery.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { writeApplicationZip } from "./support/application-zip.mjs";

const ids = Array.from({ length: 5 }, (_, index) => `example.app-${index}`);
const fail = code => Object.assign(new Error(code), { code });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("current cloud contract never auto-installs any app or replays old default receipts", async t => {
  const root = await fixture(t), store = createDefaultApplicationStore(path.join(root, "state"));
  const calls = [];
  let catalog = { items: ids.map(applicationId => ({ applicationId, name: applicationId })) };
  const service = createDefaultApplicationDelivery({ store,
    getScope: () => ({ accountId: "a", deviceId: "b" }), captureSession: () => () => {},
    market: { list: async () => catalog, candidate: () => calls.push("candidate"), install: () => calls.push("install") },
    applications: { listInstalled: () => calls.push("installed") },
  });
  t.after(() => service.close());
  assert.deepEqual((await service.ensureDefaultApplications()).items, []);
  catalog = { items: [] };
  assert.equal((await service.ensureDefaultApplications()).status, "ready");
  assert.deepEqual(calls, []);
  catalog = { items: ids.map(applicationId => ({ applicationId })), catalogState: { offline: true } };
  assert.equal((await service.ensureDefaultApplications()).status, "pending");
  assert.deepEqual(calls, []);
});

test("delivery fences account and box changes while reading cloud", async t => {
  const root = await fixture(t); let scope = { accountId: "a", deviceId: "b" };
  const service = createDefaultApplicationDelivery({ store: createDefaultApplicationStore(path.join(root, "state")),
    getScope: () => scope, captureSession: () => () => {},
    market: { list: async () => { scope = null; return { items: [] }; } },
  });
  t.after(() => service.close());
  assert.equal((await service.ensureDefaultApplications()).status, "cancelled");
  assert.equal((await service.ensureDefaultApplications()).status, "waiting");
});

const keys = generateKeyPairSync("ed25519");
const trustedKeys = { delivery: keys.publicKey.export({ format: "pem", type: "spki" }) };
async function artifact(root, version, controlled = false) {
  const artifactId = randomUUID(), archivePath = path.join(root, `${artifactId}.wanxapp`);
  const manifest = { applicationId: ids[4], version, name: "知君", protocolVersion: controlled ? 3 : 1, runtime: "electron", entrypoint: "main.mjs",
    ...(controlled ? { releaseAccess: "account", compatibility: {
      backendProductId: "wanx", clientRange: ">=0.1.0 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
      backendContracts: [], resourceDependencies: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
    } } : {}),
  };
  await writeApplicationZip(archivePath, [{ name: "wanx-app.json", body: JSON.stringify(manifest) }, { name: "main.mjs", body: "export default {};" }]);
  const bytes = await readFile(archivePath);
  const descriptor = { schemaVersion: controlled ? 3 : 1, artifactId, applicationId: ids[4], version, os: "universal", arch: "universal", packageType: "wanxapp", fileName: `${version}.wanxapp`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, minWanxVersion: "0.1.0", hostProtocol: 1, manifest,
    ...(controlled ? { compatibility: manifest.compatibility } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(descriptor));
  const envelope = { keyId: "delivery", descriptorBase64: encoded.toString("base64"), signatureBase64: sign(null, encoded, keys.privateKey).toString("base64") };
  return { archivePath, envelope, descriptor, bytes };
}

test("preparing an installed resource-free release rechecks real account authorization", async t => {
  const root = await fixture(t), value = await artifact(root, "1.0.0", true);
  let allowed = true, backendReady = true;
  const checkPermit = () => { if (!allowed) throw fail("MARKET_RELEASE_ACCESS_DENIED"); };
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys,
    getCompatibilityContext: () => ({ clientVersion: "0.2.0", hostProtocol: 1, backend: {
      schemaVersion: 1, productId: "wanx", deviceId: "box-a", observedAt: new Date().toISOString(),
      authorization: backendReady ? { status: "ready" } : { status: "blocked", code: "APP_ENTITLEMENT_REQUIRED" }, resources: [], bindings: [], contracts: [],
    } }),
    authorizeRelease: async () => { checkPermit(); return { assertLive: checkPermit, assertSession: checkPermit }; },
  });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(value);
  assert.equal((await manager.prepareInstalledApplication(ids[4])).artifactId, value.descriptor.artifactId);
  allowed = false;
  await assert.rejects(manager.prepareInstalledApplication(ids[4]), { code: "MARKET_RELEASE_ACCESS_DENIED" });
  assert.equal((await manager.listInstalled())[0].artifactId, value.descriptor.artifactId);
  allowed = true; backendReady = false;
  await assert.rejects(manager.prepareInstalledApplication(ids[4]), { code: "APP_ENTITLEMENT_REQUIRED" });
});

test("manager records removal before uninstall and automatic installation cannot replace an installed version", async t => {
  const root = await fixture(t), one = await artifact(root, "1.0.0"), two = await artifact(root, "1.1.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  await manager.installVerifiedPackage(one);
  assert.equal((await manager.installVerifiedPackage({ ...two, onlyIfMissing: true })).version, "1.0.0");
  assert.equal((await manager.listInstalled())[0].artifactId, one.descriptor.artifactId);
  await manager.uninstall(ids[4]);
  assert.equal(await manager.defaultApplicationDeliveryStore.isDismissed(ids[4]), true);
  assert.deepEqual(await manager.listInstalled(), []);
  await assert.rejects(manager.installVerifiedPackage({ ...two, onlyIfMissing: true }), { code: "DEFAULT_APPLICATION_USER_REMOVED" });
  // The user can still explicitly reinstall from the market.
  assert.equal((await manager.installVerifiedPackage(two)).version, "1.1.0");
});

test("normal market path preserves signature verification and passes the box session guard through download", async t => {
  const root = await fixture(t), value = await artifact(root, "1.0.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  let box = "box-a";
  const check = () => { if (box !== "box-a") throw fail("DEFAULT_APPLICATION_SESSION_CHANGED"); };
  const market = createApplicationMarket({ applications: manager, trustedKeys, platform: "win32", arch: "x64", wanxVersion: "0.1.4",
    request: async input => input.path.endsWith("/candidate")
      ? { status: "available", release: { version: value.descriptor.version }, artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } }
      : { artifactId: value.descriptor.artifactId, url: "https://market.invalid/app", expiresAt: new Date(Date.now() + 60000).toISOString() },
    fetch: async () => { box = "box-b"; return new Response(value.bytes); },
  });
  t.after(() => market.close());
  await market.candidate(ids[4], { assertSession: check });
  await assert.rejects(market.install(ids[4], { assertSession: check, onlyIfMissing: true }), { code: "DEFAULT_APPLICATION_SESSION_CHANGED" });
  assert.deepEqual(await manager.listInstalled(), []);
});

test("a manual installation during default download is preserved instead of silently upgraded", async t => {
  const root = await fixture(t), one = await artifact(root, "1.0.0"), two = await artifact(root, "1.1.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  const market = createApplicationMarket({ applications: manager, trustedKeys, platform: "darwin", arch: "arm64", wanxVersion: "0.1.4",
    request: async input => input.path.endsWith("/candidate")
      ? { status: "available", release: { version: two.descriptor.version }, artifact: { ...two.descriptor, status: "ready", envelope: two.envelope } }
      : { artifactId: two.descriptor.artifactId, url: "https://market.invalid/app", expiresAt: new Date(Date.now() + 60000).toISOString() },
    fetch: async () => { await manager.installVerifiedPackage(one); return new Response(two.bytes); },
  });
  t.after(() => market.close());
  await market.candidate(ids[4]);
  assert.equal((await market.install(ids[4], { onlyIfMissing: true })).version, "1.0.0");
  assert.equal((await manager.listInstalled())[0].artifactId, one.descriptor.artifactId);
});

test("an uninstall during default download prevents reinstallation at the final commit", async t => {
  const root = await fixture(t), value = await artifact(root, "1.0.0");
  const manager = await createApplicationManager({ applicationRoot: path.join(root, "apps"), trustedKeys });
  t.after(() => manager.close());
  const market = createApplicationMarket({ applications: manager, trustedKeys, platform: "darwin", arch: "arm64", wanxVersion: "0.1.4",
    request: async input => input.path.endsWith("/candidate")
      ? { status: "available", release: { version: value.descriptor.version }, artifact: { ...value.descriptor, status: "ready", envelope: value.envelope } }
      : { artifactId: value.descriptor.artifactId, url: "https://market.invalid/app", expiresAt: new Date(Date.now() + 60000).toISOString() },
    fetch: async () => { await manager.uninstall(ids[4]); return new Response(value.bytes); },
  });
  t.after(() => market.close());
  await market.candidate(ids[4]);
  await assert.rejects(market.install(ids[4], { onlyIfMissing: true }), { code: "DEFAULT_APPLICATION_USER_REMOVED" });
  assert.deepEqual(await manager.listInstalled(), []);
  assert.equal(await manager.defaultApplicationDeliveryStore.isDismissed(ids[4]), true);
});

test("receipt write rechecks the session immediately before atomic commit", async t => {
  const root = await fixture(t), store = createDefaultApplicationStore(path.join(root, "state"));
  const key = "a".repeat(64); let checks = 0;
  await assert.rejects(store.save(key, { schemaVersion: 1, scopeKey: key, items: [] }, () => {
    if (++checks === 2) throw fail("MARKET_SESSION_CHANGED");
  }), { code: "MARKET_SESSION_CHANGED" });
  assert.equal(await store.load(key), null);
  assert.deepEqual(await readdir(path.join(root, "state")), []);
});
