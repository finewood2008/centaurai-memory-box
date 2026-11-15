import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signClientRelease } from "../tools/sign-client-release.mjs";
import { clientTrustFingerprints } from "../tools/package-client-trust.mjs";
import { clientBlockers, verifyRelease } from "../updates/contracts.mjs";

test("signing API and CLI bind explicit policies without changing artifact bytes or legacy support", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-ota-policy-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test-only verified build artifact"), file = path.join(root, "client.zip");
  const reportPath = path.join(root, "report.json"), keyFile = path.join(root, "test-only.pem");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  await writeFile(file, bytes);
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const report = { version: "1.0.5", appId: "ai.centuarai.wanx.client", edition: "personal", platform: "macos", arch: "arm64",
    signed: true, notarized: true, distributionClass: "formal", updateTrust: clientTrustFingerprints({ schemaVersion: 1, keys: { fixture: publicPem } }),
    build: { buildId: "policy-test-build", channel: "stable", distributionClass: "formal", securityEpoch: 1, sourceCommit: "a".repeat(40), sourceDirty: false },
    updateArtifact: { path: file, kind: "mac-zip", notarized: true, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") } };
  await writeFile(reportPath, JSON.stringify(report));
  const policies = { clientOsPolicy: { kind: "macos-product-majors", majors: [26] },
    applicationCompatibilityPolicy: { mode: "host-protocol-backward-compatible" } };
  const support = { supportedOsVersions: ["25.5.0"], compatibleApplications: [], ...policies };
  const input = { reportPath, privateKeyPath: keyFile, keyId: "fixture", artifactURL: "https://example.test/client.zip",
    releaseId: "client-policy-test", metadataSequence: 2, ...support, now: Date.parse("2026-11-04T00:00:00Z"),
    expiresAt: "2099-01-01T00:00:00Z", outputPath: path.join(root, "release.json") };
  await signClientRelease(input);
  const signed = JSON.parse(await readFile(input.outputPath));
  const { release } = verifyRelease(signed, { product: "wanx-client", keys: { fixture: publicPem }, now: input.now });
  assert.deepEqual(release.clientOsPolicy, policies.clientOsPolicy);
  assert.deepEqual(release.applicationCompatibilityPolicy, policies.applicationCompatibilityPolicy);
  assert.deepEqual(release.supportedOsVersions, support.supportedOsVersions);
  assert.deepEqual(release.compatibleApplications, []);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(clientBlockers(release, { platform: "darwin", arch: "arm64", osVersion: "25.6.0", osProductVersion: "26.6",
    productVersion: "1.0.4", edition: "personal", hostProtocol: 1, securityEpoch: 1 }, [{ applicationId: "example.legacy", version: "9.0.0", protocolVersion: 1 }]), []);
  const supportFile = path.join(root, "support.json"), cliOutput = path.join(root, "cli-release.json");
  await writeFile(supportFile, JSON.stringify(support));
  execFileSync(process.execPath, [fileURLToPath(new URL("../tools/sign-client-release.mjs", import.meta.url)),
    "--report", reportPath, "--url", input.artifactURL, "--key-id", "fixture", "--private-key", keyFile,
    "--release-id", "client-policy-cli", "--sequence", "3", "--support", supportFile,
    "--expires-at", input.expiresAt, "--out", cliOutput]);
  const cli = verifyRelease(JSON.parse(await readFile(cliOutput)), { product: "wanx-client", keys: { fixture: publicPem } }).release;
  assert.deepEqual(cli.clientOsPolicy, policies.clientOsPolicy);
  assert.deepEqual(cli.applicationCompatibilityPolicy, policies.applicationCompatibilityPolicy);
  for (const patch of [{ clientOsPolicy: { kind: "all" } }, { clientOsPolicy: null },
    { applicationCompatibilityPolicy: { mode: "all" } }, { applicationCompatibilityPolicy: null },
    { supportedOsVersions: ["*"] }, { supportedOsVersions: ["25.*"] }])
    await assert.rejects(signClientRelease({ ...input, ...patch, outputPath: path.join(root, "invalid.json") }));
  const windows = { ...report, platform: "windows", arch: "x64", authenticodeVerified: true, publisherName: "Test Publisher",
    build: { ...report.build, installationScope: "per-user" }, updateArtifact: { ...report.updateArtifact, kind: "nsis" } };
  await writeFile(reportPath, JSON.stringify(windows));
  await signClientRelease({ ...input, artifactURL: "https://example.test/client.exe", outputPath: path.join(root, "windows.json"),
    supportedOsVersions: ["10.0.26200"], clientOsPolicy: { kind: "windows-build-ranges", ranges: [
      { family: "windows10", minBuild: 19044, maxBuild: 19045 }, { family: "windows11", minBuild: 22000, maxBuild: 26200 },
    ] } });
  assert.equal(JSON.parse(await readFile(path.join(root, "windows.json"))).payload.platform.os, "win32");
});
