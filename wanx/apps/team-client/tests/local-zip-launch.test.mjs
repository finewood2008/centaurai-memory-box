import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationBackend } from "../applications/backend.mjs";
import { writeApplicationZip } from "./support/application-zip.mjs";

test("opening an installed local v3 ZIP sends its artifact identity and honors live readiness", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-zip-open-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    applicationId: "dev.wanx.cards", version: "0.1.0", name: "Cards", protocolVersion: 3,
    runtime: "electron", launchMode: "shared", entrypoint: "shell/main.cjs", capabilities: ["identity.read"],
    compatibility: {
      backendProductId: "wanx", hostProtocolRange: ">=1.0.0 <2.0.0", clientRange: ">=0.1.0 <2.0.0",
      backendContracts: [], resourceDependencies: [], localDataSchema: { readRange: "=1.0.0", writeVersion: "1.0.0" },
    },
  };
  const archivePath = path.join(root, "cards.zip");
  await writeApplicationZip(archivePath, [
    { name: "application.manifest.json", body: JSON.stringify(manifest) },
    { name: manifest.entrypoint, body: "" },
  ]);
  const ids = [];
  let failure, starts = 0;
  const context = { accountId: "account", clientId: "client", boxId: "box", connection: "ready" };
  const backend = createApplicationBackend({
    account: { getIdentity: () => context },
    client: {
      snapshot: () => ({ phase: "ready", connection: { deviceId: "box" } }),
      async applicationConnection(id, scope) {
        assert.equal(id, manifest.applicationId);
        assert.equal(scope.backendProductId, "wanx");
        return { context: () => context, async request({ path, body }) {
          assert.equal(path, "/api/platform/applications/readiness");
          const request = JSON.parse(body);
          assert.deepEqual(request.compatibility, manifest.compatibility);
          assert.match(request.artifactId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
          ids.push(request.artifactId);
          const response = { schemaVersion: 1, applicationId: id, deviceId: "box", productId: "wanx",
            status: "ready", authorization: { status: "ready" }, observedAt: new Date().toISOString(), contracts: [], checks: [] };
          if (failure === "BACKEND_CONTRACT_INCOMPATIBLE") {
            response.status = "blocked";
            response.checks.push({ code: failure });
          } else if (failure) {
            return { status: failure === "FORBIDDEN" ? 403 : 409, body: Buffer.from(JSON.stringify({ code: failure })) };
          }
          return { status: 200, body: Buffer.from(JSON.stringify(response)) };
        } };
      },
    },
  });
  const options = { applicationRoot: path.join(root, "applications"), applicationId: "wanx-host", ...backend,
    spawn(_file, _args, { env }) {
      starts++;
      const child = new EventEmitter();
      child.kill = () => child.emit("exit", 0);
      setImmediate(() => child.emit("message", { type: "wanx:application-ready", launchId: env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  };
  const install = await createApplicationManager(options);
  try { await install.install({ archivePath }); } finally { await install.close(); }
  for (const expected of ["APP_AUTHORIZATION_UNVERIFIED", "RESOURCE_PUBLICATION_UNAVAILABLE", "BACKEND_CONTRACT_INCOMPATIBLE", null, null]) {
    const manager = await createApplicationManager(options);
    try {
      failure = expected === "APP_AUTHORIZATION_UNVERIFIED" ? "FORBIDDEN" : expected;
      if (expected) {
        await assert.rejects(manager.launch(manifest.applicationId), { code: expected });
        assert.equal(starts, 0);
      } else {
        assert.equal((await manager.launch(manifest.applicationId)).state, "running");
      }
    } finally { await manager.close(); }
  }
  assert.equal(starts, 2);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 1);
});
