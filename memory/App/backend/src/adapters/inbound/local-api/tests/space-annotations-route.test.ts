import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";
import type { SpaceAnnotationInferenceService } from "../../../../services/space-annotation-inference-service.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
function server(service?: SpaceAnnotationInferenceService) {
  app = createLocalApiServer({
    permissionManager: { verifyRuntimeToken: async token => token === "synthetic-token" } as PermissionManager,
    services: { progressBus: createProgressBus(), localData: {}, spaceAnnotations: service } as unknown as BackendServices,
    composioMcpToken: "synthetic-mcp-token"
  });
  return app;
}
describe("first-party annotation routes", () => {
  it("registers in the actual local server and protects both methods with the runtime token", async () => {
    const models = vi.fn(async () => ({ available: true, presets: [{ id: "test", name: "Test", provider: "openai" }] }));
    const suggest = vi.fn(async () => ({ tags: ["synthetic"], description: "fixture", model: { id: "test", provider: "openai", name: "Test" }, usage: {}, contentMode: "name-only" as const, truncated: false }));
    const app = server({ models, suggest });
    for (const [method, url] of [["GET", "/api/app/space-annotations/models"], ["POST", "/api/app/space-annotations/suggest"]] as const) {
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode).toBe(401);
    }
    expect(models).not.toHaveBeenCalled(); expect(suggest).not.toHaveBeenCalled();
    const headers = { "x-memmy-local-token": "synthetic-token" };
    const response = await app.inject({ method: "GET", url: "/api/app/space-annotations/models", headers });
    expect(response.statusCode).toBe(200); expect(response.json().presets[0].id).toBe("test");
    const payload = { modelPresetId: "test", file: { name: "fixture.png", content: "", kind: "file", contentMode: "name-only" } };
    expect((await app.inject({ method: "POST", url: "/api/app/space-annotations/suggest", headers, payload })).statusCode).toBe(200);
    expect(suggest).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
  });
  it("keeps manual workflows available when the embedding has no model service", async () => {
    const app = server(), headers = { "x-memmy-local-token": "synthetic-token" };
    expect((await app.inject({ method: "GET", url: "/api/app/space-annotations/models", headers })).json()).toEqual({ available: false, presets: [], reason: "SPACE_ANNOTATION_MODEL_UNAVAILABLE" });
    expect((await app.inject({ method: "POST", url: "/api/app/space-annotations/suggest", headers, payload: {} })).statusCode).toBe(503);
  });
  it.each([
    ["SPACE_ANNOTATION_INVALID", 400], ["SPACE_CONTEXT_CHANGED", 409],
    ["SPACE_ANNOTATION_MODEL_OUTPUT", 502], ["SPACE_ANNOTATION_MODEL_TIMEOUT", 504],
    ["SPACE_ANNOTATION_MODEL_QUOTA", 402], ["arbitrary-upstream-secret", 502]
  ])("returns a fixed safe envelope for %s", async (code, status) => {
    const app = server({ models: async () => ({ available: false, presets: [] }), suggest: async () => { throw Object.assign(new Error("secret-key-sensitive-content"), { code }); } });
    const response = await app.inject({ method: "POST", url: "/api/app/space-annotations/suggest", headers: { "x-memmy-local-token": "synthetic-token" }, payload: {} });
    expect(response.statusCode).toBe(status); expect(response.body).not.toContain("secret");
    expect(response.json()).toEqual({ error: { code: code === "arbitrary-upstream-secret" ? "SPACE_ANNOTATION_MODEL_FAILED" : code } });
  });
});
