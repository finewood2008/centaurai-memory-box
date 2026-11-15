import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerMemoryBundleRoutes } from "../routes/memory-bundle.js";
import { createHttpMemoryClient } from "../../../outbound/memory-client/http-memory-client.js";
import type { LocalDataService } from "../../../../services/local-data-service.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const bundle = { schemaVersion: 1, manifest: { service: "memmy-memory-service" }, tables: { memories: [{ id: "synthetic" }] } };

it("authenticates bundle transfer, validates format and always keeps existing records", async () => {
  const imported = vi.fn(async () => ({ ok: true as const, inserted: { memories: 1 }, skipped: {} }));
  app = Fastify();
  registerMemoryBundleRoutes(app, {
    localData: { exportBundle: async () => bundle, importBundle: imported } as unknown as LocalDataService,
    async authenticateRuntimeToken(request, reply) {
      if (request.headers["x-memmy-local-token"] !== "synthetic-token") return reply.code(401).send({ error: "unauthorized" });
    },
  });
  expect((await app.inject({ method: "GET", url: "/api/local-data/bundle" })).statusCode).toBe(401);
  const headers = { "x-memmy-local-token": "synthetic-token" };
  expect((await app.inject({ method: "GET", url: "/api/local-data/bundle", headers })).json()).toEqual(bundle);
  const post = (payload: unknown) => app!.inject({ method: "POST", url: "/api/local-data/bundle/import", headers, payload });
  expect((await post({ bundle, conflictStrategy: "replace" })).statusCode).toBe(400);
  expect((await post({ bundle: { tables: {} }, conflictStrategy: "skip" })).statusCode).toBe(400);
  expect(imported).not.toHaveBeenCalled();
  expect((await post({ bundle, conflictStrategy: "skip" })).json()).toMatchObject({ ok: true, inserted: { memories: 1 } });
  expect(imported).toHaveBeenCalledWith(bundle);
  const large = { ...bundle, tables: { memories: [{ id: "large", body: "a".repeat(2 * 1024 * 1024) }] } };
  expect((await post({ bundle: large, conflictStrategy: "skip" })).statusCode).toBe(200);
});

it("relays import through authenticated engine admin API without automatic retries", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createHttpMemoryClient({ baseUrl: "http://127.0.0.1:3456", token: "synthetic-engine-token", timeoutMs: 1000, maxRetries: 3 }, {
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true, inserted: { memories: 1 }, skipped: {} });
    }) as typeof fetch,
  });
  expect(await client.importBundle!(bundle)).toMatchObject({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://127.0.0.1:3456/api/v1/admin/import");
  expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer synthetic-engine-token");
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({ bundle, conflictStrategy: "skip" });
});
