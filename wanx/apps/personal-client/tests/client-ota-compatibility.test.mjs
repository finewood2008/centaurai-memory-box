import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJSON, clientBlockers, verifyRelease } from "../updates/contracts.mjs";
import { matchesClientPlatform, validateClientOsPolicy } from "../updates/client-compatibility.mjs";

const current = { platform: "darwin", arch: "arm64", osVersion: "25.6.0", osProductVersion: "26.6",
  productVersion: "1.0.4", hostProtocol: 1, securityEpoch: 1 };
const release = { product: "wanx-client", platform: { os: "darwin", arch: "arm64", osVersion: "25.5.0" },
  supportedOsVersions: ["25.5.0"], securityEpoch: 1, hostProtocol: 1, dataPolicy: "backward-compatible",
  clientOsPolicy: { kind: "macos-product-majors", majors: [26] }, compatibleApplications: [],
  applicationCompatibilityPolicy: { mode: "host-protocol-backward-compatible" } };

test("a declared macOS product major survives a minor and Darwin kernel update", () => {
  assert.deepEqual(clientBlockers(release, current, []), []);
});

test("Host protocol 1 legacy applications do not need a release version whitelist", () => {
  assert.deepEqual(clientBlockers(release, { ...current, osVersion: "25.5.0" }, [
    { applicationId: "example.new-market-app", version: "2.3.4", protocolVersion: 1 },
    { applicationId: "example.awaiting-selection", selectionRequired: true },
  ]), []);
});

const vectors = JSON.parse(readFileSync(new URL("./fixtures/client-ota-os-policy-v1.json", import.meta.url)));
for (const item of vectors.cases) test(`shared OS contract: ${item.label}`, () => {
  assert.equal(matchesClientPlatform(item.release, item.current), item.expected);
});

const modern = (patch = {}) => ({ applicationId: "example.market-app", name: "Market App", version: "12.3.4", protocolVersion: 3,
  compatibility: { backendProductId: "example.backend", clientRange: "<1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
    backendContracts: [], resourceDependencies: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" } }, ...patch });

test("explicit backwards-compatible Host policy accepts independent modern app releases", () => {
  assert.deepEqual(clientBlockers(release, current, [modern(), modern({ version: "0.1.0" }),
    { applicationId: "example.pending", installationState: "pending" }]), []);
  const incompatible = modern(); incompatible.compatibility.hostProtocolRange = ">=2.0.0 <3.0.0";
  const [blocker] = clientBlockers(release, current, [incompatible]);
  assert.equal(blocker.code, "DEPENDENCY_CONFLICT");
  assert.equal(blocker.reasonCode, "HOST_PROTOCOL_INCOMPATIBLE");
  assert.equal(blocker.applicationId, incompatible.applicationId);
  assert.equal(blocker.version, incompatible.version);
  assert.equal(blocker.requiredHostProtocolRange, ">=2.0.0 <3.0.0");
});

test("missing/invalid modern requirements fail closed while old release rules remain intact", () => {
  for (const app of [modern({ compatibility: undefined }), modern({ protocolVersion: undefined }), modern({ protocolVersion: 9 })])
    assert.equal(clientBlockers(release, current, [app])[0].reasonCode, "APPLICATION_CONTRACT_UNSUPPORTED");
  const legacy = { ...release }; delete legacy.applicationCompatibilityPolicy;
  assert.equal(clientBlockers(legacy, current, [modern()])[0].code, "DEPENDENCY_CONFLICT");
  assert.equal(clientBlockers(release, { ...current, hostProtocol: 2 }, [modern()])[0].code, "CONTRACT_UNSUPPORTED");
});

test("OS declarations are bounded and canonical; unknown policy fields are not ignored", () => {
  const invalidMac = [null, {}, { kind: "macos-product-majors", majors: [26], extra: true },
    { kind: "macos-product-majors", majors: Array.from({ length: 65 }, (_, i) => i + 1) },
    { kind: "macos-product-majors", majors: [1000] }];
  for (const policy of invalidMac) assert.throws(() => validateClientOsPolicy(policy, "darwin"), { code: "CONTRACT_UNSUPPORTED" });
  for (const ranges of [[], [{ family: "windows10", minBuild: 19045, maxBuild: 22000 }],
    [{ family: "windows11", minBuild: 19045, maxBuild: 26200 }],
    [{ family: "windows11", minBuild: 22000, maxBuild: 26200 }, { family: "windows11", minBuild: 26200, maxBuild: 28000 }],
    [{ family: "windows11", minBuild: 22000, maxBuild: 2147483648 }]])
    assert.throws(() => validateClientOsPolicy({ kind: "windows-build-ranges", ranges }, "win32"), { code: "CONTRACT_UNSUPPORTED" });
});

test("signed policies are immutable and reject unknown application modes and box extensions", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.parse("2026-11-04T00:00:00Z");
  const payload = { ...release, schemaVersion: 1, purpose: "wanx.release.v1", releaseId: "client-policy-test", buildId: "build-policy-test",
    version: "1.0.5", metadataSequence: 2, securityEpoch: 1, channel: "stable", backendContract: 1, requiredExtensions: [],
    createdAt: "2026-11-03T00:00:00Z", expiresAt: "2026-11-05T00:00:00Z",
    components: { "wanx-client": { version: "1.0.5", sha256: "a".repeat(64) } },
    artifacts: [{ component: "wanx-client", kind: "mac-zip", url: "https://example.test/client.zip", sha256: "a".repeat(64),
      sha512: Buffer.alloc(64).toString("base64"), sizeBytes: 100 }] };
  const envelope = data => ({ payload: data, signature: { algorithm: "ed25519", keyId: "test",
    signatureBase64: sign(null, Buffer.from(canonicalJSON(data)), privateKey).toString("base64") } });
  const verify = (data, product = "wanx-client") => verifyRelease(data, { product, keys: { test: publicKey.export({ type: "spki", format: "pem" }) }, now });
  assert.deepEqual(verify(envelope(payload)).release.clientOsPolicy, payload.clientOsPolicy);
  const tampered = envelope(payload); tampered.payload = structuredClone(payload); tampered.payload.clientOsPolicy.majors = [27];
  assert.throws(() => verify(tampered), { code: "SIGNATURE_INVALID" });
  for (const applicationCompatibilityPolicy of [null, {}, { mode: "all" }, { mode: "host-protocol-backward-compatible", extra: true }])
    assert.throws(() => verify(envelope({ ...payload, applicationCompatibilityPolicy })), { code: "CONTRACT_UNSUPPORTED" });
  assert.throws(() => verify(envelope({ ...payload, product: "wanx-box" }), "wanx-box"), { code: "CONTRACT_UNSUPPORTED" });
  for (const supportedOsVersions of [[], ["*"], ["25.*"], ["25.5.0", "25.5.0"], [" 25.5.0"], ["25.5.0\n"]])
    assert.throws(() => verify(envelope({ ...payload, supportedOsVersions })), { code: "CONTRACT_UNSUPPORTED" });
  for (const facts of [{ osProductVersion: "26.6" }, { windowsProductType: 1 }])
    assert.throws(() => verify(envelope({ ...payload, platform: { ...payload.platform, ...facts } })), { code: "CONTRACT_UNSUPPORTED" });
  const box = { ...payload, product: "wanx-box", platform: { os: "linux", arch: "x64", osVersion: "26.04", osId: "ubuntu" },
    components: { wanx: { version: "1.0.5", sha256: "a".repeat(64) } },
    artifacts: [{ component: "wanx", kind: "image-tar", url: "https://example.test/wanx.tar", sha256: "a".repeat(64), sizeBytes: 100 }] };
  delete box.clientOsPolicy; delete box.applicationCompatibilityPolicy;
  assert.equal(verify(envelope(box), "wanx-box").release.product, "wanx-box");
  for (const facts of [{ osProductVersion: "26.6" }, { windowsProductType: 1 }])
    assert.throws(() => verify(envelope({ ...box, platform: { ...box.platform, ...facts } }), "wanx-box"), { code: "CONTRACT_UNSUPPORTED" });
});
