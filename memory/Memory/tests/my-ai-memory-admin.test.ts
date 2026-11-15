import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../src/server/http.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const { createTestService, cleanup } = createMemoryServiceFixture();
let server: Server | undefined;
afterEach(async () => { if (server) await closeMemoryHttpServer(server); server = undefined; await cleanup(); });

function inject(method: string, url: string, payload?: unknown, token = "synthetic-token") {
  return new Promise<{ status: number; body: any }>(resolve => {
    const request = Object.assign(Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]), {
      method, url, headers: { host: "127.0.0.1:3456", authorization: "Bearer " + token }, socket: { remoteAddress: "127.0.0.1" },
    });
    let status = 200;
    const response = Object.assign(new EventEmitter(), {
      setHeader() {},
      writeHead(code: number) { status = code; },
      end(text: string) { response.emit("finish"); resolve({ status, body: JSON.parse(text) }); },
    });
    server!.emit("request", request as unknown as IncomingMessage, response as unknown as ServerResponse);
  });
}

it("authenticated local bundle API round-trips real SQLite memories and skips repeated imports", async () => {
  const source = createTestService();
  const saved = await source.service.addMemory({ content: "Synthetic MemoBox round-trip evidence", source: "gemini", layer: "L1" });
  const bundle = source.service.exportBundle({ includeAudit: false });
  const target = createTestService();
  server = createMemoryHttpServer({ service: target.service, configPath: join(target.root, "config.yaml"),
    auth: { localServiceToken: "synthetic-token" } });
  const input = { bundle, conflictStrategy: "skip" };
  expect((await inject("POST", "/api/v1/admin/import", input, "wrong-token")).status).toBe(401);
  expect((await inject("POST", "/api/v1/admin/import", { ...input, conflictStrategy: "replace" })).status).toBe(400);
  expect((await inject("POST", "/api/v1/admin/import", { ...input, bundle: { ...bundle, schemaVersion: 999999 } })).status).toBe(400);
  expect((await inject("POST", "/api/v1/admin/import", input)).body.ok).toBe(true);
  expect(target.db.db.prepare("SELECT memory_value FROM memories WHERE id=?").get(saved.id))
    .toMatchObject({ memory_value: expect.stringContaining("Synthetic MemoBox round-trip evidence") });
  const again = await inject("POST", "/api/v1/admin/import", input);
  expect(again.status).toBe(200);
  expect(again.body.skipped.memories).toBeGreaterThan(0);
  const exported = await inject("GET", "/api/v1/admin/export");
  expect(exported.body.tables.memories.some((row: { id: string }) => row.id === saved.id)).toBe(true);
});
